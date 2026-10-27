/**
 * The pieces every Settings section is built from (issue #97): a group of rows under a quiet
 * heading, and a row of label, one-line description and control. The label and description start on
 * the row's left edge and the control ends on its right edge (Horizon UI guide section 7), and a
 * hairline separates the rows inside a group. A row may also carry a `hint` (issue #237): its label
 * opens it after a long hover, and it is the `aria-describedby` of the row's controls. A row with
 * `describe` (issue #238) takes its hint from the description table, and its brief as the
 * description only in With descriptions.
 */
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Ellipsis } from "lucide-react";
import { ActionMenu, type MenuEntry } from "../components/ActionMenu";
import { RowButton } from "../components/primitives";
import { HintLabel, HintedControls } from "../components/rowHint";
import type { DescriptionId } from "../help/descriptions";
import { useDescribed } from "../help/descriptions/useDescriptions";
import type { SettingId } from "./registry";
import styles from "./Settings.module.css";

export function Group({
  title,
  aside,
  children,
  testId,
  compact = false,
}: {
  title?: string;
  aside?: ReactNode;
  children: ReactNode;
  testId?: string;
  /** Tighter rows, for a long list of one-line rows such as the keys. */
  compact?: boolean;
}) {
  return (
    <section className={styles.group} data-compact={compact ? "" : undefined} data-testid={testId}>
      {title === undefined ? null : (
        <h4 className={styles.groupHead}>
          <span>{title}</span>
          {aside === undefined ? null : <span className={styles.groupAside}>{aside}</span>}
        </h4>
      )}
      <div className={styles.rows}>{children}</div>
    </section>
  );
}

export function Row({
  label,
  description,
  hint: ownHint,
  describe,
  keepBrief,
  children,
  below,
  testId,
  setting,
  labelTestId,
}: {
  label: string;
  description?: ReactNode;
  /** What the setting does, opened by a long hover on the label or Shift F1 on the control (UI_GUIDE 9.4). */
  hint?: string;
  /**
   * The row's entry in the description table (UI_GUIDE section 9.13), in place of `hint`: its brief
   * is the description only in With descriptions, and its brief and more are the hint in both modes.
   * A row that keeps its line in both modes (decision desc-default (b)) adds `keepBrief`.
   */
  describe?: DescriptionId;
  /** With `describe`: draw the brief in Labels only too, as the project rows do (decision desc-default (b)). */
  keepBrief?: boolean;
  /** The control, at the right edge. */
  children?: ReactNode;
  /** A line that belongs to the whole row, under it: a confirmation, a reason, a result. */
  below?: ReactNode;
  testId?: string;
  /** The registry id of the setting the row controls, so `openSettingsAt` can find it. */
  setting?: SettingId;
  /** A test id for the label itself, for a row whose label is what it says. */
  labelTestId?: string;
}) {
  const hintId = useId();
  const controls = useRef<HTMLDivElement | null>(null);
  const described = useDescribed(describe, keepBrief === true);
  const hint = ownHint ?? described.hint;
  return (
    <div className={styles.row} data-testid={testId} data-setting={setting}>
      <div className={styles.rowText}>
        <HintLabel label={label} hint={hint} explains={controls}>
          <span className={styles.rowLabel} data-testid={labelTestId}>
            {label}
          </span>
        </HintLabel>
        {description === undefined ? null : <span className={styles.rowDescription}>{description}</span>}
        {described.brief === undefined ? null : (
          <span className={styles.rowDescription} data-testid="row-brief">
            {described.brief}
          </span>
        )}
      </div>
      {children === undefined ? null : (
        <div className={styles.rowControl} ref={controls}>
          <HintedControls hint={hint} hintId={hintId}>
            {children}
          </HintedControls>
        </div>
      )}
      {below === undefined ? null : <div className={styles.rowBelow}>{below}</div>}
    </div>
  );
}

/**
 * Escape closes the innermost open thing first (issue #414): while `active`, the key is this form's or
 * prompt's, taken before the window's own handler sees it, wherever focus is. The window closes only
 * once nothing inside it is waiting on an answer.
 */
export function useEscapeFirst(active: boolean, onEscape: () => void): void {
  const latest = useRef(onEscape);
  latest.current = onEscape;
  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      latest.current();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [active]);
}

/** A row's own menu, for the actions a row has but seldom needs: a "…" button that opens it below. */
export function RowMenu({ label, entries, testId }: { label: string; entries: readonly MenuEntry[]; testId: string }) {
  const [at, setAt] = useState<{ xPx: number; yPx: number } | null>(null);
  return (
    <>
      <RowButton
        icon={Ellipsis}
        label={label}
        expanded={at !== null}
        testId={testId}
        onClick={(event) => {
          const box = event.currentTarget.getBoundingClientRect();
          setAt(at === null ? { xPx: box.right - 180, yPx: box.bottom + 4 } : null);
        }}
      />
      {at === null ? null : (
        <ActionMenu
          xPx={at.xPx}
          yPx={at.yPx}
          entries={entries}
          label={label}
          testId={`${testId}-menu`}
          onClose={() => {
            setAt(null);
          }}
        />
      )}
    </>
  );
}
