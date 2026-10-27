/**
 * The two helpers added when the crypto layer was wired into the cloud client: a key grant's proof
 * (a holder of the team key vouches for the device), and the chain of older share keys a re-keyed
 * share keeps so its older proposals stay readable.
 */
import { describe, expect, it } from "vitest";
import {
  checkGrantProof,
  createTeamKeys,
  deviceRecord,
  generateDeviceKeys,
  makeGrantProof,
  newShareKey,
  openBytes,
  openShareKeyChain,
  openTeamKeyRecord,
  rotateTeamKeys,
  sealBytes,
  sealPreviousShareKey,
  aadFor,
  utf8Encode,
} from "../src/crypto/index.js";
import { flip, rejectsWith } from "./cryptoHelpers.js";

const teamId = "t_team0000000000000001";
const shareId = "s_share000000000000001";

describe("grant proofs", () => {
  it("opens to the device's fingerprint under the key it names, and under nothing else", async () => {
    const device = await generateDeviceKeys();
    const other = await generateDeviceKeys();
    const v1 = await createTeamKeys(teamId);
    const v2 = await rotateTeamKeys(teamId, v1);
    const proof = await makeGrantProof({ teamId, deviceId: device.deviceId, uid: "u1", fingerprint: device.fingerprint, teamKey: v1.key });
    expect(proof.kv).toBe(1);
    await checkGrantProof({ teamId, uid: "u1", deviceId: device.deviceId, record: deviceRecord(device), teamKey: v1.key, proof });
    // Another device's record, another team, another key version, or a changed byte all fail.
    await rejectsWith(checkGrantProof({ teamId, uid: "u1", deviceId: other.deviceId, record: deviceRecord(other), teamKey: v1.key, proof }), "decrypt-failed");
    await rejectsWith(checkGrantProof({ teamId, uid: "u1", deviceId: device.deviceId, record: deviceRecord(other), teamKey: v1.key, proof }), "bad-key");
    await rejectsWith(checkGrantProof({ teamId: "t_other", uid: "u1", deviceId: device.deviceId, record: deviceRecord(device), teamKey: v1.key, proof }), "decrypt-failed");
    await rejectsWith(checkGrantProof({ teamId, uid: "u1", deviceId: device.deviceId, record: deviceRecord(device), teamKey: v2.key, proof }), "wrong-key-version");
    await rejectsWith(checkGrantProof({ teamId, uid: "u1", deviceId: device.deviceId, record: deviceRecord(device), teamKey: v1.key, proof: { ...proof, ct: flip(proof.ct) } }), "decrypt-failed");
    // The same grant under another member's name fails too.
    await rejectsWith(checkGrantProof({ teamId, uid: "u2", deviceId: device.deviceId, record: deviceRecord(device), teamKey: v1.key, proof }), "decrypt-failed");
  });

  it("cannot be made by someone without the key: a proof under a key of their own fails", async () => {
    const device = await generateDeviceKeys();
    const real = await createTeamKeys(teamId);
    const forged = await createTeamKeys(teamId);
    const proof = await makeGrantProof({ teamId, deviceId: device.deviceId, uid: "u1", fingerprint: device.fingerprint, teamKey: forged.key });
    await rejectsWith(checkGrantProof({ teamId, uid: "u1", deviceId: device.deviceId, record: deviceRecord(device), teamKey: real.key, proof }), "decrypt-failed");
  });
});

describe("the share key chain", () => {
  it("opens every older share key from the newest, and seals only under the version above", async () => {
    const k1 = await newShareKey(1);
    const k2 = await newShareKey(2);
    const k3 = await newShareKey(3);
    const prevKeys = {
      "1": await sealPreviousShareKey({ shareId, previous: k1, next: k2 }),
      "2": await sealPreviousShareKey({ shareId, previous: k2, next: k3 }),
    };
    const chain = await openShareKeyChain({ shareId, newest: k3, prevKeys });
    expect([...chain.keys()]).toEqual([3, 2, 1]);
    const aad = aadFor.shareProjection({ shareId, autoId: "a1", kv: 1 });
    const sealed = await sealBytes(k1, utf8Encode("old projection"), aad);
    expect(new TextDecoder().decode(await openBytes(chain.get(1)!, sealed, aad))).toBe("old projection");
    expect(chain.get(1)!.key.extractable).toBe(false);
    await expect(sealPreviousShareKey({ shareId, previous: k1, next: k3 })).rejects.toThrow(/version just above/);
  });

  it("stops at the first version it does not hold, and refuses an entry moved from another share", async () => {
    const k1 = await newShareKey(1);
    const k2 = await newShareKey(2);
    expect([...(await openShareKeyChain({ shareId, newest: k2, prevKeys: {} })).keys()]).toEqual([2]);
    const moved = await sealPreviousShareKey({ shareId: "s_elsewhere", previous: k1, next: k2 });
    await rejectsWith(openShareKeyChain({ shareId, newest: k2, prevKeys: { "1": moved } }), "decrypt-failed");
  });
});

describe("a team key record's private key", () => {
  it("must belong to the record's public key, so a record cannot carry another pair's private key", async () => {
    const real = await createTeamKeys(teamId);
    await openTeamKeyRecord(teamId, real.key, real.record);
    const other = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
    const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", other.privateKey));
    const aad = aadFor.teamKeyPair({ teamId, kv: 1, fingerprint: real.encKey.fingerprint });
    const swapped = { ...real.record, pairPrivate: await sealBytes(real.key, pkcs8, aad) };
    await rejectsWith(openTeamKeyRecord(teamId, real.key, swapped), "bad-key");
  });
});
