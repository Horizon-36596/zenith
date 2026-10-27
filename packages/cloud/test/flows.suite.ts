/**
 * The cloud client end to end, through `CloudBackend`, written once and run against `MemoryBackend`
 * (memory.flows.test.ts) and against the real rules in the Firestore emulator with the real SDK
 * (emulator.flows.test.ts), including its offline queue.
 *
 * Contracts from spec 13 section 16:
 * - M-C1: an expired or revoked invite never adds anyone; a pending, removed or outside user reads
 *   nothing of the library.
 * - M-C2: publish offline, reconnect, and the revision arrives once, in order; two publishes from one
 *   base produce a diverged pair and overwrite nothing; a saved library opens with the network off.
 * - M-C7: only `admins/{uid}` can set a status; a second claim on a verified number is refused; on an
 *   unverified one both become contested; one Horizon admin alone decides everything, an appeal of
 *   their own decision included (owner ruling 2026-10-01).
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { CloudBackend } from "../src/backend.js";
import { isCloudError } from "../src/errors.js";
import type { DocData } from "../src/store.js";

export type FlowUser = CloudBackend & { setOnline(online: boolean): Promise<void> };

export interface FlowHarness {
  /** Empties the database, then writes these documents without the rules. */
  reset(docs: Record<string, DocData>): Promise<void>;
  /** A signed-in client for `uid`, on its own device; `email` is the sign-in account's, none by default. */
  user(uid: string, options?: { email?: string }): Promise<FlowUser>;
  /** A client nobody is signed in to. */
  anonymous(): Promise<CloudBackend>;
  peek(path: string): Promise<DocData | null>;
}

const DAY_MS = 24 * 60 * 60 * 1000;

async function refused(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (isCloudError(error)) return error.code;
    throw error;
  }
  return "allowed";
}

/**
 * The harness with every reset opening the private beta first, as the owner's console does with
 * config/access; a real project starts closed. A case's own config/access wins, and the cases about
 * the closed beta reset through the harness itself.
 */
function withOpenBeta(raw: FlowHarness): FlowHarness {
  return {
    reset: (docs) => raw.reset({ "config/access": { betaOpen: true }, ...docs }),
    user: (uid, options) => raw.user(uid, options),
    anonymous: () => raw.anonymous(),
    peek: (path) => raw.peek(path),
  };
}

export function defineFlowSuite(label: string, harness: () => FlowHarness): void {
  describe(`cloud client flows (${label})`, () => {
    /** The harness as given, whose reset writes exactly the documents it is handed. */
    let raw: FlowHarness;
    let h: FlowHarness;

    /** A user with a saved profile. */
    const person = async (uid: string): Promise<FlowUser> => {
      const user = await h.user(uid);
      await (await user.saveProfile({ displayName: uid })).sent;
      return user;
    };

    /** The device and the approval code a waiting device shows, as its person reads them out. */
    const codeOf = async (user: FlowUser, teamId: string): Promise<{ deviceId: string; approvalCode: string }> => {
      const status = await user.teamKeyStatus(teamId);
      if (status.state !== "waiting") throw new Error("That device already holds the team key.");
      return { deviceId: status.device.deviceId, approvalCode: status.approvalCode };
    };

    /**
     * Gives the team key to each of `devices`, typing the code each one shows, as an owner does for a
     * new member (spec 14 section 4.3): joining by an invite that approves at once adds the member, but
     * their device gets the key only from a key holder.
     */
    const grantRequests = async (admin: FlowUser, teamId: string, ...devices: FlowUser[]): Promise<void> => {
      for (const device of devices) {
        const { deviceId, approvalCode } = await codeOf(device, teamId);
        await (await admin.grantDeviceKey(teamId, deviceId, approvalCode)).sent;
      }
    };

    /** Alice's team with one auto and its first revision, and Eve as its editor. */
    const library = async () => {
      const alice = await person("alice");
      const team = await alice.createTeam({ number: 36596, name: "Horizon" });
      await team.sent;
      const teamId = team.value.id;
      const auto = await alice.createAuto(teamId, { title: "Close side" });
      await auto.sent;
      const first = await alice.publishRevision({ teamId, autoId: auto.value.id, baseRevision: null, content: '{"v":1}' });
      await first.sent;
      const eve = await person("eve");
      const invite = await alice.createInvite(teamId, { role: "editor", autoApprove: true });
      await invite.sent;
      await (await eve.redeemInvite(invite.value.code)).sent;
      await grantRequests(alice, teamId, eve);
      return { alice, eve, teamId, autoId: auto.value.id, r1: first.value.id };
    };

    beforeEach(async () => {
      raw = harness();
      h = withOpenBeta(raw);
      // One Horizon admin: nothing a reviewer does needs a second one (owner ruling 2026-10-01).
      await h.reset({ "admins/hana": { name: "Horizon reviewer" } });
    });

    describe("teams and invites (M-C1)", () => {
      it("makes a team with its owner and its number's claim, and refuses the number to a second team", async () => {
        const alice = await person("alice");
        const team = await alice.createTeam({ number: 36596, name: "Horizon" });
        await team.sent;
        expect((await alice.getClaim(36596))?.teamId).toBe(team.value.id);
        expect((await alice.listMyTeams()).map((m) => [m.teamId, m.role])).toEqual([[team.value.id, "owner"]]);

        const nina = await person("nina");
        await expect(nina.createTeam({ number: 36596, name: "Copycat" })).rejects.toThrow(/already claimed/);
        const own = await nina.createTeam({ number: null, name: "Copycat" });
        await own.sent;
        expect((await h.peek("claims/36596"))?.teamId).toBe(team.value.id);
      });

      it("exports what each member wrote, through queries the rules allow (spec 13 section 12.3)", async () => {
        const { alice, eve, teamId, autoId, r1 } = await library();
        const second = await eve.publishRevision({ teamId, autoId, baseRevision: r1, content: '{"v":2}' });
        await second.sent;
        const olga = await person("olga");
        const partner = await olga.createTeam({ number: null, name: "Partner" });
        await partner.sent;
        const share = await eve.createShare({
          teamId, autoId, revision: second.value.id, audience: "teams", teamIds: [partner.value.id], projection: '{"kind":"projection"}',
        });
        await share.sent;
        await (await alice.requestVerification(teamId, [{ kind: "statement", summary: "We are 36596." }])).sent;

        const eveData = await eve.exportMyData();
        expect(eveData.revisions.map((r) => r.content)).toEqual(['{"v":2}']);
        expect(eveData.shares.map((x) => x.id)).toEqual([share.value.id]);
        expect(eveData.activity).toEqual([]);
        expect(eveData.verificationRequests).toEqual([]);
        const aliceData = await alice.exportMyData();
        expect(aliceData.revisions.map((r) => r.content)).toEqual(['{"v":1}']);
        expect(aliceData.shares).toEqual([]);
        expect(aliceData.activity.length).toBeGreaterThan(0);
        expect(aliceData.verificationRequests.map((r) => r.teamNumber)).toEqual([36596]);
        expect(aliceData.claimHistory.map((e) => e.kind)).toEqual(["claim", "request"]);
      });

      it("refuses a team to a user with no profile", async () => {
        const kid = await h.user("kid");
        expect(await refused(kid.createTeam({ number: null, name: "Young" }))).toBe("invalid");
        expect(await kid.getProfile()).toBe(null);
        expect(await h.peek("users/kid")).toBe(null);
      });

      it("saves a profile that holds the display name and when it was made, and nothing else", async () => {
        const ada = await h.user("ada");
        await (await ada.saveProfile({ displayName: "  Ada  " })).sent;
        const stored = await h.peek("users/ada");
        expect(Object.keys(stored ?? {}).sort()).toEqual(["createdAt", "displayName"]);
        expect(stored?.displayName).toBe("Ada");
        await expect(ada.saveProfile({ displayName: " " })).rejects.toThrow(/1 to 80 characters/);
      });

      it("adds an invited member as pending, who reads nothing until an admin approves", async () => {
        const { alice, teamId, autoId } = await library();
        const invite = await alice.createInvite(teamId, { role: "editor" });
        await invite.sent;
        const nina = await person("nina");
        const joined = await nina.redeemInvite(invite.value.code);
        await joined.sent;
        expect(joined.value.role).toBe("pending");
        expect(await refused(nina.listAutos(teamId))).toBe("permission-denied");
        expect(await refused(nina.listRevisions(teamId, autoId))).toBe("permission-denied");

        const pending = (await alice.listMembers(teamId)).find((m) => m.uid === "nina");
        expect(pending?.role).toBe("pending");
        await (await alice.approveMember(teamId, "nina", await codeOf(nina, teamId))).sent;
        expect((await nina.listAutos(teamId)).map((a) => a.id)).toEqual([autoId]);
        expect((await alice.listInvites(teamId)).find((i) => i.code === invite.value.code)?.uses).toBe(1);
      });

      it("never adds anyone with an expired, revoked or used-up invite", async () => {
        const { alice, teamId } = await library();
        const expired = await alice.createInvite(teamId, { role: "viewer", autoApprove: true });
        await expired.sent;
        await (await alice.extendInvite(expired.value.code, new Date(Date.now() - DAY_MS))).sent;
        const revoked = await alice.createInvite(teamId, { role: "viewer", autoApprove: true });
        await revoked.sent;
        await (await alice.revokeInvite(revoked.value.code)).sent;
        const single = await alice.createInvite(teamId, { role: "viewer", autoApprove: true, maxUses: 1 });
        await single.sent;
        await (await (await person("first")).redeemInvite(single.value.code)).sent;

        const nina = await person("nina");
        await expect(nina.redeemInvite(expired.value.code)).rejects.toThrow(/expired/);
        await expect(nina.redeemInvite(revoked.value.code)).rejects.toThrow(/withdrawn/);
        await expect(nina.redeemInvite(single.value.code)).rejects.toThrow(/used up/);
        expect(await h.peek(`teams/${teamId}/members/nina`)).toBe(null);
        expect((await nina.listMyTeams()).length).toBe(0);
      });

      it("deletes a team with its members, invites, settings, activity and library, and never reuses its id", async () => {
        const { alice, eve, teamId, autoId, r1 } = await library();
        const invite = await alice.createInvite(teamId, { role: "viewer", autoApprove: true });
        await invite.sent;
        await (await alice.updateTeamSettings(teamId, { publishOnSave: true })).sent;
        // A verified number, so the claim has history of its own.
        const request = await alice.requestVerification(teamId, [{ kind: "statement", summary: "We are 36596." }]);
        await request.sent;
        const hana = await h.user("hana");
        await (await hana.decideVerification(request.value.id, { verdict: "verified", reason: "Listed at an event as 36596." })).sent;

        await (await alice.deleteTeam(teamId)).sent;
        for (const path of [
          `teams/${teamId}`,
          `teams/${teamId}/members/alice`,
          `teams/${teamId}/members/eve`,
          `teams/${teamId}/settings/sharing`,
          `teams/${teamId}/autos/${autoId}`,
          `teams/${teamId}/autos/${autoId}/revisions/${r1}`,
          `invites/${invite.value.code}`,
        ]) {
          expect(await h.peek(path), path).toBe(null);
        }
        expect(await h.peek(`deletedTeams/${teamId}`)).toMatchObject({ deletedBy: "alice" });
        // The number's claim and its history stay, held by nobody, and no longer verified.
        expect(await h.peek("claims/36596")).toMatchObject({ teamId: null, status: "unverified", historyCount: 4 });
        expect(await h.peek("claims/36596/history/3")).toMatchObject({ kind: "release", teamId, by: "alice" });
        expect(await h.peek("claims/36596/history/2")).toMatchObject({ kind: "verify", teamId });
        expect(await eve.listMyTeams()).toEqual([]);
        await expect(eve.redeemInvite(invite.value.code)).rejects.toThrow(/does not exist/);

        // Another team claims the number afresh, unverified, and reads none of the old history.
        const nina = await person("nina");
        const fresh = await nina.createTeam({ number: 36596, name: "New holder" });
        await fresh.sent;
        expect(await nina.getClaim(36596, fresh.value.id)).toMatchObject({ teamId: fresh.value.id, status: "unverified", historyCount: 5 });
        expect((await nina.getClaim(36596, fresh.value.id))?.history.map((e) => e.kind)).toEqual(["claim"]);
      });

      it("takes the library away from a removed member at once", async () => {
        const { alice, eve, teamId } = await library();
        expect((await eve.listAutos(teamId)).length).toBe(1);
        await (await alice.removeMember(teamId, "eve")).sent;
        expect(await refused(eve.listAutos(teamId))).toBe("permission-denied");
        expect((await alice.listActivity(teamId)).some((e) => e.kind === "member.remove" && e.target === "eve")).toBe(true);
      });

      it("changes the team key in the same write when an owner changes who may approve devices, or makes someone an admin", async () => {
        const { alice, eve, teamId } = await library();
        expect((await eve.listAutos(teamId)).length).toBe(1);
        await (await alice.updateTeamSettings(teamId, { membersMayApproveDevices: true })).sent;
        await (await alice.setRole(teamId, "eve", "admin")).sent;
        await (await alice.updateTeamSettings(teamId, { membersMayApproveDevices: false })).sent;
        expect((await alice.listActivity(teamId)).filter((e) => e.kind === "key.rotate").length).toBe(3);
        expect((await alice.getTeamSettings(teamId)).membersMayApproveDevices).toBe(false);
        expect((await eve.listAutos(teamId)).length).toBe(1);
      });

      it("keeps the library from users of other teams", async () => {
        const { teamId, autoId, r1 } = await library();
        const olga = await person("olga");
        await (await olga.createTeam({ number: 12345, name: "Partner" })).sent;
        expect(await refused(olga.listAutos(teamId))).toBe("permission-denied");
        expect(await olga.openRevision(teamId, autoId, r1)).toBe(null);
        expect(await refused(olga.listMembers(teamId))).toBe("permission-denied");
      });
    });

    describe("team library and offline (M-C2)", () => {
      it("publishes offline, and after reconnecting each revision arrives once, in order", async () => {
        const { alice, eve, teamId, autoId, r1 } = await library();
        await eve.saveForOffline(teamId);
        await eve.setOnline(false);

        const second = await eve.publishRevision({ teamId, autoId, baseRevision: r1, content: '{"v":2}' });
        const third = await eve.publishRevision({ teamId, autoId, baseRevision: second.value.id, content: '{"v":3}' });
        expect(eve.outbox().queued).toBe(2);
        expect((await alice.listRevisions(teamId, autoId)).map((r) => r.n)).toEqual([1]);

        await eve.setOnline(true);
        await second.sent;
        await third.sent;
        const revisions = await alice.listRevisions(teamId, autoId);
        expect(revisions.map((r) => [r.n, r.content])).toEqual([[1, '{"v":1}'], [2, '{"v":2}'], [3, '{"v":3}']]);
        expect(revisions[2]?.baseRevision).toBe(revisions[1]?.id);
        expect(revisions.every((r) => !r.diverged)).toBe(true);
        expect(eve.outbox().entries.filter((e) => e.kind === "publish").map((e) => e.state)).toEqual(["sent", "sent"]);
      });

      it("keeps both revisions when two members publish from one base, and marks the second diverged", async () => {
        const { alice, eve, teamId, autoId, r1 } = await library();
        const fromAlice = await alice.publishRevision({ teamId, autoId, baseRevision: r1, content: '{"by":"alice"}' });
        await fromAlice.sent;
        const fromEve = await eve.publishRevision({ teamId, autoId, baseRevision: r1, content: '{"by":"eve"}' });
        await fromEve.sent;
        expect(fromEve.value.diverged).toBe(true);

        const revisions = await alice.listRevisions(teamId, autoId);
        expect(revisions.map((r) => [r.n, r.content, r.diverged])).toEqual([
          [1, '{"v":1}', false],
          [2, '{"by":"alice"}', false],
          [2, '{"by":"eve"}', true],
        ]);
        expect(await alice.openRevision(teamId, autoId, fromAlice.value.id)).toMatchObject({ content: '{"by":"alice"}' });
      });

      it("keeps both revisions when two members publish from one base while both are offline", async () => {
        const { alice, eve, teamId, autoId, r1 } = await library();
        await alice.saveForOffline(teamId);
        await eve.saveForOffline(teamId);
        await alice.setOnline(false);
        await eve.setOnline(false);
        const a = await alice.publishRevision({ teamId, autoId, baseRevision: r1, content: '{"by":"alice"}' });
        const e = await eve.publishRevision({ teamId, autoId, baseRevision: r1, content: '{"by":"eve"}' });
        expect(a.value.diverged).toBe(false);
        expect(e.value.diverged).toBe(false);
        await alice.setOnline(true);
        await a.sent;
        await eve.setOnline(true);
        await e.sent;

        const revisions = await alice.listRevisions(teamId, autoId);
        expect(revisions.filter((r) => r.n === 2).map((r) => [r.content, r.diverged])).toEqual([
          ['{"by":"alice"}', false],
          ['{"by":"eve"}', true],
        ]);
      });

      it("still opens the team after a key change made offline is refused because an admin changed the key first", async () => {
        const { alice, eve, teamId } = await library();
        expect((await eve.listAutos(teamId)).length).toBe(1);
        await (await alice.setRole(teamId, "eve", "admin")).sent;
        expect((await eve.listAutos(teamId)).length).toBe(1);
        // Alice's device reads what a key change needs while online, then loses the network.
        await (await alice.completeKeyRotation(teamId)).sent;
        await alice.saveForOffline(teamId);
        await alice.setOnline(false);
        const offline = await alice.completeKeyRotation(teamId);
        offline.sent.catch(() => undefined);
        // The library refreshes before the change is sent, and opens the key the change makes.
        expect((await alice.listAutos(teamId)).length).toBe(1);
        // Eve changes the key first, so the server refuses Alice's change.
        await (await eve.completeKeyRotation(teamId)).sent;
        await alice.setOnline(true);
        expect(await refused(offline.sent)).not.toBe("allowed");
        // Alice's device takes Eve's key, the one that landed, and opens the team.
        expect((await alice.listAutos(teamId)).length).toBe(1);
      });

      it("opens a saved library with the network off", async () => {
        const { eve, teamId, autoId, r1 } = await library();
        await eve.saveForOffline(teamId);
        await eve.setOnline(false);
        expect((await eve.listAutos(teamId)).map((a) => a.title)).toEqual(["Close side"]);
        expect((await eve.listRevisions(teamId, autoId)).map((r) => r.id)).toEqual([r1]);
        expect((await eve.openRevision(teamId, autoId, r1))?.content).toBe('{"v":1}');
        expect((await eve.getTeamSettings(teamId)).editorsMayLinkShare).toBe(false);
        await eve.setOnline(true);
      });
    });

    describe("sharing and proposals", () => {
      const partner = async () => {
        const olga = await person("olga");
        const team = await olga.createTeam({ number: 12345, name: "Partner" });
        await team.sent;
        const bea = await person("bea");
        const invite = await olga.createInvite(team.value.id, { role: "editor", autoApprove: true });
        await invite.sent;
        await (await bea.redeemInvite(invite.value.code)).sent;
        await grantRequests(olga, team.value.id, bea);
        return { olga, bea, partnerId: team.value.id };
      };

      it("opens an anyone-with-the-link share without signing in, and never lists it", async () => {
        const { alice, teamId, autoId, r1 } = await library();
        const share = await alice.createShare({ teamId, autoId, revision: r1, audience: "link", projection: '{"p":1}' });
        await share.sent;
        const anyone = await h.anonymous();
        const secret = share.value.linkSecret ?? "";
        expect(secret).toHaveLength(22);
        expect((await anyone.openLinkShare(secret))?.projection).toBe('{"p":1}');
        // The id alone opens nothing: the key is in the secret, which the server never sees.
        expect(await anyone.getShare(share.value.id)).toBe(null);
        expect(await refused(anyone.listTeamShares(teamId))).toBe("permission-denied");
        // The team that made it copies the link again from its own list.
        expect((await alice.listTeamShares(teamId))[0]?.linkSecret).toBe(secret);
        await (await alice.revokeShare(share.value.id)).sent;
        expect(await anyone.openLinkShare(secret)).toBe(null);
      });

      it("shows a share to the teams it names while it is live, and to nobody else", async () => {
        const { alice, eve, teamId, autoId, r1 } = await library();
        const { olga, partnerId } = await partner();
        const cody = await person("cody");
        const share = await eve.createShare({ teamId, autoId, revision: r1, audience: "teams", teamIds: [partnerId], projection: '{"p":1}' });
        await share.sent;
        expect(share.value.expiresAt.getTime() - share.value.createdAt.getTime()).toBe(7 * DAY_MS);
        expect((await olga.listReceivedShares(partnerId)).map((s) => s.id)).toEqual([share.value.id]);
        expect(await cody.getShare(share.value.id)).toBe(null);

        // Editors may not make link shares by default; the server refuses it when it arrives.
        const link = eve.createShare({ teamId, autoId, revision: r1, audience: "link", projection: "{}" });
        expect(await refused(link.then((q) => q.sent))).toBe("permission-denied");
        await (await alice.revokeShare(share.value.id)).sent;
        expect(await olga.getShare(share.value.id)).toBe(null);
        expect(await olga.listReceivedShares(partnerId)).toEqual([]);
        expect((await alice.listTeamShares(teamId))[0]?.revokedAt).not.toBe(null);
      });

      it("moves a following share to each new revision as it is published", async () => {
        const { alice, teamId, autoId, r1 } = await library();
        const { olga, partnerId } = await partner();
        const share = await alice.createShare({ teamId, autoId, revision: r1, audience: "teams", teamIds: [partnerId], mode: "follow", projection: '{"p":1}' });
        await share.sent;
        const next = await alice.publishRevision({ teamId, autoId, baseRevision: r1, content: '{"v":2}', followProjection: '{"p":2}' });
        await next.sent;
        expect(await olga.getShare(share.value.id)).toMatchObject({ revision: next.value.id, projection: '{"p":2}' });
      });

      it("re-keys a following share to 3 partner teams when it publishes after removing a member", async () => {
        const { alice, teamId, autoId, r1 } = await library();
        const partners: { owner: FlowUser; teamId: string }[] = [];
        for (const uid of ["olga", "pia", "quinn"]) {
          const owner = await person(uid);
          const team = await owner.createTeam({ number: null, name: `Partner of ${uid}` });
          await team.sent;
          partners.push({ owner, teamId: team.value.id });
        }
        const share = await alice.createShare({
          teamId, autoId, revision: r1, audience: "teams", teamIds: partners.map((p) => p.teamId), mode: "follow", projection: '{"p":1}',
        });
        await share.sent;
        const keyVersionOf = (doc: DocData | null): number => ((doc?.projection as DocData | undefined)?.kv as number | undefined) ?? 0;
        const before = keyVersionOf(await h.peek(`shares/${share.value.id}`));
        // Removing Eve changes the team key, so the share's key, which Eve could open, is stale.
        await (await alice.removeMember(teamId, "eve")).sent;
        const next = await alice.publishRevision({ teamId, autoId, baseRevision: r1, content: '{"v":2}', followProjection: '{"p":2}' });
        await next.sent;
        const after = await h.peek(`shares/${share.value.id}`);
        expect(keyVersionOf(after)).toBe(before + 1);
        expect(Object.keys((after?.prevKeys as DocData | undefined) ?? {})).toEqual([String(before)]);
        for (const partner of partners) {
          expect(await partner.owner.getShare(share.value.id, partner.teamId)).toMatchObject({ revision: next.value.id, projection: '{"p":2}' });
        }
      });

      it("carries a pinned and a following share forward when a member is removed, so a partner that saw the new key opens both", async () => {
        const { alice, teamId, autoId, r1 } = await library();
        const { olga, partnerId } = await partner();
        const pinned = await alice.createShare({ teamId, autoId, revision: r1, audience: "teams", teamIds: [partnerId], projection: '{"p":"pinned"}' });
        await pinned.sent;
        const follow = await alice.createShare({ teamId, autoId, revision: r1, audience: "teams", teamIds: [partnerId], mode: "follow", projection: '{"p":"follow"}' });
        await follow.sent;
        expect((await olga.getShare(pinned.value.id))?.projection).toBe('{"p":"pinned"}');
        const keyVersionOf = (doc: DocData | null): number => ((doc?.projection as DocData | undefined)?.kv as number | undefined) ?? 0;
        const before = keyVersionOf(await h.peek(`shares/${pinned.value.id}`));
        // Removing Eve changes the team key; once that is stored, Alice's device carries both shares.
        await (await alice.removeMember(teamId, "eve")).sent;
        for (const id of [pinned.value.id, follow.value.id]) expect(keyVersionOf(await h.peek(`shares/${id}`))).toBe(before + 1);
        // Olga sees the new key on a share made after the change, and still opens the two made before.
        const fresh = await alice.createShare({ teamId, autoId, revision: r1, audience: "teams", teamIds: [partnerId], projection: '{"p":"fresh"}' });
        await fresh.sent;
        expect((await olga.getShare(fresh.value.id))?.projection).toBe('{"p":"fresh"}');
        expect((await olga.getShare(pinned.value.id))?.projection).toBe('{"p":"pinned"}');
        expect((await olga.getShare(follow.value.id))?.projection).toBe('{"p":"follow"}');
        expect(await olga.listWaitingShares(partnerId)).toEqual([]);
        expect(await alice.carryForwardShares(teamId)).toEqual({ carried: [], left: [] });
      });

      it("revokes every share of a deleted team, in groups, so no other team can open one", async () => {
        const { alice, teamId, autoId, r1 } = await library();
        const { olga, partnerId } = await partner();
        const toPartner = await alice.createShare({ teamId, autoId, revision: r1, audience: "teams", teamIds: [partnerId], projection: '{"p":1}' });
        await toPartner.sent;
        // Nine link shares as well, so the revocations take more than one write.
        const links: string[] = [];
        for (let i = 0; i < 9; i += 1) {
          const link = await alice.createShare({ teamId, autoId, revision: r1, audience: "link", projection: '{"p":2}' });
          await link.sent;
          links.push(link.value.linkSecret ?? "");
        }
        const early = await alice.createShare({ teamId, autoId, revision: r1, audience: "link", projection: '{"p":3}' });
        await early.sent;
        await (await alice.revokeShare(early.value.id)).sent;
        const revokedEarly = (await alice.getShare(early.value.id))?.revokedAt;

        await (await alice.deleteTeam(teamId)).sent;
        expect(await h.peek(`teams/${teamId}`)).toBe(null);
        expect(await olga.getShare(toPartner.value.id)).toBe(null);
        expect(await olga.listReceivedShares(partnerId)).toEqual([]);
        const anyone = await h.anonymous();
        for (const secret of links) expect(await anyone.openLinkShare(secret), secret).toBe(null);

        const hana = await h.user("hana");
        const all = await hana.listAllShares();
        expect(all).toHaveLength(11);
        for (const share of all) {
          expect(share.revokedAt, share.id).not.toBe(null);
          expect(share.updatedAt.getTime(), share.id).toBe(share.revokedAt?.getTime());
        }
        // A share revoked before keeps the moment it was revoked.
        expect(all.find((s) => s.id === early.value.id)?.revokedAt?.getTime()).toBe(revokedEarly?.getTime());
      });

      it("purges every member when a Horizon admin deletes a team, so a share sent to it opens for none of them", async () => {
        const { alice, teamId, autoId, r1 } = await library();
        const { olga, bea, partnerId } = await partner();
        const toPartner = await alice.createShare({ teamId, autoId, revision: r1, audience: "teams", teamIds: [partnerId], projection: '{"p":1}' });
        await toPartner.sent;
        expect((await bea.getShare(toPartner.value.id))?.projection).toBe('{"p":1}');

        // Nobody else can: a member who is not the owner, nor someone outside the team.
        await expect(bea.deleteTeam(partnerId)).rejects.toThrow("Only an owner of the team can delete it.");
        await expect(alice.deleteTeam(partnerId)).rejects.toThrow("Only an owner of the team can delete it.");

        const hana = await h.user("hana");
        await (await hana.deleteTeam(partnerId)).sent;
        expect(await h.peek(`teams/${partnerId}`)).toBe(null);
        expect(await h.peek(`deletedTeams/${partnerId}`)).toMatchObject({ deletedBy: "hana" });
        expect(await h.peek(`teams/${partnerId}/members/olga`)).toBe(null);
        expect(await h.peek(`teams/${partnerId}/members/bea`)).toBe(null);
        for (const member of [olga, bea]) {
          // Refused by the rules, or read as gone: either way nothing of the share reaches them.
          expect(await member.getShare(toPartner.value.id).catch(() => null)).toBe(null);
          expect(await member.listMyTeams()).toEqual([]);
        }
        // The sharing team still lists its share.
        expect((await alice.listTeamShares(teamId)).map((share) => share.id)).toEqual([toPartner.value.id]);
      });

      it("lists every share of every team to a Horizon admin, newest first, and to nobody else", async () => {
        const { alice, teamId, autoId, r1 } = await library();
        const { olga, partnerId } = await partner();
        const first = await alice.createShare({ teamId, autoId, revision: r1, audience: "teams", teamIds: [partnerId], projection: '{"p":1}' });
        await first.sent;
        const partnerAuto = await olga.createAuto(partnerId, { title: "Far side" });
        await partnerAuto.sent;
        const partnerRevision = await olga.publishRevision({ teamId: partnerId, autoId: partnerAuto.value.id, baseRevision: null, content: '{"v":1}' });
        await partnerRevision.sent;
        const second = await olga.createShare({
          teamId: partnerId, autoId: partnerAuto.value.id, revision: partnerRevision.value.id, audience: "link", projection: '{"p":2}',
        });
        await second.sent;
        await (await alice.revokeShare(first.value.id)).sent;

        const hana = await h.user("hana");
        const all = await hana.listAllShares();
        expect(all.map((s) => s.id)).toEqual([second.value.id, first.value.id]);
        expect(all.map((s) => s.ownerTeamId)).toEqual([partnerId, teamId]);
        // Settings only (spec 14 section 0): no projection, and no key.
        for (const share of all) expect(Object.keys(share).filter((k) => ["projection", "keyWraps", "ownerWrap", "linkWrap", "prevKeys", "manifest"].includes(k))).toEqual([]);
        expect(all[1]?.revokedAt).not.toBe(null);
        // An admin reads a share's settings by its id, but cannot open what it shows.
        expect(await hana.getShare(first.value.id)).toBe(null);

        expect(await refused(alice.listAllShares())).toBe("permission-denied");
        expect(await refused(olga.listAllShares())).toBe("permission-denied");
        await expect(alice.listAllShares()).rejects.toThrow("Only Horizon admins can see every share.");
        expect(await refused((await h.anonymous()).listAllShares())).toBe("signed-out");
        // Seeing a share gives an admin no way to change it.
        expect(await refused(hana.revokeShare(second.value.id).then((q) => q.sent))).toBe("permission-denied");
      });

      it("takes proposals only on a propose-level share, and lets the owning team decide", async () => {
        const { alice, teamId, autoId, r1 } = await library();
        const { bea, partnerId } = await partner();
        const view = await alice.createShare({ teamId, autoId, revision: r1, audience: "teams", teamIds: [partnerId], projection: "{}" });
        const propose = await alice.createShare({ teamId, autoId, revision: r1, audience: "teams", teamIds: [partnerId], level: "propose", projection: "{}" });
        await view.sent;
        await propose.sent;

        await expect(bea.sendProposal({ shareId: view.value.id, fromTeamId: partnerId, baseRevision: r1, diff: "[]" })).rejects.toThrow(/view only/);
        const sent = await bea.sendProposal({ shareId: propose.value.id, fromTeamId: partnerId, baseRevision: r1, diff: '[{"op":"wait"}]' });
        await sent.sent;
        expect((await alice.listProposals(teamId, "received")).map((p) => p.id)).toEqual([sent.value.id]);
        expect((await bea.listProposals(partnerId, "sent")).map((p) => p.status)).toEqual(["open"]);
        await (await alice.decideProposal(sent.value.id, "accepted")).sent;
        expect((await bea.listProposals(partnerId, "sent"))[0]?.status).toBe("accepted");
      });

      it("takes a proposal on a pinned share only against the revision it shows now", async () => {
        const { alice, teamId, autoId, r1 } = await library();
        const { bea, partnerId } = await partner();
        const propose = await alice.createShare({ teamId, autoId, revision: r1, audience: "teams", teamIds: [partnerId], level: "propose", projection: "{}" });
        await propose.sent;
        const r2 = await alice.publishRevision({ teamId, autoId, baseRevision: r1, content: '{"v":2}' });
        await r2.sent;
        await (await alice.updateShare(propose.value.id, { revision: r2.value.id, projection: '{"p":2}' })).sent;
        await expect(bea.sendProposal({ shareId: propose.value.id, fromTeamId: partnerId, baseRevision: r1, diff: "[1]" })).rejects.toThrow(/Reload the partner/);
        await (await bea.sendProposal({ shareId: propose.value.id, fromTeamId: partnerId, baseRevision: r2.value.id, diff: "[1]" })).sent;
        await expect(bea.sendProposal({ shareId: propose.value.id, fromTeamId: partnerId, baseRevision: r2.value.id, diff: "x".repeat(1_000_001) })).rejects.toThrow(/1,000 KB/);
      });

      it("asks for more time offline, sends it on reconnecting, and the sharing team grants it by extending the share", async () => {
        const { alice, teamId, autoId, r1 } = await library();
        const { olga, bea, partnerId } = await partner();
        const share = await alice.createShare({ teamId, autoId, revision: r1, audience: "teams", teamIds: [partnerId], projection: '{"p":1}' });
        await share.sent;
        expect((await olga.listReceivedShares(partnerId)).map((s) => s.id)).toEqual([share.value.id]);

        await olga.setOnline(false);
        const asked = await olga.requestMoreTime({ shareId: share.value.id, teamId: partnerId, reason: "next-event" });
        expect(asked.value).toMatchObject({ status: "open", teamId: partnerId, ownerTeamId: teamId, reason: "next-event" });
        expect(olga.outbox().queued).toBe(1);
        expect(await alice.listTimeRequests(teamId, "received")).toEqual([]);
        await olga.setOnline(true);
        await asked.sent;

        const open = await alice.listTimeRequests(teamId, "received");
        expect(open.map((r) => [r.shareId, r.teamId, r.status])).toEqual([[share.value.id, partnerId, "open"]]);
        await expect(bea.requestMoreTime({ shareId: share.value.id, teamId: partnerId })).rejects.toThrow(/already asked/);

        const until = new Date(share.value.expiresAt.getTime() + 7 * DAY_MS);
        await expect(alice.decideTimeRequest(share.value.id, partnerId, { status: "granted", expiresAt: new Date(Date.now() + DAY_MS) })).rejects.toThrow(/later/);
        await (await alice.decideTimeRequest(share.value.id, partnerId, { status: "granted", expiresAt: until })).sent;
        expect((await olga.getShare(share.value.id))?.expiresAt.getTime()).toBe(until.getTime());
        const [granted] = await bea.listTimeRequests(partnerId, "sent");
        expect(granted?.status).toBe("granted");
        expect(granted?.grantedUntil?.getTime()).toBe(until.getTime());
        expect((await alice.listActivity(teamId)).map((e) => e.kind)).toContain("time.grant");
      });

      it("asks after a share ended, lists the shares a team can no longer open, and never asks once revoked", async () => {
        const { alice, teamId, autoId, r1 } = await library();
        const { olga, partnerId } = await partner();
        const ended = await alice.createShare({ teamId, autoId, revision: r1, audience: "teams", teamIds: [partnerId], projection: '{"p":1}' });
        await ended.sent;
        await (await alice.extendShare(ended.value.id, new Date(Date.now() - DAY_MS))).sent;
        const revoked = await alice.createShare({ teamId, autoId, revision: r1, audience: "teams", teamIds: [partnerId], projection: '{"p":2}' });
        await revoked.sent;
        await (await alice.revokeShare(revoked.value.id)).sent;

        expect(await olga.listReceivedShares(partnerId)).toEqual([]);
        const gone = await olga.listEndedShares(partnerId);
        expect(gone.map((e) => e.shareId).sort()).toEqual([ended.value.id, revoked.value.id].sort());
        expect(gone.every((e) => e.ownerTeamId === teamId)).toBe(true);

        await (await olga.requestMoreTime({ shareId: ended.value.id, teamId: partnerId, wantedUntil: new Date(Date.now() + 3 * DAY_MS) })).sent;
        const onRevoked = olga.requestMoreTime({ shareId: revoked.value.id, teamId: partnerId });
        expect(await refused(onRevoked.then((q) => q.sent))).toBe("permission-denied");

        await (await alice.decideTimeRequest(ended.value.id, partnerId, { status: "declined" })).sent;
        expect((await olga.listTimeRequests(partnerId, "sent")).map((r) => r.status)).toEqual(["declined"]);
        // Declined, it may be asked again.
        await (await olga.requestMoreTime({ shareId: ended.value.id, teamId: partnerId, reason: "still-testing" })).sent;
        expect((await alice.listTimeRequests(teamId, "received")).map((r) => [r.status, r.reason])).toEqual([["open", "still-testing"]]);
      });
    });

    describe("the private beta", () => {
      /** A project the owner has not opened: no config/access, Alice named as a tester, Hana an admin. */
      const closed = (extra: Record<string, DocData> = {}) =>
        raw.reset({ "admins/hana": { name: "Horizon reviewer" }, "betaTesters/alice": { name: "Alice" }, ...extra });
      const access = async (uid: string) => (await h.user(uid)).hasBetaAccess();

      it("answers hasBetaAccess for a named tester, a Horizon admin, anyone else and nobody signed in", async () => {
        await closed();
        expect(await access("alice")).toBe(true);
        expect(await access("hana")).toBe(true);
        expect(await access("stan")).toBe(false);
        expect(await (await h.anonymous()).hasBetaAccess()).toBe(false);
      });

      it("answers true for everyone when betaOpen is true, and false while it is anything else", async () => {
        await closed({ "config/access": { betaOpen: true } });
        expect(await access("stan")).toBe(true);
        expect(await (await h.anonymous()).hasBetaAccess()).toBe(false);
        for (const value of [false, "true", 1]) {
          await closed({ "config/access": { betaOpen: value } });
          expect(await access("stan"), String(value)).toBe(false);
          expect(await access("alice"), String(value)).toBe(true);
        }
      });

      it("refuses a profile and an invite redemption to someone not named, and lets a named tester in", async () => {
        await closed({
          "betaTesters/tess": { name: "Tess" },
          // A profile from before the gate, of someone who is not on the list.
          "users/nina": { displayName: "nina", createdAt: new Date(Date.now() - DAY_MS) },
        });
        const alice = await person("alice");
        const team = await alice.createTeam({ number: null, name: "Horizon" });
        await team.sent;
        const invite = await alice.createInvite(team.value.id, { role: "editor" });
        await invite.sent;

        const stan = await h.user("stan");
        expect(await refused(stan.saveProfile({ displayName: "stan" }).then((q) => q.sent))).toBe("permission-denied");
        expect(await h.peek("users/stan")).toBe(null);
        const nina = await h.user("nina");
        expect(await refused(nina.redeemInvite(invite.value.code).then((q) => q.sent))).toBe("permission-denied");
        expect(await h.peek(`teams/${team.value.id}/members/nina`)).toBe(null);

        const tess = await person("tess");
        const joined = await tess.redeemInvite(invite.value.code);
        await joined.sent;
        expect((await h.peek(`teams/${team.value.id}/members/tess`))?.role).toBe("pending");
      });

      it("lets someone not on the list delete their account and everything the app holds of it", async () => {
        await closed({ "users/nina": { displayName: "nina", createdAt: new Date(Date.now() - DAY_MS) } });
        const nina = await h.user("nina");
        expect(await nina.hasBetaAccess()).toBe(false);
        await nina.deleteAccount();
        expect(await h.peek("users/nina")).toBe(null);
      });

      it("lists testers and admins to a Horizon admin only, and never the requests left from before", async () => {
        await closed({ "betaRequests/old": { name: "Olive", createdAt: new Date(Date.now() - 2 * DAY_MS) } });
        const stan = await h.user("stan");
        await expect(stan.listBetaAccess()).rejects.toThrow("Only Horizon admins can read the beta lists.");

        const hana = await h.user("hana");
        const lists = await hana.listBetaAccess();
        expect(lists).toEqual({
          testers: [{ uid: "alice", name: "Alice" }],
          admins: [{ uid: "hana", name: "Horizon reviewer" }],
        });
      });

      it("adds and removes testers by user code, and adding deletes a request left from before", async () => {
        await closed({ "betaRequests/stan": { name: "Stan", createdAt: new Date(Date.now() - DAY_MS) } });
        const hana = await h.user("hana");
        await expect(hana.addBetaTester({ uid: "a/b", name: "X" })).rejects.toThrow("A user code has 1 to 128 characters and no slash.");
        await expect(hana.addBetaTester({ uid: "alice", name: "Alice" })).rejects.toThrow("This person is already on the beta list.");
        await (await hana.addBetaTester({ uid: " stan ", name: "Stanley" })).sent;
        expect(await h.peek("betaTesters/stan")).toEqual({ name: "Stanley" });
        expect(await h.peek("betaRequests/stan")).toBe(null);
        await (await hana.removeBetaTester("alice")).sent;
        expect(await h.peek("betaTesters/alice")).toBe(null);
        expect(await (await h.user("alice")).hasBetaAccess()).toBe(false);

        const stan = await h.user("stan");
        expect(await refused(stan.removeBetaTester("stan").then((q) => q.sent))).not.toBe("allowed");
        expect(await h.peek("betaTesters/stan")).toEqual({ name: "Stanley" });
        const actions = (await hana.listAdminLog()).map((entry) => `${entry.action} ${entry.target ?? ""}`).sort();
        expect(actions).toEqual(["beta.add stan", "beta.remove alice"]);
      });

      it("lets a Horizon admin add and remove other admins, never themselves", async () => {
        await closed();
        const hana = await h.user("hana");
        await expect(hana.addHorizonAdmin({ uid: "hana", name: "Hana" })).rejects.toThrow("This person is already a Horizon admin.");
        await (await hana.addHorizonAdmin({ uid: "sue", name: "Sue" })).sent;
        expect(await h.peek("admins/sue")).toEqual({ name: "Sue" });
        const sue = await h.user("sue");
        expect(await sue.isHorizonAdmin()).toBe(true);
        await expect(hana.removeHorizonAdmin("hana")).rejects.toThrow("You cannot remove yourself. Another Horizon admin can.");
        const alice = await h.user("alice");
        expect(await refused(alice.addHorizonAdmin({ uid: "alice", name: "Alice" }).then((q) => q.sent))).not.toBe("allowed");
        expect(await h.peek("admins/alice")).toBe(null);
        await (await sue.removeHorizonAdmin("hana")).sent;
        expect(await h.peek("admins/hana")).toBe(null);
        expect((await sue.listBetaAccess()).admins).toEqual([{ uid: "sue", name: "Sue" }]);
      });

      it("puts a request left from before in the export, and deleting the account deletes it", async () => {
        await closed({ "betaRequests/stan": { name: "Stan", email: "stan@example.org", createdAt: new Date(Date.now() - DAY_MS) } });
        const stan = await h.user("stan", { email: "stan@example.org" });
        expect((await stan.exportMyData()).betaRequest).toMatchObject({ uid: "stan", name: "Stan", email: "stan@example.org" });
        await stan.deleteAccount();
        expect(await h.peek("betaRequests/stan")).toBe(null);
      });
    });

    describe("bug reports", () => {
      const setup = {
        appVersion: "0.1.1", surface: "web" as const, hostMode: false, browser: "Chrome 131", os: "Windows 10",
        windowWidthPx: 1440, windowHeightPx: 900, theme: "dark" as const, cloudMode: "firebase" as const,
        problems: "", recentActions: "help.reportBug",
      };

      it("go privately to Horizon admins, who mark them triaged and closed, and the reporter cannot read them back", async () => {
        const alice = await person("alice");
        const sent = await alice.sendBugReport({ whatHappened: "  The path vanished.  ", expected: "", steps: "Open, drag.", setup });
        await sent.sent;
        expect(sent.value.id).toMatch(/^[A-Za-z0-9_-]{22}$/);
        expect(await refused(alice.listBugReports())).toBe("permission-denied");
        await expect(alice.listBugReports()).rejects.toThrow("Only Horizon admins can read bug reports.");
        expect(await refused(alice.setBugReportStatus(sent.value.id, "closed").then((q) => q.sent))).toBe("permission-denied");

        const hana = await h.user("hana");
        const [report] = await hana.listBugReports();
        expect(report).toMatchObject({ id: sent.value.id, reporter: "alice", status: "new", whatHappened: "The path vanished.", steps: "Open, drag.", setup });
        expect(report?.expected).toBeUndefined();
        expect(report?.createdAt).toBeInstanceOf(Date);
        await (await hana.setBugReportStatus(sent.value.id, "triaged")).sent;
        await (await hana.setBugReportStatus(sent.value.id, "closed")).sent;
        expect((await hana.listBugReports())[0]).toMatchObject({ status: "closed", updatedBy: "hana" });
        expect((await hana.listAdminLog()).map((e) => [e.action, e.target ?? null])).toEqual([
          ["report.status", sent.value.id],
          ["report.status", sent.value.id],
        ]);
      });

      it("need a profile, and say what is wrong before anything is written", async () => {
        const nobody = await h.user("nina");
        expect(await refused(nobody.sendBugReport({ whatHappened: "Broken.", setup }).then((q) => q.sent))).toBe("permission-denied");
        const alice = await person("alice");
        await expect(alice.sendBugReport({ whatHappened: "   ", setup })).rejects.toThrow("Say what happened first.");
        await expect(alice.sendBugReport({ whatHappened: "Broken.", setup, autoFile: "a".repeat(200_001) })).rejects.toThrow("too large to attach");
        expect(await refused((await h.anonymous()).sendBugReport({ whatHappened: "Broken.", setup }))).toBe("signed-out");
      });
    });

    describe("team numbers and verification (M-C7)", () => {
      /** Alice's team holding 36596, unverified, and Olga's team with no number. */
      const twoTeams = async () => {
        const alice = await person("alice");
        const holder = await alice.createTeam({ number: 36596, name: "Horizon" });
        await holder.sent;
        const olga = await person("olga");
        const challenger = await olga.createTeam({ number: null, name: "Also Horizon" });
        await challenger.sent;
        return { alice, olga, holderId: holder.value.id, challengerId: challenger.value.id };
      };

      it("verifies a number only through a Horizon admin's decision on the team's request", async () => {
        const { alice, holderId } = await twoTeams();
        const request = await alice.requestVerification(holderId, [
          { kind: "photo", summary: "Robot with the claim code on a card.", url: "https://example.org/robot.jpg" },
          { kind: "statement", summary: "We have been 36596 since 2023." },
        ]);
        await request.sent;
        expect((await alice.listVerificationRequests(holderId)).map((r) => [r.status, r.evidence.length])).toEqual([["open", 2]]);
        expect(await refused(alice.requestVerification(holderId, [{ kind: "statement", summary: "Again." }]))).toBe("conflict");
        expect(await refused(alice.requestVerification(holderId, [{ kind: "photo", summary: "No link." }]))).toBe("invalid");

        expect(await refused(alice.decideVerification(request.value.id, { verdict: "verified", reason: "We say so." }).then((q) => q.sent))).toBe("permission-denied");
        expect(await refused(alice.listReviewQueue())).toBe("permission-denied");
        expect((await alice.getClaim(36596))?.status).toBe("unverified");

        const hana = await h.user("hana");
        expect((await hana.listReviewQueue()).requests.map((r) => r.id)).toEqual([request.value.id]);
        expect(await refused(hana.decideVerification(request.value.id, { verdict: "verified", reason: "no full stop" }))).toBe("invalid");
        await (await hana.decideVerification(request.value.id, { verdict: "verified", reason: "The photo shows the claim code on the robot." })).sent;
        expect(await alice.getClaim(36596)).toMatchObject({ status: "verified", requestId: null });
        expect((await alice.getClaim(36596, holderId))?.history.map((e) => e.kind)).toEqual(["claim", "request", "verify"]);
        // The history is for the teams involved: without a team, a member reads none of it.
        expect((await alice.getClaim(36596))?.history).toEqual([]);
        expect(await alice.getTeam(holderId)).toMatchObject({ status: "verified" });
        expect((await alice.listVerificationRequests(holderId))[0]?.decision).toMatchObject({ verdict: "verified", by: "hana" });
        expect((await hana.listReviewQueue()).requests).toEqual([]);
      });

      it("logs what a Horizon admin reads and decides, for Horizon admins alone to read", async () => {
        const { alice, holderId } = await twoTeams();
        const request = await alice.requestVerification(holderId, [{ kind: "statement", summary: "We are 36596." }]);
        await request.sent;
        const hana = await h.user("hana");
        await (await hana.recordAdminAccess("queue.list")).sent;
        await (await hana.recordAdminAccess("queue.open", request.value.id)).sent;
        await (await hana.decideVerification(request.value.id, { verdict: "declined", reason: "The statement alone does not show the number." })).sent;
        const log = await hana.listAdminLog();
        expect(log.map((e) => [e.action, e.target ?? null, e.by])).toEqual([
          ["verification.decide", request.value.id, "hana"],
          ["queue.open", request.value.id, "hana"],
          ["queue.list", null, "hana"],
        ]);
        expect(log.every((e) => e.at instanceof Date)).toBe(true);
        expect(await refused(alice.recordAdminAccess("shares.list").then((q) => q.sent))).toBe("permission-denied");
        expect(await refused(alice.listAdminLog())).toBe("permission-denied");
      });

      it("refuses a claim on a verified number with a sentence on asking for a review", async () => {
        const { alice, olga, holderId, challengerId } = await twoTeams();
        const request = await alice.requestVerification(holderId, [{ kind: "statement", summary: "Ours." }]);
        await request.sent;
        const hana = await h.user("hana");
        await (await hana.decideVerification(request.value.id, { verdict: "verified", reason: "Listed at an event as 36596." })).sent;

        let message = "";
        try {
          await olga.claimNumber(challengerId, 36596);
        } catch (error) {
          if (isCloudError(error, "conflict")) message = error.message;
        }
        expect(message).toContain("verified to another team");
        expect(message).toContain("ask for a review");
        expect((await olga.getClaim(36596))?.teamId).toBe(holderId);

        // Asking for a review keeps the number verified while it is reviewed.
        await (await olga.openDispute({ teamNumber: 36596, challengerTeamId: challengerId })).sent;
        expect((await olga.getClaim(36596))?.status).toBe("verified");
      });

      it("contests an unverified number: both teams see contested, and a third team sees nothing", async () => {
        const { alice, olga, holderId, challengerId } = await twoTeams();
        const claimed = await olga.claimNumber(challengerId, 36596);
        await claimed.sent;
        expect(claimed.value.outcome).toBe("contested");
        const disputeId = claimed.value.outcome === "contested" ? claimed.value.dispute.id : "";
        expect((await olga.getClaim(36596))?.status).toBe("contested");
        expect((await olga.getTeam(holderId))?.status).toBe("contested");
        expect((await alice.getTeam(challengerId))?.status).toBe("contested");
        expect((await alice.listDisputes(holderId)).map((d) => d.id)).toEqual([disputeId]);
        expect((await olga.listDisputes(challengerId)).map((d) => d.id)).toEqual([disputeId]);

        await (await olga.addDisputeEvidence(disputeId, { team: challengerId, kind: "event", summary: "Listed at the league meet.", url: "https://example.org/results" })).sent;
        await (await alice.addDisputeEvidence(disputeId, { team: holderId, kind: "statement", summary: "Our number since 2023." })).sent;
        expect((await alice.getDispute(disputeId))?.evidence.map((e) => e.team)).toEqual([challengerId, holderId]);

        const cody = await person("cody");
        const third = await cody.createTeam({ number: null, name: "Third" });
        await third.sent;
        expect(await cody.getDispute(disputeId)).toBeNull();
        expect(await refused(cody.listDisputes(holderId))).toBe("permission-denied");
        expect(await refused(cody.claimNumber(third.value.id, 36596))).toBe("conflict");
      });

      it("decides a dispute, takes one appeal from the team that lost, and lets the same reviewer decide it", async () => {
        const { alice, olga, holderId, challengerId } = await twoTeams();
        const claimed = await olga.claimNumber(challengerId, 36596);
        await claimed.sent;
        const disputeId = claimed.value.outcome === "contested" ? claimed.value.dispute.id : "";
        expect(await alice.getTeam(challengerId)).toMatchObject({ number: null, status: "contested" });

        expect(await refused(olga.decideDispute(disputeId, { winner: challengerId, reason: "Mine." }).then((q) => q.sent))).toBe("permission-denied");
        const hana = await h.user("hana");
        expect((await hana.listReviewQueue()).disputes.map((d) => d.id)).toEqual([disputeId]);
        await (await hana.decideDispute(disputeId, { winner: challengerId, reason: "The FTC event listing names them." })).sent;
        expect(await alice.getClaim(36596)).toMatchObject({ teamId: challengerId, status: "verified", disputeId: null });
        expect(await alice.getTeam(challengerId)).toMatchObject({ number: 36596, status: "verified" });
        expect(await alice.getTeam(holderId)).toMatchObject({ number: null, status: "unverified" });
        expect((await alice.getDispute(disputeId))?.decision).toMatchObject({ winner: challengerId, by: "hana" });

        expect(await refused(olga.appealDispute(disputeId, { team: challengerId, reason: "We won." }))).toBe("invalid");
        await (await alice.appealDispute(disputeId, { team: holderId, reason: "Our banner photo shows the number." })).sent;
        expect(await refused(alice.appealDispute(disputeId, { team: holderId, reason: "Again." }))).toBe("invalid");

        // The reviewer who made the first decision sees the appeal and decides it alone.
        expect((await hana.listReviewQueue()).appeals.map((d) => d.id)).toEqual([disputeId]);
        expect(await refused(olga.decideAppeal(disputeId, { winner: challengerId, reason: "Still mine." }).then((q) => q.sent))).toBe("permission-denied");
        await (await hana.decideAppeal(disputeId, { winner: holderId, reason: "The banner photo carries the claim code." })).sent;
        expect((await alice.getDispute(disputeId))?.appealDecision).toMatchObject({ winner: holderId, by: "hana" });
        expect(await alice.getClaim(36596)).toMatchObject({ teamId: holderId, status: "verified" });
        expect(await alice.getTeam(holderId)).toMatchObject({ number: 36596, status: "verified" });
        expect(await alice.getTeam(challengerId)).toMatchObject({ number: null, status: "unverified" });
        const everyStep = ["claim", "contest", "decision", "appeal", "appeal-decision"];
        expect((await alice.getClaim(36596, holderId))?.history.map((e) => e.kind)).toEqual(everyStep);
        // The challenger reads every step it is involved in, not the holder's own claim.
        expect((await olga.getClaim(36596, challengerId))?.history.map((e) => e.kind)).toEqual(everyStep.slice(1));
        expect((await hana.getClaim(36596))?.history.map((e) => e.kind)).toEqual(everyStep);
        expect((await hana.getClaim(36596))?.history.filter((e) => e.kind.endsWith("decision")).map((e) => e.by)).toEqual(["hana", "hana"]);
        const cody = await person("cody");
        const third = await cody.createTeam({ number: null, name: "Third" });
        await third.sent;
        expect(await cody.getClaim(36596, third.value.id)).toMatchObject({ teamId: holderId, status: "verified", history: [] });
        // Asking for another team's steps is refused by the rules, which reads as none.
        expect((await cody.getClaim(36596, holderId))?.history).toEqual([]);
        expect((await olga.getDispute(disputeId))?.status).toBe("final");
      });
    });
  });
}
