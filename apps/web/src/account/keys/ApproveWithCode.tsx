/**
 * The approval step for a new member or a new device. The approver types the approval code the
 * waiting device shows (the owner's ruling of 2026-09-28): a code only shown could be approved
 * without anyone comparing it, and a server could slip in a device of its own. Typing it proves the
 * approver has the real device in front of them.
 *
 * The input is tolerant (capitals, spaces, dashes and the look-alikes O, I and L do not matter, as
 * the cloud's `normaliseApprovalCode` reads it) and counts the characters typed; Approve acts once
 * all 18 are there. A code that is not the device's comes back as "wrong-code" and is said plainly
 * under the input, and the approver can type it again.
 *
 * It fits a sheet's body or a list row's follow-up (as `NewDeviceRequestRow` and the member row use it).
 */
import { useId, useState } from "react";
import { APPROVAL_CODE_CHARACTERS, normaliseApprovalCode } from "@horizon36596/zenith-cloud/crypto";
import { SheetButton } from "../../cloud/controls";
import { Tooltip } from "../../components/Tooltip";
import { isWrongCode } from "./errors";
import { APPROVE, WORKING, messageOf } from "./words";
import account from "../account.module.css";
import styles from "./keys.module.css";

export interface ApproveWithCodeProps {
  /** The display name of the person whose device is waiting. */
  who: string;
  /** The device's own label, such as "Chrome on Windows", when it is known. */
  deviceLabel?: string | null;
  /** A new member's first device, or a new device of someone already on the team. */
  kind: "member" | "device";
  /** True when the approver is approving a device of their own ("Approve your new device"). */
  ownDevice?: boolean;
  /**
   * Approves with the code as typed. Resolves once the approval is written; rejects with the
   * cloud's error, whose "wrong-code" is shown as a plain sentence and any other message as it is.
   */
  onApprove: (approvalCode: string) => Promise<void>;
  onDecline: () => void;
  /** True while the approval or the decline is being written. */
  busy: boolean;
  /** Why Approve cannot act at all (the device has not asked for the key, say), or null. */
  whyCannotApprove?: string | null;
  testId?: string;
}

/**
 * What the code typed so far is, for the count and for whether Approve may act. `of` is the
 * approval code's length, `APPROVAL_CODE_CHARACTERS` (18); the dashes between its groups do not count.
 */
export function typedApprovalCode(text: string): { typed: number; of: number; whyNot: string | null } {
  const of = APPROVAL_CODE_CHARACTERS;
  const typed = normaliseApprovalCode(text).length;
  const whyNot = typed > of ? APPROVE.tooLong : typed < of ? APPROVE.notYet(of) : null;
  return { typed, of, whyNot };
}

export function ApproveWithCode({
  who,
  deviceLabel = null,
  kind,
  ownDevice = false,
  onApprove,
  onDecline,
  busy,
  whyCannotApprove = null,
  testId = "approve-with-code",
}: ApproveWithCodeProps) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const errorId = useId();
  const title = ownDevice ? APPROVE.titleOwnDevice : kind === "member" ? APPROVE.titleMember(who) : APPROVE.titleDevice(who);
  const code = typedApprovalCode(text);
  const why = busy ? WORKING : (whyCannotApprove ?? code.whyNot);

  const approve = () => {
    if (why !== null) return;
    setError(null);
    onApprove(text).catch((reason: unknown) => {
      setError(isWrongCode(reason) ? APPROVE.wrongCode : messageOf(reason, APPROVE.failed));
    });
  };

  return (
    <section className={account.section} data-testid={testId}>
      <h3 className={account.sectionHead}>{title}</h3>
      {deviceLabel === null || deviceLabel.trim() === "" ? null : (
        <p className={account.hint} data-testid={`${testId}-device`}>
          {APPROVE.device(deviceLabel)}
        </p>
      )}
      <p className={account.prose}>{ownDevice ? APPROVE.askOwn : APPROVE.ask(who)}</p>
      <form
        className={account.stack}
        onSubmit={(event) => {
          event.preventDefault();
          approve();
        }}
      >
        <label className={`${account.label} ${account.wide}`}>
          {APPROVE.inputLabel}
          <Tooltip label={APPROVE.inputLabel} hint={`${APPROVE.why} ${APPROVE.inputHint}`}>
            <input
              className={`${account.input} ${styles.codeInput}`}
              value={text}
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              aria-invalid={error !== null}
              aria-errormessage={error === null ? undefined : errorId}
              data-testid={`${testId}-input`}
              onChange={(event) => {
                setText(event.target.value);
                setError(null);
              }}
            />
          </Tooltip>
        </label>
        <span className={account.hint} data-testid={`${testId}-count`}>
          {APPROVE.count(code.typed, code.of)}
        </span>
        {error === null ? null : (
          <p id={errorId} className={account.error} role="alert" data-testid={`${testId}-error`}>
            {error}
          </p>
        )}
        <div className={account.row}>
          <SheetButton
            kind="primary"
            tooltip={APPROVE.approve}
            hint={kind === "member" && !ownDevice ? APPROVE.approveMember(who) : APPROVE.approveDevice}
            whyDisabled={why}
            testId={`${testId}-approve`}
            onClick={approve}
          >
            {APPROVE.approve}
          </SheetButton>
          <SheetButton
            tooltip={APPROVE.decline}
            hint={APPROVE.declineHint}
            whyDisabled={busy ? WORKING : null}
            testId={`${testId}-decline`}
            onClick={onDecline}
          >
            {APPROVE.decline}
          </SheetButton>
        </div>
      </form>
    </section>
  );
}
