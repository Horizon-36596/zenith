/**
 * The small shared pieces: toolbar buttons, ghost buttons, the severity dot, the estimate bar, the
 * provenance chip, a panel frame and an empty state. Each one implements the rule from
 * apps/web/UI_GUIDE.md named in its comment; none of them invents a colour or a size.
 */
import type { ReactNode } from "react";
import { ChevronDown, ChevronRight, type LucideIcon } from "lucide-react";
import type { Severity } from "@horizon36596/zenith-core";
import { NO_PROVENANCE, PROVENANCE_LABELS, provenanceTier } from "@horizon36596/zenith-core";
import { Tooltip } from "./Tooltip";
import { HelpTip } from "../help/HelpTip";
import type { PanelHelpId } from "../help/content";
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
  onClick: () => void;
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
  onClick,
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
        aria-pressed={active}
        aria-disabled={disabled}
        data-testid={testId}
        data-tour={tour}
        onClick={() => {
          if (!disabled) onClick();
        }}
      >
        <Icon size={16} strokeWidth={1.75} aria-hidden />
      </button>
    </Tooltip>
  );
}

export interface ButtonProps {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  kind?: "primary" | "ghost";
  type?: "button" | "submit";
  testId?: string;
}

export function Button({
  children,
  onClick,
  disabled = false,
  kind = "ghost",
  type = "button",
  testId,
}: ButtonProps) {
  return (
    <button
      type={type}
      className={kind === "primary" ? styles.primary : styles.ghost}
      disabled={disabled}
      data-testid={testId}
      onClick={onClick}
    >
      {children}
    </button>
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
}: {
  icon: LucideIcon;
  label: string;
  shortcut?: string;
  /** What the button does, when the label alone does not say. */
  hint?: string;
  onClick: () => void;
  disabled?: boolean;
  /** Why it is disabled; shown in place of `hint` while it is. */
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
        className={styles.rowButton}
        aria-label={label}
        aria-disabled={disabled}
        data-testid={testId}
        onClick={() => {
          if (!disabled) onClick();
        }}
      >
        <Icon size={16} strokeWidth={1.5} aria-hidden />
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

export function ProvenanceChip({
  provenance,
  onClick,
}: {
  provenance: string | undefined;
  onClick?: () => void;
}) {
  const text = provenance ?? NO_PROVENANCE;
  const tier = provenanceTier(provenance);
  const shown = provenanceLabel(text);
  const short = shown.length > 22 ? `${shown.slice(0, 21)}…` : shown;
  const body = (
    <span className={styles.chip} data-tier={tier}>
      {short}
    </span>
  );
  if (onClick === undefined) {
    return (
      <Tooltip label={text} hint={PROVENANCE_HINT}>
        <span className={styles.chipWrap} data-tour="provenance">
          {body}
        </span>
      </Tooltip>
    );
  }
  return (
    <Tooltip label={text} hint={`${PROVENANCE_HINT} Click to change it.`}>
      <button
        type="button"
        className={styles.chipButton}
        onClick={onClick}
        aria-label={text}
        data-tour="provenance"
      >
        {body}
      </button>
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
          <ChevronRight size={14} strokeWidth={1.75} aria-hidden />
        ) : (
          <ChevronDown size={14} strokeWidth={1.75} aria-hidden />
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
 * UI_GUIDE section 8.9: one glyph, one line naming what would be here, one action with its
 * shortcut. Left aligned inside the panel, never a centred hero.
 */
export function EmptyState({
  icon: Icon,
  line,
  hint,
  actionLabel,
  actionShortcut,
  onAction,
  testId,
}: {
  icon: LucideIcon;
  line: string;
  /** A second, quieter line saying what to do instead. */
  hint?: string;
  actionLabel?: string;
  actionShortcut?: string;
  onAction?: () => void;
  testId?: string;
}) {
  return (
    <div className={styles.empty} data-testid={testId}>
      <Icon size={20} strokeWidth={1.5} />
      <p className={styles.emptyLine}>{line}</p>
      {hint === undefined ? null : <p className={styles.emptyHint}>{hint}</p>}
      {actionLabel === undefined ? null : (
        <button type="button" className={styles.emptyAction} onClick={onAction}>
          {actionLabel}
          {actionShortcut === undefined ? null : (
            <kbd className={styles.emptyShortcut}>{actionShortcut}</kbd>
          )}
        </button>
      )}
    </div>
  );
}

/** A one-line note where a number would be, when core cannot produce it yet. */
export const Unavailable = ({ children }: { children: ReactNode }) => (
  <p className={styles.unavailable}>{children}</p>
);
