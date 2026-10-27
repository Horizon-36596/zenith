/**
 * What a member sees on a device that has no team key yet: that a teammate has to unlock the team
 * library here, this device's approval code to read out (the approver types it), who can approve
 * it, a way to use the recovery code instead, and that everything outside the team library still
 * works meanwhile. The device's 12-digit verification code is not shown: the typed approval code
 * replaces comparing it, and one code on the screen is one code to read out.
 *
 * When the request is gone (it was declined, or this device refused a key it was sent without its
 * code, or the key changed before it opened it), it says so and offers Ask again.
 *
 * This is the body of a sheet, or of the team section of one. `onUseRecoveryCode` should show
 * `RecoveryCodeEntry`.
 */
import { formatApprovalCode } from "@horizon36596/zenith-cloud/crypto";
import { SheetButton } from "../../cloud/controls";
import { VerificationCode } from "./VerificationCode";
import { whoCanApprove, type WaitingKind } from "./logic";
import { WAITING, WORKING, teamWords } from "./words";
import account from "../account.module.css";

export interface WaitingForKeyProps {
  teamName: string;
  /** The FTC team number, when the team has one. */
  teamNumber?: number | null;
  /**
   * This device's approval code for the team's pending request: 18 characters, which the screen
   * shows in three groups of six (`formatApprovalCode`) for the approver to type.
   */
  code: string;
  /** "member" for a new member's first device, which an owner or admin approves; "device" for another device of a member. */
  kind: WaitingKind;
  /** The team setting that lets any active member approve devices. Off by default. */
  membersMayApprove?: boolean;
  /** False when the request this device made is gone, and it has to ask again. */
  requested?: boolean;
  /**
   * False when this browser could not save the approval code (its storage is full or turned off),
   * so it lasts for this session only; the screen then says approval will be needed each time.
   */
  savedOnDevice?: boolean;
  /** Asks for the key again; shown only when `requested` is false. */
  onAskAgain?: () => void;
  /** True while a request is being written. */
  busy?: boolean;
  /** Opens the recovery code entry. */
  onUseRecoveryCode: () => void;
}

export function WaitingForKey({
  teamName,
  teamNumber,
  code,
  kind,
  membersMayApprove = false,
  requested = true,
  savedOnDevice = true,
  onAskAgain,
  busy = false,
  onUseRecoveryCode,
}: WaitingForKeyProps) {
  const team = teamWords({ teamName, teamNumber });
  return (
    <section className={account.section} data-testid="waiting-for-key">
      <p className={account.lead}>{WAITING.title}</p>
      <p className={account.prose}>{whoCanApprove(kind, team, membersMayApprove)}</p>
      <p className={account.prose}>{WAITING.readOut}</p>
      <VerificationCode code={formatApprovalCode(code)} caption={WAITING.caption} testId="waiting-for-key-code" />
      {savedOnDevice ? null : (
        <p className={account.hint} role="status" data-testid="waiting-for-key-not-saved">
          {WAITING.notSaved}
        </p>
      )}
      {requested || onAskAgain === undefined ? null : (
        <p className={account.error} role="status" data-testid="waiting-for-key-not-waiting">
          {WAITING.notWaiting}
        </p>
      )}
      <p className={account.hint}>{WAITING.meanwhile}</p>
      <div className={account.row}>
        {requested || onAskAgain === undefined ? null : (
          <SheetButton
            kind="primary"
            tooltip={WAITING.askAgain}
            hint={WAITING.askAgainHint}
            whyDisabled={busy ? WORKING : null}
            testId="waiting-for-key-ask-again"
            onClick={onAskAgain}
          >
            {WAITING.askAgain}
          </SheetButton>
        )}
        <SheetButton
          kind="text"
          tooltip={WAITING.useRecovery}
          hint={WAITING.useRecoveryHint}
          testId="waiting-for-key-recovery"
          onClick={onUseRecoveryCode}
        >
          {WAITING.useRecovery}
        </SheetButton>
      </div>
    </section>
  );
}
