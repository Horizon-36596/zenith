/**
 * Opening a share someone else made (spec 13 sections 8.5 and 9): from the
 * Partners panel's list of received shares, or from a `#/s/<secret>` link.
 *
 * With an auto open, the share is loaded into the alliance view beside it, through the cloud's
 * `PartnerSource`. With none, it opens alone in the read-only viewer, which is how a team that does
 * not plan with Zenith looks at a partner's auto (section 9).
 *
 * An anyone-with-the-link share opens with nobody signed in: its link carries the secret its key
 * is derived from (spec 14), and nothing else opens it. A share to specific teams has no link; it
 * reaches those teams' Partners panels.
 */
import { loadShareIntoAlliance } from "../alliance/cloudSource";
import { getState, setStatus } from "../state/store";
import { parseShareHash } from "./shareModel";
import { openShareByLink, openShareViewer } from "./store";
import type { ReceivedShare } from "./types";
import { sharedByWords } from "./words";

/** True when an auto is open, so a partner has something to be compared with. */
const hasOpenAuto = (): boolean => {
  const editor = getState();
  return editor.project !== null && editor.auto !== null;
};

/** Loads a share into the alliance view beside the open auto, or opens it alone in the viewer. */
export async function loadReceivedShare(share: ReceivedShare): Promise<void> {
  if (!hasOpenAuto()) {
    openShareViewer(share);
    setStatus("info", `Opened the auto ${sharedByWords(share)}, read only. Open your own auto to see both on one field.`);
    return;
  }
  await loadShareIntoAlliance(share);
}

/**
 * Takes a `#/s/<secret>` address's secret out of the address bar at once (`clearHash`), so a reload
 * does not open it twice, it does not stay in the page's history, and it is gone before anything
 * else runs. Returns the secret, which the caller keeps in memory only until the share opens
 * (`openShareSecret`), or null when the address is not a share link.
 */
export function takeShareSecret(hash: string, clearHash: () => void): string | null {
  const secret = parseShareHash(hash);
  if (secret === null) return null;
  clearHash();
  return secret;
}

/** Opens the share a link's secret belongs to, beside the open auto or alone. */
export async function openShareSecret(secret: string): Promise<void> {
  const opened = await openShareByLink(secret);
  if (!opened.ok) {
    setStatus("error", opened.why);
    return;
  }
  await loadReceivedShare(opened.share);
}

/**
 * Follows a `#/s/<secret>` address: takes the secret out of the address bar, then opens the share.
 * Resolves to true when the address was a share link.
 */
export async function followShareLink(hash: string, clearHash: () => void): Promise<boolean> {
  const secret = takeShareSecret(hash, clearHash);
  if (secret === null) return false;
  await openShareSecret(secret);
  return true;
}
