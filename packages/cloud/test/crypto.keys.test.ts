/**
 * Public-key wraps, device keys and signatures, the key stores, team keys, the key chain and key
 * grants (spec 14 sections 4.1 to 4.5).
 */
import { describe, expect, it } from "vitest";
import {
  aadFor,
  checkDeviceRecord,
  checkTeamEncKey,
  createTeamKeys,
  deviceFingerprint,
  deviceIdFor,
  deviceRecord,
  generateDeviceKeys,
  IndexedDbDeviceKeyStore,
  makeKeyGrant,
  MemoryDeviceKeyStore,
  openBytes,
  openChain,
  openKeyGrant,
  openTeamKeyRecord,
  rotateTeamKeys,
  sealBytes,
  sign,
  unwrapWithPrivateKey,
  utf8Encode,
  verify,
  wrapToPublicKey,
  type DeviceKeys,
  type KeyGrant,
  type PublicKeyWrap,
  type TeamKeyRecord,
} from "../src/crypto/index.js";
import { counting, flip, rejectsWith } from "./cryptoHelpers.js";

const teamId = "t_team0000000000000001";
const grantAad = aadFor.keyGrant({ teamId, deviceId: "d1", kv: 1 });

async function exportRaw(key: CryptoKey): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.exportKey("raw", key));
}

describe("wrapToPublicKey and unwrapWithPrivateKey", () => {
  it("round-trips a 32-byte key in 125 bytes: 65 for epk, 12 for the IV and 48 of ciphertext", async () => {
    const device = await generateDeviceKeys();
    const secret = new Uint8Array(32).fill(5);
    const wrap = await wrapToPublicKey(device.encSpki, secret, grantAad);
    expect(wrap.v).toBe(1);
    expect(wrap.epk.length).toBe(65);
    expect(wrap.epk[0]).toBe(4);
    expect(wrap.iv.length).toBe(12);
    expect(wrap.ct.length).toBe(48);
    expect(wrap.epk.length + wrap.iv.length + wrap.ct.length).toBe(125);
    expect(Buffer.from([...wrap.epk, ...wrap.iv, ...wrap.ct]).toString("base64url").length).toBe(167);
    expect(await unwrapWithPrivateKey(device.encryption.privateKey, wrap, grantAad)).toEqual(secret);
  });

  it("makes a new ephemeral key for every wrap", async () => {
    const device = await generateDeviceKeys();
    const a = await wrapToPublicKey(device.encSpki, new Uint8Array(32), grantAad);
    const b = await wrapToPublicKey(device.encSpki, new Uint8Array(32), grantAad);
    expect(a.epk).not.toEqual(b.epk);
  });

  it("throws decrypt-failed for another private key, another AAD, or a flipped bit in epk, IV or ciphertext", async () => {
    const device = await generateDeviceKeys();
    const other = await generateDeviceKeys();
    const wrap = await wrapToPublicKey(device.encSpki, new Uint8Array(32).fill(1), grantAad);
    const key = device.encryption.privateKey;
    await rejectsWith(unwrapWithPrivateKey(other.encryption.privateKey, wrap, grantAad), "decrypt-failed");
    await rejectsWith(unwrapWithPrivateKey(key, wrap, aadFor.keyGrant({ teamId, deviceId: "d2", kv: 1 })), "decrypt-failed");
    await rejectsWith(unwrapWithPrivateKey(key, wrap, aadFor.keyGrant({ teamId, deviceId: "d1", kv: 2 })), "decrypt-failed");
    await rejectsWith(unwrapWithPrivateKey(key, { ...wrap, epk: flip(wrap.epk, 64) }, grantAad), "decrypt-failed");
    await rejectsWith(unwrapWithPrivateKey(key, { ...wrap, epk: flip(wrap.epk, 10) }, grantAad), "decrypt-failed");
    await rejectsWith(unwrapWithPrivateKey(key, { ...wrap, iv: flip(wrap.iv) }, grantAad), "decrypt-failed");
    await rejectsWith(unwrapWithPrivateKey(key, { ...wrap, ct: flip(wrap.ct, 3) }, grantAad), "decrypt-failed");
    await rejectsWith(unwrapWithPrivateKey(key, { ...wrap, ct: flip(wrap.ct, -1) }, grantAad), "decrypt-failed");
  });

  it("throws bad-envelope for an unknown version or wrong lengths, and bad-key for a bad recipient", async () => {
    const device = await generateDeviceKeys();
    const wrap = await wrapToPublicKey(device.encSpki, new Uint8Array(32), grantAad);
    const key = device.encryption.privateKey;
    await rejectsWith(unwrapWithPrivateKey(key, { ...wrap, v: 2 } as unknown as PublicKeyWrap, grantAad), "bad-envelope");
    await rejectsWith(unwrapWithPrivateKey(key, { ...wrap, epk: wrap.epk.subarray(1) }, grantAad), "bad-envelope");
    await rejectsWith(unwrapWithPrivateKey(key, { ...wrap, iv: new Uint8Array(16) }, grantAad), "bad-envelope");
    await rejectsWith(wrapToPublicKey(device.encSpki.subarray(1), new Uint8Array(32), grantAad), "bad-key");
    await rejectsWith(wrapToPublicKey(flip(device.encSpki, 60), new Uint8Array(32), grantAad), "bad-key");
  });

  it("uses injected randomness only for the IV", async () => {
    const device = await generateDeviceKeys();
    const wrap = await wrapToPublicKey(device.encSpki, new Uint8Array(32), grantAad, counting(100));
    expect(wrap.iv).toEqual(new Uint8Array(12).map((_, i) => 100 + i));
  });
});

describe("device keys", () => {
  it("makes non-extractable P-256 pairs whose public halves are 91-byte SPKIs", async () => {
    const device = await generateDeviceKeys();
    expect(device.encryption.privateKey.extractable).toBe(false);
    expect(device.signing.privateKey.extractable).toBe(false);
    await expect(crypto.subtle.exportKey("pkcs8", device.encryption.privateKey)).rejects.toThrow();
    await expect(crypto.subtle.exportKey("pkcs8", device.signing.privateKey)).rejects.toThrow();
    expect(device.encryption.privateKey.algorithm).toMatchObject({ name: "ECDH", namedCurve: "P-256" });
    expect(device.signing.privateKey.algorithm).toMatchObject({ name: "ECDSA", namedCurve: "P-256" });
    expect(device.encSpki.length).toBe(91);
    expect(device.signSpki.length).toBe(91);
  });

  it("fingerprints the two SPKIs with SHA-256 and derives a 22-character id from it", async () => {
    const device = await generateDeviceKeys();
    const expected = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array([...device.encSpki, ...device.signSpki])));
    expect(device.fingerprint).toEqual(expected);
    expect(await deviceFingerprint(device.encSpki, device.signSpki)).toEqual(expected);
    expect(device.deviceId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(device.deviceId).toBe(deviceIdFor(expected));
  });

  it("checks a device record against its id", async () => {
    const device = await generateDeviceKeys();
    const other = await generateDeviceKeys();
    const record = deviceRecord(device);
    await checkDeviceRecord(device.deviceId, record);
    await rejectsWith(checkDeviceRecord(other.deviceId, record), "bad-key");
    await rejectsWith(checkDeviceRecord(device.deviceId, { ...record, encSpki: other.encSpki }), "bad-key");
    await rejectsWith(checkDeviceRecord(device.deviceId, { ...record, fingerprint: flip(record.fingerprint) }), "bad-key");
    await rejectsWith(checkDeviceRecord(device.deviceId, { ...record, v: 2 as 1 }), "bad-envelope");
  });

  it("signs and verifies with ECDSA P-256, and a flipped bit in the signature or message fails", async () => {
    const device = await generateDeviceKeys();
    const message = utf8Encode("grant");
    const signature = await sign(device.signing.privateKey, message);
    expect(signature.length).toBe(64);
    expect(await verify(device.signSpki, signature, message)).toBe(true);
    expect(await verify(device.signSpki, flip(signature, 5), message)).toBe(false);
    expect(await verify(device.signSpki, flip(signature, -1), message)).toBe(false);
    expect(await verify(device.signSpki, signature, flip(message))).toBe(false);
    expect(await verify(device.signSpki, signature.subarray(1), message)).toBe(false);
    expect(await verify((await generateDeviceKeys()).signSpki, signature, message)).toBe(false);
    await rejectsWith(verify(device.signSpki.subarray(2), signature, message), "bad-key");
    await rejectsWith(sign(device.encryption.privateKey, message), "bad-key");
  });
});

describe("device key stores", () => {
  it("keeps keys in memory per slot", async () => {
    const store = new MemoryDeviceKeyStore();
    const device = await generateDeviceKeys();
    expect(await store.load("uid-a")).toBeNull();
    await store.save("uid-a", device);
    expect(await store.load("uid-a")).toBe(device);
    expect(await store.load("uid-b")).toBeNull();
    await store.remove("uid-a");
    await store.remove("uid-a");
    expect(await store.load("uid-a")).toBeNull();
  });

  it("refuses to keep a device key whose private half could be exported", async () => {
    const device = await generateDeviceKeys();
    const leaky: DeviceKeys = { ...device, encryption: await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]) };
    await rejectsWith(new MemoryDeviceKeyStore().save("uid", leaky), "bad-key");
    await rejectsWith(new IndexedDbDeviceKeyStore().save("uid", leaky), "bad-key");
  });

  it("can be imported where there is no IndexedDB, and says unavailable when used there", async () => {
    expect((globalThis as { indexedDB?: unknown }).indexedDB).toBeUndefined();
    const store = new IndexedDbDeviceKeyStore();
    await rejectsWith(store.load("uid"), "unavailable");
    await rejectsWith(store.save("uid", await generateDeviceKeys()), "unavailable");
    await rejectsWith(store.remove("uid"), "unavailable");
  });

  it("keeps non-extractable keys usable through structured clone, which IndexedDB relies on", async () => {
    const device = await generateDeviceKeys();
    const clone = structuredClone(device);
    expect(clone.encryption.privateKey.extractable).toBe(false);
    expect(await verify(device.signSpki, await sign(clone.signing.privateKey, new Uint8Array(3)), new Uint8Array(3))).toBe(true);
  });
});

describe("team keys and the chain", () => {
  it("creates version 1 with a pair whose private half is non-extractable and sealed under the key", async () => {
    const team = await createTeamKeys(teamId);
    expect(team.key.version).toBe(1);
    expect(team.key.key.extractable).toBe(true);
    expect(team.key.key.algorithm).toMatchObject({ name: "AES-GCM", length: 256 });
    expect(team.pair.privateKey.extractable).toBe(false);
    expect(team.pair.signingKey.extractable).toBe(false);
    expect(team.record).toMatchObject({ v: 1, kv: 1, prev: null, sig: null });
    expect(team.record.pairSpki).toEqual(team.pair.spki);
    expect(team.record.signSpki).toEqual(team.pair.signSpki);
    expect(team.encKey).toEqual({ v: 1, spki: team.pair.spki, fingerprint: team.pair.fingerprint, signSpki: team.pair.signSpki, sig: null });
    await checkTeamEncKey(team.encKey);
    const opened = await openTeamKeyRecord(teamId, team.key, team.record);
    expect(opened.privateKey.extractable).toBe(false);
    expect(opened.signingKey.extractable).toBe(false);
    expect(opened.spki).toEqual(team.pair.spki);
    expect(opened.signSpki).toEqual(team.pair.signSpki);
  });

  it("makes the team key from the injected random bytes", async () => {
    const team = await createTeamKeys(teamId, counting(40));
    expect(await exportRaw(team.key.key)).toEqual(new Uint8Array(32).map((_, i) => 40 + i));
  });

  it("rotates three times and opens all four versions from the newest", async () => {
    const v1 = await createTeamKeys(teamId);
    const v2 = await rotateTeamKeys(teamId, v1);
    const v3 = await rotateTeamKeys(teamId, v2);
    const v4 = await rotateTeamKeys(teamId, v3);
    expect([v2, v3, v4].map((v) => v.key.version)).toEqual([2, 3, 4]);
    expect(v4.record.prev?.kv).toBe(4);
    const records = [v3.record, v1.record, v4.record, v2.record];
    const ring = await openChain(teamId, v4.key, records);
    expect([...ring.keys()].sort()).toEqual([1, 2, 3, 4]);
    for (const [version, original] of [[1, v1], [2, v2], [3, v3], [4, v4]] as const) {
      const opened = ring.get(version);
      expect(opened?.key.version).toBe(version);
      expect(opened?.pair.spki).toEqual(original.pair.spki);
      // Each opened key reads what its original sealed.
      const aad = aadFor.autoTitle({ teamId, autoId: "a1", gen: 1, kv: version });
      const sealed = await sealBytes(original.key, utf8Encode(`title ${String(version)}`), aad);
      expect(new TextDecoder().decode(await openBytes(opened!.key, sealed, aad))).toBe(`title ${String(version)}`);
    }
    expect(ring.get(1)?.key.key.extractable).toBe(false);
    expect(ring.get(2)?.pair.privateKey.extractable).toBe(false);
  });

  it("opens only as far back as the records given, and says which version is missing for a gap", async () => {
    const v1 = await createTeamKeys(teamId);
    const v2 = await rotateTeamKeys(teamId, v1);
    const v3 = await rotateTeamKeys(teamId, v2);
    const partial = await openChain(teamId, v3.key, [v3.record, v2.record]);
    expect([...partial.keys()].sort()).toEqual([2, 3]);
    await rejectsWith(openChain(teamId, v3.key, [v3.record, v1.record]), "missing-key-version");
    await rejectsWith(openChain(teamId, v3.key, [v2.record, v1.record]), "missing-key-version");
    await rejectsWith(openChain(teamId, v3.key, [v3.record, v3.record]), "bad-input");
  });

  it("refuses a rotation from a key opened for everyday use", async () => {
    const v1 = await createTeamKeys(teamId);
    const v2 = await rotateTeamKeys(teamId, v1);
    const everyday = (await openChain(teamId, v2.key, [v2.record, v1.record])).get(1)!;
    await rejectsWith(rotateTeamKeys(teamId, everyday), "bad-key");
  });

  it("throws for a record that was changed, moved to another team or relabelled", async () => {
    const v1 = await createTeamKeys(teamId);
    const v2 = await rotateTeamKeys(teamId, v1);
    const other = await createTeamKeys(teamId);
    await rejectsWith(openTeamKeyRecord("t_elsewhere", v2.key, v2.record), "decrypt-failed");
    await rejectsWith(openTeamKeyRecord(teamId, v2.key, { ...v2.record, pairSpki: other.record.pairSpki }), "decrypt-failed");
    await rejectsWith(openTeamKeyRecord(teamId, v2.key, { ...v2.record, pairPrivate: { ...v2.record.pairPrivate, ct: flip(v2.record.pairPrivate.ct, 9) } }), "decrypt-failed");
    await rejectsWith(openTeamKeyRecord(teamId, v2.key, { ...v2.record, kv: 3 }), "wrong-key-version");
    await rejectsWith(openTeamKeyRecord(teamId, v2.key, { ...v2.record, prev: null }), "bad-envelope");
    await rejectsWith(openTeamKeyRecord(teamId, v1.key, { ...v1.record, prev: v2.record.prev }), "bad-envelope");
    await rejectsWith(openTeamKeyRecord(teamId, v1.key, { ...v1.record, v: 2 } as unknown as TeamKeyRecord), "bad-envelope");
    const tampered = { ...v2.record, prev: { ...v2.record.prev!, iv: flip(v2.record.prev!.iv) } };
    await rejectsWith(openChain(teamId, v2.key, [tampered, v1.record]), "decrypt-failed");
  });

  it("checks that an encKey's fingerprint is its key's", async () => {
    const team = await createTeamKeys(teamId);
    await rejectsWith(checkTeamEncKey({ ...team.encKey, fingerprint: flip(team.encKey.fingerprint) }), "bad-key");
    await rejectsWith(checkTeamEncKey({ ...team.encKey, v: 0 }), "bad-key");
  });
});

describe("key grants", () => {
  async function setup() {
    const team = await createTeamKeys(teamId);
    const approver = await generateDeviceKeys();
    const newcomer = await generateDeviceKeys();
    const grant = await makeKeyGrant({ teamId, teamKey: team.key, recipient: { deviceId: newcomer.deviceId, uid: "ada", record: deviceRecord(newcomer) }, approver });
    const open = (patch: Partial<KeyGrant> = {}, options: { extractable?: boolean; approver?: DeviceKeys; device?: DeviceKeys; teamId?: string } = {}) => {
      const signer = options.approver ?? approver;
      return openKeyGrant({
        teamId: options.teamId ?? teamId,
        grant: { ...grant, ...patch },
        device: options.device ?? newcomer,
        approver: { deviceId: signer.deviceId, record: deviceRecord(signer) },
        extractable: options.extractable,
      });
    };
    return { team, approver, newcomer, grant, open };
  }

  it("grants the team key to a new device, signed by the approver, and it opens there", async () => {
    const { team, approver, newcomer, grant, open } = await setup();
    expect(grant).toMatchObject({ v: 1, teamId, deviceId: newcomer.deviceId, uid: "ada", kv: 1, approverDeviceId: approver.deviceId });
    expect(grant.wrap.epk.length + grant.wrap.iv.length + grant.wrap.ct.length).toBe(125);
    expect(grant.signature.length).toBe(64);
    const everyday = await open();
    expect(everyday.version).toBe(1);
    expect(everyday.key.extractable).toBe(false);
    const forApproving = await open({}, { extractable: true });
    expect(await exportRaw(forApproving.key)).toEqual(await exportRaw(team.key.key));
  });

  it("throws bad-signature for a flipped bit in the signature or wrap, or another approver's key", async () => {
    const { grant, open } = await setup();
    await rejectsWith(open({ signature: flip(grant.signature, 7) }), "bad-signature");
    await rejectsWith(open({ wrap: { ...grant.wrap, epk: flip(grant.wrap.epk, 30) } }), "bad-signature");
    await rejectsWith(open({ wrap: { ...grant.wrap, iv: flip(grant.wrap.iv) } }), "bad-signature");
    await rejectsWith(open({ wrap: { ...grant.wrap, ct: flip(grant.wrap.ct) } }), "bad-signature");
    await rejectsWith(open({ kv: 2 }), "bad-signature");
    // The signature covers whose device it is, so a grant signed for one member cannot be relabelled as another's.
    await rejectsWith(open({ uid: "eve" }), "bad-signature");
    const impostor = await generateDeviceKeys();
    await rejectsWith(open({ approverDeviceId: impostor.deviceId }, { approver: impostor }), "bad-signature");
  });

  it("refuses a grant for another team or device, or from an approver other than the one named", async () => {
    const { approver, grant, open } = await setup();
    await rejectsWith(open({}, { teamId: "t_other" }), "bad-input");
    await rejectsWith(open({}, { device: await generateDeviceKeys() }), "bad-input");
    await rejectsWith(open({}, { approver: await generateDeviceKeys() }), "bad-input");
    await rejectsWith(open({ v: 2 as 1 }), "bad-envelope");
    await rejectsWith(open({ wrap: { ...grant.wrap, epk: new Uint8Array(3) } }), "bad-envelope");
    expect(grant.approverDeviceId).toBe(approver.deviceId);
  });

  it("refuses to grant to a device record whose keys do not match its id", async () => {
    const team = await createTeamKeys(teamId);
    const approver = await generateDeviceKeys();
    const newcomer = await generateDeviceKeys();
    const swapped = { ...deviceRecord(newcomer), encSpki: approver.encSpki };
    await rejectsWith(makeKeyGrant({ teamId, teamKey: team.key, recipient: { deviceId: newcomer.deviceId, uid: "ada", record: swapped }, approver }), "bad-key");
  });

  it("cannot grant a key opened for everyday use", async () => {
    const { newcomer, approver, open } = await setup();
    const everyday = await open();
    await rejectsWith(makeKeyGrant({ teamId, teamKey: everyday, recipient: { deviceId: newcomer.deviceId, uid: "ada", record: deviceRecord(newcomer) }, approver }), "bad-key");
  });
});
