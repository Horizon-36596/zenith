/**
 * The team recovery code, shown once: right after a team is created, and when an owner makes a new
 * code at the start of a season or after someone who held it left. It says what the code is for and
 * where to keep it, and Continue acts only after the owner has pressed Print or ticked that the code
 * was saved.
 *
 * This is the body of a sheet: put it inside `Sheet` from `cloud/controls`, with `RECOVERY_SHEET.title`
 * (or `titleReplacing`) as the sheet's title. It also holds the printed page, which is hidden on
 * screen; `onPrint` should open the system print dialog (`window.print()`), and only that page prints.
 */
import { useState } from "react";
import { SheetButton } from "../../cloud/controls";
import { Tooltip } from "../../components/Tooltip";
import { whyCannotContinue } from "./logic";
import { RECOVERY_SHEET, WORKING, dateWords, teamWords } from "./words";
import account from "../account.module.css";
import styles from "./keys.module.css";

export interface RecoveryCodeSheetProps {
  teamName: string;
  /** The FTC team number, or null for a team without one. */
  teamNumber: number | null;
  /** The code as the crypto module writes it: `ZNTH-XXXXX-XXXXX-XXXXX-XXXXX-XXXXXX`. */
  code: string;
  /** When the code was made. Only the date is shown. */
  madeAt: Date;
  /** True when this code replaces an older one, which stops working once the owner continues. */
  replacing?: boolean;
  /** Opens the system print dialog; the sheet's printed page is the only thing on the paper. */
  onPrint: () => void;
  /** The owner pressed Continue after printing or ticking that the code is saved. */
  onSaved: () => void;
  /** Leaves without using this code. Absent when a team is being created, where the code is required. */
  onCancel?: () => void;
  /** True while `onSaved`'s work is under way. */
  busy?: boolean;
}

export function RecoveryCodeSheet({
  teamName,
  teamNumber,
  code,
  madeAt,
  replacing = false,
  onPrint,
  onSaved,
  onCancel,
  busy = false,
}: RecoveryCodeSheetProps) {
  const [printed, setPrinted] = useState(false);
  const [saved, setSaved] = useState(false);
  const team = teamWords({ teamName, teamNumber });
  const date = dateWords(madeAt);
  const why = whyCannotContinue(printed, saved) ?? (busy ? WORKING : null);
  return (
    <section className={account.section} data-testid="recovery-code-sheet">
      <p className={account.lead}>{RECOVERY_SHEET.lead(team)}</p>
      <p className={account.prose}>{RECOVERY_SHEET.what}</p>
      <p className={account.prose}>{RECOVERY_SHEET.where}</p>
      {replacing ? <p className={account.prose}>{RECOVERY_SHEET.replacing}</p> : null}
      <div className={styles.codeBlock}>
        <p className={styles.recoveryCode} data-testid="recovery-code-text">
          {code}
        </p>
        <span className={styles.caption}>{RECOVERY_SHEET.madeOn(date)}</span>
      </div>
      <div className={account.row}>
        {/* Its tooltip opens above: below, it would cover the "I have saved this code" tick. */}
        <SheetButton
          tooltip={RECOVERY_SHEET.printTooltip}
          hint={RECOVERY_SHEET.printHint}
          side="top"
          testId="recovery-code-print"
          onClick={() => {
            setPrinted(true);
            onPrint();
          }}
        >
          {RECOVERY_SHEET.print}
        </SheetButton>
      </div>
      {printed ? (
        <p className={account.hint} role="status" data-testid="recovery-code-printed">
          {RECOVERY_SHEET.printed}
        </p>
      ) : null}
      <label className={account.inlineLabel}>
        <Tooltip label={RECOVERY_SHEET.saved} hint={RECOVERY_SHEET.savedHint}>
          <input
            className={account.checkbox}
            type="checkbox"
            checked={saved}
            data-testid="recovery-code-saved"
            onChange={(event) => {
              setSaved(event.target.checked);
            }}
          />
        </Tooltip>
        {RECOVERY_SHEET.saved}
      </label>
      <div className={account.row}>
        <SheetButton
          kind="primary"
          tooltip={RECOVERY_SHEET.continue}
          hint={RECOVERY_SHEET.continueHint}
          whyDisabled={why}
          testId="recovery-code-continue"
          onClick={onSaved}
        >
          {RECOVERY_SHEET.continue}
        </SheetButton>
        {onCancel === undefined ? null : (
          <SheetButton
            tooltip={RECOVERY_SHEET.cancel}
            hint={RECOVERY_SHEET.cancelHint}
            whyDisabled={busy ? WORKING : null}
            testId="recovery-code-cancel"
            onClick={onCancel}
          >
            {RECOVERY_SHEET.cancel}
          </SheetButton>
        )}
      </div>
      <RecoveryCodePrintPage team={team} code={code} date={date} />
    </section>
  );
}

/** The printed page: the team, the code in large mono, the date and one line of instructions. */
function RecoveryCodePrintPage({ team, code, date }: { team: string; code: string; date: string }) {
  return (
    <div className={styles.printPage} data-testid="recovery-code-print-page">
      <h1 className={styles.printTeam}>{team}</h1>
      <p className={styles.printCode}>{code}</p>
      <p className={styles.printLine}>{RECOVERY_SHEET.madeOn(date)}</p>
      <p className={styles.printLine}>{RECOVERY_SHEET.printInstruction}</p>
    </div>
  );
}
