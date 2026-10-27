/**
 * The associated data (AAD) for every AES-GCM seal and public-key wrap. Spec 14 section 4.1 binds
 * each ciphertext to the document path it lives at and to its purpose, so a server that moves a
 * ciphertext to another document, or offers an old key version as the current one, makes decryption
 * fail. One builder per purpose means every caller spells a purpose's AAD the same way.
 *
 * The text is `zenith/v1/<purpose>|<name>=<value>|...`, for example
 * `zenith/v1/revision|team=t1|auto=a1|rev=000004-x|field=content|kv=3`. Values are ids (letters,
 * digits, `-` and `_`, which every Zenith id is made of) or whole-number versions, so no value can
 * contain `|` or `=` and two different inputs can never give the same text.
 */
import { base64urlEncode, utf8Encode } from "./bytes.js";
import { CryptoError } from "./errors.js";

declare const aadBrand: unique symbol;

/** AAD text made by one of the `aadFor` builders. The brand stops a hand-written string being passed. */
export type Aad = string & { readonly [aadBrand]: true };

/** The revision fields that are sealed, each with its own AAD so they cannot be swapped. */
export type RevisionField = "content" | "robot" | "field" | "waypoints" | "gitSha";

const ID = /^[A-Za-z0-9_-]{1,128}$/;

/** `name=value` for an id, throwing `bad-input` when `value` is not 1 to 128 id characters. Internal. */
export function idPart(name: string, value: string): string {
  if (typeof value !== "string" || !ID.test(value)) {
    throw new CryptoError("bad-input", `The ${name} for associated data must be 1 to 128 letters, digits, hyphens or underscores.`);
  }
  return `${name}=${value}`;
}

/** A key version: a whole number from 1 to 2^31 - 1. */
export function isKeyVersion(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 0x7fffffff;
}

/** `name=value` for a key version, throwing `bad-input` when `value` is not one. Internal. */
export function versionPart(name: string, value: number): string {
  if (!isKeyVersion(value)) throw new CryptoError("bad-input", `The ${name} for associated data must be a whole number from 1 to 2147483647.`);
  return `${name}=${String(value)}`;
}

/**
 * `uid=` and a sign-in uid as base64url of its UTF-8, throwing `bad-input` for an empty uid or one
 * longer than 128 characters.
 */
export function uidPart(uid: string): string {
  if (typeof uid !== "string" || uid.length === 0 || uid.length > 128) throw new CryptoError("bad-input", "A uid for associated data must have 1 to 128 characters.");
  return `uid=${base64urlEncode(utf8Encode(uid))}`;
}

function build(purpose: string, ...parts: string[]): Aad {
  return [`zenith/v1/${purpose}`, ...parts].join("|") as Aad;
}

const REVISION_FIELDS: readonly RevisionField[] = ["content", "robot", "field", "waypoints", "gitSha"];

/**
 * What a proposal's diff and both wraps of its key are bound to: the proposal, the share it was made
 * on, the team that owns the share and the team that sent it, the owner team's `encKey` version the
 * key is wrapped to (`okv`), and the proposing team's key version it is sealed under (`fkv`).
 */
export interface ProposalBinding {
  proposalId: string;
  shareId: string;
  ownerTeamId: string;
  fromTeamId: string;
  okv: number;
  fkv: number;
}

function proposalParts(input: ProposalBinding): string[] {
  return [
    idPart("proposal", input.proposalId),
    idPart("share", input.shareId),
    idPart("owner", input.ownerTeamId),
    idPart("from", input.fromTeamId),
    versionPart("okv", input.okv),
    versionPart("fkv", input.fkv),
  ];
}

/** One AAD builder per purpose. `kv` is always the version of the key that seals or wraps. */
export const aadFor = {
  /**
   * One field of `teams/{teamId}/autos/{autoId}/revisions/{revisionId}`, sealed under team key `kv`.
   * `zenith/v1/revision|team=|auto=|rev=|field=|kv=`.
   */
  revision(input: { teamId: string; autoId: string; revisionId: string; field: RevisionField; kv: number }): Aad {
    if (!REVISION_FIELDS.includes(input.field)) throw new CryptoError("bad-input", "A revision field must be content, robot, field, waypoints or gitSha.");
    return build("revision", idPart("team", input.teamId), idPart("auto", input.autoId), idPart("rev", input.revisionId), `field=${input.field}`, versionPart("kv", input.kv));
  },
  /**
   * The title on `teams/{teamId}/autos/{autoId}`, sealed under team key `kv`. `gen` is the title's
   * generation, 1 when the auto is made and one more each time the title is written again, so an
   * older title the server puts back is refused by a device that saw a newer one.
   */
  autoTitle(input: { teamId: string; autoId: string; gen: number; kv: number }): Aad {
    return build("auto-title", idPart("team", input.teamId), idPart("auto", input.autoId), versionPart("gen", input.gen), versionPart("kv", input.kv));
  },
  /** The `detail` of `teams/{teamId}/activity/{entryId}` (the title an `auto.create` entry carries), under team key `kv`. */
  activityDetail(input: { teamId: string; entryId: string; kv: number }): Aad {
    return build("activity-detail", idPart("team", input.teamId), idPart("entry", input.entryId), versionPart("kv", input.kv));
  },
  /**
   * The projection on `shares/{shareId}` of auto `autoId`, sealed under share key `kv` (always 1 for
   * a link share). The auto is bound in, so a projection shows only as the auto it was built from.
   * `zenith/v1/share-projection|share=|auto=|kv=`.
   */
  shareProjection(input: { shareId: string; autoId: string; kv: number }): Aad {
    return build("share-projection", idPart("share", input.shareId), idPart("auto", input.autoId), versionPart("kv", input.kv));
  },
  /**
   * `ownerChoice` on `shares/{shareId}`: the choices its sharer made when building its projection
   * (how coarse it is, whether it names its commands), sealed under owner team `teamId`'s key `kv`,
   * so no team the share was made to can change what the next projection shows.
   * `zenith/v1/owner-choice|share=|team=|kv=`.
   */
  ownerChoice(input: { shareId: string; teamId: string; kv: number }): Aad {
    return build("owner-choice", idPart("share", input.shareId), idPart("team", input.teamId), versionPart("kv", input.kv));
  },
  /**
   * The diff on `proposals/{proposalId}`, sealed under that proposal's own key.
   * `zenith/v1/proposal-diff|proposal=|share=|owner=|from=|okv=|fkv=`, the same binding as both of the
   * proposal key's wraps, so none of the three can be moved to another proposal, share or team, or
   * paired with a wrap under other key versions.
   */
  proposalDiff(input: ProposalBinding): Aad {
    return build("proposal-diff", ...proposalParts(input));
  },
  /**
   * A proposal's key wrapped to owner team `ownerTeamId`'s `encKey` version `okv` (`ownerWrap` on the
   * proposal). `zenith/v1/proposal-owner-wrap|proposal=|share=|owner=|from=|okv=|fkv=`.
   */
  proposalOwnerWrap(input: ProposalBinding): Aad {
    return build("proposal-owner-wrap", ...proposalParts(input));
  },
  /**
   * A proposal's key sealed under proposing team `fromTeamId`'s team key `fkv` (`fromWrap` on the
   * proposal). `zenith/v1/proposal-from-wrap|proposal=|share=|owner=|from=|okv=|fkv=`.
   */
  proposalFromWrap(input: ProposalBinding): Aad {
    return build("proposal-from-wrap", ...proposalParts(input));
  },
  /**
   * The private half of team signing pair `kv`, sealed under team key `kv` in `teamKeys/{kv}`. The
   * public half's SHA-256 is bound in, so the stored signing key cannot be swapped either.
   */
  teamSigningKey(input: { teamId: string; kv: number; fingerprint: Uint8Array }): Aad {
    return build("team-signing-key", idPart("team", input.teamId), versionPart("kv", input.kv), `fp=${base64urlEncode(input.fingerprint)}`);
  },
  /** Team key `kv - 1`, sealed under team key `kv` in `teams/{teamId}/teamKeys/{kv}`. */
  teamKeyChain(input: { teamId: string; kv: number }): Aad {
    return build("team-key-chain", idPart("team", input.teamId), versionPart("kv", input.kv));
  },
  /**
   * The private half of team key pair `kv`, sealed under team key `kv` in `teamKeys/{kv}`. The
   * public half's fingerprint is bound in, so the stored public key cannot be swapped either.
   */
  teamKeyPair(input: { teamId: string; kv: number; fingerprint: Uint8Array }): Aad {
    return build("team-key-pair", idPart("team", input.teamId), versionPart("kv", input.kv), `fp=${base64urlEncode(input.fingerprint)}`);
  },
  /**
   * The proof on `teams/{teamId}/keyGrants/{deviceId}`: that device's fingerprint sealed under team key
   * `kv`, so any holder of key `kv` can check that a holder of the same key made the grant. The
   * member's uid is bound in as base64url of its UTF-8 (a uid may hold characters an id may not), so
   * a grant moved to another member's name no longer checks.
   */
  keyGrantProof(input: { teamId: string; deviceId: string; uid: string; kv: number }): Aad {
    return build("key-grant-proof", idPart("team", input.teamId), idPart("device", input.deviceId), uidPart(input.uid), versionPart("kv", input.kv));
  },
  /** Team key `kv` wrapped to device `deviceId` in `teams/{teamId}/keyGrants/{deviceId}`. */
  keyGrant(input: { teamId: string; deviceId: string; kv: number }): Aad {
    return build("key-grant", idPart("team", input.teamId), idPart("device", input.deviceId), versionPart("kv", input.kv));
  },
  /** Team key `kv` wrapped to the team's recovery public key in `teams/{teamId}/recovery/current`. */
  recovery(input: { teamId: string; kv: number }): Aad {
    return build("recovery", idPart("team", input.teamId), versionPart("kv", input.kv));
  },
  /** The recovery private key, sealed under the key derived from the printed recovery code. */
  recoveryKeyPair(input: { teamId: string }): Aad {
    return build("recovery-key-pair", idPart("team", input.teamId));
  },
  /**
   * The recovery signing key's private half, sealed under the key derived from the printed recovery
   * code, like the recovery key pair's. `zenith/v1/recovery-signing-key|team=`.
   */
  recoverySigningKey(input: { teamId: string }): Aad {
    return build("recovery-signing-key", idPart("team", input.teamId));
  },
  /**
   * The device roster of team key version `kv`, sealed under team key `kv` in `teamKeys/{kv}`:
   * which devices were given key `kv`, whose they are, and each member's role then.
   * `zenith/v1/team-roster|team=|kv=`.
   */
  teamRoster(input: { teamId: string; kv: number }): Aad {
    return build("team-roster", idPart("team", input.teamId), versionPart("kv", input.kv));
  },
  /** The recovery public key's fingerprint, sealed under team key `kv` so a rotating admin can trust it. */
  recoveryCheck(input: { teamId: string; kv: number }): Aad {
    return build("recovery-check", idPart("team", input.teamId), versionPart("kv", input.kv));
  },
  /** Share key `kv` of share `shareId`, wrapped to team `teamId`'s `encKey` version `ekv` (`keyWraps.<teamId>`). */
  shareWrap(input: { shareId: string; teamId: string; kv: number; ekv: number }): Aad {
    return build("share-wrap", idPart("share", input.shareId), idPart("team", input.teamId), versionPart("kv", input.kv), versionPart("ekv", input.ekv));
  },
  /** Share key `kv - 1` of share `shareId`, sealed under share key `kv` (`prevKeys.<kv - 1>` on the share). */
  shareKeyChain(input: { shareId: string; kv: number }): Aad {
    return build("share-key-chain", idPart("share", input.shareId), versionPart("kv", input.kv));
  },
  /** Share key `skv` of share `shareId`, sealed under owner team `teamId`'s key `kv` (`ownerWrap`). */
  ownerWrap(input: { shareId: string; teamId: string; kv: number; skv: number }): Aad {
    return build("owner-wrap", idPart("share", input.shareId), idPart("team", input.teamId), versionPart("kv", input.kv), versionPart("skv", input.skv));
  },
  /**
   * A link share's secret S, sealed under owner team `teamId`'s key `kv` (the link share's
   * `linkWrap`), for auto `autoId`. `zenith/v1/link-wrap|share=|team=|auto=|kv=`.
   */
  linkWrap(input: { shareId: string; teamId: string; autoId: string; kv: number }): Aad {
    return build("link-wrap", idPart("share", input.shareId), idPart("team", input.teamId), idPart("auto", input.autoId), versionPart("kv", input.kv));
  },
} as const;
