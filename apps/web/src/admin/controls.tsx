/**
 * The controls the verification UI is built from. Every one carries a tooltip (UI_GUIDE section 8.2,
 * spec 11 section 1), and a control that cannot act stays focusable with `aria-disabled` so its tooltip
 * can say why.
 */
import { useRef, type ReactNode } from "react";
import { BadgeCheck, CircleDashed, Copy, TriangleAlert } from "lucide-react";
import { useCopy } from "../app/copyText";
import { Tooltip } from "../components/Tooltip";
import type { Badge } from "./model";
import styles from "./admin.module.css";

export function ActionButton({
  children,
  tooltip,
  hint,
  whyDisabled,
  kind = "secondary",
  onClick,
  testId,
}: {
  children: ReactNode;
  /** The action, in sentence case, for the tooltip's first line. */
  tooltip: string;
  hint?: string;
  /** Why the button cannot act now; null or absent when it can. */
  whyDisabled?: string | null;
  kind?: "primary" | "secondary" | "text";
  onClick: () => void;
  testId?: string;
}) {
  const disabled = whyDisabled !== undefined && whyDisabled !== null;
  const className = kind === "primary" ? styles.primary : kind === "text" ? styles.textButton : styles.button;
  return (
    <Tooltip label={tooltip} hint={disabled ? `Unavailable: ${whyDisabled}` : hint}>
      <button
        type="button"
        className={className}
        aria-disabled={disabled}
        data-testid={testId}
        onClick={() => {
          if (!disabled) onClick();
        }}
      >
        {children}
      </button>
    </Tooltip>
  );
}

/** A labelled one-line text field with a tooltip on the input. */
export function TextField({
  label,
  tooltip,
  value,
  onChange,
  placeholder,
  mono = false,
  testId,
}: {
  label: string;
  tooltip: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  mono?: boolean;
  testId?: string;
}) {
  return (
    <label className={styles.field}>
      {label}
      <Tooltip label={label} hint={tooltip}>
        <input
          className={styles.input}
          data-mono={mono}
          value={value}
          placeholder={placeholder}
          spellCheck={!mono}
          data-testid={testId}
          onChange={(event) => {
            onChange(event.target.value);
          }}
        />
      </Tooltip>
    </label>
  );
}

/** A labelled multi-line text field with a tooltip. */
export function TextArea({
  label,
  tooltip,
  value,
  onChange,
  placeholder,
  testId,
}: {
  label: string;
  tooltip: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  testId?: string;
}) {
  return (
    <label className={styles.field}>
      {label}
      <Tooltip label={label} hint={tooltip}>
        <textarea
          className={styles.textarea}
          value={value}
          placeholder={placeholder}
          data-testid={testId}
          onChange={(event) => {
            onChange(event.target.value);
          }}
        />
      </Tooltip>
    </label>
  );
}

/** The status badge: an icon and a word, with what the status means in its tooltip. */
export function StatusBadge({ badge, testId }: { badge: Badge; testId?: string }) {
  const Icon = badge.status === "verified" ? BadgeCheck : badge.status === "contested" ? TriangleAlert : CircleDashed;
  return (
    <Tooltip label={badge.label} hint={badge.meaning}>
      <span className={styles.badge} data-status={badge.status} tabIndex={0} data-testid={testId}>
        <Icon size={12} strokeWidth={1.75} aria-hidden />
        {badge.label}
      </span>
    </Tooltip>
  );
}

/**
 * The address a team pasted as evidence. It is another team's string, so it is shown only as
 * selectable text, never as a link (spec 13 section 13), for the teams in a review and for Horizon
 * admins alike: a reader who wants to open it copies it and pastes it into the browser, seeing
 * exactly where it goes first.
 */
export function EvidenceAddress({ url }: { url: string }) {
  const { copy, label } = useCopy();
  const addressBox = useRef<HTMLSpanElement | null>(null);
  return (
    <span className={styles.address}>
      <span ref={addressBox} className={styles.addressText} data-testid="evidence-address">
        {url}
      </span>
      <ActionButton
        kind="text"
        tooltip="Copy the address"
        hint="Puts the address the team pasted on the clipboard, to paste into the browser yourself. Zenith stores no files and opens no links from other teams."
        onClick={() => {
          void copy("the address", url, { select: addressBox.current });
        }}
        testId="evidence-copy"
      >
        <Copy size={12} strokeWidth={1.75} aria-hidden />
        {label("Copy")}
      </ActionButton>
    </span>
  );
}
