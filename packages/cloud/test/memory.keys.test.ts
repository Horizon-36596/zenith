/**
 * End-to-end encryption through the whole client (spec 14), against `MemoryBackend`, whose rules
 * are the in-memory copy of cloud/firestore.rules. Each `MemoryBackend` is its own device, with its
 * own device keys and pins; `database.seed` plays a server that writes whatever it likes.
 */
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  aadFor,
  approvalCodeFor,
  createTeamKeys,
  deviceRecord,
  generateDeviceKeys,
  makeGrantProof,
  makeKeyGrant,
  MemoryDeviceKeyStore,
  newApprovalSecret,
  openText,
  teamEncKeyFor,
  unwrapWithPrivateKey,
  type Envelope,
  type PublicKeyWrap,
} from "../src/crypto/index.js";
import { importAesKey } from "../src/crypto/primitives.js";
import { isCloudError, type CloudErrorCode } from "../src/errors.js";
import { MemoryBackend } from "../src/memory/memoryBackend.js";
import { MemoryDatabase } from "../src/memory/memoryStore.js";
import { MemoryTrustStore, StorageTrustStore } from "../src/keys/trust.js";
import { SERVER_TIME, type DocData, type DocStore } from "../src/store.js";

/**
 * Few PBKDF2 iterations for approval codes. Every approval here derives the code's key on the
 * approver and again on the device, and with the app's 600,000 iterations each takes about a third
 * of a second, which these tests do not check: the test that approves four devices spent two of
 * its two and a half seconds on it and ran past 5 s under load. The count does not change what an
 * approval checks; `crypto.vectors.test.ts` checks the real one.
 */
const FAST_APPROVAL_KDF = 10;

async function code(promise: Promise<unknown>): Promise<CloudErrorCode | "allowed"> {
  try {
    await promise;
  } catch (error) {
    if (isCloudError(error)) return error.code;
    throw error;
  }
  return "allowed";
}

/** A signed-in member on a device of their own, with a saved profile. */
async function person(database: MemoryDatabase, uid: string, deviceKeys = new MemoryDeviceKeyStore(), trust = new MemoryTrustStore()): Promise<MemoryBackend> {
  const backend = new MemoryBackend({ database, deviceKeys, trust });
  backend.signInAs(uid);
  await (await backend.saveProfile({ displayName: uid })).sent;
  return backend;
}

/** The device id and approval code a waiting device shows on its screen for `teamId`. */
async function codeOf(device: MemoryBackend, teamId: string): Promise<{ deviceId: string; approvalCode: string }> {
  const status = await device.teamKeyStatus(teamId);
  if (status.state !== "waiting") throw new Error("That device already holds the team key.");
  return { deviceId: status.device.deviceId, approvalCode: status.approvalCode };
}

/**
 * Gives the team key to each of `devices`, typing the code each one shows, as `granter`, and has
 * each device open it, as the app does at once. A grant not yet opened when the key rotates loses
 * its approval, and its device asks again.
 */
async function grantAll(granter: MemoryBackend, teamId: string, ...devices: MemoryBackend[]): Promise<void> {
  for (const device of devices) {
    const { deviceId, approvalCode } = await codeOf(device, teamId);
    await (await granter.grantDeviceKey(teamId, deviceId, approvalCode)).sent;
    await device.teamKeyStatus(teamId);
  }
}

/** Joins `teamId` as `role` through an invite that approves at once, and gets the key from `owner`. */
async function join(database: MemoryDatabase, owner: MemoryBackend, teamId: string, uid: string, role: "admin" | "editor" | "viewer" = "editor", deviceKeys?: MemoryDeviceKeyStore, trust?: MemoryTrustStore) {
  const member = await person(database, uid, deviceKeys, trust);
  // An admin invite never approves at once (owner ruling 2026-10-25): an admin waits, and is approved with the key.
  const invite = await owner.createInvite(teamId, { role, autoApprove: role !== "admin" });
  await invite.sent;
  await (await member.redeemInvite(invite.value.code)).sent;
  if (role === "admin") {
    await (await owner.approveMember(teamId, uid, await codeOf(member, teamId))).sent;
    await member.teamKeyStatus(teamId);
  } else {
    await grantAll(owner, teamId, member);
  }
  return member;
}

/** A team with one auto and its first revision. */
async function teamWithAuto(database: MemoryDatabase, uid: string, number: number | null, name: string, title = `${name} secret auto`) {
  const owner = await person(database, uid);
  const created = await owner.createTeam({ number, name });
  await created.sent;
  const teamId = created.value.id;
  const auto = await owner.createAuto(teamId, { title });
  await auto.sent;
  const r1 = await owner.publishRevision({ teamId, autoId: auto.value.id, baseRevision: null, content: `{"secret":"${name} path one"}` });
  await r1.sent;
  return { owner, teamId, autoId: auto.value.id, r1: r1.value.id, recoveryCode: created.value.recoveryCode };
}

/** Every string anywhere in a document, and every byte field's gzip text when it is plain gzip. */
function textsIn(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (value instanceof Uint8Array) {
    out.push(Buffer.from(value).toString("latin1"));
    try {
      out.push(gunzipSync(value).toString("utf8"));
    } catch {
      // Ciphertext is not gzip, which is the point.
    }
  } else if (Array.isArray(value)) for (const item of value) textsIn(item, out);
  else if (value !== null && typeof value === "object" && !(value instanceof Date)) for (const item of Object.values(value)) textsIn(item, out);
  return out;
}

describe("encrypted sharing between two teams", () => {
  it("shares each way, by link, and round-trips a proposal, with nothing readable on the server", async () => {
    const database = new MemoryDatabase({ approvalKdfIterations: FAST_APPROVAL_KDF });
    const a = await teamWithAuto(database, "alice", 1111, "Alpha");
    const p = await teamWithAuto(database, "olga", 2222, "Partner");

    // Alpha to Partner, propose level.
    const toPartner = await a.owner.createShare({
      teamId: a.teamId, autoId: a.autoId, revision: a.r1, audience: "teams", teamIds: [p.teamId], level: "propose", projection: '{"marker":"ALPHA-PROJECTION"}',
    });
    await toPartner.sent;
    expect((await p.owner.listReceivedShares(p.teamId)).map((s) => s.projection)).toEqual(['{"marker":"ALPHA-PROJECTION"}']);
    expect((await a.owner.listTeamShares(a.teamId))[0]?.projection).toBe('{"marker":"ALPHA-PROJECTION"}');

    // Partner to Alpha.
    const toAlpha = await p.owner.createShare({
      teamId: p.teamId, autoId: p.autoId, revision: p.r1, audience: "teams", teamIds: [a.teamId], projection: '{"marker":"PARTNER-PROJECTION"}',
    });
    await toAlpha.sent;
    expect((await a.owner.listReceivedShares(a.teamId)).map((s) => s.projection)).toEqual(['{"marker":"PARTNER-PROJECTION"}']);
    expect((await a.owner.getShare(toAlpha.value.id))?.projection).toBe('{"marker":"PARTNER-PROJECTION"}');

    // A link share: the id comes from the secret, and the secret opens it signed out.
    const link = await a.owner.createShare({ teamId: a.teamId, autoId: a.autoId, revision: a.r1, audience: "link", projection: '{"marker":"LINK-PROJECTION"}' });
    await link.sent;
    const anyone = new MemoryBackend({ database });
    expect((await anyone.openLinkShare(link.value.linkSecret ?? ""))?.projection).toBe('{"marker":"LINK-PROJECTION"}');
    expect(await anyone.openLinkShare("A".repeat(22))).toBe(null);
    expect(await anyone.openLinkShare("not a secret")).toBe(null);

    // A proposal from Partner, read by both teams.
    const proposal = await p.owner.sendProposal({ shareId: toPartner.value.id, fromTeamId: p.teamId, baseRevision: a.r1, diff: '{"marker":"PROPOSAL-DIFF"}' });
    await proposal.sent;
    expect((await a.owner.listProposals(a.teamId, "received")).map((x) => x.diff)).toEqual(['{"marker":"PROPOSAL-DIFF"}']);
    expect((await p.owner.listProposals(p.teamId, "sent")).map((x) => x.diff)).toEqual(['{"marker":"PROPOSAL-DIFF"}']);
    await (await a.owner.decideProposal(proposal.value.id, "accepted")).sent;
    expect((await p.owner.listProposals(p.teamId, "sent"))[0]?.status).toBe("accepted");

    // The activity log opens the sealed title for the team.
    expect((await a.owner.listActivity(a.teamId)).find((e) => e.kind === "auto.create")?.detail).toBe("Alpha secret auto");

    // The raw store holds none of it: no title, path, projection or diff, in the clear or as plain gzip.
    const markers = ["Alpha secret auto", "Partner secret auto", "path one", "ALPHA-PROJECTION", "PARTNER-PROJECTION", "LINK-PROJECTION", "PROPOSAL-DIFF"];
    const texts = database.paths().flatMap((path) => textsIn(database.peek(path)));
    expect(texts.length).toBeGreaterThan(100);
    for (const marker of markers) expect(texts.filter((text) => text.includes(marker)), marker).toEqual([]);
    // Nor the link secret, which only the link and the sealed linkWrap carry.
    expect(texts.filter((text) => text.includes(link.value.linkSecret ?? "?")), "link secret").toEqual([]);
  });

  it("refuses a partner key that changed under the same version, until the person accepts it, and takes a rotated one", async () => {
    const database = new MemoryDatabase({ approvalKdfIterations: FAST_APPROVAL_KDF });
    const a = await teamWithAuto(database, "alice", 1111, "Alpha");
    const p = await teamWithAuto(database, "olga", 2222, "Partner");
    // Each share names the key whose safety code the check just showed, and accepting a changed key
    // accepts that key.
    const share = async (accept = false) => {
      const shown = (await a.owner.checkPartnerKeys([p.teamId]))[0]!.keyId;
      return a.owner.createShare({
        teamId: a.teamId, autoId: a.autoId, revision: a.r1, audience: "teams", teamIds: [p.teamId], projection: "{}",
        expectedKeys: { [p.teamId]: shown }, ...(accept ? { acceptKeyChanges: [p.teamId] } : {}),
      });
    };
    expect((await a.owner.checkPartnerKeys([p.teamId]))[0]?.status).toBe("first-use");
    await (await share()).sent;
    expect((await a.owner.checkPartnerKeys([p.teamId]))[0]?.status).toBe("same");

    // The server swaps in a key of its own under the same version.
    const real = database.peek(`teams/${p.teamId}`) as DocData;
    const forged = await createTeamKeys(p.teamId);
    database.seed(`teams/${p.teamId}`, { ...real, encKey: teamEncKeyFor(forged.pair) });
    const check = (await a.owner.checkPartnerKeys([p.teamId]))[0];
    expect(check?.status).toBe("changed");
    expect(check?.safetyCode).toMatch(/^\d{4} \d{4} \d{4} \d{4} \d{4}$/);
    expect(await code(share())).toBe("key-changed");
    expect(await code(share(true).then((q) => q.sent))).toBe("allowed");

    // Back to the real key, which the person accepts again after comparing the safety code.
    database.seed(`teams/${p.teamId}`, real);
    expect((await a.owner.checkPartnerKeys([p.teamId]))[0]?.status).toBe("changed");
    await (await share(true)).sent;
    expect((await a.owner.checkPartnerKeys([p.teamId]))[0]?.status).toBe("same");

    // A real rotation is a new version signed by the pinned one, which the device takes.
    const bea = await join(database, p.owner, p.teamId, "bea");
    await (await p.owner.removeMember(p.teamId, "bea")).sent;
    expect(bea).toBeDefined();
    expect((await a.owner.checkPartnerKeys([p.teamId]))[0]).toMatchObject({ status: "rotated", keyVersion: 2 });
    await (await share()).sent;
    expect((await a.owner.checkPartnerKeys([p.teamId]))[0]?.status).toBe("same");
  });
});

describe("a server that answers the same read two ways", () => {
  it("wraps a share key to the partner key the device compared, not to what a second read shows", async () => {
    const database = new MemoryDatabase({ approvalKdfIterations: FAST_APPROVAL_KDF });
    const p = await teamWithAuto(database, "olga", 2222, "Partner");
    const forged = await createTeamKeys(p.teamId);
    // Alice's server answers reads of the partner team honestly up to `honestReads`, then with a key of its own.
    let reads = 0;
    let honestReads = Number.POSITIVE_INFINITY;
    class TwoFacedServer extends MemoryBackend {
      protected override store(): DocStore {
        const inner = super.store();
        const getWithPending = async (path: string) => {
          const read = await inner.getWithPending(path);
          if (path !== `teams/${p.teamId}` || read.data === null) return read;
          reads += 1;
          return reads > honestReads ? { ...read, data: { ...read.data, encKey: teamEncKeyFor(forged.pair) } } : read;
        };
        return {
          get: async (path) => (await getWithPending(path)).data,
          getWithPending,
          list: (query) => inner.list(query),
          commit: (writes) => inner.commit(writes),
        };
      }
    }
    const alice = new TwoFacedServer({ database });
    alice.signInAs("alice");
    await (await alice.saveProfile({ displayName: "alice" })).sent;
    const team = await alice.createTeam({ number: 1111, name: "Alpha" });
    await team.sent;
    const auto = await alice.createAuto(team.value.id, { title: "Alpha auto" });
    await auto.sent;
    const r1 = await alice.publishRevision({ teamId: team.value.id, autoId: auto.value.id, baseRevision: null, content: "{}" });
    await r1.sent;
    const share = () =>
      alice.createShare({ teamId: team.value.id, autoId: auto.value.id, revision: r1.value.id, audience: "teams", teamIds: [p.teamId], projection: '{"kind":"TWO-FACED"}' });

    await (await share()).sent;
    // From now on only the next read of the partner team is honest.
    honestReads = reads + 1;
    const second = await share();
    await second.sent;
    expect((await p.owner.getShare(second.value.id, p.teamId))?.projection).toBe('{"kind":"TWO-FACED"}');
    // The pin still holds the real key, so the forged one now shows as changed.
    expect((await alice.checkPartnerKeys([p.teamId]))[0]?.status).toBe("changed");
  });
});

describe("getting the team key to a device", () => {
  it("gives it to a new member with the Approve that makes them active, after a code check", async () => {
    const database = new MemoryDatabase({ approvalKdfIterations: FAST_APPROVAL_KDF });
    const a = await teamWithAuto(database, "alice", null, "Alpha");
    const nina = await person(database, "nina");
    const invite = await a.owner.createInvite(a.teamId, { role: "viewer" });
    await invite.sent;
    await (await nina.redeemInvite(invite.value.code)).sent;
    expect(await code(nina.listAutos(a.teamId))).toBe("permission-denied");

    const status = await nina.teamKeyStatus(a.teamId);
    expect(status).toMatchObject({ state: "waiting", requested: true, membersMayApproveDevices: false });
    const requests = await a.owner.listKeyRequests(a.teamId);
    expect(requests).toMatchObject([{ uid: "nina", displayName: "nina", kind: "member", isYours: false }]);
    // The approver's sheet shows the same code as the device's own screen.
    expect(requests[0]?.code).toBe(status.device.code);

    if (status.state !== "waiting") throw new Error("Nina's device should be waiting.");
    expect(status.approvalCode).toMatch(/^[0-9A-HJKMNP-TV-Z]{6}-[0-9A-HJKMNP-TV-Z]{6}-[0-9A-HJKMNP-TV-Z]{6}$/);
    // A code with one character wrong in its secret part, or another device's code, is refused, and
    // nothing is written.
    expect(await code(a.owner.approveMember(a.teamId, "nina", { deviceId: status.device.deviceId, approvalCode: status.approvalCode.slice(0, 7) }))).toBe("wrong-code");
    const otherCode = await approvalCodeFor({ teamId: a.teamId, uid: "nina", fingerprint: (await generateDeviceKeys()).fingerprint }, newApprovalSecret());
    expect(await code(a.owner.approveMember(a.teamId, "nina", { deviceId: status.device.deviceId, approvalCode: otherCode }))).toBe("wrong-code");
    expect(await code(a.owner.approveMember(a.teamId, "nina", { deviceId: status.device.deviceId } as never))).toBe("invalid");
    expect(await nina.teamKeyStatus(a.teamId)).toMatchObject({ state: "waiting", approvalCode: status.approvalCode });

    // The UI may pass the device list it showed as well; it is ignored beside the one device named.
    await (await a.owner.approveMember(a.teamId, "nina", { deviceId: status.device.deviceId, approvalCode: status.approvalCode.toLowerCase(), deviceIds: ["d_ignored"] } as never)).sent;
    expect(await nina.teamKeyStatus(a.teamId)).toMatchObject({ state: "ready", keyVersion: 1, rotationPending: false });
    expect((await nina.listAutos(a.teamId)).map((x) => x.title)).toEqual(["Alpha secret auto"]);
    expect(await a.owner.listKeyRequests(a.teamId)).toEqual([]);
  });

  it("refuses a typo anywhere in the code at once, and a device refuses a grant whose MAC is not its code's, asks again, and takes the right one", async () => {
    const database = new MemoryDatabase({ approvalKdfIterations: FAST_APPROVAL_KDF });
    const a = await teamWithAuto(database, "alice", null, "Alpha");
    const trust = new MemoryTrustStore();
    const nina = new MemoryBackend({ database, trust });
    nina.signInAs("nina");
    await (await nina.saveProfile({ displayName: "nina" })).sent;
    const invite = await a.owner.createInvite(a.teamId, { role: "viewer" });
    await invite.sent;
    await (await nina.redeemInvite(invite.value.code)).sent;
    const { deviceId, approvalCode } = await codeOf(nina, a.teamId);
    expect(trust.get(`zenith.approval.nina.${a.teamId}`)).toMatch(/^\{/);
    const last = approvalCode.slice(-1);
    const typo = `${approvalCode.slice(0, -1)}${last === "0" ? "1" : "0"}`;

    // The random last part is hashed into the first, so the approver's device sees the typo.
    expect(await code(a.owner.approveMember(a.teamId, "nina", { deviceId, approvalCode: typo }))).toBe("wrong-code");
    expect(database.peek(`teams/${a.teamId}/keyGrants/${deviceId}`)).toBe(null);

    // A grant whose MAC does not check (here the server changed it) is refused by the device itself.
    await (await a.owner.approveMember(a.teamId, "nina", { deviceId, approvalCode })).sent;
    const grantPath = `teams/${a.teamId}/keyGrants/${deviceId}`;
    const grant = database.peek(grantPath) as DocData & { approval: { mac: Uint8Array } };
    const mac = new Uint8Array(grant.approval.mac);
    mac[0] = (mac[0] ?? 0) ^ 1;
    database.seed(grantPath, { ...grant, approval: { ...grant.approval, mac } });
    expect(await code(nina.listAutos(a.teamId))).toBe("no-key");
    expect(await nina.teamKeyStatus(a.teamId)).toMatchObject({ state: "waiting", requested: false, approvalCode });
    await (await nina.requestTeamKey(a.teamId)).sent;
    expect(database.peek(grantPath)).toBe(null);
    await (await a.owner.grantDeviceKey(a.teamId, deviceId, approvalCode)).sent;
    expect((await nina.listAutos(a.teamId)).map((x) => x.title)).toEqual(["Alpha secret auto"]);
    // The code is used once: the device forgets it once the grant is accepted.
    expect(trust.get(`zenith.approval.nina.${a.teamId}`)).toBe("");
  });

  it("gives it to a member's new device from another device of theirs, and from other members only when the team allows", async () => {
    const database = new MemoryDatabase({ approvalKdfIterations: FAST_APPROVAL_KDF });
    const a = await teamWithAuto(database, "alice", null, "Alpha");
    const eveKeys = new MemoryDeviceKeyStore();
    const eve = await join(database, a.owner, a.teamId, "eve", "editor", eveKeys);
    const bea = await join(database, a.owner, a.teamId, "bea", "editor");

    // Eve's laptop: the same account on a new device.
    const laptop = new MemoryBackend({ database });
    laptop.signInAs("eve");
    expect(await laptop.teamKeyStatus(a.teamId)).toMatchObject({ state: "waiting", requested: false });
    expect(await code(laptop.listAutos(a.teamId))).toBe("no-key");
    await (await laptop.requestTeamKey(a.teamId)).sent;
    const laptopId = (await laptop.thisDevice()).deviceId;

    // Bea may not approve it while the setting is off, and does not even see it.
    expect(await bea.listKeyRequests(a.teamId)).toEqual([]);
    const laptopCode = (await codeOf(laptop, a.teamId)).approvalCode;
    expect(await code(bea.grantDeviceKey(a.teamId, laptopId, laptopCode))).toBe("not-found");
    // Eve's own first device does, with the code on the laptop's screen and no other.
    const seen = await eve.listKeyRequests(a.teamId);
    expect(seen).toMatchObject([{ deviceId: laptopId, kind: "device", isYours: true }]);
    expect(await code(eve.grantDeviceKey(a.teamId, laptopId, "000000-000000-000000"))).toBe("wrong-code");
    expect(await code(eve.grantDeviceKey(a.teamId, laptopId, ""))).toBe("wrong-code");
    await (await eve.grantDeviceKey(a.teamId, laptopId, laptopCode)).sent;
    expect((await laptop.listAutos(a.teamId)).map((x) => x.title)).toEqual(["Alpha secret auto"]);

    // With the setting on, any active member approves another's new device.
    await (await a.owner.updateTeamSettings(a.teamId, { membersMayApproveDevices: true })).sent;
    const phone = new MemoryBackend({ database });
    phone.signInAs("eve");
    await (await phone.requestTeamKey(a.teamId)).sent;
    expect(await phone.teamKeyStatus(a.teamId)).toMatchObject({ state: "waiting", requested: true, membersMayApproveDevices: true });
    const phoneId = (await phone.thisDevice()).deviceId;
    expect((await bea.listKeyRequests(a.teamId)).map((r) => r.deviceId)).toEqual([phoneId]);
    await (await bea.grantDeviceKey(a.teamId, phoneId, (await codeOf(phone, a.teamId)).approvalCode)).sent;
    expect((await phone.listAutos(a.teamId)).length).toBe(1);
    expect((await a.owner.listTeamDevices(a.teamId)).filter((d) => d.uid === "eve")).toHaveLength(3);
    expect(eveKeys).toBeDefined();
  }, 60_000);

  it("opens a new grant once when two reads of the key overlap, so neither finds the code already used", async () => {
    const database = new MemoryDatabase({ approvalKdfIterations: FAST_APPROVAL_KDF });
    const a = await teamWithAuto(database, "alice", null, "Alpha");
    await join(database, a.owner, a.teamId, "eve", "editor");
    const laptop = new MemoryBackend({ database });
    laptop.signInAs("eve");
    await (await laptop.requestTeamKey(a.teamId)).sent;
    const { deviceId, approvalCode } = await codeOf(laptop, a.teamId);
    await (await a.owner.grantDeviceKey(a.teamId, deviceId, approvalCode)).sent;

    // The page reads the key when the team is chosen and again when it is refreshed, at once. Each
    // open of a first grant checks it against the approval code, and the first to finish forgets the
    // code, so a second check running beside it would find none and call the device still waiting.
    // The second open waits for the first instead: the grant is read once.
    const grantPath = `teams/${a.teamId}/keyGrants/${deviceId}`;
    const read = database.read.bind(database);
    let grantReads = 0;
    database.read = (uid, path) => {
      if (path === grantPath) grantReads += 1;
      return read(uid, path);
    };
    const [first, second] = await Promise.all([laptop.teamKeyStatus(a.teamId), laptop.teamKeyStatus(a.teamId)]);
    expect([first.state, second.state]).toEqual(["ready", "ready"]);
    expect(grantReads).toBe(1);
    expect((await laptop.teamKeyStatus(a.teamId)).state).toBe("ready");
  });
});

describe("a browser that cannot save keys", () => {
  it("keeps the approval code for the session, says it was not saved, and takes the key with that code", async () => {
    const database = new MemoryDatabase({ approvalKdfIterations: FAST_APPROVAL_KDF });
    const a = await teamWithAuto(database, "alice", null, "Alpha");
    const full = {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    const bea = await person(database, "bea", undefined, new StorageTrustStore(full));
    const invite = await a.owner.createInvite(a.teamId, { role: "editor", autoApprove: true });
    await invite.sent;
    await (await bea.redeemInvite(invite.value.code)).sent;

    const first = await bea.teamKeyStatus(a.teamId);
    const again = await bea.teamKeyStatus(a.teamId);
    if (first.state !== "waiting" || again.state !== "waiting") throw new Error("Bea's device should be waiting for the key.");
    expect(first.savedOnDevice).toBe(false);
    expect(again.approvalCode).toBe(first.approvalCode);
    await (await a.owner.grantDeviceKey(a.teamId, first.device.deviceId, first.approvalCode)).sent;
    expect((await bea.teamKeyStatus(a.teamId)).state).toBe("ready");
    expect((await bea.listAutos(a.teamId)).map((x) => x.title)).toEqual(["Alpha secret auto"]);
  });

  it("says the code was saved when the storage takes it", async () => {
    const database = new MemoryDatabase({ approvalKdfIterations: FAST_APPROVAL_KDF });
    const a = await teamWithAuto(database, "alice", null, "Alpha");
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => void values.set(key, value) };
    const bea = await person(database, "bea", undefined, new StorageTrustStore(storage));
    const invite = await a.owner.createInvite(a.teamId, { role: "editor", autoApprove: true });
    await invite.sent;
    await (await bea.redeemInvite(invite.value.code)).sent;
    expect(await bea.teamKeyStatus(a.teamId)).toMatchObject({ state: "waiting", savedOnDevice: true });
    expect([...values.keys()].some((key) => key.startsWith("zenith."))).toBe(true);
  });
});

describe("taking the key away", () => {
  it("rotates on removal in one write, so the removed member's old key opens nothing new", async () => {
    const database = new MemoryDatabase({ approvalKdfIterations: FAST_APPROVAL_KDF });
    const a = await teamWithAuto(database, "alice", null, "Alpha");
    const eveKeys = new MemoryDeviceKeyStore();
    const eve = await join(database, a.owner, a.teamId, "eve", "editor", eveKeys);
    const bea = await join(database, a.owner, a.teamId, "bea", "editor");
    const eveDevice = (await eve.thisDevice()).deviceId;
    const eveGrant = database.peek(`teams/${a.teamId}/keyGrants/${eveDevice}`) as { wrap: PublicKeyWrap };

    await (await a.owner.removeMember(a.teamId, "eve")).sent;
    expect((database.peek(`teams/${a.teamId}`) as { encKey: { v: number } }).encKey.v).toBe(2);
    expect(database.peek(`teams/${a.teamId}/keyGrants/${eveDevice}`)).toBe(null);
    expect(database.peek(`teams/${a.teamId}/teamKeys/2`)).not.toBe(null);
    expect((database.peek(`teams/${a.teamId}/recovery/current`) as { kv: number }).kv).toBe(2);
    expect(await code(eve.listAutos(a.teamId))).toBe("permission-denied");
    expect((await a.owner.listActivity(a.teamId)).some((e) => e.kind === "key.rotate")).toBe(true);

    // Everyone who stays reads old and new, and new content is under key 2.
    const r2 = await bea.publishRevision({ teamId: a.teamId, autoId: a.autoId, baseRevision: a.r1, content: '{"after":"removal"}' });
    await r2.sent;
    const sealed = (database.peek(`teams/${a.teamId}/autos/${a.autoId}/revisions/${r2.value.id}`) as { content: Envelope }).content;
    expect(sealed.kv).toBe(2);
    expect((await bea.listRevisions(a.teamId, a.autoId)).map((r) => r.content)).toEqual(['{"secret":"Alpha path one"}', '{"after":"removal"}']);

    // Even with a copy of the ciphertext from the server, Eve's key 1 opens neither key 2 nor what it seals.
    const eveKeysNow = await eveKeys.load("eve");
    const raw = await unwrapWithPrivateKey(eveKeysNow!.encryption.privateKey, eveGrant.wrap, aadFor.keyGrant({ teamId: a.teamId, deviceId: eveDevice, kv: 1 }));
    const key1 = { version: 1, key: await importAesKey(raw, false) };
    const aad = aadFor.revision({ teamId: a.teamId, autoId: a.autoId, revisionId: r2.value.id, field: "content", kv: 2 });
    await expect(openText(key1, sealed, aad)).rejects.toThrow();
    await expect(openText({ version: 2, key: key1.key }, sealed, aad)).rejects.toThrow();
  });

  it("marks the key rotation pending when a member leaves, and an admin completes it", async () => {
    const database = new MemoryDatabase({ approvalKdfIterations: FAST_APPROVAL_KDF });
    const a = await teamWithAuto(database, "alice", null, "Alpha");
    const eve = await join(database, a.owner, a.teamId, "eve");
    const bea = await join(database, a.owner, a.teamId, "bea", "viewer");
    const eveDevice = (await eve.thisDevice()).deviceId;
    await (await eve.leaveTeam(a.teamId)).sent;
    expect(database.peek(`teams/${a.teamId}/keyGrants/${eveDevice}`)).toBe(null);
    expect(await a.owner.teamKeyStatus(a.teamId)).toMatchObject({ state: "ready", keyVersion: 1, rotationPending: true });

    // A viewer cannot rotate; an owner does.
    expect(await code(bea.completeKeyRotation(a.teamId).then((q) => q.sent))).not.toBe("allowed");
    await (await a.owner.completeKeyRotation(a.teamId)).sent;
    expect(await a.owner.teamKeyStatus(a.teamId)).toMatchObject({ keyVersion: 2, rotationPending: false });
    expect(await bea.teamKeyStatus(a.teamId)).toMatchObject({ state: "ready", keyVersion: 2 });
    expect((await bea.listAutos(a.teamId)).length).toBe(1);
  });

  it("revokes one device: an admin rotates at once, a member marks it pending", async () => {
    const database = new MemoryDatabase({ approvalKdfIterations: FAST_APPROVAL_KDF });
    const a = await teamWithAuto(database, "alice", null, "Alpha");
    const eve = await join(database, a.owner, a.teamId, "eve");
    const laptopKeys = new MemoryDeviceKeyStore();
    const laptop = new MemoryBackend({ database, deviceKeys: laptopKeys });
    laptop.signInAs("eve");
    await (await laptop.requestTeamKey(a.teamId)).sent;
    await grantAll(eve, a.teamId, laptop);
    const laptopId = (await laptop.thisDevice()).deviceId;
    expect((await laptop.listAutos(a.teamId)).length).toBe(1);

    // Revoking deletes the grant; the laptop is locked out of the key from its next session, and
    // out of anything new once an owner or admin rotates, which the pending mark asks for. (The
    // rules cannot tell one of Eve's devices from another, so only the key keeps it out.)
    await (await eve.revokeDevice(a.teamId, laptopId)).sent;
    const laptopAgain = new MemoryBackend({ database, deviceKeys: laptopKeys });
    laptopAgain.signInAs("eve");
    expect(await code(laptopAgain.listAutos(a.teamId))).toBe("no-key");
    expect(await a.owner.teamKeyStatus(a.teamId)).toMatchObject({ rotationPending: true });

    const eveId = (await eve.thisDevice()).deviceId;
    await (await a.owner.revokeDevice(a.teamId, eveId)).sent;
    expect(await a.owner.teamKeyStatus(a.teamId)).toMatchObject({ keyVersion: 2, rotationPending: false });
    expect(await code(eve.listAutos(a.teamId))).toBe("no-key");
    expect(await eve.teamKeyStatus(a.teamId)).toMatchObject({ state: "waiting" });
  });
});

describe("the team recovery code", () => {
  it("unlocks the team on a new device after every device is lost, after a rotation too, and can be replaced", async () => {
    const database = new MemoryDatabase({ approvalKdfIterations: FAST_APPROVAL_KDF });
    const a = await teamWithAuto(database, "alice", null, "Alpha");
    expect(a.recoveryCode).toMatch(/^ZNTH(-[0-9A-Z]{5}){4}-[0-9A-Z]{6}$/);
    await join(database, a.owner, a.teamId, "eve");
    await (await a.owner.removeMember(a.teamId, "eve")).sent;

    // Alice's only device is gone: a new one has no key, and a wrong code opens nothing.
    const fresh = new MemoryBackend({ database });
    fresh.signInAs("alice");
    expect(await fresh.teamKeyStatus(a.teamId)).toMatchObject({ state: "waiting" });
    const wrong = `${a.recoveryCode.slice(0, -2)}${a.recoveryCode.endsWith("00") ? "11" : "00"}`;
    expect(await code(fresh.useRecoveryCode(a.teamId, wrong))).toBe("invalid");
    expect(await code(fresh.useRecoveryCode(a.teamId, "ZNTH-00000"))).toBe("invalid");

    // An owner's device that uses the code makes the next key in the same write.
    await (await fresh.useRecoveryCode(a.teamId, a.recoveryCode.toLowerCase())).sent;
    expect(await fresh.teamKeyStatus(a.teamId)).toMatchObject({ state: "ready", keyVersion: 3 });
    expect((await fresh.openRevision(a.teamId, a.autoId, a.r1))?.content).toBe('{"secret":"Alpha path one"}');
    expect((await fresh.listActivity(a.teamId)).some((e) => e.kind === "recovery.use")).toBe(true);

    // A new code replaces the old one; only an owner makes one.
    const replaced = await fresh.replaceRecoveryCode(a.teamId);
    await replaced.sent;
    const another = new MemoryBackend({ database });
    another.signInAs("alice");
    expect(await code(another.useRecoveryCode(a.teamId, a.recoveryCode))).toBe("invalid");
    await (await another.useRecoveryCode(a.teamId, replaced.value.recoveryCode)).sent;
    expect((await another.listAutos(a.teamId)).length).toBe(1);
  });

  it("while a rotation is pending, rotates when an owner uses it, and waits for one when anyone else does", async () => {
    const database = new MemoryDatabase({ approvalKdfIterations: FAST_APPROVAL_KDF });
    const a = await teamWithAuto(database, "alice", null, "Alpha");
    const eve = await join(database, a.owner, a.teamId, "eve");
    const vic = await join(database, a.owner, a.teamId, "vic", "viewer");
    await (await eve.leaveTeam(a.teamId)).sent;
    expect(await a.owner.teamKeyStatus(a.teamId)).toMatchObject({ keyVersion: 1, rotationPending: true });

    // A viewer's new device cannot grant itself while the key waits to be rotated.
    const vicPhone = new MemoryBackend({ database });
    vicPhone.signInAs("vic");
    expect(await code(vicPhone.useRecoveryCode(a.teamId, a.recoveryCode))).toBe("invalid");
    expect(vic).toBeDefined();

    // Alice's new device does, and rotates the key in the same write.
    const fresh = new MemoryBackend({ database });
    fresh.signInAs("alice");
    await (await fresh.useRecoveryCode(a.teamId, a.recoveryCode)).sent;
    expect(await fresh.teamKeyStatus(a.teamId)).toMatchObject({ state: "ready", keyVersion: 2, rotationPending: false });
    expect((await fresh.listAutos(a.teamId)).map((x) => x.title)).toEqual(["Alpha secret auto"]);
    expect(await vic.teamKeyStatus(a.teamId)).toMatchObject({ state: "ready", keyVersion: 2 });
    expect(await code(eve.listAutos(a.teamId))).toBe("permission-denied");
  });

  it("is refused to someone who is not an active member, whatever code they hold", async () => {
    const database = new MemoryDatabase({ approvalKdfIterations: FAST_APPROVAL_KDF });
    const a = await teamWithAuto(database, "alice", null, "Alpha");
    const mallory = await person(database, "mallory");
    expect(await code(mallory.useRecoveryCode(a.teamId, a.recoveryCode))).toBe("permission-denied");
  });
});

describe("re-keying a share", () => {
  it("takes a team off with a new key, and keeps older proposals readable to both teams", async () => {
    const database = new MemoryDatabase({ approvalKdfIterations: FAST_APPROVAL_KDF });
    const a = await teamWithAuto(database, "alice", 1111, "Alpha");
    const p = await teamWithAuto(database, "olga", 2222, "Partner");
    const q = await teamWithAuto(database, "quinn", 3333, "Third");
    // Alice is shown both teams' safety codes, so her device keeps both keys as checked, and still
    // lists Third's proposal once Third is taken off the share.
    const shown = await a.owner.checkPartnerKeys([p.teamId, q.teamId]);
    const share = await a.owner.createShare({
      teamId: a.teamId, autoId: a.autoId, revision: a.r1, audience: "teams", teamIds: [p.teamId, q.teamId], level: "propose", projection: '{"v":"before"}',
      expectedKeys: Object.fromEntries(shown.map((check) => [check.teamId, check.keyId])),
    });
    await share.sent;
    const first = await p.owner.sendProposal({ shareId: share.value.id, fromTeamId: p.teamId, baseRevision: a.r1, diff: '{"n":1}' });
    await first.sent;
    const qFirst = await q.owner.sendProposal({ shareId: share.value.id, fromTeamId: q.teamId, baseRevision: a.r1, diff: '{"q":1}' });
    await qFirst.sent;

    await (await a.owner.setShareTeams(share.value.id, [p.teamId])).sent;
    const stored = database.peek(`shares/${share.value.id}`) as { projection: Envelope; prevKeys: Record<string, Envelope>; keyWraps: Record<string, unknown> };
    expect(stored.projection.kv).toBe(2);
    expect(Object.keys(stored.prevKeys)).toEqual(["1"]);
    expect(Object.keys(stored.keyWraps)).toEqual([p.teamId]);
    expect(await q.owner.listReceivedShares(q.teamId)).toEqual([]);
    expect(await q.owner.getShare(share.value.id)).toBe(null);

    const second = await p.owner.sendProposal({ shareId: share.value.id, fromTeamId: p.teamId, baseRevision: a.r1, diff: '{"n":2}' });
    await second.sent;
    expect((await p.owner.listReceivedShares(p.teamId))[0]?.projection).toBe('{"v":"before"}');
    expect((await a.owner.listProposals(a.teamId, "received")).map((x) => x.diff).sort()).toEqual(['{"n":1}', '{"n":2}', '{"q":1}']);
    expect((await p.owner.listProposals(p.teamId, "sent")).map((x) => x.diff).sort()).toEqual(['{"n":1}', '{"n":2}']);
    // The team taken off still reads what it sent, and nothing sealed after.
    expect((await q.owner.listProposals(q.teamId, "sent")).map((x) => x.diff)).toEqual(['{"q":1}']);

    // Adding a team keeps the key; publishing moves a following share under the same key.
    const r = await teamWithAuto(database, "rhea", 4444, "Fourth");
    await (await a.owner.setShareTeams(share.value.id, [p.teamId, r.teamId])).sent;
    expect((database.peek(`shares/${share.value.id}`) as { projection: Envelope }).projection.kv).toBe(2);
    expect((await r.owner.listReceivedShares(r.teamId))[0]?.projection).toBe('{"v":"before"}');
    await (await a.owner.setShareMode(share.value.id, "follow")).sent;
    const r2 = await a.owner.publishRevision({ teamId: a.teamId, autoId: a.autoId, baseRevision: a.r1, content: "{}", followProjection: '{"v":"after"}' });
    await r2.sent;
    expect((await r.owner.getShare(share.value.id, r.teamId))?.projection).toBe('{"v":"after"}');
    expect((await a.owner.getShare(share.value.id))?.revision).toBe(r2.value.id);
  });
});

describe("a server that changes what it stores", () => {
  it("cannot change, move or swap ciphertext without the client refusing it", async () => {
    const database = new MemoryDatabase({ approvalKdfIterations: FAST_APPROVAL_KDF });
    const a = await teamWithAuto(database, "alice", null, "Alpha");
    const r2 = await a.owner.publishRevision({ teamId: a.teamId, autoId: a.autoId, baseRevision: a.r1, content: '{"two":2}' });
    await r2.sent;
    const path1 = `teams/${a.teamId}/autos/${a.autoId}/revisions/${a.r1}`;
    const path2 = `teams/${a.teamId}/autos/${a.autoId}/revisions/${r2.value.id}`;
    const one = database.peek(path1) as DocData & { content: Envelope };
    const two = database.peek(path2) as DocData & { content: Envelope };

    // One flipped bit.
    const flipped = new Uint8Array(one.content.ct);
    flipped[0] = (flipped[0] ?? 0) ^ 1;
    database.seed(path1, { ...one, content: { ...one.content, ct: flipped } });
    expect(await code(a.owner.openRevision(a.teamId, a.autoId, a.r1))).toBe("tampered");
    // Revision 2's content moved into revision 1: bound to its own path, so it does not open there.
    database.seed(path1, { ...one, content: two.content });
    expect(await code(a.owner.openRevision(a.teamId, a.autoId, a.r1))).toBe("tampered");
    database.seed(path1, one);
    expect((await a.owner.openRevision(a.teamId, a.autoId, a.r1))?.content).toBe('{"secret":"Alpha path one"}');

    // A title swapped between autos.
    const other = await a.owner.createAuto(a.teamId, { title: "Other" });
    await other.sent;
    const autoPath = `teams/${a.teamId}/autos/${a.autoId}`;
    const auto = database.peek(autoPath) as DocData;
    database.seed(autoPath, { ...auto, title: (database.peek(`teams/${a.teamId}/autos/${other.value.id}`) as DocData).title });
    expect(await code(a.owner.listAutos(a.teamId))).toBe("tampered");
  });

  it("cannot give a device a key of its own, swap the team's public key, or roll the keys back", async () => {
    const database = new MemoryDatabase({ approvalKdfIterations: FAST_APPROVAL_KDF });
    const a = await teamWithAuto(database, "alice", null, "Alpha");
    const eveKeys = new MemoryDeviceKeyStore();
    const eveTrust = new MemoryTrustStore();
    const eve = await join(database, a.owner, a.teamId, "eve", "editor", eveKeys, eveTrust);
    const teamPath = `teams/${a.teamId}`;
    const eveDevice = (await eve.thisDevice()).deviceId;
    const grantPath = `teams/${a.teamId}/keyGrants/${eveDevice}`;
    const realTeam = database.peek(teamPath) as DocData;
    const realGrant = database.peek(grantPath) as DocData;
    // Eve's device, in a new session each time, so nothing opened before is kept in memory.
    const fresh = () => {
      const backend = new MemoryBackend({ database, deviceKeys: eveKeys, trust: eveTrust });
      backend.signInAs("eve");
      return backend;
    };
    expect((await fresh().listAutos(a.teamId)).length).toBe(1);
    expect(eve).toBeDefined();
    const pinned = async () => {
      try {
        await fresh().listAutos(a.teamId);
      } catch (error) {
        return isCloudError(error, "tampered") && /saw before/.test(error.message);
      }
      return false;
    };

    // The server's own team key, with its own key record 1 and public key, granted to Eve's device
    // and signed by a device record the server made. Eve's device pinned the real key.
    const forged = await createTeamKeys(a.teamId);
    const serverDevice = await generateDeviceKeys();
    database.seed(`users/server/devices/${serverDevice.deviceId}`, { ...deviceRecord(serverDevice), createdAt: SERVER_TIME });
    const eveRecord = database.peek(`users/eve/devices/${eveDevice}`) as unknown as ReturnType<typeof deviceRecord>;
    const grant = await makeKeyGrant({ teamId: a.teamId, teamKey: forged.key, recipient: { deviceId: eveDevice, uid: "eve", record: eveRecord }, approver: serverDevice });
    const proof = await makeGrantProof({ teamId: a.teamId, deviceId: eveDevice, uid: "eve", fingerprint: eveRecord.fingerprint, teamKey: forged.key });
    const realKey1 = database.peek(`teams/${a.teamId}/teamKeys/1`) as DocData;
    database.seed(grantPath, { ...realGrant, ...grant, proof, approverUid: "server" });
    // With the real records, the forged key opens nothing.
    expect(await code(fresh().listAutos(a.teamId))).toBe("tampered");
    // With forged records and public key as well, the device's pin catches it.
    database.seed(`teams/${a.teamId}/teamKeys/1`, { ...forged.record, createdBy: "server", createdAt: SERVER_TIME });
    database.seed(teamPath, { ...realTeam, encKey: forged.encKey });
    expect(await pinned()).toBe(true);
    // A device that never saw the team (no pin) refuses the forged keys too: the grant carries no
    // approval MAC made with the code on its screen.
    const unpinned = new MemoryBackend({ database, deviceKeys: eveKeys });
    unpinned.signInAs("eve");
    expect(await unpinned.teamKeyStatus(a.teamId)).toMatchObject({ state: "waiting" });
    expect(await code(unpinned.listAutos(a.teamId))).toBe("no-key");
    database.seed(teamPath, realTeam);
    database.seed(`teams/${a.teamId}/teamKeys/1`, realKey1);
    database.seed(grantPath, realGrant);
    expect((await fresh().listAutos(a.teamId)).length).toBe(1);

    // Rollback: after a rotation, the old team document and grant are served again.
    await (await a.owner.completeKeyRotation(a.teamId)).sent;
    expect((await fresh().listAutos(a.teamId)).length).toBe(1);
    database.seed(teamPath, realTeam);
    database.seed(grantPath, realGrant);
    expect(await pinned()).toBe(true);
  });

  it("gets no key to a device it slips in at a rotation, or to a removed member's device it relabels", async () => {
    const database = new MemoryDatabase({ approvalKdfIterations: FAST_APPROVAL_KDF });
    const a = await teamWithAuto(database, "alice", null, "Alpha");
    const bea = await join(database, a.owner, a.teamId, "bea");
    const eve = await join(database, a.owner, a.teamId, "eve");
    const beaDevice = (await bea.thisDevice()).deviceId;
    const eveDevice = (await eve.thisDevice()).deviceId;

    // A device of the server's, under Bea's name, with a grant whose proof it could not make.
    const serverDevice = await generateDeviceKeys();
    database.seed(`users/bea/devices/${serverDevice.deviceId}`, { ...deviceRecord(serverDevice), createdAt: SERVER_TIME });
    const beaGrant = database.peek(`teams/${a.teamId}/keyGrants/${beaDevice}`) as DocData;
    database.seed(`teams/${a.teamId}/keyGrants/${serverDevice.deviceId}`, { ...beaGrant, deviceId: serverDevice.deviceId });

    // At Eve's removal, the server also relabels Eve's device as Bea's, record and all.
    const eveGrant = database.peek(`teams/${a.teamId}/keyGrants/${eveDevice}`) as DocData;
    database.seed(`users/bea/devices/${eveDevice}`, database.peek(`users/eve/devices/${eveDevice}`) as DocData);
    database.seed(`teams/${a.teamId}/keyGrants/${eveDevice}`, { ...eveGrant, uid: "bea" });

    await (await a.owner.removeMember(a.teamId, "eve")).sent;
    const grants = database.paths().filter((path) => path.startsWith(`teams/${a.teamId}/keyGrants/`));
    expect(grants.map((path) => path.split("/").pop()).sort()).toEqual([(await a.owner.thisDevice()).deviceId, beaDevice].sort());
    expect((await bea.listAutos(a.teamId)).length).toBe(1);
  });
});
