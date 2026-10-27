/**
 * The cloud's `PartnerSource`: a share the team received, or one opened by its `#/s/<id>` link
 * (spec 13 section 9, "Add to alliance view"). The share carries only its projection, which goes
 * through the same strict schema check as a file a user picks (`readPartnerText`), so a share from
 * the cloud is trusted no more than a file from a stranger.
 *
 * The partner is named after the team that shared it, "Team 12345" ("Shared link" when the viewer
 * cannot read the team), unless the sharer kept the auto's title in the projection. It remembers
 * the share it came from (`partnerShareOf`): its id, revision, level, the sharing team and when it
 * last changed, which is what the alliance view's "updated 3 hours ago" and a proposal to it use.
 */
import { partnerShareOf } from "../cloud/partnerShare";
import type { ReceivedShare } from "../cloud/types";
import { fromTeamWords, sharedByWords } from "../cloud/words";
import { setStatus } from "../state/store";
import { loadPartnersFrom } from "./actions";
import { readPartnerText, type PartnerLoad, type PartnerSource, type ShareWords } from "./source";
import { replacePartner } from "./store";

/**
 * How a received share's refusal reads: it names the share by who shared it (`subject`), and the
 * next step is to ask that team, since nobody here can fix what the cloud holds.
 */
export const receivedShareWords = (share: ReceivedShare, subject = `The auto ${sharedByWords(share)}`): ShareWords => ({
  subject,
  again: "Ask that team to share it again.",
});

/** One received share as a partner load, remembering the share it came from. */
function loadOf(share: ReceivedShare, subject?: string): PartnerLoad {
  const load = readPartnerText(fromTeamWords(share), share.projection, receivedShareWords(share, subject));
  return load.ok ? { ...load, share: partnerShareOf(share) } : load;
}

export function receivedShareSource(share: ReceivedShare): PartnerSource {
  return {
    description: `the auto ${sharedByWords(share)}`,
    load: () => Promise.resolve([loadOf(share)]),
  };
}

/** Loads a received share into the alliance view beside the open auto, saying so on the status line. */
export const loadShareIntoAlliance = (share: ReceivedShare): Promise<void> => loadPartnersFrom(receivedShareSource(share));

/** Reload: puts the share's newer version in place of partner `partnerId`, keeping its offset. */
export function reloadSharePartner(partnerId: string, share: ReceivedShare): void {
  const load = loadOf(share, `The newer version ${sharedByWords(share)}`);
  if (!load.ok) {
    setStatus("error", load.reason);
    return;
  }
  if (replacePartner(partnerId, load)) {
    setStatus("ok", `Reloaded the auto ${sharedByWords(share)} at revision ${String(share.revision)}. Its findings are predictions.`);
  }
}
