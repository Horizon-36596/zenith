/**
 * Share keys, link secrets, the recovery code and the verification codes (spec 14 sections 4.3,
 * 4.6, 4.7 and 5.3).
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  aadFor,
  codeFromHash,
  commitLinkKey,
  commitShareKey,
  ownerChoiceDigest,
  sealText,
  shareKeyCommitment,
  shareManifestDigest,
  type ShareManifestBody,
  decodeShareManifestBody,
  encodeShareManifestBody,
  MAX_TERMS_DEVICES,
  openShareManifest,
  sameShareTerms,
  shareTermsStatement,
  signShareManifest,
  TEAM_KEY_DIGEST_BYTES,
  teamKeyDigest,
  createRecovery,
  createTeamKeys,
  deriveLinkId,
  deriveLinkKey,
  deviceVerificationCode,
  generateDeviceKeys,
  LINK_SECRET_TEXT_LENGTH,
  linkSecretFromText,
  linkSecretToText,
  newLinkSecret,
  newRecoveryCode,
  newShareKey,
  openChain,
  openJson,
  openRecovery,
  recoveryCodeFromText,
  recoveryCodeToText,
  rewrapRecovery,
  rotateTeamKeys,
  sealJson,
  teamSafetyCode,
  unwrapLinkSecretAsOwner,
  unwrapShareKeyAsOwner,
  unwrapShareKeyAsTeam,
  wrapLinkSecretForOwner,
  wrapShareKeyForOwner,
  wrapShareKeyToTeam,
  type RecoveryRecord,
} from "../src/crypto/index.js";
import { randomId } from "../src/ids.js";
import { utf8Decode, utf8Encode } from "../src/crypto/bytes.js";
import { deriveLinkKeyBytes } from "../src/crypto/share.js";
import { counting, flip, rejectsWith, throwsWith } from "./cryptoHelpers.js";

const owner = "t_owner000000000000001";
const partner = "t_partner0000000000001";
const shareId = "s_share0000000000000001";

async function exportRaw(key: CryptoKey): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.exportKey("raw", key));
}

/** The pattern `isRandomId` in cloud/firestore.rules and in the in-memory rules accepts. */
const RULES_RANDOM_ID = /^[A-Za-z0-9_-]{22,64}$/;
/** The pattern the web app's `#/s/<id>` route accepts. */
const LINK_ROUTE = /^#\/s\/([A-Za-z0-9_-]{22})$/;

describe("share keys to teams", () => {
  it("wraps a share key to a partner's encKey and under the owner key, and both open it", async () => {
    const ownerKeys = await createTeamKeys(owner);
    const partnerKeys = await createTeamKeys(partner);
    const shareKey = await newShareKey();
    expect(shareKey.version).toBe(1);
    const projectionAad = aadFor.shareProjection({ shareId, autoId: "a1", kv: shareKey.version });
    const projection = await sealJson(shareKey, { title: "far side", steps: [1, 2] }, projectionAad);

    const keyWrap = await wrapShareKeyToTeam({ shareId, teamId: partner, shareKey, encKey: partnerKeys.encKey });
    expect(keyWrap.ekv).toBe(1);
    expect(keyWrap.epk.length + keyWrap.iv.length + keyWrap.ct.length).toBe(125);
    const asPartner = await unwrapShareKeyAsTeam({ shareId, teamId: partner, shareKeyVersion: projection.kv, wrap: keyWrap, pair: partnerKeys.pair });
    expect(asPartner.key.extractable).toBe(false);
    expect(await openJson(asPartner, projection, projectionAad)).toEqual({ title: "far side", steps: [1, 2] });

    const ownerWrap = await wrapShareKeyForOwner({ shareId, teamId: owner, shareKey, teamKey: ownerKeys.key });
    const asOwner = await unwrapShareKeyAsOwner({ shareId, teamId: owner, shareKeyVersion: projection.kv, wrap: ownerWrap, teamKey: ownerKeys.key });
    expect(await openJson(asOwner, projection, projectionAad)).toEqual({ title: "far side", steps: [1, 2] });
  });

  it("lets a partner open a wrap made to an older encKey through its key chain", async () => {
    const v1 = await createTeamKeys(partner);
    const shareKey = await newShareKey();
    const keyWrap = await wrapShareKeyToTeam({ shareId, teamId: partner, shareKey, encKey: v1.encKey });
    const v2 = await rotateTeamKeys(partner, v1);
    await rejectsWith(unwrapShareKeyAsTeam({ shareId, teamId: partner, shareKeyVersion: 1, wrap: keyWrap, pair: v2.pair }), "wrong-key-version");
    const ring = await openChain(partner, v2.key, [v2.record, v1.record]);
    const opened = await unwrapShareKeyAsTeam({ shareId, teamId: partner, shareKeyVersion: 1, wrap: keyWrap, pair: ring.get(keyWrap.ekv)!.pair, extractable: true });
    expect(await exportRaw(opened.key)).toEqual(await exportRaw(shareKey.key));
  });

  it("binds each wrap to its share, its team and its versions", async () => {
    const ownerKeys = await createTeamKeys(owner);
    const partnerKeys = await createTeamKeys(partner);
    const shareKey = await newShareKey(2);
    const keyWrap = await wrapShareKeyToTeam({ shareId, teamId: partner, shareKey, encKey: partnerKeys.encKey });
    const asTeam = (patch: Record<string, unknown>) =>
      unwrapShareKeyAsTeam({ shareId, teamId: partner, shareKeyVersion: 2, wrap: keyWrap, pair: partnerKeys.pair, ...patch });
    await rejectsWith(asTeam({ shareId: "s_other" }), "decrypt-failed");
    await rejectsWith(asTeam({ teamId: owner }), "decrypt-failed");
    await rejectsWith(asTeam({ shareKeyVersion: 1 }), "decrypt-failed");
    await rejectsWith(asTeam({ wrap: { ...keyWrap, ct: flip(keyWrap.ct) } }), "decrypt-failed");
    await rejectsWith(asTeam({ wrap: { ...keyWrap, ekv: 0 } }), "bad-envelope");
    await rejectsWith(wrapShareKeyToTeam({ shareId, teamId: partner, shareKey, encKey: { ...partnerKeys.encKey, spki: ownerKeys.encKey.spki } }), "bad-key");

    const ownerWrap = await wrapShareKeyForOwner({ shareId, teamId: owner, shareKey, teamKey: ownerKeys.key });
    const asOwner = (patch: Record<string, unknown>) =>
      unwrapShareKeyAsOwner({ shareId, teamId: owner, shareKeyVersion: 2, wrap: ownerWrap, teamKey: ownerKeys.key, ...patch });
    await rejectsWith(asOwner({ shareKeyVersion: 1 }), "decrypt-failed");
    await rejectsWith(asOwner({ teamId: partner }), "decrypt-failed");
    await rejectsWith(asOwner({ teamKey: partnerKeys.key }), "decrypt-failed");
    await rejectsWith(asOwner({ wrap: { ...ownerWrap, iv: flip(ownerWrap.iv) } }), "decrypt-failed");
  });

  it("makes the share key from the injected random bytes", async () => {
    const shareKey = await newShareKey(1, counting(7));
    expect(await exportRaw(shareKey.key)).toEqual(new Uint8Array(32).map((_, i) => 7 + i));
    await rejectsWith(newShareKey(0), "bad-input");
  });
});

describe("link secrets", () => {
  it("is 16 random bytes written as 22 base64url characters, and the link is 58 characters", () => {
    const secret = newLinkSecret();
    expect(secret.length).toBe(16);
    const text = linkSecretToText(secret);
    expect(text.length).toBe(LINK_SECRET_TEXT_LENGTH);
    expect(text).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(linkSecretFromText(text)).toEqual(secret);
    const link = `https://zenith.horizon36596.org/#/s/${text}`;
    expect(link.length).toBe(58);
    expect(LINK_ROUTE.exec(`#/s/${text}`)?.[1]).toBe(text);
  });

  it("reads back only exactly 22 canonical characters", () => {
    const text = linkSecretToText(new Uint8Array(16).fill(255));
    expect(text).toBe("_____________________w");
    throwsWith(() => linkSecretFromText(text.slice(1)), "bad-input");
    throwsWith(() => linkSecretFromText(`${text}A`), "bad-input");
    throwsWith(() => linkSecretFromText("_____________________x"), "bad-input");
    throwsWith(() => linkSecretFromText("____________________+w"), "bad-input");
    throwsWith(() => linkSecretToText(new Uint8Array(15)), "bad-input");
  });

  it("derives a share id that passes the same checks as a random share id", async () => {
    for (let i = 0; i < 20; i++) {
      const id = await deriveLinkId(newLinkSecret());
      expect(id.length).toBe(22);
      expect(id).toMatch(RULES_RANDOM_ID);
      expect(randomId(counting(i)).length).toBe(id.length);
    }
  });

  it("derives the id and the key deterministically, and differently from each other", async () => {
    const secret = newLinkSecret(counting(0));
    expect(await deriveLinkId(secret)).toBe(await deriveLinkId(new Uint8Array(secret)));
    expect(await deriveLinkId(secret)).not.toBe(await deriveLinkId(flip(secret)));
    const key = await deriveLinkKey(secret);
    expect(key.version).toBe(1);
    expect(key.key.extractable).toBe(false);
    expect(key.key.algorithm).toMatchObject({ name: "AES-GCM", length: 256 });
    const id = await deriveLinkId(secret);
    const aad = aadFor.shareProjection({ shareId: id, autoId: "a1", kv: 1 });
    const sealed = await sealJson(key, { a: 1 }, aad);
    expect(await openJson(await deriveLinkKey(secret), sealed, aad)).toEqual({ a: 1 });
    await rejectsWith(openJson(await deriveLinkKey(flip(secret)), sealed, aad), "decrypt-failed");
  });

  it("keeps S for the sharing team under the owner key", async () => {
    const ownerKeys = await createTeamKeys(owner);
    const secret = newLinkSecret();
    const id = await deriveLinkId(secret);
    const wrap = await wrapLinkSecretForOwner({ shareId: id, teamId: owner, autoId: "a1", secret, teamKey: ownerKeys.key });
    expect(await unwrapLinkSecretAsOwner({ shareId: id, teamId: owner, autoId: "a1", wrap, teamKey: ownerKeys.key })).toEqual(secret);
    await rejectsWith(unwrapLinkSecretAsOwner({ shareId: shareId, teamId: owner, autoId: "a1", wrap, teamKey: ownerKeys.key }), "decrypt-failed");
    // The secret is bound to the auto its share shows, so a share pointed at another auto opens nothing.
    await rejectsWith(unwrapLinkSecretAsOwner({ shareId: id, teamId: owner, autoId: "a2", wrap, teamKey: ownerKeys.key }), "decrypt-failed");
    await rejectsWith(unwrapLinkSecretAsOwner({ shareId: id, teamId: owner, autoId: "a1", wrap: { ...wrap, ct: flip(wrap.ct, 2) }, teamKey: ownerKeys.key }), "decrypt-failed");
    // Its manifest commits to the key the link gives, computed from the secret alone.
    expect(await commitLinkKey({ shareId: id, secret })).toEqual(await shareKeyCommitment({ shareId: id, skv: 1, raw: await deriveLinkKeyBytes(secret) }));
    expect(await commitLinkKey({ shareId: id, secret: flip(secret) })).not.toEqual(await commitLinkKey({ shareId: id, secret }));
  });
});

describe("the recovery code", () => {
  it("prints as ZNTH- and 26 Crockford base32 characters in groups of 5, 5, 5, 5 and 6", async () => {
    for (let i = 0; i < 30; i++) {
      const code = newRecoveryCode();
      const text = await recoveryCodeToText(code);
      expect(text).toMatch(/^ZNTH-[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{6}$/);
      expect(text.length).toBe(35);
      expect(await recoveryCodeFromText(text)).toEqual(code);
    }
  });

  it("reads a code tolerantly: any case, spaces, no dashes, no prefix, and I, L and O for 1, 1 and 0", async () => {
    const code = new Uint8Array(16).map((_, i) => i * 17);
    const text = await recoveryCodeToText(code);
    const body = text.slice(5).replaceAll("-", "");
    expect(await recoveryCodeFromText(text.toLowerCase())).toEqual(code);
    expect(await recoveryCodeFromText(body)).toEqual(code);
    expect(await recoveryCodeFromText(` znth ${body.match(/.{1,4}/g)!.join(" ")} `)).toEqual(code);
    expect(await recoveryCodeFromText(`ZNTH–${body}`)).toEqual(code);
    const confusable = body.replaceAll("0", "O").replaceAll("1", "l");
    expect(await recoveryCodeFromText(confusable)).toEqual(code);
  });

  it("says bad-recovery-code for a wrong length, a U, or a typing mistake the check bits catch", async () => {
    const code = newRecoveryCode(counting(3));
    const text = await recoveryCodeToText(code);
    await rejectsWith(recoveryCodeFromText(text.slice(0, -1)), "bad-recovery-code");
    await rejectsWith(recoveryCodeFromText(`${text}0`), "bad-recovery-code");
    await rejectsWith(recoveryCodeFromText(`${text.slice(0, -1)}U`), "bad-recovery-code");
    // Every change to the last character alone keeps the key's first 125 bits: most are caught.
    const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    let caught = 0;
    for (const char of alphabet) {
      if (char === text.at(-1)) continue;
      try {
        await recoveryCodeFromText(`${text.slice(0, -1)}${char}`);
      } catch {
        caught++;
      }
    }
    expect(caught).toBeGreaterThanOrEqual(20);
  });

  it("opens the newest team key with the code, and stays current through rotations without it", async () => {
    const v1 = await createTeamKeys(owner);
    const code = newRecoveryCode();
    const printed = await recoveryCodeToText(code);
    let record = await createRecovery({ teamId: owner, teamKey: v1.key, code });
    expect(record.kv).toBe(1);
    let current = { key: v1.key, pair: v1.pair };
    for (let i = 0; i < 3; i++) {
      const next = await rotateTeamKeys(owner, current);
      record = await rewrapRecovery({ teamId: owner, record, currentKey: current.key, newKey: next.key });
      current = { key: next.key, pair: next.pair };
    }
    const key = current.key;
    expect(record.kv).toBe(4);
    const recovered = await openRecovery({ teamId: owner, record, code: await recoveryCodeFromText(printed), extractable: true });
    expect(recovered.version).toBe(4);
    expect(await exportRaw(recovered.key)).toEqual(await exportRaw(key.key));
    expect((await openRecovery({ teamId: owner, record, code })).key.extractable).toBe(false);
  });

  it("throws decrypt-failed for a wrong code, another team, or a changed record", async () => {
    const team = await createTeamKeys(owner);
    const code = newRecoveryCode();
    const record = await createRecovery({ teamId: owner, teamKey: team.key, code });
    const open = (patch: Partial<RecoveryRecord>, teamId = owner, withCode = code) => openRecovery({ teamId, record: { ...record, ...patch }, code: withCode });
    await rejectsWith(open({}, owner, flip(code)), "decrypt-failed");
    await rejectsWith(open({}, partner), "decrypt-failed");
    await rejectsWith(open({ privateKey: { ...record.privateKey, ct: flip(record.privateKey.ct) } }), "decrypt-failed");
    await rejectsWith(open({ teamKey: { ...record.teamKey, epk: flip(record.teamKey.epk, 20) } }), "decrypt-failed");
    await rejectsWith(open({ kv: 2 }), "decrypt-failed");
    await rejectsWith(open({ v: 2 as 1 }), "bad-envelope");
  });

  it("refuses to re-wrap to a recovery public key a server swapped in", async () => {
    const v1 = await createTeamKeys(owner);
    const v2 = await rotateTeamKeys(owner, v1);
    const record = await createRecovery({ teamId: owner, teamKey: v1.key, code: newRecoveryCode() });
    const attacker = await createRecovery({ teamId: owner, teamKey: (await createTeamKeys(owner)).key, code: newRecoveryCode() });
    await rejectsWith(rewrapRecovery({ teamId: owner, record: { ...record, spki: attacker.spki }, currentKey: v1.key, newKey: v2.key }), "bad-key");
    await rejectsWith(rewrapRecovery({ teamId: owner, record: { ...record, check: attacker.check }, currentKey: v1.key, newKey: v2.key }), "decrypt-failed");
    await rejectsWith(rewrapRecovery({ teamId: owner, record, currentKey: v2.key, newKey: v2.key }), "wrong-key-version");
  });
});

describe("verification codes", () => {
  it("gives a device five groups of four digits from a slow hash of its fingerprint", async () => {
    const device = await generateDeviceKeys();
    const code = await deviceVerificationCode(device.encSpki, device.signSpki);
    expect(code).toMatch(/^\d{4} \d{4} \d{4} \d{4} \d{4}$/);
    expect(code).not.toBe(codeFromHash(device.fingerprint));
    expect(await deviceVerificationCode(device.encSpki, device.signSpki)).toBe(code);
    const other = await generateDeviceKeys();
    expect(await deviceVerificationCode(other.encSpki, other.signSpki)).not.toBe(code);
  });

  it("reads the first 16 bytes as a number modulo 10^20, with leading zeros", () => {
    expect(codeFromHash(new Uint8Array(32))).toBe("0000 0000 0000 0000 0000");
    const hash = new Uint8Array(32);
    hash[15] = 1;
    expect(codeFromHash(hash)).toBe("0000 0000 0000 0000 0001");
    // 2^128 - 1 = 340282366920938463463374607431768211455, whose last twenty digits are 63374607431768211455.
    expect(codeFromHash(new Uint8Array(32).fill(255))).toBe("6337 4607 4317 6821 1455");
    throwsWith(() => codeFromHash(new Uint8Array(31)), "bad-key");
  });

  it("gives a team a safety code from its encKey that changes when the key rotates", async () => {
    const v1 = await createTeamKeys(owner);
    const v2 = await rotateTeamKeys(owner, v1);
    const code = await teamSafetyCode(v1.encKey);
    expect(code).toMatch(/^\d{4} \d{4} \d{4} \d{4} \d{4}$/);
    // It covers the signing key as well as the fingerprint, so neither can be swapped unseen.
    expect(code).not.toBe(codeFromHash(v1.encKey.fingerprint));
    expect(await teamSafetyCode({ ...v1.encKey, signSpki: v2.encKey.signSpki })).not.toBe(code);
    expect(await teamSafetyCode(v2.encKey)).not.toBe(code);
    await rejectsWith(teamSafetyCode({ ...v1.encKey, spki: v2.encKey.spki }), "bad-key");
  });
});

describe("share manifests", () => {
  const DEVICE = "dDeviceIdOf22Letters_-";
  const OTHER = "oOtherDevice22Letters_";
  const KA = new Uint8Array(32).fill(0xaa);
  const KB = new Uint8Array(32).fill(0xbb);
  const KA_TEXT = "qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqo";
  const KB_TEXT = "u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7s";
  const body = (commit: Uint8Array, device = DEVICE, termsDevices: string[] = device === DEVICE ? [OTHER, DEVICE] : [device]): ShareManifestBody => ({
    shareId: "s1",
    ownerTeamId: "tOwner",
    autoId: "a1",
    revisionId: "000002-rev2abcd",
    audience: "teams",
    mode: "follow",
    level: "propose",
    revoked: false,
    expiresAtMs: 1_790_000_000_000,
    seq: 5,
    skv: 2,
    wkv: 2,
    okv: 3,
    device,
    termsSeq: 3,
    termsDevices,
    choice: null,
    teams: [["tB", 4, KB], ["tA", 1, KA]],
    commit,
  });
  const TEAMS = `teams=tA:1:${KA_TEXT},tB:4:${KB_TEXT}`;
  const TEXT =
    "zenith/v5/share-manifest|share=s1|owner=tOwner|aid=a1|rid=000002-rev2abcd|aud=teams|mode=follow|lvl=propose|rev=0|exp=1790000000000" +
    `|seq=5|skv=2|wkv=2|okv=3|dev=${DEVICE}|tseq=3|tdev=${OTHER},${DEVICE}|och=-|${TEAMS}`;

  it("encode the share's terms and keys in one canonical form, with the teams sorted, and decode only that form", async () => {
    const commit = new Uint8Array(32).fill(7);
    const bytes = encodeShareManifestBody(body(commit));
    expect(Array.from(bytes.subarray(0, TEXT.length + 1))).toEqual([...utf8Encode(TEXT), 0]);
    expect(decodeShareManifestBody(bytes)).toEqual({ ...body(commit), teams: [["tA", 1, KA], ["tB", 4, KB]] });
    const variant = (t: string) => new Uint8Array([...utf8Encode(t), 0, ...commit]);
    const bad = [
      TEXT.replace(TEAMS, `teams=tB:4:${KB_TEXT},tA:1:${KA_TEXT}`),
      TEXT.replace("skv=2", "skv=02"),
      TEXT.replace(TEAMS, `teams=tA:1:${KA_TEXT},tA:1:${KA_TEXT}`),
      // Each team names its key, by all 32 bytes of its digest, in their one encoding.
      TEXT.replace(TEAMS, "teams=tA:1,tB:4"),
      TEXT.replace(TEAMS, `teams=tA:1:${KA_TEXT.slice(1)},tB:4:${KB_TEXT}`),
      TEXT.replace(TEAMS, `teams=tA:1:${KA_TEXT.slice(0, -1)}p,tB:4:${KB_TEXT}`),
      TEXT.replace(TEAMS, `teams=tA:1:${KA_TEXT}:${KA_TEXT},tB:4:${KB_TEXT}`),
      // The terms signers are 1 to 8 device ids, each once, and their count at most the manifest's.
      TEXT.replace(`tdev=${OTHER},${DEVICE}|`, ""),
      TEXT.replace(`tdev=${OTHER},${DEVICE}`, "tdev="),
      TEXT.replace(`tdev=${OTHER},${DEVICE}`, `tdev=${DEVICE},${DEVICE}`),
      TEXT.replace(`tdev=${OTHER},`, `tdev=${OTHER.slice(1)},`),
      TEXT.replace(`tdev=${OTHER},${DEVICE}`, `tdev=${OTHER},${DEVICE},`),
      TEXT.replace(`tdev=${OTHER},${DEVICE}`, `tdev=${Array.from({ length: MAX_TERMS_DEVICES + 1 }, (_, i) => `${String(i)}${DEVICE.slice(1)}`).join(",")}`),
      TEXT.replace("tseq=3", "tseq=6"),
      TEXT.replace("tseq=3", "tseq=03"),
      TEXT.replace("tseq=3", "tseq=0"),
      TEXT.replace("tseq=3|", ""),
      TEXT.replace(`dev=${DEVICE}|tseq=3`, `tseq=3|dev=${DEVICE}`),
      TEXT.replace(`tdev=${OTHER},${DEVICE}`, `odev=${OTHER}`),
      TEXT.replace("zenith/v5/", "zenith/v4/"),
      TEXT.replace("zenith/v5/", "zenith/v3/"),
      TEXT.replace("skv=2", "skv=0"),
      TEXT.replace("seq=5", "seq=0"),
      TEXT.replace("rev=0", "rev=2"),
      TEXT.replace("mode=follow", "mode=Follow"),
      TEXT.replace("lvl=propose", "lvl=edit"),
      TEXT.replace("aud=teams", "aud=everyone"),
      TEXT.replace("och=-", "och="),
      TEXT.replace("wkv=2", "wkv=4"),
      TEXT.replace("aid=a1|", ""),
      TEXT.replace("zenith/v5/", "zenith/v2/"),
      TEXT.replace(TEAMS, "teams="),
      TEXT.replace("rid=000002-rev2abcd|", ""),
      TEXT.replace("rid=000002-rev2abcd", "rid="),
      TEXT.replace("rid=000002-rev2abcd", "rid=000002.rev2"),
      TEXT.replace("exp=1790000000000", "exp=01790000000000"),
      TEXT.replace("exp=1790000000000", "exp=0"),
      TEXT.replace("exp=1790000000000", "exp=8640000000000001"),
      TEXT.replace("exp=1790000000000", "exp=-1"),
      TEXT.replace("exp=1790000000000|", ""),
      TEXT.replace(`dev=${DEVICE}`, `dev=${DEVICE.slice(1)}`),
      TEXT.replace(`dev=${DEVICE}`, `dev=${DEVICE}x`),
      TEXT.replace(`dev=${DEVICE}|`, ""),
    ];
    for (const text of bad) throwsWith(() => decodeShareManifestBody(variant(text)), "bad-envelope");
    throwsWith(() => decodeShareManifestBody(new Uint8Array([...utf8Encode(TEXT), 1, ...commit])), "bad-envelope");
    throwsWith(() => encodeShareManifestBody({ ...body(commit), teams: [] }), "bad-input");
    throwsWith(() => encodeShareManifestBody({ ...body(commit), teams: [["tA", 1, KA], ["tA", 2, KA]] }), "bad-input");
    throwsWith(() => encodeShareManifestBody({ ...body(commit), teams: [["tA", 1, KA.subarray(1)]] }), "bad-input");
    throwsWith(() => encodeShareManifestBody({ ...body(commit), termsDevices: [] }), "bad-input");
    throwsWith(() => encodeShareManifestBody({ ...body(commit), termsDevices: ["short"] }), "bad-input");
    throwsWith(() => encodeShareManifestBody({ ...body(commit), termsDevices: [DEVICE, DEVICE] }), "bad-input");
    throwsWith(() => encodeShareManifestBody({ ...body(commit), termsDevices: Array.from({ length: MAX_TERMS_DEVICES + 1 }, (_, i) => `${String(i)}${DEVICE.slice(1)}`) }), "bad-input");
    expect(decodeShareManifestBody(encodeShareManifestBody({ ...body(commit), termsDevices: Array.from({ length: MAX_TERMS_DEVICES }, (_, i) => `${String(i)}${DEVICE.slice(1)}`) })).termsDevices).toHaveLength(MAX_TERMS_DEVICES);
    throwsWith(() => encodeShareManifestBody({ ...body(commit), termsSeq: 6 }), "bad-input");
    throwsWith(() => encodeShareManifestBody({ ...body(commit), termsSeq: 0 }), "bad-input");
    throwsWith(() => encodeShareManifestBody({ ...body(commit), wkv: 4 }), "bad-input");
    throwsWith(() => encodeShareManifestBody({ ...body(commit), choice: new Uint8Array(31) }), "bad-input");
    throwsWith(() => encodeShareManifestBody({ ...body(commit), expiresAtMs: 1.5 }), "bad-input");
    throwsWith(() => encodeShareManifestBody({ ...body(commit), expiresAtMs: Number.NaN }), "bad-input");
    throwsWith(() => encodeShareManifestBody({ ...body(commit), device: "short" }), "bad-input");
    throwsWith(() => encodeShareManifestBody({ ...body(commit), revisionId: "" }), "bad-input");
    // A link share names no teams, is view only and has the one key its link gives.
    const link: ShareManifestBody = { ...body(commit), audience: "link", level: "view", skv: 1, teams: [], choice: new Uint8Array(32).fill(255) };
    const linkBytes = encodeShareManifestBody(link);
    expect(utf8Decode(linkBytes.subarray(0, linkBytes.length - 33))).toBe(
      "zenith/v5/share-manifest|share=s1|owner=tOwner|aid=a1|rid=000002-rev2abcd|aud=link|mode=follow|lvl=view|rev=0|exp=1790000000000" +
        `|seq=5|skv=1|wkv=2|okv=3|dev=${DEVICE}|tseq=3|tdev=${OTHER},${DEVICE}|och=__________________________________________8|teams=`,
    );
    expect(decodeShareManifestBody(linkBytes)).toEqual(link);
    throwsWith(() => encodeShareManifestBody({ ...link, teams: [["tA", 1, KA]] }), "bad-input");
    throwsWith(() => encodeShareManifestBody({ ...link, level: "propose" }), "bad-input");
    throwsWith(() => encodeShareManifestBody({ ...link, skv: 2 }), "bad-input");
  });

  it("name the sealed sharer's choices by a digest of their ciphertext, and a manifest by a digest of its body", async () => {
    const teamKeys = await createTeamKeys("tOwner");
    const choice = await sealText(teamKeys.key, '{"coarsen":true}', aadFor.ownerChoice({ shareId: "s1", teamId: "tOwner", kv: 1 }));
    const digest = await ownerChoiceDigest({ shareId: "s1", choice });
    expect(digest.length).toBe(32);
    expect(await ownerChoiceDigest({ shareId: "s2", choice })).not.toEqual(digest);
    expect(await ownerChoiceDigest({ shareId: "s1", choice: { ...choice, ct: flip(choice.ct) } })).not.toEqual(digest);
    const device = await generateDeviceKeys();
    const manifest = await signShareManifest({ body: { ...body(new Uint8Array(32), device.deviceId), choice: digest }, signingKey: teamKeys.pair.signingKey, device });
    expect(await shareManifestDigest(manifest)).toEqual(new Uint8Array(createHash("sha256").update(manifest.body).digest()));
  });

  it("verify with the owner team's signing key only, and a share key opens only as the key committed to", async () => {
    const owner = await createTeamKeys("tOwner");
    const other = await createTeamKeys("tOther");
    const partner = await createTeamKeys("tA");
    const device = await generateDeviceKeys();
    const shareKey = await newShareKey(2);
    const commit = await commitShareKey({ shareId: "s1", shareKey });
    const manifest = await signShareManifest({ body: body(commit, device.deviceId), signingKey: owner.pair.signingKey, device });
    expect(manifest.v).toBe(5);
    expect((await openShareManifest({ manifest, signSpki: owner.pair.signSpki })).skv).toBe(2);
    await rejectsWith(openShareManifest({ manifest, signSpki: other.pair.signSpki }), "bad-signature");
    await rejectsWith(openShareManifest({ manifest: { ...manifest, body: flip(manifest.body, -1) }, signSpki: owner.pair.signSpki }), "bad-signature");
    // The first four versions, which did not name who signed the terms, before that the device that
    // made the share or the keys it was wrapped to, and before that the revision, the end or the
    // device that signed, are refused.
    for (const v of [1, 2, 3, 4]) await rejectsWith(openShareManifest({ manifest: { ...manifest, v: v as 5 }, signSpki: owner.pair.signSpki }), "bad-envelope");

    const wrap = await wrapShareKeyToTeam({ shareId: "s1", teamId: "tA", shareKey, encKey: partner.encKey });
    const unwrap = (c: Uint8Array) => unwrapShareKeyAsTeam({ shareId: "s1", teamId: "tA", shareKeyVersion: 2, wrap, pair: partner.pair, commit: c });
    expect((await unwrap(commit)).version).toBe(2);
    await rejectsWith(unwrap(flip(commit)), "bad-key");
    const ownerWrap = await wrapShareKeyForOwner({ shareId: "s1", teamId: "tOwner", shareKey, teamKey: owner.key });
    await rejectsWith(unwrapShareKeyAsOwner({ shareId: "s1", teamId: "tOwner", shareKeyVersion: 2, wrap: ownerWrap, teamKey: owner.key, commit: flip(commit) }), "bad-key");
    // The commitment binds the share and the version too.
    expect(await commitShareKey({ shareId: "s2", shareKey })).not.toEqual(commit);
    expect(await commitShareKey({ shareId: "s1", shareKey: { ...shareKey, version: 3 } })).not.toEqual(commit);
  });

  it("verify with the key of the device the body names, which the manifest carries and its id comes from", async () => {
    const owner = await createTeamKeys("tOwner");
    const device = await generateDeviceKeys();
    const thief = await generateDeviceKeys();
    const manifest = await signShareManifest({ body: body(new Uint8Array(32), device.deviceId), signingKey: owner.pair.signingKey, device });
    expect(manifest.dsig.length).toBe(64);
    expect(Array.from(manifest.dkeys)).toEqual([...device.encSpki, ...device.signSpki]);
    // A signer that is not the device the body names is refused before anything is signed.
    await rejectsWith(signShareManifest({ body: body(new Uint8Array(32), device.deviceId), signingKey: owner.pair.signingKey, device: thief }), "bad-input");
    // Another device's signature, or another device's keys, do not verify.
    const byThief = await signShareManifest({ body: body(new Uint8Array(32), thief.deviceId), signingKey: owner.pair.signingKey, device: thief });
    await rejectsWith(openShareManifest({ manifest: { ...manifest, dsig: byThief.dsig }, signSpki: owner.pair.signSpki }), "bad-signature");
    await rejectsWith(openShareManifest({ manifest: { ...manifest, dkeys: byThief.dkeys }, signSpki: owner.pair.signSpki }), "bad-signature");
    await rejectsWith(openShareManifest({ manifest: { ...manifest, dsig: flip(manifest.dsig) }, signSpki: owner.pair.signSpki }), "bad-signature");
    // Keys of another length, or a signature of another length, are a manifest out of shape.
    await rejectsWith(openShareManifest({ manifest: { ...manifest, dkeys: manifest.dkeys.subarray(1) }, signSpki: owner.pair.signSpki }), "bad-envelope");
    await rejectsWith(openShareManifest({ manifest: { ...manifest, dsig: manifest.dsig.subarray(1) }, signSpki: owner.pair.signSpki }), "bad-envelope");
    await rejectsWith(openShareManifest({ manifest: { ...manifest, tsig: manifest.tsig.subarray(1) }, signSpki: owner.pair.signSpki }), "bad-envelope");
    await rejectsWith(openShareManifest({ manifest: { ...manifest, tkeys: manifest.tkeys.subarray(1) }, signSpki: owner.pair.signSpki }), "bad-envelope");
  });

  it("sign the share's terms by the last device named as their signer, over a statement of the terms alone", async () => {
    const owner = await createTeamKeys("tOwner");
    const maker = await generateDeviceKeys();
    const pinned = { ...body(new Uint8Array(32), maker.deviceId), mode: "pinned" as const };
    const statement =
      "zenith/v5/share-terms|share=s1|owner=tOwner|aid=a1|aud=teams|mode=pinned|lvl=propose|rev=0|exp=1790000000000|okv=3|tseq=3" +
      `|tdev=${maker.deviceId}|rid=000002-rev2abcd|och=-|${TEAMS}`;
    expect(utf8Decode(shareTermsStatement(pinned))).toBe(statement);
    // A following share's revision moves with every publish, so it is not one of its terms.
    expect(utf8Decode(shareTermsStatement({ ...pinned, mode: "follow" }))).toBe(statement.replace("mode=pinned", "mode=follow").replace("rid=000002-rev2abcd", "rid="));
    const made = await signShareManifest({ body: pinned, signingKey: owner.pair.signingKey, device: maker });
    expect(Array.from(made.tkeys)).toEqual([...maker.encSpki, ...maker.signSpki]);
    expect(Array.from(made.tkeys)).toEqual(Array.from(made.dkeys));
    expect((await openShareManifest({ manifest: made, signSpki: owner.pair.signSpki })).termsDevices).toEqual([maker.deviceId]);
    // A device that signs terms is the last of their signers the body names.
    await rejectsWith(signShareManifest({ body: { ...pinned, termsDevices: [maker.deviceId, OTHER] }, signingKey: owner.pair.signingKey, device: maker }), "bad-input");
  });

  it("carry the terms signature unchanged through a write that changes no term, and refuse it over changed terms", async () => {
    const owner = await createTeamKeys("tOwner");
    const maker = await generateDeviceKeys();
    const later = await generateDeviceKeys();
    const first = body(new Uint8Array(32), maker.deviceId);
    const made = await signShareManifest({ body: first, signingKey: owner.pair.signingKey, device: maker });
    const terms = { tsig: made.tsig, tkeys: made.tkeys };
    // What an ordinary write changes: the revision a following share shows, the share key and its
    // commitment and versions, the manifest's count and its signer.
    const carried = { ...first, seq: 6, device: later.deviceId, revisionId: "000003-rev3abcd", skv: 3, wkv: 3, commit: new Uint8Array(32).fill(9) };
    expect(sameShareTerms(carried, first)).toBe(true);
    const again = await signShareManifest({ body: carried, signingKey: owner.pair.signingKey, device: later, terms });
    expect(Array.from(again.tsig)).toEqual(Array.from(made.tsig));
    expect(Array.from(again.tkeys)).toEqual([...maker.encSpki, ...maker.signSpki]);
    expect((await openShareManifest({ manifest: again, signSpki: owner.pair.signSpki })).device).toBe(later.deviceId);
    // Every term, carried under the old signature, no longer verifies.
    const changes: Partial<ShareManifestBody>[] = [
      { shareId: "s2" }, { ownerTeamId: "tOther" }, { autoId: "a2" }, { mode: "pinned" }, { level: "view" }, { revoked: true }, { expiresAtMs: 1_790_000_000_001 },
      { choice: new Uint8Array(32) }, { teams: [["tA", 1, KB], ["tB", 4, KB]] }, { teams: [["tA", 2, KA], ["tB", 4, KB]] }, { teams: [["tA", 1, KA]] },
      { audience: "link", level: "view", skv: 1, wkv: 1, teams: [] }, { okv: 4 }, { termsSeq: 4 }, { termsDevices: [OTHER, maker.deviceId] },
    ];
    for (const change of changes) {
      const next = { ...carried, ...change };
      if (!("termsSeq" in change) && !("termsDevices" in change) && !("okv" in change)) expect(sameShareTerms(next, first), JSON.stringify(Object.keys(change))).toBe(false);
      const forged = await signShareManifest({ body: next, signingKey: owner.pair.signingKey, device: later, terms });
      await rejectsWith(openShareManifest({ manifest: forged, signSpki: owner.pair.signSpki }), "bad-signature");
    }
    // A pinned share's revision is one of its terms.
    const pinnedFirst = { ...first, mode: "pinned" as const };
    expect(sameShareTerms({ ...pinnedFirst, revisionId: "000003-rev3abcd" }, pinnedFirst)).toBe(false);
    // Another device's keys, or a signature changed, do not verify either.
    await rejectsWith(openShareManifest({ manifest: { ...again, tkeys: again.dkeys }, signSpki: owner.pair.signSpki }), "bad-signature");
    await rejectsWith(openShareManifest({ manifest: { ...again, tsig: flip(again.tsig) }, signSpki: owner.pair.signSpki }), "bad-signature");
  });

  it("name a team's key by a digest of both its public keys, its team and its version", async () => {
    const v1 = await createTeamKeys("tA");
    const v2 = await rotateTeamKeys("tA", { key: v1.key, pair: v1.pair });
    const digest = await teamKeyDigest({ teamId: "tA", ...v1.encKey });
    const label = "zenith/v4/team-key-digest|team=tA|ekv=1";
    const expected = createHash("sha256").update(label).update(new Uint8Array([0])).update(v1.encKey.fingerprint).update(v1.encKey.signSpki).digest();
    expect(Array.from(digest)).toEqual(Array.from(expected));
    expect(digest.length).toBe(TEAM_KEY_DIGEST_BYTES);
    expect(await teamKeyDigest({ teamId: "tA", ...v1.encKey, signSpki: v2.encKey.signSpki })).not.toEqual(digest);
    expect(await teamKeyDigest({ teamId: "tA", ...v1.encKey, fingerprint: v2.encKey.fingerprint })).not.toEqual(digest);
    expect(await teamKeyDigest({ teamId: "tB", ...v1.encKey })).not.toEqual(digest);
    expect(await teamKeyDigest({ teamId: "tA", ...v1.encKey, v: 2 })).not.toEqual(digest);
    await rejectsWith(teamKeyDigest({ teamId: "tA", ...v1.encKey, signSpki: v1.encKey.signSpki.subarray(1) }), "bad-key");
  });
});
