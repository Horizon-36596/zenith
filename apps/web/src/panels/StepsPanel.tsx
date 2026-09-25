/**
 * The step list: one 28 px row per step, nested under its group, with the insert menu at the foot.
 *
 * - Click selects a step; Shift- or Ctrl-click adds it to a multi-selection for "wrap in a group".
 * - Right-click opens the step menu, built from the same action table as the toolbar and palette.
 * - Drag a row by its handle before or after another row, or onto a group to put it inside; that
 *   is how a step moves into or out of a group. `Alt + ↑ ↓` is the keyboard equivalent within a
 *   list.
 * - When a step starts somewhere other than where the one before it ends (the gap a middle insert
 *   can leave), an inline "Connect the next step" fix sits between the two rows.
 */
import { useCallback, useMemo, useRef, useState, type DragEvent as ReactDragEvent } from "react";
import { ChevronDown, ChevronRight, Copy, GripVertical, Link2, ListOrdered, Trash } from "lucide-react";
import { renameStep } from "@horizon36596/zenith-core";
import {
  connectStep,
  deleteSelection,
  duplicateSelection,
  moveStepTo,
  tryEdit,
} from "../app/edits";
import { SHORTCUTS } from "../app/shortcuts";
import { ActionMenu, type MenuEntry } from "../components/ActionMenu";
import { EstimateBar, EmptyState, RowButton, SeverityDot } from "../components/primitives";
import { Tooltip } from "../components/Tooltip";
import { durationOrDash } from "../lib/format";
import { KIND_ICON, KIND_LABEL } from "../lib/stepKinds";
import { indexSteps, isGroupKind, type StepEntry } from "../lib/stepOps";
import { continuityGapIn, type DropPosition } from "../lib/structure";
import { estimateByStep, findingsByStep } from "../state/derived";
import { MAX_FOLDED_GROUPS, foldKey } from "../state/prefs";
import {
  getState,
  isReadOnly,
  selectStep,
  setPrefs,
  toggleMultiStep,
  useDerived,
  useEditor,
} from "../state/store";
import { closeStepMenu, openInsertMenu, openStepMenu, useUi } from "../state/ui";
import { InsertMenu } from "./InsertMenu";
import styles from "./StepsPanel.module.css";

const RANK = { error: 0, warning: 1, info: 2 } as const;

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
  const state = useEditor();
  const { auto, selection, trace, multiSteps } = state;
  const derived = useDerived();
  const { stepMenu } = useUi();
  const [drop, setDrop] = useState<Drop | null>(null);
  const dragged = useRef<StepEntry | null>(null);
  const readOnly = isReadOnly(state);

  const entries = useMemo(() => (auto === null ? [] : indexSteps(auto)), [auto]);
  const byId = useMemo(() => new Map(entries.map((entry) => [entry.id, entry])), [entries]);
  const foldedKeys = useMemo(() => new Set(state.prefs.foldedGroups), [state.prefs.foldedGroups]);
  const isFolded = (id: string): boolean => foldedKeys.has(foldKey(state.fileName, id));
  // A selection hidden inside a folded group is shown on the group row that hides it.
  const selectedEntry = selection.stepId === undefined ? undefined : byId.get(selection.stepId);
  const selectionHiddenBy =
    selectedEntry === undefined ? undefined : hiddenBy(byId, selectedEntry, isFolded);
  const perStep = useMemo(() => estimateByStep(derived.estimate), [derived.estimate]);
  const byStep = useMemo(() => findingsByStep(derived.findings), [derived.findings]);
  const actualByStep = useMemo(() => {
    const map = new Map<string, number>();
    for (const step of trace?.steps ?? []) map.set(step.id, step.endS - step.startS);
    return map;
  }, [trace]);

  const maxS = useMemo(() => {
    let longest = 0;
    for (const value of perStep.values()) if (value !== null) longest = Math.max(longest, value);
    return longest;
  }, [perStep]);

  const closeMenu = useCallback(() => {
    closeStepMenu();
  }, []);

  if (auto === null) {
    return (
      <EmptyState
        icon={ListOrdered}
        line="No auto is open."
        hint="Its steps show here, in the order the robot runs them."
        testId="steps-empty"
      />
    );
  }

  const menuEntries: MenuEntry[] = [
    { id: "insert.path", label: "Insert a path after" },
    {
      id: "step.insertMenu",
      label: "Insert another kind after…",
      does: "Open the insert menu with every step kind.",
      run: () => {
        openInsertMenu();
      },
    },
    { id: "edit.duplicate", separatorBefore: true },
    { id: "edit.delete" },
    { id: "edit.wrapSequence", separatorBefore: true },
    { id: "edit.wrapParallel" },
    { id: "edit.wrapBranch" },
    { id: "edit.unwrap" },
  ];

  return (
    <div className={styles.list} role="list" data-testid="steps-list" aria-label="Steps">
      {entries.map((entry, index) => {
        if (hiddenBy(byId, entry, isFolded) !== undefined) return null;
        const findings = byStep.get(entry.id) ?? [];
        const worst = [...findings].sort((a, b) => RANK[a.severity] - RANK[b.severity])[0];
        const inMulti = multiSteps.includes(entry.id);
        const selected = selection.stepId === entry.id || inMulti || selectionHiddenBy === entry.id;
        const group = isGroupKind(entry.step.kind);
        const gapIn = continuityGapIn(derived.resolved, entry.id);
        const previous = entries[index - 1];
        return (
          <div key={entry.id} className={styles.rowWrap}>
            {gapIn === null || readOnly ? null : (
              <ConnectFix
                stepId={entry.id}
                previousId={previous?.id}
                gapIn={gapIn}
                depth={entry.depth}
              />
            )}
            <StepRow
              entry={entry}
              selected={selected}
              primary={selection.stepId === entry.id || selectionHiddenBy === entry.id}
              folded={group ? isFolded(entry.id) : undefined}
              seconds={perStep.get(entry.id) ?? null}
              actualS={actualByStep.get(entry.id) ?? null}
              maxS={maxS}
              findingCount={findings.length}
              worstSeverity={worst?.severity}
              drop={drop?.targetId === entry.id ? drop.position : null}
              readOnly={readOnly}
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
      {stepMenu === null ? null : (
        <ActionMenu
          xPx={stepMenu.xPx}
          yPx={stepMenu.yPx}
          entries={menuEntries}
          onClose={closeMenu}
          label={`Step ${stepMenu.stepId}`}
          testId="step-menu"
        />
      )}
    </div>
  );
}

/**
 * The inline fix between two rows when the lower step starts somewhere other than where the upper
 * one ends: one button that makes it continue from there.
 */
function ConnectFix({
  stepId,
  previousId,
  gapIn,
  depth,
}: {
  stepId: string;
  previousId: string | undefined;
  gapIn: number;
  depth: number;
}) {
  return (
    <div
      className={styles.connect}
      style={{ paddingLeft: `calc(var(--pad-row-x) + ${String(depth)} * var(--space-4) + 12px)` }}
      data-testid={`connect-${stepId}`}
    >
      <span className={styles.connectText}>
        {stepId} starts {gapIn.toFixed(1)} in from where {previousId ?? "the start"} ends.
      </span>
      <Tooltip
        label="Connect the next step"
        hint={`Make ${stepId} start where the step before it ends, so the robot does not jump.`}
      >
        <button
          type="button"
          className={styles.connectButton}
          data-testid={`connect-fix-${stepId}`}
          onClick={() => {
            connectStep(stepId);
          }}
        >
          <Link2 size={12} strokeWidth={1.5} aria-hidden />
          Connect the next step
        </button>
      </Tooltip>
    </div>
  );
}

interface StepRowProps {
  entry: StepEntry;
  selected: boolean;
  primary: boolean;
  seconds: number | null;
  actualS: number | null;
  maxS: number;
  findingCount: number;
  worstSeverity?: "error" | "warning" | "info";
  drop: DropPosition | null;
  readOnly: boolean;
  /** For a group row, whether it is folded shut; undefined for a step that holds no others. */
  folded: boolean | undefined;
  onDragStart: () => void;
  /** Returns whether a drop here is allowed. */
  onDragOver: (event: ReactDragEvent<HTMLElement>) => boolean;
  onDrop: () => void;
  onDragEnd: () => void;
}

function StepRow({
  entry,
  selected,
  primary,
  seconds,
  actualS,
  maxS,
  findingCount,
  worstSeverity,
  drop,
  readOnly,
  folded,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: StepRowProps) {
  const inside = childCount(entry);
  const Icon = KIND_ICON[entry.step.kind];
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(entry.id);

  const commitId = () => {
    setEditing(false);
    const next = draft.trim();
    if (next === "" || next === entry.id) return;
    tryEdit((auto) => renameStep(auto, entry.id, next));
    selectStep(next);
  };

  const className = [
    styles.row,
    selected ? styles.rowSelected : "",
    primary ? styles.rowPrimary : "",
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
      data-selected={selected ? "true" : undefined}
      data-depth={entry.depth}
      data-folded={folded === true ? "true" : undefined}
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
      <Tooltip
        label="Drag to move"
        shortcut={SHORTCUTS.reorder}
        hint="Drop between rows to reorder, or onto a group to put the step inside it."
      >
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
          <GripVertical size={12} strokeWidth={1.5} />
        </span>
      </Tooltip>

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

      <button
        type="button"
        className={styles.main}
        onClick={(event) => {
          if (event.shiftKey || event.ctrlKey || event.metaKey) toggleMultiStep(entry.id);
          else selectStep(entry.id);
        }}
        onDoubleClick={() => {
          if (readOnly) return;
          setDraft(entry.id);
          setEditing(true);
        }}
      >
        <Tooltip label={KIND_LABEL[entry.step.kind]} hint={kindDetail(entry)} side="right">
          <span className={styles.kind}>
            <Icon size={16} strokeWidth={1.75} aria-hidden />
          </span>
        </Tooltip>
        {editing ? null : (
          <span className={styles.id} title={`${entry.id} · double-click to rename`}>
            {entry.arm === "else" ? <span className={styles.arm}>else</span> : null}
            {entry.arm === "then" && entry.index === 0 ? <span className={styles.arm}>if</span> : null}
            {entry.id}
            {folded === true ? (
              <span className={styles.foldCount} data-testid={`step-fold-count-${entry.id}`}>
                {String(inside)}
              </span>
            ) : null}
          </span>
        )}
      </button>

      {editing ? (
        <input
          className={styles.idInput}
          value={draft}
          autoFocus
          aria-label="Step id"
          data-testid={`step-id-input-${entry.id}`}
          onChange={(event) => {
            setDraft(event.target.value);
          }}
          onBlur={commitId}
          onKeyDown={(event) => {
            if (event.key === "Enter") commitId();
            if (event.key === "Escape") setEditing(false);
            event.stopPropagation();
          }}
        />
      ) : null}

      <Tooltip
        label={seconds === null ? "No estimate for this step" : `About ${durationOrDash(seconds)} s`}
        hint={
          seconds === null
            ? "The bar is striped because nothing is known yet, which is not the same as zero."
            : actualS === null
              ? "How long Zenith expects this step to take."
              : `The thin green bar is the ${durationOrDash(actualS)} s the simulator recorded.`
        }
      >
        <span className={styles.bar}>
          <EstimateBar seconds={seconds} maxS={maxS} actualS={actualS} />
        </span>
      </Tooltip>

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

/** A second tooltip line for the kind icon: what this particular step does, in words. */
function kindDetail(entry: StepEntry): string {
  const step = entry.step;
  switch (step.kind) {
    case "path":
      return `Drives ${String(step.segments.length)} ${step.segments.length === 1 ? "segment" : "segments"}.`;
    case "command":
      return `Runs ${step.name}.`;
    case "wait":
      return step.until === undefined ? `Waits ${String(step.seconds ?? 0)} s.` : `Waits until ${step.until}.`;
    case "sequence":
      return `Runs its ${String(step.steps.length)} steps one after another.`;
    case "parallel":
      return step.mode === "all"
        ? "Runs its steps together and ends when all are done."
        : step.mode === "race"
          ? "Runs its steps together and ends when the first is done."
          : `Runs its steps together and ends when ${step.deadline ?? "its deadline step"} is done.`;
    case "branch":
      return `Runs one arm or the other depending on ${step.condition}.`;
  }
}

/** The actions beside the list's title: duplicate and delete the selected step. */
export function StepActions() {
  const state = useEditor();
  const noSelection = state.selection.stepId === undefined;
  const readOnly = isReadOnly(state);
  const why = readOnly ? "Review mode is read only." : "Select a step first.";
  return (
    <>
      <RowButton
        icon={Copy}
        label="Duplicate step"
        hint="Copy the selected step and put the copy straight after it."
        shortcut={SHORTCUTS.duplicate}
        disabled={noSelection || readOnly}
        whyDisabled={why}
        onClick={duplicateSelection}
        testId="duplicate-step"
      />
      <RowButton
        icon={Trash}
        label="Delete step"
        hint="Remove the selected step from the routine."
        shortcut={SHORTCUTS.delete}
        disabled={noSelection || readOnly}
        whyDisabled={why}
        onClick={deleteSelection}
        testId="delete-step"
      />
    </>
  );
}
