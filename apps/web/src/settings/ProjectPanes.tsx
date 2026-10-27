/**
 * The Settings sections that need no account: General, the person's feature switches (issue #101),
 * and Editor, the person's own view preferences. The open project's command library and pathing
 * system are in Robot, under Follower (issue #414), since choosing a library writes the project's
 * zenith.json. Robot and Commands are `RobotPanes.tsx`.
 */
import { useEffect, useState } from "react";
import { LIBRARIES_DOC } from "../account/config";
import { FIELD_VIEWS, FIELD_VIEW_LABEL, TOOLBAR_GROUPS, actionById, fieldHasPicture } from "../app/actions";
import { Segmented } from "../components/Segmented";
import { SheetButton } from "../cloud/controls";
import { Tooltip } from "../components/Tooltip";
import { setDescriptions, setPrefs, setSetting, setWaypointPins, toggleSnap, useEditor } from "../state/store";
import type { DefaultHeadingMode, Descriptions, FieldGrid, OptimizeScorer, Prefs, Theme } from "../state/prefs";
import type { DescriptionId } from "../help/descriptions";
import {
  DEFAULT_HEADING_OPTIONS,
  FIELD_GRID_OPTIONS,
  TOOLBAR_BUTTONS,
  getSetting,
  settingEntry,
  toolbarButtonShown,
  toolbarSettingId,
  type SettingId,
  type SettingValues,
} from "./registry";
import { NumberField } from "../components/fields";
import { WAYPOINT_PINS_LABEL, WAYPOINT_PINS_MODES, type WaypointPinsMode } from "../state/waypointPins";
import { setProjectCommandLibrary, type WriteOutcome } from "./actions";
import { EDITING_NUMBER_DIGITS, roundEditingNumber } from "./editingNumbers";
import { COMMAND_LIBRARIES, LIBRARY_DOES, LIBRARY_LABEL, codeSettingsOf, type CommandLibrary } from "./codeSettings";
import { clearanceValueText, optimizeMarginNote } from "./robotSettings";
import { FEATURES, actionShown, setFeature, settingId, useFeature, useFeatures } from "../state/features";
import { Group, Row } from "./parts";
import { SIM_SPEEDS, SIM_SPEED_COST, SIM_SPEED_DOES, SIM_SPEED_LABEL, type SimSpeed } from "../state/simSpeed";
import { isDesktop } from "../project/desktop";
import { openRobotClearance } from "./store";
import styles from "./Settings.module.css";

export function GeneralPane() {
  const features = useFeatures();
  return (
    <>
      <Group title="Features" testId="settings-features">
        {FEATURES.map((feature) => (
          <Row
            key={feature.id}
            label={feature.label}
            description={feature.description}
            testId={`settings-feature-${feature.id}`}
            setting={settingId(feature.id)}
          >
            <Segmented<Shown>
              label={feature.label}
              options={[
                { value: "on" as const, label: "On", does: `Show ${feature.label.toLowerCase()} everywhere in the editor.` },
                { value: "off" as const, label: "Off", does: `Hide ${feature.label.toLowerCase()}. Your files keep everything.` },
              ]}
              value={features[feature.id] ? "on" : "off"}
              onChange={(value) => {
                setFeature(feature.id, value === "on");
              }}
              testId={`settings-feature-${feature.id}-choice`}
            />
          </Row>
        ))}
      </Group>
      <FullSimSpeed />
      <p className={styles.paneNote}>These switches are yours, on this computer. They never change a project&apos;s files.</p>
    </>
  );
}

/**
 * Full sim speed (site/docs/full-sim-simloop.md): how the desktop app runs the robot repository's own
 * sim, shown while Full sim is offered. Each speed says what it does and what it costs the computer,
 * from `state/simSpeed.ts`. General holds only the person's own switches, so the row shows the
 * person's choice whatever project is open; a project without `sim.server` runs Basic, and the sim
 * panel says so when it runs (`desktopActions.ts`, `runHighFidelitySim`). Only the desktop app runs
 * that sim, so a browser draws no row (`desktopOnly`; 0.1.2 UX sweep, W1-3).
 */
function FullSimSpeed() {
  const { prefs } = useEditor();
  const fullSim = useFeature("fullSim");
  if (!fullSim || (settingEntry("sim.speed").desktopOnly === true && !isDesktop())) return null;
  const chosen = getSetting(prefs, "sim.speed");
  return (
    <Group title="Full sim" testId="settings-full-sim">
      <Row
        label="Full sim speed"
        description={settingEntry("sim.speed").description}
        testId="settings-sim-speed"
        setting="sim.speed"
        below={
          <>
            <dl className={styles.speeds} data-testid="settings-sim-speed-tiers">
              {SIM_SPEEDS.map((speed) => (
                <div key={speed} className={styles.speed} data-speed={speed}>
                  <dt className={styles.speedName}>{SIM_SPEED_LABEL[speed]}</dt>
                  <dd className={styles.speedText}>
                    {SIM_SPEED_DOES[speed]} {SIM_SPEED_COST[speed].wait} {SIM_SPEED_COST[speed].computer}
                  </dd>
                </div>
              ))}
            </dl>
          </>
        }
      >
        <Segmented<SimSpeed>
          label="Full sim speed"
          options={SIM_SPEEDS.map((speed) => ({
            value: speed,
            label: SIM_SPEED_LABEL[speed],
            does: `${SIM_SPEED_DOES[speed]} ${SIM_SPEED_COST[speed].computer}`,
          }))}
          value={chosen}
          onChange={(speed) => {
            setSetting("sim.speed", speed);
          }}
          testId="settings-sim-speed-choice"
        />
      </Row>
    </Group>
  );
}


/**
 * The open project's command library and pathing system, drawn in Robot under Follower (issue #414):
 * choosing a library writes the project's zenith.json, so the choice sits with the project's other
 * code settings, not with the person's own switches in General. The library shows with every switch
 * off: the generated class runs on its runtime even when the auto has only paths.
 */
export function CodeRows() {
  const { project, backend } = useEditor();
  const [outcome, setOutcome] = useState<WriteOutcome | null>(null);
  const [busy, setBusy] = useState(false);
  // Another project is another file: an old result would describe the wrong one.
  useEffect(() => {
    setOutcome(null);
  }, [project?.name]);
  if (project === null || backend === null) return null;

  const code = codeSettingsOf(project, backend.setCommandLibrary !== undefined);
  const choose = (library: CommandLibrary) => {
    if (busy || library === code.library) return;
    setBusy(true);
    void setProjectCommandLibrary(library).then((result) => {
      setOutcome(result);
      setBusy(false);
    });
  };

  return (
    <>
      <Row
        label="Command library"
        describe="settings.commandLibrary"
        keepBrief
        testId="settings-command-library"
        below={
          <>
            {code.whyCannotChange === null || project.source.kind === "example" ? null : (
              <p className={styles.note} data-testid="settings-command-library-why">
                {code.whyCannotChange}
              </p>
            )}
            {code.library === null ? (
              <p className={styles.note}>Not set yet. Zenith does not pick one for you.</p>
            ) : null}
            {outcome === null ? null : (
              <p
                className={outcome.ok ? styles.note : styles.error}
                role={outcome.ok ? "status" : "alert"}
                data-testid="settings-command-library-result"
              >
                {outcome.message}
              </p>
            )}
          </>
        }
      >
        {code.whyCannotChange === null ? (
          <Segmented
            label="Command library"
            options={COMMAND_LIBRARIES.map((library) => ({
              value: library,
              label: LIBRARY_LABEL[library],
              does: LIBRARY_DOES[library],
              whyDisabled: busy ? "Saving zenith.json." : null,
            }))}
            value={code.library ?? ("" as CommandLibrary)}
            onChange={choose}
            testId="settings-command-library-choice"
          />
        ) : (
          <span
            className={code.library === null ? styles.valueDefault : styles.value}
            data-testid="settings-command-library-value"
          >
            {code.library === null ? "Not set" : LIBRARY_LABEL[code.library]}
          </span>
        )}
      </Row>
      <Row
        label="Pathing system"
        describe="settings.pathingSystem"
        keepBrief
        testId="settings-pathing"
      >
        <span className={styles.value} data-testid="settings-pathing-value">
          {code.follower}
        </span>
      </Row>
      <p className={styles.paneNote}>
        Both libraries run the same autos.{" "}
        <a className={styles.link} href={LIBRARIES_DOC} target="_blank" rel="noreferrer">
          Choosing a command library
        </a>
      </p>
    </>
  );
}

const THEMES: ReadonlyArray<{ value: Theme; label: string; does: string }> = [
  { value: "dark", label: "Dark", does: "The Horizon night sky. The field stays dark in both themes." },
  { value: "light", label: "Light", does: "For bright rooms and printing. The field stays dark in both themes." },
];

/** What each Waypoint pins choice does (issue #236). */
const WAYPOINT_PINS_DOES: Record<WaypointPinsMode, string> = {
  all: "Show every pin in waypoints.json.",
  used: "Show only the pins the open auto follows.",
  none: "Hide every pin; the selected one still shows, faintly.",
};

/** The Descriptions option (issue #238), as issue #200's registry entry display.descriptions names it. */
const DESCRIPTION_MODES: ReadonlyArray<{ value: Descriptions; label: string; does: string }> = [
  { value: "compact", label: "Labels only", does: "Rows show their labels. Hover a label for a second, or press Shift F1, to read more." },
  { value: "full", label: "With descriptions", does: "Rows show a short line under their labels, and the rest on a long hover." },
];

type Shown = "on" | "off";

/** The settings whose value is a yes or a no. */
type SwitchId = { [Id in SettingId]: SettingValues[Id] extends boolean ? Id : never }[SettingId];

/**
 * A yes/no setting's control, drawn from its registry entry (issue #414): the entry says it is a
 * switch, the person's value is read at its storage key, and a press writes it through `setSetting`.
 * On and Off for a choice about how Zenith behaves; Show and Hide only for something that is drawn.
 */
function SettingSwitch({
  id,
  label,
  words = "onOff",
  on,
  off,
  testId,
}: {
  id: SwitchId;
  label: string;
  words?: "onOff" | "showHide";
  on: string;
  off: string;
  testId: string;
}) {
  const { prefs } = useEditor();
  if (settingEntry(id).control.type !== "switch") return null;
  const yes = words === "onOff" ? "On" : "Show";
  const no = words === "onOff" ? "Off" : "Hide";
  return (
    <Segmented<Shown>
      label={label}
      options={[
        { value: "on" as const, label: yes, does: on },
        { value: "off" as const, label: no, does: off },
      ]}
      value={getSetting(prefs, id) ? "on" : "off"}
      onChange={(value) => {
        setSetting(id, (value === "on") as never);
      }}
      testId={testId}
    />
  );
}

/**
 * Settings, Editor, Toolbar buttons: one icon button for each button this toolbar has, from the
 * registry's `display.toolbar.<actionId>` entries, pressed while the button shows. Hiding one takes
 * the button away and nothing else, so its key, its menu items and its palette row still work.
 */
function ToolbarButtons() {
  const { prefs } = useEditor();
  const onToolbar = new Set([...TOOLBAR_GROUPS.flat(), "help.docs"]);
  const buttons = TOOLBAR_BUTTONS.filter((button) => onToolbar.has(button.id) && actionShown(button.id, prefs.features));
  return (
    <Group title="Toolbar buttons" testId="settings-toolbar">
      <div className={styles.toolToggles} role="group" aria-label="Toolbar buttons">
        {buttons.map(({ id, label }) => {
          const shown = toolbarButtonShown(prefs, id);
          const Icon = actionById(id)?.icon;
          return (
            <span key={id} data-setting={toolbarSettingId(id)}>
              <Tooltip
                label={label}
                hint={shown ? "On the toolbar. Press to hide the button; its key and the search still run it." : "Hidden. Press to show its button on the toolbar."}
              >
                <button
                  type="button"
                  className={styles.toolToggle}
                  aria-pressed={shown}
                  aria-label={label}
                  data-testid={`settings-toolbar-${id}`}
                  onClick={() => {
                    setSetting(toolbarSettingId(id), !shown);
                  }}
                >
                  {Icon === undefined ? label : <Icon size={16} strokeWidth={1.75} aria-hidden />}
                </button>
              </Tooltip>
            </span>
          );
        })}
      </div>
    </Group>
  );
}

export function EditorPane() {
  const state = useEditor();
  const { prefs } = state;
  // The field view only chooses between a field file's own picture and the drawn field.
  const picture = fieldHasPicture(state);
  const ledger = useFeature("ledger");
  const optimizer = useFeature("optimizer");
  return (
    <>
      <Group title="Appearance">
        <Row label="Theme" testId="settings-theme" setting="display.theme">
          <Segmented
            label="Theme"
            options={THEMES}
            value={prefs.theme}
            onChange={(theme) => {
              setSetting("display.theme", theme);
            }}
            testId="settings-theme-choice"
          />
        </Row>
        <Row label="Descriptions" describe="settings.descriptions" testId="settings-descriptions">
          <Segmented<Descriptions>
            label="Descriptions"
            options={DESCRIPTION_MODES}
            value={prefs.descriptions}
            onChange={setDescriptions}
            testId="settings-descriptions-choice"
          />
        </Row>
        <Row
          label={settingEntry("display.findingCodes").label}
          hint={settingEntry("display.findingCodes").description}
          testId="settings-finding-codes"
          setting="display.findingCodes"
        >
          <SettingSwitch
            id="display.findingCodes"
            label="Finding codes"
            words="showHide"
            on="Show each problem's code beside it."
            off="Hide the codes; the sentence and its fix still show."
            testId="settings-finding-codes-choice"
          />
        </Row>
      </Group>
      <Group title="Field">
        {picture ? (
          <Row label="Field view" description="What is drawn under your routine." testId="settings-field-view" setting="display.fieldView">
            <Segmented
              label="Field view"
              options={FIELD_VIEWS.map((view) => ({
                value: view,
                label: FIELD_VIEW_LABEL[view].charAt(0).toUpperCase() + FIELD_VIEW_LABEL[view].slice(1),
                does: `Show the ${FIELD_VIEW_LABEL[view]}.`,
              }))}
              value={prefs.fieldView}
              onChange={(fieldView) => {
                setSetting("display.fieldView", fieldView);
              }}
              testId="settings-field-view-choice"
            />
          </Row>
        ) : null}
        <Row label="Grid" describe="settings.fieldGrid" testId="settings-field-grid" setting="display.fieldGrid">
          <select
            className={styles.select}
            aria-label="Grid"
            data-testid="settings-field-grid-choice"
            value={prefs.fieldGrid}
            onChange={(event) => {
              setSetting("display.fieldGrid", event.target.value as FieldGrid);
            }}
          >
            {FIELD_GRID_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </Row>
        <Row
          label="Snap"
          description="Points stop at waypoints, walls and the grid, and headings at 15°. Ctrl flips it for one drag."
          testId="settings-snap"
          setting="editing.snap"
        >
          <Segmented
            label="Snap"
            options={[
              { value: "on" as const, label: "On", does: "Points and headings snap while you drag." },
              { value: "off" as const, label: "Off", does: "Points and headings move freely." },
            ]}
            value={prefs.snap ? "on" : "off"}
            onChange={(value) => {
              if ((value === "on") !== prefs.snap) toggleSnap();
            }}
            testId="settings-snap-choice"
          />
        </Row>
        <Row label="Heading for new paths" describe="settings.defaultHeading" testId="settings-default-heading" setting="editing.defaultHeading">
          <select
            className={styles.select}
            aria-label="Heading for new paths"
            data-testid="settings-default-heading-choice"
            value={prefs.defaultHeading}
            onChange={(event) => {
              setSetting("editing.defaultHeading", event.target.value as DefaultHeadingMode);
            }}
          >
            {DEFAULT_HEADING_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </Row>
        <Row
          label={settingEntry("display.waypointPins").label}
          description={settingEntry("display.waypointPins").description}
          testId="settings-waypoint-pins"
          setting="display.waypointPins"
        >
          <Segmented<WaypointPinsMode>
            label="Waypoint pins"
            options={WAYPOINT_PINS_MODES.map((mode) => ({ value: mode, label: WAYPOINT_PINS_LABEL[mode], does: WAYPOINT_PINS_DOES[mode] }))}
            value={prefs.waypointPins}
            onChange={setWaypointPins}
            testId="settings-waypoint-pins-choice"
          />
        </Row>
        <Row label="Clip ghosts" describe="settings.clipGhosts" testId="settings-clip-ghosts" setting="display.clipGhosts">
          <SettingSwitch
            id="display.clipGhosts"
            label="Clip ghosts"
            words="showHide"
            on="Draw them on the field."
            off="Hide them; hovering a problem still shows its ghost."
            testId="settings-clip-ghosts-choice"
          />
        </Row>
        {/* Planned as issue #200 registry entry `field.overheadOutlines`: Basic off, Essential and Full on. */}
        <Row
          label="Overhead outlines"
          description="Dashed outlines of the hive frame and hive the robot drives under. Bands it hits always show."
          testId="settings-overhead-outlines"
        >
          <Segmented<Shown>
            label="Overhead outlines"
            options={[
              { value: "on" as const, label: "Show", does: "Draw them on the field." },
              { value: "off" as const, label: "Hide", does: "Hide them; the legs' bands still show." },
            ]}
            value={prefs.overheadOutlines ? "on" : "off"}
            onChange={(value) => {
              setPrefs({ overheadOutlines: value === "on" });
            }}
            testId="settings-overhead-outlines-choice"
          />
        </Row>
        <Row label="Clearance outline" describe="settings.clearanceOutline" testId="settings-clearance-outline" setting="display.clearanceOutline">
          <SettingSwitch
            id="display.clearanceOutline"
            label="Clearance outline"
            words="showHide"
            on="Draw it around the robot at the playhead."
            off="Hide it; the clearance still applies."
            testId="settings-clearance-outline-choice"
          />
        </Row>
        {ledger ? (
          <Row label="Ledger counts" testId="settings-ledger-counts" setting="display.ledgerCounts">
            <SettingSwitch
              id="display.ledgerCounts"
              label="Ledger counts"
              words="showHide"
              on="Draw the counts on the field."
              off="Hide them; the Ledger panel still lists them."
              testId="settings-ledger-counts-choice"
            />
          </Row>
        ) : null}
      </Group>
      <Group title="Editing" testId="settings-editing">
        <Row
          label="Start a new path with the previous path's end heading"
          describe="settings.newPathKeepsHeading"
          testId="settings-new-path-keeps-heading"
          setting="editing.newPathKeepsHeading"
        >
          <SettingSwitch
            id="editing.newPathKeepsHeading"
            label="Start a new path with the previous path's end heading"
            on="A new path starts at the heading the robot already has, and a Linear one keeps it."
            off="A Linear new path turns to the way it drives, or to the heading you click."
            testId="settings-new-path-keeps-heading-choice"
          />
        </Row>
        <Row label="Protect measured waypoints" describe="settings.protectMeasuredPins" testId="settings-protect-measured-pins" setting="editing.protectMeasuredPins">
          <SettingSwitch
            id="editing.protectMeasuredPins"
            label="Protect measured waypoints"
            on="A measured pin selects on its first press and moves on the next."
            off="A measured pin moves on the first press, as any pin does."
            testId="settings-protect-measured-pins-choice"
          />
        </Row>
        {EDITING_NUMBER_IDS.map((id) => (
          <NumberSettingRow key={id} id={id} prefs={prefs} />
        ))}
      </Group>
      {optimizer ? <OptimizeGroup /> : null}
      <ToolbarButtons />
    </>
  );
}

/** The number settings Editing lists, in the order the keys are learnt: nudge, far nudge, rotate, playhead. */
const EDITING_NUMBER_IDS = ["editing.nudgeIn", "editing.nudgeFarIn", "editing.rotateDeg", "editing.scrubStepS"] as const;

/**
 * One number setting as a row: its registered unit, range and step, so typing or scrubbing past the
 * range stops at the end of it. The value is always in range, so a stored one that is not never shows.
 */
function NumberSettingRow({ id, prefs }: { id: (typeof EDITING_NUMBER_IDS)[number]; prefs: Prefs }) {
  const entry = settingEntry(id);
  const { control } = entry;
  if (control.type !== "number") return null;
  return (
    <NumberField
      label={entry.label}
      unit={control.unit}
      value={getSetting(prefs, id)}
      step={control.step}
      min={control.min}
      max={control.max}
      digits={EDITING_NUMBER_DIGITS}
      hint={`${entry.description} From ${String(control.min)} to ${String(control.max)} ${control.unit}.`}
      testId={`settings-editing-${entry.storage}`}
      onChange={(value) => {
        setSetting(id, roundEditingNumber(value));
      }}
    />
  );
}

/** The heading holds Optimize path takes (issue #448), start first; the card shows the same two. */
const OPTIMIZE_HOLD_IDS = ["optimizer.holdStartHeadingIn", "optimizer.holdEndHeadingIn"] as const;

/** Each hold's entry in the description table, whose brief shows under its label in With descriptions. */
const HOLD_DESCRIBE = {
  "optimizer.holdStartHeadingIn": "settings.holdStartHeading",
  "optimizer.holdEndHeadingIn": "settings.holdEndHeading",
} as const satisfies Record<(typeof OPTIMIZE_HOLD_IDS)[number], DescriptionId>;

/** One heading hold as a row, in whole inches, 0 off. Its test id is the one the settings search lands on for a number setting. */
function HoldSettingRow({ id, prefs }: { id: (typeof OPTIMIZE_HOLD_IDS)[number]; prefs: Prefs }) {
  const entry = settingEntry(id);
  const { control } = entry;
  if (control.type !== "number") return null;
  return (
    <NumberField
      label={entry.label}
      unit={control.unit}
      value={getSetting(prefs, id)}
      step={control.step}
      min={control.min}
      max={control.max}
      digits={0}
      hint={`${entry.description} From ${String(control.min)} to ${String(control.max)} ${control.unit}.`}
      describe={HOLD_DESCRIBE[id]}
      rowTestId={`settings-row-${entry.storage}`}
      testId={`settings-editing-${entry.storage}`}
      onChange={(value) => {
        setSetting(id, Math.round(value / control.step) * control.step);
      }}
    />
  );
}

const OPTIMIZE_SCORERS: ReadonlyArray<{ value: OptimizeScorer; label: string; does: string }> = [
  { value: "sim", label: "Instant sim", does: "Lower the time the instant sim gives, and check its own motion against the margin." },
  { value: "estimate", label: "Estimate", does: "Lower the estimate. The margin is checked on the planned path only." },
];

/**
 * What the optimizer card starts with. The margin is the robot's own clearance and is only shown here:
 * it is set in Settings, Robot, and the card may use another for one run without saving it (owner
 * ruling D8).
 */
function OptimizeGroup() {
  const { prefs, project } = useEditor();
  return (
    <Group title="Optimize path" testId="settings-optimize">
      <Row
        label="Safety margin"
        hint="The robot's clearance from field elements, 1 in until you set it in Robot. The card may use another margin for one run, never saved."
        // The Pedro drift sentence is long and has a number in it, so it is the row's line, not its hint.
        description={optimizeMarginNote(project?.robot ?? null)}
        testId="settings-optimize-margin"
      >
        <span className={styles.inline}>
          <span className={styles.readValue} data-testid="settings-optimize-margin-value">
            {project === null ? "No project open" : clearanceValueText(project.robot)}
          </span>
          {project === null ? null : (
            <SheetButton
              tooltip="Change in Robot"
              hint="Opens Robot at Clearance from field elements, where the margin is set."
              onClick={openRobotClearance}
              testId="settings-optimize-margin-change"
            >
              Change in Robot
            </SheetButton>
          )}
        </span>
      </Row>
      <Row label="Score with" description="Which time Optimize path tries to lower." testId="settings-optimize-scorer" setting="optimizer.scorer">
        <Segmented<OptimizeScorer>
          label="Score with"
          options={OPTIMIZE_SCORERS}
          value={prefs.optimizeScorer}
          onChange={(scorer) => {
            setSetting("optimizer.scorer", scorer);
          }}
          testId="settings-optimize-scorer-choice"
        />
      </Row>
      <Row label="Allow several paths" testId="settings-optimize-split" setting="optimizer.allowSplit">
        <SettingSwitch
          id="optimizer.allowSplit"
          label="Allow several paths"
          on="Optimize path may split a chain into up to four paths."
          off="Optimize path keeps the chain's paths as they are."
          testId="settings-optimize-split-choice"
        />
      </Row>
      <Row label="Allow heading ranges" testId="settings-optimize-ranges" setting="optimizer.allowRanges">
        <SettingSwitch
          id="optimizer.allowRanges"
          label="Allow heading ranges"
          on="Optimize path may change the heading mode part of the way along a path."
          off="Optimize path keeps each path's heading mode."
          testId="settings-optimize-ranges-choice"
        />
      </Row>
      {OPTIMIZE_HOLD_IDS.map((id) => (
        <HoldSettingRow key={id} id={id} prefs={prefs} />
      ))}
    </Group>
  );
}
