/**
 * The cloud client's public interface. The web and desktop apps talk only to `CloudBackend`; two
 * implementations exist: `FirebaseBackend` (the real service, with offline persistence) and
 * `MemoryBackend` (in memory, applying the same permission rules, for tests and UI work).
 *
 * Reads return plain objects. Writes apply locally at once and return a `Queued` value whose `sent`
 * promise settles when the server acknowledges or refuses the write (the outbox, spec 13 section 6).
 *
 * Content is end-to-end encrypted (spec 14). Titles, revisions, projections and diffs are sealed on
 * this device before they are written and opened after they are read, so every value here is plain
 * text and the stored documents (types.ts) hold only ciphertext. A call that needs a team key this
 * device does not hold yet fails with "no-key"; one that meets data that does not check out fails
 * with "tampered" and shows none of it.
 */
import type { BugReportInput } from "./bugReports.js";
import type { TeamNumberPin } from "./keys/trust.js";
import type { OutboxListener, OutboxStatus, Queued } from "./outbox.js";
import type {
  ActiveRole,
  ActivityDoc,
  AdminAction,
  AdminLogDoc,
  AutoDoc,
  BetaRequestDoc,
  BugReportDoc,
  BugReportStatus,
  ClaimDoc,
  ClaimHistoryEntry,
  DisputeAppeal,
  DisputeEvidence,
  DisputeDecision,
  DisputeDoc,
  EvidenceInput,
  InviteDoc,
  InviteRole,
  MemberDoc,
  ProposalDoc,
  RevisionDoc,
  ShareAudience,
  ShareDoc,
  ShareLevel,
  ShareMode,
  TeamDoc,
  TeamSettingsDoc,
  TimeRequestDoc,
  TimeRequestReason,
  UserDoc,
  VerificationDecision,
  VerificationRequestDoc,
} from "./types.js";

export type SignInProvider = "github" | "google" | "microsoft";

/** A bug report as a Horizon admin reads it, with its id. */
export interface BugReport extends BugReportDoc {
  id: string;
}

/** One entry of the Horizon admin access log, with its id. */
export interface AdminLogEntry extends AdminLogDoc {
  id: string;
}

/** A request for beta access left from before 2026-10-03, with the requester's uid (its id). */
export interface BetaRequest extends BetaRequestDoc {
  uid: string;
}

/** A person on the beta tester list, by uid. */
export interface BetaTester {
  uid: string;
  name: string;
}

/** A Horizon admin, by uid. An admin named in the console may have no name. */
export interface HorizonAdmin {
  uid: string;
  name: string | null;
}

/** What the review page's Beta access view lists. Horizon admins only. */
export interface BetaAccessLists {
  /** By name. */
  testers: BetaTester[];
  /** By name, unnamed last. */
  admins: HorizonAdmin[];
}

/**
 * A provider's credential from a sign-in the app ran itself, outside Firebase's popup: the desktop
 * app signs in through the system browser because the popup refuses its `zenith://` page (ADR 0011).
 * Each carries exactly what Firebase's `signInWithCredential` takes for that provider.
 */
export type NativeCredential =
  | { provider: "google"; idToken: string }
  | {
      provider: "microsoft";
      idToken: string;
      /** The nonce before hashing; the ID token's `nonce` claim is its SHA-256, which Firebase checks. */
      rawNonce: string;
    }
  | { provider: "github"; accessToken: string };

/** How Delete my account signs the person in again before it deletes anything. */
export interface DeleteAccountOptions {
  /**
   * Runs the sign-in for `provider`, the account's own, outside Firebase's popup and resolves with
   * its credential: the desktop app's route, whose page the popup refuses (ADR 0011). Without it,
   * the account signs in again in Firebase's popup. A rejection stops the delete before anything is
   * deleted.
   */
  reauthenticate?: (provider: SignInProvider) => Promise<NativeCredential>;
}

export interface CloudUser {
  uid: string;
  /** Kept with the sign-in record, never shown to other teams (spec 13 section 4.1). */
  email: string | null;
  /** The sign-in methods on the account, for example ["github.com"] or ["emailLink"]. */
  providerIds: string[];
}

export interface Team extends TeamDoc {
  id: string;
}

export interface Membership {
  teamId: string;
  role: MemberDoc["role"];
  /** Null when the team document is gone. */
  team: Team | null;
}

export type Member = MemberDoc;

export interface Invite extends InviteDoc {
  code: string;
}

/** A team as creating it returns it: with the recovery code to show once, print or save. */
export interface CreatedTeam extends Team {
  /**
   * The team recovery code, `ZNTH-XXXXX-XXXXX-XXXXX-XXXXX-XXXXXX` (spec 14 section 5.3). It is never
   * stored anywhere: show it once, with Print and "I have saved it".
   */
  recoveryCode: string;
}

export interface AutoRecord extends Omit<AutoDoc, "title" | "titleGen"> {
  id: string;
  teamId: string;
  /** The title, opened. */
  title: string;
}

/** A revision with its files opened. */
export interface Revision extends Omit<RevisionDoc, "content" | "robot" | "field" | "waypoints" | "gitSha"> {
  id: string;
  teamId: string;
  autoId: string;
  /** The commit the auto came from, when the project is a git repository. */
  gitSha?: string;
  /** The auto file in canonical form (spec 02), as JSON text. */
  content: string;
  /** The team's robot.json at publish time. */
  robot?: string;
  /** The field file at publish time. */
  field?: string;
  /** The waypoints file at publish time. */
  waypoints?: string;
}

/**
 * A share's settings without what it shows: what a Horizon admin sees (spec 14 section 0), and the
 * part of a share that needs no key.
 */
export interface ShareSummary extends Omit<ShareDoc, "projection" | "keyWraps" | "ownerWrap" | "linkWrap" | "prevKeys" | "manifest" | "ownerChoice"> {
  id: string;
}

/** A share with its projection opened. */
export interface Share extends ShareSummary {
  /** The projection (spec 13 section 8.2) as JSON text. */
  projection: string;
  /**
   * A link share, opened by the team that made it or by its link: the 22-character secret that
   * follows `#/s/` in the link. Absent for a share to teams.
   */
  linkSecret?: string;
  /**
   * The sharer's choices for the projection (`CreateShareInput.ownerChoice`), opened by the team
   * that made the share and by nobody else. Absent when the share has none, or for another team.
   */
  ownerChoice?: string;
}

/** A proposal with its diff opened. */
export interface Proposal extends Omit<ProposalDoc, "diff" | "ownerWrap" | "fromWrap" | "sig"> {
  id: string;
  /** The proposed change as JSON text (`core.diff`). */
  diff: string;
}

/** A request for more time on a share (spec 13 section 8.4). Its id is its `teamId`. */
export type TimeRequest = TimeRequestDoc;

/**
 * A share made to a team that the team can no longer open: it ended, was revoked, or the team that
 * made it was deleted. The rules do not say which, since a recipient reads a share only while it is
 * live; the pointer in the team's inbox is what remains.
 */
export interface EndedShare {
  shareId: string;
  ownerTeamId: string;
  /** When the share was made to the team. */
  receivedAt: Date;
}

/**
 * Why a team's own share stopped when the team key changed:
 * - `device-removed`: it was made, or its terms last changed, on a device the team then removed (a
 *   member taken off the team, or a device the team took the key from);
 * - `not-listed`: every device that signed it is still on the team, but the device that changed the
 *   key did not list it, for example because the database did not show it then.
 */
export type StoppedShareReason = "device-removed" | "not-listed";

/**
 * A share the team made that stopped when its key changed: its manifest is signed with an older team
 * key, and the newest device roster neither lists it nor holds every device that signed it, so the
 * team's devices seal nothing new into it and refuse to change it (`SHARE_NOT_LISTED`). It is not
 * revoked and has not ended. Every term here is read from its manifest, which the team's own key of
 * that older version signed, so the database cannot choose them; the database can at most leave a
 * stopped share out. The team shares the auto again to go on sharing it.
 */
export interface StoppedShare {
  id: string;
  ownerTeamId: string;
  autoId: string;
  audience: ShareAudience;
  /** The teams the manifest names; empty for a link share. */
  teamIds: string[];
  level: ShareLevel;
  mode: ShareMode;
  /** The revision the manifest names: the pinned one, or the last one a following share got. */
  revision: string;
  /** The end the manifest signs. After now. */
  expiresAt: Date;
  /** When the share was made, as the database stamped it: for ordering and display only. */
  createdAt: Date;
  reason: StoppedShareReason;
}

/**
 * A share made to the team that this device refuses because its manifest is signed with an older
 * key of the sharing team than one this device has seen (`SHARE_SIGNED_WITH_OLDER_KEY`): nothing of
 * it is opened, so all that is known is its id and the team the database says made it. It opens
 * again once a device of that team carries it forward to its newer key (`carryForwardShares`); a
 * share that team stopped at the key change, or one someone it took off made, stays here.
 */
export interface WaitingShare {
  id: string;
  /** The team the database says made the share: its word alone, since nothing of the share was opened. */
  ownerTeamId: string;
}

/** What one run of `carryForwardShares` did, by share id. */
export interface CarriedShares {
  /** The shares signed again at the team's newest key, under a new share key. */
  carried: string[];
  /**
   * The shares the newest roster lists that are still signed with an older key and that this run
   * could not carry: this device may not write them, a partner's key needs a person to check it, or
   * the database refused the write. A later run, on this device or another, tries them again.
   */
  left: string[];
}

export interface RequestMoreTimeInput {
  shareId: string;
  /** The asking team: the signed-in member's, and one the share was made to. */
  teamId: string;
  reason?: TimeRequestReason;
  /** The end the team would like; the sharing team picks the real one. After now. */
  wantedUntil?: Date;
}

/** Granting extends the share to `expiresAt` in the same write; declining changes only the request. */
export type TimeRequestDecision = { status: "granted"; expiresAt: Date } | { status: "declined" };

export interface ActivityEntry extends Omit<ActivityDoc, "detail"> {
  id: string;
  /** The detail as text; an `auto.create` entry's title is opened, and left out when it cannot be. */
  detail?: string;
}

/** The public part of a claim, which anyone signed in reads. */
export interface ClaimRecord extends ClaimDoc {
  teamNumber: number;
}

export interface Claim extends ClaimRecord {
  /**
   * The steps of the claim's history the caller may read, oldest first: for `getClaim(n, teamId)`,
   * the steps that involve that team; for a Horizon admin without a team, every step; otherwise none.
   */
  history: ClaimHistoryEntry[];
}

export interface Dispute extends DisputeDoc {
  id: string;
}

export interface VerificationRequest extends VerificationRequestDoc {
  id: string;
}

/** What claiming a number did: took a free number, or contested an unverified one. */
export type ClaimOutcome =
  | { outcome: "claimed"; claim: Claim }
  | { outcome: "contested"; dispute: Dispute };

/** A Horizon admin's work (spec 13 section 4.4). Oldest first, so the longest-waiting comes first. */
export interface ReviewQueue {
  /** Open requests for verification. */
  requests: VerificationRequest[];
  /** Open disputes. */
  disputes: Dispute[];
  /** Appealed disputes, the ones the caller decided first included: one admin may decide an appeal alone. */
  appeals: Dispute[];
}

/** A reviewer's decision on a dispute or an appeal: the team that gets the number, and why. */
export type DisputeDecisionInput = Pick<DisputeDecision, "winner" | "reason">;

export interface TeamSettings {
  editorsMayProposeShare: boolean;
  editorsMayLinkShare: boolean;
  publishOnSave: boolean;
  /** Any active member may give the team key to another member's new device. Default false. */
  membersMayApproveDevices: boolean;
}

// ------------------------------------------------------------ keys (spec 14)

/** This device, as the key screens show it. */
export interface ThisDevice {
  /** 22 characters: the first 128 bits of the fingerprint of its public keys. */
  deviceId: string;
  /** Its verification code, five groups of four digits, which an approver compares. */
  code: string;
}

/**
 * Where this device stands with a team's key:
 * - `ready`: it holds the newest key. `rotationPending` asks an owner or admin to rotate it
 *   (`completeKeyRotation`) after a member left or a device was taken off: the server's mark, or what
 *   this device works out from the newest roster. Until then nothing new is sealed under the key.
 * - `waiting`: an owner, an admin or another of the member's devices must approve it first, by
 *   typing its `approvalCode`. `requested` says whether it has asked (`requestTeamKey`).
 */
export type TeamKeyStatus =
  | {
      state: "ready";
      /** The newest team key version. */
      keyVersion: number;
      rotationPending: boolean;
      /** The team safety code, which two teams compare (spec 14 section 4.6). */
      safetyCode: string;
      device: ThisDevice;
    }
  | {
      state: "waiting";
      requested: boolean;
      /** The team's setting: any active member may approve a device. */
      membersMayApproveDevices: boolean;
      /**
       * The code the approver types, `XXXXXX-XXXXXX-XXXXXX` (18 Crockford base32 characters): the
       * last 8 are a random secret, kept on this device only and never sent to the server, and the
       * first 10 a hash of the team, the member, that secret and this device's public keys. Shown
       * until a grant is accepted or the request withdrawn.
       */
      approvalCode: string;
      /**
       * False when this browser could not save the approval code's secret (its storage is full or
       * turned off): the code lasts for this session only, so a later session shows a new one and
       * needs approving again.
       */
      savedOnDevice: boolean;
      device: ThisDevice;
    };

/** A device waiting for the team key, as the people who may approve it see it. */
export interface KeyRequest {
  deviceId: string;
  uid: string;
  /** The member's display name in the team. */
  displayName: string;
  /** A new member's first device, or another device of a member already active. */
  kind: "member" | "device";
  /** The device's verification code, from its public keys, to compare with the code on its screen. */
  code: string;
  requestedAt: Date;
  /** The request is from a device of the signed-in user. */
  isYours: boolean;
  /**
   * False when no device record under the member's name matches the request's device id: the
   * record is missing, or its keys give another id. Such a request cannot be granted. It is how a
   * member who puts a request at a teammate's device id before that device asks would block it, so
   * owners and admins see it, to delete it with `declineKeyRequest`; nobody else is shown it.
   */
  matchesDevice: boolean;
}

/** A device that holds a team's key. */
export interface TeamDevice {
  deviceId: string;
  uid: string;
  displayName: string;
  /** The team key version it holds. */
  keyVersion: number;
  code: string;
  isThisDevice: boolean;
  /**
   * The uid the server gives as the member who approved it most recently (a rotation re-approves
   * every device). A server claim: nothing a key holder signs binds it, so it is shown as who the
   * server says approved the device, never as proof.
   */
  approvedBy: string;
  approvedAt: Date;
}

/**
 * How a partner team's public key compares with the one this device used for it before (trust on
 * first use, spec 14 section 4.6): see `PartnerKeyStatus` in keys/trust.ts. `changed` and `older`
 * make `createShare` refuse with "key-changed" unless the team is in `acceptKeyChanges`;
 * `member-key-differs` makes it refuse with "key-changed" whatever the answers say.
 */
export interface PartnerKeyCheck {
  teamId: string;
  status: "first-use" | "same" | "rotated" | "changed" | "older" | "member-key-differs";
  keyVersion: number;
  /** The team's safety code for the key it shows now, to compare with that team. */
  safetyCode: string;
  /**
   * That key named exactly: its version, fingerprint and signing key (`teamKeyId` in keys/trust.ts).
   * A share made after the person was shown `safetyCode` passes it back in `expectedKeys`, so the
   * share is wrapped to this key or not made at all.
   */
  keyId: string;
}

/**
 * A partner team's safety code as this device knows it (`teamSafetyCode`). The server can show any
 * key it likes, so the code shown is of the key this device pinned for the team, or of a newer one
 * the team signed from it; only with no pin yet is it of the key the server shows now.
 */
export interface KnownSafetyCode {
  safetyCode: string;
  /**
   * True for a pin this device checked (`PartnerPinTrust` in keys/trust.ts). False when this device
   * has no pin for the team yet, so the code is of the key the server shows now, and false too for a
   * pin only trusted on first use, such as the one opening a share received from the team writes:
   * the code is then of that key, to compare with the team, but nobody on this device compared it.
   */
  pinned: boolean;
  /**
   * True when the server now shows a key that is neither the pinned one nor a rotation the team signed
   * from it. `safetyCode` is then still the pinned key's code, not the key the server shows.
   */
  serverKeyDiffers: boolean;
  /**
   * Set when `safetyCode` is of a newer key than the first one this device trusted for the team, and
   * the server shows that newer key: the team replaced its key since this device first met it, by a
   * rotation it signed with the key before. Opening a received share only moves a pin forward along
   * such signatures, so for a team this device has only received from, the code changed because the
   * team replaced its key. Absent when the key is still the first one, or when `serverKeyDiffers`.
   */
  keyReplaced?: true;
}

export interface CreateInviteInput {
  role: InviteRole;
  /** Default 7 days (spec 13 section 8.1). */
  expiresInS?: number;
  /** Default 1: single-use (spec 13 section 13). */
  maxUses?: number;
  /** Default false: new members wait for an admin's approval. */
  autoApprove?: boolean;
}

export interface PublishInput {
  teamId: string;
  autoId: string;
  /** The revision id the auto was edited from, or null for the first revision. */
  baseRevision: string | null;
  /** The auto in canonical form, as a JSON string. */
  content: string;
  robot?: string;
  field?: string;
  waypoints?: string;
  gitSha?: string;
  /**
   * The projection of this revision, built by `core` on this device. When given, every live share
   * of this auto that follows the latest version moves to the new revision in the same write.
   */
  followProjection?: string;
}

export interface CreateShareInput {
  teamId: string;
  autoId: string;
  revision: string;
  audience: ShareAudience;
  /** The receiving teams, 1 to 8, for audience "teams"; omitted or empty for "link". */
  teamIds?: string[];
  /** Default "view". */
  level?: ShareLevel;
  /** Default "pinned". */
  mode?: ShareMode;
  /** Default 7 days from now. */
  expiresAt?: Date;
  /** The projection as a JSON string (spec 13 section 8.2), built on this device. */
  projection: string;
  /**
   * Teams whose key is `changed` or `older` (`checkPartnerKeys`) that the person chose to trust
   * after comparing their safety code. Without it, such a team makes the share fail with "key-changed".
   * It counts only for a team whose key is also named in `expectedKeys`: what is trusted is the key
   * that was shown, never whatever the server shows by the time the share is made.
   */
  acceptKeyChanges?: string[];
  /**
   * For each team whose safety code the person was shown before this share, by team id, the `keyId`
   * of the key that code was of (`checkPartnerKeys`). A team whose key is not that one when the share
   * key is wrapped stops the share with "key-changed", and nothing is pinned.
   */
  expectedKeys?: Record<string, string>;
  /**
   * The choices the sharer made when building `projection` (how coarse it is, whether it names its
   * commands), as text of the caller's own form, at most MAX_OWNER_CHOICE_BYTES. It is sealed under
   * the sharing team's key, so only that team reads it back, and every rebuild of the projection
   * takes it from there rather than from the projection, which each team the share is made to can
   * seal again.
   */
  ownerChoice?: string;
}

/** What the person decided about partner keys before a share key is wrapped to them. */
export type PartnerKeyAnswers = Pick<CreateShareInput, "acceptKeyChanges" | "expectedKeys">;

export interface SendProposalInput {
  shareId: string;
  fromTeamId: string;
  baseRevision: string;
  /** The proposed change as a JSON string (`core.diff`). */
  diff: string;
}

/**
 * Everything Zenith holds about the signed-in user that they can read (spec 13 section 12.3): the
 * profile and memberships, and what they wrote in the teams they are an active member of. Records in a
 * team they left, or are still waiting to join, are the team's and cannot be read back; `notIncluded`
 * says in sentences what the database's rules kept out of this export.
 */
export interface MyDataExport {
  /** When the export was made, by this device's clock. */
  exportedAt: Date;
  uid: string;
  profile: UserDoc | null;
  memberships: Member[];
  /** Their entries in the activity logs of teams where they are an owner or admin. */
  activity: (ActivityEntry & { teamId: string })[];
  /** Revisions they published, with the auto's content. */
  revisions: Revision[];
  /** Shares they made, with the projection each one shows. */
  shares: Share[];
  /** Proposals they sent. */
  proposals: Proposal[];
  /** Requests for verification they made, with their evidence and the reviewer's decision. */
  verificationRequests: VerificationRequest[];
  /** Reviews of a team number they opened. */
  disputesOpened: Pick<Dispute, "id" | "teamNumber" | "holderTeamId" | "challengerTeamId" | "createdAt" | "status">[];
  /** Evidence they added to a review. */
  disputeEvidence: (DisputeEvidence & { disputeId: string; teamNumber: number })[];
  /** Appeals they wrote. */
  appeals: (DisputeAppeal & { disputeId: string; teamNumber: number })[];
  /** Steps of team-number histories they made. */
  claimHistory: (ClaimHistoryEntry & { teamNumber: number })[];
  /**
   * The request for beta access they sent before asking was removed on 2026-10-03, until the daily
   * clean-up deletes it; null when there is none.
   */
  betaRequest: BetaRequest | null;
  /** What the export could not include, and why, one sentence each. Empty when nothing was left out. */
  notIncluded: string[];
  /**
   * Sentences about what the export holds that the person should know, such as that a share's
   * `linkSecret` is their own working link secret. Absent when there is nothing to say.
   */
  notes?: string[];
}

export interface CloudBackend {
  readonly kind: "firebase" | "memory";

  // ------------------------------------------------------------ session (spec 13 section 4.1)

  currentUser(): CloudUser | null;
  onAuthChange(listener: (user: CloudUser | null) => void): () => void;
  signInWithProvider(provider: SignInProvider): Promise<CloudUser>;
  /** Signs in with a credential the app got from the provider itself, with no popup (ADR 0011). */
  signInWithNativeCredential(credential: NativeCredential): Promise<CloudUser>;
  /** Sends a sign-in link to `email` that opens `continueUrl`. */
  sendSignInLink(email: string, continueUrl: string): Promise<void>;
  isSignInLink(url: string): boolean;
  completeSignInLink(email: string, url: string): Promise<CloudUser>;
  /** Signs out and clears the offline cache (spec 13 section 6). */
  signOut(): Promise<void>;

  // ------------------------------------------------------------ profile (spec 13 section 4.1)

  getProfile(): Promise<UserDoc | null>;
  /** Makes the profile with this display name, or changes the name of the one there is. */
  saveProfile(input: { displayName: string }): Promise<Queued<UserDoc>>;
  exportMyData(): Promise<MyDataExport>;
  /**
   * Signs the person in again with the account's own provider, then leaves every team, deletes the
   * profile and then the sign-in account. Refused for an owner.
   */
  deleteAccount(options?: DeleteAccountOptions): Promise<void>;

  // ------------------------------------------------------------ teams (spec 13 sections 4.2, 4.3)

  /**
   * Creates the team with its keys in one write: team key 1, this device's grant and the recovery
   * record. The result carries the recovery code, which is shown once and never stored.
   */
  createTeam(input: { number: number | null; name: string }): Promise<Queued<CreatedTeam>>;
  getTeam(teamId: string): Promise<Team | null>;
  findTeamByNumber(teamNumber: number): Promise<Team | null>;
  listMyTeams(): Promise<Membership[]>;
  renameTeam(teamId: string, name: string): Promise<Queued<void>>;
  /**
   * Owner only. Revokes every share the team made that is not revoked yet, then deletes the team.
   * The team's revisions stay stored, readable by nobody, until an admin purges them.
   */
  deleteTeam(teamId: string): Promise<Queued<void>>;
  listMembers(teamId: string): Promise<Member[]>;
  setRole(teamId: string, uid: string, role: ActiveRole): Promise<Queued<void>>;
  /**
   * Gives a pending member the role their invite offered and, in the same write, the team key to the
   * one device `deviceId` they asked from, whose `approvalCode` the approver typed from its screen.
   * Throws "wrong-code" when the code is not that device's. This device must hold the newest team key.
   */
  approveMember(teamId: string, uid: string, input: { deviceId: string; approvalCode: string }): Promise<Queued<void>>;
  /**
   * Removes a member and rotates the team key in the same write, so they cannot open anything made
   * after. When this device cannot rotate (it is waiting for the key), the member is removed, their
   * grants are deleted and the team is marked "rotation pending".
   */
  removeMember(teamId: string, uid: string): Promise<Queued<void>>;
  /** Leaves the team, deleting this member's grants and key requests, and marks the key "rotation pending". */
  leaveTeam(teamId: string): Promise<Queued<void>>;
  getTeamSettings(teamId: string): Promise<TeamSettings>;
  updateTeamSettings(teamId: string, patch: Partial<TeamSettingsDoc>): Promise<Queued<void>>;
  /** Newest first. Owners and admins only. */
  listActivity(teamId: string): Promise<ActivityEntry[]>;

  // ------------------------------------------------------------ invites

  createInvite(teamId: string, input: CreateInviteInput): Promise<Queued<Invite>>;
  getInvite(code: string): Promise<Invite | null>;
  /**
   * Joins the invite's team, as pending unless the invite approves automatically, and asks for the
   * team key for this device in the same write. Even an automatic approval gets the key only when a
   * key holder grants it (spec 14 section 4.3).
   */
  redeemInvite(code: string): Promise<Queued<Member>>;
  extendInvite(code: string, expiresAt: Date): Promise<Queued<void>>;
  revokeInvite(code: string): Promise<Queued<void>>;
  /** Every invite the team has made, found through its activity log. Owners and admins only. */
  listInvites(teamId: string): Promise<Invite[]>;

  // ------------------------------------------------------------ team library (spec 13 section 5)

  createAuto(teamId: string, input: { title: string }): Promise<Queued<AutoRecord>>;
  listAutos(teamId: string): Promise<AutoRecord[]>;
  /** Adds a revision; never overwrites one. A publish from a stale base is marked diverged. */
  publishRevision(input: PublishInput): Promise<Queued<Revision>>;
  /**
   * Oldest first. `diverged` is true for a revision the publisher marked, and for every revision
   * with an earlier sibling on the same base (two members who published from one base offline).
   */
  listRevisions(teamId: string, autoId: string): Promise<Revision[]>;
  openRevision(teamId: string, autoId: string, revisionId: string): Promise<Revision | null>;
  /** Fetches every auto, revision and received share of the team so they open offline. */
  saveForOffline(teamId: string): Promise<void>;

  // ------------------------------------------------------------ sharing (spec 13 section 8)

  createShare(input: CreateShareInput): Promise<Queued<Share>>;
  /**
   * Null when it does not exist, has expired, was revoked, or the caller may not open it. `asTeamId`
   * says which of the caller's teams opens it: the team that made it, or one it was made to. Without
   * it, the owner team is tried, then each team the share names. A link share is opened here only by
   * the team that made it; anyone else opens it with its secret (`openLinkShare`).
   */
  getShare(shareId: string, asTeamId?: string): Promise<Share | null>;
  /**
   * The link share whose link carries `secret` (the 22 characters after `#/s/`), opened. Works signed
   * out. Null when it does not exist, has ended, was revoked, or the secret is not a link secret.
   */
  openLinkShare(secret: string): Promise<Share | null>;
  /** Every share the team has made, live or not. */
  listTeamShares(teamId: string): Promise<Share[]>;
  /**
   * The team's shares that stopped when its key changed (`StoppedShare`), newest first, and not
   * revoked or ended. `listTeamShares` leaves them out. Members who hold the team key.
   */
  listStoppedShares(teamId: string): Promise<StoppedShare[]>;
  /** The live shares made to the team. */
  listReceivedShares(teamId: string): Promise<Share[]>;
  /**
   * The live shares made to the team that this device refuses as signed with an older key of the
   * sharing team than it has seen (`WaitingShare`), by id. `listReceivedShares` leaves them out.
   */
  listWaitingShares(teamId: string): Promise<WaitingShare[]>;
  /**
   * Signs again, with the team's newest key and under a new share key, each of the team's shares
   * to teams that the newest device roster lists but whose manifest an older key signed, so a
   * partner that has seen the newer key opens it again. A share the rotation stopped, one revoked
   * or ended, and link shares are left alone. The writes go in groups of at most
   * `CARRY_FORWARD_SHARES_PER_WRITE`. The device that changes the key runs it once the change is
   * stored; any device of the team may run it again, which finishes an interrupted run.
   */
  carryForwardShares(teamId: string): Promise<CarriedShares>;
  extendShare(shareId: string, expiresAt: Date): Promise<Queued<void>>;
  revokeShare(shareId: string): Promise<Queued<void>>;
  setShareLevel(shareId: string, level: ShareLevel): Promise<Queued<void>>;
  setShareMode(shareId: string, mode: ShareMode): Promise<Queued<void>>;
  /** "Update share": moves a share to a newer revision with its new projection. */
  updateShare(shareId: string, input: { revision: string; projection: string }): Promise<Queued<void>>;
  /**
   * Changes which teams a share to teams is made to. Adding teams wraps the share key to them. Taking
   * a team off gives the share a new key, sealed so the teams left and the owner still read older
   * proposals, and re-seals the projection, so the team taken off gets nothing new (spec 14 section
   * 4.6). `acceptKeyChanges` and `expectedKeys` are as for `createShare`.
   */
  setShareTeams(shareId: string, teamIds: string[], options?: PartnerKeyAnswers): Promise<Queued<void>>;

  // ------------------------------------------------------------ proposals (spec 13 section 14)

  sendProposal(input: SendProposalInput): Promise<Queued<Proposal>>;
  listProposals(teamId: string, direction: "received" | "sent"): Promise<Proposal[]>;
  decideProposal(proposalId: string, decision: "accepted" | "rejected"): Promise<Queued<void>>;
  withdrawProposal(proposalId: string): Promise<Queued<void>>;

  // ------------------------------------------------------------ more time (spec 13 section 8.4)

  /**
   * Asks the team that made a share for more time on it, for `teamId`, a team the share was made to.
   * Any active member may ask, before or after the share ends, but not once it was revoked. A team
   * has one request per share; asking again after a decision replaces it, and asking while one is
   * open is refused.
   */
  requestMoreTime(input: RequestMoreTimeInput): Promise<Queued<TimeRequest>>;
  /** "received": the requests on the team's own shares; "sent": the team's own. Newest first. */
  listTimeRequests(teamId: string, direction: "received" | "sent"): Promise<TimeRequest[]>;
  /**
   * Grants an open request, extending the share to `expiresAt` in the same write, or declines it.
   * The sharing team's owners and admins, or the editor who made the share.
   */
  decideTimeRequest(shareId: string, teamId: string, decision: TimeRequestDecision): Promise<Queued<void>>;
  /** The shares made to the team that it can no longer open, newest first. Active members. */
  listEndedShares(teamId: string): Promise<EndedShare[]>;

  // ------------------------------------------------------------ team numbers (spec 13 section 4.4)

  /**
   * The public claim on a number (holder, status, open review or request), or null when unclaimed,
   * with the history steps that involve `forTeamId`. Without a team, a Horizon admin gets every step
   * and anyone else none (spec 13 section 4.4: the history is for the teams involved).
   */
  getClaim(teamNumber: number, forTeamId?: string): Promise<Claim | null>;
  /**
   * Claims a number for a team that has none. A free number is claimed at once. A verified number is
   * refused with a sentence saying how to ask for a review. An unverified one is contested: both
   * claims show as contested and a dispute opens for a Horizon admin. Team owners and admins only.
   */
  claimNumber(teamId: string, teamNumber: number): Promise<Queued<ClaimOutcome>>;
  /** Asks a Horizon admin to verify the team's unverified number, with 1 to 6 pieces of evidence. */
  requestVerification(teamId: string, evidence: EvidenceInput[]): Promise<Queued<VerificationRequest>>;
  /** The team's requests for verification, newest first. Active members only. */
  listVerificationRequests(teamId: string): Promise<VerificationRequest[]>;
  /**
   * Opens a review of a claimed number for a team with none. An unverified claim becomes contested in
   * the same write; a verified one stays verified while it is reviewed. `claimNumber` calls this for
   * an unverified number; call it directly to ask for a review of a verified one.
   */
  openDispute(input: { teamNumber: number; challengerTeamId: string }): Promise<Queued<Dispute>>;
  /** Adds evidence while the dispute waits for a reviewer. Either team's owners and admins. */
  addDisputeEvidence(disputeId: string, evidence: EvidenceInput & { team: string }): Promise<Queued<void>>;
  /** The one appeal, by the team that lost, within 14 days of the decision. */
  appealDispute(disputeId: string, appeal: { team: string; reason: string }): Promise<Queued<void>>;
  /** Null when it does not exist or the caller is neither one of its teams nor a Horizon admin. */
  getDispute(disputeId: string): Promise<Dispute | null>;
  /** The disputes the team is in, newest first. */
  listDisputes(teamId: string): Promise<Dispute[]>;

  // ------------------------------------------------------------ Horizon admins

  isHorizonAdmin(): Promise<boolean>;
  /**
   * Whether the signed-in user may join Zenith during the private beta: the owner has named them in
   * `betaTesters/{uid}`, they are a Horizon admin, or `config/access` has `betaOpen: true`. The rules
   * refuse a new profile and an invite redemption to anyone else; false when nobody is signed in.
   * The fake cloud's beta is open unless its database was made with `betaGate: "closed"`.
   */
  hasBetaAccess(): Promise<boolean>;
  /** Everything waiting for a reviewer. Horizon admins only. */
  listReviewQueue(): Promise<ReviewQueue>;
  /** Verifies or declines a request, with a one-sentence reason the team reads. Horizon admins only. */
  decideVerification(requestId: string, decision: Pick<VerificationDecision, "verdict" | "reason">): Promise<Queued<void>>;
  /** Gives the number to one of the two teams, with a one-sentence reason both read. Horizon admins only. */
  decideDispute(disputeId: string, decision: DisputeDecisionInput): Promise<Queued<void>>;
  /** Decides the appeal, finally. Any Horizon admin, the one who made the first decision included. */
  decideAppeal(disputeId: string, decision: DisputeDecisionInput): Promise<Queued<void>>;
  /**
   * Every share of every team, live, expired or revoked, by its settings only and never what it
   * shows, newest first: the admin dashboard's All shares list (spec 13 section 13, spec 14 section 0). Horizon admins only; anyone else gets
   * "permission-denied". Read only: an admin changes a share only through a team role.
   */
  listAllShares(): Promise<ShareSummary[]>;
  /**
   * Adds one entry to the Horizon admin access log: `action`, about `target` when there is one, by
   * the signed-in admin at the server's time (spec 13 section 13). The admin page calls it for each
   * read; the decisions write their own entry in the same write. Anyone else is refused.
   */
  recordAdminAccess(action: AdminAction, target?: string): Promise<Queued<void>>;
  /** The admin access log, newest first. Horizon admins only. */
  listAdminLog(): Promise<AdminLogEntry[]>;
  /**
   * The beta testers and the Horizon admins, for the review page's Beta access view (owner rulings
   * 2026-10-02 and 2026-10-03). Horizon admins only; anyone else gets "permission-denied".
   */
  listBetaAccess(): Promise<BetaAccessLists>;
  /**
   * Adds a beta tester by user code and name, and deletes any request for access they sent before
   * 2026-10-03, in one write with its admin log entry. "conflict" when they are already on the list.
   * Horizon admins only.
   */
  addBetaTester(input: { uid: string; name: string }): Promise<Queued<void>>;
  /** Takes a tester off the list, in one write with its admin log entry. Horizon admins only. */
  removeBetaTester(uid: string): Promise<Queued<void>>;
  /**
   * Makes someone a Horizon admin by user code and name, and deletes any beta request they sent
   * before 2026-10-03, in one write with its admin log entry. "conflict" when they already are one. Horizon admins only.
   */
  addHorizonAdmin(input: { uid: string; name: string }): Promise<Queued<void>>;
  /**
   * Removes a Horizon admin, in one write with its admin log entry. Never oneself, so no admin locks
   * themselves out: "invalid" for the caller's own uid. Horizon admins only.
   */
  removeHorizonAdmin(uid: string): Promise<Queued<void>>;

  // ------------------------------------------------------------ bug reports

  /**
   * Sends a bug report to Horizon, privately: only Horizon admins read it, and the reporter cannot
   * read it back. Needs a signed-in user with a profile. Throws "invalid" with a sentence when
   * `bugReportProblem` finds one. The result carries the new report's id.
   */
  sendBugReport(input: BugReportInput): Promise<Queued<{ id: string }>>;
  /** Every bug report, newest first. Horizon admins only; anyone else gets "permission-denied". */
  listBugReports(): Promise<BugReport[]>;
  /**
   * Marks a bug report triaged, closed or new again, and records it in the admin access log in the
   * same write. Horizon admins only.
   */
  setBugReportStatus(reportId: string, status: BugReportStatus): Promise<Queued<void>>;

  // ------------------------------------------------------------ keys (spec 14)

  /** This device's id and verification code, registering its public keys when it has not yet. */
  thisDevice(): Promise<ThisDevice>;
  /** Where this device stands with the team's key. Throws "tampered" when the team's keys do not check out. */
  teamKeyStatus(teamId: string): Promise<TeamKeyStatus>;
  /** Asks for the team key for this device (a new member's first device, or a new device of theirs). */
  requestTeamKey(teamId: string): Promise<Queued<void>>;
  /**
   * The devices waiting for the team key that the caller may approve: every one for owners and admins,
   * and for any active member when the team allows it; otherwise the caller's own.
   */
  listKeyRequests(teamId: string): Promise<KeyRequest[]>;
  /**
   * Which of `uid`'s waiting devices the typed `approvalCode` is for: the id of the one key request
   * whose device record the code matches, or null when it matches none. A code is bound to one
   * device, team and member, so an approver can type it without choosing the device first.
   */
  keyRequestForCode(teamId: string, uid: string, approvalCode: string): Promise<string | null>;
  /**
   * Gives the newest team key to the device that asked, signed by this device, and deletes the
   * request. `approvalCode` is the code on that device's screen, as typed; "wrong-code" when it is
   * not that device's. For a pending member, use `approveMember`, which sets the role too.
   */
  grantDeviceKey(teamId: string, deviceId: string, approvalCode: string): Promise<Queued<void>>;
  /** Deletes a key request without granting it. */
  declineKeyRequest(teamId: string, deviceId: string): Promise<Queued<void>>;
  /** The devices that hold the team key: every one for owners and admins, otherwise the caller's own. */
  listTeamDevices(teamId: string): Promise<TeamDevice[]>;
  /**
   * Takes the team key from a device. An owner or admin rotates the key in the same write; a member
   * revoking a device of their own deletes its grant and marks the key "rotation pending".
   */
  revokeDevice(teamId: string, deviceId: string): Promise<Queued<void>>;
  /** Rotates the team key after a member left ("rotation pending"). Owners and admins. */
  completeKeyRotation(teamId: string): Promise<Queued<void>>;
  /**
   * Unlocks the team on this device with the printed recovery code, when every device that held the
   * key is gone (spec 14 section 5.2): this device grants itself the key, and the activity log
   * records it. The caller must be an active member.
   */
  useRecoveryCode(teamId: string, code: string): Promise<Queued<void>>;
  /** Makes a new recovery code, which replaces the old one. Owners only; the result is shown once. */
  replaceRecoveryCode(teamId: string): Promise<Queued<{ recoveryCode: string }>>;
  /** How each team's public key compares with the one this device used for it before. */
  checkPartnerKeys(teamIds: string[]): Promise<PartnerKeyCheck[]>;
  /**
   * A partner team's safety code as this device knows it: of the key it pinned for the team, and
   * whether the server shows another one now (`KnownSafetyCode`). Any team.
   */
  teamSafetyCode(teamId: string): Promise<KnownSafetyCode>;
  /**
   * The team this device and user shared with under an FTC number, and whether the person was shown
   * its safety code, or null for none. The claim that turns a number into a team is the server's
   * word, so the sharing screens compare it with this pin before sending.
   */
  teamNumberPin(teamNumber: number): TeamNumberPin | null;
  /** Remembers that this device and user shared with `teamId` under `teamNumber`. */
  pinTeamNumber(teamNumber: number, teamId: string, options: { safetyCodeSeen: boolean }): void;

  // ------------------------------------------------------------ outbox (spec 13 section 6)

  isOnline(): boolean;
  outbox(): OutboxStatus;
  onOutboxChange(listener: OutboxListener): () => void;
}
