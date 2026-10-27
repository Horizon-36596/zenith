/**
 * The warning a sharer sees when a team number now leads to a different team from the one this
 * device shared with under it before. The server writes the claim that turns a number into a team,
 * so this is what a server trying to read the share would show, and it is treated like a changed key:
 * both teams' safety codes are shown, and nothing is sent until the person decides.
 *
 * It goes inline in the share flow, where the send would happen.
 */
import { ShieldAlert } from "lucide-react";
import { SheetButton } from "../../cloud/controls";
import { VerificationCode } from "./VerificationCode";
import { NUMBER_CHANGED, WORKING, numberedTeamWords } from "./words";
import account from "../account.module.css";
import styles from "./keys.module.css";

export interface NumberChangedWarningProps {
  /** The FTC number the person typed. */
  teamNumber: number;
  /** The name of the team the number leads to now, or null when it cannot be read. */
  teamName: string | null;
  /** That team's safety code: five groups of four digits split by spaces. */
  safetyCode: string;
  /** The name of the team this device shared with under the number before, or null. */
  previousTeamName: string | null;
  /** That earlier team's safety code, or null when it can no longer be read. */
  previousSafetyCode: string | null;
  /** Share with the team the number leads to now. */
  onContinue: () => void;
  /** Send nothing to this team. */
  onDontSend: () => void;
  /** True while the send is under way. */
  busy?: boolean;
  testId?: string;
}

export function NumberChangedWarning({
  teamNumber,
  teamName,
  safetyCode,
  previousTeamName,
  previousSafetyCode,
  onContinue,
  onDontSend,
  busy = false,
  testId = "number-changed-warning",
}: NumberChangedWarningProps) {
  const number = String(teamNumber);
  const now = numberedTeamWords(teamName, teamNumber);
  const before = numberedTeamWords(previousTeamName, teamNumber);
  return (
    <section className={styles.warning} role="alert" data-testid={testId}>
      <h3 className={styles.warningTitle}>
        <ShieldAlert className={styles.warningIcon} size={16} strokeWidth={1.75} aria-hidden />
        {NUMBER_CHANGED.title(number)}
      </h3>
      <p className={account.prose}>
        {NUMBER_CHANGED.what} {NUMBER_CHANGED.risk}
      </p>
      <p className={account.prose}>{NUMBER_CHANGED.compare}</p>
      {previousSafetyCode === null ? (
        <p className={account.hint} data-testid={`${testId}-before-gone`}>
          {NUMBER_CHANGED.beforeGone}
        </p>
      ) : (
        <VerificationCode code={previousSafetyCode} caption={NUMBER_CHANGED.before(before)} testId={`${testId}-before`} />
      )}
      <VerificationCode code={safetyCode} caption={NUMBER_CHANGED.now(now)} testId={`${testId}-code`} />
      <div className={account.row}>
        <SheetButton
          tooltip={NUMBER_CHANGED.dontSend}
          hint={NUMBER_CHANGED.dontSendHint}
          testId={`${testId}-dont-send`}
          onClick={onDontSend}
        >
          {NUMBER_CHANGED.dontSend}
        </SheetButton>
        <SheetButton
          tooltip={NUMBER_CHANGED.continueTooltip}
          hint={NUMBER_CHANGED.continueHint}
          whyDisabled={busy ? WORKING : null}
          testId={`${testId}-continue`}
          onClick={onContinue}
        >
          {NUMBER_CHANGED.continue}
        </SheetButton>
      </div>
    </section>
  );
}
