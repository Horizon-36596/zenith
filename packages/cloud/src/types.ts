/**
 * The cloud data model, exactly as it is stored in Firestore (spec 13, cloud/README.md). The security
 * rules in cloud/firestore.rules enforce every constraint written here; these types are the same
 * shapes on the client side.
 *
 * Every time is a `Date` on the client and a Firestore timestamp in the database. Document ids are
 * noted on each type: the path is part of the contract.
 *
 * Content is end-to-end encrypted (spec 14): an auto's title, a revision's four files, the title in
 * an `auto.create` activity entry, a share's projection and a proposal's diff are stored as sealed
 * `Envelope`s, which only the team's devices, or the teams a share was made to, can open. The client's
 * API (backend.ts) hands them out opened, as plain text.
 */
import type { Envelope, ProposalKeyWrap, PublicKeyWrap, ShareKeyWrap, ShareManifest, TeamEncKey } from "./crypto/index.js";

/** A role in a team (spec 13 section 4.3). `pending` is a member waiting for an admin's approval. */
export type Role = "owner" | "admin" | "editor" | "viewer" | "pending";

/** A role that reads the team library. A pending member reads nothing but their own membership. */
export type ActiveRole = Exclude<Role, "pending">;

/** A role an invite can give. Owners are made only by another owner, never by invite. */
export type InviteRole = "admin" | "editor" | "viewer";

/** A team number's verification status (spec 13 section 4.4). */
export type TeamStatus = "unverified" | "verified" | "contested";

export const ACTIVE_ROLES: readonly ActiveRole[] = ["owner", "admin", "editor", "viewer"];
export const EDITOR_ROLES: readonly ActiveRole[] = ["owner", "admin", "editor"];
export const ADMIN_ROLES: readonly ActiveRole[] = ["owner", "admin"];

/**
 * `users/{uid}`. Only its owner reads or writes it. A profile made before the age screen was removed
 * (owner ruling 2026-10-02) may also hold `over13: true`, which nothing reads.
 */
export interface UserDoc {
  displayName: string;
  createdAt: Date;
}

/**
 * `admins/{uid}`: a Horizon admin. The very first is named from the Firebase console; after that any
 * Horizon admin adds and removes admins on the review page (owner ruling 2026-10-02), with exactly
 * `{ name }`, and never removes themselves. An entry made in the console may lack the name.
 */
export interface AdminDoc {
  name?: string;
}

/**
 * `betaTesters/{uid}`: a person let into the private beta. Added and removed by any Horizon admin on
 * the review page, or from the Firebase console; the tester reads their own, and Horizon admins read
 * and list them all.
 */
export interface BetaTesterDoc {
  /** The tester's name, as the admin typed it or as the tester's request gave it. */
  name: string;
}

/**
 * `betaRequests/{uid}`: a request for beta access a signed-in person sent from the private-beta
 * screen before 2026-10-03, when asking was removed (issue #99). Nobody makes or changes one now; the
 * ones left are read and deleted by their sender and by Horizon admins. Adding the person by user
 * code deletes theirs, and the daily clean-up deletes each after BETA_REQUEST_MAX_DAYS in
 * `cleanup/plan.ts` and with the account.
 */
export interface BetaRequestDoc {
  /** The name the person typed, 1 to MAX_BETA_NAME characters. */
  name: string;
  /** The sign-in token's email, when the token had one. */
  email?: string;
  createdAt: Date;
}

/**
 * The longest name a beta request, a beta tester entry or a Horizon admin entry holds, as `size()`
 * counts. SET BY HAND, equal to the display name's limit.
 */
export const MAX_BETA_NAME = 80;

/**
 * `config/access`: written only from the Firebase console, read by anyone signed in. A missing
 * document, or any `betaOpen` but true, keeps the private beta closed.
 */
export interface AccessConfigDoc {
  /** True opens Zenith to everyone: the public launch switch. */
  betaOpen: boolean;
}

/** `teams/{teamId}`. The id is 128 random bits. Any signed-in user may read one by id. */
export interface TeamDoc {
  /** The FTC team number, or null for a team that has not claimed one. */
  number: number | null;
  name: string;
  /** Written only by a Horizon admin after creation. */
  status: TeamStatus;
  createdBy: string;
  createdAt: Date;
  /**
   * On a team with no number that contests one: the review it opened, set in the same write that
   * labels it contested, which the rules require. A reviewer's decision clears it to null.
   */
  disputeId?: string | null;
  /**
   * The public half of the team's newest team key pair (spec 14 section 4.1). Other teams wrap share
   * keys to it; `v` is the newest team key version, which every new ciphertext of the team is under.
   */
  encKey: TeamEncKey;
  /**
   * True after a member left, or revoked a device of their own, without being able to rotate the
   * team key: the next owner or admin rotates it (spec 14 section 4.5). Absent or false otherwise.
   */
  rotationPending?: boolean;
}

/** `teams/{teamId}/members/{uid}`. A removed member has no document. */
export interface MemberDoc {
  uid: string;
  teamId: string;
  role: Role;
  /** Copied from the member's profile so teammates never need to read another user's profile. */
  displayName: string;
  joinedAt: Date;
  /** The invite code the member joined with; absent for the founding owner. */
  invite?: string;
  /** The role the invite offered, which an admin grants on approval. */
  requestedRole?: InviteRole;
}

/** `teams/{teamId}/settings/sharing`. A missing document means every default, all false. */
export interface TeamSettingsDoc {
  /** Editors may make propose-level shares. Default false (spec 13 section 4.3). */
  editorsMayProposeShare?: boolean;
  /** Editors may make anyone-with-the-link shares. Default false (spec 13 section 4.3). */
  editorsMayLinkShare?: boolean;
  /** Publish a revision on every save (spec 13 section 5.2). Default false. */
  publishOnSave?: boolean;
  /**
   * Any active member may give the team key to another member's new device, not only owners, admins
   * and the member's own devices. Default false (spec 14 section 0).
   */
  membersMayApproveDevices?: boolean;
}

/** `invites/{code}`. The code is the document id: 128 random bits. Nobody can list invites. */
export interface InviteDoc {
  teamId: string;
  role: InviteRole;
  expiresAt: Date;
  maxUses: number;
  uses: number;
  /** When false, which is the default, a new member joins as `pending`. */
  autoApprove: boolean;
  createdBy: string;
  createdAt: Date;
  revoked: boolean;
}

/** `teams/{teamId}/autos/{autoId}`. */
export interface AutoDoc {
  /** The title, sealed under the team's newest key when it was written (`aadFor.autoTitle`, with `titleGen`). */
  title: Envelope;
  /** The title's generation: 1 when the auto is made, one more each time the title is written again. */
  titleGen: number;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * `teams/{teamId}/autos/{autoId}/revisions/{revisionId}`: create-only, never updated or deleted.
 *
 * The id is `n` zero-padded to six digits, a hyphen and a random suffix (`000004-q8Yx…`), so two
 * members publishing revision 4 offline make two documents instead of one lost write.
 */
export interface RevisionDoc {
  /** 1 for the first revision, otherwise the base revision's `n` plus one. */
  n: number;
  /** The id of the revision this one was edited from, or null for the first. */
  baseRevision: string | null;
  author: string;
  createdAt: Date;
  /**
   * The commit the auto came from, when the project is a git repository, sealed like the files below
   * (field `gitSha`): a commit id can be looked up in a public repository.
   */
  gitSha?: Envelope;
  /**
   * The auto file in canonical form (spec 02), as JSON text sealed under the team's newest key
   * (`aadFor.revision`, field `content`). The three below are sealed under the same key version.
   */
  content: Envelope;
  /** The team's robot.json at publish time, sealed. */
  robot?: Envelope;
  /** The field file at publish time, sealed. */
  field?: Envelope;
  /** The waypoints file at publish time, sealed. */
  waypoints?: Envelope;
  /** Set by the publisher when it already knew its base was not the newest revision. */
  diverged: boolean;
}

export type ShareAudience = "teams" | "link";
export type ShareLevel = "view" | "propose";
export type ShareMode = "pinned" | "follow";

/**
 * `shares/{shareId}`. The id is 128 random bits. A link share's id is derived from the secret in its
 * link (`#/s/<secret>`, spec 14 section 4.7), so the server never learns the secret.
 *
 * A link share is readable by any caller by id and never listed. A share to teams is readable by
 * active members of the listed teams while it is live. The sharing team always reads its own.
 */
export interface ShareDoc {
  ownerTeamId: string;
  autoId: string;
  audience: ShareAudience;
  /** The receiving teams; empty for a link share; at most 8 (ADR 0009 section 4). */
  teamIds: string[];
  level: ShareLevel;
  mode: ShareMode;
  /** The revision id the projection was built from. */
  revision: string;
  expiresAt: Date;
  revokedAt: Date | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  /**
   * The projection (spec 13 section 8.2) as JSON text built on the sharer's device, sealed under the
   * share key (`aadFor.shareProjection`). Its `kv` is the share key's version: always 1 for a link
   * share, and one higher each time a team is taken off a share to teams.
   */
  projection: Envelope;
  /** A share to teams: the share key wrapped to each recipient team's `encKey`, by team id. */
  keyWraps?: Record<string, ShareKeyWrap>;
  /** A share to teams: the share key sealed under the owner team's key (`aadFor.ownerWrap`). */
  ownerWrap?: Envelope;
  /** A link share: its secret sealed under the owner team's key, so a teammate can copy the link again. */
  linkWrap?: Envelope;
  /**
   * A share to teams that was re-keyed: each older share key, by its version as decimal text, sealed
   * under the version above it (`aadFor.shareKeyChain`), so older proposals stay readable.
   */
  prevKeys?: Record<string, Envelope>;
  /**
   * Which auto and revision the share shows, to whom, following or pinned, at which level, until
   * when, whether it is revoked, which share key the owner team made and the team key version it was
   * wrapped to for each team, signed with the owner team's signing key and by the device that wrote
   * it, with the terms signed by the device that last chose them (crypto/manifest.ts). On every
   * share, a link share included. Written again, one `seq` higher, by every update of the share.
   */
  manifest: ShareManifest;
  /**
   * The sharer's choices for the projection (`CreateShareInput.ownerChoice`), sealed under the owner
   * team's key (`aadFor.ownerChoice`). Written once, when the share is made; the manifest names its
   * digest.
   */
  ownerChoice?: Envelope;
}

/** `teams/{teamId}/inbox/{shareId}`: a pointer to a share made to this team. */
export interface InboxDoc {
  shareId: string;
  ownerTeamId: string;
  createdBy: string;
  createdAt: Date;
}

export type ProposalStatus = "open" | "accepted" | "rejected" | "withdrawn";

/** `proposals/{proposalId}`. Readable by both teams and nobody else. */
export interface ProposalDoc {
  shareId: string;
  ownerTeamId: string;
  autoId: string;
  fromTeamId: string;
  /** The revision id of the share the proposal was made against. */
  baseRevision: string;
  /**
   * The proposed change as JSON text (`core.diff`, by step id), sealed under this proposal's own key
   * (`aadFor.proposalDiff`), never under the share key, which every team on the share holds.
   */
  diff: Envelope;
  /**
   * The proposal key wrapped to the owner team's `encKey` of version `ekv`, the owner team's newest key
   * this device verified, so only that team opens it.
   */
  ownerWrap: ProposalKeyWrap;
  /**
   * The proposal key sealed under the proposing team's key of version `kv`, so the proposing team reads
   * what it sent after the share ends or it is taken off the share.
   */
  fromWrap: Envelope;
  /**
   * 64 bytes: the proposing team's signature over the proposal (`proposalSignedBytes`), with its team
   * signing key of version `fromWrap.kv`. The owner team lists only a proposal whose signature checks
   * with the signing key it trusts for that team, since anyone can make `ownerWrap`.
   */
  sig: Uint8Array;
  status: ProposalStatus;
  createdBy: string;
  createdAt: Date;
  decidedBy?: string;
  decidedAt?: Date;
}

/**
 * Why a team asks for more time on a share it received (spec 13 section 8.4): a fixed list, never
 * free text, because FIRST's Youth Protection Program rules out private messages between users
 * (spec 13 section 12.2). The web app words each one as a sentence.
 */
export type TimeRequestReason = "next-event" | "still-testing" | "still-planning";

export const TIME_REQUEST_REASONS: readonly TimeRequestReason[] = ["next-event", "still-testing", "still-planning"];

export type TimeRequestStatus = "open" | "granted" | "declined";

/**
 * `shares/{shareId}/timeRequests/{teamId}`: "Request more time", from a team the share was made to,
 * to the team that made it. The id is the asking team's, so a team has at most one request per
 * share; asking again after a decision replaces it. Both teams' active members read it.
 */
export interface TimeRequestDoc {
  shareId: string;
  /** The asking team: one of the share's `teamIds`. */
  teamId: string;
  /** The team that made the share, which decides. */
  ownerTeamId: string;
  requestedBy: string;
  requestedAt: Date;
  status: TimeRequestStatus;
  reason?: TimeRequestReason;
  /** The end the asking team would like, when it named one. Always after the moment it asked. */
  wantedUntil?: Date;
  decidedBy?: string;
  decidedAt?: Date;
  /** The share's new end, when the request was granted: the extension was made in the same write. */
  grantedUntil?: Date;
}

/** What an activity entry records. Free text in the database, this list in the client. */
export type ActivityKind =
  | "team.create"
  | "team.rename"
  | "team.claim"
  | "member.join"
  | "member.approve"
  | "member.role"
  | "member.remove"
  | "member.leave"
  | "invite.create"
  | "invite.extend"
  | "invite.revoke"
  | "auto.create"
  | "revision.publish"
  | "share.create"
  | "share.extend"
  | "share.revoke"
  | "share.level"
  | "share.mode"
  | "share.update"
  | "proposal.send"
  | "proposal.decide"
  /** Asked the team that made a share for more time on it (the asking team's log). */
  | "time.request"
  /** Granted a request for more time, which extended the share (the sharing team's log). */
  | "time.grant"
  /** Declined a request for more time (the sharing team's log). */
  | "time.decline"
  | "settings.change"
  /** Gave the team key to a device (a member's new device, or a new member's). */
  | "key.grant"
  /** Made a new team key and gave it to every device that keeps access. */
  | "key.rotate"
  /** Took the team key from a device. */
  | "key.revoke"
  /** Took a team off a share, which gave the share a new key. */
  | "share.teams"
  /** Unlocked the team library on a device with the team recovery code. */
  | "recovery.use"
  /** Made a new team recovery code, which replaced the old one. */
  | "recovery.replace"
  | "dispute.open"
  | "dispute.evidence"
  | "dispute.appeal"
  | "verification.request";

/** `teams/{teamId}/activity/{entryId}`: append-only. Owners and admins read it. */
export interface ActivityDoc {
  at: Date;
  by: string;
  kind: ActivityKind;
  /** The id the entry is about: an invite code, a share id, an auto id, a member uid. */
  target?: string;
  /** Plain text, except an `auto.create` entry's, which is the auto's title sealed (`aadFor.activityDetail`). */
  detail?: string | Envelope;
}

// ---------------------------------------------------------------------------- keys (spec 14)

/**
 * `users/{uid}/devices/{deviceId}`: a device's public keys. The id is the first 128 bits of the
 * fingerprint; every client checks that before it trusts the record. Never changed.
 */
export interface DeviceDoc {
  v: 1;
  /** 91-byte SPKI of the device's P-256 ECDH key, which team keys are wrapped to. */
  encSpki: Uint8Array;
  /** 91-byte SPKI of the device's P-256 ECDSA key, which signs the grants it makes. */
  signSpki: Uint8Array;
  /** 32 bytes: SHA-256 of `encSpki` then `signSpki`. */
  fingerprint: Uint8Array;
  createdAt: Date;
}

/**
 * `teams/{teamId}/teamKeys/{kv}`: team key kv-1 sealed under key kv, and team key pair kv. Never
 * changed. Anyone signed in may get one by id, so it holds public keys and ciphertext only: no
 * creator and no time.
 */
export interface TeamKeyDoc {
  v: 1;
  kv: number;
  prev: Envelope | null;
  pairSpki: Uint8Array;
  pairPrivate: Envelope;
  /** 91-byte SPKI of team signing pair kv's public half. */
  signSpki: Uint8Array;
  /** Its private half, sealed under team key kv (`aadFor.teamSigningKey`). */
  signPrivate: Envelope;
  /** 64 bytes: signing pair kv-1's signature over this version's public keys, or null for kv 1. */
  sig: Uint8Array | null;
  /**
   * The device roster of version kv, sealed under team key kv (`aadFor.teamRoster`): every device
   * given key kv with its member and fingerprint, every active member's role, the recovery record's
   * keys, and the device that made the version (keys/roster.ts). At most MAX_ROSTER_BYTES of
   * ciphertext.
   */
  roster: Envelope;
  /** 64 bytes: the signature of the device that made version kv over the roster and this version's public keys. */
  rosterSig: Uint8Array;
}

/** `teams/{teamId}/recovery/current`: the team recovery code's record (spec 14 section 5.3). */
export interface RecoveryDoc {
  v: 1;
  /** The team key version it holds: always the newest. */
  kv: number;
  spki: Uint8Array;
  privateKey: Envelope;
  /** 91-byte SPKI of the recovery signing key, whose endorsement lets a device that used the code make the next key roster. */
  signSpki: Uint8Array;
  /** Its private half, sealed under the key derived from the code (`aadFor.recoverySigningKey`), `kv` 1. */
  signPrivate: Envelope;
  teamKey: PublicKeyWrap;
  check: Envelope;
  updatedBy: string;
  updatedAt: Date;
}

/**
 * `teams/{teamId}/keyGrants/{deviceId}`: the newest team key for one device, wrapped to it, with a
 * proof that a key holder made it and the approving device's signature.
 */
export interface KeyGrantDoc {
  v: 1;
  teamId: string;
  deviceId: string;
  /** The member the device belongs to. */
  uid: string;
  kv: number;
  wrap: PublicKeyWrap;
  /** The device's fingerprint sealed under team key `kv` (`aadFor.keyGrantProof`). */
  proof: Envelope;
  approverDeviceId: string;
  /** The approver's uid, as the server holds it. The signature does not cover it; see `TeamDevice.approvedBy`. */
  approverUid: string;
  /** 64 bytes: the approving device's signature over `keyGrantSignedBytes`. */
  signature: Uint8Array;
  /**
   * The approval code's MAC, on a grant made by approving a device's request: HMAC-SHA-256 under a
   * key derived from the code's random part, over team key `kv` and its public keys (see
   * crypto/approval.ts). A device with no pin for the team accepts its first grant only when it
   * checks. Its `kv` is the grant's own; a rotation that updates the grant removes it, and a device
   * that had not opened the grant yet asks again. Absent on a founder's and a recovery grant, which
   * the device makes for itself.
   */
  approval?: GrantApproval;
  /**
   * 64 bytes, on a grant a device made for itself with the recovery code only: the recovery signing
   * key's signature over this device, its member, its fingerprint and the grant's `kv`
   * (`recoveryEndorsementBytes` in keys/roster.ts). It is what lets that device make the team's next
   * key. A rotation that updates the grant removes it.
   */
  recoverySig?: Uint8Array;
  createdAt: Date;
  updatedAt: Date;
}

/** `approval` on a key grant. */
export interface GrantApproval {
  v: 1;
  /** The team key version the MAC covers, which is always the grant's `kv`. */
  kv: number;
  /** 32 bytes. */
  mac: Uint8Array;
}

/** `teams/{teamId}/keyRequests/{deviceId}`: a device asking for the team key. It holds no key. */
export interface KeyRequestDoc {
  uid: string;
  deviceId: string;
  createdAt: Date;
}

/** What happened to a claim, in the order it happened (spec 13 section 4.4: every step is recorded). */
export type ClaimHistoryKind =
  /** A team claimed the number. */
  | "claim"
  /** The holder asked a Horizon admin to verify it. */
  | "request"
  /** A Horizon admin verified it after a request. */
  | "verify"
  /** A Horizon admin declined a request; the number stays unverified. */
  | "decline"
  /** Another team claimed it too, which opened a dispute. */
  | "contest"
  /** A Horizon admin decided the dispute. */
  | "decision"
  /** The team that lost appealed, once. */
  | "appeal"
  /** A Horizon admin decided the appeal, which is final. */
  | "appeal-decision"
  /** The team that held the number was deleted, and the claim was kept with nobody holding it. */
  | "release";

/**
 * `claims/{teamNumber}/history/{index}`: one step of a claim's history, numbered from 0 in the order
 * it happened. Readable by the active members of `teamId` and `otherTeamId` and by Horizon admins,
 * and by nobody else (spec 13 section 4.4: the history is for the teams involved). Never changed.
 */
export interface ClaimHistoryEntry {
  kind: ClaimHistoryKind;
  /** The team the step is about: the claimant, the requester, the challenger, the appellant or the winner. */
  teamId: string;
  /**
   * The second team the step involves, or null: the holder a contest is against, the team that lost
   * a decision, the team that won the decision an appeal is against. A step read from before this
   * field existed has none, which means null.
   */
  otherTeamId?: string | null;
  by: string;
  /** The server's time of the step. */
  at: Date;
  disputeId?: string;
  requestId?: string;
  /** The reviewer's one-sentence reason, or the appeal's reason. */
  note?: string;
}

/**
 * `claims/{teamNumber}`: one per FTC team number. The id is the number as decimal digits. Anyone
 * signed in reads it; its history is in the `history` subcollection, which only the teams involved
 * read.
 */
export interface ClaimDoc {
  /**
   * The team that holds the number, or null when nobody does: the team that held it was deleted
   * while the claim had history of its own, so the claim was kept, detached, with a `release` step.
   * A team then claims the number afresh, unverified, once no review or request is open on it.
   */
  teamId: string | null;
  status: TeamStatus;
  claimedAt: Date;
  /** How many steps the history has; the next step's index. At least 1, the claim itself. */
  historyCount: number;
  /** The dispute under review, or null. While it is set, no second dispute can be opened. */
  disputeId?: string | null;
  /** The open verification request, or null. While it is set, the holder cannot ask again. */
  requestId?: string | null;
}

/**
 * What a team offers as evidence (spec 13 section 4.4): a `photo` of the robot or banner with the
 * claim's code on a card, an `event` result that lists the team, or a `statement`.
 *
 * Photos are not uploaded: the Spark backend has no Cloud Storage that ADR 0009 verified as free, so
 * a team hosts its photo wherever it likes and pastes an https address, with a summary.
 */
export type EvidenceKind = "photo" | "event" | "statement";

export const EVIDENCE_KINDS: readonly EvidenceKind[] = ["photo", "event", "statement"];

/** One piece of evidence as a team enters it. */
export interface EvidenceInput {
  kind: EvidenceKind;
  /** What it shows, in the team's words. 1 to 500 characters. */
  summary: string;
  /** An https address of the photo or the event result. Required for `photo` and `event`. */
  url?: string;
}

/** Evidence as stored on a verification request. */
export interface Evidence extends EvidenceInput {
  by: string;
  /** The client's clock (inside an array, so the server cannot stamp it). */
  at: Date;
}

export interface DisputeEvidence extends Evidence {
  /** The team that offered it: one of the dispute's two teams. */
  team: string;
}

export interface DisputeDecision {
  /** The team that gets the number. */
  winner: string;
  /** One sentence, shown to both teams. */
  reason: string;
  by: string;
  /** The server's time of the decision. */
  at: Date;
}

export interface DisputeAppeal {
  team: string;
  by: string;
  reason: string;
  /** The server's time of the appeal. */
  at: Date;
}

/**
 * Where a dispute is: `open` for review, `decided` (appealable for 14 days by the team that lost),
 * `appealed` waiting for a Horizon admin, any of them, and `final`.
 */
export type DisputeStatus = "open" | "decided" | "appealed" | "final";

/** `disputes/{disputeId}`: a review record both teams read. Only Horizon admins decide. */
export interface DisputeDoc {
  teamNumber: number;
  holderTeamId: string;
  challengerTeamId: string;
  openedBy: string;
  createdAt: Date;
  status: DisputeStatus;
  evidence: DisputeEvidence[];
  decision: DisputeDecision | null;
  appeal: DisputeAppeal | null;
  appealDecision: DisputeDecision | null;
}

export type VerificationVerdict = "verified" | "declined";

export interface VerificationDecision {
  verdict: VerificationVerdict;
  /** One sentence the team can read. */
  reason: string;
  by: string;
  /** The server's time of the decision. */
  at: Date;
}

/**
 * `verifications/{requestId}`: a team's request that a Horizon admin verify its number. Readable by
 * the team's active members and by Horizon admins; nobody else.
 */
export interface VerificationRequestDoc {
  teamNumber: number;
  teamId: string;
  requestedBy: string;
  createdAt: Date;
  status: "open" | "decided";
  evidence: Evidence[];
  decision: VerificationDecision | null;
}

/** How long after a decision the team that lost may appeal (spec 13 section 4.4). SPEC. */
export const APPEAL_WINDOW_DAYS = 14;

/** The most evidence rows one verification request carries. SET BY HAND: a guard, not a product rule. */
export const MAX_REQUEST_EVIDENCE = 6;

/** The most evidence entries one dispute collects from both teams. SET BY HAND: a guard. */
export const MAX_DISPUTE_EVIDENCE = 20;

/** The longest evidence summary or appeal reason. SET BY HAND: a guard against abuse. */
export const MAX_EVIDENCE_TEXT = 500;

/** The longest one-sentence decision reason. SET BY HAND. */
export const MAX_REASON_TEXT = 300;

/**
 * The longest `target` of an activity entry. SET BY HAND: every id the app writes there fits, the
 * longest being a revision id of at most 71 characters or a sign-in uid; cloud/firestore.rules says
 * what each entry holds.
 */
export const MAX_ACTIVITY_TARGET = 128;

/**
 * The longest plain-text `detail` of an activity entry. SET BY HAND: the longest the app writes is
 * the list of teams a share names, at most 8 ids of up to 64 characters joined by commas (519
 * characters). An `auto.create` entry's sealed title is capped by MAX_TITLE_CIPHERTEXT_BYTES instead.
 */
export const MAX_ACTIVITY_DETAIL = 600;

/**
 * What a Horizon admin's app records in the admin access log (spec 13 section 13: admin access is
 * "used only for reviews and support, and logged"): each read or decision on the `#/admin` page.
 */
export type AdminAction =
  /** Listed the review queue: every open verification request, dispute and appeal. */
  | "queue.list"
  /** Opened one item of the queue, reading its evidence and the claim's history. */
  | "queue.open"
  /** Listed every share of every team. */
  | "shares.list"
  /** Decided a verification request. */
  | "verification.decide"
  /** Decided a dispute. */
  | "dispute.decide"
  /** Decided an appeal. */
  | "appeal.decide"
  /** Listed every bug report. */
  | "reports.list"
  /** Changed a bug report's status (triaged or closed). */
  | "report.status"
  /** Listed the beta testers and the Horizon admins, and before 2026-10-03 the beta requests. */
  | "beta.list"
  /** Approved a beta request: added the tester and deleted the request. Not written since 2026-10-03. */
  | "beta.approve"
  /** Declined a beta request: deleted it. Not written since 2026-10-03. */
  | "beta.decline"
  /** Added a beta tester by their user code. */
  | "beta.add"
  /** Took a beta tester off the list. */
  | "beta.remove"
  /** Made someone a Horizon admin. */
  | "admin.add"
  /** Removed a Horizon admin, never oneself. */
  | "admin.remove";

export const ADMIN_ACTIONS: readonly AdminAction[] = [
  "queue.list",
  "queue.open",
  "shares.list",
  "verification.decide",
  "dispute.decide",
  "appeal.decide",
  "reports.list",
  "report.status",
  "beta.list",
  "beta.approve",
  "beta.decline",
  "beta.add",
  "beta.remove",
  "admin.add",
  "admin.remove",
];

/**
 * `adminLog/{entryId}`: one entry of the Horizon admin access log. Who, when, what, and the id it was
 * about; never what was read. Written only by Horizon admins, as themselves, at the server's time;
 * never changed or deleted; read only by Horizon admins.
 */
export interface AdminLogDoc {
  by: string;
  at: Date;
  action: AdminAction;
  /** The request, dispute, share, bug report or account the action was about, when it was about one. */
  target?: string;
}

// ------------------------------------------------------------ bug reports

/**
 * Where a bug report stands, as a Horizon admin marks it: `new` when sent, `triaged` once an admin has
 * read it and knows what to do, `closed` when nothing more will be done.
 */
export type BugReportStatus = "new" | "triaged" | "closed";

export const BUG_REPORT_STATUSES: readonly BugReportStatus[] = ["new", "triaged", "closed"];

/**
 * The setup a bug report carries, collected by the app and shown to the person before they send it.
 * It names no person, team, device, key, token or file path (spec 13 section 12): only the app's
 * version and surface, the browser and system reduced to name and major version, the window and
 * theme, the cloud mode, the open file's findings and the ids of the last actions run.
 */
export interface BugReportSetup {
  /** The Zenith version the app was built as, such as "0.1.1". */
  appVersion: string;
  surface: "web" | "desktop";
  /** True when another web app (DSIM) opened Zenith in host mode. */
  hostMode: boolean;
  /** Browser name and major version, such as "Chrome 131". */
  browser: string;
  /** System name and major version where the browser tells it, such as "Windows 10" or "macOS". */
  os: string;
  windowWidthPx: number;
  windowHeightPx: number;
  theme: "dark" | "light";
  cloudMode: "off" | "fake" | "firebase";
  /** The open file's findings, one "CODE: message" per line, or empty. */
  problems: string;
  /** The ids of the last actions run from the action registry, oldest first, comma separated, or empty. */
  recentActions: string;
}

/**
 * `bugReports/{reportId}`: a bug report a signed-in user sent to Horizon. Created only by its
 * reporter, with a profile and beta access, at the server's time and with status
 * `new`; read, marked and deleted only by Horizon admins. The reporter cannot read it back. Deleted
 * by the daily clean-up 30 days after it is closed or 90 days after it was sent, whichever is first,
 * and when the reporter's account is deleted.
 */
export interface BugReportDoc {
  reporter: string;
  createdAt: Date;
  status: BugReportStatus;
  /** What happened, in the reporter's words. Required. */
  whatHappened: string;
  /** What they expected instead, when they said. */
  expected?: string;
  /** How to make it happen again, when they said. */
  steps?: string;
  setup: BugReportSetup;
  /**
   * The open auto file as canonical JSON, only when the reporter ticked "Include a snapshot of my
   * auto file", with its `authors` removed and at most MAX_BUG_AUTO_FILE characters. The one
   * exception to "Horizon admins never see a team's paths" (owner ruling of 2026-09-30).
   */
  autoFile?: string;
  /** The Horizon admin who last changed the status, and when; absent until one does. */
  updatedBy?: string;
  updatedAt?: Date;
}

/** The longest "what happened". SET BY HAND: a guard against abuse, several paragraphs long. */
export const MAX_BUG_WHAT_HAPPENED = 4000;

/** The longest "what you expected". SET BY HAND: a guard against abuse. */
export const MAX_BUG_EXPECTED = 2000;

/** The longest "steps to reproduce". SET BY HAND: a guard against abuse. */
export const MAX_BUG_STEPS = 4000;

/** The longest one-line value of the setup block (version, browser, system). SET BY HAND. */
export const MAX_BUG_SETUP_TEXT = 80;

/** The longest findings list of the setup block. SET BY HAND: about 50 findings of full sentences. */
export const MAX_BUG_PROBLEMS = 8000;

/** The longest list of recent action ids. SET BY HAND: 20 ids of up to 60 characters, with commas. */
export const MAX_BUG_RECENT_ACTIONS = 1500;

/** The widest or tallest window the setup block records, in pixels. SET BY HAND: a guard. */
export const MAX_BUG_WINDOW_PX = 100_000;

/**
 * The most UTF-16 code units the attached auto file may hold. SET BY HAND: 200,000 units are at most
 * 600,000 bytes of UTF-8, which with the rest of the report (under 30,000 bytes) stays well under
 * Firestore's 1 MiB limit on a document; a real auto is a few kilobytes.
 */
export const MAX_BUG_AUTO_FILE = 200_000;

/**
 * The most team key versions a partner's key may have moved on since this device pinned it, for the
 * signatures between them to be read and checked one by one. SET BY HAND: a guard on reads; a team
 * rotates when someone leaves, so a hundred rotations between two shares is far beyond real use, and
 * a key further on is shown as "changed", for the safety codes to be compared.
 */
export const MAX_PARTNER_KEY_STEPS = 100;

/** The most teams one share can name (ADR 0009 section 4: the rules engine's read limit). */
export const MAX_SHARE_TEAMS = 8;

/**
 * The most bytes a share's projection may hold, and the most a proposal's diff may hold: of UTF-8
 * before it is sealed, which the client checks, and of ciphertext after (the gzip-compressed text and
 * the 16-byte tag), which the rules check too. SET BY HAND. Firestore keeps at most 1 MiB
 * (1,048,576 bytes) in one document, and everything else in a share or a proposal is under 15 KB,
 * so 1,000,000 bytes is the largest round number that always fits. Real projections are 3 to 13 KB
 * (spec 13 section 8.2); one built with every flat list at the schema's cap is about 886 KB, and the
 * largest proposal built the same way about 466 KB (test/sizeCaps.test.ts). cloud/firestore.rules
 * holds the same numbers and says why.
 */
export const MAX_SHARE_PROJECTION_BYTES = 1_000_000;
export const MAX_PROPOSAL_DIFF_BYTES = 1_000_000;

/**
 * The largest body of a share's manifest (`manifest.body` on `shares/{shareId}`), bytes: what the
 * client signs and what the rules check. SET BY HAND: eight teams with the longest ids the associated
 * data allows (128 characters), each with the largest key version and its key digest, and the
 * largest other versions and sequence numbers, with the share, owner, auto and revision ids as long,
 * the latest end, the signing device and eight terms signers, and a choice digest, come to 2,472
 * bytes (test/sizeCaps.test.ts); 2,560 is the next multiple of 256 and is small beside the
 * projection.
 */
export const MAX_SHARE_MANIFEST_BYTES = 2560;

/**
 * The most bytes of ciphertext one sealed field of a revision holds. SET BY HAND: Firestore's own
 * limit on a whole document, which the four sealed fields of a revision share.
 */
export const MAX_REVISION_FIELD_BYTES = 1_048_576;

/**
 * The most bytes of ciphertext an auto's sealed title holds, and the copy in its auto.create entry.
 * SET BY HAND: 200 UTF-16 code units are at most 600 bytes of UTF-8, at most about 625 after gzip,
 * and 641 with the tag.
 */
export const MAX_TITLE_CIPHERTEXT_BYTES = 1024;

/**
 * The most bytes of ciphertext a share's sealed `ownerChoice` holds. SET BY HAND: the web app's
 * choice, with an auto's title of 200 UTF-16 code units (at most 600 bytes of UTF-8), is under 700
 * bytes of text before it is compressed and sealed. Only the ciphertext is capped, so a title whose
 * characters JSON writes as escapes, and which compresses well, still fits.
 */
export const MAX_OWNER_CHOICE_BYTES = 1024;

/**
 * The most bytes of ciphertext a sealed private key holds: a team key pair's or the recovery key
 * pair's. SET BY HAND: WebCrypto's PKCS#8 for a P-256 key is 138 bytes, 154 with the tag.
 */
export const MAX_PRIVATE_KEY_BYTES = 256;

/**
 * The most bytes of ciphertext a team key version's sealed device roster holds. SET BY HAND: a roster
 * holds at most 500 members, 500 devices and 50 links (keys/roster.ts), which with the longest uids is
 * about 342 KB of JSON (test/sizeCaps.test.ts); half of Firestore's 1 MiB document limit holds that,
 * with room for the rest of the record.
 */
export const MAX_ROSTER_BYTES = 524_288;

/**
 * The most older share keys one share keeps in `prevKeys`, one per team taken off it. SET BY HAND: a
 * guard; 100 of them are about 10 KB stored.
 */
export const MAX_PREVIOUS_SHARE_KEYS = 100;

/** Spec 13 section 8.1 and the owner's answer 3: shares and invites expire after 7 days by default. */
export const DEFAULT_EXPIRY_S = 7 * 24 * 60 * 60;
