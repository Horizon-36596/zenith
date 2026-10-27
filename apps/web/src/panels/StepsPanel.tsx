/**
 * The step list: one 28 px row per step, nested under its group, with the insert menu at the foot.
 *
 * - Click selects a step; Ctrl-click adds it to a multi-selection or takes it out, and Shift-click
 *   selects the run of rows from the last plain click to it, for "wrap in a group" (issue #505).
 * - Right-click (or Shift+F10 and the context-menu key on a focused row) opens the step menu, built
 *   from the same action table as the toolbar and palette. Its first item, "Play from here", moves
 *   the playhead to where the step starts at the playback level and plays (issue #141).
 * - Drag a row by its handle before or after another row, or onto a group to put it inside; that
 *   is how a step moves into or out of a group. `Alt + ↑ ↓` is the keyboard equivalent: it moves
 *   the selected step one row, into an open group next to it or out past the end of its own
 *   (`moveSelection` in `app/edits.ts`).
 * - On a focused row, Up, Down, Home and End select and focus the row there, Left and Right fold and
 *   unfold a group, Shift with Up or Down extends the selection, and R is consumed so a row never
 *   turns a pose. One row is in the Tab order (roving focus). Enter and Space on the only selected
 *   row are the app's, decided in `useKeyboard` from `data-step-key` (issue #161).
 * - A step that starts somewhere other than where the one before it ends keeps its severity dot,
 *   and its fix stays in Problems, the one place it is offered (issue #411).
 * - Each row shows its time, right-aligned, and one long-hover tooltip names it, its kind and that
 *   time; the bars are the timeline's alone (issue #411).
 * - While the playhead is placed, every step running at it is highlighted (issue #111): the step,
 *   the groups it sits in and each running branch of a parallel group (`useActiveSteps.ts`). While
 *   playing, the deepest running row scrolls into view, unless the person scrolled the list in the
 *   last few seconds.
 *
 * The list subscribes to the parts of the editor state it draws, not to the whole state, so a frame
 * of playback that moves only the playhead does not draw it again.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent } from "react";
import { ChevronDown, ChevronRight, Copy, GripVertical, ListOrdered, Play, Plus, Trash } from "lucide-react";
import {
  deleteSelection,
  duplicateSelection,
  moveStepTo,
  refuseStepRename,
  renameStepTo,
  stepRenameProblem,
  stepsInside,
  wrapRefusal,
  wrapTargets,
} from "../app/edits";
import { INSERT_ANOTHER_LABEL } from "../app/canvasMenu";
import { focusForInput } from "../components/inputModality";
import { keyBindingForKey } from "../app/keymap";
import { useKeyLabel } from "../app/shortcuts";
import { ActionMenu, type MenuEntry } from "../components/ActionMenu";
import { EmptyState, RowButton, SeverityDot } from "../components/primitives";
import { Tooltip } from "../components/Tooltip";
import { playFrom, playFromStep } from "../app/playFromHere";
import { renameFieldCh, seconds as formatSeconds } from "../lib/format";
import { KIND_ICON, KIND_NOUN, TURN_ICON, TURN_NOUN, turnIds } from "../lib/stepKinds";
import { transferChip, transferOverridden, transferWords } from "../lib/transfer";
import { indexSteps, isGroupKind, type StepEntry } from "../lib/stepOps";
import { type DropPosition } from "../lib/structure";
import { estimateByStep, findingsByStep } from "../state/derived";
import { hiddenDataNotes, hiddenStepIds } from "../state/features";
import { MAX_FOLDED_GROUPS, foldKey } from "../state/prefs";
import {
  getState,
  isReadOnly,
  selectStep,
  selectStepRange,
  setPrefs,
  toggleMultiStep,
  useDerived,
  useEditor,
  useSelector,
  type State,
} from "../state/store";
import { useSim } from "../state/sim";
import { closeInsertMenu, closeStepMenu, openInsertMenu, openStepMenu, useUi, type StepMenu as StepMenuState } from "../state/ui";
import { InsertMenu } from "./InsertMenu";
import { useActiveSteps } from "./useActiveSteps";
import styles from "./StepsPanel.module.css";

const selectAuto = (state: State): State["auto"] => state.auto;
const selectSelection = (state: State): State["selection"] => state.selection;
const selectTrace = (state: State): State["trace"] => state.trace;
const selectMultiSteps = (state: State): State["multiSteps"] => state.multiSteps;
const selectFeatures = (state: State): State["prefs"]["features"] => state.prefs.features;
const selectFoldedGroups = (state: State): State["prefs"]["foldedGroups"] => state.prefs.foldedGroups;
const selectFileName = (state: State): State["fileName"] => state.fileName;
const selectReadOnly = (state: State): boolean => isReadOnly(state);
const selectPlaying = (state: State): boolean => state.playing;

/** How long after the person scrolls the list that playback leaves the scroll alone (issue #411). */
const FOLLOW_PAUSE_MS = 3000;
/** Scroll events this soon after the list scrolled itself to the running row are its own. */
const OWN_SCROLL_MS = 400;

/** The nearest ancestor that scrolls, which is what the running row is brought into view in. */
function scrollingAncestor(element: HTMLElement): HTMLElement | null {
  for (let at = element.parentElement; at !== null; at = at.parentElement) {
    const overflow = getComputedStyle(at).overflowY;
    if (overflow === "auto" || overflow === "scroll") return at;
  }
  return null;
}

const RANK = { error: 0, warning: 1, info: 2 } as const;

/** Where Up, Down, Home and End take the focus on a step row. */
type RowMove = "up" | "down" | "home" | "end";

interface Drop {
  targetId: string;
  position: DropPosition;
}

/** Where a drag over `row` lands: the top third before it, the bottom third after, a group's middle into it. */
function dropPositionFor(event: ReactDragEvent<HTMLElement>, entry: StepEntry): DropPosition {
  const box = event.currentTarget.getBoundingClientRect();
  const at = (event.clientY - box.top) / Math.max(1, box.height);
  if (isGroupKind(entry.step.kind)) {
    if (at < 0.3) return "before";
    if (at > 0.7) return "after";
    return "into";
  }
  return at < 0.5 ? "before" : "after";
}

/** Folds a group row shut, or opens it; kept in UI prefs so the list looks the same next visit. */
function toggleFold(stepId: string): void {
  const { fileName, prefs } = getState();
  const key = foldKey(fileName, stepId);
  const next = prefs.foldedGroups.includes(key)
    ? prefs.foldedGroups.filter((candidate) => candidate !== key)
    : [...prefs.foldedGroups, key].slice(-MAX_FOLDED_GROUPS);
  setPrefs({ foldedGroups: next });
}

/** The folded group that hides `entry`, outermost first, or undefined when it is on show. */
function hiddenBy(
  byId: ReadonlyMap<string, StepEntry>,
  entry: StepEntry,
  isFolded: (id: string) => boolean,
): string | undefined {
  let hidden: string | undefined;
  for (let parent = entry.parentId; parent !== undefined; parent = byId.get(parent)?.parentId) {
    if (isFolded(parent)) hidden = parent;
  }
  return hidden;
}

/** True when `candidate` sits somewhere inside the step named `ancestorId`. */
function isInside(entries: readonly StepEntry[], candidate: StepEntry, ancestorId: string): boolean {
  let parent = candidate.parentId;
  while (parent !== undefined) {
    if (parent === ancestorId) return true;
    parent = entries.find((entry) => entry.id === parent)?.parentId;
  }
  return false;
}

export function StepsPanel() {
  const auto = useSelector(selectAuto);
  const selection = useSelector(selectSelection);
  const trace = useSelector(selectTrace);
  const multiSteps = useSelector(selectMultiSteps);
  const features = useSelector(selectFeatures);
  const foldedGroups = useSelector(selectFoldedGroups);
  const fileName = useSelector(selectFileName);
  const readOnly = useSelector(selectReadOnly);
  const playing = useSelector(selectPlaying);
  const derived = useDerived();
  const { stepMenu } = useUi();
  const [drop, setDrop] = useState<Drop | null>(null);
  const dragged = useRef<StepEntry | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  /** The row button that had focus last, so a delete that removes it hands focus to the next row. */
  const focusedRow = useRef<HTMLElement | null>(null);

  const entries = useMemo(() => (auto === null ? [] : indexSteps(auto)), [auto]);
  const byId = useMemo(() => new Map(entries.map((entry) => [entry.id, entry])), [entries]);
  const parentOf = useMemo(() => new Map(entries.map((entry) => [entry.id, entry.parentId])), [entries]);
  const running = useActiveSteps(parentOf);
  // What a switch that hides file data hides (command steps while Commands is off): kept in the
  // file, left out of the list, with one line for each switch saying where it went.
  const hidden = useMemo(() => hiddenStepIds(auto, features), [auto, features]);
  const hiddenNotes = useMemo(() => hiddenDataNotes(auto, features), [auto, features]);
  const foldedKeys = useMemo(() => new Set(foldedGroups), [foldedGroups]);
  const isFolded = (id: string): boolean => foldedKeys.has(foldKey(fileName, id));
  // A selection hidden inside a folded group is shown on the group row that hides it.
  const selectedEntry = selection.stepId === undefined ? undefined : byId.get(selection.stepId);
  const selectionHiddenBy =
    selectedEntry === undefined ? undefined : hiddenBy(byId, selectedEntry, isFolded);
  const perStep = useMemo(() => estimateByStep(derived.estimate), [derived.estimate]);
  // A turn on the spot is a path step with no length; its row reads as a turn (issue #505).
  const turns = useMemo(() => turnIds(derived.plan), [derived.plan]);
  /** The row a Shift-click's run starts from: the last row clicked or walked to without Shift. */
  const rangeAnchor = useRef<string | null>(null);
  const byStep = useMemo(() => findingsByStep(derived.findings), [derived.findings]);
  const actualByStep = useMemo(() => {
    const map = new Map<string, number>();
    for (const step of trace?.steps ?? []) map.set(step.id, step.endS - step.startS);
    return map;
  }, [trace]);

  const closeMenu = useCallback(() => {
    closeStepMenu();
  }, []);
  const open = auto !== null;

  // A delete removes the focused row, and focus would fall to the page; the row the delete selected
  // takes it instead, so a second Delete keeps going (issue #411).
  // Only a row that left the page counts: focus that moved elsewhere, a click on the field say, stays
  // where it went, so the arrows keep nudging what the field selected.
  useEffect(() => {
    const row = focusedRow.current;
    if (row === null || row.isConnected || selection.stepId === undefined) return;
    if (document.activeElement !== null && document.activeElement !== document.body) return;
    focusedRow.current = null;
    focusForInput(document.querySelector<HTMLElement>(`[data-testid="step-main-${CSS.escape(selection.stepId)}"]`));
  }, [selection.stepId, auto]);

  // While playing, the deepest running row is kept in view, unless the person scrolled the list in
  // the last few seconds: they are reading something else (issue #411).
  const scrolledAt = useRef(Number.NEGATIVE_INFINITY);
  const ownScrollAt = useRef(Number.NEGATIVE_INFINITY);
  useEffect(() => {
    const list = listRef.current;
    const scroller = list === null ? null : scrollingAncestor(list);
    if (scroller === null) return;
    const onScroll = (): void => {
      if (performance.now() - ownScrollAt.current > OWN_SCROLL_MS) scrolledAt.current = performance.now();
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      scroller.removeEventListener("scroll", onScroll);
    };
  }, [open]);
  const deepestRunning = useMemo(() => {
    let deepest: StepEntry | undefined;
    for (const entry of entries) if (running.has(entry.id) && (deepest === undefined || entry.depth >= deepest.depth)) deepest = entry;
    return deepest?.id;
  }, [entries, running]);
  useEffect(() => {
    if (!playing || deepestRunning === undefined) return;
    if (performance.now() - scrolledAt.current < FOLLOW_PAUSE_MS) return;
    const row = document.querySelector<HTMLElement>(`[data-testid="step-row-${CSS.escape(deepestRunning)}"]`);
    if (row === null) return;
    ownScrollAt.current = performance.now();
    row.scrollIntoView({ block: "nearest" });
  }, [playing, deepestRunning]);

  // The title bar already says no auto is open, so the list says only what it holds (UX review, S4).
  if (auto === null) {
    return (
      <EmptyState
        icon={ListOrdered}
        line="No steps yet"
        testId="steps-empty"
      />
    );
  }

  // The rows on show, in order: what Up, Down, Home and End walk. A step inside a folded group, or a
  // command step while Commands is off, is not one of them.
  const visibleIds = entries
    .filter((entry) => !hidden.has(entry.id) && hiddenBy(byId, entry, isFolded) === undefined)
    .map((entry) => entry.id);
  // Focus roves: one row is in the Tab order, the selected one (or the group that hides the
  // selection), else the first, so Tab goes through the list in one press.
  const tabStopId =
    selection.stepId !== undefined && visibleIds.includes(selection.stepId)
      ? selection.stepId
      : (selectionHiddenBy ?? visibleIds[0]);
  // The first group row on show: where the tour's Groups stop points (0.1.2 UX sweep, W1-5).
  const groupsAnchor = visibleIds.find((id) => {
    const kind = byId.get(id)?.step.kind;
    return kind !== undefined && isGroupKind(kind);
  });

  /** Up, Down, Home and End from the row `from`: select and focus the row there, or with Shift add it. */
  const navigate = (from: string, to: RowMove, extend: boolean): void => {
    const at = visibleIds.indexOf(from);
    if (at < 0) return;
    const index = to === "up" ? at - 1 : to === "down" ? at + 1 : to === "home" ? 0 : visibleIds.length - 1;
    const next = visibleIds[Math.min(Math.max(index, 0), visibleIds.length - 1)];
    if (next === undefined || next === from) return;
    if (extend && (to === "up" || to === "down")) {
      const chosen =
        multiSteps.length > 0 ? multiSteps : selection.stepId === undefined ? [] : [selection.stepId];
      if (!chosen.includes(from)) {
        // Shift from a focused row that is not selected starts a selection of that row and the next.
        selectStep(from);
        toggleMultiStep(next);
      } else if (multiSteps.includes(next)) {
        // Going back over a row already in the selection lets go of the one left behind.
        toggleMultiStep(from);
      } else {
        toggleMultiStep(next);
      }
    } else {
      selectStep(next);
      rangeAnchor.current = next;
    }
    focusForInput(document.querySelector<HTMLElement>(`[data-testid="step-main-${CSS.escape(next)}"]`));
  };

  /**
   * Shift-click on `to` (issue #505): selects the rows on show from the anchor, the last row clicked
   * without Shift, to `to`. When the two share a list, only that list's rows are taken, so a group
   * between them goes in whole and Wrap can wrap the run; otherwise every row between them is.
   */
  const selectRange = (to: string): void => {
    const from = rangeAnchor.current ?? selection.stepId;
    if (from === undefined || from === null || !visibleIds.includes(from) || from === to) {
      rangeAnchor.current = to;
      selectStep(to);
      return;
    }
    const start = visibleIds.indexOf(from);
    const end = visibleIds.indexOf(to);
    const between = visibleIds.slice(Math.min(start, end), Math.max(start, end) + 1);
    const a = byId.get(from);
    const b = byId.get(to);
    const sameList = a !== undefined && b !== undefined && a.parentId === b.parentId && a.arm === b.arm;
    const run = sameList
      ? between.filter((id) => {
          const entry = byId.get(id);
          return entry !== undefined && entry.parentId === a.parentId && entry.arm === a.arm;
        })
      : between;
    selectStepRange(start <= end ? run : [...run].reverse(), to);
  };

  return (
    <div
      ref={listRef}
      className={styles.list}
      role="list"
      data-testid="steps-list"
      aria-label="Steps"
      onFocus={(event) => {
        focusedRow.current =
          event.target instanceof HTMLElement && event.target.dataset["stepKey"] !== undefined ? event.target : null;
      }}
    >
      {hiddenNotes.map(({ feature, note }) => (
        <p key={feature} className={styles.hiddenNote} role="note" data-testid={`steps-hidden-${feature}`}>
          {note}
        </p>
      ))}
      {entries.map((entry) => {
        if (hidden.has(entry.id) || hiddenBy(byId, entry, isFolded) !== undefined) return null;
        const findings = byStep.get(entry.id) ?? [];
        const worst = [...findings].sort((a, b) => RANK[a.severity] - RANK[b.severity])[0];
        const inMulti = multiSteps.includes(entry.id);
        const selected = selection.stepId === entry.id || inMulti || selectionHiddenBy === entry.id;
        const group = isGroupKind(entry.step.kind);
        return (
          <div key={entry.id} className={styles.rowWrap}>
            <StepRow
              entry={entry}
              turn={turns.has(entry.id)}
              tour={entry.id === groupsAnchor ? "groups" : undefined}
              selected={selected}
              primary={selection.stepId === entry.id || selectionHiddenBy === entry.id}
              running={running.has(entry.id)}
              folded={group ? isFolded(entry.id) : undefined}
              seconds={perStep.get(entry.id) ?? null}
              actualS={actualByStep.get(entry.id) ?? null}
              findingCount={findings.length}
              worstSeverity={worst?.severity}
              drop={drop?.targetId === entry.id ? drop.position : null}
              readOnly={readOnly}
              tabStop={tabStopId === entry.id}
              onNavigate={(to, extend) => {
                navigate(entry.id, to, extend);
              }}
              onSelect={(how) => {
                if (how === "range") selectRange(entry.id);
                else if (how === "toggle") toggleMultiStep(entry.id);
                else {
                  rangeAnchor.current = entry.id;
                  selectStep(entry.id);
                }
              }}
              onDragStart={() => {
                dragged.current = entry;
              }}
              onDragOver={(event) => {
                const source = dragged.current;
                if (source === null || source.id === entry.id || isInside(entries, entry, source.id)) {
                  setDrop(null);
                  return false;
                }
                const position = dropPositionFor(event, entry);
                if (drop?.targetId !== entry.id || drop.position !== position) {
                  setDrop({ targetId: entry.id, position });
                }
                return true;
              }}
              onDrop={() => {
                const source = dragged.current;
                const target = drop;
                setDrop(null);
                dragged.current = null;
                if (source === null || target === null) return;
                moveStepTo(source.id, target.targetId, target.position);
              }}
              onDragEnd={() => {
                setDrop(null);
                dragged.current = null;
              }}
            />
          </div>
        );
      })}
      <InsertMenu />
      {stepMenu === null ? null : <StepMenu menu={stepMenu} onClose={closeMenu} />}
    </div>
  );
}

/**
 * The step's right-click menu. "Play from here" leads it, enabled only when the playback level has a
 * start for the step; it reads the editor and the instant sim so its state follows both while open.
 * It offers only what can apply to this kind of step (issue #411): Join with next path on a path,
 * Unwrap group on a group. Duplicate and Delete say how many steps they touch, and the wrap items
 * say why when the selected steps sit in different lists.
 */
function StepMenu({ menu, onClose }: { menu: StepMenuState; onClose: () => void }) {
  const state = useEditor();
  const derived = useDerived();
  useSim(derived.plan, derived.plan?.robot ?? null, derived.plan?.field ?? null);
  const from = playFrom(menu.stepId, state);
  const entries = state.auto === null ? [] : indexSteps(state.auto);
  const kind = entries.find((entry) => entry.id === menu.stepId)?.step.kind;
  const targets = wrapTargets();
  const counted = stepCountLabels(entries, targets);
  const wrapWhy = wrapRefusal(state.auto, targets);
  const items: MenuEntry[] = [
    {
      id: "step.playFromHere",
      label: "Play from here",
      does: "Move the playhead to where this step starts at the playback level, and play from there.",
      icon: Play,
      whyDisabled: from.ok ? null : from.reason,
      run: () => {
        playFromStep(menu.stepId);
      },
    },
    // The same words as the field's menu for the same two items (issue #505).
    { id: "insert.path", label: "Insert a path after", separatorBefore: true },
    {
      id: "step.insertMenu",
      label: INSERT_ANOTHER_LABEL,
      does: "Open the insert menu with every step kind.",
      icon: Plus,
      run: () => {
        openInsertMenu();
      },
    },
    // A path step's Optimize path (issue #366); its switch hides it, as everywhere.
    ...(kind === "path" ? [{ id: "path.optimize", separatorBefore: true }] : []),
    { id: "edit.duplicate", label: counted.duplicate, separatorBefore: true },
    { id: "edit.delete", label: counted.delete },
    ...(kind === "path" ? [{ id: "edit.joinNext" }] : []),
    { id: "edit.wrapSequence", separatorBefore: true, whyDisabled: wrapWhy },
    { id: "edit.wrapParallel", whyDisabled: wrapWhy },
    { id: "edit.wrapBranch", whyDisabled: wrapWhy },
    ...(kind !== undefined && isGroupKind(kind) ? [{ id: "edit.unwrap" }] : []),
  ];
  return (
    <ActionMenu
      xPx={menu.xPx}
      yPx={menu.yPx}
      entries={items}
      onClose={onClose}
      label={`Step ${menu.stepId}`}
      testId="step-menu"
    />
  );
}

/**
 * What Duplicate and Delete say for the steps they act on: "Duplicate step", "Delete 2 steps", or
 * "Delete group and its 3 steps" for one group, counting the steps that run inside it.
 */
export function stepCountLabels(entries: readonly StepEntry[], ids: readonly string[]): { duplicate: string; delete: string } {
  if (ids.length > 1) return { duplicate: `Duplicate ${String(ids.length)} steps`, delete: `Delete ${String(ids.length)} steps` };
  const only = ids[0] === undefined ? undefined : entries.find((entry) => entry.id === ids[0]);
  if (only !== undefined && isGroupKind(only.step.kind)) {
    const inside = stepsInside(entries, only.id);
    return {
      duplicate: "Duplicate group",
      delete: inside === 0 ? "Delete group" : `Delete group and its ${String(inside)} ${inside === 1 ? "step" : "steps"}`,
    };
  }
  return { duplicate: "Duplicate step", delete: "Delete step" };
}
interface StepRowProps {
  entry: StepEntry;
  /** Whether the step is a turn on the spot, a path step with no length, which reads as a turn. */
  turn: boolean;
  /** The `data-tour` anchor on the row: the first group row is the tour's Groups stop. */
  tour?: string;
  selected: boolean;
  primary: boolean;
  /** Whether the step runs at the playhead: it, a step inside it, or a branch beside it (issue #111). */
  running: boolean;
  seconds: number | null;
  actualS: number | null;
  findingCount: number;
  worstSeverity?: "error" | "warning" | "info";
  drop: DropPosition | null;
  readOnly: boolean;
  /** For a group row, whether it is folded shut; undefined for a step that holds no others. */
  folded: boolean | undefined;
  /** Whether this row is the one in the Tab order; the others are reached by the arrow keys. */
  tabStop: boolean;
  /** Up, Down, Home or End on the row: move selection and focus; `extend` is Shift. */
  onNavigate: (to: RowMove, extend: boolean) => void;
  /** A click on the row: on its own, with Ctrl to toggle it, or with Shift to select a run up to it. */
  onSelect: (how: "only" | "toggle" | "range") => void;
  onDragStart: () => void;
  /** Returns whether a drop here is allowed. */
  onDragOver: (event: ReactDragEvent<HTMLElement>) => boolean;
  onDrop: () => void;
  onDragEnd: () => void;
}

function StepRow({
  entry,
  turn,
  tour,
  selected,
  primary,
  running,
  seconds,
  actualS,
  findingCount,
  worstSeverity,
  drop,
  readOnly,
  folded,
  tabStop,
  onNavigate,
  onSelect,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: StepRowProps) {
  const inside = childCount(entry);
  const Icon = turn ? TURN_ICON : KIND_ICON[entry.step.kind];
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(entry.id);

  const startRename = () => {
    if (readOnly) return;
    setDraft(entry.id);
    setEditing(true);
  };

  /**
   * Commits the rename and returns the id the row has afterwards. A refused rename (an id with a
   * space, or one another step has) says why on the status line and leaves the document alone
   * (`renameStepTo`, issue #494).
   */
  const commitId = (): string => {
    setEditing(false);
    return renameStepTo(entry.id, draft);
  };

  /**
   * Enter and Escape end a rename from the keyboard, so focus goes back to the row rather than to
   * the page. A renamed row is a new element under its new id, so it is found after React draws it;
   * if the rename was refused, the row kept its old id.
   */
  const refocusRow = (id: string) => {
    requestAnimationFrame(() => {
      const main =
        document.querySelector<HTMLElement>(`[data-testid="step-main-${CSS.escape(id)}"]`) ??
        document.querySelector<HTMLElement>(`[data-testid="step-main-${CSS.escape(entry.id)}"]`);
      focusForInput(main);
    });
  };

  const className = [
    styles.row,
    selected ? styles.rowSelected : "",
    primary ? styles.rowPrimary : "",
    running ? styles.rowRunning : "",
    drop === "before" ? styles.dropBefore : "",
    drop === "after" ? styles.dropAfter : "",
    drop === "into" ? styles.dropInto : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      role="listitem"
      className={className}
      style={{ paddingLeft: `calc(var(--pad-row-x) + ${String(entry.depth)} * var(--space-4))` }}
      data-testid={`step-row-${entry.id}`}
      data-tour={tour}
      data-selected={selected ? "true" : undefined}
      data-running={running ? "true" : undefined}
      aria-current={running ? "step" : undefined}
      data-depth={entry.depth}
      data-folded={folded === true ? "true" : undefined}
      // The row drags, so a finger held on it is starting a drag and never opens a row hint (UI_GUIDE 9.4).
      data-drag-row=""
      onDragOver={(event) => {
        if (onDragOver(event)) {
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
        }
      }}
      onDrop={(event) => {
        event.preventDefault();
        onDrop();
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        if (!selected) selectStep(entry.id);
        openStepMenu({ stepId: entry.id, xPx: event.clientX, yPx: event.clientY });
      }}
    >
      {running ? (
        <span className={styles.runningMark} data-testid={`step-running-${entry.id}`} aria-hidden>
          {/* Filled, so it reads as playing and not as one more fold chevron beside a group's. */}
          <Play size={12} strokeWidth={1.75} fill="currentColor" />
        </span>
      ) : null}
      {/* The grab cursor says it drags; it has no tooltip of its own (issue #411). */}
      <span
        className={styles.handle}
        draggable={!readOnly}
        aria-hidden
        data-testid={`step-handle-${entry.id}`}
        onDragStart={(event) => {
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("text/plain", entry.id);
          onDragStart();
        }}
        onDragEnd={onDragEnd}
      >
        <GripVertical size={12} strokeWidth={1.75} />
      </span>

      {folded === undefined ? (
        <span aria-hidden />
      ) : (
        <Tooltip
          label={folded ? "Show the steps inside" : "Hide the steps inside"}
          hint={`${entry.id} holds ${String(inside)} ${inside === 1 ? "step" : "steps"}. Folding only changes this list; the routine is the same.`}
        >
          <button
            type="button"
            className={styles.fold}
            aria-expanded={!folded}
            // Left and Right on the row fold and unfold it, so Tab passes the list in one press.
            tabIndex={-1}
            aria-label={folded ? `Show the steps inside ${entry.id}` : `Hide the steps inside ${entry.id}`}
            data-testid={`step-fold-${entry.id}`}
            onClick={() => {
              toggleFold(entry.id);
            }}
          >
            {folded ? (
              <ChevronRight size={12} strokeWidth={1.75} aria-hidden />
            ) : (
              <ChevronDown size={12} strokeWidth={1.75} aria-hidden />
            )}
          </button>
        </Tooltip>
      )}

      {editing ? (
        // While renaming, the field takes the name's own cell, so it is as wide as the row allows
        // and never narrower than the name. It used to land in the 12 px fold column.
        <div className={styles.main}>
          <span className={styles.kind}>
            <Icon size={16} strokeWidth={1.75} aria-hidden />
          </span>
          <input
            className={styles.idInput}
            style={{ width: `${String(renameFieldCh(draft))}ch` }}
            value={draft}
            autoFocus
            spellCheck={false}
            aria-label={`Rename ${entry.id}`}
            data-testid={`step-id-input-${entry.id}`}
            onFocus={(event) => {
              event.currentTarget.select();
            }}
            onChange={(event) => {
              setDraft(event.target.value);
            }}
            onBlur={() => {
              commitId();
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                // An id outside the rule keeps the field open with the reason on the status line,
                // so the person can fix what they typed (issue #494).
                const problem = stepRenameProblem(entry.id, draft);
                if (problem !== null) refuseStepRename(entry.id, problem);
                else refocusRow(commitId());
              }
              if (event.key === "Escape") {
                setEditing(false);
                refocusRow(entry.id);
              }
              event.stopPropagation();
            }}
          />
        </div>
      ) : (
        <button
          type="button"
          className={styles.main}
          data-testid={`step-main-${entry.id}`}
          // Enter and Space on the only selected row are the app's (`useKeyboard`).
          data-step-key={entry.id}
          tabIndex={tabStop ? 0 : -1}
          onClick={(event) => {
            onSelect(event.shiftKey ? "range" : event.ctrlKey || event.metaKey ? "toggle" : "only");
          }}
          onDoubleClick={startRename}
          onKeyDown={(event) => {
            // The arrows, Home and End walk the list, and Left and Right fold a group. Each is
            // consumed, so the key never nudges the step's end; Alt + Up and Down still reorder.
            if (!event.altKey && !event.ctrlKey && !event.metaKey) {
              const moves: Record<string, RowMove> = { ArrowUp: "up", ArrowDown: "down", Home: "home", End: "end" };
              const move = moves[event.key];
              if (move !== undefined) {
                event.preventDefault();
                onNavigate(move, event.shiftKey);
                return;
              }
              if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
                event.preventDefault();
                if (folded === (event.key === "ArrowRight")) toggleFold(entry.id);
                return;
              }
            }
            // Turn's key (R and Shift R, or the person's own) turns a pose elsewhere; on a row it does nothing.
            if (keyBindingForKey(event) === "keys.rotate") {
              event.preventDefault();
              return;
            }
            // F2 renames, as it does in a file list, and goes no further: the app's own F2 (Rename
            // waypoint) must not run too and leave its "select a pin first" behind (issue #411).
            if (event.key === "F2") {
              event.preventDefault();
              event.stopPropagation();
              startRename();
              return;
            }
            // Shift+F10 and the context-menu key open the step menu under the row, as a right-click does.
            if ((event.key === "F10" && event.shiftKey) || event.key === "ContextMenu") {
              event.preventDefault();
              if (!selected) selectStep(entry.id);
              const box = event.currentTarget.getBoundingClientRect();
              openStepMenu({ stepId: entry.id, xPx: box.left + 24, yPx: box.bottom });
            }
          }}
        >
          {/*
            One long-hover tooltip for the row (issue #411): its name, its kind and its time, with
            what it does under them. It sits on a span, so walking the list with the arrows opens none.
          */}
          <Tooltip label={rowTooltip(entry, seconds, turn)} hint={rowDetail(entry, actualS, turn)} delay="long" side="right">
          <span className={styles.label}>
            <span className={styles.kind} data-testid={`step-kind-${entry.id}`} data-kind={turn ? "turn" : entry.step.kind}>
              <Icon size={16} strokeWidth={1.75} aria-hidden />
            </span>
            <span className={readOnly ? styles.id : `${styles.id} ${styles.idEditable}`} data-testid={`step-name-${entry.id}`}>
              {entry.arm === "else" ? <span className={styles.arm}>else</span> : null}
              {entry.arm === "then" && entry.index === 0 ? <span className={styles.arm}>if</span> : null}
              <span className={styles.idText}>{entry.id}</span>
              {running ? <span className="visually-hidden">, running</span> : null}
              {entry.step.kind === "transfer" ? (
                <span
                  className={transferOverridden(entry.step) ? `${styles.transfer} ${styles.transferOverridden}` : styles.transfer}
                  data-testid={`step-transfer-${entry.id}`}
                  title={
                    transferOverridden(entry.step)
                      ? "Expected, then the actual count the ledger uses instead."
                      : "The count the ledger moves; the actual count is the expected one."
                  }
                >
                  {transferChip(entry.step)}
                </span>
              ) : null}
              {folded === true ? (
                <span className={styles.foldCount} data-testid={`step-fold-count-${entry.id}`}>
                  {String(inside)}
                </span>
              ) : null}
            </span>
          </span>
          </Tooltip>
        </button>
      )}

      {/* The time people compare while tuning, as a number; the bars are the timeline's (issue #411). */}
      <span
        className={styles.time}
        data-testid={`step-time-${entry.id}`}
        data-seconds={seconds === null ? undefined : seconds.toFixed(3)}
      >
        {seconds === null ? "—" : `${rowSeconds(seconds)} s`}
      </span>

      <span className={styles.badge}>
        {worstSeverity === undefined ? null : (
          <Tooltip
            label={`${String(findingCount)} ${findingCount === 1 ? "problem" : "problems"}`}
            hint="The worst one sets the colour. Select the step to see them in the problems panel."
          >
            <span data-testid={`step-dot-${entry.id}`}>
              <SeverityDot severity={worstSeverity} />
            </span>
          </Tooltip>
        )}
      </span>
    </div>
  );
}

/** How many steps a group holds directly, across all its arms. */
function childCount(entry: StepEntry): number {
  const step = entry.step;
  switch (step.kind) {
    case "sequence":
    case "parallel":
      return step.steps.length;
    case "branch":
      return step.then.length + (step.else?.length ?? 0);
    default:
      return 0;
  }
}

/** A row's time with the Inspector's precision, so one number reads the same in both: "3.52" (issue #505). */
const rowSeconds = (value: number): string => formatSeconds(value);

/** The row's tooltip, for example "toGarden, a path, about 3.52 s", or "a turn on the spot" for a turn. */
export function rowTooltip(entry: StepEntry, seconds: number | null, turn = false): string {
  const time = seconds === null ? "no time estimate yet" : `about ${rowSeconds(seconds)} s`;
  return `${entry.id}, ${turn ? TURN_NOUN : KIND_NOUN[entry.step.kind]}, ${time}`;
}

/** The tooltip's second line: what the step does, and the simulator's time when a trace has one. */
function rowDetail(entry: StepEntry, actualS: number | null, turn: boolean): string {
  const does = turn ? "Turns where the step before it ends, and drives nowhere." : kindDetail(entry);
  return actualS === null ? does : `${does} The simulator recorded ${actualS.toFixed(2)} s.`;
}


/** What this particular step does, in words, for the row's tooltip. */
function kindDetail(entry: StepEntry): string {
  const step = entry.step;
  switch (step.kind) {
    case "path":
      return step.segments.length === 1
        ? "Drives 1 path."
        : `Drives ${String(step.segments.length)} paths, followed as one.`;
    case "command":
      return `Runs ${step.name}.`;
    case "wait":
      return step.until === undefined ? `Waits ${String(step.seconds ?? 0)} s.` : `Waits until ${step.until}.`;
    case "transfer":
      return `Planner only: ${transferWords(step)}. The robot does nothing here.`;
    case "sequence":
      return step.steps.length === 1 ? "Runs its one step." : `Runs its ${String(step.steps.length)} steps one after another.`;
    case "parallel":
      return step.mode === "all"
        ? "Runs its steps together and ends when all are done."
        : step.mode === "race"
          ? "Runs its steps together and ends when any one is done."
          : `Runs its steps together and ends when ${step.deadline ?? "its chosen step"} is done.`;
    case "branch":
      return `Runs one arm or the other depending on ${step.condition}.`;
  }
}

/**
 * The actions beside the list's title: how many steps are selected when it is more than one, insert
 * a step (the same menu as the foot button), and duplicate and delete what is selected, each saying
 * how many steps it touches (issue #411).
 */
export function StepActions() {
  const state = useEditor();
  const { insertOpen } = useUi();
  const insertKey = useKeyLabel("insertAfter");
  const duplicateKey = useKeyLabel("duplicate");
  const deleteKey = useKeyLabel("delete");
  const noSelection = state.selection.stepId === undefined;
  const readOnly = isReadOnly(state);
  const why = readOnly ? "Review mode is read only." : "Select a step first.";
  const entries = useMemo(() => (state.auto === null ? [] : indexSteps(state.auto)), [state.auto]);
  const targets = state.multiSteps.length > 0 ? state.multiSteps : noSelection ? [] : [state.selection.stepId!];
  const counted = stepCountLabels(entries, targets);
  return (
    <>
      {state.multiSteps.length > 1 ? (
        <span className={styles.selectedCount} data-testid="steps-selected-count" aria-live="polite">
          {String(state.multiSteps.length)} steps selected
        </span>
      ) : null}
      {state.auto === null ? null : (
        <span className={styles.insertToggle} data-insert-toggle="">
          <RowButton
            icon={Plus}
            label="Insert step"
            hint={
              noSelection
                ? "Add a step at the end of the routine."
                : `Add a step straight after ${state.selection.stepId!}.`
            }
            shortcut={insertKey}
            disabled={readOnly}
            whyDisabled="Review mode is read only."
            expanded={insertOpen}
            onClick={() => {
              if (insertOpen) closeInsertMenu();
              else openInsertMenu("kinds", "header");
            }}
            testId="steps-insert"
          />
        </span>
      )}
      <RowButton
        icon={Copy}
        label={counted.duplicate}
        hint="Copy what is selected and put each copy straight after its original."
        shortcut={duplicateKey}
        disabled={noSelection || readOnly}
        whyDisabled={why}
        onClick={duplicateSelection}
        testId="duplicate-step"
      />
      <RowButton
        icon={Trash}
        label={counted.delete}
        hint="Remove what is selected from the routine."
        shortcut={deleteKey}
        disabled={noSelection || readOnly}
        whyDisabled={why}
        onClick={deleteSelection}
        testId="delete-step"
      />
    </>
  );
}