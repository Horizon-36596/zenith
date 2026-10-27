/**
 * How many account `Feedback` lines are on screen now: the sheets and Settings sections that show the
 * account's last result mount one each. While none is, an account failure also goes to the status
 * line, so a publish refused from the command palette or the share dialog is never silent.
 */
let mounted = 0;

/** Counts one `Feedback` on screen until the returned clean-up runs. */
export function feedbackMounted(): () => void {
  mounted += 1;
  return () => {
    mounted -= 1;
  };
}

/** True while at least one `Feedback` is on screen. */
export const feedbackShown = (): boolean => mounted > 0;
