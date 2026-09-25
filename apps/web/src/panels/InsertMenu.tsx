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
} from "react";
import { ChevronLeft, ChevronRight, Plus } from "lucide-react";
import type { ParallelStep } from "@horizon36596/zenith-schema";
import {
  addBranchStep,
  addCommandStep,
  addParallelStep,
  addPathStep,
  addSequenceStep,
  addWaitStep,
  addWaitUntil,
  type DeadlineChoice,
} from "../app/edits";
import { SHORTCUTS } from "../app/shortcuts";
import { Tooltip } from "../components/Tooltip";
import { INSERT_HELP, type InsertKind } from "../help/content";
import { KIND_ICON } from "../lib/stepKinds";
import { isReadOnly, useEditor } from "../state/store";
import {
  closeInsertMenu,
  openInsertMenu,
  setInsertPane,
  useUi,
  type InsertPane,
} from "../state/ui";
import styles from "./InsertMenu.module.css";

const KINDS: InsertKind[] = ["path", "command", "wait", "sequence", "parallel", "branch"];

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

/** The nearest ancestor that clips its content, which is what the menu has to fit inside. */
function clippingAncestor(element: HTMLElement): HTMLElement | null {
  for (let at = element.parentElement; at !== null; at = at.parentElement) {
    const overflow = getComputedStyle(at).overflowY;
    if (overflow === "auto" || overflow === "scroll" || overflow === "hidden") return at;
  }
  return null;
}

interface Placement {
  up: boolean;
  maxPx: number;
}

export function InsertMenu() {
  const state = useEditor();
  const { insertOpen, insertPane } = useUi();
  const root = useRef<HTMLDivElement | null>(null);
  const anchor = state.selection.stepId;
  const readOnly = isReadOnly(state);
  const [placement, setPlacement] = useState<Placement>({ up: false, maxPx: MENU_MAX_PX });

  // The button sits at the bottom of the step list, so in a short window the menu opens upwards
  // rather than disappearing under the panel below.
  useLayoutEffect(() => {
    const element = root.current;
    if (!insertOpen || element === null) return;
    const own = element.getBoundingClientRect();
    const clip = clippingAncestor(element)?.getBoundingClientRect();
    const top = clip?.top ?? 0;
    const bottom = clip?.bottom ?? window.innerHeight;
    const below = bottom - own.bottom - 8;
    const above = own.top - top - 8;
    const up = below < MENU_MIN_BELOW_PX && above > below;
    setPlacement({ up, maxPx: Math.max(160, Math.min(MENU_MAX_PX, up ? above : below)) });
  }, [insertOpen]);

  // Any press outside the menu closes it, the way every popover in the app behaves.
  useEffect(() => {
    if (!insertOpen) return;
    const onDown = (event: PointerEvent) => {
      if (root.current !== null && !root.current.contains(event.target as Node)) closeInsertMenu();
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
        shortcut={SHORTCUTS.insertAfter}
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
          <kbd className={styles.shortcut}>{SHORTCUTS.insertAfter}</kbd>
        </button>
      </Tooltip>

      {insertOpen ? (
        <div
          className={styles.menu}
          data-up={placement.up ? "true" : undefined}
          style={{ maxHeight: `${String(placement.maxPx)}px` }}
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
    closeInsertMenu();
    event.stopPropagation();
    return;
  }
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next = items[(at + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length];
    next?.focus();
    event.preventDefault();
  }
  event.stopPropagation();
}

function done(): void {
  closeInsertMenu();
}

function KindsPane() {
  const state = useEditor();
  const robot = state.autoRobot ?? state.project?.robot;
  const commands = robot?.commands.length ?? 0;
  const conditions = robot?.conditions?.length ?? 0;
  const first = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    first.current?.focus();
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
      {KINDS.map((kind, index) => {
        const Icon = KIND_ICON[kind];
        const help = INSERT_HELP[kind];
        const reason = blocked(kind);
        const pane = PANE_OF[kind];
        return (
          <Tooltip
            key={kind}
            label={help.title}
            hint={reason === null ? help.body : `Unavailable: ${reason}`}
            side="right"
          >
            <button
              ref={index === 0 ? first : undefined}
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
                if (kind === "sequence") addSequenceStep();
                done();
              }}
            >
              <Icon size={16} strokeWidth={1.75} aria-hidden className={styles.icon} />
              <span className={styles.itemText}>
                <span className={styles.itemLabel}>{help.title}</span>
                <span className={styles.itemHint}>{help.body}</span>
              </span>
              {pane === undefined ? null : (
                <ChevronRight size={14} strokeWidth={1.5} aria-hidden className={styles.more} />
              )}
            </button>
          </Tooltip>
        );
      })}
    </>
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
        <ChevronLeft size={14} strokeWidth={1.5} aria-hidden />
      </button>
      <span className={styles.paneTitle}>{title}</span>
    </div>
  );
}

function CommandPane() {
  const state = useEditor();
  const [query, setQuery] = useState("");
  const commands = useMemo(() => state.autoRobot?.commands ?? state.project?.robot.commands ?? [], [state]);
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
            <button
              key={spec.name}
              type="button"
              role="menuitem"
              className={styles.item}
              data-testid={`insert-command-${spec.name}`}
              onClick={() => {
                addCommandStep(spec);
                done();
              }}
            >
              <span className={`${styles.itemLabel} mono`}>{spec.name}</span>
              {spec.summary === undefined ? null : <span className={styles.itemHint}>{spec.summary}</span>}
            </button>
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
  return (
    <>
      <PaneHead title="Wait" />
      <p className={styles.group}>For a time</p>
      <div className={styles.formRow}>
        <input
          className={styles.number}
          inputMode="decimal"
          aria-label="Seconds to wait"
          value={seconds}
          data-testid="insert-wait-seconds"
          onChange={(event) => {
            setSeconds(event.target.value);
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
          <button
            key={condition.name}
            type="button"
            role="menuitem"
            className={styles.item}
            data-testid={`insert-wait-until-${condition.name}`}
            onClick={() => {
              addWaitUntil(condition.name);
              done();
            }}
          >
            <span className={`${styles.itemLabel} mono`}>{condition.name}</span>
            {condition.summary === undefined ? null : (
              <span className={styles.itemHint}>{condition.summary}</span>
            )}
          </button>
        ))
      )}
    </>
  );
}

const MODES: Array<{ mode: ParallelStep["mode"]; title: string; body: string }> = [
  { mode: "all", title: "All", body: "Ends when every step in it has finished." },
  { mode: "race", title: "Race", body: "Ends as soon as the first step finishes." },
  { mode: "deadline", title: "Deadline", body: "Ends when the step you pick finishes." },
];

function ParallelPane() {
  const state = useEditor();
  const command = (state.autoRobot?.commands ?? state.project?.robot.commands ?? [])[0];
  const [mode, setMode] = useState<ParallelStep["mode"]>("all");
  const [deadline, setDeadline] = useState<DeadlineChoice>("drive");
  return (
    <>
      <PaneHead title="Parallel group" />
      <p className={styles.note}>
        A drive{command === undefined ? "" : ` and ${command.name}`}, running at the same time. Add
        more steps inside it afterwards.
      </p>
      <div role="radiogroup" aria-label="How the group ends" className={styles.radios}>
        {MODES.map((option) => (
          <label key={option.mode} className={styles.radio} data-testid={`insert-parallel-mode-${option.mode}`}>
            <input
              type="radio"
              name="parallel-mode"
              checked={mode === option.mode}
              onChange={() => {
                setMode(option.mode);
              }}
            />
            <span className={styles.radioTitle}>{option.title}</span>
            <span className={styles.itemHint}>{option.body}</span>
          </label>
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
  return (
    <>
      <PaneHead title="Branch" />
      <label className={styles.formRow}>
        <span className={styles.formLabel}>If</span>
        <select
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
