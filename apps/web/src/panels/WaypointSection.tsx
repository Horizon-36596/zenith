/**
 * The inspector's Waypoints list (issues #134, #245 and #431): one compact row for every waypoint in
 * waypoints.json, with its name, which selects the pin even where a dot or the start mark covers it,
 * its x, y and heading edited in place, and, on hover or focus, an eye that hides or shows its pin
 * for this person and a ⋯ menu with the items a right-click on the pin has. The open auto's
 * waypoints come first and the rest wait under a closed Other waypoints section, which is how a pin
 * the field does not show is selected (issue #217). A selected pin has its own Waypoint section
 * first, with its provenance chip and one Used by row, and its header's ⋯ has Rename, Delete and
 * Select the points that follow it. Also the "Save as waypoint…" and "Select waypoint" buttons
 * beside the start and a path's ends. Degrees here, radians in the file (CLAUDE.md rule 3). Where
 * the project cannot write waypoints.json, the numbers are read only and one sentence says why.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { BookmarkPlus, Crosshair, Eye, EyeOff, MoreHorizontal, Plus } from "lucide-react";
import { waypointUses, waypointsUsed } from "@horizon36596/zenith-core";
import type { Waypoint } from "@horizon36596/zenith-schema";
import { ChoiceControl, CompactNumber, FieldRow, Section, type Choice } from "../components/fields";
import { usePoseBounds } from "./poseBounds";
import { Button, RowButton, TextButton } from "../components/primitives";
import { POSE_PROVENANCE_HINT, ProvenancePicker } from "../components/ProvenancePicker";
import { focusForInput } from "../components/inputModality";
import { Tooltip } from "../components/Tooltip";
import { ContextMenu } from "../canvas/ContextMenu";
import { actionById, isEnabled } from "../app/actions";
import { turnWords, useKeyLabel } from "../app/shortcuts";
import { pinMenuItems } from "../app/canvasMenu";
import { ownerSource, type PoseOwner } from "../app/edits";
import { askAddWaypoint } from "../app/waypointDialog";
import { waypointEditingOff, waypointUseName, whyNoWaypointFrom, writeWaypointProvenance } from "../app/waypointEdits";
import { measuredNotice, protectedLabel } from "../app/pinProtection";
import { changedWaypointNames, waypointImpact, type Impact } from "../app/waypointImpact";
import { groupWaypoints, unusedByAnyAuto, waypointsUsedElsewhere } from "../app/waypointGroups";
import {
  getState,
  hiddenWaypoints,
  openProjectKey,
  setSelection,
  setWaypointPins,
  setWaypointPinShown,
  showAllWaypointPins,
  useEditor,
  type State,
} from "../state/store";
import { useFeature } from "../state/features";
import { parseWaypointPins, projectPinOverrideCount, WAYPOINT_PINS_LABEL, type WaypointPinsMode } from "../state/waypointPins";
import { editingNumbers, formatDegrees, formatInches, type EditingNumbers } from "../settings/editingNumbers";
import { pinsHint, rowValues, splitName, usedByLine, writeRowNumber, type RowAxis } from "./waypointList";
import styles from "./Inspector.module.css";
import wp from "./WaypointSection.module.css";
import { closeRowMenuOf, getRowMenu, setRowMenu, subscribeRowMenu } from "./waypointRowMenu";

/** How long a waypoint edit must rest before the other autos are checked against it. */
const SETTLE_MS = 400;

/**
 * Which of the project's other autos follow the waypoint, and, once an edit has settled, how many
 * new errors the unsaved change gives each (issue #191). Other autos are read once per project; only
 * the checks run again. Null while they are being read; a failed read counts every auto unchecked.
 */
function useOtherAutos(name: string, state: State): Impact | null {
  const changed = changedWaypointNames(state).includes(name);
  const key = JSON.stringify([name, state.fileName, state.project?.name, state.project?.autoFiles, changed, changed ? state.project?.waypoints?.waypoints[name] : null]);
  const [done, setDone] = useState<{ key: string; impact: Impact } | null>(null);
  useEffect(() => {
    let live = true;
    const timer = setTimeout(
      () => {
        const now = getState();
        void waypointImpact([name], changed, now)
          .catch((): Impact => ({ followers: [], unreadable: [], unchecked: now.project?.autoFiles ?? [] }))
          .then((impact) => {
            if (live) setDone({ key, impact });
          });
      },
      changed ? SETTLE_MS : 0,
    );
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [key, name, changed]);
  return done?.key === key ? done.impact : null;
}

/**
 * The waypoints the project's other autos follow, read once the other autos are, or null until
 * then or when one of them could not be read (issue #217).
 */
function useUsedElsewhere(state: State): ReadonlySet<string> | null {
  const key = JSON.stringify([state.fileName, state.project?.name, state.project?.autoFiles]);
  const [done, setDone] = useState<{ key: string; used: ReadonlySet<string> | null } | null>(null);
  useEffect(() => {
    let live = true;
    void waypointsUsedElsewhere(getState())
      .catch(() => null)
      .then((used) => {
        if (live) setDone({ key, used });
      });
    return () => {
      live = false;
    };
  }, [key]);
  return done?.key === key ? done.used : null;
}

/**
 * The Pins row's choices, in the words every surface uses for them: All, This auto's and None
 * (issue #410). The mode is the same `waypointPins` preference the Settings row writes.
 */
const PIN_CHOICES: ReadonlyArray<Choice<WaypointPinsMode>> = [
  { value: "all", label: WAYPOINT_PINS_LABEL.all, hint: "Every waypoint's pin." },
  { value: "used", label: WAYPOINT_PINS_LABEL.used, hint: "Only the pins this auto follows." },
  { value: "none", label: WAYPOINT_PINS_LABEL.none, hint: "No pins, except the selected one." },
];

/** The three numbers of a row, each with what it is called, its step and its decimals. */
const AXES: ReadonlyArray<{
  axis: RowAxis;
  label: string;
  unit: string;
  step: number;
  digits: number;
  /** The hint, which names the person's own nudge and turn distances and Turn's keys as they have them. */
  hint: (numbers: EditingNumbers, turn: string | undefined) => string;
}> = [
  { axis: "x", label: "x", unit: "in", step: 0.5, digits: 1, hint: (numbers) => `Inches. The arrow keys nudge a selected pin on the field by ${formatInches(numbers.nudgeIn)}.` },
  { axis: "y", label: "y", unit: "in", step: 0.5, digits: 1, hint: (numbers) => `Inches. The arrow keys nudge a selected pin on the field by ${formatInches(numbers.nudgeIn)}.` },
  {
    axis: "h",
    label: "heading",
    unit: "°",
    step: 5,
    digits: 1,
    // Turn's keys as the person has them (issue #290); none when they removed them.
    hint: (numbers, turn) => (turn === undefined ? "Degrees." : `Degrees. ${turn} turn a selected pin by ${formatDegrees(numbers.rotateDeg)}.`),
  },
];

/**
 * One waypoint's row: name, x, y and heading on one 24 px line (issue #431), with an eye that hides
 * or shows its pin for this person in the left gutter and a ⋯ at its end. The eye and the ⋯ show
 * on hover or focus, and always on a touch screen; a hidden pin keeps its eye-off in view so it is
 * easy to show again. The selected row keeps the test ids the waypoint's own section had
 * (`inspector-waypoint-x` and the rest).
 */
function WaypointRow({
  name,
  waypoint,
  numbers,
  protect,
  selected,
  hidden,
  off,
  menuOpen,
  hasMenu,
  onMenu,
  onMenuPress,
  moreRef,
}: {
  name: string;
  waypoint: Waypoint;
  /** The person's nudge and turn distances, which the number hints name. */
  numbers: EditingNumbers;
  /** Protect measured waypoints is on: a measured pin's number selects its row first (decision D12). */
  protect: boolean;
  selected: boolean;
  hidden: boolean;
  off: string | null;
  menuOpen: boolean;
  /** False with the Waypoints switch off: the selected pin keeps its numbers but offers no Rename or Delete. */
  hasMenu: boolean;
  onMenu: () => void;
  onMenuPress: () => void;
  moreRef: (element: HTMLButtonElement | null) => void;
}) {
  const values = rowValues(waypoint);
  const bounds = usePoseBounds();
  const nameParts = splitName(name);
  const turn = turnWords(useKeyLabel("rotate"));
  const selectRow = (): void => {
    if (getState().selection.waypoint !== name) setSelection({ waypoint: name });
  };
  const line = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    // A pin selected on the field brings its row into view, scrolling no more than it needs.
    if (selected) line.current?.scrollIntoView({ block: "nearest" });
  }, [selected]);
  return (
    <div
      ref={line}
      className={`${styles.waypointRow} ${wp.row}`}
      data-selected={selected ? "" : undefined}
      data-hidden={hidden ? "" : undefined}
      data-menu-open={menuOpen ? "" : undefined}
      data-testid={`inspector-waypoint-line-${name}`}
    >
      <span className={wp.eye}>
        <RowButton
          icon={hidden ? EyeOff : Eye}
          label={hidden ? `Show pin ${name}` : `Hide pin ${name}`}
          hint="On your field only. waypoints.json and the autos stay as they are."
          testId={`inspector-waypoint-eye-${name}`}
          onClick={() => {
            setWaypointPinShown(name, hidden);
          }}
        />
      </span>
      <button
        type="button"
        className={`${styles.waypointName} ${wp.nameFlex}`}
        aria-pressed={selected}
        title={name}
        data-testid={`inspector-waypoint-row-${name}`}
        onClick={() => {
          setSelection({ waypoint: name });
        }}
      >
        {/* A long name is cut in the middle, so its last word always shows (flowerNo…Approach); the
            whole name is the button's tooltip. */}
        <span className={wp.nameHead}>{nameParts.head}</span>
        {nameParts.tail === "" ? null : <span className={wp.nameTail}>{nameParts.tail}</span>}
      </button>
      {/* A press or focus on a protected pin's number selects its row first, so the notice in its
          section (decision D12) is up before the number is committed. */}
      <span
        className={styles.waypointNumbers}
        onFocusCapture={protectedLabel(waypoint) !== null && protect ? selectRow : undefined}
        onPointerDownCapture={protectedLabel(waypoint) !== null && protect ? selectRow : undefined}
      >
        {AXES.map(({ axis, label, unit, step, digits, hint }) => (
          <CompactNumber
            key={axis}
            label={`${name} ${label}`}
            unit={unit}
            value={values[axis]}
            step={step}
            digits={digits}
            narrow={axis === "h"}
            {...(axis === "x" ? bounds.x : axis === "y" ? bounds.y : {})}
            disabled={off !== null}
            hint={hint(numbers, turn)}
            testId={selected ? `inspector-waypoint-${axis}` : `inspector-waypoint-${name}-${axis}`}
            onChange={(value) => {
              // A MEASURED waypoint's number is warned about and relabelled; its section opens to the
              // chip that sets MEASURED back, one click away (issue #273).
              if (writeRowNumber(name, axis, value) !== null && getState().selection.waypoint !== name) setSelection({ waypoint: name });
            }}
          />
        ))}
      </span>
      <span className={wp.more}>
        {hasMenu ? (
          <RowButton
            icon={MoreHorizontal}
            label={`More for ${name}`}
            hint="The pin's own menu, as a right-click on it opens: Rename, Delete and Select the points that follow it."
            testId={`inspector-waypoint-more-${name}`}
            expanded={menuOpen}
            buttonRef={moreRef}
            onPointerDown={onMenuPress}
            onClick={onMenu}
          />
        ) : null}
      </span>
    </div>
  );
}

/**
 * The selected waypoint's own section (issue #431), above the list: its provenance as a short chip
 * whose menu sets it, what typing a number does to a measured label, and one quiet Used by row whose
 * hint names every point and every other auto that follows it. Its numbers are edited in its list
 * row only, so each fact has one place; with the Waypoints switch off, that row is here instead.
 */
function PinSection({ name, waypoint, row }: { name: string; waypoint: Waypoint; row: ReactNode }) {
  const state = useEditor();
  const impact = useOtherAutos(name, state);
  const here = state.auto === null ? [] : waypointUses(state.auto, name).map(waypointUseName);
  const used = usedByLine(here, impact);
  // Before a number is typed the section says what it does to a measured label (decision D12).
  const measured = state.prefs.protectMeasuredPins ? protectedLabel(waypoint) : null;
  return (
    <Section title="Waypoint" foldId="waypoint.pin" forceOpen holder={name}>
      <div data-testid="inspector-waypoint-detail">
        {/* "Origin", not "Label": beside a pin's name a "Label" row reads as its name (issue #505). */}
        <FieldRow label="Origin" hint="Where this pin's numbers came from. Click the chip to change it.">
          <ProvenancePicker
            short
            provenance={waypoint.provenance}
            hint={POSE_PROVENANCE_HINT}
            testId="inspector-waypoint-provenance"
            onChange={(provenance) => {
              writeWaypointProvenance(name, provenance);
            }}
          />
        </FieldRow>
        {measured === null ? null : (
          <p className={styles.waypointNotice} data-testid="inspector-waypoint-measured-notice">
            {measuredNotice(measured, "you change a number here")}
          </p>
        )}
        <FieldRow label="Used by" quiet>
          <Tooltip label="Used by" hint={used.hint}>
            <span className={styles.waypointUsedBy} tabIndex={0} data-testid="inspector-waypoint-used-by">
              <span data-testid="inspector-waypoint-followers">{used.here}</span>
              {" · "}
              <span data-testid="inspector-waypoint-others">{used.others}</span>
            </span>
          </Tooltip>
        </FieldRow>
        {row}
      </div>
    </Section>
  );
}

/**
 * The waypoints of waypoints.json as compact rows (issue #431): the ones the open auto follows under
 * WAYPOINTS, with its count and a + that waits for a click on the field to place a new one, and the
 * rest under a closed OTHER WAYPOINTS, which opens by itself when one of them is selected or Pins
 * is All, each in the file's order (issue #217). The list's first row is the Pins choice beside the
 * x, y and heading column heads. One that no auto in the project follows says so. Clicking a name
 * selects the pin, which then shows on the field and takes the press even where a dot or the start
 * mark is drawn on it, and its own WAYPOINT section comes first.
 *
 * `listed` false is the Waypoints switch off: no list,
 * no groups and no Rename or Delete, only the selected pin's own section with its row, which still
 * edits and moves it.
 */
export function WaypointsSection({ selected, listed = true }: { selected?: string; listed?: boolean }) {
  const state = useEditor();
  const waypoints = state.project?.waypoints?.waypoints ?? {};
  const names = listed ? Object.keys(waypoints) : Object.keys(waypoints).filter((name) => name === selected);
  const off = waypointEditingOff(state);
  const hidden = hiddenWaypoints(state);
  const numbers = editingNumbers(state.prefs);
  const overrides = projectPinOverrideCount(state.prefs.waypointPinOverrides, openProjectKey(state));
  const add = actionById("waypoint.add");
  const canAdd = add !== undefined && isEnabled(add, state);
  const followedHere = useMemo<ReadonlySet<string>>(
    () => new Set(state.auto === null ? [] : waypointsUsed(state.auto)),
    [state.auto],
  );
  const { here, others } = groupWaypoints(names, followedHere);
  const usedElsewhere = useUsedElsewhere(state);
  const selectedOther = selected !== undefined && others.includes(selected);
  // With Waypoint pins on All the field shows the other waypoints too, so their group starts open.
  const showsAll = state.prefs.waypointPins === "all";

  // The ⋯ menu opens once its row is selected and laid out, so it sits under the button even when
  // selecting the row moved it.
  const { wanted, open: menu } = useSyncExternalStore(subscribeRowMenu, getRowMenu, getRowMenu);
  const moreButtons = useRef(new Map<string, HTMLButtonElement>());
  // A press on the ⋯ of an open menu closes it; this keeps the click that follows from opening it again.
  const closedByButton = useRef(false);
  // This list, so that only the list that opened the menu closes it when it goes (`waypointRowMenu.ts`).
  const [owner] = useState(() => Symbol("waypoint list"));
  useLayoutEffect(() => {
    if (wanted === null) return;
    const box = moreButtons.current.get(wanted)?.getBoundingClientRect();
    setRowMenu({
      wanted: null,
      open: box === undefined ? null : { name: wanted, xPx: box.left, yPx: box.bottom, items: pinMenuItems(wanted), owner },
    });
  }, [wanted, owner]);
  // A list that goes, as when a step is selected, takes its menu with it.
  useEffect(
    () => () => {
      closeRowMenuOf(owner);
    },
    [owner],
  );

  /** One waypoint's row, and its "Not used by any auto" line when `unused`. */
  const listRow = (name: string, unused: boolean) => {
    const waypoint = waypoints[name];
    if (waypoint === undefined) return null;
    return (
      <div key={name}>
        <WaypointRow
          name={name}
          waypoint={waypoint}
          numbers={numbers}
          protect={state.prefs.protectMeasuredPins}
          selected={selected === name}
          hidden={hidden.has(name)}
          off={off}
          menuOpen={menu?.name === name}
          hasMenu={listed}
          moreRef={(element) => {
            if (element === null) moreButtons.current.delete(name);
            else moreButtons.current.set(name, element);
          }}
          onMenuPress={() => {
            closedByButton.current = menu?.name === name;
          }}
          onMenu={() => {
            if (closedByButton.current) {
              closedByButton.current = false;
              return;
            }
            // As a right-click on the pin does, the ⋯ selects it first.
            setRowMenu({ wanted: name, open: null });
            if (getState().selection.waypoint !== name) setSelection({ waypoint: name });
          }}
        />
        {unused ? (
          <p className={styles.waypointUnused} data-testid={`inspector-waypoint-unused-${name}`}>
            Not used by any auto
          </p>
        ) : null}
      </div>
    );
  };

  /** One quiet line over the numbers: x, y and heading, after the Pins choice when the list has one. */
  const columns = (pins: boolean) => (
    <div className={wp.columns} data-testid="inspector-waypoints-columns">
      {pins ? (
        // Which pins the field shows sits on the column heads' line (issue #431), not on a row of its own.
        <span className={wp.pins} data-testid="inspector-waypoints-pins">
          <ChoiceControl
            label="Pins"
            value={state.prefs.waypointPins}
            options={PIN_CHOICES}
            buttonHint={pinsHint(hidden.size, names.length)}
            testId="inspector-waypoints-show"
            chevron
            compact
            onChange={(mode) => {
              setWaypointPins(parseWaypointPins(mode));
            }}
          />
        </span>
      ) : (
        <span className={wp.columnName} />
      )}
      <span className={wp.columnNumber} aria-hidden>
        x
      </span>
      <span className={wp.columnNumber} aria-hidden>
        y
      </span>
      <span className={wp.columnAngle} aria-hidden>
        heading
      </span>
      <span className={wp.columnMore} aria-hidden />
    </div>
  );

  const selectedWaypoint = selected === undefined ? undefined : waypoints[selected];
  const rowMenuShown =
    menu === null ? null : (
      <ContextMenu
        fixed
        xPx={menu.xPx}
        yPx={menu.yPx}
        items={menu.items}
        label={`Waypoint ${menu.name}`}
        testId="inspector-waypoint-menu"
        onClose={() => {
          const name = menu.name;
          setRowMenu({ wanted: null, open: null });
          focusForInput(moreButtons.current.get(name));
        }}
      />
    );

  return (
    <>
      {selected === undefined || selectedWaypoint === undefined ? null : (
        <PinSection
          key={`pin-${selected}`}
          name={selected}
          waypoint={selectedWaypoint}
          row={
            listed ? null : (
              <>
                {off === null ? null : (
                  <p className={styles.note} data-testid="inspector-waypoints-note">
                    {off}
                  </p>
                )}
                {columns(false)}
                {listRow(selected, false)}
              </>
            )
          }
        />
      )}
      {listed ? (
        <Section
          title="Waypoints"
          count={here.length}
          foldId="waypoint.list"
          // It only shows in the Routine view and with a waypoint selected (issue #244), so it starts
          // open when there is something in it; an empty list has nothing to show until one is placed.
          defaultOpen={names.length > 0}
          forceOpen={selected !== undefined}
          holder={selected}
          help="section.waypoints"
          // With a waypoint selected, its selection header has the `?`; the Routine view's is the Inspector's.
          helpInHeader={selected !== undefined}
          tight
          actions={
            <RowButton
              icon={Plus}
              label="Add waypoint"
              hint="Click the field where the pin goes, then name it. Esc cancels."
              disabled={!canAdd}
              whyDisabled={add?.whyDisabled?.(state)}
              testId="inspector-waypoints-add"
              onClick={() => {
                void add?.run();
              }}
            />
          }
        >
          {off !== null || names.length === 0 ? (
            <p className={styles.note} data-testid="inspector-waypoints-note">
              {off ?? "None yet. The + places one on the field."}
            </p>
          ) : null}
          {overrides === 0 ? null : (
            <div className={styles.waypointTools}>
              <TextButton
                label="Show all"
                hint="Forget the pins you hid or showed one by one in this project, so each follows Waypoint pins again."
                testId="inspector-waypoints-show-all"
                onClick={showAllWaypointPins}
              />
            </div>
          )}
          <div data-testid="inspector-waypoints">
            {names.length === 0 ? null : columns(true)}
            {here.map((name) => listRow(name, false))}
          </div>
        </Section>
      ) : null}
      {listed && others.length > 0 ? (
        <Section
          // Choosing All opens the group afresh, as selecting one of its waypoints does.
          key={showsAll ? "others-all" : "others"}
          title="Other waypoints"
          count={others.length}
          defaultOpen={selectedOther || showsAll}
          forceOpen={selectedOther}
          holder={selected}
          headTestId="inspector-waypoints-others"
          tight
        >
          <div data-testid="inspector-waypoints-other-list">
            {others.map((name) => listRow(name, unusedByAnyAuto(name, followedHere, usedElsewhere)))}
          </div>
        </Section>
      ) : null}
      {rowMenuShown}
    </>
  );
}

/**
 * The ⋯ of a selected waypoint's header (issue #431): the pin's own menu, as a right-click on it
 * opens, with Rename, Delete and Select the points that follow it.
 */
export function WaypointHeaderMenu({ name }: { name: string }) {
  const [open, setOpen] = useState<{ xPx: number; yPx: number } | null>(null);
  const button = useRef<HTMLButtonElement | null>(null);
  return (
    <>
      <RowButton
        icon={MoreHorizontal}
        label={`More for ${name}`}
        hint="Rename, Delete and Select the points that follow it, as a right-click on the pin offers."
        testId="inspector-waypoint-head-more"
        expanded={open !== null}
        buttonRef={(element) => {
          button.current = element;
        }}
        onClick={(event) => {
          if (open !== null) {
            setOpen(null);
            return;
          }
          const box = event.currentTarget.getBoundingClientRect();
          setOpen({ xPx: box.left, yPx: box.bottom });
        }}
      />
      {open === null ? null : (
        <ContextMenu
          fixed
          xPx={open.xPx}
          yPx={open.yPx}
          items={pinMenuItems(name)}
          label={`Waypoint ${name}`}
          testId="inspector-waypoint-head-menu"
          onClose={() => {
            setOpen(null);
            focusForInput(button.current);
          }}
        />
      )}
    </>
  );
}
/**
 * A path end's inline waypoint button, after its SourceSelect (issue #241): a crosshair that selects
 * the waypoint the end follows, or, for an end that follows none, a bookmark-plus that saves it as
 * one. Why it cannot is its tooltip, not a note under it.
 */
export function WaypointEndAction({ owner, follows }: { owner: PoseOwner; follows: string | null }) {
  const state = useEditor();
  const making = useFeature("waypoints");
  const id = owner === "start" ? "start" : `${owner.point.pointKind}-${String(owner.point.segmentIndex)}`;
  // The end's source is read here, so "Last step's end" and "Previous path's end", which are not a
  // pose of its own, offer nothing to save (issue #410).
  const source = state.auto === null ? undefined : ownerSource(state.auto, owner);
  if (follows === null && source === "current") return null;
  if (follows !== null) {
    return (
      <RowButton
        icon={Crosshair}
        label={`Select waypoint ${follows}`}
        testId={`inspector-${id}-select-waypoint`}
        onClick={() => {
          setSelection({ waypoint: follows });
        }}
      />
    );
  }
  // Saving a pose as a waypoint makes one, which the Waypoints switch takes away.
  if (!making) return null;
  const why = whyNoWaypointFrom(owner);
  return (
    <RowButton
      icon={BookmarkPlus}
      label="Save as waypoint…"
      testId={`inspector-${id}-save-waypoint`}
      disabled={why !== null}
      whyDisabled={why ?? undefined}
      onClick={() => askAddWaypoint(owner)}
    />
  );
}

/**
 * Beside the start: "Save as waypoint…" when it has a pose of its own, or "Select waypoint" when it
 * follows one, which selects that pin.
 */
export function WaypointOwnerActions({ owner, follows }: { owner: PoseOwner; follows: string | null }) {
  useEditor();
  const making = useFeature("waypoints");
  const id = owner === "start" ? "start" : `${owner.point.pointKind}-${String(owner.point.segmentIndex)}`;
  if (follows !== null) {
    return (
      <div className={styles.markerAdd}>
        <Button
          testId={`inspector-${id}-select-waypoint`}
          onClick={() => {
            setSelection({ waypoint: follows });
          }}
        >
          Select waypoint {follows}
        </Button>
      </div>
    );
  }
  // Saving a pose as a waypoint makes one, which the Waypoints switch takes away.
  if (!making) return null;
  const why = whyNoWaypointFrom(owner);
  return (
    <>
      <div className={styles.markerAdd}>
        <Button testId={`inspector-${id}-save-waypoint`} whyDisabled={why} onClick={() => askAddWaypoint(owner)}>
          Save as waypoint…
        </Button>
      </div>
      {why === null ? null : (
        <p className={styles.note} data-testid={`inspector-${id}-save-waypoint-why`}>
          {why}
        </p>
      )}
    </>
  );
}
