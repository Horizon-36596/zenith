/**
 * The small shared pieces: toolbar buttons, ghost buttons, the severity dot, the estimate bar, the
 * provenance chip, a panel frame and an empty state. Each one implements the rule from
 * apps/web/UI_GUIDE.md named in its comment; none of them invents a colour or a size.
 */
import { useEffect, useRef, type MouseEvent, type ReactNode } from "react";
import { ChevronDown, ChevronRight, WifiOff, type LucideIcon } from "lucide-react";
import type { Severity } from "@horizon36596/zenith-core";
import { NO_PROVENANCE, PROVENANCE_LABELS, provenanceTier } from "@horizon36596/zenith-core";
import { Tooltip } from "./Tooltip";
import { PROVENANCE_MEANING, shortChipTipLabel, shortProvenanceLabel, splitProvenance } from "../lib/provenance";
import { HelpTip } from "../help/HelpTip";
import type { PanelHelpId } from "../help/content";
import { focusForInput } from "./inputModality";
import styles from "./primitives.module.css";

/* ---- Buttons ------------------------------------------------------------ */

export interface ToolButtonProps {
  icon: LucideIcon;
  label: string;
  shortcut?: string;
  hint?: string;
  active?: boolean;
  disabled?: boolean;
  /** An active tool takes the 2 px accent bar; an on toggle (snap, alliance) does not. */
  toggle?: boolean;
  /** A button that does something each press (undo, redo) and has no on state, so no `aria-pressed`. */
  momentary?: boolean;
  onClick: () => void;
  /** A right-click on the button, for one with a menu of its own (Optimize path, issue #366). */
  onContextMenu?: (event: MouseEvent<HTMLButtonElement>) => void;
  testId?: string;
  /** The `data-tour` anchor the tour points at. */
  tour?: string;
}

/** UI_GUIDE section 8.1: 28 px square, 16 px icon, accent fill and bar when it is the active tool. */
export function ToolButton({
  icon: Icon,
  label,
  shortcut,
  hint,
  active = false,
  disabled = false,
  toggle = false,
  momentary = false,
  onClick,
  onContextMenu,
  testId,
  tour,
}: ToolButtonProps) {
  const className = [
    styles.tool,
    active ? styles.toolActive : "",
    active && !toggle ? styles.toolBar : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <Tooltip label={label} shortcut={shortcut} hint={hint}>
      {/*
        A disabled control is `aria-disabled` rather than `disabled`: a `disabled` button receives
        no pointer events and takes no focus, so its tooltip — the one place UI_GUIDE section 8.1
        puts the reason it is disabled — could never be read by the person who needs it.
      */}
      <button
        type="button"
        className={className}
        aria-label={label}
        aria-pressed={momentary ? undefined : active}
        aria-disabled={disabled}
        data-testid={testId}
        data-tour={tour}
        onClick={() => {
          if (!disabled) onClick();
        }}
        onContextMenu={onContextMenu}
      >
        <Icon size={16} strokeWidth={1.75} aria-hidden />
      </button>
    </Tooltip>
  );
}

export interface ButtonProps {
  children: ReactNode;
  onClick?: () => void;
  /**
   * Why the button cannot act now; null or absent when it can. A disabled button stays focusable
   * (`aria-disabled`, never `disabled`) and its tooltip says "Unavailable: <why>" (UI_GUIDE 9.9).
   */
  whyDisabled?: string | null;
  /** For a caller that has no reason to give yet; prefer `whyDisabled`. */
  disabled?: boolean;
  /**
   * UI_GUIDE 9.9: `primary` is the one per screen or dialog, bottom-right; `secondary` is the
   * alternative beside it (Cancel); `ghost` is a row or region action; `text` is an inline action.
   */
  kind?: "primary" | "secondary" | "ghost" | "text";
  type?: "button" | "submit";
  testId?: string;
  /** The tooltip's first line, for a button whose words need one; disabled ones always get one. */
  tooltip?: string;
  /** The tooltip's second line while the button can act. */
  hint?: string;
  /**
   * Takes focus once it is shown and enabled, again if it was disabled when the page was built. A
   * dialog's frame moves focus to its first control after this mounts, so a plain `autoFocus` loses.
   * Once the person has pressed Tab, focus is theirs: a late enable no longer takes it back.
   */
  takeFocus?: boolean;
}

const BUTTON_CLASS = {
  primary: styles.primary,
  secondary: styles.secondary,
  ghost: styles.ghost,
  text: styles.textButton,
} as const;

/** The plain words of a button's children, for the tooltip of one that is given no `tooltip`. */
function wordsOf(children: ReactNode): string {
  if (typeof children === "string" || typeof children === "number") return String(children);
  if (Array.isArray(children)) return children.map((child: ReactNode) => wordsOf(child)).join("");
  return "";
}

/**
 * The one labelled button (UI_GUIDE 9.9). Disabled is `aria-disabled`, as for `ToolButton` and
 * `RowButton`, so the button keeps its place in the tab order and its tooltip can say why.
 */
export function Button({
  children,
  onClick,
  whyDisabled,
  disabled: disabledProp = false,
  kind = "secondary",
  type = "button",
  testId,
  tooltip,
  hint,
  takeFocus = false,
}: ButtonProps) {
  const ref = useRef<HTMLButtonElement | null>(null);
  const tabbed = useRef(false);
  const disabled = disabledProp || (whyDisabled !== undefined && whyDisabled !== null);
  useEffect(() => {
    if (!takeFocus) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Tab") tabbed.current = true;
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [takeFocus]);
  useEffect(() => {
    if (takeFocus && !disabled && !tabbed.current) focusForInput(ref.current);
  }, [takeFocus, disabled]);
  const button = (
    <button
      ref={ref}
      type={type}
      className={BUTTON_CLASS[kind]}
      aria-disabled={disabled ? true : undefined}
      data-testid={testId}
      onClick={(event) => {
        // A disabled submit button must not submit its form either, from a click or from Enter.
        if (disabled) {
          event.preventDefault();
          return;
        }
        onClick?.();
      }}
    >
      {children}
    </button>
  );
  const why = disabled && whyDisabled !== undefined && whyDisabled !== null ? `Unavailable: ${whyDisabled}` : undefined;
  if (tooltip === undefined && why === undefined) return button;
  return (
    <Tooltip label={tooltip ?? wordsOf(children)} hint={why ?? hint}>
      {button}
    </Tooltip>
  );
}

/**
 * A 22 px icon-only button for inside a row; it still carries a tooltip and a label. Disabled is
 * `aria-disabled`, like `ToolButton`, so the tooltip that says why stays reachable.
 */
export function RowButton({
  icon: Icon,
  label,
  shortcut,
  hint,
  onClick,
  disabled = false,
  whyDisabled,
  testId,
  onPointerDown,
  expanded,
  buttonRef,
  keepFocus = false,
}: {
  icon: LucideIcon;
  label: string;
  shortcut?: string;
  /** What the button does, when the label alone does not say. */
  hint?: string;
  /** Given the click, for a button that opens a menu where it is. */
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
  disabled?: boolean;
  /** Why it is disabled; shown in place of `hint` while it is. */
  whyDisabled?: string;
  testId?: string;
  onPointerDown?: () => void;
  /** For a button that opens a menu: whether the menu is open. */
  expanded?: boolean;
  buttonRef?: (element: HTMLButtonElement | null) => void;
  /**
   * For a transport button: a press does not move focus to it, so the keys keep working where they
   * were, and Space still plays and pauses after the button was clicked (issue #161). Tab still
   * reaches it, and Enter and Space then press it, as for any button.
   */
  keepFocus?: boolean;
}) {
  return (
    <Tooltip
      label={label}
      shortcut={shortcut}
      hint={disabled && whyDisabled !== undefined ? `Unavailable: ${whyDisabled}` : hint}
    >
      <button
        ref={buttonRef}
        type="button"
        className={styles.rowButton}
        onMouseDown={keepFocus ? (event) => { event.preventDefault(); } : undefined}
        aria-label={label}
        aria-disabled={disabled}
        aria-haspopup={expanded === undefined ? undefined : "menu"}
        aria-expanded={expanded}
        data-testid={testId}
        onPointerDown={onPointerDown}
        onClick={(event) => {
          if (!disabled) onClick(event);
        }}
      >
        <Icon size={16} strokeWidth={1.75} aria-hidden />
      </button>
    </Tooltip>
  );
}

/**
 * A quiet text button inside a row or at the end of a section, such as Set, Switch to Linear or
 * Add marker (issue #241, UI_GUIDE section 9.5, the inline row action): accent words with no box
 * until hovered, an optional icon before them, and a tooltip with what it does. Disabled is
 * `aria-disabled`, as for `RowButton`, so the tooltip that says why stays reachable.
 */
export function TextButton({
  icon: Icon,
  label,
  shortcut,
  hint,
  onClick,
  disabled = false,
  whyDisabled,
  testId,
}: {
  icon?: LucideIcon;
  label: string;
  shortcut?: string;
  hint?: string;
  onClick: () => void;
  disabled?: boolean;
  whyDisabled?: string;
  testId?: string;
}) {
  return (
    <Tooltip
      label={label}
      shortcut={shortcut}
      hint={disabled && whyDisabled !== undefined ? `Unavailable: ${whyDisabled}` : hint}
    >
      <button
        type="button"
        className={styles.textButton}
        aria-disabled={disabled}
        data-testid={testId}
        onClick={() => {
          if (!disabled) onClick();
        }}
      >
        {Icon === undefined ? null : <Icon size={12} strokeWidth={1.75} aria-hidden />}
        {label}
      </button>
    </Tooltip>
  );
}

/* ---- Severity ----------------------------------------------------------- */

export const SeverityDot = ({ severity }: { severity: Severity }) => (
  <span className={styles.dot} data-severity={severity} aria-hidden />
);

/** The step row badge: the highest severity on the step, with a count when above one. */
export function FindingBadge({ severity, count }: { severity: Severity; count: number }) {
  return (
    <span className={styles.badge} data-severity={severity}>
      {count > 1 ? <span className={styles.badgeCount}>{count}</span> : null}
    </span>
  );
}

/* ---- The estimate bar --------------------------------------------------- */

export interface EstimateBarProps {
  /** Seconds, or null when nothing is known: the bar hatches rather than showing zero. */
  seconds: number | null;
  /** The longest step in the list, so bars in one column are comparable. */
  maxS: number;
  /** A recorded duration from a sim trace, drawn as a second bar underneath. */
  actualS?: number | null;
  width?: number;
  title?: string;
}

/**
 * UI_GUIDE section 4: one bar language everywhere. Solid for an estimate, diagonally hatched where
 * no estimate exists (never blank and never zero width), green for a recorded actual.
 */
export function EstimateBar({ seconds, maxS, actualS = null, width = 64, title }: EstimateBarProps) {
  const span = maxS > 0 ? maxS : 1;
  const fraction = seconds === null ? 1 : Math.max(0.02, Math.min(1, seconds / span));
  return (
    <span
      className={styles.barTrack}
      style={{ width: `${String(width)}px` }}
      title={title}
      data-unknown={seconds === null ? "true" : undefined}
    >
      <span
        className={seconds === null ? styles.barUnknown : styles.barEstimated}
        style={{ width: `${String(fraction * 100)}%` }}
      />
      {actualS === null || actualS === undefined ? null : (
        <span
          className={styles.barActual}
          style={{ width: `${String(Math.min(1, actualS / span) * 100)}%` }}
        />
      )}
    </span>
  );
}

/* ---- Provenance --------------------------------------------------------- */

/** UI_GUIDE section 8.3: the chip always shows the full string; the colour is only a shortcut. */
const PROVENANCE_HINT = "Where this number came from: measured on the field, set in the editor, or a placeholder until someone checks it on the robot.";

/**
 * The chip's text in sentence case (UI_GUIDE section 9.5): the vocabulary word the string starts
 * with, so "SET FROM EDITOR: dragged" and "SET FROM EDITOR 2026-09-23" both show as "Set from
 * editor" (QA-20). A string that starts with no vocabulary word shows what comes before any colon.
 * The tooltip keeps the full string.
 */
export function provenanceLabel(text: string): string {
  const upper = text.trim().toUpperCase();
  const word = [...PROVENANCE_LABELS]
    .sort((a, b) => b.length - a.length)
    .find((label) => upper === label || upper.startsWith(`${label}:`) || upper.startsWith(`${label} `));
  const head = word ?? (text.split(":")[0] ?? text).trim();
  if (head !== head.toUpperCase()) return head;
  const lower = head.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

/**
 * The provenance chip. Without `onClick` it is a plain label, for a value that cannot be edited
 * where it is shown. With one it is a button that opens a menu (`ProvenancePicker`), and `hint`
 * replaces the default "Click to change it." with what changing it does.
 */
export function ProvenanceChip({
  provenance,
  onClick,
  hint,
  expanded,
  testId,
  short = false,
}: {
  provenance: string | undefined;
  onClick?: (event: MouseEvent<HTMLButtonElement>) => void;
  hint?: string;
  /** Whether the menu the chip opens is open, for `aria-expanded`. */
  expanded?: boolean;
  testId?: string;
  /**
   * The chip of a pose row (UI_GUIDE section 9.5): the label in its short form, at most 12
   * characters, with the full label and what it means in the tooltip.
   */
  short?: boolean;
}) {
  const text = provenance ?? NO_PROVENANCE;
  const tier = provenanceTier(provenance);
  const full = provenanceLabel(text);
  const shown = short ? shortProvenanceLabel(text) : full.length > 22 ? `${full.slice(0, 21)}…` : full;
  const { label: known } = splitProvenance(text);
  // A short chip's tooltip names the whole label, its note and what the label means.
  const tipLabel = short ? shortChipTipLabel(text, full) : text;
  const meaning = short && known !== null ? `${PROVENANCE_MEANING[known]} ` : "";
  // Needs measurement is drawn hollow, so it does not look like a placeholder (UI_GUIDE section 4.3; UX review, G4).
  const needs = known === "NEEDS MEASUREMENT";
  const body = (
    <span className={styles.chip} data-tier={tier} data-short={short ? "" : undefined} data-needs={needs ? "" : undefined}>
      {shown}
    </span>
  );
  if (onClick === undefined) {
    return (
      <Tooltip label={tipLabel} hint={`${meaning}${PROVENANCE_HINT}`}>
        <span className={styles.chipWrap} data-tour="provenance" data-testid={testId}>
          {body}
        </span>
      </Tooltip>
    );
  }
  return (
    <Tooltip label={tipLabel} hint={`${meaning}${PROVENANCE_HINT} ${hint ?? "Click to change it."}`}>
      <button
        type="button"
        className={styles.chipButton}
        onClick={onClick}
        aria-label={`${text}. Change the provenance`}
        aria-haspopup="menu"
        aria-expanded={expanded}
        data-tour="provenance"
        data-testid={testId}
      >
        {body}
      </button>
    </Tooltip>
  );
}

/**
 * A quiet fact about the thing selected, such as Planner only or Stands still, or a warning about it,
 * such as No time limit (issue #242). It is a state, never a description: it shows in both description
 * modes, and its tooltip says what it means. The warning tone uses the same lemon as an unverified
 * value, so it reads as something to look at without being an error.
 */
export function StatusChip({
  children,
  hint,
  tone = "quiet",
  testId,
}: {
  children: string;
  /** What the chip means, in a sentence. */
  hint?: string;
  tone?: "quiet" | "warn";
  testId?: string;
}) {
  return (
    <Tooltip label={children} hint={hint}>
      <span className={styles.statusChip} data-tone={tone} data-testid={testId} tabIndex={0}>
        {children}
      </span>
    </Tooltip>
  );
}

/* ---- Panels and empty states -------------------------------------------- */

export function Panel({
  title,
  actions,
  children,
  label,
  scroll = true,
  testId,
  help,
  tour,
  folded,
  onToggleFold,
  summary,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  label: string;
  scroll?: boolean;
  testId?: string;
  /** The `PANEL_HELP` entry the header's `?` explains. Every panel with a title has one. */
  help?: PanelHelpId;
  /** The tour anchor this panel is. */
  tour?: string;
  /** A foldable panel: true shows only the header and `summary`. */
  folded?: boolean;
  onToggleFold?: () => void;
  /** One line shown after the title while the panel is folded. */
  summary?: ReactNode;
}) {
  const foldable = onToggleFold !== undefined;
  const heading =
    foldable && title !== undefined ? (
      <button
        type="button"
        className={styles.panelFold}
        aria-expanded={folded !== true}
        data-testid={testId === undefined ? undefined : `${testId}-fold`}
        onClick={onToggleFold}
      >
        {folded === true ? (
          <ChevronRight size={16} strokeWidth={1.75} aria-hidden />
        ) : (
          <ChevronDown size={16} strokeWidth={1.75} aria-hidden />
        )}
        <h2 className={styles.panelTitle}>{title}</h2>
      </button>
    ) : (
      <h2 className={styles.panelTitle}>{title}</h2>
    );
  return (
    <section
      className={styles.panel}
      aria-label={label}
      data-testid={testId}
      data-tour={tour}
      data-folded={folded === true ? "true" : undefined}
    >
      {title === undefined ? null : (
        <header className={styles.panelHead}>
          {heading}
          {help === undefined ? null : <HelpTip id={help} />}
          {folded === true && summary !== undefined ? (
            <span className={styles.panelSummary}>{summary}</span>
          ) : null}
          {actions === undefined ? null : <div className={styles.panelActions}>{actions}</div>}
        </header>
      )}
      {folded === true ? null : (
        <div className={scroll ? styles.panelBodyScroll : styles.panelBody}>{children}</div>
      )}
    </section>
  );
}

/**
 * UI_GUIDE section 9.12: a 32 px glyph, a headline naming what would be here, one sentence saying
 * what to do, and one action with its shortcut. Left aligned inside the region, never a centred
 * hero. A small region leaves the headline out: the line and the action alone.
 */
export function EmptyState({
  icon: Icon,
  headline,
  line,
  hint,
  actionLabel,
  actionShortcut,
  actionHint,
  onAction,
  testId,
}: {
  icon: LucideIcon;
  /** What would be here: "No autos in the library yet". */
  headline?: string;
  /** One sentence saying what to do. */
  line: string;
  /** A second, quieter line saying what to do instead. */
  hint?: string;
  actionLabel?: string;
  actionShortcut?: string;
  /** What the action does, for its tooltip. */
  actionHint?: string;
  onAction?: () => void;
  testId?: string;
}) {
  return (
    <div className={styles.empty} data-testid={testId}>
      <Icon className={styles.emptyIcon} size={32} strokeWidth={1.75} aria-hidden />
      {headline === undefined ? null : <p className={styles.emptyHeadline}>{headline}</p>}
      <p className={styles.emptyLine}>{line}</p>
      {hint === undefined ? null : <p className={styles.emptyHint}>{hint}</p>}
      {actionLabel === undefined ? null : (
        <Tooltip label={actionLabel} {...(actionShortcut === undefined ? {} : { shortcut: actionShortcut })} {...(actionHint === undefined ? {} : { hint: actionHint })}>
          <button type="button" className={styles.emptyAction} onClick={onAction} data-testid={testId === undefined ? undefined : `${testId}-action`}>
            {actionLabel}
            {actionShortcut === undefined ? null : <kbd className={styles.emptyShortcut}>{actionShortcut}</kbd>}
          </button>
        </Tooltip>
      )}
    </div>
  );
}

/**
 * UI_GUIDE section 9.12: a region's loading line, which always turns into the data or into why it
 * could not be read and Try again. `error` null means still reading; the caller shows the data once
 * it has it.
 */
export function LoadingLine({
  line,
  error,
  onRetry,
  testId,
}: {
  /** What is being read, with the ellipsis: "Reading the library…". */
  line: string;
  /** Why the read failed, ending with what to do, or null while it is still under way. */
  error: string | null;
  onRetry: () => void;
  testId?: string;
}) {
  if (error === null) {
    return (
      <p className={styles.loading} role="status" data-testid={testId}>
        {line}
      </p>
    );
  }
  return (
    <div className={styles.loadFailed} role="alert" data-testid={testId === undefined ? undefined : `${testId}-failed`}>
      <p className={styles.loadFailedLine}>{error}</p>
      <Tooltip label="Try again" hint="Read it again now.">
        <button type="button" className={styles.emptyAction} onClick={onRetry} data-testid={testId === undefined ? undefined : `${testId}-retry`}>
          Try again
        </button>
      </Tooltip>
    </div>
  );
}

/**
 * UI_GUIDE section 9.12: the line a sheet shows while this computer is offline, saying what still
 * works and what waits for the connection. A state of the connection, so no severity hue.
 */
export function OfflineLine({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <p className={styles.offlineLine} role="status" data-testid={testId}>
      <WifiOff className={styles.offlineIcon} size={16} strokeWidth={1.75} aria-hidden />
      <span>{children}</span>
    </p>
  );
}

/** A one-line note where a number would be, when core cannot produce it yet. */
export const Unavailable = ({ children }: { children: ReactNode }) => (
  <p className={styles.unavailable}>{children}</p>
);
