/**
 * The last account request's result, under a sheet's or a Settings section's content: the error as
 * an alert, or the notice. With `offerNewRecoveryCode`, on the sheet that holds an owner's Recovery
 * code, a notice that suggests a new code has a button that opens it.
 */
import { useEffect } from "react";
import { SheetButton } from "../cloud/controls";
import { feedbackMounted } from "./feedbackShown";
import { account, useAccount } from "./store";
import styles from "./account.module.css";

export function Feedback({ offerNewRecoveryCode = false }: { offerNewRecoveryCode?: boolean }) {
  const { error, notice, suggestNewRecoveryCode } = useAccount();
  // While this is on screen the account's failures show here, so they stay off the status line.
  useEffect(() => feedbackMounted(), []);
  if (error !== null) {
    return (
      <p className={styles.error} role="alert" data-testid="account-error">
        {error}
      </p>
    );
  }
  if (notice !== null) {
    return (
      <>
        <p className={styles.notice} data-testid="account-notice">
          {notice}
        </p>
        {offerNewRecoveryCode && suggestNewRecoveryCode ? (
          <div className={styles.row}>
            <SheetButton
              kind="text"
              tooltip="New recovery code"
              hint="Opens Recovery code on this page, which asks first."
              testId="account-notice-new-recovery-code"
              onClick={() => {
                account.askNewRecoveryCode(true);
              }}
            >
              Make a new recovery code
            </SheetButton>
          </div>
        ) : null}
      </>
    );
  }
  return null;
}
