/**
 * Where a proposal goes, and what it names (spec 13 section 14): the send sink is the cloud share
 * only for a partner loaded from a received cloud share at the propose level, with the cloud on and
 * the signed-in team one the share was made to; a file partner, a signed-out page, a view share, a
 * share made to other teams and the team's own share all fall back to the file, each with its
 * reason. A cloud partner's proposal names its real share id and revision; a file partner's names a
 * local reference.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { newProposal } from "@horizon36596/zenith-core";
import { parseProjection } from "@horizon36596/zenith-schema";
import { describe, expect, it } from "vitest";
import type { PartnerShare } from "../cloud/partnerShare";
import type { SendProposalRequest } from "../cloud/proposalsApi";
import { LOCAL_REF_REVISION, partnerRefOf, suggestBlockedReason } from "./proposerActions";
import { cloudShareSink, proposalText, sendSinkFor, type CloudSend } from "./sink";

const starter = fileURLToPath(new URL("../../../../examples/starter/", import.meta.url));
const SHARE = parseProjection(JSON.parse(readFileSync(`${starter}partners/starter-collect-and-score.propose.projection.json`, "utf8")));

const OWNER = "team-owner";
const ME = "team-me";

const share = (patch: Partial<PartnerShare> = {}): PartnerShare => ({
  shareId: "Zq3fK9xT2mNp7LwR4sVb8A",
  revision: 3,
  revisionId: "000003-abc",
  level: "propose",
  mode: "follow",
  fromTeamId: OWNER,
  fromTeam: "Team 36596",
  teamIds: [ME],
  updatedAt: "2026-09-27T09:00:00.000Z",
  ...patch,
});

const signedIn = { signedIn: true, teamId: ME };

/** A stand-in for the cloud that records what it was handed. */
function recorder(queued = false): { send: CloudSend; calls: Omit<SendProposalRequest, "fromTeamId">[] } {
  const calls: Omit<SendProposalRequest, "fromTeamId">[] = [];
  const send: CloudSend = (request) => {
    calls.push(request);
    return Promise.resolve({ value: {} as never, queued });
  };
  return { send, calls };
}

describe("choosing where Send goes", () => {
  it("sends to the share for a propose-level cloud partner made to the signed-in team", () => {
    const choice = sendSinkFor(share(), signedIn);
    expect(choice.ok).toBe(true);
    if (choice.ok) expect(choice.sink.description).toBe("Team 36596's share");
  });

  it("offers no send, and says why, for a file partner, signed out, a view share, other teams and the team's own share", () => {
    const why = (choice: ReturnType<typeof sendSinkFor>): string => (choice.ok ? "" : choice.why);
    expect(why(sendSinkFor(undefined, signedIn))).toContain("loaded from a file");
    expect(why(sendSinkFor(share(), { signedIn: false, teamId: null }))).toContain("Sign in");
    expect(why(sendSinkFor(share({ level: "view" }), signedIn))).toContain("view only");
    expect(why(sendSinkFor(share({ teamIds: ["team-other"] }), signedIn))).toContain("did not share this auto with the team you are signed in with");
    expect(why(sendSinkFor(share(), { signedIn: true, teamId: OWNER }))).toContain("your own team's share");
  });
});

describe("the cloud share sink", () => {
  const proposal = newProposal(SHARE, { shareId: share().shareId, revision: 3 }, [{ op: "insertWait", atStart: true, seconds: 1 }]);

  it("hands the cloud the proposal's canonical text against the share's revision id, and says it was sent", async () => {
    const { send, calls } = recorder();
    const said = await cloudShareSink(share(), send).send(proposal, "x.proposal.json");
    expect(calls).toEqual([{ shareId: share().shareId, baseRevisionId: "000003-abc", text: proposalText(proposal) }]);
    expect(said.sentence).toContain("Sent the proposal to Team 36596");
    expect(said.waiting).toBe(false);
  });

  it("says the proposal is waiting to send, never that it was sent, when the computer is offline", async () => {
    const { send } = recorder(true);
    const said = await cloudShareSink(share(), send).send(proposal, "x.proposal.json");
    expect(said).toEqual({
      sentence: "Waiting to send the proposal to Team 36596. It goes from the Outbox when you are back online.",
      waiting: true,
    });
  });

  it("refuses a proposal that names another share or revision, and sends nothing", async () => {
    const { send, calls } = recorder();
    await expect(cloudShareSink(share({ revision: 4 }), send).send(proposal, "x.proposal.json")).rejects.toThrow("different share or revision");
    expect(calls).toEqual([]);
  });
});

describe("what a partner's proposal names", () => {
  it("names a cloud partner's real share id and revision", () => {
    expect(partnerRefOf({ fileName: "Team 36596", share: share() })).toEqual({
      kind: "cloud",
      shareRef: { shareId: "Zq3fK9xT2mNp7LwR4sVb8A", revision: 3 },
    });
  });

  it("names a local reference for a file partner, from its file name", () => {
    expect(partnerRefOf({ fileName: "partners/starter-collect-and-score.propose.projection.json" })).toEqual({
      kind: "local",
      shareRef: { shareId: "starter-collect-and-score", revision: LOCAL_REF_REVISION },
    });
  });

  it("offers Suggest changes on a cloud share only at the propose level, to a team it was made to", () => {
    const open = { project: {} as never, auto: {} as never };
    expect(suggestBlockedReason({ projection: SHARE, share: share() }, open, ME)).toBeNull();
    expect(suggestBlockedReason({ projection: SHARE }, open, null)).toBeNull();
    expect(suggestBlockedReason({ projection: SHARE, share: share({ level: "view" }) }, open, ME)).toContain("view only");
    expect(suggestBlockedReason({ projection: SHARE, share: share() }, open, "team-other")).toContain("did not share");
    expect(suggestBlockedReason({ projection: SHARE, share: share() }, { project: null, auto: null }, ME)).toContain("Open your own auto");
  });
});
