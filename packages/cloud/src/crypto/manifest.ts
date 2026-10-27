/**
 * The signed manifest of a share. A share key is wrapped to each recipient team's public key, which
 * anyone can read, so a wrap proves nothing about who made the key: the server could make a key of
 * its own and wrap it to a partner. And a share's terms (which auto and revision, to whom, following
 * or pinned, view or propose, until when, revoked or not) are plain fields the server writes. The
 * manifest says all of it, signed with the owner team's signing key, so every device that opens the
 * share key, or seals under it, checks the key and the terms against the owner team's key chain, and
 * refuses a share whose plain fields say anything else.
 *
 * Anyone who holds a team key can sign with it, a member taken off the team or a stolen device
 * among them, until the key changes. So the manifest also names the device that signed it and
 * carries that device's own signature and public keys. And it names the devices that signed the
 * share's terms at the key that signs the manifest (`tdev`), the last of which signs a statement of
 * the terms (`shareTermsStatement`) and whose public keys the manifest carries too: a write that
 * changes no term carries that signature unchanged, whichever device signs the manifest, and a write
 * that changes one adds its own device to the list and signs the terms again. The team's rotation
 * lists a share signed at the key it replaces only when every one of those devices, and the device
 * that signed the manifest, is one the new roster keeps (keys/roster.ts). So a share forged with the
 * old key, or an honest share whose terms were changed with it, is not carried past the rotation by
 * an honest device that signed it again, or changed its terms again on top.
 *
 * For each team the share key was wrapped to, the manifest names that team's public key, as the
 * sharer checked it (`teamKeyDigest`), so a device that re-keys the share later wraps only to that
 * key or to a newer one the team signed from it, whatever key the server shows.
 *
 * `body` is the text
 * `zenith/v5/share-manifest|share=|owner=|aid=|rid=|aud=|mode=|lvl=|rev=|exp=|seq=|skv=|wkv=|okv=|dev=|tseq=|tdev=<deviceId>,...|och=|prj=|teams=<teamId>:<ekv>:<key>,...`
 * with the teams sorted by id (none for a link share), `<key>` the 43-character base64url of the
 * team's key digest, `prj` the 43-character base64url of the projection's digest
 * (`shareProjectionDigest`, left out, `|prj=` and all, by a manifest signed before 2026-10-11, which
 * binds no projection), a zero byte, and the 32-byte commitment to the share key (`shareKeyCommitment`;
 * for a link share, to the key its link derives). `sig` is the ECDSA P-256 SHA-256 signature over
 * `body` by the owner team's signing key of version `okv`; `dsig` is the same over `body` by the
 * signing key of device `dev`, whose two public keys are `dkeys`, from which its id comes
 * (`deviceIdFor`); `tsig` is the same over the terms statement (`shareTermsStatement`) by the signing
 * key of the last device `tdev` names, whose two public keys are `tkeys`. The body has exactly one
 * encoding, so a reader decodes it, encodes it again and refuses it when the two differ.
 */
import { base64urlDecode, base64urlEncode, bytesEqual, concatBytes, toBytes, utf8Decode, utf8Encode } from "./bytes.js";
import { idPart, isKeyVersion, versionPart } from "./aad.js";
import { deviceIdFor, sign, SIGNATURE_BYTES, verify, type DeviceKeys } from "./device.js";
import type { Envelope } from "./envelope.js";
import { CryptoError } from "./errors.js";
import { exportAesKey, hkdfBits, isBytes, sha256 } from "./primitives.js";
import { deriveLinkKeyBytes, type ShareKey } from "./share.js";
import { P256_SPKI_BYTES } from "./wrap.js";
import { MAX_SHARE_MANIFEST_BYTES } from "../types.js";

/**
 * The manifest format version. Version 1, which named only the keys, version 2, which did not name
 * the revision, the end or the signing device, version 3, which named neither the device that made
 * the share nor the partner keys it was wrapped to, and version 4, which signed only the share's
 * origin and not who chose its terms, are refused.
 */
export const SHARE_MANIFEST_VERSION = 5;
/** `dkeys` and `tkeys`, a device's two public keys, encryption key first, bytes. */
export const MANIFEST_DEVICE_KEYS_BYTES = 2 * P256_SPKI_BYTES;
/**
 * The most devices a manifest names as signers of the share's terms at one key version (`tdev`).
 * SET BY HAND: as many as the teams one share names (the body's pattern, `TEXT`, spells it too). A
 * ninth device that would change the terms before the team key next changes is refused, and one
 * already named may make the change.
 */
export const MAX_TERMS_DEVICES = 8;
/** The latest end a manifest can name, milliseconds since 1970: the latest a JavaScript date can hold. */
export const MAX_SHARE_EXPIRY_MS = 8_640_000_000_000_000;
/** The commitment to a share key, bytes. */
export const SHARE_KEY_COMMIT_BYTES = 32;
/** The digest of the sealed sharer's choices a manifest names (`ownerChoiceDigest`), bytes. */
export const OWNER_CHOICE_DIGEST_BYTES = 32;
/** The digest of a share's sealed projection a manifest names (`shareProjectionDigest`), bytes. */
export const SHARE_PROJECTION_DIGEST_BYTES = 32;
/** The digest of a manifest (`shareManifestDigest`), bytes: what a team's device roster lists. */
export const SHARE_MANIFEST_DIGEST_BYTES = 32;
/** The digest that names a team's public key in a manifest (`teamKeyDigest`), bytes. */
export const TEAM_KEY_DIGEST_BYTES = 32;
/** The most recipient teams one manifest names: the rules' limit on a share's `teamIds`. */
export const MAX_MANIFEST_TEAMS = 8;
/**
 * The largest manifest body, bytes. It is defined with the other size caps in types.ts, which the
 * in-memory rules read too, and says there how it was chosen.
 */
export { MAX_SHARE_MANIFEST_BYTES };

/** `manifest` on `shares/{shareId}`. */
export interface ShareManifest {
  v: 5;
  /** The canonical body (`encodeShareManifestBody`). */
  body: Uint8Array;
  /** 64 bytes: the owner team's signing key of version `okv` over `body`. */
  sig: Uint8Array;
  /** 64 bytes: the signing key of the device the body names (`dev`) over `body`. */
  dsig: Uint8Array;
  /** 182 bytes: that device's encryption and signing public keys, each a 91-byte SPKI, whose SHA-256 gives its id. */
  dkeys: Uint8Array;
  /**
   * 64 bytes: the signing key of the last device the body names among the terms signers (`tdev`)
   * over the share's terms statement (`shareTermsStatement`). A manifest that changes no term
   * carries it unchanged from the manifest it replaces.
   */
  tsig: Uint8Array;
  /** 182 bytes: that device's encryption and signing public keys, whose SHA-256 gives its id. */
  tkeys: Uint8Array;
}

/** What a manifest says. */
export interface ShareManifestBody {
  shareId: string;
  ownerTeamId: string;
  /** The auto the share shows. */
  autoId: string;
  /** The revision of that auto the projection was built from: the pinned one, or the newest a following share was moved to. */
  revisionId: string;
  audience: "teams" | "link";
  mode: "pinned" | "follow";
  level: "view" | "propose";
  /** True once the owner team revoked the share: nothing is sealed into it again. */
  revoked: boolean;
  /** When the share ends, milliseconds since 1970 UTC (`expiresAt`): nothing is sealed into it after. */
  expiresAtMs: number;
  /**
   * One more than the manifest this one replaces, from 1 when the share is made. A device refuses a
   * manifest older than the newest it has seen for the share.
   */
  seq: number;
  /** The share key's version, which is also the projection envelope's `kv`; always 1 for a link share. */
  skv: number;
  /**
   * The owner team key version the share key is sealed under for the owner team (`ownerWrap.kv`), or
   * a link share's secret (`linkWrap.kv`). A share to teams keyed under an older key than the team's
   * newest is re-keyed before anything new is sealed under it.
   */
  wkv: number;
  /** The owner team key version whose signing key signs: the team's newest when it was signed. At least `wkv`. */
  okv: number;
  /** The id of the device that signed (`deviceIdFor`), which `dsig` and `dkeys` are of. */
  device: string;
  /**
   * The count of signatures of the share's terms (`tseq`): 1 when the share is made, and one more at
   * every new `tsig`. A device refuses a manifest whose terms are older than the newest it has seen
   * for the share. At most `seq`.
   */
  termsSeq: number;
  /**
   * The devices that signed the share's terms at key version `okv` (`tdev`), each once, the one that
   * signed them last (`tsig`, `tkeys`) at the end; 1 to `MAX_TERMS_DEVICES`. The first manifest at a
   * key version signs the terms again and names only its own device.
   */
  termsDevices: readonly string[];
  /** `ownerChoiceDigest` of the share's sealed `ownerChoice`, or null when it has none. */
  choice: Uint8Array | null;
  /**
   * `shareProjectionDigest` of the projection the share shows with this manifest (`prj`), so an
   * older projection under the same share key cannot be served beside it. Absent from a manifest
   * signed before the field existed, which binds no projection and keeps its one encoding; every
   * manifest signed since names one.
   */
  projection?: Uint8Array;
  /**
   * Each recipient team, the version of its public key the share key was wrapped to and that key's
   * `teamKeyDigest`, sorted by team id; none for a link share.
   */
  teams: ReadonlyArray<SignedTeamKey>;
  /** `shareKeyCommitment` of the share key, 32 bytes. */
  commit: Uint8Array;
}

/** A recipient team as a manifest names it: its id, the version of its public key wrapped to, and that key's `teamKeyDigest`. */
export type SignedTeamKey = readonly [teamId: string, ekv: number, key: Uint8Array];

const LABEL = "zenith/v5/share-manifest";
const TERMS_LABEL = "zenith/v5/share-terms";
const TEXT =
  /^zenith\/v5\/share-manifest\|share=([A-Za-z0-9_-]{1,128})\|owner=([A-Za-z0-9_-]{1,128})\|aid=([A-Za-z0-9_-]{1,128})\|rid=([A-Za-z0-9_-]{1,128})\|aud=(teams|link)\|mode=(pinned|follow)\|lvl=(view|propose)\|rev=([01])\|exp=([0-9]{1,16})\|seq=([0-9]{1,10})\|skv=([0-9]{1,10})\|wkv=([0-9]{1,10})\|okv=([0-9]{1,10})\|dev=([A-Za-z0-9_-]{22})\|tseq=([0-9]{1,10})\|tdev=([A-Za-z0-9_-]{22}(?:,[A-Za-z0-9_-]{22}){0,7})\|och=(-|[A-Za-z0-9_-]{43})(?:\|prj=([A-Za-z0-9_-]{43}))?\|teams=([A-Za-z0-9_:,-]*)$/;
const DEVICE_ID = /^[A-Za-z0-9_-]{22}$/;
const TEAM = /^([A-Za-z0-9_-]{1,128}):([0-9]{1,10}):([A-Za-z0-9_-]{43})$/;
const NO_SALT = new Uint8Array(0);

/**
 * The 32-byte commitment to share key `raw` of share `shareId` at version `skv`: HKDF-SHA-256 of the
 * raw key with an empty salt and the info `zenith/v1/share-key-commit|share=<shareId>|skv=<skv>`. It
 * reveals nothing of the key, binds it to one share and version, and no second key gives the same
 * bytes without breaking SHA-256.
 */
export async function shareKeyCommitment(input: { shareId: string; skv: number; raw: Uint8Array }): Promise<Uint8Array<ArrayBuffer>> {
  const info = ["zenith/v1/share-key-commit", idPart("share", input.shareId), versionPart("skv", input.skv)].join("|");
  return hkdfBits(input.raw, NO_SALT, info, SHARE_KEY_COMMIT_BYTES * 8);
}

/** The commitment to `shareKey`, which must be extractable (it is, on the device that made it). */
export async function commitShareKey(input: { shareId: string; shareKey: ShareKey }): Promise<Uint8Array<ArrayBuffer>> {
  const raw = await exportAesKey(input.shareKey.key);
  try {
    return await shareKeyCommitment({ shareId: input.shareId, skv: input.shareKey.version, raw });
  } finally {
    raw.fill(0);
  }
}

/** A link share's key commitment, from the secret in its link (the key itself is never extractable). */
export async function commitLinkKey(input: { shareId: string; secret: Uint8Array }): Promise<Uint8Array<ArrayBuffer>> {
  const raw = await deriveLinkKeyBytes(input.secret);
  try {
    return await shareKeyCommitment({ shareId: input.shareId, skv: 1, raw });
  } finally {
    raw.fill(0);
  }
}

/**
 * The 32 bytes that name a share's sealed `ownerChoice` in its manifest: SHA-256 of
 * `zenith/v2/owner-choice-digest|share=<shareId>|kv=<kv>`, a zero byte, the IV and the ciphertext.
 * Only the ciphertext is hashed, so the digest shows nothing of the choices, and a choice sealed
 * again by anyone who holds an older team key no longer matches.
 */
export async function ownerChoiceDigest(input: { shareId: string; choice: Envelope }): Promise<Uint8Array<ArrayBuffer>> {
  const label = ["zenith/v2/owner-choice-digest", idPart("share", input.shareId), versionPart("kv", input.choice.kv)].join("|");
  return sha256(concatBytes(utf8Encode(label), new Uint8Array([0]), input.choice.iv, input.choice.ct));
}

/**
 * The 32 bytes that name a share's sealed projection in its manifest (`prj`): SHA-256 of
 * `zenith/v1/share-projection-digest|share=<shareId>|kv=<kv>`, a zero byte, the IV and the
 * ciphertext. Only the ciphertext is hashed, so the digest shows nothing of the projection, and the
 * projection of another revision, or one sealed again under the same share key, no longer matches.
 */
export async function shareProjectionDigest(input: { shareId: string; projection: Envelope }): Promise<Uint8Array<ArrayBuffer>> {
  const label = ["zenith/v1/share-projection-digest", idPart("share", input.shareId), versionPart("kv", input.projection.kv)].join("|");
  return sha256(concatBytes(utf8Encode(label), new Uint8Array([0]), input.projection.iv, input.projection.ct));
}

/** The 32 bytes that name one manifest in a team's device roster: SHA-256 of its body, which says everything it signs. */
export async function shareManifestDigest(manifest: ShareManifest): Promise<Uint8Array<ArrayBuffer>> {
  return sha256(manifest.body);
}

function sortedTeams(body: Pick<ShareManifestBody, "audience" | "teams">): [string, number, Uint8Array][] {
  const teams = body.teams;
  const range = body.audience === "link" ? [0, 0] : [1, MAX_MANIFEST_TEAMS];
  if (!Array.isArray(teams) || teams.length < (range[0] as number) || teams.length > (range[1] as number)) {
    throw new CryptoError("bad-input", body.audience === "link" ? "A link share's manifest names no teams." : `A share manifest names 1 to ${String(MAX_MANIFEST_TEAMS)} teams.`);
  }
  const out = teams.map(([teamId, ekv, key]): [string, number, Uint8Array] => {
    idPart("team", teamId);
    versionPart("ekv", ekv);
    if (!isBytes(key, { exactly: TEAM_KEY_DIGEST_BYTES })) throw new CryptoError("bad-input", "A share manifest names each team's key by its 32-byte digest.");
    return [teamId, ekv, key];
  });
  out.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (let i = 1; i < out.length; i++) {
    if (out[i]?.[0] === out[i - 1]?.[0]) throw new CryptoError("bad-input", "A share manifest names each team once.");
  }
  return out;
}

/** Throws `bad-input` unless `devices` is 1 to `MAX_TERMS_DEVICES` device ids, each once. */
function checkTermsDevices(devices: unknown): void {
  if (!Array.isArray(devices) || devices.length < 1 || devices.length > MAX_TERMS_DEVICES) {
    throw new CryptoError("bad-input", `A share manifest names 1 to ${String(MAX_TERMS_DEVICES)} devices that signed its terms.`);
  }
  for (const id of devices) {
    if (typeof id !== "string" || !DEVICE_ID.test(id)) throw new CryptoError("bad-input", "A share manifest names each device that signed its terms by its 22-character id.");
  }
  if (new Set(devices).size !== devices.length) throw new CryptoError("bad-input", "A share manifest names each device that signed its terms once.");
}

/**
 * Throws `bad-input` unless every part of `body` that its terms statement names is in shape, and
 * returns the teams in the one spelling the body and the statement both write them in.
 */
function checkedTerms(body: ShareManifestBody): { teams: string } {
  if (body.audience !== "teams" && body.audience !== "link") throw new CryptoError("bad-input", "A share is to teams or to anyone with the link.");
  if (body.mode !== "pinned" && body.mode !== "follow") throw new CryptoError("bad-input", "A share is pinned or follows the latest version.");
  if (body.level !== "view" && body.level !== "propose") throw new CryptoError("bad-input", "A share is view or propose.");
  if (typeof body.revoked !== "boolean") throw new CryptoError("bad-input", "A share manifest says whether the share is revoked.");
  if (!isExpiry(body.expiresAtMs)) throw new CryptoError("bad-input", "A share manifest names the moment the share ends, in whole milliseconds since 1970.");
  if (body.audience === "link" && (body.level !== "view" || body.skv !== 1)) throw new CryptoError("bad-input", "A link share is view only, under the one key its link gives.");
  if (body.choice !== null && !isBytes(body.choice, { exactly: OWNER_CHOICE_DIGEST_BYTES })) throw new CryptoError("bad-input", "A choice digest is 32 bytes.");
  if (!isKeyVersion(body.okv)) throw new CryptoError("bad-input", "A share manifest names the team key version that signs it.");
  if (!isKeyVersion(body.termsSeq) || !isKeyVersion(body.seq) || body.termsSeq > body.seq) {
    throw new CryptoError("bad-input", "A share manifest counts the signatures of its terms from 1, and no more often than it was signed.");
  }
  checkTermsDevices(body.termsDevices);
  const teams = sortedTeams(body)
    .map(([teamId, ekv, key]) => `${teamId}:${String(ekv)}:${base64urlEncode(key)}`)
    .join(",");
  return { teams };
}

/** The canonical body bytes. Throws `bad-input` for an id, version, term or commitment out of shape. */
export function encodeShareManifestBody(body: ShareManifestBody): Uint8Array<ArrayBuffer> {
  if (!isBytes(body.commit, { exactly: SHARE_KEY_COMMIT_BYTES })) throw new CryptoError("bad-input", "A share key commitment is 32 bytes.");
  if (typeof body.device !== "string" || !DEVICE_ID.test(body.device)) throw new CryptoError("bad-input", "A share manifest names the device that signed it by its 22-character id.");
  const { teams } = checkedTerms(body);
  if (!isKeyVersion(body.wkv) || body.wkv > body.okv) {
    throw new CryptoError("bad-input", "A share manifest is signed with a key no older than the one the share key is sealed under.");
  }
  if (body.projection !== undefined && !isBytes(body.projection, { exactly: SHARE_PROJECTION_DIGEST_BYTES })) {
    throw new CryptoError("bad-input", "A projection digest is 32 bytes.");
  }
  const text = [
    LABEL,
    idPart("share", body.shareId),
    idPart("owner", body.ownerTeamId),
    idPart("aid", body.autoId),
    idPart("rid", body.revisionId),
    `aud=${body.audience}`,
    `mode=${body.mode}`,
    `lvl=${body.level}`,
    `rev=${body.revoked ? "1" : "0"}`,
    `exp=${String(body.expiresAtMs)}`,
    versionPart("seq", body.seq),
    versionPart("skv", body.skv),
    versionPart("wkv", body.wkv),
    versionPart("okv", body.okv),
    `dev=${body.device}`,
    versionPart("tseq", body.termsSeq),
    `tdev=${body.termsDevices.join(",")}`,
    `och=${body.choice === null ? "-" : base64urlEncode(body.choice)}`,
    ...(body.projection === undefined ? [] : [`prj=${base64urlEncode(body.projection)}`]),
    `teams=${teams}`,
  ].join("|");
  const bytes = concatBytes(utf8Encode(text), new Uint8Array([0]), body.commit);
  if (bytes.byteLength > MAX_SHARE_MANIFEST_BYTES) throw new CryptoError("bad-input", "That share manifest is longer than one share holds.");
  return bytes;
}

/** True for a share's end as a manifest names it: whole milliseconds since 1970, after 1970 and no later than a date can hold. */
function isExpiry(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= MAX_SHARE_EXPIRY_MS;
}

/** A share's end from its decimal text, or `bad-envelope`. */
function expiryFrom(text: string): number {
  const value = Number(text);
  if (!isExpiry(value) || String(value) !== text) throw new CryptoError("bad-envelope", "The share manifest names an end out of range.");
  return value;
}

/** A version from its decimal text, or `bad-envelope`. */
function versionFrom(text: string): number {
  const value = Number(text);
  if (!isKeyVersion(value) || String(value) !== text) throw new CryptoError("bad-envelope", "The share manifest has a version out of range.");
  return value;
}

/** 32 bytes from their 43 characters of base64url, or `bad-envelope` when they are not in its one encoding. */
function digestFrom(text: string): Uint8Array<ArrayBuffer> {
  try {
    return base64urlDecode(text);
  } catch (error) {
    throw new CryptoError("bad-envelope", "The share manifest names a digest in a form this app does not know.", { cause: error });
  }
}

/** What `bytes` says, refusing anything that is not exactly the canonical encoding (`bad-envelope`). */
export function decodeShareManifestBody(bytes: Uint8Array): ShareManifestBody {
  if (!isBytes(bytes, { min: SHARE_KEY_COMMIT_BYTES + 2 }) || bytes.byteLength > MAX_SHARE_MANIFEST_BYTES) {
    throw new CryptoError("bad-envelope", "The share manifest is not the length one can be.");
  }
  const split = bytes.byteLength - SHARE_KEY_COMMIT_BYTES - 1;
  if (bytes[split] !== 0) throw new CryptoError("bad-envelope", "The share manifest is not in the form this app knows.");
  let text: string;
  try {
    text = utf8Decode(bytes.subarray(0, split));
  } catch (error) {
    throw new CryptoError("bad-envelope", "The share manifest is not in the form this app knows.", { cause: error });
  }
  const match = TEXT.exec(text);
  if (match === null) throw new CryptoError("bad-envelope", "The share manifest is not in the form this app knows.");
  const [, shareId, ownerTeamId, autoId, revisionId, audience, mode, level, rev, exp, seq, skv, wkv, okv, device, tseq, tdev, och, prj, teamsText] = match as unknown as string[] as [
    string, string, string, string, string, string, string, string, string, string, string, string, string, string, string, string, string, string, string | undefined, string,
  ];
  const teams =
    teamsText === ""
      ? []
      : teamsText.split(",").map((entry): [string, number, Uint8Array] => {
          const team = TEAM.exec(entry);
          if (team === null) throw new CryptoError("bad-envelope", "The share manifest names a team in a form this app does not know.");
          return [team[1] as string, versionFrom(team[2] as string), digestFrom(team[3] as string)];
        });
  const body: ShareManifestBody = {
    shareId,
    ownerTeamId,
    autoId,
    revisionId,
    audience: audience as ShareManifestBody["audience"],
    mode: mode as ShareManifestBody["mode"],
    level: level as ShareManifestBody["level"],
    revoked: rev === "1",
    expiresAtMs: expiryFrom(exp),
    seq: versionFrom(seq),
    skv: versionFrom(skv),
    wkv: versionFrom(wkv),
    okv: versionFrom(okv),
    device,
    termsSeq: versionFrom(tseq),
    termsDevices: tdev.split(","),
    choice: och === "-" ? null : digestFrom(och),
    ...(prj === undefined ? {} : { projection: digestFrom(prj) }),
    teams,
    commit: toBytes(bytes.subarray(split + 1)),
  };
  let again: Uint8Array;
  try {
    again = encodeShareManifestBody(body);
  } catch (error) {
    throw new CryptoError("bad-envelope", "The share manifest is not in the form this app knows.", { cause: error });
  }
  if (!bytesEqual(again, bytes)) throw new CryptoError("bad-envelope", "The share manifest is not in its one canonical form.");
  return body;
}

/** The device keys a manifest is signed with: its id, its two public keys and its private signing key. */
export type ManifestSigner = Pick<DeviceKeys, "deviceId" | "encSpki" | "signSpki"> & { signing: Pick<CryptoKeyPair, "privateKey"> };

/**
 * `body` encoded and signed with the owner team's signing key of version `body.okv`, and with the
 * signing key of `device`, which must be the device the body names. Without `terms`, `device` signs
 * the share's terms too (`shareTermsStatement`), and must be the last of the terms signers the body
 * names: a new share, a change of its terms, or the first manifest at a newer key version. With
 * `terms`, the terms signature and keys of the manifest this one replaces, which names the same
 * terms, are carried unchanged; whether they still verify is the reader's check
 * (`openShareManifest`), which the caller should have made on the manifest it replaces.
 */
export async function signShareManifest(input: {
  body: ShareManifestBody;
  signingKey: CryptoKey;
  device: ManifestSigner;
  terms?: Pick<ShareManifest, "tsig" | "tkeys">;
}): Promise<ShareManifest> {
  if (input.body.device !== input.device.deviceId) throw new CryptoError("bad-input", "A share manifest names the device that signs it.");
  const bytes = encodeShareManifestBody(input.body);
  const dkeys = concatBytes(input.device.encSpki, input.device.signSpki);
  let terms: Pick<ShareManifest, "tsig" | "tkeys">;
  if (input.terms === undefined) {
    if (input.body.termsDevices.at(-1) !== input.device.deviceId) throw new CryptoError("bad-input", "A device that signs a share's terms is the last of their signers the manifest names.");
    terms = { tsig: await sign(input.device.signing.privateKey, shareTermsStatement(input.body)), tkeys: dkeys };
  } else {
    if (!isBytes(input.terms.tsig, { exactly: SIGNATURE_BYTES }) || !isBytes(input.terms.tkeys, { exactly: MANIFEST_DEVICE_KEYS_BYTES })) {
      throw new CryptoError("bad-input", "A terms signature is 64 bytes and the keys of the device that made it 182.");
    }
    terms = { tsig: toBytes(input.terms.tsig), tkeys: toBytes(input.terms.tkeys) };
  }
  return {
    v: SHARE_MANIFEST_VERSION,
    body: bytes,
    sig: await sign(input.signingKey, bytes),
    dsig: await sign(input.device.signing.privateKey, bytes),
    dkeys,
    ...terms,
  };
}

/**
 * The bytes the last terms signer of a share signs (`tsig`): the UTF-8 text
 * `zenith/v5/share-terms|share=<shareId>|owner=<ownerTeamId>|aid=<autoId>|aud=<audience>|mode=<mode>|lvl=<level>|rev=0|1|exp=<ms>|okv=<n>|tseq=<n>|tdev=<deviceId>,...|rid=<revisionId, or nothing for a following share>|och=<choice>|teams=<teamId>:<ekv>:<key>,...`,
 * in the body's own spellings. It names everything a person or the sharing team chose about the
 * share: which auto, to whom and with which of each team's keys, pinned to which revision or
 * following, at which level, until when, whether revoked, with which of the sharer's choices, and
 * who signed those terms at which key version. It leaves out what an ordinary write changes without
 * a choice: the revision a following share was last moved to, the share key, its commitment, the
 * versions it is sealed under, and the sequence number and signer of the manifest. A share's id is
 * new for each share, so terms signed for one share are never terms of another.
 */
export function shareTermsStatement(body: ShareManifestBody): Uint8Array<ArrayBuffer> {
  const { teams } = checkedTerms(body);
  return utf8Encode(
    [
      TERMS_LABEL,
      idPart("share", body.shareId),
      idPart("owner", body.ownerTeamId),
      idPart("aid", body.autoId),
      `aud=${body.audience}`,
      `mode=${body.mode}`,
      `lvl=${body.level}`,
      `rev=${body.revoked ? "1" : "0"}`,
      `exp=${String(body.expiresAtMs)}`,
      versionPart("okv", body.okv),
      versionPart("tseq", body.termsSeq),
      `tdev=${body.termsDevices.join(",")}`,
      body.mode === "pinned" ? idPart("rid", body.revisionId) : "rid=",
      `och=${body.choice === null ? "-" : base64urlEncode(body.choice)}`,
      `teams=${teams}`,
    ].join("|"),
  );
}

/**
 * True when `a` and `b` name the same terms, apart from who signed them and how often: the terms
 * statement of each with `b`'s signers, count and key version. A write whose new body names the
 * same terms as the one it replaces carries the terms signature; any other writes a new one.
 */
export function sameShareTerms(a: ShareManifestBody, b: ShareManifestBody): boolean {
  const as = { termsSeq: b.termsSeq, termsDevices: b.termsDevices, okv: b.okv };
  return bytesEqual(shareTermsStatement({ ...a, ...as }), shareTermsStatement(b));
}

/** The signing public key of the device that signed `manifest`'s terms, from its `tkeys`: a 91-byte SPKI. */
export function manifestTermsSignSpki(manifest: ShareManifest): Uint8Array<ArrayBuffer> {
  return toBytes(manifest.tkeys.subarray(P256_SPKI_BYTES));
}

/**
 * The 32 bytes that name team `teamId`'s public key of version `v` in a manifest: SHA-256 of
 * `zenith/v4/team-key-digest|team=<teamId>|ekv=<v>`, a zero byte, the key's 32-byte ECDH fingerprint
 * and its 91-byte signing SPKI. It covers both keys a team publishes for a version, as its safety
 * code does, and, in full, keeps the 128-bit collision resistance of SHA-256.
 */
export async function teamKeyDigest(input: { teamId: string; v: number; fingerprint: Uint8Array; signSpki: Uint8Array }): Promise<Uint8Array<ArrayBuffer>> {
  if (!isBytes(input.fingerprint, { exactly: 32 }) || !isBytes(input.signSpki, { exactly: P256_SPKI_BYTES })) {
    throw new CryptoError("bad-key", "A team key digest needs a 32-byte fingerprint and a 91-byte signing key.");
  }
  const label = ["zenith/v4/team-key-digest", idPart("team", input.teamId), versionPart("ekv", input.v)].join("|");
  return sha256(concatBytes(utf8Encode(label), new Uint8Array([0]), input.fingerprint, input.signSpki));
}

/**
 * What `manifest` says, once its shape is checked, its signature verifies with `signSpki`, the owner
 * team's signing key of the version the body names, its device signature verifies with the signing
 * key in `dkeys`, the keys of the device the body names, and its terms signature verifies over the
 * body's terms statement with the signing key in `tkeys`, the keys of the last terms signer the body
 * names. The caller finds the team's key from what it trusts, after reading `okv` with
 * `readShareManifest`, and checks the rest against the share; whether the devices are ones the owner
 * team keeps is the owner team's own question (`manifestDeviceSignSpki`, `manifestTermsSignSpki`),
 * which only its roster answers. Throws `bad-envelope` for a manifest out of shape and
 * `bad-signature` for one any of the three keys did not sign.
 */
export async function openShareManifest(input: { manifest: ShareManifest; signSpki: Uint8Array }): Promise<ShareManifestBody> {
  const body = readShareManifest(input.manifest);
  if (!(await verify(input.signSpki, input.manifest.sig, input.manifest.body))) {
    throw new CryptoError("bad-signature", "The share manifest is not signed by the team that made the share.");
  }
  if (deviceIdFor(await sha256(input.manifest.dkeys)) !== body.device) {
    throw new CryptoError("bad-signature", "The share manifest carries the keys of another device than the one it names.");
  }
  if (!(await verify(manifestDeviceSignSpki(input.manifest), input.manifest.dsig, input.manifest.body))) {
    throw new CryptoError("bad-signature", "The share manifest is not signed by the device it names.");
  }
  if (deviceIdFor(await sha256(input.manifest.tkeys)) !== body.termsDevices.at(-1)) {
    throw new CryptoError("bad-signature", "The share manifest carries the keys of another device than the one it names as the last to sign its terms.");
  }
  if (!(await verify(manifestTermsSignSpki(input.manifest), input.manifest.tsig, shareTermsStatement(body)))) {
    throw new CryptoError("bad-signature", "The share's terms are not the ones the device that last set them signed, so someone else may have changed them.");
  }
  return body;
}

/** The signing public key of the device that signed `manifest`, from its `dkeys`: a 91-byte SPKI. */
export function manifestDeviceSignSpki(manifest: ShareManifest): Uint8Array<ArrayBuffer> {
  return toBytes(manifest.dkeys.subarray(P256_SPKI_BYTES));
}

/** The body of `manifest`, decoded but not yet verified, so its reader can find the key to verify it with. */
export function readShareManifest(manifest: ShareManifest): ShareManifestBody {
  if (
    typeof manifest !== "object" ||
    manifest === null ||
    manifest.v !== SHARE_MANIFEST_VERSION ||
    !isBytes(manifest.body) ||
    !isBytes(manifest.sig, { exactly: SIGNATURE_BYTES }) ||
    !isBytes(manifest.dsig, { exactly: SIGNATURE_BYTES }) ||
    !isBytes(manifest.dkeys, { exactly: MANIFEST_DEVICE_KEYS_BYTES }) ||
    !isBytes(manifest.tsig, { exactly: SIGNATURE_BYTES }) ||
    !isBytes(manifest.tkeys, { exactly: MANIFEST_DEVICE_KEYS_BYTES })
  ) {
    throw new CryptoError("bad-envelope", "The share manifest has a version this app does not know.");
  }
  return decodeShareManifestBody(manifest.body);
}
