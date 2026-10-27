/**
 * The warning a sharer sees when a partner team's key is not the one this device saw before, and the
 * team did not make a new key version: this device trusted the first key it saw for that team, and a
 * different key under the same version is what a server trying to read the share would present. It
 * shows the team's safety code to compare, and asks before anything is sent.
 *
 * It goes inline in the share flow, where the send would happen.
 */
import { ShieldAlert } from "lucide-react";
import { SheetButton } from "../../cloud/controls";
import { VerificationCode } from "./VerificationCode";
import { KEY_CHANGED, WORKING, teamWords } from "./words";
import account from "../account.module.css";
import styles from "./keys.module.css";

export interface KeyChangedWarningProps {
  /** The partner team whose key changed. */
  teamName: string;
  teamNumber?: number | null;
  /** That team's safety code for the key it shows now: five groups of four digits split by spaces. */
  safetyCode: string;
  /** Trust the new key and send. */
  onContinue: () => void;
  /** Send nothing to this team. */
  onDontSend: () => void;
  /** True while the send is under way. */
  busy?: boolean;
  testId?: string;
}

export function KeyChangedWarning({
  teamName,
  teamNumber,
  safetyCode,
  onContinue,
  onDontSend,
  busy = false,
  testId = "key-changed-warning",
}: KeyChangedWarningProps) {
  const team = teamWords({ teamName, teamNumber });
  return (
    <section className={styles.warning} role="alert" data-testid={testId}>
      <h3 className={styles.warningTitle}>
        <ShieldAlert className={styles.warningIcon} size={16} strokeWidth={1.75} aria-hidden />
        {KEY_CHANGED.title(team)}
      </h3>
      <p className={account.prose}>{KEY_CHANGED.what}</p>
      <p className={account.prose}>{KEY_CHANGED.compare}</p>
      <VerificationCode code={safetyCode} caption={KEY_CHANGED.caption(team)} testId={`${testId}-code`} />
      <div className={account.row}>
        <SheetButton
          tooltip={KEY_CHANGED.dontSend}
          hint={KEY_CHANGED.dontSendHint}
          testId={`${testId}-dont-send`}
          onClick={onDontSend}
        >
          {KEY_CHANGED.dontSend}
        </SheetButton>
        <SheetButton
          tooltip={KEY_CHANGED.continueTooltip}
          hint={KEY_CHANGED.continueHint}
          whyDisabled={busy ? WORKING : null}
          testId={`${testId}-continue`}
          onClick={onContinue}
        >
          {KEY_CHANGED.continue}
        </SheetButton>
      </div>
    </section>
  );
}
