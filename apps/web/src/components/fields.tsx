/**
 * The inspector's field rows (UI_GUIDE section 8.3): 28 px, label left in 11 px, value right in a
 * 26 px mono input with the unit as a muted suffix outside the input's own text, and a provenance
 * chip at the end of the row. A numeric input is also a horizontal drag target, and its tooltip
 * names the keyboard equivalent, because every drag has one.
 */
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { ChevronDown, ChevronRight } from "lucide-react";
import { parseNumber } from "../lib/format";
import { Tooltip } from "./Tooltip";
import { HelpTip } from "../help/HelpTip";
import type { PanelHelpId } from "../help/content";
import { TOUR_REVEAL_EVENT } from "../tour/signals";
import styles from "./fields.module.css";

export function FieldRow({
  label,
  htmlFor,
  children,
  chip,
}: {
  label: string;
  htmlFor?: string;
  children: ReactNode;
  chip?: ReactNode;
}) {
  return (
    <div className={styles.row} data-chip={chip === undefined ? undefined : ""}>
      <label className={styles.label} htmlFor={htmlFor} title={label}>
        {label}
      </label>
      <div className={styles.value}>{children}</div>
      {chip === undefined ? null : <div className={styles.chip}>{chip}</div>}
    </div>
  );
}

export function Section({
  title,
  children,
  defaultOpen = true,
  help,
}: {
  title: string;
  children: ReactNode;
  defaultOpen?: boolean;
  /** The `PANEL_HELP` entry the section's `?` explains; also its tour anchor. */
  help?: PanelHelpId;
}) {
  const [open, setOpen] = useState(defaultOpen);
  // The tour opens a collapsed section it is about to point at (QA-01).
  useEffect(() => {
    if (help === undefined) return;
    const onReveal = (event: Event) => {
      if ((event as CustomEvent<string>).detail === help) setOpen(true);
    };
    window.addEventListener(TOUR_REVEAL_EVENT, onReveal);
    return () => {
      window.removeEventListener(TOUR_REVEAL_EVENT, onReveal);
    };
  }, [help]);
  return (
    <section className={styles.section} data-tour={help}>
      <div className={styles.sectionHeadRow}>
        <button
          type="button"
          className={styles.sectionHead}
          aria-expanded={open}
          onClick={() => {
            setOpen(!open);
          }}
        >
          {open ? (
            <ChevronDown size={12} strokeWidth={1.5} aria-hidden />
          ) : (
            <ChevronRight size={12} strokeWidth={1.5} aria-hidden />
          )}
          {title}
        </button>
        {help === undefined ? null : <HelpTip id={help} side="left" />}
      </div>
      {open ? <div className={styles.sectionBody}>{children}</div> : null}
    </section>
  );
}

export interface NumberFieldProps<T extends number | null = number> {
  label: string;
  value: number | null;
  unit?: string;
  /** How far one arrow-key press or one pixel of drag moves the value. */
  step?: number;
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
  onChange: (value: T) => void;
  chip?: ReactNode;
}

/** A number the user can type, step with the arrows, or scrub by dragging across the input. */
export function NumberField<T extends number | null = number>({
  label,
  value,
  unit,
  step = 0.5,
  digits = 2,
  min,
  max,
  disabled = false,
  hint,
  testId,
  nullable = false,
  onChange,
  chip,
}: NumberFieldProps<T>) {
  const id = useId();
  const [text, setText] = useState(() => (value === null ? "" : value.toFixed(digits)));
  const editing = useRef(false);
  const drag = useRef<{ x: number; from: number } | null>(null);

  useEffect(() => {
    if (!editing.current) setText(value === null ? "" : value.toFixed(digits));
  }, [value, digits]);

  const clamp = useCallback(
    (next: number): number => {
      const low = min === undefined ? next : Math.max(min, next);
      return max === undefined ? low : Math.min(max, low);
    },
    [min, max],
  );

  const commitText = useCallback(
    (raw: string) => {
      const parsed = parseNumber(raw);
      if (parsed !== null) {
        onChange(clamp(parsed) as T);
        setText(raw);
        return;
      }
      if (nullable && raw.trim() === "") {
        onChange(null as T);
        setText("");
        return;
      }
      setText(value === null ? "" : value.toFixed(digits));
    },
    [clamp, onChange, value, digits, nullable],
  );

  const bump = useCallback(
    (direction: 1 | -1, factor: number) => {
      if (value === null) return;
      onChange(clamp(value + direction * step * factor) as T);
    },
    [value, step, clamp, onChange],
  );

  const onPointerDown = (event: ReactPointerEvent<HTMLInputElement>) => {
    if (disabled || value === null || event.button !== 0) return;
    drag.current = { x: event.clientX, from: value };
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLInputElement>) => {
    const state = drag.current;
    if (state === null) return;
    const dx = event.clientX - state.x;
    if (Math.abs(dx) < 3) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const factor = event.shiftKey ? 4 : event.altKey ? 0.25 : 1;
    onChange(clamp(state.from + dx * step * factor) as T);
  };

  const endDrag = (event: ReactPointerEvent<HTMLInputElement>) => {
    if (drag.current === null) return;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  return (
    <FieldRow label={label} htmlFor={id} chip={chip}>
      <Tooltip
        label={label}
        shortcut="↑ ↓"
        hint={hint ?? "Drag across the field to scrub. Shift for four times, Alt for a quarter."}
      >
        <input
          id={id}
          className={styles.input}
          data-testid={testId}
          inputMode="decimal"
          disabled={disabled}
          value={text}
          onChange={(event) => {
            editing.current = true;
            setText(event.target.value);
          }}
          onBlur={(event) => {
            editing.current = false;
            commitText(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              editing.current = false;
              commitText(event.currentTarget.value);
            } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
              event.preventDefault();
              event.stopPropagation();
              bump(event.key === "ArrowUp" ? 1 : -1, event.shiftKey ? 4 : 1);
            }
          }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        />
      </Tooltip>
      {unit === undefined ? null : <span className="unit">{unit}</span>}
    </FieldRow>
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
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  mono?: boolean;
  placeholder?: string;
  disabled?: boolean;
  testId?: string;
}) {
  const id = useId();
  const [text, setText] = useState(value);
  useEffect(() => {
    setText(value);
  }, [value]);
  return (
    <FieldRow label={label} htmlFor={id}>
      <input
        id={id}
        data-testid={testId}
        className={mono ? styles.input : styles.inputProse}
        value={text}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(event) => {
          setText(event.target.value);
        }}
        onBlur={() => {
          if (text !== value) onChange(text);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
      />
    </FieldRow>
  );
}

export function TextAreaField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const id = useId();
  const [text, setText] = useState(value);
  useEffect(() => {
    setText(value);
  }, [value]);
  return (
    <div className={styles.stack}>
      <label className={styles.label} htmlFor={id}>
        {label}
      </label>
      <textarea
        id={id}
        className={styles.textarea}
        rows={3}
        value={text}
        onChange={(event) => {
          setText(event.target.value);
        }}
        onBlur={() => {
          if (text !== value) onChange(text);
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
}: {
  label: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (value: T) => void;
  disabled?: boolean;
  testId?: string;
}) {
  const id = useId();
  // A long choice can still be cut short in a narrow inspector, so the whole of it is on hover.
  const shown = options.find((option) => option.value === value)?.label;
  return (
    <FieldRow label={label} htmlFor={id}>
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
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
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
  value,
  options,
  onChange,
  disabled = false,
  testId,
}: {
  label: string;
  value: T;
  options: ReadonlyArray<Choice<T>>;
  onChange: (value: T) => void;
  disabled?: boolean;
  testId?: string;
}) {
  const id = useId();
  const listId = `${id}-list`;
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [placed, setPlaced] = useState<{ top: number; right: number } | null>(null);
  const shown = options.find((option) => option.value === value) ?? options[0];

  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    if (refocus) buttonRef.current?.focus();
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
    const selected = list.querySelector<HTMLElement>('[aria-selected="true"]');
    (selected ?? list.querySelector<HTMLElement>('[role="option"]'))?.focus();
  }, [open]);

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
    else if (event.key === "Escape" || event.key === "Tab") close(event.key === "Escape");
    else return;
    if (event.key !== "Tab") event.preventDefault();
    event.stopPropagation();
  };

  return (
    <FieldRow label={label} htmlFor={id}>
      <Tooltip label={shown?.label ?? label} hint={shown?.hint} side="left">
        <button
          id={id}
          ref={buttonRef}
          type="button"
          className={`${styles.select} ${styles.choice}`}
          data-testid={testId}
          data-value={value}
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
          <ChevronDown size={12} strokeWidth={1.5} aria-hidden className={styles.choiceChevron} />
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
            document.body,
          )
        : null}
    </FieldRow>
  );
}

export function CheckboxField({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  const id = useId();
  return (
    <FieldRow label={label} htmlFor={id}>
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
