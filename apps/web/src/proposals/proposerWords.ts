/**
 * The proposer's status lines (spec 13 section 14), as pure helpers so each sentence is tested
 * (`proposerWords.test.ts`).
 */

/**
 * What the status line says when "Suggest changes…" opens. Only a partner that came from a received
 * cloud share can be sent a proposal; one loaded from a file, or any partner while the cloud is off,
 * gets the proposal back as a file, so the sentence names only saving.
 */
export function suggestingWords(label: string, canSend: boolean): string {
  const leaves = canSend ? "nothing is sent until you save or send the proposal" : "nothing leaves this computer until you save the proposal as a file";
  return `Suggesting changes to ${label}. Your own auto is not touched; ${leaves}.`;
}

/**
 * What the status line says when the proposer leaves, or null to leave the line as it is. Changes
 * already saved as a file or sent to the share were not dropped, so leaving then says nothing and
 * the "Saved" or "Sent" line stays.
 */
export function leaveWords(label: string, changeCount: number, handedOver: boolean): string | null {
  if (changeCount === 0 || handedOver) return null;
  const changes = changeCount === 1 ? "its 1 change was" : `its ${String(changeCount)} changes were`;
  return `Left the proposal to ${label}; ${changes} not saved or sent, so ${changeCount === 1 ? "it was" : "they were"} dropped.`;
}
