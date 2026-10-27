/**
 * Using the team recovery code: the way back into a team library when no device that holds the team
 * key is left. The input is tolerant (capitals, spaces and dashes do not matter, and the ZNTH prefix
 * may be left off), and the text goes to `onSubmit` exactly as typed; the crypto module's parser
 * decides whether it is right, and its message is shown when it is not.
 *
 * This is the body of a sheet, or of a section inside one.
 */
import { useId, useState } from "react";
import { SheetButton } from "../../cloud/controls";
import { Tooltip } from "../../components/Tooltip";
import { recoveryCharactersTyped } from "./logic";
import { RECOVERY_ENTRY, messageOf, teamWords } from "./words";
import account from "../account.module.css";
import styles from "./keys.module.css";

export interface RecoveryCodeEntryProps {
  teamName: string;
  /** The FTC team number, when the team has one. */
  teamNumber?: number | null;
  /**
   * Uses the code as typed. Resolves when this device has the team key; rejects with an `Error` (or
   * a string) whose message is shown under the input, such as the parser's "That recovery code has a
   * typing mistake in it."
   */
  onSubmit: (text: string) => Promise<void>;
  /** True while a code is being checked, here or elsewhere. */
  busy: boolean;
  /** Goes back without using a code. Absent when there is nowhere to go back to. */
  onCancel?: () => void;
}

export function RecoveryCodeEntry({ teamName, teamNumber, onSubmit, busy, onCancel }: RecoveryCodeEntryProps) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const errorId = useId();
  const team = teamWords({ teamName, teamNumber });
  const why = busy ? RECOVERY_ENTRY.checking : text.trim() === "" ? RECOVERY_ENTRY.empty : null;

  const submit = () => {
    if (why !== null) return;
    setError(null);
    onSubmit(text).catch((reason: unknown) => {
      setError(messageOf(reason, RECOVERY_ENTRY.failed));
    });
  };

  return (
    <section className={account.section} data-testid="recovery-code-entry">
      <h3 className={account.sectionHead}>{RECOVERY_ENTRY.title(team)}</h3>
      <p className={account.prose}>{RECOVERY_ENTRY.how}</p>
      <form
        className={account.stack}
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <label className={`${account.label} ${account.wide}`}>
          {RECOVERY_ENTRY.inputLabel}
          <Tooltip label={RECOVERY_ENTRY.inputLabel} hint={RECOVERY_ENTRY.inputHint}>
            <input
              className={`${account.input} ${styles.codeInput}`}
              value={text}
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              aria-invalid={error !== null}
              aria-errormessage={error === null ? undefined : errorId}
              data-testid="recovery-entry-input"
              onChange={(event) => {
                setText(event.target.value);
                setError(null);
              }}
            />
          </Tooltip>
        </label>
        <span className={account.hint} data-testid="recovery-entry-count">
          {RECOVERY_ENTRY.count(recoveryCharactersTyped(text))}
        </span>
        {error === null ? null : (
          <p id={errorId} className={account.error} role="alert" data-testid="recovery-entry-error">
            {error}
          </p>
        )}
        <div className={account.row}>
          <SheetButton
            kind="primary"
            tooltip={RECOVERY_ENTRY.submitTooltip}
            hint={RECOVERY_ENTRY.submitHint}
            whyDisabled={why}
            testId="recovery-entry-submit"
            onClick={submit}
          >
            {busy ? RECOVERY_ENTRY.checking : RECOVERY_ENTRY.submit}
          </SheetButton>
          {onCancel === undefined ? null : (
            <SheetButton
              tooltip={RECOVERY_ENTRY.cancel}
              hint={RECOVERY_ENTRY.cancelHint}
              testId="recovery-entry-cancel"
              onClick={onCancel}
            >
              {RECOVERY_ENTRY.cancel}
            </SheetButton>
          )}
        </div>
      </form>
    </section>
  );
}
