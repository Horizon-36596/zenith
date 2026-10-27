import { describe, expect, it } from "vitest";
import { isCloudError } from "../src/errors.js";
import { randomId, revisionId, revisionNumber, type RandomBytes } from "../src/ids.js";
import { MemoryBackend } from "../src/memory/memoryBackend.js";
import { MemoryDatabase } from "../src/memory/memoryStore.js";
import { SIGNED_OUT_NOTE } from "../src/outbox.js";
import { SERVER_TIME } from "../src/store.js";

/** A deterministic byte source, so ids in these tests are stable. */
function counterBytes(): RandomBytes {
  let next = 0;
  return (length) => Uint8Array.from({ length }, () => (next++ * 37) & 255);
}

async function signedIn(database: MemoryDatabase, uid: string): Promise<MemoryBackend> {
  const backend = new MemoryBackend({ database });
  backend.signInAs(uid);
  await (await backend.saveProfile({ displayName: uid })).sent;
  return backend;
}

describe("ids", () => {
  it("writes 128 random bits as 22 base64url characters", () => {
    const id = randomId(counterBytes());
    expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(randomId(counterBytes())).toBe(id);
  });

  it("puts the revision number first, zero-padded, so ids sort by number", () => {
    const id = revisionId(42, counterBytes());
    expect(id).toMatch(/^000042-[A-Za-z0-9_-]{11}$/);
    expect(revisionNumber(id)).toBe(42);
    expect(() => revisionId(0, counterBytes())).toThrow(/1 to 999999/);
  });
});

describe("MemoryBackend session", () => {
  it("signs in with each provider and with an email link", async () => {
    const backend = new MemoryBackend();
    const seen: (string | null)[] = [];
    backend.onAuthChange((user) => seen.push(user?.uid ?? null));
    expect((await backend.signInWithProvider("microsoft")).providerIds).toEqual(["microsoft.com"]);
    await backend.signOut();

    await backend.sendSignInLink("coach@example.org", "https://example.org/zenith/app/");
    const link = backend.lastSignInLink ?? "";
    expect(backend.isSignInLink(link)).toBe(true);
    await expect(backend.completeSignInLink("someone@example.org", link)).rejects.toThrow(/not for this email/);
    const user = await backend.completeSignInLink("coach@example.org", link);
    expect(user).toMatchObject({ email: "coach@example.org", providerIds: ["emailLink"] });
    expect(seen).toEqual([null, "memory-microsoft-user", null, user.uid]);
  });

  it("refuses data calls when nobody is signed in, with a sentence", async () => {
    const backend = new MemoryBackend();
    await expect(backend.listMyTeams()).rejects.toSatisfy((e: unknown) => isCloudError(e, "signed-out"));
  });

  it("clears the offline cache on sign-out", async () => {
    const database = new MemoryDatabase();
    const alice = await signedIn(database, "alice");
    const team = await alice.createTeam({ number: null, name: "Horizon" });
    await team.sent;
    const auto = await alice.createAuto(team.value.id, { title: "Close side" });
    await auto.sent;
    await alice.saveForOffline(team.value.id);
    await alice.setOnline(false);
    expect((await alice.listAutos(team.value.id)).length).toBe(1);

    await alice.signOut();
    alice.signInAs("alice");
    expect(await alice.listAutos(team.value.id)).toEqual([]);
    await expect(alice.getProfile()).rejects.toSatisfy((e: unknown) => isCloudError(e, "unavailable"));
  });
});

describe("MemoryBackend outbox", () => {
  it("lists writes made offline as queued, then sent in order", async () => {
    const database = new MemoryDatabase();
    const alice = await signedIn(database, "alice");
    const team = await alice.createTeam({ number: null, name: "Horizon" });
    await team.sent;
    const statuses: number[] = [];
    alice.onOutboxChange((status) => statuses.push(status.queued));

    await alice.setOnline(false);
    const first = await alice.createAuto(team.value.id, { title: "One" });
    const second = await alice.createAuto(team.value.id, { title: "Two" });
    expect(alice.outbox()).toMatchObject({ online: false, queued: 2, failed: 0 });
    expect(database.peek(`teams/${team.value.id}/autos/${first.value.id}`)).toBe(null);

    await alice.setOnline(true);
    await Promise.all([first.sent, second.sent]);
    expect(alice.outbox()).toMatchObject({ online: true, queued: 0, failed: 0 });
    // Stored sealed (spec 14 section 4.9); the client opens it.
    expect(database.peek(`teams/${team.value.id}/autos/${second.value.id}`)).toMatchObject({ title: { v: 1, alg: "A256GCM", kv: 1 } });
    expect((await alice.listAutos(team.value.id)).map((a) => a.title)).toEqual(["One", "Two"]);
    expect(statuses).toContain(2);
  });

  it("marks a write the server refuses as failed, with the reason", async () => {
    const database = new MemoryDatabase();
    const alice = await signedIn(database, "alice");
    const team = await alice.createTeam({ number: null, name: "Horizon" });
    await team.sent;
    const eve = await signedIn(database, "eve");
    const attempt = await eve.renameTeam(team.value.id, "Not mine");
    await expect(attempt.sent).rejects.toSatisfy((e: unknown) => isCloudError(e, "permission-denied"));
    const entry = eve.outbox().entries.find((e) => e.id === attempt.outboxId);
    expect(entry).toMatchObject({ state: "failed", kind: "team" });
    expect(entry?.error).toBe("The cloud refused that. Your role in the team may not allow it.");
  });

  it("marks writes still queued at sign-out as dropped, not refused (issue #319)", async () => {
    const database = new MemoryDatabase();
    const alice = await signedIn(database, "alice");
    const team = await alice.createTeam({ number: null, name: "Horizon" });
    await team.sent;
    await alice.setOnline(false);
    const first = await alice.createAuto(team.value.id, { title: "One" });
    const second = await alice.createAuto(team.value.id, { title: "Two" });
    await alice.signOut();
    await expect(first.sent).rejects.toSatisfy((e: unknown) => isCloudError(e, "signed-out"));
    await expect(second.sent).rejects.toSatisfy((e: unknown) => isCloudError(e, "signed-out"));
    expect(alice.outbox()).toMatchObject({ queued: 0, failed: 0, dropped: 2 });
    for (const id of [first.outboxId, second.outboxId]) {
      expect(alice.outbox().entries.find((e) => e.id === id)).toMatchObject({ state: "dropped", error: SIGNED_OUT_NOTE });
    }
    await alice.setOnline(true);
    expect(database.peek(`teams/${team.value.id}/autos/${first.value.id}`)).toBe(null);
  });
});

describe("MemoryBackend account", () => {
  it("exports the profile and memberships, and refuses to delete an owner's account", async () => {
    const database = new MemoryDatabase();
    const alice = await signedIn(database, "alice");
    const team = await alice.createTeam({ number: null, name: "Horizon" });
    await team.sent;
    const exported = await alice.exportMyData();
    expect(exported.profile?.displayName).toBe("alice");
    expect(exported.memberships.map((m) => [m.teamId, m.role])).toEqual([[team.value.id, "owner"]]);
    await expect(alice.deleteAccount()).rejects.toThrow(/Make another member an owner/);
  });

  it("exports what the user wrote in their teams, and says what the rules keep out", async () => {
    const database = new MemoryDatabase();
    database.seed("admins/hana", { name: "Reviewer" });
    const alice = await signedIn(database, "alice");
    const team = await alice.createTeam({ number: 36596, name: "Horizon" });
    await team.sent;
    const teamId = team.value.id;
    const invite = await alice.createInvite(teamId, { role: "editor", autoApprove: true });
    await invite.sent;
    const eve = await signedIn(database, "eve");
    await (await eve.redeemInvite(invite.value.code)).sent;
    const waiting = await eve.teamKeyStatus(teamId);
    if (waiting.state !== "waiting") throw new Error("Eve's device should be waiting for the key.");
    await (await alice.grantDeviceKey(teamId, waiting.device.deviceId, waiting.approvalCode)).sent;
    const olga = await signedIn(database, "olga");
    const partner = await olga.createTeam({ number: null, name: "Partner" });
    await partner.sent;
    const partnerId = partner.value.id;

    // Eve, an editor: an auto, a revision, a view share, and nothing in the activity log she can read.
    const auto = await eve.createAuto(teamId, { title: "Close side" });
    await auto.sent;
    const revision = await eve.publishRevision({ teamId, autoId: auto.value.id, baseRevision: null, content: '{"v":1}' });
    await revision.sent;
    const share = await eve.createShare({
      teamId, autoId: auto.value.id, revision: revision.value.id, audience: "teams", teamIds: [partnerId], projection: '{"kind":"projection"}',
    });
    await share.sent;
    // Alice, the owner: a propose share Olga answers, and a request for verification.
    const propose = await alice.createShare({
      teamId, autoId: auto.value.id, revision: revision.value.id, audience: "teams", teamIds: [partnerId], level: "propose",
      projection: '{"kind":"projection"}',
    });
    await propose.sent;
    await (await olga.sendProposal({ shareId: propose.value.id, fromTeamId: partnerId, baseRevision: revision.value.id, diff: "[1]" })).sent;
    // Olga claims 36596 too, adds evidence, wins; Alice appeals.
    const claimed = await olga.claimNumber(partnerId, 36596);
    await claimed.sent;
    const disputeId = claimed.value.outcome === "contested" ? claimed.value.dispute.id : "";
    await (await olga.addDisputeEvidence(disputeId, { team: partnerId, kind: "statement", summary: "Registered to us." })).sent;
    const hana = new MemoryBackend({ database });
    hana.signInAs("hana");
    await (await hana.decideDispute(disputeId, { winner: partnerId, reason: "The registration names Partner." })).sent;
    await (await alice.appealDispute(disputeId, { team: teamId, reason: "Our banner shows the number." })).sent;

    const eveData = await eve.exportMyData();
    expect(eveData.uid).toBe("eve");
    expect(eveData.memberships.map((m) => m.role)).toEqual(["editor"]);
    expect(eveData.revisions.map((r) => [r.id, r.content])).toEqual([[revision.value.id, '{"v":1}']]);
    expect(eveData.shares.map((x) => x.id)).toEqual([share.value.id]);
    expect(eveData.activity).toEqual([]);
    expect(eveData.notIncluded.join(" ")).toMatch(/activity log of a team where you are an editor or viewer/);

    const aliceData = await alice.exportMyData();
    expect(aliceData.shares.map((x) => x.id)).toEqual([propose.value.id]);
    expect(aliceData.revisions).toEqual([]);
    expect(aliceData.activity.map((a) => a.kind)).toEqual(expect.arrayContaining(["team.create", "invite.create", "share.create", "dispute.appeal"]));
    expect(aliceData.activity.every((a) => a.by === "alice" && a.teamId === teamId)).toBe(true);
    expect(aliceData.appeals).toMatchObject([{ disputeId, teamNumber: 36596, reason: "Our banner shows the number." }]);
    expect(aliceData.claimHistory.map((e) => e.kind)).toEqual(["claim", "appeal"]);
    expect(aliceData.notIncluded.join(" ")).not.toMatch(/editor or viewer/);

    const olgaData = await olga.exportMyData();
    expect(olgaData.proposals.map((p) => p.diff)).toEqual(["[1]"]);
    expect(olgaData.disputesOpened).toMatchObject([{ id: disputeId, teamNumber: 36596 }]);
    expect(olgaData.disputeEvidence).toMatchObject([{ disputeId, summary: "Registered to us." }]);
    expect(olgaData.claimHistory.map((e) => e.kind)).toEqual(["contest"]);
    // Nothing of Alice's is in Olga's export, although they share a dispute.
    expect(JSON.stringify(olgaData)).not.toContain("Our banner shows the number.");
  });

  it("exports a verification request with its evidence", async () => {
    const database = new MemoryDatabase();
    const alice = await signedIn(database, "alice");
    const team = await alice.createTeam({ number: 36596, name: "Horizon" });
    await team.sent;
    await (await alice.requestVerification(team.value.id, [{ kind: "statement", summary: "We are 36596." }])).sent;
    const data = await alice.exportMyData();
    expect(data.verificationRequests).toMatchObject([{ teamNumber: 36596, evidence: [{ summary: "We are 36596." }] }]);
    expect(data.claimHistory.map((e) => e.kind)).toEqual(["claim", "request"]);
  });

  it("deletes a member's account: memberships, then profile, then sign-in", async () => {
    const database = new MemoryDatabase();
    const alice = await signedIn(database, "alice");
    const team = await alice.createTeam({ number: null, name: "Horizon" });
    await team.sent;
    const invite = await alice.createInvite(team.value.id, { role: "viewer", autoApprove: true });
    await invite.sent;
    const vic = await signedIn(database, "vic");
    await (await vic.redeemInvite(invite.value.code)).sent;
    await vic.deleteAccount();
    expect(vic.currentUser()).toBe(null);
    expect(database.peek("users/vic")).toBe(null);
    expect(database.peek(`teams/${team.value.id}/members/vic`)).toBe(null);
  });

  it("asks a stale sign-in to sign in again before deleting anything, and deletes nothing if it does not", async () => {
    const database = new MemoryDatabase();
    const alice = await signedIn(database, "alice");
    const team = await alice.createTeam({ number: null, name: "Horizon" });
    await team.sent;
    const invite = await alice.createInvite(team.value.id, { role: "viewer", autoApprove: true });
    await invite.sent;
    const vic = await signedIn(database, "vic");
    await (await vic.redeemInvite(invite.value.code)).sent;

    vic.setSignInStale();
    vic.reauthentication = "cancelled";
    await expect(vic.deleteAccount()).rejects.toSatisfy(
      (e: unknown) => isCloudError(e, "reauth-required") && /Nothing was deleted/.test((e as Error).message),
    );
    expect(vic.reauthentications).toBe(1);
    expect(vic.currentUser()?.uid).toBe("vic");
    expect(database.peek("users/vic")).not.toBe(null);
    expect(database.peek(`teams/${team.value.id}/members/vic`)).not.toBe(null);

    vic.reauthentication = "finishes";
    await vic.deleteAccount();
    expect(vic.reauthentications).toBe(2);
    expect(vic.currentUser()).toBe(null);
    expect(database.peek("users/vic")).toBe(null);
    expect(database.peek(`teams/${team.value.id}/members/vic`)).toBe(null);
  });

  it("does not ask a recent sign-in to sign in again, and refuses to start offline", async () => {
    const database = new MemoryDatabase();
    const vic = await signedIn(database, "vic");
    await vic.setOnline(false);
    await expect(vic.deleteAccount()).rejects.toSatisfy((e: unknown) => isCloudError(e, "unavailable"));
    expect(vic.currentUser()?.uid).toBe("vic");
    await vic.setOnline(true);
    await vic.deleteAccount();
    expect(vic.reauthentications).toBe(0);
    expect(database.peek("users/vic")).toBe(null);
  });

  it("deletes a team with everything the owner may delete", async () => {
    const database = new MemoryDatabase();
    const alice = await signedIn(database, "alice");
    const team = await alice.createTeam({ number: 36596, name: "Horizon" });
    await team.sent;
    await (await alice.deleteTeam(team.value.id)).sent;
    expect(database.peek(`teams/${team.value.id}`)).toBe(null);
    expect(database.peek("claims/36596")).toBe(null);
    expect(database.peek("claims/36596/history/0")).toBe(null);
    expect(await alice.listMyTeams()).toEqual([]);
  });

  it("revokes a deleted team's shares in writes sent before the delete, offline too", async () => {
    const database = new MemoryDatabase();
    const alice = await signedIn(database, "alice");
    const team = await alice.createTeam({ number: null, name: "Horizon" });
    await team.sent;
    const teamId = team.value.id;
    const auto = await alice.createAuto(teamId, { title: "Close side" });
    const revision = await alice.publishRevision({ teamId, autoId: auto.value.id, baseRevision: null, content: '{"v":1}' });
    await revision.sent;
    const share = await alice.createShare({ teamId, autoId: auto.value.id, revision: revision.value.id, audience: "link", projection: "{}" });
    await share.sent;

    await alice.setOnline(false);
    const deleted = await alice.deleteTeam(teamId);
    const summaries = alice.outbox().entries.filter((e) => e.state === "queued").map((e) => e.summary);
    expect(summaries).toEqual(["Revoke 1 share of team Horizon before deleting it.", "Delete team Horizon."]);
    expect(database.peek(`shares/${share.value.id}`)).toMatchObject({ revokedAt: null });
    await alice.setOnline(true);
    await deleted.sent;
    const stored = database.peek(`shares/${share.value.id}`);
    expect(stored?.revokedAt).toBeInstanceOf(Date);
    expect(stored?.updatedAt).toEqual(stored?.revokedAt);
    expect(database.peek(`teams/${teamId}`)).toBe(null);
    expect(await new MemoryBackend({ database }).getShare(share.value.id)).toBe(null);
  });

  it("refuses a team admin who is not an owner before revoking anything", async () => {
    const database = new MemoryDatabase();
    const alice = await signedIn(database, "alice");
    const team = await alice.createTeam({ number: null, name: "Horizon" });
    await team.sent;
    const teamId = team.value.id;
    const auto = await alice.createAuto(teamId, { title: "Close side" });
    const revision = await alice.publishRevision({ teamId, autoId: auto.value.id, baseRevision: null, content: '{"v":1}' });
    await revision.sent;
    const share = await alice.createShare({ teamId, autoId: auto.value.id, revision: revision.value.id, audience: "link", projection: "{}" });
    await share.sent;
    const invite = await alice.createInvite(teamId, { role: "editor", autoApprove: true });
    await invite.sent;
    const adam = await signedIn(database, "adam");
    await (await adam.redeemInvite(invite.value.code)).sent;
    await (await alice.setRole(teamId, "adam", "admin")).sent;

    await expect(adam.deleteTeam(teamId)).rejects.toThrow("Only an owner of the team can delete it.");
    expect(database.peek(`shares/${share.value.id}`)).toMatchObject({ revokedAt: null });
    expect(database.peek(`teams/${teamId}`)).not.toBe(null);
  });

  it("deletes a team with no shares in one write, as before", async () => {
    const database = new MemoryDatabase();
    const alice = await signedIn(database, "alice");
    const team = await alice.createTeam({ number: null, name: "Horizon" });
    await team.sent;
    const before = alice.outbox().entries.length;
    await (await alice.deleteTeam(team.value.id)).sent;
    expect(alice.outbox().entries.slice(before).map((e) => e.summary)).toEqual(["Delete team Horizon."]);
  });

  it("deletes a team but keeps the claim on its number, held by nobody, once the claim has history", async () => {
    const database = new MemoryDatabase();
    const alice = await signedIn(database, "alice");
    const team = await alice.createTeam({ number: 36596, name: "Horizon" });
    await team.sent;
    await (await alice.requestVerification(team.value.id, [{ kind: "statement", summary: "We are 36596." }])).sent;
    await (await alice.deleteTeam(team.value.id)).sent;
    expect(database.peek(`teams/${team.value.id}`)).toBe(null);
    expect(database.peek("claims/36596")).toMatchObject({ teamId: null, status: "unverified", historyCount: 3 });
    expect(database.peek("claims/36596/history/1")).toMatchObject({ kind: "request" });
    expect(database.peek("claims/36596/history/2")).toMatchObject({ kind: "release", teamId: team.value.id });
    // Its request is still open for a reviewer to close, so nobody claims the number until then.
    const nina = await signedIn(database, "nina");
    await expect(nina.createTeam({ number: 36596, name: "New holder" })).rejects.toThrow(/Horizon admin/);
  });

  it("deletes a team too large for one write in several, the tombstone first and the team last", async () => {
    const database = new MemoryDatabase();
    const alice = await signedIn(database, "alice");
    const team = await alice.createTeam({ number: null, name: "Horizon" });
    await team.sent;
    const teamId = team.value.id;
    for (let i = 0; i < 450; i += 1) {
      database.seed(`teams/${teamId}/activity/bulk${String(i).padStart(3, "0")}`, { at: new Date(), by: "alice", kind: "auto.create" });
    }
    const before = alice.outbox().entries.length;
    await (await alice.deleteTeam(teamId)).sent;
    expect(alice.outbox().entries.slice(before).map((e) => e.summary)).toEqual([
      "Delete team Horizon, part 1 of 2.",
      "Delete team Horizon, part 2 of 2.",
    ]);
    expect(database.peek(`deletedTeams/${teamId}`)).toMatchObject({ deletedBy: "alice" });
    expect(database.peek(`teams/${teamId}/activity/bulk449`)).toBe(null);
    expect(database.peek(`teams/${teamId}`)).toBe(null);
  });

  it("purges a deleted team offline too, sending every write in order on reconnecting", async () => {
    const database = new MemoryDatabase();
    const alice = await signedIn(database, "alice");
    const team = await alice.createTeam({ number: null, name: "Horizon" });
    await team.sent;
    const teamId = team.value.id;
    const auto = await alice.createAuto(teamId, { title: "Close side" });
    const revision = await alice.publishRevision({ teamId, autoId: auto.value.id, baseRevision: null, content: '{"v":1}' });
    await revision.sent;
    const invite = await alice.createInvite(teamId, { role: "viewer" });
    await invite.sent;
    await alice.listRevisions(teamId, auto.value.id);
    await alice.listActivity(teamId);

    await alice.setOnline(false);
    const deleted = await alice.deleteTeam(teamId);
    expect(database.peek(`teams/${teamId}/autos/${auto.value.id}/revisions/${revision.value.id}`)).not.toBe(null);
    await alice.setOnline(true);
    await deleted.sent;
    expect(database.peek(`teams/${teamId}/autos/${auto.value.id}/revisions/${revision.value.id}`)).toBe(null);
    expect(database.peek(`invites/${invite.value.code}`)).toBe(null);
    expect(database.peek(`teams/${teamId}`)).toBe(null);
  });
});

describe("the fake cloud's private beta", () => {
  it("is open by default, so the fake cloud needs no beta setup", async () => {
    const database = new MemoryDatabase();
    expect(database.peek("config/access")).toEqual({ betaOpen: true });
    const stan = new MemoryBackend({ database });
    stan.signInAs("stan");
    expect(await stan.hasBetaAccess()).toBe(true);
    await (await stan.saveProfile({ displayName: "stan" })).sent;
    expect(database.peek("users/stan")).not.toBe(null);
    // A backend made without a database makes its own, open as well.
    const alone = new MemoryBackend();
    alone.signInAs("solo");
    expect(await alone.hasBetaAccess()).toBe(true);
  });

  it("is closed with betaGate: \"closed\" until a tester is named or the switch is set", async () => {
    const database = new MemoryDatabase({ betaGate: "closed" });
    expect(database.peek("config/access")).toBe(null);
    const stan = new MemoryBackend({ database });
    stan.signInAs("stan");
    expect(await stan.hasBetaAccess()).toBe(false);
    const refused = await (await stan.saveProfile({ displayName: "stan" })).sent.then(
      () => "allowed",
      (error: unknown) => (isCloudError(error) ? error.code : "other"),
    );
    expect(refused).toBe("permission-denied");
    database.seed("betaTesters/stan", { name: "Stan" });
    expect(await stan.hasBetaAccess()).toBe(true);
    await (await stan.saveProfile({ displayName: "stan" })).sent;
    expect(database.peek("users/stan")).not.toBe(null);
    const nina = new MemoryBackend({ database });
    nina.signInAs("nina");
    expect(await nina.hasBetaAccess()).toBe(false);
    database.seed("config/access", { betaOpen: true });
    expect(await nina.hasBetaAccess()).toBe(true);
    // Signed out, nobody has access.
    expect(await new MemoryBackend({ database }).hasBetaAccess()).toBe(false);
  });
});
