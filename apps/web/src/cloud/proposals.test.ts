/**
 * Proposals through the cloud (spec 13 section 14), in node against the in-memory cloud and its
 * real permission rules: Horizon shares its collect-and-score at the propose level with team 12345;
 * team 12345 loads it, proposes a wait at the start and sends it through the share sink; Horizon
 * sees it received for that share, opens it against the library revision it was made against,
 * accepts and applies it, and team 12345 sees it accepted. Also: a rejection, the model's words,
 * the rules refusing a view share, and a send made offline waiting in the Outbox.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { canonicalize, loadAuto, loadField, loadLink, loadRobot, loadWaypoints, newProposal } from "@horizon36596/zenith-core";
import { parseProjection, type Proposal } from "@horizon36596/zenith-schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryBackend } from "@horizon36596/zenith-cloud/memory";
import { partnerShareOf } from "./partnerShare";
import { acceptEveryValidChange, applyAccepted, currentOwnerReview, leaveOwnerReview, rejectCloudProposal } from "../proposals/ownerActions";
import { getOwnerReview, openOwnerReview } from "../proposals/ownerStore";
import { openCloudProposal, pinnedFromRevision } from "../proposals/cloudReview";
import { sendSinkFor } from "../proposals/sink";
import type { ProjectBackend } from "../project/backend";
import type { Project } from "../project/types";
import { closeProject, getState, openAuto, openProject } from "../state/store";
import { NOW_MS, cloudWorld, publishTo, type CloudMember } from "./cloudFixture.test";
import { createCloudSharingApi } from "./cloudSharingApi";
import { CloudError, RULES_REFUSED } from "@horizon36596/zenith-cloud";
import { createCloudProposalsApi, proposalErrorSentence, type CloudProposal } from "./proposalsApi";
import {
  openCount,
  proposalChangeCount,
  proposalWords,
  proposalsOfShare,
  reviewBlockedReason,
  shareStatusOf,
  whyCannotWithdraw,
  withdrawConfirmSentence,
  withdrawnSentence,
} from "./proposalsModel";
import { getProposals, refreshProposals, setProposalsApi, withdrawCloudProposal } from "./proposalsStore";
import { revisionProjector } from "./revisionProjection";
import { SIGNED_OUT, getCloud, openSharingSheet, setSharingBackend, type CloudSession } from "./store";

const starter = fileURLToPath(new URL("../../../../examples/starter/", import.meta.url));
const text = (relative: string): string => readFileSync(`${starter}${relative}`, "utf8");
const read = (relative: string): unknown => JSON.parse(text(relative));
const link = loadLink(read("zenith.json"));
const waypointsFile = link.waypoints ?? "autos/waypoints.json";
const project: Project = {
  source: { kind: "example" },
  name: "examples/starter",
  link,
  robot: loadRobot(read(link.robot)),
  field: loadField(read(link.field)),
  waypoints: loadWaypoints(read(waypointsFile)),
  autoFiles: [],
  autoTexts: {},
};
const FILE = "collect-and-score.auto.json";
const OWN_AUTO = loadAuto(read(`autos/${FILE}`));
const CONTENT = canonicalize("auto", OWN_AUTO);
const FILES = { content: CONTENT, robot: text(link.robot), field: text(link.field), waypoints: text(waypointsFile) };

const sessionOf = (member: CloudMember): CloudSession => ({ signedIn: true, teamId: member.teamId, teamNumber: member.teamNumber, teamName: null });

/** Signs this page in as `member`, for sharing and for proposals. */
function signInAs(member: CloudMember): void {
  setSharingBackend(createCloudSharingApi(member.backend, { now: () => NOW_MS }), sessionOf(member), { now: () => NOW_MS });
  setProposalsApi(createCloudProposalsApi(member.backend), sessionOf(member));
}

/** Horizon publishes collect-and-score with its robot and field, and shares it with team 12345. */
async function shared(level: "view" | "propose" = "propose") {
  const world = await cloudWorld([12345]);
  const partner = world.partners[0];
  if (partner === undefined) throw new Error("no partner");
  const at = await publishTo(world.owner, FILE, CONTENT, { robot: FILES.robot, field: FILES.field, waypoints: FILES.waypoints });
  const projector = revisionProjector(FILES, null, at.n);
  if (!projector.ok) throw new Error(projector.reason);
  const projection = projector.build({ level, coarsen: false });
  if (projection === null) throw new Error("not projected");
  const made = await world.owner.backend.createShare({
    teamId: world.owner.teamId,
    autoId: at.autoId,
    revision: at.revisionId,
    audience: "teams",
    teamIds: [partner.teamId],
    level,
    projection,
  });
  await made.sent;
  return { world, partner, at, shareId: made.value.id };
}

/** Team 12345's side: the received share, and a one-change proposal against it. */
async function propose(partner: CloudMember, comment: string) {
  const [received] = await createCloudSharingApi(partner.backend, { now: () => NOW_MS }).listReceived(partner.teamId);
  if (received === undefined) throw new Error("nothing received");
  const share = partnerShareOf(received);
  const projection = parseProjection(JSON.parse(received.projection));
  const proposal: Proposal = newProposal(projection, { shareId: share.shareId, revision: share.revision }, [
    { op: "insertWait", atStart: true, seconds: 1, comment },
  ]);
  return { share, proposal };
}

const settled = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

afterEach(() => {
  leaveOwnerReview();
  closeProject();
  setProposalsApi(null, SIGNED_OUT);
  setSharingBackend(createCloudSharingApi(new MemoryBackend()), SIGNED_OUT);
});

describe("proposals through the cloud", () => {
  it("goes from team 12345 to Horizon, is accepted and applied there, and reads accepted back at team 12345", async () => {
    const { world, partner, at, shareId } = await shared();

    // ---- Team 12345 sends it through the share sink. ----
    signInAs(partner);
    await settled();
    const { share, proposal } = await propose(partner, "Let us clear the wall first.");
    const choice = sendSinkFor(share, sessionOf(partner));
    if (!choice.ok) throw new Error(choice.why);
    expect((await choice.sink.send(proposal, "x.proposal.json")).sentence).toContain("Sent the proposal to Team 36596 (unverified)");
    expect(getProposals().sent.map((entry) => [entry.shareId, entry.status, entry.ownerTeam])).toEqual([[shareId, "open", "Team 36596 (unverified)"]]);

    // ---- Horizon sees it received for that share. ----
    signInAs(world.owner);
    await settled();
    await refreshProposals();
    const received = proposalsOfShare(getProposals().received, shareId);
    expect(received).toHaveLength(1);
    const [first] = received;
    if (first === undefined) throw new Error("nothing received");
    expect(first).toMatchObject({ status: "open", fromTeam: "Team 12345 (unverified)", revision: 1, baseRevisionId: at.revisionId, autoId: at.autoId });
    expect(proposalWords(first, "received", NOW_MS)).toMatchObject({ status: "Open", who: "From team 12345 (unverified)", against: "against revision 1" });

    // ---- Opened against revision 1 of the library, with collect-and-score open. ----
    openProject(project, { kind: "local" } as unknown as ProjectBackend);
    openAuto(FILE, OWN_AUTO, CONTENT);
    const [ownShare] = await createCloudSharingApi(world.owner.backend, { now: () => NOW_MS }).listShares(world.owner.teamId);
    if (ownShare === undefined) throw new Error("no share");
    openSharingSheet("sharing");
    await openCloudProposal(first, ownShare);
    const review = getOwnerReview();
    // The review takes the editor, so the Sharing page it was opened from is closed.
    expect(getCloud().sheet).toBeNull();
    expect(review?.pinnedSource).toBe("revision");
    expect(review?.shareRef).toEqual({ shareId, revision: 1 });
    expect(review?.cloud).toMatchObject({ proposalId: first.id, fromTeam: "Team 12345 (unverified)", status: "open" });
    expect(currentOwnerReview()?.validIndexes).toEqual([0]);

    // ---- Accept and apply: the auto gains the wait, and the cloud records it accepted. ----
    const before = getState().auto?.steps.length ?? 0;
    acceptEveryValidChange();
    applyAccepted();
    expect(getState().auto?.steps.length).toBe(before + 1);
    expect(getState().auto?.steps[0]?.kind).toBe("wait");
    // The decision is sent in the background, after encryption work that takes more than a few ticks.
    await vi.waitFor(() => {
      expect(getOwnerReview()?.cloud?.status).toBe("accepted");
    });

    // ---- Team 12345 sees it accepted. ----
    signInAs(partner);
    await settled();
    await refreshProposals();
    expect(getProposals().sent.map((entry) => entry.status)).toEqual(["accepted"]);
  });

  it("records a rejection, which the proposing team reads back", async () => {
    const { world, partner, shareId } = await shared();
    signInAs(partner);
    await settled();
    const { share, proposal } = await propose(partner, "Wait for us.");
    const choice = sendSinkFor(share, sessionOf(partner));
    if (!choice.ok) throw new Error(choice.why);
    await choice.sink.send(proposal, "x.proposal.json");

    signInAs(world.owner);
    await settled();
    await refreshProposals();
    const [first] = getProposals().received;
    const [ownShare] = await createCloudSharingApi(world.owner.backend, { now: () => NOW_MS }).listShares(world.owner.teamId);
    if (first === undefined || ownShare === undefined) throw new Error("missing");
    openProject(project, { kind: "local" } as unknown as ProjectBackend);
    openAuto(FILE, OWN_AUTO, CONTENT);
    await openCloudProposal(first, ownShare);
    await rejectCloudProposal();
    expect(getOwnerReview()?.cloud?.status).toBe("rejected");
    // The auto is untouched.
    expect(canonicalize("auto", getState().auto ?? OWN_AUTO)).toBe(CONTENT);

    const sent = await createCloudProposalsApi(partner.backend).list(partner.teamId, "sent");
    expect(sent.map((entry) => [entry.shareId, entry.status])).toEqual([[shareId, "rejected"]]);
  });

  /** Team 12345 sends a one-change proposal; Horizon opens it for review with collect-and-score open. */
  async function opened(comment: string) {
    const { world, partner, shareId } = await shared();
    signInAs(partner);
    await settled();
    const { share, proposal } = await propose(partner, comment);
    const choice = sendSinkFor(share, sessionOf(partner));
    if (!choice.ok) throw new Error(choice.why);
    await choice.sink.send(proposal, "x.proposal.json");
    signInAs(world.owner);
    await settled();
    await refreshProposals();
    const [first] = getProposals().received;
    const [ownShare] = await createCloudSharingApi(world.owner.backend, { now: () => NOW_MS }).listShares(world.owner.teamId);
    if (first === undefined || ownShare === undefined) throw new Error("missing");
    openProject(project, { kind: "local" } as unknown as ProjectBackend);
    openAuto(FILE, OWN_AUTO, CONTENT);
    await openCloudProposal(first, ownShare);
    return { partner, shareId, first };
  }

  it("records a decision that comes back after another proposal was opened on that one only (issue #408)", async () => {
    const { first } = await opened("Wait for us.");
    const rejecting = rejectCloudProposal();
    expect(getOwnerReview()?.cloud?.deciding).toBe(true);
    // The owner opens a different proposal before the reply comes back.
    const current = getOwnerReview();
    if (current?.cloud === undefined) throw new Error("no review");
    openOwnerReview({ ...current, cloud: { ...current.cloud, proposalId: "another-proposal", status: "open", deciding: false } });
    await rejecting;
    expect(getOwnerReview()?.cloud).toMatchObject({ proposalId: "another-proposal", status: "open", deciding: false });
    expect(first.id).not.toBe("another-proposal");
  });

  it("will not Apply while a rejection is on its way, and says so when the proposal was rejected already (issue #408)", async () => {
    await opened("Wait for us.");
    acceptEveryValidChange();
    const rejecting = rejectCloudProposal();
    applyAccepted();
    expect(canonicalize("auto", getState().auto ?? OWN_AUTO)).toBe(CONTENT);
    expect(getState().status).toMatchObject({ kind: "error", message: expect.stringContaining("Wait for the cloud to record your decision") });
    await rejecting;
    expect(getOwnerReview()?.cloud?.status).toBe("rejected");

    // Applied after the rejection, the changes go in, and the status line says the sender still sees it rejected.
    applyAccepted();
    expect(getState().auto?.steps[0]?.kind).toBe("wait");
    expect(getState().status?.message).toContain("You rejected the proposal from Team 12345 (unverified) already");
    await settled();
    expect(getOwnerReview()?.cloud?.status).toBe("rejected");
  });

  it("waits in the Outbox while offline, and arrives once the connection comes back", async () => {
    const { world, partner, shareId } = await shared();
    signInAs(partner);
    await settled();
    const { share, proposal } = await propose(partner, "Offline.");
    await partner.backend.setOnline(false);
    const choice = sendSinkFor(share, sessionOf(partner));
    if (!choice.ok) throw new Error(choice.why);
    expect(await choice.sink.send(proposal, "x.proposal.json")).toMatchObject({ waiting: true, sentence: expect.stringContaining("Waiting to send") });
    expect(partner.backend.outbox().entries.map((entry) => [entry.kind, entry.state])).toEqual(
      expect.arrayContaining([["proposal", "queued"]]),
    );
    expect(await createCloudProposalsApi(world.owner.backend).list(world.owner.teamId, "received")).toEqual([]);

    await partner.backend.setOnline(true);
    await settled();
    const received = await createCloudProposalsApi(world.owner.backend).list(world.owner.teamId, "received");
    expect(received.map((entry) => entry.shareId)).toEqual([shareId]);
  });

  it("waits in the Outbox when the page says offline though the backend does not, and posts that as information", async () => {
    const { world, partner, shareId } = await shared();
    signInAs(partner);
    // The browser's own switch is off: the account says offline while the backend has not noticed.
    setProposalsApi(createCloudProposalsApi(partner.backend, { online: () => false }), sessionOf(partner));
    await settled();
    const { share, proposal } = await propose(partner, "Browser offline.");
    const choice = sendSinkFor(share, sessionOf(partner));
    if (!choice.ok) throw new Error(choice.why);
    const said = await choice.sink.send(proposal, "x.proposal.json");
    expect(said).toEqual({
      sentence: "Waiting to send the proposal to Team 36596 (unverified). It goes from the Outbox when you are back online.",
      waiting: true,
    });
    expect(said.sentence).not.toContain("Sent");
    // The backend was online all along, so the write still reaches Horizon.
    await settled();
    const received = await createCloudProposalsApi(world.owner.backend).list(world.owner.teamId, "received");
    expect(received.map((entry) => entry.shareId)).toEqual([shareId]);
  });

  it("is withdrawn by the member who sent it, and Horizon sees it withdrawn with nothing to review", async () => {
    const { world, partner, shareId } = await shared();
    signInAs(partner);
    await settled();
    const { share, proposal } = await propose(partner, "On second thought.");
    const choice = sendSinkFor(share, sessionOf(partner));
    if (!choice.ok) throw new Error(choice.why);
    await choice.sink.send(proposal, "x.proposal.json");
    const [mine] = getProposals().sent;
    if (mine === undefined) throw new Error("nothing sent");
    expect(mine).toMatchObject({ status: "open", sentByMe: true });
    expect(whyCannotWithdraw(mine)).toBeNull();

    const withdrawn = await withdrawCloudProposal(mine.id);
    expect(withdrawn.queued).toBe(false);
    expect(withdrawnSentence(mine, withdrawn.queued)).toBe("Withdrew the proposal. Team 36596 (unverified) now sees it as withdrawn.");
    const [after] = getProposals().sent;
    expect(after).toMatchObject({ id: mine.id, status: "withdrawn" });
    expect(after?.decidedAt).not.toBeNull();
    if (after === undefined) throw new Error("gone");
    expect(proposalWords(after, "sent", NOW_MS).status).toBe("Withdrawn");
    expect(whyCannotWithdraw(after)).toBe("It is already withdrawn, so there is nothing to take back.");
    // A second withdrawal is refused by the rules, in a sentence about proposals.
    await expect(withdrawCloudProposal(mine.id)).rejects.toThrow("only the member who sent it can withdraw it, while it is open");

    // Horizon's review list shows it withdrawn, and Review says why it cannot open.
    signInAs(world.owner);
    await settled();
    await refreshProposals();
    const [received] = proposalsOfShare(getProposals().received, shareId);
    expect(received).toMatchObject({ status: "withdrawn", sentByMe: false });
    if (received === undefined) throw new Error("nothing received");
    expect(proposalWords(received, "received", NOW_MS).status).toBe("Withdrawn");
    expect(reviewBlockedReason({ proposal: received, editorBlocked: null, openAutoId: share.shareId, share: { autoId: share.shareId }, autoLabel: "x" })).toBe(
      "Team 12345 (unverified) withdrew it, so there is nothing to review.",
    );
    // Nor can the sharing team withdraw, accept or reject it now.
    await expect(createCloudProposalsApi(world.owner.backend).decide(received.id, "accepted")).rejects.toThrow("The cloud refused that.");
  });

  it("waits in the Outbox when withdrawn offline, and reaches Horizon once the connection comes back", async () => {
    const { world, partner, shareId } = await shared();
    signInAs(partner);
    await settled();
    const { share, proposal } = await propose(partner, "Offline withdrawal.");
    const choice = sendSinkFor(share, sessionOf(partner));
    if (!choice.ok) throw new Error(choice.why);
    await choice.sink.send(proposal, "x.proposal.json");
    const [mine] = getProposals().sent;
    if (mine === undefined) throw new Error("nothing sent");

    await partner.backend.setOnline(false);
    const withdrawn = await withdrawCloudProposal(mine.id);
    expect(withdrawn.queued).toBe(true);
    expect(withdrawnSentence(mine, withdrawn.queued)).toBe(
      "Withdrawn on this computer. Team 36596 (unverified) sees it withdrawn when this computer is back online.",
    );
    expect(partner.backend.outbox().entries.map((entry) => [entry.kind, entry.state])).toEqual(
      expect.arrayContaining([["proposal", "queued"]]),
    );
    const beforeSync = await createCloudProposalsApi(world.owner.backend).list(world.owner.teamId, "received");
    expect(beforeSync.map((entry) => entry.status)).toEqual(["open"]);

    await partner.backend.setOnline(true);
    await settled();
    const received = await createCloudProposalsApi(world.owner.backend).list(world.owner.teamId, "received");
    expect(received.map((entry) => [entry.shareId, entry.status])).toEqual([[shareId, "withdrawn"]]);
  });

  it("is refused by the rules for a view-level share, in a sentence", async () => {
    const { partner } = await shared("view");
    signInAs(partner);
    await settled();
    const [received] = await createCloudSharingApi(partner.backend, { now: () => NOW_MS }).listReceived(partner.teamId);
    if (received === undefined) throw new Error("nothing received");
    expect(sendSinkFor(partnerShareOf(received), sessionOf(partner)).ok).toBe(false);
    await expect(
      createCloudProposalsApi(partner.backend).send({
        shareId: received.id,
        fromTeamId: partner.teamId,
        baseRevisionId: received.revisionId,
        text: "{}",
      }),
    ).rejects.toThrow("view only");
  });
});

describe("a refused proposal call", () => {
  it("keeps the client's own sentence, and tells a refusal by the rules in terms of proposals", () => {
    expect(proposalErrorSentence(new CloudError("permission-denied", "That share is view only, so it does not take proposals."))).toBe(
      "That share is view only, so it does not take proposals.",
    );
    expect(proposalErrorSentence(new CloudError("permission-denied", RULES_REFUSED))).toContain(
      "A proposal is taken only from an editor of a team the share was made to",
    );
  });
});

describe("the received-proposals model", () => {
  const proposal = (patch: Partial<CloudProposal>): CloudProposal => ({
    id: "p1",
    shareId: "s1",
    autoId: "a1",
    ownerTeamId: "t-owner",
    ownerTeam: "Team 36596",
    fromTeamId: "t-from",
    fromTeam: "Team 12345",
    baseRevisionId: "000002-x",
    revision: 2,
    status: "open",
    createdAt: "2026-09-27T11:55:00.000Z",
    decidedAt: null,
    sentByMe: true,
    text: "{}",
    ...patch,
  });

  it("groups by share, newest first, and counts those still open", () => {
    const list = [
      proposal({ id: "old", createdAt: "2026-09-26T12:00:00.000Z", status: "accepted" }),
      proposal({ id: "new" }),
      proposal({ id: "other", shareId: "s2" }),
    ];
    expect(proposalsOfShare(list, "s1").map((entry) => entry.id)).toEqual(["new", "old"]);
    expect(openCount(proposalsOfShare(list, "s1"))).toBe(1);
  });

  it("says who, when and against which revision, from either side", () => {
    expect(proposalWords(proposal({}), "received", NOW_MS)).toEqual({
      status: "Open",
      who: "From team 12345",
      when: "sent 5 minutes ago",
      against: "against revision 2",
      changes: null,
    });
    expect(
      proposalWords(proposal({ status: "rejected", decidedAt: "2026-09-27T09:00:00.000Z" }), "sent", NOW_MS),
    ).toEqual({ status: "Rejected", who: "To team 36596", when: "rejected 3 hours ago", against: "against revision 2", changes: null });
    expect(proposalWords(proposal({ status: "withdrawn", decidedAt: "2026-09-27T12:00:00.000Z" }), "sent", NOW_MS).status).toBe("Withdrawn");
  });

  it("counts a proposal's changes, so two sent alike read differently", () => {
    const two = JSON.stringify({ kind: "proposal", changes: [{ op: "a" }, { op: "b" }] });
    const one = JSON.stringify({ kind: "proposal", changes: [{ op: "a" }] });
    expect(proposalWords(proposal({ text: two }), "sent", NOW_MS).changes).toBe("2 changes");
    expect(proposalWords(proposal({ text: one }), "received", NOW_MS).changes).toBe("1 change");
    expect(proposalWords(proposal({ text: JSON.stringify({ changes: [] }) }), "sent", NOW_MS).changes).toBe("0 changes");
    expect(proposalChangeCount("{not json")).toBeNull();
    expect(proposalChangeCount("[]")).toBeNull();
    expect(proposalChangeCount('{"changes":3}')).toBeNull();
  });

  it("offers Withdraw only on an open proposal, and only to the member who sent it", () => {
    expect(whyCannotWithdraw(proposal({}))).toBeNull();
    expect(whyCannotWithdraw(proposal({ sentByMe: false }))).toBe("Only the member of your team who sent it can withdraw it.");
    expect(whyCannotWithdraw(proposal({ status: "accepted" }))).toBe("It is already accepted, so there is nothing to take back.");
    expect(whyCannotWithdraw(proposal({ status: "rejected", sentByMe: false }))).toBe("It is already rejected, so there is nothing to take back.");
    expect(withdrawConfirmSentence(proposal({}))).toBe(
      "Withdraw this proposal? Team 36596 can then no longer accept it. This cannot be undone.",
    );
    expect(withdrawnSentence(proposal({}), false)).toBe("Withdrew the proposal. Team 36596 now sees it as withdrawn.");
    expect(withdrawnSentence(proposal({}), true)).toBe("Withdrawn on this computer. Team 36596 sees it withdrawn when this computer is back online.");
  });

  it("reads a share as live, revoked or ended", () => {
    expect(shareStatusOf({ revokedAt: null, expiresAt: "2026-10-01T00:00:00.000Z" }, NOW_MS)).toBe("live");
    expect(shareStatusOf({ revokedAt: "2026-09-27T00:00:00.000Z", expiresAt: "2026-10-01T00:00:00.000Z" }, NOW_MS)).toBe("revoked");
    expect(shareStatusOf({ revokedAt: null, expiresAt: "2026-09-26T00:00:00.000Z" }, NOW_MS)).toBe("expired");
  });

  it("opens a review only with the share's own auto open", () => {
    const share = { autoId: "a1" };
    expect(reviewBlockedReason({ editorBlocked: null, openAutoId: "a1", share, autoLabel: "x" })).toBeNull();
    expect(reviewBlockedReason({ editorBlocked: null, openAutoId: "a2", share, autoLabel: "collect-and-score.auto.json" })).toBe(
      "Open collect-and-score.auto.json first: the proposal is reviewed against it.",
    );
    expect(reviewBlockedReason({ editorBlocked: "Open an auto.", openAutoId: null, share, autoLabel: "x" })).toBe("Open an auto.");
    // A withdrawn proposal says so before anything else; an open or decided one reads as before.
    expect(reviewBlockedReason({ proposal: proposal({ status: "withdrawn" }), editorBlocked: "Open an auto.", openAutoId: null, share, autoLabel: "x" })).toBe(
      "Team 12345 withdrew it, so there is nothing to review.",
    );
    expect(reviewBlockedReason({ proposal: proposal({ status: "accepted" }), editorBlocked: null, openAutoId: "a1", share, autoLabel: "x" })).toBeNull();
  });

  it("reads a revision with its own robot and field, or the open project's, and says when it has neither", () => {
    const own = pinnedFromRevision(FILES, null, 1);
    expect(own.ok).toBe(true);
    const bare = pinnedFromRevision({ content: CONTENT }, null, 4);
    expect(bare).toEqual({ ok: false, reason: expect.stringContaining("Revision 4 was published without robot.json") });
    const fallback = pinnedFromRevision({ content: CONTENT }, { robot: project.robot, field: project.field, waypoints: project.waypoints }, 4);
    expect(fallback.ok).toBe(true);
  });
});
