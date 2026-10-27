/**
 * A share's revision and its end date, as its manifest signs them. Both are plain fields the server
 * writes, so the owner team signs them with the rest of the share's terms: a pinned share cannot be
 * pointed at a revision the team never shared, and a share's end cannot be moved without the team.
 * Nothing is sealed into a share after the end it was signed with, by this device's clock.
 */
import { describe, expect, it } from "vitest";
import { decodeShareManifestBody, MemoryDeviceKeyStore, type ShareManifest } from "../src/crypto/index.js";
import { SHARE_ENDED, SHARE_TERMS_CHANGED } from "../src/client.js";
import { isCloudError } from "../src/errors.js";
import { MemoryTrustStore } from "../src/keys/trust.js";
import { MemoryBackend } from "../src/memory/memoryBackend.js";
import { MemoryDatabase } from "../src/memory/memoryStore.js";

/** Few PBKDF2 iterations for approval codes, as in `memory.keys.test.ts`: the count does not change what an approval checks. */
const FAST_APPROVAL_KDF = 10;

const DAY_MS = 86_400_000;
const START_MS = Date.parse("2026-09-27T12:00:00Z");

async function person(database: MemoryDatabase, uid: string, now?: () => Date): Promise<MemoryBackend> {
  const backend = new MemoryBackend({ database, deviceKeys: new MemoryDeviceKeyStore(), trust: new MemoryTrustStore(), ...(now === undefined ? {} : { now }) });
  backend.signInAs(uid);
  await (await backend.saveProfile({ displayName: uid })).sent;
  return backend;
}

/** Alpha, whose owner's device clock is `clock`, with an auto and its first revision, and Beta, a partner team. */
async function world() {
  let serverMs = START_MS;
  const database = new MemoryDatabase({ approvalKdfIterations: FAST_APPROVAL_KDF, now: () => new Date((serverMs += 1)) });
  const clock = { ms: START_MS };
  const alice = await person(database, "alice", () => new Date(Math.max(clock.ms, serverMs)));
  const created = await alice.createTeam({ number: 1111, name: "Alpha" });
  await created.sent;
  const teamId = created.value.id;
  const auto = await alice.createAuto(teamId, { title: "auto" });
  await auto.sent;
  const autoId = auto.value.id;
  const r1 = await alice.publishRevision({ teamId, autoId, baseRevision: null, content: '{"s":"one"}' });
  await r1.sent;
  const bob = await person(database, "bob");
  const beta = await bob.createTeam({ number: 2222, name: "Beta" });
  await beta.sent;
  const publish = async (base: string, s: string, followProjection?: string) => {
    const r = await alice.publishRevision({ teamId, autoId, baseRevision: base, content: `{"s":"${s}"}`, ...(followProjection === undefined ? {} : { followProjection }) });
    await r.sent;
    return r.value.id;
  };
  return { database, clock, alice, bob, teamId, autoId, r1: r1.value.id, betaId: beta.value.id, publish };
}
type World = Awaited<ReturnType<typeof world>>;

async function shareTo(w: World, mode: "pinned" | "follow", expiresAt = new Date(START_MS + 7 * DAY_MS)) {
  const made = await w.alice.createShare({ teamId: w.teamId, autoId: w.autoId, revision: w.r1, audience: "teams", teamIds: [w.betaId], mode, expiresAt, projection: '{"v":"one"}' });
  await made.sent;
  return made.value.id;
}
const docOf = (w: World, shareId: string) => w.database.peek(`shares/${shareId}`) as Record<string, unknown> & { manifest: ShareManifest; expiresAt: Date };
const termsOf = (w: World, shareId: string) => decodeShareManifestBody(docOf(w, shareId).manifest.body);
const tampered = (error: unknown) => isCloudError(error, "tampered");

describe("a share's revision is the one its manifest signs", () => {
  it("signs the revision a share is made at, and the one an update moves it to", async () => {
    const w = await world();
    const shareId = await shareTo(w, "pinned");
    expect(termsOf(w, shareId).revisionId).toBe(w.r1);
    const r2 = await w.publish(w.r1, "two");
    await (await w.alice.updateShare(shareId, { revision: r2, projection: '{"v":"two"}' })).sent;
    expect(termsOf(w, shareId)).toMatchObject({ revisionId: r2, seq: 2 });
    expect((await w.bob.getShare(shareId, w.betaId))?.revision).toBe(r2);
  });

  it("refuses a pinned share the server points at a revision the team never shared, for its team and its partner", async () => {
    const w = await world();
    const shareId = await shareTo(w, "pinned");
    const r2 = await w.publish(w.r1, "two, never shared");
    const doc = docOf(w, shareId);
    w.database.seed(`shares/${shareId}`, { ...doc, revision: r2 });
    await expect(w.alice.getShare(shareId, w.teamId)).rejects.toThrow(SHARE_TERMS_CHANGED);
    await expect(w.bob.getShare(shareId, w.betaId)).rejects.toSatisfy(tampered);
    await expect(w.alice.updateShare(shareId, { revision: r2, projection: '{"v":"two"}' })).rejects.toSatisfy(tampered);
    await expect(w.alice.setShareLevel(shareId, "propose")).rejects.toSatisfy(tampered);
  });

  it("signs each revision a following share moves to when the team publishes", async () => {
    const w = await world();
    const shareId = await shareTo(w, "follow");
    const r2 = await w.publish(w.r1, "two", '{"v":"two"}');
    expect(termsOf(w, shareId)).toMatchObject({ revisionId: r2, seq: 2 });
    const seen = await w.bob.getShare(shareId, w.betaId);
    expect(seen).toMatchObject({ revision: r2, projection: '{"v":"two"}' });
  });
});

describe("a share's end is the one its manifest signs", () => {
  it("refuses a share whose end the server moved, for its team and its partner", async () => {
    const w = await world();
    const shareId = await shareTo(w, "follow");
    const doc = docOf(w, shareId);
    expect(termsOf(w, shareId).expiresAtMs).toBe(doc.expiresAt.getTime());
    w.database.seed(`shares/${shareId}`, { ...doc, expiresAt: new Date(START_MS + 60 * DAY_MS) });
    await expect(w.alice.getShare(shareId, w.teamId)).rejects.toThrow(SHARE_TERMS_CHANGED);
    await expect(w.bob.getShare(shareId, w.betaId)).rejects.toSatisfy(tampered);
    await expect(w.alice.publishRevision({ teamId: w.teamId, autoId: w.autoId, baseRevision: w.r1, content: "{}", followProjection: '{"v":"two"}' })).rejects.toSatisfy(tampered);
  });

  it("seals nothing into a share once its signed end has passed on this device's clock, until the team extends it", async () => {
    const w = await world();
    const shareId = await shareTo(w, "follow", new Date(START_MS + 1 * DAY_MS));
    w.clock.ms = START_MS + 3 * DAY_MS;
    await expect(w.alice.updateShare(shareId, { revision: w.r1, projection: '{"v":"late"}' })).rejects.toThrow(SHARE_ENDED);
    // A publish leaves the ended share alone and publishes the revision.
    const r2 = await w.publish(w.r1, "two", '{"v":"two, after the end"}');
    expect(docOf(w, shareId).revision).toBe(w.r1);
    expect(termsOf(w, shareId).seq).toBe(1);
    // Extending signs the new end, and the next publish reaches the share again.
    const until = new Date(START_MS + 10 * DAY_MS);
    await (await w.alice.extendShare(shareId, until)).sent;
    expect(termsOf(w, shareId)).toMatchObject({ expiresAtMs: until.getTime(), seq: 2 });
    const r3 = await w.publish(r2, "three", '{"v":"three"}');
    expect(termsOf(w, shareId)).toMatchObject({ revisionId: r3, seq: 3 });
    expect(docOf(w, shareId).revision).toBe(r3);
  });

  it("signs the end a partner's request for more time is granted", async () => {
    const w = await world();
    const shareId = await shareTo(w, "pinned");
    await (await w.bob.requestMoreTime({ shareId, teamId: w.betaId })).sent;
    const until = new Date(START_MS + 20 * DAY_MS);
    await (await w.alice.decideTimeRequest(shareId, w.betaId, { status: "granted", expiresAt: until })).sent;
    expect(termsOf(w, shareId)).toMatchObject({ expiresAtMs: until.getTime(), seq: 2 });
    expect((await w.bob.getShare(shareId, w.betaId))?.expiresAt.getTime()).toBe(until.getTime());
  });
});
