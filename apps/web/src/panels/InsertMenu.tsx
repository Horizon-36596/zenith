/**
 * The insert menu (site/docs/editor.md, "The insert menu"): every step kind the format
 * has, each with its icon and a one-line tooltip, inserted straight after the selected step so a
 * routine can be extended in the middle as easily as at the end. Kinds with a choice to make
 * (which command, how long to wait, how a parallel group ends, what a branch tests) open a small
 * pane of their own rather than inserting a placeholder the user then has to find and fix.
 */
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
  type Ref,
} from "react";
import { ChevronLeft, ChevronRight, Plus, RotateCcw, type LucideIcon } from "lucide-react";
import {
  addBranchStep,
  addCommandStep,
  addParallelStep,
  addPathStep,
  addSequenceStep,
  addTurnStep,
  addTransferStep,
  addWaitStep,
  addWaitUntil,
  type DeadlineChoice,
} from "../app/edits";
import { useKeyLabel } from "../app/shortcuts";
import { focusForInput } from "../components/inputModality";
import { Tooltip } from "../components/Tooltip";
import { INSERT_KINDS, type InsertKind } from "../help/content";
import type { DescriptionId } from "../help/descriptions";
import { firstSentence } from "../help/descriptions/firstSentence";
import { useDescribed, useDescriptions } from "../help/descriptions/useDescriptions";
import { PARALLEL_MODES, type ParallelMode } from "../lib/parallelModes";
import { KIND_ICON } from "../lib/stepKinds";
import { insertKindShown } from "../state/features";
import { getState, isReadOnly, useEditor } from "../state/store";
import {
  closeInsertMenu,
  openInsertMenu,
  setInsertPane,
  useUi,
  type InsertPane,
} from "../state/ui";
import styles from "./InsertMenu.module.css";

const KINDS: InsertKind[] = ["path", "turn", "command", "wait", "transfer", "sequence", "parallel", "branch"];

/** Each kind's icon: the step kind's own, and for a turn on the spot, which is a path step, a turn. */
const ICON: Record<InsertKind, LucideIcon> = { ...KIND_ICON, turn: RotateCcw };

/** Each kind's entry in the description table (`help/descriptions/insert.ts`). */
const DESCRIBE_KIND: Record<InsertKind, DescriptionId> = {
  path: "insert.path",
  turn: "insert.turn",
  command: "insert.command",
  wait: "insert.wait",
  transfer: "insert.transfer",
  sequence: "insert.sequence",
  parallel: "insert.parallel",
  branch: "insert.branch",
};

/** Each parallel mode's entry in the description table. */
const DESCRIBE_MODE: Record<ParallelMode, DescriptionId> = {
  all: "insert.parallelAll",
  race: "insert.parallelRace",
  deadline: "insert.parallelDeadline",
};

/** The kinds that open a pane of options instead of inserting straight away. */
const PANE_OF: Partial<Record<InsertKind, InsertPane>> = {
  command: "command",
  wait: "wait",
  parallel: "parallel",
  branch: "branch",
};

/** The tallest the menu grows, and the least room below it before it opens upwards instead. */
const MENU_MAX_PX = 440;
const MENU_MIN_BELOW_PX = 280;
/** The gap the menu keeps from its button and from the window's edges. */
const MENU_GAP_PX = 8;

/**
 * Where the menu sits, in window pixels: it is fixed to the window rather than to the step list, so
 * no panel clips it, and its height never takes its bottom past the window (issue #411).
 */
interface Placement {
  up: boolean;
  maxPx: number;
  leftPx: number;
  widthPx: number;
  /** The menu's top when it opens down, or its bottom's distance from the window's bottom when up. */
  edgePx: number;
}

/** The selector of a control elsewhere that opens and closes the menu, such as the Steps header's +. */
export const INSERT_TOGGLE_ATTR = "data-insert-toggle";

/** The menu's place beside `button`, below it when there is room and above it when there is more. */
function placeMenu(button: DOMRect, padPx: number): Placement {
  const below = window.innerHeight - button.bottom - MENU_GAP_PX;
  const above = button.top - MENU_GAP_PX;
  const up = below < MENU_MIN_BELOW_PX && above > below;
  return {
    up,
    maxPx: Math.max(0, Math.min(MENU_MAX_PX, up ? above : below)),
    leftPx: button.left + padPx,
    widthPx: Math.max(0, button.width - 2 * padPx),
    edgePx: up ? window.innerHeight - button.top + 4 : button.bottom + 4,
  };
}

/**
 * Where focus goes when the menu closes (W2-9 of the 0.1.2 sweep): to the new step's row after an
 * insert, and back to whatever opened the menu after Escape. The item that had focus leaves the page
 * with the menu, so without this focus falls to the page and the next key runs an editor shortcut.
 */
let focusAfterClose: "step" | "opener" | null = null;

/** Focuses the row of the selected step in the step list, when it shows. */
function focusSelectedRow(): boolean {
  const id = getState().selection.stepId;
  if (id === undefined) return false;
  const row = document.querySelector<HTMLElement>(`[data-testid="step-main-${CSS.escape(id)}"]`);
  focusForInput(row);
  return row !== null;
}

export function InsertMenu() {
  const state = useEditor();
  const insertKey = useKeyLabel("insertAfter");
  const { insertOpen, insertPane, insertAnchor } = useUi();
  const root = useRef<HTMLDivElement | null>(null);
  const anchor = state.selection.stepId;
  const readOnly = isReadOnly(state);
  const [placement, setPlacement] = useState<Placement | null>(null);
  const menu = useRef<HTMLDivElement | null>(null);
  /** Whether the menu holds more below what shows, so its foot fades as a cue to scroll. */
  const [more, setMore] = useState(false);
  const measureMore = (): void => {
    const element = menu.current;
    setMore(element !== null && element.scrollTop + element.clientHeight < element.scrollHeight - 2);
  };

  // The element that had focus when the menu opened, read while the open menu renders for the
  // first time: by the time its effects run, a pane's first field has already taken focus.
  const opener = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  if (insertOpen && !wasOpen.current) {
    const active = document.activeElement;
    opener.current = active instanceof HTMLElement && active !== document.body ? active : null;
    focusAfterClose = null;
  }
  wasOpen.current = insertOpen;

  // On closing, focus goes where `focusAfterClose` says, unless it already went somewhere else (a
  // press on the field, say).
  useEffect(() => {
    if (insertOpen) return;
    const after = focusAfterClose;
    focusAfterClose = null;
    if (after === null) return;
    const active = document.activeElement;
    if (active !== null && active !== document.body) return;
    if (after === "step" && focusSelectedRow()) return;
    if (opener.current?.isConnected === true) focusForInput(opener.current);
    else focusSelectedRow();
  }, [insertOpen]);

  // The button sits at the bottom of the step list, so in a short window the menu opens upwards
  // rather than disappearing under the panel below. It is placed again whenever it switches pane,
  // the auto changes while it is open, or the list scrolls or the window resizes under it: the
  // palette can open a pane, or insert a step and push the button down, without the menu closing.
  useLayoutEffect(() => {
    const element = root.current;
    if (!insertOpen || element === null) {
      setPlacement(null);
      return;
    }
    // Opened from the Steps header's +, the menu opens under that + while it shows, as wide as the
    // list, and the list stays where it was scrolled.
    const toggle = (): DOMRect | null => {
      if (insertAnchor !== "header") return null;
      const box = element.ownerDocument.querySelector(`[${INSERT_TOGGLE_ATTR}]`)?.getBoundingClientRect();
      return box === undefined || box.width === 0 || box.height === 0 ? null : box;
    };
    // Opened from the palette, with Enter, or from a + that has gone, the foot button may be
    // scrolled out of a long step list; bring it into view first, or the menu opens beside a button
    // nobody can see.
    if (toggle() === null) element.scrollIntoView?.({ block: "nearest" });
    const place = (): void => {
      const pad = Number.parseFloat(getComputedStyle(element).paddingLeft) || 0;
      const foot = element.getBoundingClientRect();
      const header = toggle();
      setPlacement(placeMenu(header === null ? foot : new DOMRect(foot.left, header.top, foot.width, header.height), pad));
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [insertOpen, insertPane, insertAnchor, state.auto]);

  useLayoutEffect(measureMore, [placement, insertPane]);

  // Any press outside the menu closes it, the way every popover in the app behaves. The Steps
  // header's + toggles it itself, so a press there is left to its click.
  useEffect(() => {
    if (!insertOpen) return;
    const onDown = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (target?.closest?.(`[${INSERT_TOGGLE_ATTR}]`) != null) return;
      if (root.current !== null && !root.current.contains(target)) closeInsertMenu();
    };
    window.addEventListener("pointerdown", onDown);
    return () => {
      window.removeEventListener("pointerdown", onDown);
    };
  }, [insertOpen]);

  if (state.auto === null) return null;


  return (
    <div className={styles.insert} ref={root}>
      <Tooltip
        label={anchor === undefined ? "Add a step" : `Insert after ${anchor}`}
        shortcut={insertKey}
        hint={
          readOnly
            ? "Unavailable: review mode is read only."
            : anchor === undefined
              ? "Nothing is selected, so the new step goes at the end. Select a step to insert after it."
              : "The new step goes straight after the selected one, and a new path starts where it ends."
        }
        side="right"
      >
        <button
          type="button"
          className={styles.button}
          data-testid="insert-step"
          data-tour="insert"
          aria-haspopup="menu"
          aria-expanded={insertOpen}
          aria-disabled={readOnly}
          onClick={() => {
            if (readOnly) return;
            if (insertOpen) closeInsertMenu();
            else openInsertMenu();
          }}
        >
          <Plus size={16} strokeWidth={1.75} aria-hidden />
          <span className={styles.buttonLabel}>Insert step</span>
          <kbd className={styles.shortcut}>{insertKey}</kbd>
        </button>
      </Tooltip>

      {insertOpen ? (
        <div
          ref={menu}
          className={styles.menu}
          data-up={placement?.up === true ? "true" : undefined}
          data-more={more ? "true" : undefined}
          style={
            // Placed before the first paint; never hidden, or the first kind could not take focus.
            placement === null
              ? undefined
              : {
                  maxHeight: `${String(placement.maxPx)}px`,
                  left: `${String(placement.leftPx)}px`,
                  width: `${String(placement.widthPx)}px`,
                  ...(placement.up ? { bottom: `${String(placement.edgePx)}px` } : { top: `${String(placement.edgePx)}px` }),
                }
          }
          onScroll={measureMore}
          role="menu"
          aria-label="Insert a step"
          data-testid="insert-menu"
          onKeyDown={onMenuKeys}
        >
          {insertPane === "kinds" ? <KindsPane /> : null}
          {insertPane === "command" ? <CommandPane /> : null}
          {insertPane === "wait" ? <WaitPane /> : null}
          {insertPane === "parallel" ? <ParallelPane /> : null}
          {insertPane === "branch" ? <BranchPane /> : null}
        </div>
      ) : null}
    </div>
  );
}

/** Up and down walk the items, Escape closes, and nothing leaks to the global shortcuts. */
function onMenuKeys(event: ReactKeyboardEvent<HTMLDivElement>): void {
  if (event.key === "Escape") {
    event.preventDefault();
    focusAfterClose = "opener";
    closeInsertMenu();
    event.stopPropagation();
    return;
  }
  // A radio button and a select keep their own arrows, which pick an option.
  const target = event.target as HTMLElement;
  const ownArrows = target instanceof HTMLSelectElement || (target instanceof HTMLInputElement && target.type === "radio");
  if ((event.key === "ArrowDown" || event.key === "ArrowUp") && !ownArrows) {
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next = items[(at + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length];
    next?.focus();
    event.preventDefault();
  }
  event.stopPropagation();
}

/**
 * A ref for a pane's first field, which takes the focus when the pane opens, so a pane opened with
 * Enter can be filled in from the keyboard (W2-9). `then` runs after, to select a default, say.
 */
function useFirstField<T extends HTMLElement>(then?: (element: T) => void): Ref<T> {
  const field = useRef<T | null>(null);
  const after = useRef(then);
  // Only when the pane opens.
  useEffect(() => {
    const element = field.current;
    if (element === null) return;
    element.focus();
    after.current?.(element);
  }, []);
  return field;
}

/** Closes the menu after an insert; the new step's row takes the focus. */
function done(): void {
  focusAfterClose = "step";
  closeInsertMenu();
}

function KindsPane() {
  const state = useEditor();
  const robot = state.autoRobot ?? state.project?.robot;
  const commands = robot?.commands.length ?? 0;
  const conditions = robot?.conditions?.length ?? 0;
  const first = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    focusForInput(first.current);
  }, []);

  const blocked = (kind: InsertKind): string | null => {
    if (kind === "command" && commands === 0) return "robot.json registers no commands.";
    if (kind === "branch" && conditions === 0) return "robot.json declares no conditions to branch on.";
    return null;
  };

  return (
    <>
      <p className={styles.heading}>
        {state.selection.stepId === undefined ? "Add at the end" : `After ${state.selection.stepId}`}
      </p>
      {KINDS.filter((kind) => insertKindShown(kind, state.prefs.features)).map((kind, index) => {
        const reason = blocked(kind);
        return (
          <KindItem
            key={kind}
            kind={kind}
            label={INSERT_KINDS[kind].title}
            describe={DESCRIBE_KIND[kind]}
            reason={reason}
            focusRef={index === 0 ? first : undefined}
          />
        );
      })}
    </>
  );
}

/**
 * One step kind in the menu. Its brief is the second line only in With descriptions, and its brief
 * and more are the hint a long hover or Shift F1 opens. Transfer keeps a "Planner only" chip in both
 * modes: it is the one kind that changes the plan and not the robot.
 */
function KindItem({
  kind,
  label,
  describe,
  reason,
  focusRef,
}: {
  kind: InsertKind;
  label: string;
  describe: DescriptionId;
  reason: string | null;
  focusRef: Ref<HTMLButtonElement> | undefined;
}) {
  const Icon = ICON[kind];
  const pane = PANE_OF[kind];
  const described = useDescribed(describe);
  return (
    <Tooltip
      label={label}
      hint={reason === null ? described.hint : `Unavailable: ${reason}`}
      delay={reason === null ? "long" : "normal"}
      side="right"
    >
      <button
        ref={focusRef}
        type="button"
        role="menuitem"
        className={styles.item}
        data-testid={`insert-kind-${kind}`}
        aria-disabled={reason !== null}
        aria-haspopup={pane === undefined ? undefined : "menu"}
        onClick={() => {
          if (reason !== null) return;
          if (pane !== undefined) {
            setInsertPane(pane);
            return;
          }
          if (kind === "path") addPathStep();
          if (kind === "turn") addTurnStep();
          if (kind === "transfer") addTransferStep();
          if (kind === "sequence") addSequenceStep();
          done();
        }}
      >
        <Icon size={16} strokeWidth={1.75} aria-hidden className={styles.icon} />
        <span className={styles.itemText}>
          <span className={styles.itemLabel}>{label}</span>
          {described.brief === undefined ? null : (
            <span className={styles.itemHint} data-testid={`insert-kind-hint-${kind}`}>
              {described.brief}
            </span>
          )}
        </span>
        {kind === "transfer" ? (
          <span className={styles.chip} data-testid="insert-kind-chip-transfer">
            Planner only
          </span>
        ) : null}
        {pane === undefined ? null : (
          <ChevronRight size={16} strokeWidth={1.75} aria-hidden className={styles.more} />
        )}
      </button>
    </Tooltip>
  );
}

function PaneHead({ title }: { title: string }) {
  return (
    <div className={styles.paneHead}>
      <button
        type="button"
        className={styles.back}
        aria-label="Back to the step kinds"
        data-testid="insert-back"
        onClick={() => {
          setInsertPane("kinds");
        }}
      >
        <ChevronLeft size={16} strokeWidth={1.75} aria-hidden />
      </button>
      <span className={styles.paneTitle}>{title}</span>
    </div>
  );
}

/**
 * A command or condition row's long hover (issue #246): its whole robot.json summary, which the row
 * itself cuts to the first sentence in With descriptions and leaves out in Labels only. A row with no
 * summary has nothing to say, so it gets no tooltip.
 */
function SummaryHint({ name, summary, children }: { name: string; summary: string | undefined; children: ReactElement }) {
  if (summary === undefined) return children;
  return (
    <Tooltip label={name} hint={summary} delay="long" side="right">
      {children}
    </Tooltip>
  );
}

function CommandPane() {
  const state = useEditor();
  const [query, setQuery] = useState("");
  const commands = useMemo(() => state.autoRobot?.commands ?? state.project?.robot.commands ?? [], [state]);
  const full = useDescriptions() === "full";
  const needle = query.trim().toLowerCase();
  const shown = commands.filter(
    (spec) =>
      needle === "" ||
      spec.name.toLowerCase().includes(needle) ||
      (spec.summary ?? "").toLowerCase().includes(needle),
  );
  return (
    <>
      <PaneHead title="Command" />
      <input
        className={styles.search}
        placeholder="Search the robot's commands"
        aria-label="Search the robot's commands"
        value={query}
        autoFocus
        data-testid="insert-command-search"
        onChange={(event) => {
          setQuery(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" && shown[0] !== undefined) {
            addCommandStep(shown[0]);
            done();
          }
        }}
      />
      <div className={styles.scroll}>
        {shown.length === 0 ? (
          <p className={styles.none}>No command matches that.</p>
        ) : (
          shown.map((spec) => (
            <SummaryHint key={spec.name} name={spec.name} summary={spec.summary}>
              <button
                type="button"
                role="menuitem"
                className={styles.item}
                data-testid={`insert-command-${spec.name}`}
                onClick={() => {
                  addCommandStep(spec);
                  done();
                }}
              >
                <span className={styles.itemText}>
                  <span className={`${styles.itemLabel} mono`}>{spec.name}</span>
                  {spec.summary === undefined || !full ? null : (
                    // The first sentence, wrapped, in With descriptions; the whole summary is the hint.
                    <span className={styles.itemSummary} data-testid={`insert-command-summary-${spec.name}`}>
                      {firstSentence(spec.summary)}
                    </span>
                  )}
                </span>
              </button>
            </SummaryHint>
          ))
        )}
      </div>
    </>
  );
}

function WaitPane() {
  const state = useEditor();
  const conditions = state.autoRobot?.conditions ?? state.project?.robot.conditions ?? [];
  const [seconds, setSeconds] = useState("0.5");
  const value = Number(seconds);
  const valid = seconds.trim() !== "" && Number.isFinite(value) && value >= 0;
  // The seconds take the focus, selected, so typing a time replaces the default and Enter adds it.
  const first = useFirstField<HTMLInputElement>((input) => {
    input.select();
  });
  return (
    <>
      <PaneHead title="Wait" />
      <p className={styles.group}>For a time</p>
      <div className={styles.formRow}>
        <input
          ref={first}
          className={styles.number}
          inputMode="decimal"
          aria-label="Seconds to wait"
          value={seconds}
          data-testid="insert-wait-seconds"
          onChange={(event) => {
            setSeconds(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || !valid) return;
            event.preventDefault();
            addWaitStep(value);
            done();
          }}
        />
        <span className="unit">s</span>
        <button
          type="button"
          role="menuitem"
          className={styles.add}
          aria-disabled={!valid}
          data-testid="insert-wait-add"
          onClick={() => {
            if (!valid) return;
            addWaitStep(value);
            done();
          }}
        >
          Add wait
        </button>
      </div>
      <p className={styles.group}>Until a condition</p>
      {conditions.length === 0 ? (
        <p className={styles.none}>robot.json declares no conditions to wait for.</p>
      ) : (
        conditions.map((condition) => (
          <SummaryHint key={condition.name} name={condition.name} summary={condition.summary}>
            <button
              type="button"
              role="menuitem"
              className={styles.item}
              data-testid={`insert-wait-until-${condition.name}`}
              onClick={() => {
                addWaitUntil(condition.name);
                done();
              }}
            >
              <span className={styles.itemText}>
                <span className={`${styles.itemLabel} mono`}>{condition.name}</span>
                {/*
                  A condition's name is a code word, not a label, so its first sentence shows under it
                  in both description modes (issue #411); the whole summary is the long hover.
                */}
                {condition.summary === undefined ? null : (
                  <span className={styles.itemSummary} data-testid={`insert-wait-summary-${condition.name}`}>
                    {firstSentence(condition.summary)}
                  </span>
                )}
              </span>
            </button>
          </SummaryHint>
        ))
      )}
    </>
  );
}

/** One way a parallel group can end: its label, its brief in With descriptions, and the hint. */
function ModeOption({
  mode,
  label,
  checked,
  onChoose,
  inputRef,
}: {
  mode: ParallelMode;
  label: string;
  checked: boolean;
  onChoose: () => void;
  inputRef: Ref<HTMLInputElement> | undefined;
}) {
  const described = useDescribed(DESCRIBE_MODE[mode]);
  return (
    <Tooltip label={label} hint={described.hint} delay="long" side="right">
      <label className={styles.radio} data-testid={`insert-parallel-mode-${mode}`}>
        <input ref={inputRef} type="radio" name="parallel-mode" checked={checked} onChange={onChoose} />
        <span className={styles.radioTitle}>{label}</span>
        {described.brief === undefined ? null : <span className={styles.itemHint}>{described.brief}</span>}
      </label>
    </Tooltip>
  );
}

function ParallelPane() {
  const state = useEditor();
  const command = (state.autoRobot?.commands ?? state.project?.robot.commands ?? [])[0];
  const [mode, setMode] = useState<ParallelMode>("all");
  const [deadline, setDeadline] = useState<DeadlineChoice>("drive");
  // The chosen way to end takes the focus; the arrows pick another, as in any radio group.
  const first = useFirstField<HTMLInputElement>();
  return (
    <>
      <PaneHead title="Parallel" />
      <div role="radiogroup" aria-label="How the group ends" className={styles.radios}>
        {PARALLEL_MODES.map((option) => (
          <ModeOption
            key={option.value}
            mode={option.value}
            label={option.label}
            inputRef={option.value === mode ? first : undefined}
            checked={mode === option.value}
            onChoose={() => {
              setMode(option.value);
            }}
          />
        ))}
      </div>
      {mode === "deadline" ? (
        <label className={styles.formRow}>
          <span className={styles.formLabel}>Ends when</span>
          <select
            className={styles.select}
            value={deadline}
            data-testid="insert-parallel-deadline"
            onChange={(event) => {
              setDeadline(event.target.value === "command" ? "command" : "drive");
            }}
          >
            <option value="drive">the drive ends</option>
            {command === undefined ? null : <option value="command">{command.name} ends</option>}
          </select>
        </label>
      ) : null}
      <div className={styles.actions}>
        <button
          type="button"
          role="menuitem"
          className={styles.add}
          data-testid="insert-parallel-add"
          onClick={() => {
            addParallelStep(mode, deadline);
            done();
          }}
        >
          Add parallel group
        </button>
      </div>
    </>
  );
}

function BranchPane() {
  const state = useEditor();
  const conditions = state.autoRobot?.conditions ?? state.project?.robot.conditions ?? [];
  const [condition, setCondition] = useState(conditions[0]?.name ?? "");
  const [withElse, setWithElse] = useState(true);
  const summary = conditions.find((candidate) => candidate.name === condition)?.summary;
  const first = useFirstField<HTMLSelectElement>();
  return (
    <>
      <PaneHead title="Branch" />
      <label className={styles.formRow}>
        <span className={styles.formLabel}>If</span>
        <select
          ref={first}
          className={styles.select}
          value={condition}
          data-testid="insert-branch-condition"
          onChange={(event) => {
            setCondition(event.target.value);
          }}
        >
          {conditions.map((candidate) => (
            <option key={candidate.name} value={candidate.name}>
              {candidate.name}
            </option>
          ))}
        </select>
      </label>
      {summary === undefined ? null : <p className={styles.note}>{summary}</p>}
      <label className={styles.check}>
        <input
          type="checkbox"
          checked={withElse}
          onChange={(event) => {
            setWithElse(event.target.checked);
          }}
        />
        Include an else arm, for when it is false
      </label>
      <div className={styles.actions}>
        <button
          type="button"
          role="menuitem"
          className={styles.add}
          aria-disabled={condition === ""}
          data-testid="insert-branch-add"
          onClick={() => {
            if (condition === "") return;
            addBranchStep(condition, withElse);
            done();
          }}
        >
          Add branch
        </button>
      </div>
    </>
  );
}
