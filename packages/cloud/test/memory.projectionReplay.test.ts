/**
 * A share's projection is bound to the signed manifest that names it (crypto/manifest.ts, `prj`).
 * Publishing to a following share seals the new projection under the same share key when no team
 * key changed, so two revisions' projections share a key version; the AAD binds only the share, the
 * auto and that version. Without the digest in the manifest, a server could serve an older
 * projection beside the newest manifest, which the device's `seq` pin then accepts.
 */
import { describe, expect, it } from "vitest";
import { decodeShareManifestBody, encodeShareManifestBody, MemoryDeviceKeyStore, readShareManifest, signShareManifest, type ShareManifest } from "../src/crypto/index.js";
import type { KeyRing } from "../src/keys/keyring.js";
import { SHARE_PROJECTION_NOT_SIGNED } from "../src/client.js";
import { isCloudError } from "../src/errors.js";
import { MemoryTrustStore } from "../src/keys/trust.js";
import { MemoryBackend } from "../src/memory/memoryBackend.js";
import { MemoryDatabase } from "../src/memory/memoryStore.js";
import type { DocData } from "../src/store.js";

/** Few PBKDF2 iterations for approval codes: the count does not change what is checked here. */
const FAST_APPROVAL_KDF = 10;

async function person(database: MemoryDatabase, uid: string): Promise<MemoryBackend> {
  const backend = new MemoryBackend({ database, deviceKeys: new MemoryDeviceKeyStore(), trust: new MemoryTrustStore() });
  backend.signInAs(uid);
  await (await backend.saveProfile({ displayName: uid })).sent;
  return backend;
}

async function teamWithAuto(database: MemoryDatabase, uid: string, number: number, name: string) {
  const owner = await person(database, uid);
  const created = await owner.createTeam({ number, name });
  await created.sent;
  const teamId = created.value.id;
  const auto = await owner.createAuto(teamId, { title: `${name} auto` });
  await auto.sent;
  const r1 = await owner.publishRevision({ teamId, autoId: auto.value.id, baseRevision: null, content: `{"secret":"${name} one"}` });
  await r1.sent;
  return { owner, teamId, autoId: auto.value.id, r1: r1.value.id };
}

async function outcome(work: () => Promise<unknown>): Promise<string> {
  try {
    const value = await work();
    return `ok ${JSON.stringify((value as { projection?: string } | null)?.projection ?? null)}`;
  } catch (error) {
    return isCloudError(error) ? error.code : String(error);
  }
}

describe("a following share's projection", () => {
  it("cannot be served from an older revision beside the newest signed manifest", async () => {
    const database = new MemoryDatabase({ approvalKdfIterations: FAST_APPROVAL_KDF });
    const a = await teamWithAuto(database, "alice", 1111, "Alpha");
    const p = await teamWithAuto(database, "olga", 2222, "Partner");
    const share = await a.owner.createShare({ teamId: a.teamId, autoId: a.autoId, revision: a.r1, audience: "teams", teamIds: [p.teamId], mode: "follow", projection: '{"p":1}' });
    await share.sent;
    const shareId = share.value.id;
    expect(await outcome(() => p.owner.getShare(shareId, p.teamId))).toBe('ok "{\\"p\\":1}"');
    const first = database.peek(`shares/${shareId}`) as DocData & { projection: { kv: number } };

    const r2 = await a.owner.publishRevision({ teamId: a.teamId, autoId: a.autoId, baseRevision: a.r1, content: '{"secret":"Alpha two"}' });
    await r2.sent;
    await (await a.owner.updateShare(shareId, { revision: r2.value.id, projection: '{"p":2}' })).sent;
    expect(await outcome(() => p.owner.getShare(shareId, p.teamId))).toBe('ok "{\\"p\\":2}"');
    const second = database.peek(`shares/${shareId}`) as DocData & { projection: { kv: number } };
    // The publish kept the share key, so the two projections are under the same version.
    expect(second.projection.kv).toBe(first.projection.kv);

    // The server serves the first projection beside the newest manifest and revision.
    database.seed(`shares/${shareId}`, { ...second, projection: first.projection });
    expect(await outcome(() => p.owner.getShare(shareId, p.teamId))).toBe("tampered");
    expect(await outcome(() => a.owner.getShare(shareId))).toBe("tampered");
  }, 60_000);

  it("is named in the manifest a share is made and published with, and a manifest that names none still decodes to its own bytes", async () => {
    const database = new MemoryDatabase({ approvalKdfIterations: FAST_APPROVAL_KDF });
    const a = await teamWithAuto(database, "alice", 1111, "Alpha");
    const p = await teamWithAuto(database, "olga", 2222, "Partner");
    const share = await a.owner.createShare({ teamId: a.teamId, autoId: a.autoId, revision: a.r1, audience: "teams", teamIds: [p.teamId], mode: "follow", projection: '{"p":1}' });
    await share.sent;
    const manifest = (database.peek(`shares/${share.value.id}`) as { manifest: ShareManifest }).manifest;
    const body = readShareManifest(manifest);
    expect(body.projection?.byteLength).toBe(32);
    // A manifest made before the field existed has none, and keeps its one encoding.
    const { projection: _projection, ...legacy } = body;
    const bytes = encodeShareManifestBody(legacy);
    expect(new TextDecoder().decode(bytes)).not.toContain("|prj=");
    const decoded = decodeShareManifestBody(bytes);
    expect(decoded.projection).toBeUndefined();
    expect(encodeShareManifestBody(decoded)).toEqual(bytes);
  }, 60_000);

  it("is refused when the manifest names none, though the owner team signed it (security review L1)", async () => {
    const database = new MemoryDatabase({ approvalKdfIterations: FAST_APPROVAL_KDF });
    const a = await teamWithAuto(database, "alice", 1111, "Alpha");
    const p = await teamWithAuto(database, "olga", 2222, "Partner");
    const share = await a.owner.createShare({ teamId: a.teamId, autoId: a.autoId, revision: a.r1, audience: "teams", teamIds: [p.teamId], mode: "follow", projection: '{"p":1}' });
    await share.sent;
    const shareId = share.value.id;
    const doc = database.peek(`shares/${shareId}`) as DocData & { manifest: ShareManifest };
    // The same terms signed again, by the owner team's key and device, with no projection named: a
    // manifest of the kind made before 2026-10-11.
    const keys = (a.owner as unknown as { keys: KeyRing }).keys;
    const opened = await keys.openTeam(a.teamId);
    const { projection: _projection, ...legacy } = readShareManifest(doc.manifest);
    const manifest = await signShareManifest({ body: legacy, signingKey: opened.newest.pair.signingKey, device: await keys.device(), terms: { tsig: doc.manifest.tsig, tkeys: doc.manifest.tkeys } });
    database.seed(`shares/${shareId}`, { ...doc, manifest });
    await expect(p.owner.getShare(shareId, p.teamId)).rejects.toMatchObject({ code: "tampered", message: SHARE_PROJECTION_NOT_SIGNED });
    await expect(a.owner.getShare(shareId)).rejects.toMatchObject({ code: "tampered", message: SHARE_PROJECTION_NOT_SIGNED });
  }, 60_000);
});
