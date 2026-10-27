/**
 * The one way Zenith asks "are you sure" in place (UI_GUIDE 9.14): the question as a sentence, then
 * Cancel on the left and the specific verb as the one primary on the right. Revoke a share, remove
 * a member, delete a preset, reset every key and reject a proposal all ask with it, so the safe
 * choice is always Cancel and always in the same place. Cancel takes focus when it opens, so Enter
 * never does the thing by accident, and Escape answers Cancel.
 */
import type { ReactNode } from "react";
import { Button } from "./primitives";
import styles from "./ConfirmRow.module.css";

export interface ConfirmRowProps {
  /** The question, with what the action does and does not do: "Revoke the share with 1234?" */
  sentence: ReactNode;
  /** The primary's label: the specific verb, never OK or Yes. */
  verb: string;
  onConfirm: () => void;
  onCancel: () => void;
  /** Why the verb cannot act now, such as a name that is not typed yet; null when it can. */
  whyDisabled?: string | null;
  /** The verb's tooltip line, such as "This cannot be undone." */
  verbHint?: string;
  testId: string;
  /** Test ids of the two buttons, when a screen had them before this row; `-yes` and `-cancel` otherwise. */
  confirmTestId?: string;
  cancelTestId?: string;
  /** Anything the question needs between the sentence and the buttons, such as a field to type in. */
  children?: ReactNode;
  /** Drawn inline in a single line, for a toolbar or a header row; boxed under its row otherwise. */
  inline?: boolean;
}

export function ConfirmRow({
  sentence,
  verb,
  onConfirm,
  onCancel,
  whyDisabled = null,
  verbHint,
  testId,
  confirmTestId,
  cancelTestId,
  children,
  inline = false,
}: ConfirmRowProps) {
  return (
    <div
      className={inline ? styles.inline : styles.confirm}
      role="group"
      aria-label={verb}
      data-testid={testId}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        // Escape answers the question and nothing else: the sheet or window around it stays.
        event.stopPropagation();
        event.preventDefault();
        onCancel();
      }}
    >
      <p className={styles.sentence}>{sentence}</p>
      {children}
      <div className={styles.actions}>
        <Button testId={cancelTestId ?? `${testId}-cancel`} onClick={onCancel} takeFocus>
          Cancel
        </Button>
        <Button
          kind="primary"
          testId={confirmTestId ?? `${testId}-yes`}
          whyDisabled={whyDisabled}
          {...(verbHint === undefined ? {} : { tooltip: verb, hint: verbHint })}
          onClick={onConfirm}
        >
          {verb}
        </Button>
      </div>
    </div>
  );
}
