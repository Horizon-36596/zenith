/**
 * The field rows and sections the Inspector, Settings and the dialogs share (UI_GUIDE sections 9.3
 * and 9.5). Inside the Inspector, under `INSPECTOR_GRID`, every row sits on one fixed grid (issue
 * #431): the label at 24 px in 12 px `--text-lo`, the value left-aligned at 120 px, and one inline
 * action at the far right. A value still at its default is drawn a step quieter (`quiet`). A numeric
 * input that is not being typed in is also a horizontal drag target (`numberScrub.ts`), and its
 * tooltip names the keyboard equivalent, because every drag has one.
 */
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { ChevronDown } from "lucide-react";
import { parseNumber } from "../lib/format";
import { arrowStart, arrowValue, clampToRange, commitWrites, inRange, rangeHint, refusedNumberLine } from "./numberStep";
import { scrubPxPerStepFor, startScrub, type Scrub } from "./numberScrub";
import { Tooltip } from "./Tooltip";
import { usePopoverLayer } from "./popoverLayer";
import { HintLabel, HintedControls } from "./rowHint";
import { HelpTip } from "../help/HelpTip";
import type { PanelHelpId } from "../help/content";
import type { DescriptionId } from "../help/descriptions";
import { useDescribed } from "../help/descriptions/useDescriptions";
import { TOUR_REVEAL_EVENT } from "../tour/signals";
import { REFUSED_EDIT_STATUS_MS, setStatus, useSelector, type State } from "../state/store";
import { FOLD_OPEN_EVENT, foldOpenListener, foldShown, rememberFold, revealListener, stillHeld } from "./foldMemory";
import { focusForInput } from "./inputModality";
import styles from "./fields.module.css";

/**
 * The class that puts a surface's rows on the Inspector's grid (issue #431): labels at 24 px, values
 * left-aligned at 120 px, actions at the right edge. Settings and the dialogs keep their own layout.
 */
export const INSPECTOR_GRID: string = styles.grid ?? "";

export function FieldRow({
  label,
  htmlFor,
  children,
  chip,
  chipInline = false,
  stacked = false,
  hint: ownHint,
  describe,
  testId,
  quiet = false,
  action,
}: {
  label: string;
  htmlFor?: string;
  children: ReactNode;
  chip?: ReactNode;
  /**
   * Draws the chip at the end of the value's own line instead of on a line under it: for a short
   * chip beside a value that leaves it room, such as an envelope's time (UI_GUIDE section 9.5).
   */
  chipInline?: boolean;
  /**
   * Puts the controls on a line under the label instead of beside it, for a long label with buttons
   * that would squeeze it, such as the stay-inside box's two (issue #410).
   */
  stacked?: boolean;
  /**
   * What the row is for, in a sentence or two (UI_GUIDE section 9.4, row hints). The label opens it
   * after a long hover, Shift F1 on the row's control opens it, and it is the control's
   * `aria-describedby` (rowHint.tsx).
   */
  hint?: string;
  /**
   * The row's entry in the description table (issue #238, UI_GUIDE section 9.13), in place of
   * `hint`: its brief is drawn on one line under the label only in With descriptions, and its brief
   * and more together are the row's hint in both modes.
   */
  describe?: DescriptionId;
  /** Where tests find the row, and the hint's hidden text inside it. */
  testId?: string;
  /**
   * The value is still at its default, or is read only, such as From "Last step's end" or Speed's
   * robot default: drawn a step quieter, in `--text-mid`, so the values that were set stand out.
   */
  quiet?: boolean;
  /** One 24 px inline action at the row's far right, such as a crosshair or a pencil (issue #431). */
  action?: ReactNode;
}) {
  const hintId = useId();
  const controls = useRef<HTMLDivElement | null>(null);
  const described = useDescribed(describe);
  const hint = ownHint ?? described.hint;
  return (
    <div
      className={styles.row}
      // A side tooltip on a control here steps out past the whole row, off its label (Tooltip.tsx).
      data-field-row=""
      data-chip={chip === undefined ? undefined : chipInline ? "inline" : ""}
      data-stacked={stacked ? "" : undefined}
      data-quiet={quiet ? "" : undefined}
      data-testid={testId}
    >
      <HintLabel label={label} hint={hint} explains={controls}>
        {/* With a hint, the hint's bubble names the row, so the browser's own title would be a second one. */}
        <label className={styles.label} htmlFor={htmlFor} data-field-label="" title={hint === undefined ? label : undefined}>
          {label}
        </label>
      </HintLabel>
      <div className={styles.value} ref={controls}>
        <HintedControls hint={hint} hintId={hintId}>
          {children}
        </HintedControls>
      </div>
      {chip === undefined ? null : <div className={styles.chip}>{chip}</div>}
      {action === undefined ? null : <div className={styles.rowEnd}>{action}</div>}
      {described.brief === undefined ? null : (
        <p className={styles.brief} data-testid="row-brief">
          {described.brief}
        </p>
      )}
    </div>
  );
}

const NO_FOLD = (): undefined => undefined;

/** The unit that makes a number field an angle, in degrees. */
export const ANGLE_UNIT = "°";

/**
 * A heading in degrees as the person reads it, in (-180, 180]: a stored -180 and a stored 180 are
 * the same way of facing, so they read the same. Display only: core's linear heading already turns
 * the short way (`angleDelta`), so no plan changes (fields.test.ts).
 */
export function wrapDegrees(degrees: number): number {
  let wrapped = degrees % 360;
  if (wrapped <= -180) wrapped += 360;
  else if (wrapped > 180) wrapped -= 360;
  return wrapped === 0 ? 0 : wrapped;
}

/** What a number field shows at rest: its text, the wrapped angle for a degree field, or nothing when empty. */
export function fieldText(value: number | null, digits: number, angle: boolean): string {
  if (value === null) return "";
  const text = (angle ? wrapDegrees(value) : value).toFixed(digits);
  // A tiny negative number rounds to -0.0, which reads as a different heading from 0.0, and an angle
  // just inside -180 rounds to -180.0 beside the 180.0 the same heading shows everywhere else.
  if (/^-0\.?0*$/.test(text) || (angle && /^-180\.?0*$/.test(text))) return text.slice(1);
  return text;
}

/** The disclosure triangle of a section header: filled, 8 px, turned down while open (issue #431). */
function FoldTriangle({ open }: { open: boolean }) {
  return (
    <svg className={styles.triangle} data-open={open ? "" : undefined} width="8" height="8" viewBox="0 0 8 8" aria-hidden>
      <path d="M2 1 L6.5 4 L2 7 Z" fill="currentColor" />
    </svg>
  );
}

/** What a folded section's dot says, as its `title` and its accessible name. */
const MARK_WORDS = { set: "Something is set inside", warn: "Something inside needs a look" } as const;

/**
 * An Inspector section (UI_GUIDE section 9.3, issue #431): a 28 px header that folds it, with a
 * filled triangle, a small uppercase title, an optional count, a dot while folded when something is
 * set inside (`marked`), a short summary while folded, the `?` on hover and at most one ghost action
 * at the right edge; then its rows. Sections are separated by full-bleed hairlines. A `sub` section
 * is a group inside one, such as one path of a chain: a sentence-case title, its rows indented 16
 * px. With a `foldId` its open state is remembered per person for that kind of section
 * (`foldMemory.ts`); without one it is the section's own.
 */
export function Section({
  title,
  children,
  defaultOpen = true,
  help,
  foldId,
  summary,
  actions,
  forceOpen = false,
  icon,
  holder,
  scope,
  count,
  marked,
  variant = "section",
  tight = false,
  hoverActions = false,
  headTestId,
  helpInHeader = false,
}: {
  title: string;
  children?: ReactNode;
  /** Open until the person folds it. With a `foldId`, only until they make a choice for that kind. */
  defaultOpen?: boolean;
  /** The `PANEL_HELP` entry the section's `?` explains; also its tour anchor. */
  help?: PanelHelpId;
  /**
   * A stable kind-level id, such as `path.heading`, `step.more` or `envelope`: the key of its fold
   * in `prefs.inspectorFolds`, shared by every section of that kind. Also its `data-fold`.
   */
  foldId?: string;
  /** Quiet text after the title, shown only while the section is folded: what is inside it. */
  summary?: string;
  /** The header's one ghost action at its right edge, such as a +, a bin or a pencil. */
  actions?: ReactNode;
  /** Holds it open without writing the memory, as a selected point does its path. */
  forceOpen?: boolean;
  /** A small glyph before the title, for a section about one kind of thing. */
  icon?: ReactNode;
  /**
   * What holds it open, such as the selected point. A header click lets go of this holder only, so a
   * different one holds the section open again.
   */
  holder?: string;
  /** What the section shows, such as its step's id: a change of it ends an `openFoldForNow`. */
  scope?: string;
  /** How many things it lists, after the title in quiet mono: `PATHS 2`, `WAYPOINTS 7`. */
  count?: number;
  /**
   * A dot after the title while the section is folded: `set` when something inside has a value, such
   * as written notes, and `warn`, in lemon, when something inside needs a look, such as a wait with
   * no time limit. Open, the rows show it themselves.
   */
  marked?: "set" | "warn";
  /**
   * `sub` is a group inside a section, such as one path of a chain, and `row` a disclosure drawn as a
   * row of the grid, such as a curve's Controls, its summary in the value column (issue #431).
   */
  variant?: "section" | "sub" | "row";
  /** A list's body: 4 px under it rather than 8. */
  tight?: boolean;
  /** The header's action shows only on hover or focus, as a path's bin in a chain. */
  hoverActions?: boolean;
  /** Where tests find the header's fold button. */
  headTestId?: string;
  /**
   * The selection header above already has the `?` for `help`, so the section keeps `help` as its
   * tour anchor only and draws no second `?` (issue #431: the header has the one `?`).
   */
  helpInHeader?: boolean;
}) {
  const selectRemembered = useCallback(
    (state: State): boolean | undefined => (foldId === undefined ? undefined : state.prefs.inspectorFolds[foldId]),
    [foldId],
  );
  const remembered = useSelector(foldId === undefined ? NO_FOLD : selectRemembered);
  const [own, setOwn] = useState(defaultOpen);
  // The tour opens a folded section it is about to point at (QA-01), without writing the memory,
  // and only while that stop shows: its next reveal, or its end, clears this.
  const [revealed, setRevealed] = useState(false);
  // A header click while held open folds it anyway, until whatever held it lets go or another
  // holder, such as a different selected point, takes hold.
  const holdKey = forceOpen ? (holder ?? "") : undefined;
  const [releasedFor, setReleasedFor] = useState<string | undefined>(undefined);
  useEffect(() => {
    setReleasedFor(undefined);
  }, [holdKey]);
  useEffect(() => {
    if (help === undefined) return;
    const onReveal = revealListener(help, (shown) => {
      setRevealed(shown);
    });
    window.addEventListener(TOUR_REVEAL_EVENT, onReveal);
    return () => {
      window.removeEventListener(TOUR_REVEAL_EVENT, onReveal);
    };
  }, [help]);
  // `openFoldForNow` opens it the same way, writing no memory, until a header click or a new scope.
  const [openedNow, setOpenedNow] = useState(false);
  useEffect(() => {
    setOpenedNow(false);
  }, [scope]);
  useEffect(() => {
    if (foldId === undefined) return;
    const onOpen = foldOpenListener(foldId, () => {
      setOpenedNow(true);
    });
    window.addEventListener(FOLD_OPEN_EVENT, onOpen);
    return () => {
      window.removeEventListener(FOLD_OPEN_EVENT, onOpen);
    };
  }, [foldId]);
  const open = foldShown({
    remembered: foldId === undefined ? own : remembered,
    defaultOpen,
    revealed: revealed || openedNow,
    forced: stillHeld(holdKey, releasedFor),
  });
  const hasBody = children !== undefined && children !== null && children !== false;
  return (
    <section
      className={styles.section}
      data-variant={variant}
      data-open={open ? "" : undefined}
      data-tour={help}
      data-fold={foldId}
    >
      <div className={styles.sectionHeadRow}>
        <button
          type="button"
          className={styles.sectionHead}
          aria-expanded={open}
          data-testid={headTestId}
          onClick={() => {
            const next = !open;
            setRevealed(false);
            setOpenedNow(false);
            setReleasedFor(holdKey !== undefined && !next ? holdKey : undefined);
            if (foldId === undefined) setOwn(next);
            else rememberFold(foldId, next);
          }}
        >
          <FoldTriangle open={open} />
          {icon}
          <span className={styles.sectionTitle}>{title}</span>
          {count === undefined ? null : (
            <>
              {" "}
              <span className={styles.sectionCount} data-testid="section-count">
                {count}
              </span>
            </>
          )}
          {open || marked === undefined ? null : (
            <span
              className={styles.sectionDot}
              data-tone={marked}
              role="img"
              aria-label={MARK_WORDS[marked]}
              title={MARK_WORDS[marked]}
              data-testid="section-dot"
            />
          )}
          {open || summary === undefined ? null : (
            <>
              {" "}
              <span className={styles.sectionSummary}>{summary}</span>
            </>
          )}
        </button>
        {help === undefined || helpInHeader ? null : (
          // Quiet at rest so a column of identical circles does not compete with the values: shown on
          // a header hover or focus (fields.module.css), and still in the tab order (issue #410).
          <span className={styles.sectionHelp}>
            <HelpTip id={help} side="left" />
          </span>
        )}
        {actions === undefined ? null : (
          <div className={styles.sectionActions} data-hover={hoverActions ? "" : undefined}>
            {actions}
          </div>
        )}
      </div>
      {open && hasBody ? (
        <div className={styles.sectionBody} data-tight={tight ? "" : undefined}>
          {children}
        </div>
      ) : null}
    </section>
  );
}

/** A number field's tooltip when it sets none: how to scrub it, which works until you click in to type. */
export const SCRUB_HINT =
  "Drag across the field to scrub it, before you click in to type. Shift for four times, Alt for a quarter, Esc to put it back.";

export interface NumberFieldProps<T extends number | null = number> {
  label: string;
  value: number | null;
  unit?: string;
  /** How far one arrow-key press moves the value, and a scrub of `scrubPxPerStep` pixels. */
  step?: number;
  /**
   * How many pixels of scrub move the value by one `step`: 4 by default, and one degree per pixel
   * for an angle (unit °), whose arrow keys still step 5° (`scrubPxPerStepFor` in `numberScrub.ts`).
   */
  scrubPxPerStep?: number;
  /** How many decimals the field shows, 2 by default. A scrub writes its values rounded to it. */
  digits?: number;
  min?: number;
  max?: number;
  disabled?: boolean;
  hint?: string;
  testId?: string;
  /**
   * When true, committing an empty field calls `onChange(null)` instead of reverting to the last
   * value: for a field whose absence is meaningful, such as a step's `timeoutS`, rather than a
   * quantity that always has one.
   */
  nullable?: boolean;
  /** What an empty field means, shown faintly in it, such as "none" for a step with no timeout. */
  placeholder?: string;
  /**
   * Where the arrow keys and a drag start from while the field is empty: 0 for a timeout, or the
   * robot's default for a speed. Without it an empty field ignores them. A start below `min`, as a
   * timeout's 0 is, never writes `min` itself: a move from it that stays below `min` leaves the
   * field empty (`steppedValue` in `numberStep.ts`).
   */
  emptyStart?: number;
  onChange: (value: T) => void;
  chip?: ReactNode;
}

/** What `NumberControl` takes beyond a field's own props: the input without a row around it. */
interface NumberControlProps<T extends number | null> extends Omit<NumberFieldProps<T>, "chip"> {
  /** The input's id, for the row's label to point at. */
  id?: string;
  /** The input's own accessible name, where no `<label>` points at it. */
  ariaLabel?: string;
  /** A class that replaces the input's default width, such as a pose row's narrower box. */
  inputClass?: string;
  /** Leaves the unit's suffix out, as a pose row says it once for both of its numbers. */
  hideUnit?: boolean;
}

/** A press on a number field that may become a scrub, with what letting it go needs. */
interface ScrubPress {
  scrub: Scrub;
  input: HTMLInputElement;
  pointerId: number;
  /** Removes the Esc listener a started scrub adds. */
  stopEscape: (() => void) | null;
}

/** Ends a press: forgets it, removes its Esc listener and lets the pointer go. */
function releasePress(press: { current: ScrubPress | null }, current: ScrubPress): void {
  if (press.current === current) press.current = null;
  current.stopEscape?.();
  current.stopEscape = null;
  if (current.input.hasPointerCapture(current.pointerId)) current.input.releasePointerCapture(current.pointerId);
}

/**
 * A number the user can type, step with the arrows, or scrub by dragging across the input while it
 * is not being typed in (issue #145). A press on a field without focus that moves 3 px sideways
 * scrubs it as one undo step, and Esc during the scrub puts the value back. A press that does not
 * move focuses the field and selects its text. Once the field has focus, a press-drag selects text
 * as in any input.
 */
function NumberControl<T extends number | null = number>({
  id: givenId,
  ariaLabel,
  inputClass,
  hideUnit = false,
  label,
  value,
  unit,
  step = 0.5,
  scrubPxPerStep,
  digits: digitsProp,
  min,
  max,
  disabled = false,
  hint,
  testId,
  nullable = false,
  placeholder,
  emptyStart,
  onChange,
}: NumberControlProps<T>) {
  const ownId = useId();
  const id = givenId ?? ownId;
  // An angle shows wrapped into (-180, 180] with one decimal and its degree sign tight against it
  // (issue #410). Only what is shown is wrapped: a typed 270 is written as 270, never rewritten.
  const angle = unit === ANGLE_UNIT;
  const digits = digitsProp ?? (angle ? 1 : 2);
  const [text, setText] = useState(() => fieldText(value, digits, angle));
  const editing = useRef(false);
  // Bumped by each commit, so the field shows what the file holds even when a commit leaves the
  // value as it was: a typed 3.6 that a count rounds back to 4, or a 1.5 clamped to a maximum of 1
  // the field already held. Without it the typed text stayed on screen (issue #314).
  const [commits, setCommits] = useState(0);
  const press = useRef<ScrubPress | null>(null);
  // A scrub writes through the latest onChange, which may close over what the last frame wrote.
  const latestOnChange = useRef(onChange);
  latestOnChange.current = onChange;

  // A field that goes away mid-scrub, as when the selection changes, still closes its transaction.
  useEffect(
    () => () => {
      const current = press.current;
      if (current === null) return;
      releasePress(press, current);
      current.scrub.finish();
    },
    [],
  );

  useEffect(() => {
    if (!editing.current) setText(fieldText(value, digits, angle));
  }, [value, digits, commits]);

  const clamp = useCallback((next: number): number => clampToRange(next, { min, max }), [min, max]);

  // A refused commit puts back what the file holds and says why on the status line, with the range.
  const refuse = useCallback(
    (notANumber: boolean) => {
      setText(fieldText(value, digits, angle));
      setCommits((count) => count + 1);
      setStatus("info", refusedNumberLine(label, { min, max }, unit, digits, notANumber), undefined, {
        expireMs: REFUSED_EDIT_STATUS_MS,
      });
    },
    [value, digits, angle, label, min, max, unit],
  );
  const range = rangeHint({ min, max }, unit, digits);

  const commitText = useCallback(
    (raw: string, typed: boolean) => {
      const shown = fieldText(value, digits, angle);
      if (!commitWrites(raw, shown, typed)) {
        // Untouched text, or text typed back to what was shown: the stored number stays exact.
        setText(shown);
        return;
      }
      const parsed = parseNumber(raw);
      if (parsed !== null && !inRange(parsed, { min, max })) {
        // Out of range: the field keeps what it had and says its range once (issue #502), rather
        // than writing the nearest end, which read as the field taking the number.
        refuse(false);
        return;
      }
      if (parsed !== null) {
        const next = clamp(parsed);
        // The same number the field holds is no edit, so it writes nothing and leaves no undo step.
        if (next !== value) onChange(next as T);
        // What the file holds, which the commit may have rounded or clamped further, is shown once
        // the edit has rendered: `commits` runs the effect above again even if `value` is unchanged.
        setText(fieldText(next, digits, angle));
        setCommits((count) => count + 1);
        return;
      }
      if (nullable && raw.trim() === "") {
        onChange(null as T);
        setText("");
        return;
      }
      // Text that is not a number, or an empty field that must hold one.
      refuse(true);
    },
    [clamp, onChange, value, digits, nullable, refuse, min, max],
  );

  // `raw` is the field's text when the press came while typing: the step starts from the typed
  // number, so the press writes once and the field shows what it wrote (`arrowStart`).
  const bump = useCallback(
    (direction: 1 | -1, factor: number, raw: string | null) => {
      const typed =
        raw !== null && commitWrites(raw, fieldText(value, digits, angle), true) ? parseNumber(raw) : null;
      const start = arrowStart(value, emptyStart, typed === null ? null : clamp(typed));
      // The typed text is replaced by what the file holds once the press has rendered.
      if (raw !== null) setCommits((count) => count + 1);
      if (start === null) return;
      // Null only for a press on an empty field that stays empty, so there is nothing to write.
      const next = arrowValue(start.from, direction * step * factor, { min, max }, start.startedEmpty, digits);
      if (next !== null && next !== value) onChange(next as T);
    },
    [value, emptyStart, step, min, max, digits, angle, clamp, onChange],
  );

  const onPointerDown = (event: ReactPointerEvent<HTMLInputElement>) => {
    const from = value ?? emptyStart;
    const input = event.currentTarget;
    // A field being typed in keeps the browser's own press, so a press-drag there selects text.
    if (disabled || from === undefined || event.button !== 0 || input.ownerDocument.activeElement === input) return;
    press.current = {
      scrub: startScrub({
        x: event.clientX,
        from,
        fromEmpty: value === null,
        step,
        pxPerStep: scrubPxPerStepFor(unit, step, scrubPxPerStep),
        digits,
        range: { min, max },
        nullable,
        write: (next) => {
          if (next !== null) latestOnChange.current(next as T);
          else if (nullable) latestOnChange.current(null as T);
        },
      }),
      input,
      pointerId: event.pointerId,
      stopEscape: null,
    };
  };

  // The press may still become a scrub, so the browser must not focus the field and start selecting
  // text yet. A press that stays a click focuses the field and selects its text on release instead.
  const onMouseDown = (event: ReactMouseEvent<HTMLInputElement>) => {
    if (press.current !== null) event.preventDefault();
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLInputElement>) => {
    const current = press.current;
    if (current === null || event.pointerId !== current.pointerId) return;
    // The button came up somewhere else before the scrub started and captured the pointer.
    if ((event.buttons & 1) === 0) {
      releasePress(press, current);
      return;
    }
    const factor = event.shiftKey ? 4 : event.altKey ? 0.25 : 1;
    if (!current.scrub.move(event.clientX, factor)) return;
    // This move left the dead zone: the scrub has started.
    current.input.setPointerCapture(event.pointerId);
    const onKey = (key: KeyboardEvent): void => {
      if (key.key !== "Escape") return;
      key.preventDefault();
      key.stopPropagation();
      releasePress(press, current);
      current.scrub.cancel();
    };
    window.addEventListener("keydown", onKey, true);
    current.stopEscape = () => {
      window.removeEventListener("keydown", onKey, true);
    };
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLInputElement>) => {
    const current = press.current;
    if (current === null || event.pointerId !== current.pointerId) return;
    releasePress(press, current);
    if (current.scrub.finish()) return;
    // A click: into the field, with its text selected so typing replaces it.
    current.input.focus();
    current.input.select();
  };

  // pointercancel and lostpointercapture: the scrub so far stays, as one undo step.
  const onPointerLost = (event: ReactPointerEvent<HTMLInputElement>) => {
    const current = press.current;
    if (current === null || event.pointerId !== current.pointerId) return;
    releasePress(press, current);
    current.scrub.finish();
  };

  return (
    <>
      <Tooltip
        label={label}
        shortcut="↑ ↓"
        hint={range === null ? (hint ?? SCRUB_HINT) : `${hint ?? SCRUB_HINT} ${range}`}
      >
        <input
          id={id}
          className={inputClass ?? styles.input}
          aria-label={ariaLabel}
          data-testid={testId}
          inputMode="decimal"
          disabled={disabled}
          placeholder={placeholder}
          value={text}
          onChange={(event) => {
            editing.current = true;
            setText(event.target.value);
          }}
          onBlur={(event) => {
            // Only text typed since the last commit: a blur right after Enter, or after a scrub,
            // must not commit the same value again as a second undo step.
            if (!editing.current) return;
            editing.current = false;
            commitText(event.target.value, true);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              // Enter on text nobody typed in writes nothing (`commitWrites` in `numberStep.ts`).
              const typed = editing.current;
              editing.current = false;
              commitText(event.currentTarget.value, typed);
            } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
              event.preventDefault();
              event.stopPropagation();
              const typed = editing.current;
              editing.current = false;
              bump(event.key === "ArrowUp" ? 1 : -1, event.shiftKey ? 4 : 1, typed ? event.currentTarget.value : null);
            }
          }}
          onPointerDown={onPointerDown}
          onMouseDown={onMouseDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerLost}
          onLostPointerCapture={onPointerLost}
        />
      </Tooltip>
      {unit === undefined || hideUnit ? null : // An empty field shows its placeholder alone: 'none', never 'none s'. Only a
      // field with no stored value is empty: clearing a stored value to retype it keeps the unit.
      value === null && text.trim() === "" && placeholder !== undefined ? null : (
        <span className={angle || unit === "%" ? `unit ${styles.degreeUnit}` : "unit"}>{unit}</span>
      )}
    </>
  );
}

export function NumberField<T extends number | null = number>({
  chip,
  chipInline,
  rowHint,
  quiet,
  action,
  rowTestId,
  describe,
  ...props
}: NumberFieldProps<T> & {
  /** The row's entry in the description table; see `FieldRow`. */
  describe?: DescriptionId;
  /** Puts the chip on the value's own line; see `FieldRow`. */
  chipInline?: boolean;
  /** The row's hint, opened from its label, as `FieldRow`'s `hint`; `hint` stays the input's own tooltip. */
  rowHint?: string;
  /** The value is at its default or empty, drawn a step quieter; see `FieldRow`. */
  quiet?: boolean;
  /** The row's one inline action at its right edge; see `FieldRow`. */
  action?: ReactNode;
  /** Where tests find the row. */
  rowTestId?: string;
}) {
  const id = useId();
  return (
    <FieldRow
      label={props.label}
      htmlFor={id}
      chip={chip}
      chipInline={chipInline}
      hint={rowHint}
      describe={describe}
      quiet={quiet}
      action={action}
      testId={rowTestId}
    >
      <NumberControl {...props} id={id} />
    </FieldRow>
  );
}

/**
 * A number with no row around it, for a list row that holds several, as the Waypoints list's x, y
 * and heading (issue #245): plain text until hovered or focused, as every number field is
 * (UI_GUIDE layout rule 6), and it scrubs, steps and types as a `NumberField` does. `label` is its
 * accessible name and its tooltip's title.
 */
export function CompactNumber<T extends number | null = number>({
  narrow = false,
  ...props
}: Omit<NumberFieldProps<T>, "chip"> & {
  /** A box for three digits and a sign, as a heading in whole degrees needs, not an inch's six; it keeps its unit. */
  narrow?: boolean;
}) {
  // An angle keeps its degree sign; an inch says its unit in the row's hint, not after each number.
  return <NumberControl {...props} ariaLabel={props.label} inputClass={narrow ? styles.compactAngle : styles.compactInput} hideUnit={!narrow} />;
}

export interface PoseAxis {
  value: number;
  onChange: (value: number) => void;
  /** Where tests and the Inspector's own code find this input. */
  testId?: string;
  /** Replaces the scrub hint on this input's tooltip. */
  hint?: string;
  step?: number;
  min?: number;
  max?: number;
}

/**
 * A pose on one line (UI_GUIDE section 9.5): a label, its x and y, the unit once, and a short
 * provenance chip at the end. The label keeps at least 72 px; a panel too narrow for the chip puts
 * it on a line under the numbers, right-aligned, and never takes the room from the label. Each of the
 * three controls is the same one a `NumberField` has, so a pose scrubs, steps and types as before.
 */
export function PoseRow({
  label,
  x,
  y,
  unit = "in",
  digits = 2,
  disabled = false,
  chip,
  hint,
  testId,
  axes = ["x", "y"],
  between,
}: {
  label: string;
  x: PoseAxis;
  y: PoseAxis;
  /** What the two numbers are, for their accessible names: x and y, or width and height for a size. */
  axes?: readonly [string, string];
  /** Drawn between the two numbers, such as the × of a size. */
  between?: string;
  unit?: string;
  digits?: number;
  disabled?: boolean;
  /** A `ProvenancePicker` with `short`, or a plain short `ProvenanceChip`. */
  chip?: ReactNode;
  /** What the row is for; the label opens it after a long hover, as for `FieldRow`. */
  hint?: string;
  testId?: string;
}) {
  const hintId = useId();
  const controls = useRef<HTMLDivElement | null>(null);
  return (
    <div className={styles.poseRow} data-pose-row="" data-chip={chip === undefined ? undefined : ""} data-testid={testId}>
      <HintLabel label={label} hint={hint} explains={controls}>
        <span className={styles.poseLabel} data-pose-label="" title={hint === undefined ? label : undefined}>
          {label}
        </span>
      </HintLabel>
      <div className={styles.poseValues} ref={controls}>
        <HintedControls hint={hint} hintId={hintId}>
          <NumberControl
            {...x}
            label={`${label} ${axes[0]}`}
            ariaLabel={`${label} ${axes[0]}`}
            unit={unit}
            hideUnit
            digits={digits}
            disabled={disabled}
            inputClass={styles.poseInput}
          />
          {between === undefined ? null : <span className="unit">{between}</span>}
          <NumberControl
            {...y}
            label={`${label} ${axes[1]}`}
            ariaLabel={`${label} ${axes[1]}`}
            unit={unit}
            hideUnit
            digits={digits}
            disabled={disabled}
            inputClass={styles.poseInput}
          />
          <span className="unit">{unit}</span>
        </HintedControls>
      </div>
      {chip === undefined ? null : <div className={styles.poseChip}>{chip}</div>}
    </div>
  );
}

export function TextField({
  label,
  value,
  onChange,
  mono = true,
  placeholder,
  disabled = false,
  testId,
  hint,
  rowHint,
  chip,
  wide = false,
  note,
  problem = null,
  onDraft,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  /** The row's hint, opened from its label, as `FieldRow`'s `hint`. */
  rowHint?: string;
  mono?: boolean;
  placeholder?: string;
  disabled?: boolean;
  testId?: string;
  /** The input's tooltip: what the text is for. Without one the field has no tooltip. */
  hint?: string;
  chip?: ReactNode;
  /**
   * The dialogs' text field (issue #502, UI_GUIDE section 9.5): the label on its own line and a box
   * the dialog's full width under it, with an edge at rest, for words a person writes such as an
   * auto's title or a robot class. The row's own 160 px box clipped them and had no edge until hovered.
   */
  wide?: boolean;
  /** A quiet line under a wide field about what is in it, such as where a prefill came from. */
  note?: ReactNode;
  /** Why what is in a wide field cannot be used, shown under it in the error colour. */
  problem?: string | null;
  /** Each keystroke's text, before the field commits it, for a note that follows what is typed. */
  onDraft?: (text: string) => void;
}) {
  const id = useId();
  const [text, setText] = useState(value);
  useEffect(() => {
    setText(value);
  }, [value]);
  const noteId = `${id}-note`;
  const problemId = `${id}-problem`;
  const described = [note === undefined ? null : noteId, problem === null ? null : problemId].filter(Boolean).join(" ");
  const input = (
    <input
      id={id}
      data-testid={testId}
      // Text is never the 86 px, drag-to-scrub number box: a name or a list of authors needs the
      // wider box whether it is set in mono or in the UI face.
      className={[wide ? styles.inputWide : styles.inputProse, mono ? "" : styles.inputWords].filter(Boolean).join(" ")}
      value={text}
      disabled={disabled}
      placeholder={placeholder}
      aria-invalid={problem === null ? undefined : true}
      aria-describedby={described === "" ? undefined : described}
      onChange={(event) => {
        setText(event.target.value);
        onDraft?.(event.target.value);
      }}
      onBlur={() => {
        if (text !== value) onChange(text);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
      }}
    />
  );
  if (wide) {
    return (
      <div className={styles.stack}>
        <label className={styles.label} htmlFor={id}>
          {label}
        </label>
        {hint === undefined ? (
          input
        ) : (
          <Tooltip label={label} hint={hint}>
            {input}
          </Tooltip>
        )}
        {problem === null ? null : (
          <p className={styles.fieldProblem} id={problemId} role="alert" data-testid={testId === undefined ? undefined : `${testId}-problem`}>
            {problem}
          </p>
        )}
        {note === undefined ? null : (
          <p className={styles.fieldNote} id={noteId} data-testid={testId === undefined ? undefined : `${testId}-note`}>
            {note}
          </p>
        )}
      </div>
    );
  }
  return (
    <FieldRow label={label} htmlFor={id} chip={chip} hint={rowHint}>
      {hint === undefined ? (
        input
      ) : (
        <Tooltip label={label} hint={hint}>
          {input}
        </Tooltip>
      )}
    </FieldRow>
  );
}

export function TextAreaField({
  label,
  value,
  onChange,
  autoFocus = false,
  onDone,
  well = false,
  placeholder,
  testId,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  /** Takes the focus when it appears, as when a click on a notes preview opens it. */
  autoFocus?: boolean;
  /** Called when the focus leaves it, after any change is written. */
  onDone?: () => void;
  /**
   * The text in a quiet `--bg-inset` well under its section's header, with the label kept for
   * screen readers only, as a step's Notes (issue #431). The well is the box: a click types in it.
   */
  well?: boolean;
  placeholder?: string;
  testId?: string;
}) {
  const id = useId();
  const [text, setText] = useState(value);
  useEffect(() => {
    setText(value);
  }, [value]);
  return (
    <div className={well ? styles.well : styles.stack}>
      <label className={well ? "visually-hidden" : styles.label} htmlFor={id}>
        {label}
      </label>
      <textarea
        id={id}
        className={well ? styles.wellText : styles.textarea}
        rows={well ? 2 : 3}
        value={text}
        placeholder={placeholder}
        data-testid={testId}
        autoFocus={autoFocus}
        onChange={(event) => {
          setText(event.target.value);
        }}
        onBlur={() => {
          if (text !== value) onChange(text);
          onDone?.();
        }}
      />
    </div>
  );
}

export function SelectField<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled = false,
  testId,
  rowTestId,
  describe,
  rowHint,
  suffix,
  chip,
  quiet = false,
}: {
  label: string;
  value: T;
  /** The row's hint, in place of a description entry: a few words on what it is, as `FieldRow`'s `hint`. */
  rowHint?: string;
  /** A disabled option is shown but cannot be picked: a placeholder such as "Pick a step". */
  options: ReadonlyArray<{ value: T; label: string; disabled?: boolean }>;
  onChange: (value: T) => void;
  disabled?: boolean;
  testId?: string;
  /** Where tests find the row. */
  rowTestId?: string;
  /** The row's entry in the description table. */
  describe?: DescriptionId;
  /** State after the select on the same line, such as a wait's cap `≤ 1.00 s`, in the unit's quiet type. */
  suffix?: ReactNode;
  /** A chip under the select, such as a warning about the value. */
  chip?: ReactNode;
  /** The choice is the default, such as Stop early's Never: drawn a step quieter (`FieldRow`). */
  quiet?: boolean;
}) {
  const id = useId();
  // A long choice can still be cut short in a narrow inspector, so the whole of it is on hover.
  const shown = options.find((option) => option.value === value)?.label;
  return (
    <FieldRow label={label} htmlFor={id} describe={describe} hint={rowHint} testId={rowTestId} chip={chip} quiet={quiet}>
      <select
        id={id}
        data-testid={testId}
        className={styles.select}
        title={shown}
        value={value}
        disabled={disabled}
        onChange={(event) => {
          onChange(event.target.value as T);
        }}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </option>
        ))}
      </select>
      {suffix === undefined ? null : suffix}
    </FieldRow>
  );
}

/**
 * One number and the unit it is in, as a select that reads like a unit (issue #242): a marker's At,
 * `0.50 t`, `12.0 in from start`. Changing the unit is the caller's: it decides what the number
 * becomes. The number is the same field a `NumberField` has, so it scrubs, steps and types as one.
 */
export function NumberUnitField<U extends string>({
  unit,
  ...number
}: Omit<NumberFieldProps, "unit" | "chip"> & {
  unit: {
    value: U;
    options: ReadonlyArray<{ value: U; label: string }>;
    onChange: (value: U) => void;
    testId?: string;
  };
}) {
  const id = useId();
  const unitId = useId();
  return (
    <FieldRow label={number.label} htmlFor={id}>
      {/* The select shows the unit; the number keeps it only for its range's words, "0 to 27 in from end". */}
      <NumberControl {...number} id={id} unit={unit.options.find((option) => option.value === unit.value)?.label} hideUnit />
      <select
        id={unitId}
        className={styles.unitSelect}
        aria-label={`${number.label} unit`}
        data-testid={unit.testId}
        value={unit.value}
        onChange={(event) => {
          unit.onChange(event.target.value as U);
        }}
      >
        {unit.options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </FieldRow>
  );
}

/**
 * Where one end of a path is, as one select (issue #241): the ends it can take, such as the previous
 * end and "This pose", then a group of every waypoint. It replaces a kind select with a Waypoint
 * select under it. `action` sits after the select on the same line: a crosshair that selects the
 * waypoint followed, or a bookmark-plus that saves the end as one.
 */
export function SourceSelect<T extends string>({
  label,
  value,
  ends,
  group,
  onChange,
  action,
  describe,
  testId,
  quiet = false,
  detail,
  brief,
}: {
  label: string;
  value: T;
  ends: ReadonlyArray<{ value: T; label: string }>;
  /** The second part of the list, under its own heading: the waypoints. */
  group: { label: string; options: ReadonlyArray<{ value: T; label: string }> };
  onChange: (value: T) => void;
  /** The row's one inline action at its right edge (issue #431). */
  action?: ReactNode;
  describe?: DescriptionId;
  testId?: string;
  /** The choice is the default, such as From "Last step's end": drawn a step quieter. */
  quiet?: boolean;
  /** Said after the choice in the select's tooltip, such as where the followed waypoint is. */
  detail?: string;
  /** A quiet line under the row, such as the followed pose in With descriptions (issue #431). */
  brief?: ReactNode;
}) {
  const id = useId();
  const shown = [...ends, ...group.options].find((option) => option.value === value)?.label;
  return (
    <FieldRow
      label={label}
      htmlFor={id}
      describe={describe}
      quiet={quiet}
      action={action === undefined || action === null ? undefined : <span className={styles.rowAction}>{action}</span>}
      chip={brief}
    >
      <select
        id={id}
        data-testid={testId}
        className={styles.select}
        title={detail === undefined ? shown : `${shown ?? ""}: ${detail}`}
        value={value}
        onChange={(event) => {
          onChange(event.target.value as T);
        }}
      >
        {ends.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
        {group.options.length === 0 ? null : (
          <optgroup label={group.label}>
            {group.options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </optgroup>
        )}
      </select>
    </FieldRow>
  );
}

export interface Choice<T extends string> {
  value: T;
  label: string;
  /** The option's tooltip: what it means. */
  hint?: string;
}

/**
 * A select whose options each carry a tooltip, which a native `<select>` cannot do: the heading
 * mode, where the label is Pedro's name and the tooltip says what it means (spec 11 section 2). It
 * looks like `SelectField` at rest, opens a listbox under itself, and is driven from the keyboard
 * the way a select is: Enter, Space or the arrows open it, the arrows move, Enter picks, Esc closes.
 */
export function ChoiceField<T extends string>({
  label,
  rowTestId,
  hint,
  quiet,
  ...control
}: Omit<ChoiceControlProps<T>, "id"> & {
  /** Where tests find the row. */
  rowTestId?: string;
  /** What the row is for: its label's long-hover hint, such as a command's summary. */
  hint?: string;
  /** The choice is the default: drawn a step quieter (`FieldRow`). */
  quiet?: boolean;
}) {
  const id = useId();
  return (
    <FieldRow label={label} htmlFor={id} hint={hint} testId={rowTestId} quiet={quiet}>
      <ChoiceControl {...control} label={label} id={id} />
    </FieldRow>
  );
}

interface ChoiceControlProps<T extends string> {
  label: string;
  value: T;
  options: ReadonlyArray<Choice<T>>;
  onChange: (value: T) => void;
  disabled?: boolean;
  testId?: string;
  /** Draws the chevron at rest, for a choice that would read as plain text without it. */
  chevron?: boolean;
  /** The button's id, for a row's label to point at. */
  id?: string;
  /** The button's tooltip in place of the chosen option's, for a choice with no row label of its own. */
  buttonHint?: string;
  /** A list row's small choice, such as the Waypoints list's Pins (issue #431). */
  compact?: boolean;
}

/**
 * The choice's button and its listbox, with no row around it: `ChoiceField` puts it in a row, and a
 * list's head row, such as the Waypoints list's Pins, holds it alone (issue #431).
 */
export function ChoiceControl<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled = false,
  testId,
  chevron = false,
  id: givenId,
  buttonHint,
  compact = false,
}: ChoiceControlProps<T>) {
  const ownId = useId();
  const id = givenId ?? ownId;
  const listId = `${id}-list`;
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const layer = usePopoverLayer();
  const [placed, setPlaced] = useState<{ top: number; right: number } | null>(null);
  const shown = options.find((option) => option.value === value) ?? options[0];

  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    if (refocus) focusForInput(buttonRef.current);
  }, []);

  const pick = useCallback(
    (next: T) => {
      close(true);
      if (next !== value) onChange(next);
    },
    [close, onChange, value],
  );

  // Place the list under the button, right-aligned with it, flipped above when there is no room.
  useEffect(() => {
    if (!open) {
      setPlaced(null);
      return;
    }
    const button = buttonRef.current;
    const list = listRef.current;
    if (button === null || list === null) return;
    const anchor = button.getBoundingClientRect();
    const box = list.getBoundingClientRect();
    let top = anchor.bottom + 4;
    if (top + box.height > window.innerHeight - 4) top = Math.max(4, anchor.top - box.height - 4);
    setPlaced({ top, right: Math.max(4, window.innerWidth - anchor.right) });
  }, [open]);

  // Focus the chosen option once the list is placed. Until then it is visibility: hidden, and the
  // browser refuses focus to a hidden element, so focusing it in the effect above left focus on the
  // button and the options out of the keyboard's reach (issue #403).
  useEffect(() => {
    const list = listRef.current;
    if (placed === null || list === null) return;
    const selected = list.querySelector<HTMLElement>('[aria-selected="true"]');
    focusForInput(selected ?? list.querySelector<HTMLElement>('[role="option"]'));
  }, [placed]);

  // A press anywhere else closes it, as a native select does.
  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent): void => {
      const target = event.target as Node | null;
      if (target !== null && (listRef.current?.contains(target) || buttonRef.current?.contains(target))) return;
      close(false);
    };
    window.addEventListener("pointerdown", onDown, true);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
    };
  }, [open, close]);

  const onListKey = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const items = Array.from(listRef.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? []);
    const at = items.indexOf(document.activeElement as HTMLElement);
    const move = (index: number): void => {
      items[Math.max(0, Math.min(items.length - 1, index))]?.focus();
    };
    if (event.key === "ArrowDown") move(at + 1);
    else if (event.key === "ArrowUp") move(at - 1);
    else if (event.key === "Home") move(0);
    else if (event.key === "End") move(items.length - 1);
    // Tab closes the list as Escape does and goes back to its button, so focus never lands behind a
    // modal the list was opened from (issue #313).
    else if (event.key === "Escape" || event.key === "Tab") close(true);
    else return;
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <>
      <Tooltip label={buttonHint === undefined ? (shown?.label ?? label) : `${label}: ${shown?.label ?? ""}`} hint={buttonHint ?? shown?.hint} side="left">
        <button
          id={id}
          ref={buttonRef}
          type="button"
          aria-label={buttonHint === undefined ? undefined : `${label}: ${shown?.label ?? ""}`}
          className={compact ? `${styles.select} ${styles.choice} ${styles.choiceCompact}` : `${styles.select} ${styles.choice}`}
          data-testid={testId}
          data-value={value}
          data-chevron={chevron ? "" : undefined}
          disabled={disabled}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          onClick={() => {
            setOpen(!open);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              event.stopPropagation();
              setOpen(true);
            }
          }}
        >
          <span className={styles.choiceText}>{shown?.label ?? ""}</span>
          <ChevronDown size={12} strokeWidth={1.75} aria-hidden className={styles.choiceChevron} />
        </button>
      </Tooltip>
      {open
        ? createPortal(
            <div
              id={listId}
              ref={listRef}
              role="listbox"
              aria-label={label}
              className={styles.choiceList}
              data-testid={testId === undefined ? undefined : `${testId}-list`}
              style={
                placed === null
                  ? { visibility: "hidden", top: 0, right: 0 }
                  : { top: `${String(placed.top)}px`, right: `${String(placed.right)}px` }
              }
              onKeyDown={onListKey}
            >
              {options.map((option) => (
                <Tooltip key={option.value} label={option.label} hint={option.hint} side="left">
                  <button
                    type="button"
                    role="option"
                    aria-selected={option.value === value}
                    className={styles.choiceOption}
                    data-testid={testId === undefined ? undefined : `${testId}-option-${option.value}`}
                    onClick={() => {
                      pick(option.value);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        event.stopPropagation();
                        pick(option.value);
                      }
                    }}
                  >
                    {option.label}
                  </button>
                </Tooltip>
              ))}
            </div>,
            layer,
          )
        : null}
    </>
  );
}

export function CheckboxField({
  label,
  checked,
  onChange,
  rowHint,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** The row's hint, opened from its label, as `FieldRow`'s `hint`. */
  rowHint?: string;
}) {
  const id = useId();
  return (
    <FieldRow label={label} htmlFor={id} hint={rowHint}>
      <input
        id={id}
        type="checkbox"
        className={styles.checkbox}
        checked={checked}
        onChange={(event) => {
          onChange(event.target.checked);
        }}
      />
    </FieldRow>
  );
}

/** The speed fraction slider, with the number beside it so the value is readable while dragging. */
export function SliderField({
  label,
  value,
  min,
  max,
  step,
  onChange,
  testId,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  testId?: string;
}) {
  const id = useId();
  return (
    <FieldRow label={label} htmlFor={id}>
      <input
        id={id}
        type="range"
        data-testid={testId}
        className={styles.slider}
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => {
          onChange(Number(event.target.value));
        }}
      />
      <span className={styles.sliderValue}>{value.toFixed(2)}</span>
    </FieldRow>
  );
}
