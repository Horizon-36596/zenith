/**
 * A device whose user is a member of a team holds that team's real key as a team pin. When the
 * server shows another key for that team at the same version, the device knows the key shown is not
 * the team's, so accepting a key change does not let a share be wrapped to it, and the safety code
 * this device gives for the team is the one of the key it holds.
 */
import { describe, expect, it } from "vitest";
import {
  MemoryDeviceKeyStore,
  commitShareKey,
  createTeamKeys,
  generateDeviceKeys,
  newShareKey,
  sealText,
  aadFor,
  shareProjectionDigest,
  signShareManifest,
  teamEncKeyFor,
  teamKeyDigest,
  teamSafetyCode,
  unwrapShareKeyAsTeam,
  openText,
  wrapShareKeyToTeam,
  type TeamEncKey,
} from "../src/crypto/index.js";
import { isCloudError, type CloudErrorCode } from "../src/errors.js";
import { MemoryTrustStore, readPin, writePartnerPin } from "../src/keys/trust.js";
import { MemoryBackend } from "../src/memory/memoryBackend.js";
import { MemoryDatabase } from "../src/memory/memoryStore.js";
import { uidOf, type Caller } from "./cryptoHelpers.js";
import type { DocData } from "../src/store.js";

/** Few PBKDF2 iterations for approval codes, as in `memory.keys.test.ts`: the count does not change what an approval checks. */
const FAST_APPROVAL_KDF = 10;

async function person(database: MemoryDatabase, uid: string, trust = new MemoryTrustStore()): Promise<MemoryBackend> {
  const backend = new MemoryBackend({ database, deviceKeys: new MemoryDeviceKeyStore(), trust });
  backend.signInAs(uid);
  await (await backend.saveProfile({ displayName: uid })).sent;
  return backend;
}

async function teamWithAuto(owner: MemoryBackend, number: number, name: string) {
  const created = await owner.createTeam({ number, name });
  await created.sent;
  const teamId = created.value.id;
  const auto = await owner.createAuto(teamId, { title: `${name} auto` });
  await auto.sent;
  const r1 = await owner.publishRevision({ teamId, autoId: auto.value.id, baseRevision: null, content: '{"s":"one"}' });
  await r1.sent;
  return { teamId, autoId: auto.value.id, r1: r1.value.id };
}

/** `member` joins `teamId` and its device is granted the team key, which pins it as a team pin. */
async function joinWithKey(owner: MemoryBackend, member: MemoryBackend, teamId: string): Promise<void> {
  const invite = await owner.createInvite(teamId, { role: "editor", autoApprove: true });
  await invite.sent;
  await (await member.redeemInvite(invite.value.code)).sent;
  const status = await member.teamKeyStatus(teamId);
  if (status.state !== "waiting") throw new Error("That device already holds the team key.");
  await (await owner.grantDeviceKey(teamId, status.device.deviceId, status.approvalCode)).sent;
  await member.listAutos(teamId);
}

async function code(promise: Promise<unknown>): Promise<CloudErrorCode | "allowed"> {
  try {
    await promise;
  } catch (error) {
    if (isCloudError(error)) return error.code;
    throw error;
  }
  return "allowed";
}

/** Shows `alice` the key `encKey` for team `teamId` whenever `showing()` is true. */
function showKeyToAlice(database: MemoryDatabase, teamId: string, encKey: TeamEncKey, showing: () => boolean = () => true): void {
  const realRead = database.read.bind(database);
  database.read = (caller: Caller, path: string) => {
    const doc = realRead(caller, path);
    return showing() && uidOf(caller) === "alice" && path === `teams/${teamId}` && doc !== null ? ({ ...doc, encKey } as unknown as DocData) : doc;
  };
}

const shares = (database: MemoryDatabase): string[] => database.paths().filter((path) => path.startsWith("shares/"));

describe("a key the server shows for a team this device holds the real key of, at the same version", () => {
  it("is refused whatever the answers say, when a different partner pin sits at that version too", async () => {
    const database = new MemoryDatabase({ approvalKdfIterations: FAST_APPROVAL_KDF });
    const aliceTrust = new MemoryTrustStore();
    const alice = await person(database, "alice", aliceTrust);
    const a = await teamWithAuto(alice, 1111, "Alpha");
    const tess = await person(database, "tess");
    const t = await teamWithAuto(tess, 3333, "Third");
    await joinWithKey(tess, alice, t.teamId);
    expect(readPin(aliceTrust, "alice", "team", t.teamId)?.v).toBe(1);
    const realCode = await teamSafetyCode((database.peek(`teams/${t.teamId}`) as { encKey: TeamEncKey }).encKey);

    // The server's own key pair for Third at version 1, which this device also holds a partner pin of.
    const forged = await createTeamKeys(t.teamId);
    const forgedEnc = teamEncKeyFor(forged.pair);
    writePartnerPin(aliceTrust, "alice", t.teamId, forgedEnc, "first-use");
    showKeyToAlice(database, t.teamId, forgedEnc);

    const check = (await alice.checkPartnerKeys([t.teamId]))[0]!;
    expect(check.status).toBe("member-key-differs");
    expect(await alice.teamSafetyCode(t.teamId)).toEqual({ safetyCode: realCode, pinned: true, serverKeyDiffers: true });
    const made = alice.createShare({
      teamId: a.teamId, autoId: a.autoId, revision: a.r1, audience: "teams", teamIds: [t.teamId], level: "view",
      projection: '{"secret":"alpha strategy"}', expectedKeys: { [t.teamId]: check.keyId }, acceptKeyChanges: [t.teamId],
    });
    await expect(made).rejects.toThrow(/holds that team's real key/);
    expect(await code(made)).toBe("key-changed");
    expect(shares(database)).toEqual([]);
    // Nothing the refused share would have pinned was pinned.
    expect(readPin(aliceTrust, "alice", "partner", t.teamId)).toMatchObject({ v: 1, firstUse: true });
  }, 60_000);

  it("is refused whatever the answers say, with no partner pin at all", async () => {
    const database = new MemoryDatabase({ approvalKdfIterations: FAST_APPROVAL_KDF });
    const alice = await person(database, "alice");
    const a = await teamWithAuto(alice, 1111, "Alpha");
    const tess = await person(database, "tess");
    const t = await teamWithAuto(tess, 3333, "Third");
    await joinWithKey(tess, alice, t.teamId);
    const realCode = await teamSafetyCode((database.peek(`teams/${t.teamId}`) as { encKey: TeamEncKey }).encKey);
    const forged = await createTeamKeys(t.teamId);
    showKeyToAlice(database, t.teamId, teamEncKeyFor(forged.pair));

    const check = (await alice.checkPartnerKeys([t.teamId]))[0]!;
    expect(check.status).toBe("member-key-differs");
    expect(await alice.teamSafetyCode(t.teamId)).toEqual({ safetyCode: realCode, pinned: true, serverKeyDiffers: true });
    expect(
      await code(
        alice.createShare({
          teamId: a.teamId, autoId: a.autoId, revision: a.r1, audience: "teams", teamIds: [t.teamId], level: "view",
          projection: '{"secret":"alpha strategy"}', expectedKeys: { [t.teamId]: check.keyId }, acceptKeyChanges: [t.teamId],
        }),
      ),
    ).toBe("key-changed");
    expect(shares(database)).toEqual([]);
  }, 60_000);

  it("is refused when the server first made a share from that team with its key, and the user joined the team for real later", async () => {
    const database = new MemoryDatabase({ approvalKdfIterations: FAST_APPROVAL_KDF });
    const aliceTrust = new MemoryTrustStore();
    const alice = await person(database, "alice", aliceTrust);
    const a = await teamWithAuto(alice, 1111, "Alpha");
    const tess = await person(database, "tess");
    const t = await teamWithAuto(tess, 3333, "Third");
    const forged = await createTeamKeys(t.teamId);
    const forgedEnc = teamEncKeyFor(forged.pair);
    let lie = true;
    showKeyToAlice(database, t.teamId, forgedEnc, () => lie);

    // A share "from" Third that the server made, signed with its own version 1.
    const shareId = "fakeShareFromThird00000";
    const device = await generateDeviceKeys();
    const to = (database.peek(`teams/${a.teamId}`) as { encKey: TeamEncKey }).encKey;
    const shareKey = await newShareKey(1);
    const expires = new Date(database.now().getTime() + 7 * 86_400_000);
    const projection = await sealText(shareKey, '{"server":"projection"}', aadFor.shareProjection({ shareId, autoId: t.autoId, kv: 1 }));
    const body = {
      shareId, ownerTeamId: t.teamId, autoId: t.autoId, revisionId: "r1fake", audience: "teams" as const, mode: "follow" as const, level: "view" as const,
      revoked: false, expiresAtMs: expires.getTime(), seq: 1, skv: 1, wkv: 1, okv: 1, device: device.deviceId, termsSeq: 1, termsDevices: [device.deviceId], choice: null,
      projection: await shareProjectionDigest({ shareId, projection }),
      teams: [[a.teamId, to.v, await teamKeyDigest({ teamId: a.teamId, v: to.v, fingerprint: to.fingerprint, signSpki: to.signSpki })] as const],
      commit: await commitShareKey({ shareId, shareKey }),
    };
    const now = database.now();
    database.seed(`shares/${shareId}`, {
      ownerTeamId: t.teamId, autoId: t.autoId, revision: "r1fake", audience: "teams", teamIds: [a.teamId], level: "view", mode: "follow",
      expiresAt: expires, revokedAt: null, createdBy: "someone", createdAt: now, updatedAt: now,
      projection,
      keyWraps: { [a.teamId]: await wrapShareKeyToTeam({ shareId, teamId: a.teamId, shareKey, encKey: to }) },
      manifest: await signShareManifest({ body, signingKey: forged.pair.signingKey, device }),
    } as unknown as DocData);
    database.seed(`teams/${a.teamId}/inbox/${shareId}`, { ownerTeamId: t.teamId, createdAt: now } as unknown as DocData);
    expect((await alice.listReceivedShares(a.teamId)).map((share) => share.id)).toEqual([shareId]);
    expect(readPin(aliceTrust, "alice", "partner", t.teamId)).toMatchObject({ v: 1, firstUse: true });

    // Later Alice joins Third for real, and her device pins Third's real key as a team pin.
    lie = false;
    await joinWithKey(tess, alice, t.teamId);
    expect(readPin(aliceTrust, "alice", "team", t.teamId)?.v).toBe(1);
    lie = true;

    const check = (await alice.checkPartnerKeys([t.teamId]))[0]!;
    expect(check.status).toBe("member-key-differs");
    expect(
      await code(
        alice.createShare({
          teamId: a.teamId, autoId: a.autoId, revision: a.r1, audience: "teams", teamIds: [t.teamId], level: "view",
          projection: '{"secret":"alpha strategy"}', expectedKeys: { [t.teamId]: check.keyId }, acceptKeyChanges: [t.teamId],
        }),
      ),
    ).toBe("key-changed");
    expect(shares(database).filter((path) => path !== `shares/${shareId}`)).toEqual([]);
  }, 60_000);
});

describe("a changed key of a partner team this device is not a member of", () => {
  it("can still be accepted after the person compared its safety code, and the share is wrapped to the key shown", async () => {
    const database = new MemoryDatabase({ approvalKdfIterations: FAST_APPROVAL_KDF });
    const aliceTrust = new MemoryTrustStore();
    const alice = await person(database, "alice", aliceTrust);
    const a = await teamWithAuto(alice, 1111, "Alpha");
    const tess = await person(database, "tess");
    const t = await teamWithAuto(tess, 3333, "Third");
    // Alice shares with Third once, which pins its key as a partner pin.
    const first = await alice.checkPartnerKeys([t.teamId]);
    await (
      await alice.createShare({
        teamId: a.teamId, autoId: a.autoId, revision: a.r1, audience: "teams", teamIds: [t.teamId], level: "view",
        projection: '{"s":"first"}', expectedKeys: { [t.teamId]: first[0]!.keyId },
      })
    ).sent;
    expect(readPin(aliceTrust, "alice", "team", t.teamId)).toBeNull();

    const other = await createTeamKeys(t.teamId);
    showKeyToAlice(database, t.teamId, teamEncKeyFor(other.pair));
    const check = (await alice.checkPartnerKeys([t.teamId]))[0]!;
    expect(check.status).toBe("changed");
    const made = await alice.createShare({
      teamId: a.teamId, autoId: a.autoId, revision: a.r1, audience: "teams", teamIds: [t.teamId], level: "view",
      projection: '{"s":"second"}', expectedKeys: { [t.teamId]: check.keyId }, acceptKeyChanges: [t.teamId],
    });
    await made.sent;
    const doc = database.peek(`shares/${made.value.id}`) as unknown as { keyWraps: Record<string, never>; projection: never };
    const key = await unwrapShareKeyAsTeam({ shareId: made.value.id, teamId: t.teamId, shareKeyVersion: 1, wrap: doc.keyWraps[t.teamId]!, pair: other.pair });
    expect(await openText(key, doc.projection, aadFor.shareProjection({ shareId: made.value.id, autoId: a.autoId, kv: 1 }))).toBe('{"s":"second"}');
  }, 60_000);
});
