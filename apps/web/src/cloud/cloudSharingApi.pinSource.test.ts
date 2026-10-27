/**
 * A pin the web app writes on its own. Signing in lists the received shares (`setSharingBackend`
 * and `refreshReceived`), which opens each one and pins the key of the team it claims to come from,
 * with no safety code shown. The server alone can make such a share, so that pin is kept as trusted
 * on first use only: it makes no proposal the server signed list as that team's, and it does not
 * let the share dialog skip showing that team's safety code.
 */
import { describe, expect, it } from "vitest";
import {
  aadFor, commitShareKey, createTeamKeys, generateDeviceKeys, newShareKey, rotateTeamKeys, sealProposal, sealText,
  shareProjectionDigest, signProposal, signShareManifest, teamKeyDigest, wrapShareKeyToTeam, type TeamEncKey,
} from "@horizon36596/zenith-cloud/crypto";
import type { MemoryDatabase } from "@horizon36596/zenith-cloud/memory";
import { NOW_MS, cloudWorld, ownerSawPartnerCodes, publishTo } from "./cloudFixture.test";
import { createCloudSharingApi } from "./cloudSharingApi";
import { createCloudProposalsApi } from "./proposalsApi";
import { getCloud, refreshReceived, setSharingBackend } from "./store";

type Doc = Record<string, unknown>;
const encKeyOf = (database: MemoryDatabase, teamId: string) => (database.peek(`teams/${teamId}`) as unknown as { encKey: TeamEncKey }).encKey;

describe("a pin planted by a received share the server made", () => {
  it("does not make a proposal the server made list as from that team", async () => {
    const world = await cloudWorld([12345, 23456]);
    ownerSawPartnerCodes(world);
    const { database, owner } = world;
    const [partner, third] = world.partners as [typeof world.partners[0], typeof world.partners[0]];
    const at = await publishTo(owner, "first-auto.auto.json", '{"kind":"auto"}\n');
    const checks = await owner.backend.checkPartnerKeys([partner.teamId]);
    const made = await owner.backend.createShare({
      teamId: owner.teamId, autoId: at.autoId, revision: at.revisionId, audience: "teams", teamIds: [partner.teamId], level: "propose", mode: "pinned",
      projection: '{"s":"one"}', expectedKeys: { [partner.teamId]: checks[0]!.keyId },
    });
    await made.sent;

    // The server, holding no key of any team: a version 2 of "team 23456" of its own, and a share
    // "from" 23456 to Horizon signed with it and a device of its own.
    const fakeOne = await createTeamKeys(third.teamId);
    const fake = await rotateTeamKeys(third.teamId, fakeOne);
    database.seed(`teams/${third.teamId}/teamKeys/2`, fake.record as unknown as Doc);
    const shareId = "fakeShareFrom23456000000";
    const device = await generateDeviceKeys();
    const to = encKeyOf(database, owner.teamId);
    const shareKey = await newShareKey(1);
    const expires = new Date(NOW_MS + 7 * 86_400_000);
    const projection = await sealText(shareKey, '{"server":"projection"}', aadFor.shareProjection({ shareId, autoId: "fakeAuto", kv: 1 }));
    const body = {
      shareId, ownerTeamId: third.teamId, autoId: "fakeAuto", revisionId: "r1fake", audience: "teams" as const, mode: "follow" as const, level: "view" as const,
      revoked: false, expiresAtMs: expires.getTime(), seq: 1, skv: 1, wkv: 2, okv: 2, device: device.deviceId, termsSeq: 1, termsDevices: [device.deviceId], choice: null,
      projection: await shareProjectionDigest({ shareId, projection }),
      teams: [[owner.teamId, to.v, await teamKeyDigest({ teamId: owner.teamId, v: to.v, fingerprint: to.fingerprint, signSpki: to.signSpki })] as const],
      commit: await commitShareKey({ shareId, shareKey }),
    };
    const now = database.now();
    database.seed(`shares/${shareId}`, {
      ownerTeamId: third.teamId, autoId: "fakeAuto", revision: "r1fake", audience: "teams", teamIds: [owner.teamId], level: "view", mode: "follow",
      expiresAt: expires, revokedAt: null, createdBy: "someone", createdAt: now, updatedAt: now,
      projection,
      keyWraps: { [owner.teamId]: await wrapShareKeyToTeam({ shareId, teamId: owner.teamId, shareKey, encKey: to }) },
      manifest: await signShareManifest({ body, signingKey: fake.pair.signingKey, device }),
    } as unknown as Doc);
    database.seed(`teams/${owner.teamId}/inbox/${shareId}`, { ownerTeamId: third.teamId, createdAt: now } as unknown as Doc);

    // Horizon's owner signs in: the web app lists received shares on its own.
    setSharingBackend(createCloudSharingApi(owner.backend, { now: () => NOW_MS }), { signedIn: true, teamId: owner.teamId, teamNumber: 36596, teamName: "Horizon" }, { now: () => NOW_MS });
    await refreshReceived();
    expect(getCloud().error).toBeNull();
    expect(getCloud().received.map((share) => share.id)).toEqual([shareId]);

    // The server writes a proposal "from" 23456 on Horizon's real share to 12345.
    const proposalId = "plantedPinWebProposal000";
    const binding = { proposalId, shareId: made.value.id, ownerTeamId: owner.teamId, fromTeamId: third.teamId, okv: to.v, fkv: 2 };
    const sealed = await sealProposal({ binding, diffText: '{"server":"chosen change"}', ownerEncKey: to, fromTeamKey: fake.key });
    const sig = await signProposal({ binding, context: { autoId: at.autoId, baseRevision: at.revisionId }, sealed, signingKey: fake.pair.signingKey });
    database.seed(`proposals/${proposalId}`, {
      shareId: made.value.id, ownerTeamId: owner.teamId, autoId: at.autoId, fromTeamId: third.teamId, baseRevision: at.revisionId,
      status: "open", createdBy: "someone", createdAt: database.now(), ...sealed, sig,
    } as unknown as Doc);

    const listed = await createCloudProposalsApi(owner.backend).list(owner.teamId, "received");
    // Team 23456 never signed anything, so nothing is listed as its proposal.
    expect(listed.map((proposal) => [proposal.fromTeamId === third.teamId ? "23456" : proposal.fromTeamId, proposal.text])).toEqual([]);
  });
});

describe("a pin written by opening a real received share", () => {
  it("does not let the share dialog skip that team's safety code", async () => {
    const world = await cloudWorld([12345]);
    // The number pin says the person saw 12345's code, so only the key pin can ask again here.
    ownerSawPartnerCodes(world);
    const { owner } = world;
    const [partner] = world.partners as [typeof world.partners[0]];
    const at = await publishTo(partner, "partner-auto.auto.json", '{"kind":"auto"}\n');
    const checks = await partner.backend.checkPartnerKeys([owner.teamId]);
    await (await partner.backend.createShare({
      teamId: partner.teamId, autoId: at.autoId, revision: at.revisionId, audience: "teams", teamIds: [owner.teamId], level: "view", mode: "pinned",
      projection: '{"s":"partner"}', expectedKeys: { [owner.teamId]: checks[0]!.keyId },
    })).sent;

    const sharing = createCloudSharingApi(owner.backend, { now: () => NOW_MS });
    setSharingBackend(sharing, { signedIn: true, teamId: owner.teamId, teamNumber: 36596, teamName: "Horizon" }, { now: () => NOW_MS });
    await refreshReceived();
    expect(getCloud().received.map((share) => share.fromTeamNumber)).toEqual([12345]);

    // Opening the share pinned 12345's key, but nobody was shown its code, so the dialog shows it.
    expect((await sharing.checkPartnerKeys([12345])).map((warning) => [warning.kind, warning.teamNumber])).toEqual([["first-use", 12345]]);
    expect(await owner.backend.teamSafetyCode(partner.teamId)).toMatchObject({ pinned: false, serverKeyDiffers: false });
  });
});
