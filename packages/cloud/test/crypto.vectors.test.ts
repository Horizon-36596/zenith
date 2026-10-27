/**
 * Known-answer tests. `crypto.vectors.json` was generated once with this layer and pinned, so a
 * later change to any stored format (an AAD text, an HKDF salt or info, the order of signed bytes,
 * a record's fields) fails here instead of silently orphaning data. Where it can, each test also
 * recomputes the answer with `node:crypto`, independently of WebCrypto and of this code, so a salt
 * and info swapped in both places at once would still be caught.
 */
import { createCipheriv, createDecipheriv, createECDH, createHash, createHmac, createPrivateKey, createPublicKey, hkdfSync, pbkdf2Sync, verify as nodeVerify } from "node:crypto";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  aadFor,
  APPROVAL_KDF_ITERATIONS,
  approvalCodeFor,
  approvalKey,
  approvalPublicPart,
  approvalSecretFrom,
  checkApprovalMac,
  checkTeamKeyStep,
  commitLinkKey,
  decodeShareManifestBody,
  deriveLinkId,
  deriveLinkKey,
  deviceFingerprint,
  deviceVerificationCode,
  encodeShareManifestBody,
  keyGrantSignedBytes,
  linkSecretToText,
  makeApprovalMac,
  openChain,
  openJson,
  openKeyGrant,
  openRecovery,
  openRecoverySigner,
  openShareManifest,
  openTeamKeyRecord,
  openText,
  ownerChoiceDigest,
  recoveryCodeFromText,
  recoveryCodeToText,
  recoveryFingerprint,
  sealBytes,
  shareKeyCommitment,
  shareManifestDigest,
  shareTermsStatement,
  teamKeyDigest,
  teamKeySignedBytes,
  teamSafetyCode,
  unwrapLinkSecretAsOwner,
  unwrapShareKeyAsOwner,
  unwrapShareKeyAsTeam,
  utf8Encode,
  type DeviceKeys,
  type Envelope,
  type KeyGrant,
  type PublicKeyWrap,
  type RecoveryRecord,
  type TeamKeyRecord,
} from "../src/crypto/index.js";
import { openRoster, rosterSignedBytes } from "../src/keys/roster.js";
import { counting, hex, toHex } from "./cryptoHelpers.js";

type Hex<T> = { [K in keyof T]: T[K] extends Uint8Array ? string : T[K] extends object | null ? Hex<T[K]> : T[K] };
const vectors = JSON.parse(readFileSync(new URL("./crypto.vectors.json", import.meta.url), "utf8")) as {
  teamId: string;
  teamKeys: { v1: string; v2: string; v3: string };
  records: Hex<TeamKeyRecord>[];
  encKey3: { v: number; spki: string; fingerprint: string; signSpki: string; sig: string };
  device: { deviceId: string; encPkcs8: string; signPkcs8: string; encSpki: string; signSpki: string; fingerprint: string; verificationCode: string };
  grant: Hex<KeyGrant>;
  recovery: { code: string; text: string; record: Hex<RecoveryRecord> };
  share: {
    shareId: string;
    autoId: string;
    recipientTeamId: string;
    partnerKey1: string;
    partnerRecord1: Hex<TeamKeyRecord>;
    shareKey: string;
    keyWrap: Hex<PublicKeyWrap> & { ekv: number };
    ownerWrap: Hex<Envelope>;
    projection: Hex<Envelope>;
    ownerChoice: Hex<Envelope>;
  };
  link: { secret: string; text: string; id: string; autoId: string; projection: Hex<Envelope>; ownerWrap: Hex<Envelope> };
  teamSafetyCode3: string;
  roster3: { roster: Hex<Envelope>; rosterSig: string; digest: string };
  shareManifest: {
    seq: number; skv: number; wkv: number; okv: number; commit: string; choice: string; revisionId: string; expiresAtMs: number;
    partnerKeyDigest: string; body: string; sig: string; dsig: string; tsig: string; digest: string;
  };
  linkManifest: { commit: string; body: string; sig: string; dsig: string; tsig: string };
};

const envelope = (e: Hex<Envelope>): Envelope => ({ v: e.v, alg: e.alg, kv: e.kv, iv: hex(e.iv), ct: hex(e.ct) });
const wrap = (w: Hex<PublicKeyWrap>): PublicKeyWrap => ({ v: w.v, epk: hex(w.epk), iv: hex(w.iv), ct: hex(w.ct) });
const record = (r: Hex<TeamKeyRecord>): TeamKeyRecord => ({
  v: r.v,
  kv: r.kv,
  prev: r.prev === null ? null : envelope(r.prev),
  pairSpki: hex(r.pairSpki),
  pairPrivate: envelope(r.pairPrivate),
  signSpki: hex(r.signSpki),
  signPrivate: envelope(r.signPrivate),
  sig: r.sig === null ? null : hex(r.sig as unknown as string),
});
const grant = (g: Hex<KeyGrant>): KeyGrant => ({ ...g, wrap: wrap(g.wrap), signature: hex(g.signature) });
const recovery = (r: Hex<RecoveryRecord>): RecoveryRecord => ({
  v: r.v,
  kv: r.kv,
  spki: hex(r.spki),
  privateKey: envelope(r.privateKey),
  signSpki: hex(r.signSpki),
  signPrivate: envelope(r.signPrivate),
  teamKey: wrap(r.teamKey),
  check: envelope(r.check),
});

async function aes(rawHex: string, version: number, extractable = false) {
  return { version, key: await crypto.subtle.importKey("raw", hex(rawHex), "AES-GCM", extractable, ["encrypt", "decrypt"]) };
}
async function exportHex(key: CryptoKey): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.exportKey("raw", key)));
}
/** AES-256-GCM decryption by node:crypto, independent of WebCrypto. */
function nodeOpen(key: Uint8Array, iv: Uint8Array, ct: Uint8Array, aad: string): Buffer {
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(ct.subarray(ct.length - 16));
  return Buffer.concat([decipher.update(ct.subarray(0, ct.length - 16)), decipher.final()]);
}
/** The ECIES unwrap by node:crypto: ECDH, then HKDF with the ephemeral key as salt and the AAD as info. */
function nodeUnwrap(pkcs8Hex: string, w: PublicKeyWrap, aad: string): Buffer {
  const d = createPrivateKey({ key: Buffer.from(pkcs8Hex, "hex"), format: "der", type: "pkcs8" }).export({ format: "jwk" }).d!;
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(Buffer.from(d, "base64url"));
  const shared = ecdh.computeSecret(w.epk);
  const key = new Uint8Array(hkdfSync("sha256", shared, w.epk, Buffer.from(aad, "utf8"), 32));
  return nodeOpen(key, w.iv, w.ct, aad);
}

const teamId = vectors.teamId;

describe("known answers", () => {
  it("seals AES-256-GCM exactly as node:crypto does", async () => {
    const key = await aes(toHex(new Uint8Array(32).map((_, i) => i)), 1);
    const aad = aadFor.autoTitle({ teamId: "t1", autoId: "a1", gen: 1, kv: 1 });
    const sealed = await sealBytes(key, utf8Encode("zenith"), aad, counting());
    expect(toHex(sealed.iv)).toBe("000102030405060708090a0b");
    expect(toHex(sealed.ct)).toBe("3d67b872b18dcad97e29c5f1356280253eb377a14bf0");
    const cipher = createCipheriv("aes-256-gcm", new Uint8Array(32).map((_, i) => i), sealed.iv);
    cipher.setAAD(Buffer.from(aad));
    expect(toHex(Buffer.concat([cipher.update("zenith"), cipher.final(), cipher.getAuthTag()]))).toBe(toHex(sealed.ct));
  });

  it("derives the link id and link key with HKDF-SHA-256, empty salt, and the spec's info strings", async () => {
    const secret = hex(vectors.link.secret);
    expect(linkSecretToText(secret)).toBe(vectors.link.text);
    expect(await deriveLinkId(secret)).toBe(vectors.link.id);
    const nodeId = Buffer.from(hkdfSync("sha256", secret, new Uint8Array(0), "zenith/v1/link-id", 16)).toString("base64url");
    expect(nodeId).toBe(vectors.link.id);

    const aad = aadFor.shareProjection({ shareId: vectors.link.id, autoId: vectors.link.autoId, kv: 1 });
    expect(aad).toBe(`zenith/v1/share-projection|share=${vectors.link.id}|auto=${vectors.link.autoId}|kv=1`);
    const projection = envelope(vectors.link.projection);
    expect(await openText(await deriveLinkKey(secret), projection, aad)).toBe('{"link":true}');
    const nodeKey = new Uint8Array(hkdfSync("sha256", secret, new Uint8Array(0), "zenith/v1/link-key", 32));
    expect(gunzipSync(nodeOpen(nodeKey, projection.iv, projection.ct, aad)).toString("utf8")).toBe('{"link":true}');
  });

  it("opens the pinned key chain from version 3 down to 1", async () => {
    const v3 = await aes(vectors.teamKeys.v3, 3);
    const ring = await openChain(teamId, v3, vectors.records.map(record), { extractable: true });
    expect(await exportHex(ring.get(1)!.key.key)).toBe(vectors.teamKeys.v1);
    expect(await exportHex(ring.get(2)!.key.key)).toBe(vectors.teamKeys.v2);
    expect(toHex(ring.get(3)!.pair.spki)).toBe(vectors.encKey3.spki);
    // Key 2 inside record 3, recomputed with node:crypto.
    const prev = envelope(vectors.records[2]!.prev!);
    expect(nodeOpen(hex(vectors.teamKeys.v3), prev.iv, prev.ct, aadFor.teamKeyChain({ teamId, kv: 3 })).toString("hex")).toBe(vectors.teamKeys.v2);
  });

  it("opens the pinned grant, whose signature node:crypto also verifies", async () => {
    const d = vectors.device;
    const encryption = await crypto.subtle.importKey("pkcs8", hex(d.encPkcs8), { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
    const device = { deviceId: d.deviceId, encryption: { privateKey: encryption } as CryptoKeyPair, fingerprint: hex(d.fingerprint) } as Pick<DeviceKeys, "deviceId" | "encryption" | "fingerprint">;
    const pinned = grant(vectors.grant);
    expect(pinned.wrap.epk.length + pinned.wrap.iv.length + pinned.wrap.ct.length).toBe(125);
    const deviceRecord = { v: 1 as const, encSpki: hex(d.encSpki), signSpki: hex(d.signSpki), fingerprint: hex(d.fingerprint) };
    const key = await openKeyGrant({ teamId, grant: pinned, device, approver: { deviceId: d.deviceId, record: deviceRecord }, extractable: true });
    expect(await exportHex(key.key)).toBe(vectors.teamKeys.v3);

    const aad = aadFor.keyGrant({ teamId, deviceId: d.deviceId, kv: 3 });
    expect(nodeUnwrap(d.encPkcs8, pinned.wrap, aad).toString("hex")).toBe(vectors.teamKeys.v3);
    const signer = createPublicKey({ key: Buffer.from(d.signSpki, "hex"), format: "der", type: "spki" });
    const signed = keyGrantSignedBytes(pinned, hex(d.fingerprint));
    expect(nodeVerify("sha256", signed, { key: signer, dsaEncoding: "ieee-p1363" }, pinned.signature)).toBe(true);
    const uid = Buffer.from("ada").toString("base64url");
    const label = `zenith/v1/key-grant-signature|team=${teamId}|device=${d.deviceId}|uid=${uid}|kv=3|approver=${d.deviceId}\u0000`;
    expect(Buffer.from(signed.subarray(0, label.length)).toString("latin1")).toBe(label);
    // The recipient's fingerprint comes next, then the wrap.
    expect(toHex(signed.subarray(label.length, label.length + 32))).toBe(d.fingerprint);
    expect(signed.length).toBe(label.length + 32 + 125);
  });

  it("prints and reads the pinned recovery code, and it opens the pinned record", async () => {
    const code = hex(vectors.recovery.code);
    expect(await recoveryCodeToText(code)).toBe(vectors.recovery.text);
    expect(await recoveryCodeFromText(vectors.recovery.text)).toEqual(code);
    const record = recovery(vectors.recovery.record);
    const key = await openRecovery({ teamId, record, code, extractable: true });
    expect(key.version).toBe(3);
    expect(await exportHex(key.key)).toBe(vectors.teamKeys.v3);
    // The signing pair opens with the same code, and its public half is the record's.
    const signer = await openRecoverySigner({ teamId, record, code });
    const probe = utf8Encode("known answer");
    const signature = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, signer, probe));
    const signPublic = createPublicKey({ key: Buffer.from(record.signSpki), format: "der", type: "spki" });
    expect(nodeVerify("sha256", probe, { key: signPublic, dsaEncoding: "ieee-p1363" }, signature)).toBe(true);
    // Its private half, recomputed with node:crypto: sealed under the code's HKDF key.
    const codeKey = new Uint8Array(hkdfSync("sha256", code, new Uint8Array(0), "zenith/v1/recovery-key", 32));
    const pkcs8 = nodeOpen(codeKey, record.signPrivate.iv, record.signPrivate.ct, aadFor.recoverySigningKey({ teamId }));
    expect(toHex(createPublicKey(createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" })).export({ format: "der", type: "spki" }))).toBe(toHex(record.signSpki));
    // A roster names the record by SHA-256 of both public halves.
    expect(toHex(await recoveryFingerprint(record))).toBe(createHash("sha256").update(record.spki).update(record.signSpki).digest("hex"));
  });

  it("opens the pinned device roster of version 3, whose digest and signature node:crypto recomputes", async () => {
    const r = vectors.roster3;
    const sealed = envelope(r.roster);
    const r3 = record(vectors.records[2]!);
    const opened = await openRoster(teamId, await aes(vectors.teamKeys.v3, 3), { kv: 3, roster: sealed });
    expect(opened.roster).toMatchObject({ v: 1, teamId, kv: 3, rotator: vectors.device.deviceId, members: [{ uid: "ada", role: "owner" }], via: [] });
    expect(opened.roster.devices.map((device) => [device.deviceId, device.uid, toHex(device.encSpki), toHex(device.signSpki), toHex(device.fingerprint)])).toEqual([
      [vectors.device.deviceId, "ada", vectors.device.encSpki, vectors.device.signSpki, vectors.device.fingerprint],
    ]);
    expect(toHex(opened.roster.recovery)).toBe(toHex(await recoveryFingerprint(recovery(vectors.recovery.record))));
    const plaintext = nodeOpen(hex(vectors.teamKeys.v3), sealed.iv, sealed.ct, aadFor.teamRoster({ teamId, kv: 3 }));
    // The JSON holds each device's two public keys, not its fingerprint, which comes from them.
    expect(JSON.parse(plaintext.toString("utf8"))).toEqual({
      v: 1,
      teamId,
      kv: 3,
      rotator: vectors.device.deviceId,
      nonce: Buffer.from(new Uint8Array(16).map((_, i) => i)).toString("base64url"),
      recovery: Buffer.from(opened.roster.recovery).toString("base64url"),
      members: [{ uid: "ada", role: "owner" }],
      devices: [{ deviceId: vectors.device.deviceId, uid: "ada", encSpki: Buffer.from(vectors.device.encSpki, "hex").toString("base64url"), signSpki: Buffer.from(vectors.device.signSpki, "hex").toString("base64url") }],
      via: [],
    });
    const digest = createHash("sha256").update(`zenith/v1/team-roster-digest|team=${teamId}|kv=3`).update(new Uint8Array([0])).update(sealed.iv).update(sealed.ct).digest();
    expect(digest.toString("hex")).toBe(r.digest);
    expect(toHex(opened.digest)).toBe(r.digest);
    const pairFingerprint = createHash("sha256").update(r3.pairSpki).digest();
    const signed = rosterSignedBytes(teamId, 3, digest, createHash("sha256").update(plaintext).digest(), pairFingerprint, r3.signSpki);
    const label = `zenith/v1/team-roster-signature|team=${teamId}|kv=3\u0000`;
    expect(Buffer.from(signed.subarray(0, label.length)).toString("latin1")).toBe(label);
    expect(signed.length).toBe(label.length + 32 + 32 + 32 + 91);
    const signer = createPublicKey({ key: Buffer.from(vectors.device.signSpki, "hex"), format: "der", type: "spki" });
    expect(nodeVerify("sha256", signed, { key: signer, dsaEncoding: "ieee-p1363" }, hex(r.rosterSig))).toBe(true);
  });

  it("opens the pinned share as the partner team and as the owner", async () => {
    const s = vectors.share;
    const partnerPair = await openTeamKeyRecord(s.recipientTeamId, await aes(s.partnerKey1, 1), record(s.partnerRecord1));
    const keyWrap = { ...wrap(s.keyWrap), ekv: s.keyWrap.ekv };
    const asPartner = await unwrapShareKeyAsTeam({ shareId: s.shareId, teamId: s.recipientTeamId, shareKeyVersion: 1, wrap: keyWrap, pair: partnerPair, extractable: true });
    expect(await exportHex(asPartner.key)).toBe(s.shareKey);
    const asOwner = await unwrapShareKeyAsOwner({ shareId: s.shareId, teamId, shareKeyVersion: 1, wrap: envelope(s.ownerWrap), teamKey: await aes(vectors.teamKeys.v3, 3), extractable: true });
    expect(await exportHex(asOwner.key)).toBe(s.shareKey);
    const aad = aadFor.shareProjection({ shareId: s.shareId, autoId: s.autoId, kv: 1 });
    expect(await openJson(asPartner, envelope(s.projection), aad)).toEqual({ title: "Known answer", steps: [1, 2, 3] });
    const projection = envelope(s.projection);
    expect(gunzipSync(nodeOpen(hex(s.shareKey), projection.iv, projection.ct, aad)).toString("utf8")).toBe('{"steps":[1,2,3],"title":"Known answer"}');
  });

  it("encodes, commits to and signs the pinned share's manifest as node:crypto checks it", async () => {
    const s = vectors.share;
    const m = vectors.shareManifest;
    const info = `zenith/v1/share-key-commit|share=${s.shareId}|skv=1`;
    const commit = new Uint8Array(hkdfSync("sha256", hex(s.shareKey), new Uint8Array(0), Buffer.from(info, "utf8"), 32));
    expect(toHex(commit)).toBe(m.commit);
    expect(toHex(await shareKeyCommitment({ shareId: s.shareId, skv: 1, raw: hex(s.shareKey) }))).toBe(m.commit);
    // The sharer's choices, sealed under the owner team's key 3, and their digest, which the manifest names.
    const choice = envelope(s.ownerChoice);
    const choiceAad = `zenith/v1/owner-choice|share=${s.shareId}|team=${teamId}|kv=3`;
    expect(aadFor.ownerChoice({ shareId: s.shareId, teamId, kv: 3 })).toBe(choiceAad);
    expect(gunzipSync(nodeOpen(hex(vectors.teamKeys.v3), choice.iv, choice.ct, choiceAad)).toString("utf8")).toBe('{"coarsen":true}');
    const choiceDigest = createHash("sha256").update(`zenith/v2/owner-choice-digest|share=${s.shareId}|kv=3`).update(new Uint8Array([0])).update(choice.iv).update(choice.ct).digest();
    expect(choiceDigest.toString("hex")).toBe(m.choice);
    expect(toHex(await ownerChoiceDigest({ shareId: s.shareId, choice }))).toBe(m.choice);
    const d = vectors.device;
    // The partner's key of version 1, named by SHA-256 of the label, a zero byte, its ECDH fingerprint and its signing key.
    const partnerFingerprint = createHash("sha256").update(hex(s.partnerRecord1.pairSpki)).digest();
    const partnerDigest = createHash("sha256")
      .update(`zenith/v4/team-key-digest|team=${s.recipientTeamId}|ekv=1`)
      .update(new Uint8Array([0]))
      .update(partnerFingerprint)
      .update(hex(s.partnerRecord1.signSpki))
      .digest();
    expect(partnerDigest.toString("hex")).toBe(m.partnerKeyDigest);
    expect(toHex(await teamKeyDigest({ teamId: s.recipientTeamId, v: 1, fingerprint: new Uint8Array(partnerFingerprint), signSpki: hex(s.partnerRecord1.signSpki) }))).toBe(m.partnerKeyDigest);
    const text =
      `zenith/v5/share-manifest|share=${s.shareId}|owner=${teamId}|aid=${s.autoId}|rid=${m.revisionId}|aud=teams|mode=pinned|lvl=view|rev=0` +
      `|exp=${String(m.expiresAtMs)}|seq=1|skv=1|wkv=3|okv=3|dev=${d.deviceId}|tseq=1|tdev=${d.deviceId}|och=${choiceDigest.toString("base64url")}` +
      `|teams=${s.recipientTeamId}:1:${partnerDigest.toString("base64url")}`;
    expect(m.body).toBe(Buffer.concat([Buffer.from(text, "utf8"), Buffer.from([0]), commit]).toString("hex"));
    const body = {
      shareId: s.shareId, ownerTeamId: teamId, autoId: s.autoId, revisionId: m.revisionId, audience: "teams" as const, mode: "pinned" as const, level: "view" as const, revoked: false,
      expiresAtMs: m.expiresAtMs, seq: m.seq, skv: m.skv, wkv: m.wkv, okv: m.okv, device: d.deviceId, termsSeq: 1, termsDevices: [d.deviceId], choice: new Uint8Array(choiceDigest),
      teams: [[s.recipientTeamId, 1, new Uint8Array(partnerDigest)] as const], commit,
    };
    expect(toHex(encodeShareManifestBody(body))).toBe(m.body);
    expect(decodeShareManifestBody(hex(m.body))).toEqual({ ...body, teams: [[s.recipientTeamId, 1, new Uint8Array(partnerDigest)]] });
    const signSpki = hex(vectors.records.find((r) => r.kv === 3)!.signSpki);
    const signer = createPublicKey({ key: Buffer.from(signSpki), format: "der", type: "spki" });
    expect(nodeVerify("sha256", hex(m.body), { key: signer, dsaEncoding: "ieee-p1363" }, hex(m.sig))).toBe(true);
    // The pinned device signed it too, and the manifest carries that device's two keys, whose id the body names.
    const deviceSigner = createPublicKey({ key: Buffer.from(hex(d.signSpki)), format: "der", type: "spki" });
    expect(nodeVerify("sha256", hex(m.body), { key: deviceSigner, dsaEncoding: "ieee-p1363" }, hex(m.dsig))).toBe(true);
    const dkeys = new Uint8Array([...hex(d.encSpki), ...hex(d.signSpki)]);
    expect(createHash("sha256").update(dkeys).digest().subarray(0, 16).toString("base64url")).toBe(d.deviceId);
    // The device that made the share signed its terms, the statement every later manifest that
    // changes no term carries, and the manifest carries that device's keys for it too.
    const terms =
      `zenith/v5/share-terms|share=${s.shareId}|owner=${teamId}|aid=${s.autoId}|aud=teams|mode=pinned|lvl=view|rev=0|exp=${String(m.expiresAtMs)}` +
      `|okv=3|tseq=1|tdev=${d.deviceId}|rid=${m.revisionId}|och=${choiceDigest.toString("base64url")}|teams=${s.recipientTeamId}:1:${partnerDigest.toString("base64url")}`;
    expect(nodeVerify("sha256", Buffer.from(terms, "utf8"), { key: deviceSigner, dsaEncoding: "ieee-p1363" }, hex(m.tsig))).toBe(true);
    const stored = { v: 5 as const, body: hex(m.body), sig: hex(m.sig), dsig: hex(m.dsig), dkeys, tsig: hex(m.tsig), tkeys: dkeys };
    const opened = await openShareManifest({ manifest: stored, signSpki });
    expect(opened.okv).toBe(3);
    expect(Buffer.from(shareTermsStatement(opened)).toString("utf8")).toBe(terms);
    // A roster lists a share by the SHA-256 of its manifest's body.
    expect(createHash("sha256").update(hex(m.body)).digest("hex")).toBe(m.digest);
    expect(toHex(await shareManifestDigest(stored))).toBe(m.digest);
    // The pinned wraps open with the commitment given, and the owner's with it too.
    const partnerPair = await openTeamKeyRecord(s.recipientTeamId, await aes(s.partnerKey1, 1), record(s.partnerRecord1));
    const asPartner = await unwrapShareKeyAsTeam({ shareId: s.shareId, teamId: s.recipientTeamId, shareKeyVersion: 1, wrap: { ...wrap(s.keyWrap), ekv: 1 }, pair: partnerPair, commit, extractable: true });
    expect(await exportHex(asPartner.key)).toBe(s.shareKey);
    await unwrapShareKeyAsOwner({ shareId: s.shareId, teamId, shareKeyVersion: 1, wrap: envelope(s.ownerWrap), teamKey: await aes(vectors.teamKeys.v3, 3), commit });
  });

  it("encodes, commits to and signs the pinned link share's manifest as node:crypto checks it", async () => {
    const l = vectors.link;
    const m = vectors.linkManifest;
    // The commitment is to the key the link derives, which node:crypto derives from the secret.
    const linkKey = hkdfSync("sha256", hex(l.secret), new Uint8Array(0), "zenith/v1/link-key", 32);
    const commit = new Uint8Array(hkdfSync("sha256", new Uint8Array(linkKey), new Uint8Array(0), Buffer.from(`zenith/v1/share-key-commit|share=${l.id}|skv=1`, "utf8"), 32));
    expect(toHex(commit)).toBe(m.commit);
    expect(toHex(await commitLinkKey({ shareId: l.id, secret: hex(l.secret) }))).toBe(m.commit);
    const d = vectors.device;
    const { revisionId, expiresAtMs } = vectors.shareManifest;
    const text =
      `zenith/v5/share-manifest|share=${l.id}|owner=${teamId}|aid=${l.autoId}|rid=${revisionId}|aud=link|mode=follow|lvl=view|rev=0` +
      `|exp=${String(expiresAtMs)}|seq=1|skv=1|wkv=3|okv=3|dev=${d.deviceId}|tseq=1|tdev=${d.deviceId}|och=-|teams=`;
    expect(m.body).toBe(Buffer.concat([Buffer.from(text, "utf8"), Buffer.from([0]), commit]).toString("hex"));
    const signSpki = hex(vectors.records.find((r) => r.kv === 3)!.signSpki);
    const signer = createPublicKey({ key: Buffer.from(signSpki), format: "der", type: "spki" });
    expect(nodeVerify("sha256", hex(m.body), { key: signer, dsaEncoding: "ieee-p1363" }, hex(m.sig))).toBe(true);
    const deviceSigner = createPublicKey({ key: Buffer.from(hex(d.signSpki)), format: "der", type: "spki" });
    expect(nodeVerify("sha256", hex(m.body), { key: deviceSigner, dsaEncoding: "ieee-p1363" }, hex(m.dsig))).toBe(true);
    const dkeys = new Uint8Array([...hex(d.encSpki), ...hex(d.signSpki)]);
    // A following share's revision is not one of its terms, so its terms statement names none.
    const terms = `zenith/v5/share-terms|share=${l.id}|owner=${teamId}|aid=${l.autoId}|aud=link|mode=follow|lvl=view|rev=0|exp=${String(expiresAtMs)}|okv=3|tseq=1|tdev=${d.deviceId}|rid=|och=-|teams=`;
    expect(nodeVerify("sha256", Buffer.from(terms, "utf8"), { key: deviceSigner, dsaEncoding: "ieee-p1363" }, hex(m.tsig))).toBe(true);
    const body = await openShareManifest({ manifest: { v: 5, body: hex(m.body), sig: hex(m.sig), dsig: hex(m.dsig), dkeys, tsig: hex(m.tsig), tkeys: dkeys }, signSpki });
    expect(body).toMatchObject({ audience: "link", teams: [], choice: null, autoId: l.autoId, revisionId, expiresAtMs, device: d.deviceId, termsSeq: 1, termsDevices: [d.deviceId] });
  });

  it("opens the pinned link secret under the owner key, for the auto it names", async () => {
    const l = vectors.link;
    const wrapped = envelope(l.ownerWrap);
    const secret = await unwrapLinkSecretAsOwner({ shareId: l.id, teamId, autoId: l.autoId, wrap: wrapped, teamKey: await aes(vectors.teamKeys.v3, 3) });
    expect(toHex(secret)).toBe(l.secret);
    const aad = `zenith/v1/link-wrap|share=${l.id}|team=${teamId}|auto=${l.autoId}|kv=3`;
    expect(nodeOpen(hex(vectors.teamKeys.v3), wrapped.iv, wrapped.ct, aad).toString("hex")).toBe(l.secret);
  });

  it("gives the pinned device verification code and team safety code", async () => {
    const d = vectors.device;
    expect(toHex(await deviceFingerprint(hex(d.encSpki), hex(d.signSpki)))).toBe(d.fingerprint);
    expect(await deviceVerificationCode(hex(d.encSpki), hex(d.signSpki))).toBe(d.verificationCode);
    const encKey3 = { v: 3, spki: hex(vectors.encKey3.spki), fingerprint: hex(vectors.encKey3.fingerprint), signSpki: hex(vectors.encKey3.signSpki), sig: hex(vectors.encKey3.sig) };
    expect(await teamSafetyCode(encKey3)).toBe(vectors.teamSafetyCode3);
    // The same twenty digits from node:crypto: PBKDF2-SHA-256 with 2^18 iterations under a fixed salt per
    // kind, of the device fingerprint, or of the team's ECDH fingerprint and signing key.
    const digits = (input: Uint8Array, salt: string) => {
      const out = pbkdf2Sync(input, salt, 262_144, 32, "sha256");
      const value = (out.readBigUInt64BE(0) << 64n) | out.readBigUInt64BE(8);
      return (value % 10n ** 20n).toString().padStart(20, "0").match(/.{4}/g)!.join(" ");
    };
    expect(d.verificationCode).toBe(digits(hex(d.fingerprint), "zenith/v2/device-verification-code"));
    expect(vectors.teamSafetyCode3).toBe(digits(Buffer.concat([encKey3.fingerprint, encKey3.signSpki]), "zenith/v2/team-safety-code"));
  });

  it("chains the pinned team signing keys, each version signed by the one below, as node:crypto verifies", async () => {
    const records = vectors.records.map(record);
    for (const kv of [2, 3]) {
      const below = records[kv - 2]!;
      const above = records[kv - 1]!;
      const fingerprint = createHash("sha256").update(above.pairSpki).digest();
      const signed = teamKeySignedBytes(teamId, kv, fingerprint, above.signSpki);
      const label = `zenith/v1/team-key-signature|team=${teamId}|kv=${String(kv)}\u0000`;
      expect(Buffer.from(signed.subarray(0, label.length)).toString("latin1")).toBe(label);
      expect(signed.length).toBe(label.length + 32 + 91);
      const signer = createPublicKey({ key: Buffer.from(below.signSpki), format: "der", type: "spki" });
      expect(nodeVerify("sha256", signed, { key: signer, dsaEncoding: "ieee-p1363" }, above.sig!)).toBe(true);
      expect(await checkTeamKeyStep(teamId, below.signSpki, { v: kv, fingerprint, signSpki: above.signSpki, sig: above.sig })).toBe(true);
    }
    expect(toHex(records[2]!.signSpki)).toBe(vectors.encKey3.signSpki);
    // Each signing private key opens under its own team key, with node:crypto too.
    const raw = [vectors.teamKeys.v1, vectors.teamKeys.v2, vectors.teamKeys.v3];
    for (const [i, r] of records.entries()) {
      const aad = aadFor.teamSigningKey({ teamId, kv: r.kv, fingerprint: createHash("sha256").update(r.signSpki).digest() });
      const pkcs8 = nodeOpen(hex(raw[i]!), r.signPrivate.iv, r.signPrivate.ct, aad);
      const publicSpki = createPublicKey(createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" })).export({ format: "der", type: "spki" });
      expect(toHex(publicSpki)).toBe(toHex(r.signSpki));
    }
  });

  it("derives the approval code's device part and MAC as node:crypto does", async () => {
    const d = vectors.device;
    const fingerprint = hex(d.fingerprint);
    const secret = new Uint8Array([1, 2, 3, 4, 5]);
    const codeLabel = `zenith/v1/approval-code|team=${teamId}|uid=${Buffer.from("ada").toString("base64url")}`;
    const digest = createHash("sha256").update(codeLabel).update(new Uint8Array([0])).update(secret).update(fingerprint).digest();
    const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    let bits = digest.readBigUInt64BE(0) >> 14n;
    let expected = "";
    for (let i = 0; i < 10; i++) {
      expected = alphabet[Number(bits & 31n)] + expected;
      bits >>= 5n;
    }
    const codeSubject = { teamId, uid: "ada", fingerprint };
    expect(await approvalPublicPart(codeSubject, secret)).toBe(expected);
    const code = await approvalCodeFor(codeSubject, secret);
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{6}-[0-9A-HJKMNP-TV-Z]{6}-[0-9A-HJKMNP-TV-Z]{6}$/);
    expect(code.replaceAll("-", "").slice(0, 10)).toBe(expected);
    expect(await approvalSecretFrom(code.toLowerCase().replaceAll("-", " "), codeSubject)).toEqual(secret);

    const teamKey = await aes(vectors.teamKeys.v3, 3, true);
    const signSpki = hex(vectors.encKey3.signSpki);
    const encFingerprint = hex(vectors.encKey3.fingerprint);
    const rosterDigest = hex(vectors.roster3.digest);
    const subject = { teamId, deviceId: d.deviceId, uid: "ada", teamKey, encFingerprint, signSpki, rosterDigest };
    const key = await approvalKey({ teamId, deviceId: d.deviceId, secret });
    const mac = await makeApprovalMac(key, subject);
    const kdf = pbkdf2Sync(secret, `zenith/v1/approval-salt|team=${teamId}|device=${d.deviceId}`, APPROVAL_KDF_ITERATIONS, 32, "sha256");
    const commitment = createHash("sha256").update("zenith/v1/team-key-commitment").update(new Uint8Array([0])).update(hex(vectors.teamKeys.v3)).digest();
    const label = `zenith/v1/approval-mac|team=${teamId}|device=${d.deviceId}|uid=${Buffer.from("ada").toString("base64url")}|kv=3`;
    const nodeMac = createHmac("sha256", kdf).update(label).update(new Uint8Array([0])).update(encFingerprint).update(signSpki).update(commitment).update(rosterDigest).digest();
    expect(toHex(mac)).toBe(nodeMac.toString("hex"));
    expect(await checkApprovalMac(key, subject, mac)).toBe(true);
    expect(await checkApprovalMac(key, { ...subject, uid: "eve" }, mac)).toBe(false);
  });
});
