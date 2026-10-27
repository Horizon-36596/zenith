/**
 * The one segmented switch (UI_GUIDE sections 9.9 and 9.16): a row of buttons in an inset well, one
 * of them pressed, each with its own tooltip saying what choosing it does, or why it cannot be chosen
 * now. Every switch in the app is this component: the sharing sheets, Settings, Set up, the admin
 * page, a proposal's Accept and Reject, and the timeline's playback level.
 *
 * Each option is a `<button aria-pressed>` inside a named `role="group"`. An option that cannot be
 * chosen is `aria-disabled`, not `disabled`, so it stays focusable and its tooltip can say why.
 */
import type { ReactElement } from "react";
import { Tooltip } from "./Tooltip";
import styles from "./Segmented.module.css";

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
  /** The tooltip: what choosing this option does. */
  does: string;
  /** Why this option cannot be chosen now, when it cannot. */
  whyDisabled?: string | null;
  /** The option's accessible name and tooltip title when its label is a short word for a longer one. */
  ariaLabel?: string;
}

export interface SegmentedProps<T extends string> {
  /** The group's accessible name. */
  label: string;
  options: ReadonlyArray<SegmentOption<T>>;
  /** The pressed option, or null when none is pressed yet. */
  value: T | null;
  onChange: (value: T) => void;
  /** The group's test id; each option's is `${testId}-${value}`. */
  testId: string;
  /** `small` sets the labels at `--fs-xs`, for a switch inside a dense row. */
  size?: "normal" | "small";
  /**
   * A press does not take focus, so the keys keep going where they went before it (the playback
   * level keeps Space playing and pausing, issue #161).
   */
  keepFocus?: boolean;
  /** Extra classes on the group, for where it sits in its row. */
  className?: string;
  /** `data-` attributes on the group, such as the playback level's `data-level` that tests read. */
  groupData?: Readonly<Record<`data-${string}`, string | undefined>>;
}

/** The hint an option's tooltip shows: what it does, or why it cannot be chosen now. */
export function segmentHint(option: Pick<SegmentOption<string>, "does" | "whyDisabled">): string {
  return isUnavailable(option) ? `Unavailable: ${option.whyDisabled ?? ""}` : option.does;
}

function isUnavailable(option: Pick<SegmentOption<string>, "whyDisabled">): boolean {
  return option.whyDisabled !== undefined && option.whyDisabled !== null;
}

export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
  testId,
  size = "normal",
  keepFocus = false,
  className,
  groupData,
}: SegmentedProps<T>): ReactElement {
  return (
    <div
      className={className === undefined ? styles.segmented : `${styles.segmented} ${className}`}
      role="group"
      aria-label={label}
      {...groupData}
      data-size={size}
      data-testid={testId}
    >
      {options.map((option) => {
        const disabled = isUnavailable(option);
        return (
          <Tooltip key={option.value} label={option.ariaLabel ?? option.label} hint={segmentHint(option)}>
            <button
              type="button"
              className={styles.segment}
              aria-pressed={option.value === value}
              aria-disabled={disabled ? true : undefined}
              aria-label={option.ariaLabel}
              data-testid={`${testId}-${option.value}`}
              onMouseDown={
                keepFocus
                  ? (event) => {
                      event.preventDefault();
                    }
                  : undefined
              }
              onClick={() => {
                if (!disabled) onChange(option.value);
              }}
            >
              {option.label}
            </button>
          </Tooltip>
        );
      })}
    </div>
  );
}
