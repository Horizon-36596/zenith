/**
 * What caps a wait for a condition (issue #242). The step's Timeout is the cap, so the Until row shows
 * it as state, `≤ 1.00 s`, in both description modes, and a wait with no Timeout shows a warning
 * instead, because it can wait to the end of the match.
 */

/** The warning chip's text for a wait for a condition that has no Timeout. */
export const NO_TIMEOUT_WARNING = "No time limit: may wait to the end";

/** The cap a Timeout puts on a wait, as the Until row's suffix: `≤ 1.00 s`. */
export function waitCapText(timeoutS: number): string {
  return `≤ ${timeoutS.toFixed(2)} s`;
}
