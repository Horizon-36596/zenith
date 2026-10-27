/**
 * Every data operation of `CloudBackend`, written once against `DocStore`. `FirebaseBackend` and
 * `MemoryBackend` extend this class and add only the session: where documents live, who is signed
 * in, and what "online" means.
 *
 * End-to-end encryption (spec 14) happens here, between the API's plain text and the store's
 * envelopes: every value is sealed just before it is written and opened just after it is read, with
 * the keys `KeyRing` opened and checked. Nothing plain that spec 14 seals ever reaches the store.
 */
import type {
  ActivityEntry,
  AdminLogEntry,
  AutoRecord,
  BugReport,
  CarriedShares,
  Claim,
  CloudBackend,
  CloudUser,
  CreatedTeam,
  CreateInviteInput,
  BetaAccessLists,
  BetaRequest,
  CreateShareInput,
  ClaimOutcome,
  ClaimRecord,
  Dispute,
  DisputeDecisionInput,
  EndedShare,
  Invite,
  KeyRequest,
  Member,
  Membership,
  MyDataExport,
  DeleteAccountOptions,
  KnownSafetyCode,
  NativeCredential,
  PartnerKeyAnswers,
  PartnerKeyCheck,
  Proposal,
  PublishInput,
  RequestMoreTimeInput,
  ReviewQueue,
  Revision,
  SendProposalInput,
  Share,
  ShareSummary,
  SignInProvider,
  StoppedShare,
  Team,
  TeamDevice,
  TeamKeyStatus,
  TeamSettings,
  ThisDevice,
  TimeRequest,
  TimeRequestDecision,
  VerificationRequest,
  WaitingShare,
} from "./backend.js";
import {
  aadFor,
  commitLinkKey,
  commitShareKey,
  createRecovery,
  createTeamKeys,
  deriveLinkId,
  deriveLinkKey,
  deviceRecord,
  deviceVerificationCode,
  linkSecretFromText,
  linkSecretToText,
  manifestDeviceSignSpki,
  manifestTermsSignSpki,
  MAX_TERMS_DEVICES,
  MemoryDeviceKeyStore,
  newLinkSecret,
  newRecoveryCode,
  newShareKey,
  openRecovery,
  openRecoverySigner,
  openProposalAsOwner,
  openProposalAsSender,
  verifyProposal,
  openShareManifest,
  openText,
  ownerChoiceDigest,
  readShareManifest,
  recoveryCodeFromText,
  recoveryCodeToText,
  recoveryFingerprint,
  sameShareTerms,
  sealPreviousShareKey,
  sealProposal,
  signProposal,
  sealText,
  shareManifestDigest,
  shareProjectionDigest,
  safetyCodeOfKeys,
  signShareManifest,
  teamKeyDigest,
  teamSafetyCode,
  unwrapLinkSecretAsOwner,
  unwrapShareKeyAsOwner,
  unwrapShareKeyAsTeam,
  wrapLinkSecretForOwner,
  wrapShareKeyForOwner,
  wrapShareKeyToTeam,
  openChain,
  approvalCodeFor,
  isKeyVersion,
  approvalSecretFrom,
  checkTeamEncKey,
  checkTeamKeyStep,
  isCryptoError,
  newApprovalSecret,
  teamKeyFingerprint,
  type DeviceKeyStore,
  type Envelope,
  type ProposalBinding,
  type RevisionField,
  type ShareKey,
  type ShareKeyWrap,
  type ShareManifest,
  type ShareManifestBody,
  type SignedTeamKey,
  type TeamEncKey,
  type TeamKeyRecord,
} from "./crypto/index.js";
import { bytesEqual } from "./crypto/bytes.js";
import { CloudError, isCloudError } from "./errors.js";
import { CANNOT_DEMOTE_ADMIN, CANNOT_REMOVE_ADMIN, CANNOT_REVOKE_ADMIN_DEVICE, CANNOT_STOP_MEMBER_APPROVALS, CannotRotateError, guarded, isCannotRotate, KeyRing, keyPaths, teamKeyAt, teamPairAt, type OpenedTeam, type Rotation } from "./keys/keyring.js";
import { anchorRecovery, endorseRecoveredDevice, isAdminRole, roleIn, type RosterDevice, type RosterShare } from "./keys/roster.js";
import {
  clearApprovalSecret,
  comparePin,
  MemoryTrustStore,
  readApprovalSecret,
  readEarlierPartnerPins,
  readPin,
  readShareKeyPin,
  readTeamNumberPin,
  readShareSeqPin,
  readShareSignerPin,
  readShareTermsPin,
  readTitlePin,
  teamKeyId,
  writeApprovalSecret,
  writePartnerPin,
  writePin,
  writeShareKeyPin,
  writeShareSeqPin,
  writeShareSignerPin,
  writeShareTermsPin,
  writeTeamNumberPin,
  writeTitlePin,
  type PartnerPinTrust,
  type Pin,
  type TeamNumberPin,
  type TrustStore,
} from "./keys/trust.js";
import { randomId, revisionId, type RandomBytes } from "./ids.js";
import { Outbox, type OutboxKind, type OutboxListener, type OutboxStatus, type Queued } from "./outbox.js";
import { paths } from "./paths.js";
import { numberInTeamName } from "./teamNumbers.js";
import { lastSegment, SERVER_TIME, type DocData, type DocStore, type Query, type StoredDoc, type Write } from "./store.js";
import { appealProblem, cleanEvidence, evidenceProblem, oneSentenceProblem } from "./verification.js";
import { bugReportProblem, type BugReportInput } from "./bugReports.js";
import {
  DEFAULT_EXPIRY_S,
  MAX_BETA_NAME,
  MAX_DISPUTE_EVIDENCE,
  MAX_EVIDENCE_TEXT,
  MAX_OWNER_CHOICE_BYTES,
  MAX_PARTNER_KEY_STEPS,
  MAX_PREVIOUS_SHARE_KEYS,
  MAX_PROPOSAL_DIFF_BYTES,
  MAX_REQUEST_EVIDENCE,
  MAX_REVISION_FIELD_BYTES,
  MAX_SHARE_PROJECTION_BYTES,
  MAX_SHARE_TEAMS,
  MAX_TITLE_CIPHERTEXT_BYTES,
  TIME_REQUEST_REASONS,
  BUG_REPORT_STATUSES,
  type ActiveRole,
  type AdminAction,
  type AdminLogDoc,
  type ActivityDoc,
  type ActivityKind,
  type AutoDoc,
  type BetaRequestDoc,
  type BugReportDoc,
  type BugReportStatus,
  type ClaimDoc,
  type ClaimHistoryEntry,
  type DisputeDoc,
  type DisputeEvidence,
  type Evidence,
  type EvidenceInput,
  type InviteDoc,
  type KeyGrantDoc,
  type KeyRequestDoc,
  type MemberDoc,
  type ProposalDoc,
  type RecoveryDoc,
  type RevisionDoc,
  type ShareDoc,
  type ShareLevel,
  type ShareMode,
  type TeamDoc,
  type TeamKeyDoc,
  type TeamSettingsDoc,
  type TimeRequestDoc,
  type UserDoc,
  type VerificationDecision,
  type VerificationRequestDoc,
} from "./types.js";

/**
 * How many shares one write revokes when a team is deleted. Each revocation reads the share's
 * revision in the rules, and one write may read at most 10 documents (ADR 0009 section 4): 8
 * revisions and the owner's membership leave one to spare. Set by hand from that limit.
 */
const SHARES_REVOKED_PER_WRITE = 8;

/**
 * How many documents one write deletes when a team is deleted. Firestore takes at most 500 writes in
 * one batch (ADR 0009 section 3); 400 leaves room for the last write's few more (the claim, the team
 * and the owner's membership), and every delete in it reads the same two documents in the rules (the
 * owner's membership and the team's tombstone). Set by hand from that limit.
 */
const DOCS_DELETED_PER_WRITE = 400;

const utf8 = new TextEncoder();

const kb = (n: number) => `${Math.ceil(n / 1000).toLocaleString("en-US")} KB`;

/**
 * Refuses a projection or a proposal larger than the rules take (spec 13 section 13), with the
 * sentence the UI shows, before anything is written.
 */
function refuseOversize(text: string, max: number, what: string): void {
  const bytes = utf8.encode(text).length;
  if (bytes <= max) return;
  throw new CloudError("invalid", `${what} is ${kb(bytes)}, more than the ${kb(max)} the cloud takes.`);
}

/**
 * Refuses a sealed value whose ciphertext is larger than the rules take. Text under the cap on
 * plain text compresses to well under it; only data that gzip cannot shrink comes this close.
 */
function refuseSealedOversize(envelope: Envelope, max: number, what: string): void {
  if (envelope.ct.byteLength <= max) return;
  throw new CloudError("invalid", `${what} is ${kb(envelope.ct.byteLength)} once encrypted, more than the ${kb(max)} the cloud takes.`);
}

/** The fields of a share document that hold keys or ciphertext, which a `ShareSummary` leaves out. */
function summaryOf(id: string, doc: ShareDoc): ShareSummary {
  const { projection: _projection, keyWraps: _keyWraps, ownerWrap: _ownerWrap, linkWrap: _linkWrap, prevKeys: _prevKeys, manifest: _manifest, ownerChoice: _ownerChoice, ...summary } = doc;
  return { id, ...summary };
}

/** True for the refusal to seal into a share after the end its manifest signs (`SHARE_ENDED`). */
function isEnded(error: unknown): boolean {
  return isCloudError(error, "invalid") && error.message === SHARE_ENDED;
}

/** True when `at`, a share's plain end, is not after `now`; an end that is not a date counts as past. */
function isPast(at: unknown, now: Date): boolean {
  return !(at instanceof Date) || at.getTime() <= now.getTime();
}

/** True for the refusal of a share signed with an older key of its team than this device has seen. */
function isSignedWithOlderKey(error: unknown): boolean {
  return isCloudError(error, "tampered") && error.message === SHARE_SIGNED_WITH_OLDER_KEY;
}

/** True for the refusal of a share that its team's newest key neither signed nor listed (`SHARE_NOT_LISTED`). */
function isNotListed(error: unknown): boolean {
  return isCloudError(error, "tampered") && error.message === SHARE_NOT_LISTED;
}

/**
 * True when the device that signed `manifest`, whose verified body is `body`, is one of `devices`,
 * with the signing key the manifest carries. Its id comes from its keys, so the key checked against
 * the manifest's device signature is the one the roster holds for it.
 */
function signedByOneOf(manifest: ShareManifest, body: ShareManifestBody, devices: readonly RosterDevice[]): boolean {
  const device = devices.find((entry) => entry.deviceId === body.device);
  return device !== undefined && bytesEqual(device.signSpki, manifestDeviceSignSpki(manifest));
}

/**
 * True when every device that signed the terms of the share whose verified manifest is `body`
 * (`termsDevices`) is one of `devices`, and the last of them, whose signature the manifest carries,
 * with the signing key in its `tkeys`: the key the terms signature was checked with. The roster is
 * signed, so that key is the team's, not the server's. The devices before the last signed the terms
 * earlier at the same key version; each is named because it could have chosen any of them.
 */
function termsSignedByOneOf(manifest: ShareManifest, body: ShareManifestBody, devices: readonly RosterDevice[]): boolean {
  const kept = new Set(devices.map((entry) => entry.deviceId));
  if (!body.termsDevices.every((deviceId) => kept.has(deviceId))) return false;
  const last = devices.find((entry) => entry.deviceId === body.termsDevices.at(-1));
  return last !== undefined && bytesEqual(last.signSpki, manifestTermsSignSpki(manifest));
}

/** Each team a manifest names, by id, with the version and digest of the key it names for it. */
function signedTeamKeys(manifest: ShareManifestBody): Map<string, SignedTeamKey> {
  return new Map(manifest.teams.map((entry) => [entry[0], entry]));
}

/** True when two team keys are the same version with the same fingerprint and signing key. */
function sameKeyAs(a: Pick<Pin, "v" | "fingerprint" | "signSpki">, b: Pick<Pin, "v" | "fingerprint" | "signSpki">): boolean {
  return a.v === b.v && bytesEqual(a.fingerprint, b.fingerprint) && bytesEqual(a.signSpki, b.signSpki);
}

const ACTIVE_ROLE_SET = new Set<string>(["owner", "admin", "editor", "viewer"]);
const ADMIN_ROLE_SET = new Set<string>(["owner", "admin"]);

/** The sentence for a device whose id another member's key request already holds. */
const ANOTHERS_REQUEST =
  "Another member has asked for the team key under this device's id, which keeps this device from getting it. Ask an owner or admin to delete that request from the team's devices waiting for approval, then try again.";

/** `REVOKE_NEEDS_KEY_CHANGE`, for a removal. */
export const REMOVE_NEEDS_KEY_CHANGE =
  "The team key could not be changed, because the database withheld a key that changing it needs, so the member was not removed. Try again, and if this keeps happening, remove them on another owner's or admin's device.";

/**
 * Why a revocation from a device that may change the team key failed without changing anything: the
 * database refused a read the key change needs, and taking the key without changing it would leave
 * the revoked device able to read what the team writes next.
 */
export const REVOKE_NEEDS_KEY_CHANGE =
  "The team key could not be changed, because the database refused a read that changing it needs, so the device still holds the key. Nothing was changed. Try again, and if this keeps happening, take the key from it on another owner's or admin's device.";

/**
 * Why nothing new was sealed: a member left or a device was taken off, so the team key must change
 * first (`openTeamToSeal`). One sentence for an owner or admin, who can change it, and one for anyone else.
 */
export const ROTATE_BEFORE_SEALING_ADMIN =
  "A member left or a device was taken off, so the team key must change before anything new is sent. Nothing was sent. Click Make a new key on the team page, then try again.";
export const ROTATE_BEFORE_SEALING =
  "A member left or a device was taken off, so the team key must change before anything new is sent. Nothing was sent. Ask an owner or admin of the team to make a new key, then try again.";

/** How this device opens a share: as its owner team, as a team it was made to, or by its link. */
type ShareAccess =
  | { kind: "owner"; team: OpenedTeam }
  | { kind: "recipient"; team: OpenedTeam }
  | { kind: "link"; secret: Uint8Array };

/** A share key as this device opened it, with the manifest it checked first (null when opened by its link alone). */
interface OpenedShareKey {
  key: ShareKey;
  manifest: ShareManifestBody | null;
}

/** The share key an owner team device opened, with the manifest it checked and found live. */
interface OwnedShareKey {
  key: ShareKey;
  manifest: ShareManifestBody;
}

/**
 * What a share's verified, live manifest says about the proposals made on it (`proposalAnchor`): the
 * auto it is for, and each team it names, by id, with the version and digest of the key it names.
 */
interface ProposalAnchor {
  autoId: string;
  teams: ReadonlyMap<string, SignedTeamKey>;
}

/**
 * What a write that signs a new manifest moves a share to: the share key version, the owner team
 * key version that signed, the manifest's sequence number and its count of terms signatures, which
 * this device pins once the write is stored.
 */
interface Signed {
  kv: number;
  okv: number;
  seq: number;
  tseq: number;
}

/** One share's write in a carry-forward (`carriedShare`): the fields, where they move it, and its sealed projection's size. */
interface CarriedShare {
  shareId: string;
  fields: DocData;
  signed: Signed;
  bytes: number;
}

/** The sentence for a share that has no signed manifest. */
export const SHARE_WITHOUT_MANIFEST =
  "This share carries no signed record of its key and terms, so they cannot be checked, and nothing is opened or sent. It may have been made by an older version of Zenith: ask the team that made it to share it again.";

/** The sentence for a share whose plain fields say something its signed manifest does not. */
export const SHARE_TERMS_CHANGED =
  "This share's auto, revision, teams, level, mode, end date or revocation is not what the team that made it signed, so the database may have changed it. Nothing is opened or sent.";

/** The sentence for a share whose projection is not the one its signed manifest names. */
export const SHARE_PROJECTION_NOT_SIGNED =
  "What this share shows is not what the team that made it last signed, so the database may have put back an older version. Nothing is opened or sent.";

/** The sentence for a seal into a share after the end its manifest signs. */
export const SHARE_ENDED =
  "This share has ended, on the date the team that made it signed, so nothing new is sealed into it. Nothing was changed. Extend the share first to send it something new.";

/** The sentence for a share whose manifest is older than one this device has seen. */
export const SHARE_MANIFEST_OLDER =
  "This share is older than a version of it this device has already seen, so the database may have put back a share from before it was changed or revoked. Nothing is opened or sent.";

/** The sentence for a share whose signed terms are older than ones this device has seen. */
export const SHARE_TERMS_OLDER =
  "This share's terms are older than terms of it this device has already seen, so someone may have put back its teams, level, end or revocation from before a change. Nothing is opened or sent.";

/** The sentence for a change of terms on one device more than a manifest names as their signers. */
export const SHARE_TERMS_SIGNERS_FULL =
  "This share's terms have been changed on as many devices as one share records since your team's key last changed, so this device cannot change them. Nothing was changed. Make the change on one of the devices that changed them before, or make a new share for these teams.";

/**
 * The sentence for an owner team's share that its newest key version neither signed nor listed: it
 * may have been made by someone taken off the team, or on a device the team took the key from, with
 * a key they kept.
 */
export const SHARE_NOT_LISTED =
  "This share was signed with a key your team has since replaced, and the device that replaced the key did not list it among the team's shares, so someone taken off the team, or a device the team took the key from, may have made it. Nothing was sealed into it or changed. If your team made it, make a new share of the auto for the same teams; this one gets nothing new.";

/** The sentence for a publish into a share whose manifest does not say it follows that auto. */
export const SHARE_NOT_FOLLOWING =
  "This share is not one the team signed as following this auto, so nothing new is sealed into it. Nothing was changed.";

/** The sentence for a share manifest signed with an older key of the owner team than this device knows of. */
export const SHARE_SIGNED_WITH_OLDER_KEY =
  "This share's key was signed with an older key of the team that made it than one this device has already seen, so someone that team took off may have made it. Nothing is opened or sent. Ask that team to update the share.";

/**
 * How many shares one write carries forward to the team's newest key (`carryForwardShares`). SET BY
 * HAND. Each is an update of one share document whose rule reads the writer's membership and the
 * team, the same two documents for every share of the team, so a write stays far inside the 20
 * documents one batch may read (ADR 0013 section 5, E9) and the 500 writes it may hold (ADR 0009
 * section 3). The team's roster lists at most `MAX_ROSTER_SHARES` shares, so a run makes at most
 * 150 writes, one after the other, and a run cut short leaves whole writes behind it.
 */
export const CARRY_FORWARD_SHARES_PER_WRITE = 10;

/**
 * How many bytes of sealed projections one carry-forward write holds at most, beyond its first
 * share. SET BY HAND: four of the largest projections the rules take (1,000,000 bytes each), so that
 * a write of large shares is split well before it could hold the ten documents of up to 1 MiB each
 * that `CARRY_FORWARD_SHARES_PER_WRITE` allows. The largest request Firestore takes has not been
 * measured, so this stays far below ten such documents rather than close to a figure not checked.
 */
export const CARRY_FORWARD_PROJECTION_BYTES_PER_WRITE = 4_000_000;

export interface CloudClientOptions {
  /** The device clock, used only for values shown before the server has stamped them. */
  now?: () => Date;
  random: RandomBytes;
  /**
   * Where this device keeps its own keys (spec 14 section 4.1): IndexedDB normally, memory on a
   * shared computer. Default: memory, so a backend with no store given keeps nothing on disk.
   */
  deviceKeys?: DeviceKeyStore;
  /**
   * Where this device keeps the team keys it has seen (trust on first use): `localStorage` in the
   * browser. Default: memory.
   */
  trust?: TrustStore;
  /** PBKDF2 iterations for an approval code's key; only the in-memory cloud's tests pass fewer. */
  approvalKdfIterations?: number;
}

export abstract class CloudClient implements CloudBackend {
  abstract readonly kind: "firebase" | "memory";
  protected readonly now: () => Date;
  protected readonly random: RandomBytes;
  protected readonly outboxList: Outbox;
  protected readonly deviceKeys: DeviceKeyStore;
  protected readonly trust: TrustStore;
  /** This device's keys and the team keys it opened. */
  protected readonly keys: KeyRing;
  /** The run of `carryForwardShares` in progress on this device, by team, so two calls share one. */
  private readonly carrying = new Map<string, Promise<CarriedShares>>();

  protected constructor(options: CloudClientOptions) {
    this.now = options.now ?? (() => new Date());
    this.random = options.random;
    this.outboxList = new Outbox(this.now, () => this.isOnline());
    this.deviceKeys = options.deviceKeys ?? new MemoryDeviceKeyStore();
    this.trust = options.trust ?? new MemoryTrustStore();
    this.keys = new KeyRing({
      store: () => this.store(),
      uid: () => this.uid(),
      random: this.random,
      deviceKeys: this.deviceKeys,
      trust: this.trust,
      liveShares: (opened, kept) => this.liveSharesAt(opened, kept),
      ...(options.approvalKdfIterations === undefined ? {} : { approvalKdfIterations: options.approvalKdfIterations }),
    });
  }

  // ------------------------------------------------------------ what each backend provides

  protected abstract store(): DocStore;
  abstract currentUser(): CloudUser | null;
  abstract onAuthChange(listener: (user: CloudUser | null) => void): () => void;
  abstract signInWithProvider(provider: SignInProvider): Promise<CloudUser>;
  abstract signInWithNativeCredential(credential: NativeCredential): Promise<CloudUser>;
  abstract sendSignInLink(email: string, continueUrl: string): Promise<void>;
  abstract isSignInLink(url: string): boolean;
  abstract completeSignInLink(email: string, url: string): Promise<CloudUser>;
  abstract signOut(): Promise<void>;
  abstract isOnline(): boolean;
  /**
   * Makes sure the sign-in is recent enough for the provider to let the sign-in account be deleted,
   * asking the person to sign in again when it is not. Called before anything is deleted, so a
   * refusal leaves the account whole. Throws `CloudError` "reauth-required" when they do not finish.
   * `reauthenticate`, when given, is how the account's provider signs in again instead of the popup.
   */
  protected abstract confirmRecentSignIn(reauthenticate?: DeleteAccountOptions["reauthenticate"]): Promise<void>;
  /** Deletes the sign-in account itself, after the profile is gone. */
  protected abstract deleteSignInAccount(): Promise<void>;

  // ------------------------------------------------------------ helpers

  protected uid(): string {
    const user = this.currentUser();
    if (user === null) throw new CloudError("signed-out", "Sign in to use the team library and sharing.");
    return user.uid;
  }

  private write<T>(kind: OutboxKind, summary: string, writes: Write[], value: T): Queued<T> {
    const { sent } = this.store().commit(writes);
    const tracked = this.outboxList.track(kind, summary, sent);
    return { value, outboxId: tracked.outboxId, sent: tracked.sent };
  }

  /**
   * `write`, with `registration` (this device's record, from `keys.registration()`) first in the
   * batch. If the batch is refused, the record is written again with the next one.
   */
  private writeRegistered<T>(kind: OutboxKind, summary: string, registration: Write[], writes: Write[], value: T): Queued<T> {
    const queued = this.write(kind, summary, [...registration, ...writes], value);
    if (registration.length > 0) {
      const uid = this.uid();
      this.keys.registrationQueued(registration);
      queued.sent.catch(() => this.keys.registrationFailed(uid, registration));
    }
    return queued;
  }

  private activity(teamId: string, kind: ActivityKind, target?: string, detail?: string | Envelope): Write {
    return this.activityAt(teamId, randomId(this.random), kind, target, detail);
  }

  private activityAt(teamId: string, entryId: string, kind: ActivityKind, target?: string, detail?: string | Envelope): Write {
    const data: DocData = { at: SERVER_TIME, by: this.uid(), kind };
    if (target !== undefined) data.target = target;
    if (detail !== undefined) data.detail = detail;
    return { op: "set", path: paths.activityEntry(teamId, entryId), data };
  }

  /** The team's keys on this device, opened and checked; "no-key" while it waits for them. */
  private openTeam(teamId: string, options: { extractable?: boolean } = {}): Promise<OpenedTeam> {
    return this.keys.openTeam(teamId, options);
  }

  /**
   * Whether the team's key must change before anything new is sealed with it: a member who held it
   * left or a device that held it was taken off (spec 14 section 4.5). The `rotationPending` mark is
   * the server's word, so this device also works it out from the newest roster: a member it names who
   * is no longer active, or, for an owner or admin, who may read every grant, a device it names that
   * no longer holds one. A read that fails (offline, or refused) leaves only the mark to go on.
   */
  private async rotationDue(opened: OpenedTeam): Promise<boolean> {
    if (opened.team.rotationPending === true) return true;
    const members = await this.store().list({ collection: paths.members(opened.teamId) }).catch(() => null);
    if (members === null) return false;
    const roles = new Map(members.map((doc) => [doc.id, (doc.data as unknown as MemberDoc).role]));
    if (opened.roster.members.some((member) => !ACTIVE_ROLE_SET.has(roles.get(member.uid) ?? ""))) return true;
    if (!ADMIN_ROLE_SET.has(roles.get(this.uid()) ?? "")) return false;
    const grants = await this.store().list({ collection: keyPaths.grants(opened.teamId) }).catch(() => null);
    if (grants === null) return false;
    const held = new Set(grants.map((doc) => (doc.data as unknown as KeyGrantDoc).deviceId));
    return opened.roster.devices.some((device) => !held.has(device.deviceId));
  }

  /**
   * `openTeam` for a call that seals something new under the team key: a revision, a title, a share
   * or a proposal. While a rotation is due the current key is one a removed member may still hold, so
   * nothing new is sealed with it until an owner or admin makes a new key.
   */
  private async openTeamToSeal(teamId: string, options: { extractable?: boolean } = {}): Promise<OpenedTeam> {
    const opened = await this.openTeam(teamId, options);
    if (await this.rotationDue(opened)) {
      const role = ((await this.getOrNull(paths.member(teamId, this.uid()))) as MemberDoc | null)?.role;
      throw new CloudError("conflict", ADMIN_ROLE_SET.has(role ?? "") ? ROTATE_BEFORE_SEALING_ADMIN : ROTATE_BEFORE_SEALING);
    }
    return opened;
  }

  /** `openTeam`, or null when this device cannot open the team (not a member, or still waiting). */
  private async openTeamOrNull(teamId: string): Promise<OpenedTeam | null> {
    try {
      return await this.openTeam(teamId);
    } catch (error) {
      if (isCloudError(error, "no-key") || isCloudError(error, "permission-denied") || isCloudError(error, "not-found")) return null;
      throw error;
    }
  }

  /** Seals `text` under the team's newest key. */
  private sealForTeam(opened: OpenedTeam, text: string, aad: ReturnType<typeof aadFor.autoTitle>): Promise<Envelope> {
    return guarded("The data to encrypt", () => sealText(opened.newest.key, text, aad, this.random));
  }

  /** A read the rules refuse becomes null, for documents a caller may simply not know about. */
  private async getOrNull(path: string): Promise<DocData | null> {
    try {
      return await this.store().get(path);
    } catch (error) {
      if (isCloudError(error, "permission-denied")) return null;
      throw error;
    }
  }

  private async require(path: string, what: string): Promise<DocData> {
    const data = await this.getOrNull(path);
    if (data === null) throw new CloudError("not-found", `${what} does not exist, or you cannot open it.`);
    return data;
  }

  private expiry(seconds: number): Date {
    return new Date(this.now().getTime() + seconds * 1000);
  }

  // ------------------------------------------------------------ profile

  async getProfile(): Promise<UserDoc | null> {
    return (await this.store().get(paths.user(this.uid()))) as UserDoc | null;
  }

  async saveProfile(input: { displayName: string }): Promise<Queued<UserDoc>> {
    const displayName = input.displayName.trim();
    if (displayName.length === 0 || displayName.length > 80) {
      throw new CloudError("invalid", "A display name must have 1 to 80 characters.");
    }
    const path = paths.user(this.uid());
    const existing = (await this.store().get(path)) as UserDoc | null;
    if (existing === null) {
      const value: UserDoc = { displayName, createdAt: this.now() };
      return this.write("profile", "Save your profile.", [
        { op: "set", path, data: { displayName, createdAt: SERVER_TIME } },
      ], value);
    }
    return this.write("profile", "Change your display name.", [{ op: "update", path, data: { displayName } }], {
      ...existing,
      displayName,
    });
  }

  /**
   * The profile, the memberships, and for every team the user is an active member of, what they
   * wrote there that the rules let them read. Every query carries the filter its list rule is written
   * for (a team id), plus the author field; equality filters only, which Firestore serves from its
   * single-field indexes without a composite index.
   */
  async exportMyData(): Promise<MyDataExport> {
    const uid = this.uid();
    const profile = await this.getProfile();
    const memberDocs = await this.store().list({ collection: "members", group: true, where: [{ field: "uid", value: uid }] });
    const memberships = memberDocs.map((doc) => doc.data as unknown as Member);
    const out: MyDataExport = {
      exportedAt: this.now(),
      uid,
      profile,
      memberships,
      activity: [],
      revisions: [],
      shares: [],
      proposals: [],
      verificationRequests: [],
      disputesOpened: [],
      disputeEvidence: [],
      appeals: [],
      claimHistory: [],
      betaRequest: await this.myBetaRequest(),
      notIncluded: [],
    };
    const mine = (field: string) => ({ field, value: uid });
    let unreadActivity = false;
    let lockedTeam = false;
    const seenSteps = new Set<string>();
    for (const membership of memberships) {
      if (membership.role === "pending") continue;
      const teamId = membership.teamId;
      // What the member wrote is sealed under the team key; a device that does not hold it yet
      // exports the rest and says what it left out.
      const opened = await this.openTeamOrNull(teamId);
      if (opened === null) lockedTeam = true;
      if (membership.role === "owner" || membership.role === "admin") {
        const entries = await this.store().list({ collection: paths.activity(teamId), where: [mine("by")] });
        for (const doc of entries) out.activity.push({ teamId, ...(await this.toActivity(teamId, opened, doc)) });
      } else {
        unreadActivity = true;
      }
      if (opened !== null) {
        for (const auto of await this.store().list({ collection: paths.autos(teamId) })) {
          const docs = await this.store().list({ collection: paths.revisions(teamId, auto.id), where: [mine("author")] });
          for (const doc of docs) out.revisions.push(await this.toRevision(opened, auto.id, doc));
        }
        const shares = await this.store().list({ collection: paths.shares(), where: [{ field: "ownerTeamId", value: teamId }, mine("createdBy")] });
        for (const doc of shares) out.shares.push(await this.openShareDoc(doc.id, doc.data as unknown as ShareDoc, { kind: "owner", team: opened }));
        const proposals = await this.store().list({
          collection: paths.proposals(),
          where: [{ field: "fromTeamId", value: teamId }, mine("createdBy")],
        });
        for (const doc of proposals) out.proposals.push(await this.openProposal(doc.id, doc.data as unknown as ProposalDoc, opened, "sent"));
      }
      const requests = await this.store().list({
        collection: paths.verifications(),
        where: [{ field: "teamId", value: teamId }, mine("requestedBy")],
      });
      for (const doc of requests) out.verificationRequests.push({ id: doc.id, ...(doc.data as unknown as VerificationRequestDoc) });

      const disputes = await this.listDisputes(teamId);
      const numbers = new Set<number>(disputes.map((d) => d.teamNumber));
      const team = await this.getTeam(teamId);
      if (team?.number != null) numbers.add(team.number);
      for (const d of disputes) {
        const where = { disputeId: d.id, teamNumber: d.teamNumber };
        if (d.openedBy === uid && !out.disputesOpened.some((o) => o.id === d.id)) {
          const { id, teamNumber, holderTeamId, challengerTeamId, createdAt, status } = d;
          out.disputesOpened.push({ id, teamNumber, holderTeamId, challengerTeamId, createdAt, status });
        }
        for (const row of d.evidence) {
          if (row.by === uid && row.team === teamId) out.disputeEvidence.push({ ...row, ...where });
        }
        if (d.appeal !== null && d.appeal.by === uid && d.appeal.team === teamId) out.appeals.push({ ...d.appeal, ...where });
      }
      for (const teamNumber of numbers) {
        for (const [index, step] of await this.claimSteps(teamNumber, teamId)) {
          const key = `${String(teamNumber)}/${String(index)}`;
          if (step.by !== uid || seenSteps.has(key)) continue;
          seenSteps.add(key);
          out.claimHistory.push({ ...step, teamNumber });
        }
      }
    }
    if (unreadActivity) {
      out.notIncluded.push(
        "Your entries in the activity log of a team where you are an editor or viewer: only a team's owners and admins can read its activity log.",
      );
    }
    if (lockedTeam) {
      out.notIncluded.push(
        "The autos, shares and proposals you wrote in a team whose key this device does not hold yet: they are encrypted, and only a device that holds the team key can open them. Export again from such a device.",
      );
    }
    if (memberships.some((m) => m.role === "pending")) {
      out.notIncluded.push("Anything in a team that has not yet approved you: a waiting member can read nothing in the team.");
    }
    out.notIncluded.push(
      "What you wrote in a team you have left or been removed from: it belongs to that team, and only its members' devices can open it. Horizon cannot read it or give it to you. Ask the team's owners if you need it; a team that has lost every device opens its library with its printed recovery code.",
    );
    if (out.shares.some((share) => share.linkSecret !== undefined)) {
      out.notes = [
        "The linkSecret of each anyone-with-the-link share is your own working link secret, the part of the link after #/s/. Anyone who has it can open that share until it is revoked or expires, so keep this file as private as the links themselves.",
      ];
    }
    return out;
  }

  async deleteAccount(options: DeleteAccountOptions = {}): Promise<void> {
    const uid = this.uid();
    if (!this.isOnline()) {
      throw new CloudError("unavailable", "Deleting your account needs a connection. Nothing was deleted; try again when you are online.");
    }
    // Before anything is deleted, and before any other request so a sign-in window is still allowed
    // to open from the press of the button. Firebase refuses to delete a sign-in account whose
    // sign-in is old; checking afterwards would leave a profile deleted and a sign-in kept.
    await this.confirmRecentSignIn(options.reauthenticate);
    const memberships = await this.listMyTeams();
    const owned = memberships.filter((m) => m.role === "owner");
    if (owned.length > 0) {
      throw new CloudError(
        "conflict",
        `You own ${String(owned.length)} team${owned.length === 1 ? "" : "s"}. Make another member an owner, or delete the team, before deleting your account.`,
      );
    }
    // Leaving each team as `leaveTeam` does: this member's grants and key requests go, and a team
    // they were active in is marked "rotation pending" for its owners and admins. Then the device
    // records, the profile and the sign-in.
    const writes: Write[] = [];
    for (const m of memberships) writes.push(...(await this.leaveWrites(m.teamId, m.role)));
    writes.push(...memberships.map((m): Write => ({ op: "delete", path: paths.member(m.teamId, uid) })));
    for (const device of await this.store().list({ collection: keyPaths.devices(uid) })) writes.push({ op: "delete", path: device.path });
    if ((await this.myBetaRequest()) !== null) writes.push({ op: "delete", path: paths.betaRequest(uid) });
    writes.push({ op: "delete", path: paths.user(uid) });
    const queued = this.write("profile", "Delete your account.", writes, undefined);
    await queued.sent;
    await this.deviceKeys.remove(uid).catch(() => undefined);
    await this.deleteSignInAccount();
  }

  // ------------------------------------------------------------ teams

  private async displayName(): Promise<string> {
    const profile = await this.getProfile();
    if (profile === null) {
      throw new CloudError("invalid", "Save your profile before you create or join a team.");
    }
    return profile.displayName;
  }

  /**
   * Creates a team and its keys in one write (spec 14 section 4.2): team key 1 and its pair
   * (`teamKeys/1` and `encKey`) with device roster 1, which names this device and its owner; this
   * device's grant, signed by itself; and the recovery record for a new recovery code, whose text
   * comes back to be shown once.
   */
  async createTeam(input: { number: number | null; name: string }): Promise<Queued<CreatedTeam>> {
    const uid = this.uid();
    const name = input.name.trim();
    if (name.length === 0 || name.length > 100) throw new CloudError("invalid", "A team name must have 1 to 100 characters.");
    if (input.number !== null && (!Number.isInteger(input.number) || input.number < 1 || input.number > 999_999)) {
      throw new CloudError("invalid", "An FTC team number is a whole number from 1 to 999999.");
    }
    const displayName = await this.displayName();
    const released = input.number === null ? null : await this.claimableRecord(input.number);

    const teamId = randomId(this.random);
    const device = await this.keys.device();
    const registration = await this.keys.registration();
    const { keys, recovery, recoveryCode, anchor } = await guarded("The new team's keys", async () => {
      const made = await createTeamKeys(teamId, this.random);
      const code = newRecoveryCode(this.random);
      try {
        const record = await createRecovery({ teamId, teamKey: made.key, code, random: this.random });
        // The code vouches for version 1, which a device with no pin that uses it starts from.
        const signer = await openRecoverySigner({ teamId, record, code });
        const fingerprint = await recoveryFingerprint(record);
        return {
          keys: made,
          recovery: record,
          recoveryCode: await recoveryCodeToText(code),
          anchor: await anchorRecovery(signer, {
            teamId,
            kv: made.key.version,
            pairSpki: made.record.pairSpki,
            signSpki: made.record.signSpki,
            recovery: fingerprint,
            rotatorSignSpki: device.signSpki,
          }),
        };
      } finally {
        code.fill(0);
      }
    });
    const roster = await this.keys.foundingRoster(teamId, keys, recovery, anchor);
    const founded: OpenedTeam = {
      teamId,
      team: { number: input.number, name, status: "unverified", createdBy: uid, createdAt: this.now(), encKey: keys.encKey },
      device,
      grant: null as unknown as KeyGrantDoc,
      newest: { key: keys.key, pair: keys.pair },
      chain: new Map([[1, { key: keys.key, pair: keys.pair }]]),
      roster: roster.roster,
      rosterDigest: roster.digest,
    };
    const grant = await this.keys.grantWrite(founded, { uid, deviceId: device.deviceId, record: deviceRecord(device) }, null);
    const writes: Write[] = [
      {
        op: "set",
        path: paths.team(teamId),
        data: { number: input.number, name, status: "unverified", createdBy: uid, createdAt: SERVER_TIME, encKey: keys.encKey },
      },
      {
        op: "set",
        path: paths.member(teamId, uid),
        data: { uid, teamId, role: "owner", displayName, joinedAt: SERVER_TIME },
      },
      { op: "set", path: keyPaths.teamKey(teamId, 1), data: { ...keys.record, ...roster.fields } },
      { op: "set", path: keyPaths.recovery(teamId), data: { ...recovery, updatedBy: uid, updatedAt: SERVER_TIME } },
      grant,
    ];
    if (input.number !== null) writes.push(...this.claimWrites(input.number, teamId, released));
    writes.push(this.activity(teamId, "team.create", teamId));
    const value: CreatedTeam = {
      id: teamId,
      number: input.number,
      name,
      status: "unverified",
      createdBy: uid,
      createdAt: this.now(),
      encKey: keys.encKey,
      recoveryCode,
    };
    const label = input.number === null ? name : `${String(input.number)} ${name}`;
    const queued = this.writeRegistered("team", `Create team ${label}.`, registration, writes, value);
    writePin(this.trust, uid, "team", teamId, keys.encKey, roster.digest);
    return queued;
  }

  /**
   * The claim on `teamNumber` when nobody holds it any more, null when there is no claim, and a
   * refusal with the sentence to show when another team holds it or a reviewer still has it.
   */
  private async claimableRecord(teamNumber: number): Promise<ClaimRecord | null> {
    const claim = await this.claimRecord(teamNumber);
    if (claim === null) return null;
    if (claim.teamId === null) {
      if ((claim.disputeId ?? null) === null && (claim.requestId ?? null) === null) return claim;
      throw new CloudError(
        "conflict",
        `Team number ${String(teamNumber)} was given up when the team that held it was deleted, and a Horizon admin still has a review or request on it to close. Try again after that decision.`,
      );
    }
    if (claim.status === "verified") {
      throw new CloudError(
        "conflict",
        `Team number ${String(teamNumber)} is verified to another team. If that is wrong, create your team without a number and ask for a review of the number from its Verification section, with your evidence.`,
      );
    }
    throw new CloudError(
      "conflict",
      `Team number ${String(teamNumber)} is already claimed and not yet verified. Create your team without a number and claim it from the team's Verification section: both claims will show as contested until a Horizon admin decides.`,
    );
  }

  /**
   * A new claim on `teamNumber` for `teamId`, with its first step, or, on a claim nobody holds any
   * more (`released`), the claim taken afresh with a `claim` step added to its history.
   */
  private claimWrites(teamNumber: number, teamId: string, released: ClaimRecord | null = null): Write[] {
    if (released !== null) {
      return [
        {
          op: "update",
          path: paths.claim(teamNumber),
          data: { teamId, status: "unverified", claimedAt: SERVER_TIME, historyCount: released.historyCount + 1 },
        },
        this.stepWrite(teamNumber, released.historyCount, this.historyEntry("claim", teamId, null)),
      ];
    }
    return [
      {
        op: "set",
        path: paths.claim(teamNumber),
        data: { teamId, status: "unverified", claimedAt: SERVER_TIME, historyCount: 1, disputeId: null, requestId: null },
      },
      this.stepWrite(teamNumber, 0, this.historyEntry("claim", teamId, null)),
    ];
  }

  async getTeam(teamId: string): Promise<Team | null> {
    const data = await this.getOrNull(paths.team(teamId));
    return data === null ? null : { id: teamId, ...(data as unknown as TeamDoc) };
  }

  async findTeamByNumber(teamNumber: number): Promise<Team | null> {
    const claim = await this.claimRecord(teamNumber);
    return claim === null || claim.teamId === null ? null : this.getTeam(claim.teamId);
  }

  async listMyTeams(): Promise<Membership[]> {
    const docs = await this.store().list({ collection: "members", group: true, where: [{ field: "uid", value: this.uid() }] });
    const out: Membership[] = [];
    for (const doc of docs) {
      const member = doc.data as unknown as MemberDoc;
      out.push({ teamId: member.teamId, role: member.role, team: await this.getTeam(member.teamId) });
    }
    return out;
  }

  async renameTeam(teamId: string, name: string): Promise<Queued<void>> {
    const trimmed = name.trim();
    if (trimmed.length === 0 || trimmed.length > 100) throw new CloudError("invalid", "A team name must have 1 to 100 characters.");
    return this.write("team", `Rename the team to ${trimmed}.`, [
      { op: "update", path: paths.team(teamId), data: { name: trimmed } },
      this.activity(teamId, "team.rename", teamId, trimmed),
    ], undefined);
  }

  /**
   * Deletes a team and what it holds (spec 13 section 4.3). In order, and each write sent while the
   * owner's membership still stands:
   * 1. Every share the team made that is not revoked yet is revoked, in groups small enough for the
   *    rules' limit on documents read by one write (each share reads its revision). Shares are kept,
   *    revoked, as the record of what was shared.
   * 2. The team's tombstone (`deletedTeams/{teamId}`) and every document the team holds are deleted in
   *    writes of at most DOCS_DELETED_PER_WRITE: its invites, revisions, autos, activity log, inbox,
   *    settings and other members. The tombstone goes in the first of them, and the rules let the
   *    owner delete those documents only under it; it also keeps the team's id from ever being used
   *    again.
   * 3. The last write drops the claim on the team's number, or keeps it detached from the team when
   *    it has history of its own, then deletes the team and the owner's membership.
   * Offline, every write waits in the outbox and is sent in order.
   *
   * A Horizon admin who is not the team's owner deletes it as `deleteTeamAsHorizonAdmin` does.
   */
  async deleteTeam(teamId: string): Promise<Queued<void>> {
    const uid = this.uid();
    const team = await this.getTeam(teamId);
    if (team === null) throw new CloudError("not-found", "That team does not exist, or you cannot open it.");
    // Checked here, before any write, because a team admin may revoke shares but not delete the team:
    // without it the revocations would go through and the delete would then be refused.
    const mine = (await this.getOrNull(paths.member(teamId, uid))) as unknown as MemberDoc | null;
    if (mine?.role !== "owner") {
      if (await this.isHorizonAdmin()) return this.deleteTeamAsHorizonAdmin(teamId, team.name);
      throw new CloudError("permission-denied", "Only an owner of the team can delete it.");
    }
    const members = await this.listMembers(teamId);
    // Each share is revoked with the manifest that says so, signed with the team's key. A team is
    // deleted even if one of its shares does not open, or this device does not hold the key: a
    // share nobody can revoke stops opening for anyone once its team is gone.
    const opened = await this.openTeamOrNull(teamId);
    const open: Write[] = [];
    for (const doc of opened === null ? [] : await this.store().list({ collection: paths.shares(), where: [{ field: "ownerTeamId", value: teamId }] })) {
      const share = doc.data as unknown as ShareDoc;
      if (share.revokedAt !== null || opened === null) continue;
      let signed: ShareManifest;
      try {
        const { manifest } = await this.ownedShareKey(doc.id, share, opened);
        ({ manifest: signed } = await this.signedManifest(opened, { ...manifest, revoked: true, seq: manifest.seq + 1 }, { manifest: share.manifest, body: manifest }));
      } catch (error) {
        if (isCloudError(error, "tampered") || isCloudError(error, "invalid") || isCloudError(error, "no-key")) continue;
        throw error;
      }
      open.push({ op: "update", path: paths.share(doc.id), data: { revokedAt: SERVER_TIME, manifest: signed, updatedAt: SERVER_TIME } });
    }
    const revocations: Queued<void>[] = [];
    for (let start = 0; start < open.length; start += SHARES_REVOKED_PER_WRITE) {
      const writes = open.slice(start, start + SHARES_REVOKED_PER_WRITE);
      const group = writes;
      const summary = `Revoke ${String(group.length)} share${group.length === 1 ? "" : "s"} of team ${team.name} before deleting it.`;
      revocations.push(this.write("share", summary, writes, undefined));
    }

    const del = (path: string): Write => ({ op: "delete", path });
    const activity = await this.store().list({ collection: paths.activity(teamId) });
    const inviteCodes = new Set<string>();
    for (const entry of activity) {
      if (entry.data.kind === "invite.create" && typeof entry.data.target === "string") inviteCodes.add(entry.data.target);
    }
    const library: Write[] = [];
    for (const auto of await this.store().list({ collection: paths.autos(teamId) })) {
      for (const revision of await this.store().list({ collection: paths.revisions(teamId, auto.id) })) library.push(del(revision.path));
      library.push(del(auto.path));
    }
    const inbox = await this.store().list({ collection: paths.inbox(teamId) });
    // The team's keys go with it: every grant, request and key record, and the recovery record.
    const keyDocs: Write[] = [];
    for (const collection of [keyPaths.grants(teamId), keyPaths.requests(teamId), keyPaths.teamKeys(teamId)]) {
      for (const doc of await this.store().list({ collection })) keyDocs.push(del(doc.path));
    }
    keyDocs.push(del(keyPaths.recovery(teamId)));
    // A deletion that stopped half way already wrote the tombstone, which is never written twice.
    const tombstone = await this.getOrNull(paths.deletedTeam(teamId)).catch(() => null);
    const purge: Write[] = [
      ...(tombstone === null ? [{ op: "set", path: paths.deletedTeam(teamId), data: { deletedBy: uid, deletedAt: SERVER_TIME } } as Write] : []),
      ...[...inviteCodes].map((code) => del(paths.invite(code))),
      ...library,
      ...activity.map((doc) => del(doc.path)),
      ...inbox.map((doc) => del(doc.path)),
      ...keyDocs,
      del(paths.settings(teamId)),
      ...members.filter((m) => m.uid !== uid).map((m) => del(paths.member(teamId, m.uid))),
    ];
    const last: Write[] = team.number === null ? [] : await this.detachClaimWrites(team.number, teamId);
    last.push(del(paths.team(teamId)), del(paths.member(teamId, uid)));
    const groups: Write[][] = [];
    for (let start = 0; start < purge.length; start += DOCS_DELETED_PER_WRITE) groups.push(purge.slice(start, start + DOCS_DELETED_PER_WRITE));
    if (groups.length === 0) groups.push([]);
    groups[groups.length - 1]?.push(...last);
    const deletions = groups.map((writes, index) => {
      const summary = groups.length === 1 ? `Delete team ${team.name}.` : `Delete team ${team.name}, part ${String(index + 1)} of ${String(groups.length)}.`;
      return this.write("team", summary, writes, undefined);
    });
    const deleted = deletions[deletions.length - 1] as Queued<void>;
    const all = [...revocations, ...deletions];
    if (all.length === 1) return deleted;
    const sent = Promise.all(all.map((queued) => queued.sent)).then(() => undefined);
    sent.catch(() => undefined);
    return { ...deleted, sent };
  }

  /**
   * A Horizon admin's deletion of a team they are not the owner of. Every member document goes before
   * the team document does: a share made to the team is read by an active member of it (the rules'
   * `isRecipient`), which asks for the membership alone, not the team, so a member left behind would
   * go on reading what other teams sent to it. In order:
   * 1. The team's tombstone, alone, unless an earlier attempt wrote it; it lets the admin list and
   *    delete the team's members, and keeps the id from ever being used again.
   * 2. The members, in writes of at most DOCS_DELETED_PER_WRITE, and with the last of them the team
   *    document.
   * Each write is waited for, so it needs a connection. What else the team held stays, unreadable
   * without the team, and the shares it made stop opening for anyone once it is gone.
   */
  private async deleteTeamAsHorizonAdmin(teamId: string, name: string): Promise<Queued<void>> {
    if (!this.isOnline()) {
      throw new CloudError("unavailable", "Deleting a team as a Horizon admin needs a connection. Nothing was deleted; try again when you are online.");
    }
    const uid = this.uid();
    if ((await this.getOrNull(paths.deletedTeam(teamId))) === null) {
      await this.write("team", `Mark team ${name} deleted.`, [{ op: "set", path: paths.deletedTeam(teamId), data: { deletedBy: uid, deletedAt: SERVER_TIME } }], undefined).sent;
    }
    const members = await this.listMembers(teamId);
    const purge: Write[] = members.map((m): Write => ({ op: "delete", path: paths.member(teamId, m.uid) }));
    const groups: Write[][] = [];
    for (let start = 0; start < purge.length; start += DOCS_DELETED_PER_WRITE) groups.push(purge.slice(start, start + DOCS_DELETED_PER_WRITE));
    if (groups.length === 0) groups.push([]);
    groups[groups.length - 1]?.push({ op: "delete", path: paths.team(teamId) });
    let last: Queued<void> | null = null;
    for (const [index, writes] of groups.entries()) {
      const summary = groups.length === 1 ? `Delete team ${name} and its members.` : `Delete team ${name} and its members, part ${String(index + 1)} of ${String(groups.length)}.`;
      last = this.write("team", summary, writes, undefined);
      await last.sent;
    }
    return last as Queued<void>;
  }

  async listMembers(teamId: string): Promise<Member[]> {
    const docs = await this.store().list({ collection: paths.members(teamId) });
    return docs.map((doc) => doc.data as unknown as Member);
  }

  /**
   * Changes a member's role. Making someone an owner or admin, or making an owner or admin of the
   * newest device roster anything else, also rotates the team key in the same write, so the new
   * key's roster records the change: only an owner or admin in the newest roster makes the next one
   * (spec 14 section 4.5). Whether the member is an owner or admin comes from the roster, never from
   * their member document. Lowering an owner or admin of the roster from a device that cannot rotate
   * is refused (`CANNOT_DEMOTE_ADMIN`), since they could make the next key until it changes, and so is
   * any lowering from a device that cannot open the roster, which cannot tell. Raising a role from
   * such a device still changes it for the rules, and it counts in the roster only once an owner or
   * admin makes the change from a device that rotates.
   */
  async setRole(teamId: string, uid: string, role: ActiveRole): Promise<Queued<void>> {
    if (uid === this.uid()) throw new CloudError("invalid", "Nobody can change their own role; ask another owner or admin.");
    const member = (await this.require(paths.member(teamId, uid), "That member")) as unknown as MemberDoc;
    const writes: Write[] = [
      { op: "update", path: paths.member(teamId, uid), data: { role } },
      this.activity(teamId, "member.role", uid, role),
    ];
    let opened: OpenedTeam;
    try {
      opened = await this.keys.openTeam(teamId, { extractable: true });
    } catch (error) {
      if (!isCloudError(error, "no-key")) throw error;
      if (!ADMIN_ROLE_SET.has(role)) throw new CannotRotateError(CANNOT_DEMOTE_ADMIN);
      return this.write("member", `Make a member ${role}.`, writes, undefined);
    }
    const signed = roleIn(opened.roster, uid);
    const demotes = isAdminRole(signed) && !ADMIN_ROLE_SET.has(role);
    // A member document still waiting to join is taken at its word only for a raise, which a
    // rotation could not record for a member who is not active anyway.
    const raises = !isAdminRole(signed) && ADMIN_ROLE_SET.has(role) && ACTIVE_ROLE_SET.has(member.role);
    let rotation: Rotation | null = null;
    if (demotes || raises) {
      try {
        rotation = await this.keys.rotationWrites(teamId, {}, { opened, roles: { [uid]: role } });
        writes.push(...rotation.writes, this.activity(teamId, "key.rotate"));
        this.keys.forget(teamId);
      } catch (error) {
        if (!isCannotRotate(error)) throw error;
        if (demotes) throw new CannotRotateError(CANNOT_DEMOTE_ADMIN);
      }
    }
    return this.pinRotation(teamId, rotation, this.write("member", `Make a member ${role}.`, writes, undefined));
  }

  async approveMember(teamId: string, uid: string, input: { deviceId: string; approvalCode: string }): Promise<Queued<void>> {
    if (typeof input?.deviceId !== "string" || typeof input.approvalCode !== "string") {
      throw new CloudError("invalid", "Approving a member needs the device they asked from and the approval code it shows.");
    }
    const member = (await this.require(paths.member(teamId, uid), "That member")) as unknown as MemberDoc;
    if (member.role !== "pending") throw new CloudError("invalid", "That member is not waiting for approval.");
    const role = member.requestedRole ?? "viewer";
    // The key goes to the one device whose code the approver typed, in the write that makes the
    // member active: the rules give a grant only to a member who is active after the write.
    const request = (await this.getOrNull(keyPaths.request(teamId, input.deviceId))) as KeyRequestDoc | null;
    if (request === null || request.uid !== uid || request.deviceId !== input.deviceId) {
      throw new CloudError("not-found", "That member has not asked for the team key from that device. Ask them to open the team on it again.");
    }
    const opened = await this.openTeam(teamId, { extractable: true });
    const grants = await this.grantRequestWrites(opened, request, input.approvalCode);
    const writes: Write[] = [
      { op: "update", path: paths.member(teamId, uid), data: { role } },
      ...grants,
      this.activity(teamId, "member.approve", uid, role),
    ];
    return this.write("member", `Approve ${member.displayName} as ${role}.`, writes, undefined);
  }

  /**
   * The grant for a key request, and the request's deletion. `approvalCode` is what the approver
   * typed from the device's screen: its first part must come from the device record's keys, or this
   * throws "wrong-code", and its random part puts the MAC on the grant that the device checks.
   */
  private async grantRequestWrites(opened: OpenedTeam, request: KeyRequestDoc, approvalCode: string): Promise<Write[]> {
    const record = await this.keys.deviceRecordOf(request.uid, request.deviceId);
    if (record === null) throw new CloudError("not-found", "That device has no public keys on the server, so it cannot be given the team key. Ask for the request again from the device.");
    const secret = await guarded("The approval code", () =>
      approvalSecretFrom(approvalCode, { teamId: opened.teamId, uid: request.uid, fingerprint: record.fingerprint }),
    );
    if (secret === null) {
      throw new CloudError("wrong-code", "That code does not match the device waiting for approval. Check it against the code on that device's screen, character by character.");
    }
    const existing = await this.keys.grantOf(opened.teamId, request.deviceId);
    return [
      await this.keys.grantWrite(opened, { uid: request.uid, deviceId: request.deviceId, record }, existing, { approvalSecret: secret }),
      { op: "delete", path: keyPaths.request(opened.teamId, request.deviceId) },
    ];
  }

  /**
   * Removes a member and, in the same write, rotates the team key to every device that stays
   * (spec 14 section 4.5). A device that cannot rotate (it does not hold the newest key, or the
   * newest device roster gives it no authority to make the next) removes the member, deletes their
   * grants and marks the key "rotation pending" instead, unless the member is an owner or admin in
   * the newest roster: they could make the next key themselves until it changes, so that is refused
   * (`CANNOT_REMOVE_ADMIN`). A device that cannot open the roster cannot tell, so it refuses too.
   *
   * A member still waiting to join is declined with no new key. Their member document saying so is
   * the server's word, so it counts only when this device opens the roster, the roster does not name
   * them, and they hold no grant; otherwise they are removed like anyone else.
   */
  async removeMember(teamId: string, uid: string): Promise<Queued<void>> {
    if (uid === this.uid()) return this.leaveTeam(teamId);
    const member = (await this.require(paths.member(teamId, uid), "That member")) as unknown as MemberDoc;
    const removal: Write[] = [
      { op: "delete", path: paths.member(teamId, uid) },
      this.activity(teamId, "member.remove", uid),
    ];
    const grants = await this.store().list({ collection: keyPaths.grants(teamId), where: [{ field: "uid", value: uid }] });
    // Nothing the server shows can prove a member holds no grant: it can call her pending and leave her
    // grant out of the listing. So a device that can make the next key always does, and only one that
    // cannot declines without a new key, and marks the key pending in case she held it after all.
    if (member.role === "pending" && grants.length === 0 && (await this.rosterNames(teamId, uid)) === false && !(await this.mayMakeNextKeyHere(teamId))) {
      const requests = await this.store().list({ collection: keyPaths.requests(teamId), where: [{ field: "uid", value: uid }] });
      return this.write("member", "Decline a request to join.", [
        ...removal,
        ...requests.map((doc): Write => ({ op: "delete", path: doc.path })),
        { op: "update", path: paths.team(teamId), data: { rotationPending: true } },
      ], undefined);
    }
    let keyWrites: Write[];
    let rotation: Rotation | null = null;
    try {
      rotation = await this.keys.rotationWrites(teamId, { uids: [uid] });
      keyWrites = [...rotation.writes, this.activity(teamId, "key.rotate", uid)];
    } catch (error) {
      if (!isCloudError(error, "no-key") && !isCannotRotate(error)) throw error;
      if (await this.mayMakeNextKey(teamId, uid)) throw new CannotRotateError(CANNOT_REMOVE_ADMIN);
      // A key the server withheld during the rotation, from a device the roster lets rotate, fails the
      // removal: marking the key pending instead would let the server keep the member's key current.
      if (isCloudError(error, "no-key") && (await this.mayMakeNextKeyHere(teamId))) throw new CloudError("no-key", REMOVE_NEEDS_KEY_CHANGE);
      keyWrites = [
        ...grants.map((doc): Write => ({ op: "delete", path: doc.path })),
        { op: "update", path: paths.team(teamId), data: { rotationPending: true } },
      ];
    }
    this.keys.forget(teamId);
    return this.pinRotation(teamId, rotation, this.write("member", "Remove a member.", [...removal, ...keyWrites], undefined));
  }

  /** Whether the newest device roster names `uid`, or null when this device cannot open it. */
  private async rosterNames(teamId: string, uid: string): Promise<boolean | null> {
    try {
      return roleIn((await this.keys.openTeam(teamId)).roster, uid) !== null;
    } catch (error) {
      if (!isCloudError(error, "no-key")) throw error;
      return null;
    }
  }

  /**
   * Pins the version `rotation` made once the server acknowledges `queued`, so a server that then puts
   * back the state from before is refused as an older one. A refused write pins nothing.
   */
  private pinRotation<T>(teamId: string, rotation: Rotation | null, queued: Queued<T>): Queued<T> {
    if (rotation === null) return queued;
    const uid = this.uid();
    // Once the new key is stored, this device carries the shares the new roster lists forward to it,
    // so a partner that sees the new key still opens them. `sent` settles after that, so nothing this
    // device does next races the carrying writes. A run that fails, or never happens because this
    // device goes away, is finished by the next device of the team that runs it.
    const sent = queued.sent.then(async () => {
      writePin(this.trust, uid, "team", teamId, rotation.encKey, rotation.rosterDigest);
      this.keys.forget(teamId);
      try {
        await this.carryForwardShares(teamId);
      } catch {
        // The key change itself is stored; the shares wait for the next run.
      }
    });
    sent.catch(() => undefined);
    return { ...queued, sent };
  }
  /** True when this device could make the next device roster, and false when it cannot open the roster. */
  private async mayMakeNextKeyHere(teamId: string): Promise<boolean> {
    try {
      return await this.keys.mayMakeNextRoster(await this.keys.openTeam(teamId), (await this.keys.device()).deviceId);
    } catch (error) {
      if (!isCloudError(error, "no-key")) throw error;
      return false;
    }
  }
  /**
   * True when `uid` is an owner or admin in the newest device roster, so a device of theirs could
   * make the next one, and when this device cannot open the roster, since it then cannot tell.
   */
  private async mayMakeNextKey(teamId: string, uid: string): Promise<boolean> {
    try {
      return isAdminRole(roleIn((await this.keys.openTeam(teamId)).roster, uid));
    } catch (error) {
      if (!isCloudError(error, "no-key")) throw error;
      return true;
    }
  }

  /**
   * The writes that take a leaving member's keys out of a team: their grants and key requests, and,
   * for an active member, the "rotation pending" mark (spec 14 section 4.5), since the device that
   * is leaving cannot rotate fairly.
   */
  private async leaveWrites(teamId: string, role: MemberDoc["role"]): Promise<Write[]> {
    const uid = this.uid();
    const own = { field: "uid", value: uid };
    const writes: Write[] = [];
    // Every grant goes, whatever the member document says the role is: it is the server's word. A
    // member still waiting may not list grants, and holds none.
    const grants = await this.store().list({ collection: keyPaths.grants(teamId), where: [own] }).catch((error: unknown) => {
      if (isCloudError(error, "permission-denied")) return [];
      throw error;
    });
    for (const doc of grants) writes.push({ op: "delete", path: doc.path });
    for (const doc of await this.store().list({ collection: keyPaths.requests(teamId), where: [own] })) writes.push({ op: "delete", path: doc.path });
    if (ACTIVE_ROLE_SET.has(role) && role !== "owner") writes.push({ op: "update", path: paths.team(teamId), data: { rotationPending: true } });
    return writes;
  }

  async leaveTeam(teamId: string): Promise<Queued<void>> {
    const uid = this.uid();
    const member = (await this.require(paths.member(teamId, uid), "Your membership")) as unknown as MemberDoc;
    const keyWrites = await this.leaveWrites(teamId, member.role);
    this.keys.forget(teamId);
    // The activity entry goes first: once the membership is deleted, the rules no longer let this
    // user write to the team. Both are in one write, and the rules read memberships as they were
    // before it.
    return this.write("member", "Leave the team.", [
      this.activity(teamId, "member.leave", uid),
      ...keyWrites,
      { op: "delete", path: paths.member(teamId, uid) },
    ], undefined);
  }

  async getTeamSettings(teamId: string): Promise<TeamSettings> {
    // A query rather than a get: offline, the SDK answers a query from its cache even when the
    // document has never existed, while a get of a missing document fails (ADR 0009 section 3).
    const docs = await this.store().list({ collection: paths.settingsCollection(teamId) });
    const data = (docs.find((doc) => doc.path === paths.settings(teamId))?.data ?? null) as TeamSettingsDoc | null;
    return {
      editorsMayProposeShare: data?.editorsMayProposeShare ?? false,
      editorsMayLinkShare: data?.editorsMayLinkShare ?? false,
      publishOnSave: data?.publishOnSave ?? false,
      membersMayApproveDevices: data?.membersMayApproveDevices ?? false,
    };
  }

  /**
   * Changes the team's sharing settings. Turning `membersMayApproveDevices` on or off also rotates the
   * team key in the same write when the newest device roster says otherwise, so the new roster
   * records it: a rotation judges approvals by the roster alone, never by the setting the server
   * holds (spec 14 section 4.5). Turning it on from a device that cannot rotate still changes it for
   * the rules, and a rotation counts it only once an owner or admin sets it from a device that can.
   * Turning it off while the roster has it on, from a device that cannot rotate or cannot open the
   * roster, is refused (`CANNOT_STOP_MEMBER_APPROVALS`): members' approvals would still count at the
   * next rotation.
   */
  async updateTeamSettings(teamId: string, patch: Partial<TeamSettingsDoc>): Promise<Queued<void>> {
    const next = { ...(await this.getTeamSettings(teamId)), ...patch };
    const writes: Write[] = [
      { op: "set", path: paths.settings(teamId), data: { ...next } },
      this.activity(teamId, "settings.change", "sharing", JSON.stringify(patch)),
    ];
    let rotation: Rotation | null = null;
    if (typeof patch.membersMayApproveDevices === "boolean") {
      const wanted = patch.membersMayApproveDevices;
      let opened: OpenedTeam | null = null;
      try {
        opened = await this.keys.openTeam(teamId, { extractable: true });
      } catch (error) {
        if (!isCloudError(error, "no-key")) throw error;
      }
      if (opened === null) {
        if (!wanted) throw new CannotRotateError(CANNOT_STOP_MEMBER_APPROVALS);
      } else if (opened.roster.membersMayApprove !== wanted) {
        try {
          rotation = await this.keys.rotationWrites(teamId, {}, { opened, membersMayApprove: wanted });
          writes.push(...rotation.writes, this.activity(teamId, "key.rotate"));
          this.keys.forget(teamId);
        } catch (error) {
          if (!isCannotRotate(error)) throw error;
          if (!wanted) throw new CannotRotateError(CANNOT_STOP_MEMBER_APPROVALS);
        }
      }
    }
    return this.pinRotation(teamId, rotation, this.write("settings", "Change the team's sharing settings.", writes, undefined));
  }

  async listActivity(teamId: string): Promise<ActivityEntry[]> {
    const docs = await this.store().list({ collection: paths.activity(teamId) });
    const opened = await this.openTeamOrNull(teamId);
    const entries: ActivityEntry[] = [];
    for (const doc of docs) entries.push(await this.toActivity(teamId, opened, doc));
    return entries.sort((a, b) => b.at.getTime() - a.at.getTime() || b.id.localeCompare(a.id));
  }

  /** An activity entry with an `auto.create` entry's sealed title opened, or left out when it cannot be. */
  private async toActivity(teamId: string, opened: OpenedTeam | null, doc: StoredDoc): Promise<ActivityEntry> {
    const { detail, ...rest } = doc.data as unknown as ActivityDoc;
    const entry: ActivityEntry = { id: doc.id, ...rest };
    if (typeof detail === "string") entry.detail = detail;
    else if (detail !== undefined && opened !== null) {
      try {
        entry.detail = await openText(teamKeyAt(opened, detail.kv), detail, aadFor.activityDetail({ teamId, entryId: doc.id, kv: detail.kv }));
      } catch (error) {
        // A log entry that does not open loses only its title; the rest of the log still shows.
        if (!isCloudError(error, "tampered") && !(error instanceof Error && error.name === "CryptoError")) throw error;
      }
    }
    return entry;
  }

  // ------------------------------------------------------------ invites

  async createInvite(teamId: string, input: CreateInviteInput): Promise<Queued<Invite>> {
    const uid = this.uid();
    const maxUses = input.maxUses ?? 1;
    if (!Number.isInteger(maxUses) || maxUses < 1) throw new CloudError("invalid", "An invite must allow at least one use.");
    const expiresInS = input.expiresInS ?? DEFAULT_EXPIRY_S;
    if (!(expiresInS > 0)) throw new CloudError("invalid", "An invite must expire after the moment it is made.");
    if (input.role === "admin" && input.autoApprove === true) {
      throw new CloudError("invalid", "An admin invite cannot let people in at once. An owner or admin approves each one.");
    }
    const code = randomId(this.random);
    const doc: InviteDoc = {
      teamId,
      role: input.role,
      expiresAt: this.expiry(expiresInS),
      maxUses,
      uses: 0,
      autoApprove: input.autoApprove ?? false,
      createdBy: uid,
      createdAt: this.now(),
      revoked: false,
    };
    return this.write("invite", `Invite a new ${input.role}.`, [
      { op: "set", path: paths.invite(code), data: { ...doc, createdAt: SERVER_TIME } },
      this.activity(teamId, "invite.create", code, input.role),
    ], { code, ...doc });
  }

  async getInvite(code: string): Promise<Invite | null> {
    const data = await this.getOrNull(paths.invite(code));
    return data === null ? null : { code, ...(data as unknown as InviteDoc) };
  }

  async redeemInvite(code: string): Promise<Queued<Member>> {
    const uid = this.uid();
    const invite = await this.getInvite(code);
    if (invite === null) throw new CloudError("not-found", "That invite does not exist. Check the link, or ask for a new one.");
    if (invite.revoked) throw new CloudError("invalid", "That invite was withdrawn. Ask the team for a new one.");
    if (invite.expiresAt.getTime() <= this.now().getTime()) throw new CloudError("invalid", "That invite has expired. Ask the team for a new one.");
    if (invite.uses >= invite.maxUses) throw new CloudError("invalid", "That invite has been used up. Ask the team for a new one.");
    const displayName = await this.displayName();
    const role = invite.autoApprove && invite.role !== "admin" ? invite.role : "pending";
    const member: MemberDoc = {
      uid,
      teamId: invite.teamId,
      role,
      displayName,
      joinedAt: this.now(),
      invite: code,
      requestedRole: invite.role,
    };
    // The same write asks for the team key for this device (spec 14 section 4.3), which shows a new
    // approval code for it.
    const device = await this.keys.device();
    const registration = await this.keys.registration();
    clearApprovalSecret(this.trust, uid, invite.teamId);
    await this.approvalCode(invite.teamId);
    return this.writeRegistered("member", role === "pending" ? "Ask to join a team." : "Join a team.", registration, [
      { op: "set", path: paths.member(invite.teamId, uid), data: { ...member, joinedAt: SERVER_TIME } },
      { op: "update", path: paths.invite(code), data: { uses: invite.uses + 1 } },
      { op: "set", path: keyPaths.request(invite.teamId, device.deviceId), data: { uid, deviceId: device.deviceId, createdAt: SERVER_TIME } },
      this.activity(invite.teamId, "member.join", uid, role),
    ], member);
  }

  private async changeInvite(code: string, patch: DocData, kind: ActivityKind, summary: string): Promise<Queued<void>> {
    const invite = await this.getInvite(code);
    if (invite === null) throw new CloudError("not-found", "That invite does not exist, or you cannot open it.");
    return this.write("invite", summary, [
      { op: "update", path: paths.invite(code), data: patch },
      this.activity(invite.teamId, kind, code),
    ], undefined);
  }

  async extendInvite(code: string, expiresAt: Date): Promise<Queued<void>> {
    return this.changeInvite(code, { expiresAt }, "invite.extend", "Extend an invite.");
  }

  async revokeInvite(code: string): Promise<Queued<void>> {
    return this.changeInvite(code, { revoked: true }, "invite.revoke", "Withdraw an invite.");
  }

  async listInvites(teamId: string): Promise<Invite[]> {
    const created = await this.store().list({ collection: paths.activity(teamId), where: [{ field: "kind", value: "invite.create" }] });
    const invites: Invite[] = [];
    for (const entry of created) {
      const code = entry.data.target;
      if (typeof code !== "string") continue;
      const invite = await this.getInvite(code);
      if (invite !== null) invites.push(invite);
    }
    return invites.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  // ------------------------------------------------------------ library

  async createAuto(teamId: string, input: { title: string }): Promise<Queued<AutoRecord>> {
    const title = input.title.trim();
    if (title.length === 0 || title.length > 200) throw new CloudError("invalid", "An auto's title must have 1 to 200 characters.");
    const opened = await this.openTeamToSeal(teamId);
    const autoId = randomId(this.random);
    const entryId = randomId(this.random);
    const kv = opened.newest.key.version;
    const sealedTitle = await this.sealForTeam(opened, title, aadFor.autoTitle({ teamId, autoId, gen: 1, kv }));
    const sealedDetail = await this.sealForTeam(opened, title, aadFor.activityDetail({ teamId, entryId, kv }));
    refuseSealedOversize(sealedTitle, MAX_TITLE_CIPHERTEXT_BYTES, "That title");
    refuseSealedOversize(sealedDetail, MAX_TITLE_CIPHERTEXT_BYTES, "That title");
    const uid = this.uid();
    const value: AutoRecord = { id: autoId, teamId, title, createdBy: uid, createdAt: this.now(), updatedAt: this.now() };
    return this.write("auto", `Add ${title} to the team library.`, [
      { op: "set", path: paths.auto(teamId, autoId), data: { title: sealedTitle, titleGen: 1, createdBy: uid, createdAt: SERVER_TIME, updatedAt: SERVER_TIME } },
      this.activityAt(teamId, entryId, "auto.create", autoId, sealedDetail),
    ], value);
  }

  async listAutos(teamId: string): Promise<AutoRecord[]> {
    const docs = await this.store().list({ collection: paths.autos(teamId) });
    if (docs.length === 0) return [];
    const opened = await this.openTeam(teamId);
    const uid = this.uid();
    const autos: AutoRecord[] = [];
    for (const doc of docs) {
      const { title, titleGen, ...rest } = doc.data as unknown as AutoDoc;
      if (!isKeyVersion(titleGen)) throw new CloudError("tampered", "An auto's title has no valid generation, so it is not shown.");
      // The generation is sealed into the title, so an older title put back comes with its own older
      // generation, which this device refuses once it has read a newer one.
      const seen = readTitlePin(this.trust, uid, teamId, doc.id);
      if (seen !== null && titleGen < seen) {
        throw new CloudError("tampered", "An auto's title is older than one this device already read, so the server may have put an old one back. It is not shown.");
      }
      const opens = await guarded("An auto's title", () => openText(teamKeyAt(opened, title.kv), title, aadFor.autoTitle({ teamId, autoId: doc.id, gen: titleGen, kv: title.kv })));
      writeTitlePin(this.trust, uid, teamId, doc.id, titleGen);
      autos.push({ id: doc.id, teamId, ...rest, title: opens });
    }
    return autos.sort((a, b) => a.title.localeCompare(b.title));
  }

  /** A revision document with its four files opened. */
  private async toRevision(opened: OpenedTeam, autoId: string, doc: StoredDoc): Promise<Revision> {
    const teamId = opened.teamId;
    const { content, robot, field, waypoints, gitSha, ...rest } = doc.data as unknown as RevisionDoc;
    const open = (envelope: Envelope, name: RevisionField) =>
      guarded("A revision", () =>
        openText(teamKeyAt(opened, envelope.kv), envelope, aadFor.revision({ teamId, autoId, revisionId: doc.id, field: name, kv: envelope.kv })),
      );
    const revision: Revision = { id: doc.id, teamId, autoId, ...rest, content: await open(content, "content") };
    if (gitSha !== undefined) revision.gitSha = await open(gitSha, "gitSha");
    if (robot !== undefined) revision.robot = await open(robot, "robot");
    if (field !== undefined) revision.field = await open(field, "field");
    if (waypoints !== undefined) revision.waypoints = await open(waypoints, "waypoints");
    return revision;
  }

  async listRevisions(teamId: string, autoId: string): Promise<Revision[]> {
    const docs = await this.store().list({ collection: paths.revisions(teamId, autoId) });
    if (docs.length === 0) return [];
    const opened = await this.openTeam(teamId);
    const revisions: Revision[] = [];
    for (const doc of docs) revisions.push(await this.toRevision(opened, autoId, doc));
    const earlier = (a: Revision, b: Revision) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id);
    revisions.sort((a, b) => a.n - b.n || earlier(a, b));
    return revisions.map((r) => ({
      ...r,
      diverged: r.diverged || revisions.some((s) => s.id !== r.id && s.baseRevision === r.baseRevision && earlier(s, r) < 0),
    }));
  }

  async openRevision(teamId: string, autoId: string, id: string): Promise<Revision | null> {
    const path = paths.revision(teamId, autoId, id);
    const data = await this.getOrNull(path);
    if (data === null) return null;
    return this.toRevision(await this.openTeam(teamId), autoId, { path, id, data });
  }

  async publishRevision(input: PublishInput): Promise<Queued<Revision>> {
    const uid = this.uid();
    if (input.content.length === 0) throw new CloudError("invalid", "An empty auto cannot be published.");
    if (input.gitSha !== undefined && !/^[0-9a-f]{7,40}$/.test(input.gitSha)) {
      throw new CloudError("invalid", "A git commit id is 7 to 40 lowercase hexadecimal characters.");
    }
    const opened = await this.openTeamToSeal(input.teamId);
    let n = 1;
    if (input.baseRevision !== null) {
      const base = (await this.getOrNull(paths.revision(input.teamId, input.autoId, input.baseRevision))) as RevisionDoc | null;
      if (base === null) throw new CloudError("not-found", "The revision this auto was edited from is not in the library.");
      n = base.n + 1;
    }
    // Diverged when this device already knows the base is not the newest revision. Every revision
    // numbered above n descends, one number at a time, from one numbered exactly n, so a query for
    // the siblings on n answers that without reading the whole history (and its quota).
    const siblings = await this.store().list({
      collection: paths.revisions(input.teamId, input.autoId),
      where: [{ field: "n", value: n }],
    });
    const diverged = siblings.length > 0;
    const id = revisionId(n, this.random);
    const kv = opened.newest.key.version;
    const seal = async (text: string, field: RevisionField): Promise<Envelope> => {
      const envelope = await this.sealForTeam(opened, text, aadFor.revision({ teamId: input.teamId, autoId: input.autoId, revisionId: id, field, kv }));
      refuseSealedOversize(envelope, MAX_REVISION_FIELD_BYTES, field === "content" ? "The auto" : field === "gitSha" ? "The git commit id" : `The ${field} file`);
      return envelope;
    };
    const sealed: DocData = { n, baseRevision: input.baseRevision, author: uid, content: await seal(input.content, "content"), diverged };
    const value: Revision = { id, teamId: input.teamId, autoId: input.autoId, n, baseRevision: input.baseRevision, author: uid, createdAt: this.now(), content: input.content, diverged };
    if (input.gitSha !== undefined) {
      sealed.gitSha = await seal(input.gitSha, "gitSha");
      value.gitSha = input.gitSha;
    }
    if (input.robot !== undefined) {
      sealed.robot = await seal(input.robot, "robot");
      value.robot = input.robot;
    }
    if (input.field !== undefined) {
      sealed.field = await seal(input.field, "field");
      value.field = input.field;
    }
    if (input.waypoints !== undefined) {
      sealed.waypoints = await seal(input.waypoints, "waypoints");
      value.waypoints = input.waypoints;
    }

    const path = paths.revision(input.teamId, input.autoId, id);
    const writes: Write[] = [
      { op: "set", path, data: { ...sealed, createdAt: SERVER_TIME } },
      this.activity(input.teamId, "revision.publish", input.autoId, id),
    ];
    // A following share whose key a removed member or revoked device may hold moves to a new key here.
    // Each share's manifest must say it follows this auto, is not revoked and has not ended, and is
    // signed again for the new revision; a share the team's newest key neither signed nor listed gets
    // nothing (someone taken off the team, or a revoked device, may have made it).
    const resigned = new Map<string, Signed>();
    if (input.followProjection !== undefined) {
      refuseOversize(input.followProjection, MAX_SHARE_PROJECTION_BYTES, "What a following share would show");
      const shares = await this.store().list({ collection: paths.shares(), where: [{ field: "ownerTeamId", value: input.teamId }] });
      for (const doc of shares) {
        const share = doc.data as unknown as ShareDoc;
        if (share.autoId !== input.autoId || share.mode !== "follow" || share.revokedAt !== null || isPast(share.expiresAt, this.now())) continue;
        let moved: { fields: DocData; signed: Signed };
        try {
          moved = await this.projectionFields(doc.id, share, opened, input.followProjection, id, input.autoId);
        } catch (error) {
          if (isNotListed(error) || isEnded(error)) continue;
          throw error;
        }
        resigned.set(doc.id, moved.signed);
        writes.push({ op: "update", path: paths.share(doc.id), data: { revision: id, ...moved.fields, updatedAt: SERVER_TIME } });
      }
    }
    const summary = `Publish revision ${String(n)}${diverged ? ", diverged," : ""} to the team library.`;
    const queued = this.write("publish", summary, writes, value);
    // A revision can never be overwritten, so if the server refuses the write because the document
    // already exists with this content (a resend after a lost acknowledgement), it did arrive.
    const content = sealed.content as Envelope;
    const sent = queued.sent.catch(async (error: unknown) => {
      if (isCloudError(error, "permission-denied")) {
        const stored = await this.getOrNull(path).catch(() => null);
        const storedContent = stored?.content as Envelope | undefined;
        if (stored !== null && stored.author === uid && storedContent !== undefined && storedContent.ct instanceof Uint8Array && bytesEqual(storedContent.iv, content.iv) && bytesEqual(storedContent.ct, content.ct)) return;
      }
      throw error;
    });
    sent.catch(() => undefined);
    this.pinSharesWhenSent(sent, resigned);
    return { ...queued, sent };
  }

  async saveForOffline(teamId: string): Promise<void> {
    // Opening the team reads its grant and key records, so they are in the cache too.
    const autos = await this.listAutos(teamId);
    for (const auto of autos) await this.listRevisions(teamId, auto.id);
    await this.listMembers(teamId);
    await this.getTeamSettings(teamId);
    await this.listReceivedShares(teamId);
  }

  // ------------------------------------------------------------ sharing

  // Share keys (spec 14 sections 4.6 and 4.7). A share to teams has a random share key, wrapped to
  // each recipient team's public key and sealed under the owner team's key; a link share's key and
  // id come from the secret in its link, which the owner team's key also seals.

  /** A share document as stored, or null when it does not exist or the caller may not read it. */
  private async shareDoc(shareId: string): Promise<ShareDoc | null> {
    return (await this.getOrNull(paths.share(shareId))) as ShareDoc | null;
  }

  /**
   * A link share's secret, opened by its owner team: under the team key its manifest names, for the
   * auto it names, the secret its id comes from, and the one whose key the manifest commits to.
   */
  private async linkSecretOf(shareId: string, doc: ShareDoc, team: OpenedTeam, manifest: ShareManifestBody): Promise<Uint8Array> {
    const wrap = doc.linkWrap;
    if (wrap === undefined) throw new CloudError("tampered", "This link share has no sealed secret, so its link cannot be opened.");
    if (wrap.kv !== manifest.wkv) throw new CloudError("tampered", "This link share's secret is not under the team key its manifest names.");
    return guarded("A link share's secret", async () => {
      const secret = await unwrapLinkSecretAsOwner({ shareId, teamId: doc.ownerTeamId, autoId: manifest.autoId, wrap, teamKey: teamKeyAt(team, wrap.kv) });
      if ((await deriveLinkId(secret)) !== shareId) throw new CloudError("tampered", "This link share's secret is not the one its id comes from.");
      if (!bytesEqual(await commitLinkKey({ shareId, secret }), manifest.commit)) {
        throw new CloudError("tampered", "This link share's secret is not the one its manifest names.");
      }
      return secret;
    });
  }

  /**
   * The key a share's projection is sealed under now, and the manifest it was checked against. A wrap
   * to a team's public key proves nothing about who made the key, since anyone may wrap to a public
   * key, and a share's plain fields are the server's to write, so the key is used only when the
   * share's manifest is signed by the owner team's key of the version it names, says what the share's
   * fields say, is for this share and this key version, names the wrap this device opened, and commits
   * to the key it opened. The owner team's own devices also need the manifest to be live
   * (`vouchedManifest`). A share opened by its link alone is checked by the link: its key comes from
   * the secret in it, and the projection is bound to the share and the auto.
   */
  private async openShareKey(shareId: string, doc: ShareDoc, access: ShareAccess, extractable = false): Promise<OpenedShareKey> {
    const kv = doc.projection.kv;
    if (access.kind === "link") return { key: await guarded("A link share", () => deriveLinkKey(access.secret)), manifest: null };
    if (doc.audience === "link" && access.kind !== "owner") throw new CloudError("no-key", "A link share opens only with its link.");
    // A share's key only moves forward (a new one when a team is taken off), so a version older
    // than one this device used is the server putting back a key a removed team still holds.
    const uid = this.uid();
    const seen = readShareKeyPin(this.trust, uid, shareId);
    if (seen !== null && kv < seen) {
      throw new CloudError(
        "tampered",
        "This share's key is older than one this device already used, so the server may have put back a key a team taken off the share still has. Nothing is opened or sent.",
      );
    }
    const { body, pin } = await this.checkedManifest(shareId, doc, access);
    let key: ShareKey;
    if (access.kind === "owner") {
      await this.vouchedManifest(shareId, doc, body, access.team);
      if (doc.audience === "link") {
        const secret = await this.linkSecretOf(shareId, doc, access.team, body);
        key = await guarded("A link share", () => deriveLinkKey(secret));
      } else {
        const wrap = doc.ownerWrap;
        if (wrap === undefined) throw new CloudError("tampered", "This share has no key for the team that made it.");
        if (wrap.kv !== body.wkv) throw new CloudError("tampered", "This share's key for the team that made it is not under the team key its manifest names.");
        key = await guarded("A share's key", () =>
          unwrapShareKeyAsOwner({ shareId, teamId: doc.ownerTeamId, shareKeyVersion: kv, wrap, teamKey: teamKeyAt(access.team, wrap.kv), extractable, commit: body.commit }),
        );
      }
    } else {
      const teamId = access.team.teamId;
      const wrap = doc.keyWraps?.[teamId];
      if (wrap === undefined) throw new CloudError("tampered", "This share has no key for your team.");
      const signed = body.teams.find(([id]) => id === teamId);
      if (signed === undefined || signed[1] !== wrap.ekv) throw new CloudError("tampered", "This share's key for your team is not the one its manifest names.");
      // The manifest names the key the sharer wrapped to. A re-key follows that key, so one that is
      // not this team's own is refused here, where this team can see it and tell the sharer.
      const own = teamPairAt(access.team, wrap.ekv);
      const digest = await guarded("A share's key", () => teamKeyDigest({ teamId, v: wrap.ekv, fingerprint: own.fingerprint, signSpki: own.signSpki }));
      if (!bytesEqual(digest, signed[2])) {
        throw new CloudError("tampered", "This share's manifest names a key for your team that is not your team's key, so a later update of it could go to someone else. Nothing is opened. Tell the team that shared it.");
      }
      key = await guarded("A share's key", () =>
        unwrapShareKeyAsTeam({ shareId, teamId, shareKeyVersion: kv, wrap, pair: teamPairAt(access.team, wrap.ekv), extractable, commit: body.commit }),
      );
    }
    pin();
    writeShareKeyPin(this.trust, uid, shareId, key.version);
    writeShareSignerPin(this.trust, uid, shareId, body.okv);
    writeShareSeqPin(this.trust, uid, shareId, body.seq);
    writeShareTermsPin(this.trust, uid, shareId, body.termsSeq);
    return { key, manifest: body };
  }

  /** `openShareKey` as the owner team, which always has a manifest to check. */
  private async ownedShareKey(shareId: string, doc: ShareDoc, owner: OpenedTeam, extractable = false): Promise<OwnedShareKey> {
    const { key, manifest } = await this.openShareKey(shareId, doc, { kind: "owner", team: owner }, extractable);
    if (manifest === null) throw new CloudError("tampered", SHARE_WITHOUT_MANIFEST);
    return { key, manifest };
  }

  /**
   * A share's manifest, verified with the owner team's signing key of the version `okv` it names,
   * from what this device trusts: the key chain it opened, for the owner team's own devices, and
   * otherwise this device's pin of the owner team, walked forward through the team's signed
   * rotations when the manifest is newer. It must be for this share and its owner team, for the
   * share key version the projection is under, and say exactly what the share's plain fields say:
   * its auto and revision, audience, teams, level, mode, end and whether it is revoked. Its device
   * signature and its terms signature must verify too, each with the keys the manifest carries for
   * the device it names (`openShareManifest`), so terms changed under an honest terms signature are
   * refused here, by every device; whether those devices are ones the owner team keeps is for the
   * owner team's devices alone to ask (`vouchedManifest`). Its `okv` may not be older than one this
   * device has seen sign the share, nor its `seq` or `tseq` lower than one this device has seen.
   * `pin` raises this device's pin of the owner team to `okv`, once the key the manifest names has
   * opened.
   */
  private async checkedManifest(shareId: string, doc: ShareDoc, access: ShareAccess & { kind: "owner" | "recipient" }): Promise<{ body: ShareManifestBody; pin: () => void }> {
    const manifest: ShareManifest | undefined = doc.manifest;
    if (manifest === undefined || manifest === null) throw new CloudError("tampered", SHARE_WITHOUT_MANIFEST);
    const claimed = await guarded("A share's manifest", async () => readShareManifest(manifest));
    const uid = this.uid();
    const signer = readShareSignerPin(this.trust, uid, shareId);
    if (signer !== null && claimed.okv < signer) throw new CloudError("tampered", SHARE_SIGNED_WITH_OLDER_KEY);
    const seq = readShareSeqPin(this.trust, uid, shareId);
    if (seq !== null && claimed.seq < seq) throw new CloudError("tampered", SHARE_MANIFEST_OLDER);
    const termsSeq = readShareTermsPin(this.trust, uid, shareId);
    if (termsSeq !== null && claimed.termsSeq < termsSeq) throw new CloudError("tampered", SHARE_TERMS_OLDER);
    let signSpki: Uint8Array;
    let pin = (): void => undefined;
    if (access.kind === "owner") {
      const version = access.team.chain.get(claimed.okv);
      if (version === undefined) throw new CloudError("tampered", "This share's manifest names a key of your team that its key records do not hold.");
      signSpki = version.pair.signSpki;
    } else {
      ({ signSpki, pin } = await this.partnerSigningKey(doc.ownerTeamId, claimed.okv));
    }
    const body = await guarded("A share's manifest", () => openShareManifest({ manifest, signSpki }));
    if (body.shareId !== shareId || body.ownerTeamId !== doc.ownerTeamId) throw new CloudError("tampered", "This share's manifest was made for another share.");
    if (body.skv !== doc.projection.kv) throw new CloudError("tampered", "This share's key is not the version its manifest names.");
    // Every manifest signed since 2026-10-11 names the projection it was signed with (`prj`). One that
    // names none, from before, would let an older projection under the same share key be served
    // beside it, so it is refused (security review L1); its share shows again once it is published.
    if (body.projection === undefined) throw new CloudError("tampered", SHARE_PROJECTION_NOT_SIGNED);
    const projection = await guarded("A share's projection", () => shareProjectionDigest({ shareId, projection: doc.projection }));
    if (!bytesEqual(projection, body.projection)) throw new CloudError("tampered", SHARE_PROJECTION_NOT_SIGNED);
    const named = body.teams.map(([teamId]) => teamId);
    const teamIds = Array.isArray(doc.teamIds) ? doc.teamIds : [];
    if (named.length !== new Set(teamIds).size || !teamIds.every((teamId) => named.includes(teamId))) {
      throw new CloudError("tampered", "This share names other teams than its manifest does.");
    }
    if (
      body.autoId !== doc.autoId ||
      body.revisionId !== doc.revision ||
      !(doc.expiresAt instanceof Date) ||
      body.expiresAtMs !== doc.expiresAt.getTime() ||
      body.audience !== doc.audience ||
      body.mode !== doc.mode ||
      body.level !== doc.level ||
      body.revoked !== (doc.revokedAt !== null && doc.revokedAt !== undefined)
    ) {
      throw new CloudError("tampered", SHARE_TERMS_CHANGED);
    }
    return { body, pin };
  }

  /**
   * Throws "tampered" (`SHARE_NOT_LISTED`) unless the owner team's device `team` may seal into, re-key
   * or sign again the share whose verified manifest is `body`: the manifest is signed with the team's
   * newest key, or it is the manifest the newest device roster lists for the share, signed by a
   * device that roster holds, with terms signed only by devices that roster holds. A member taken
   * off the team, or a device the team took the key from, kept the key before the newest, and with
   * it could sign any manifest of that version, for any auto and any team; the roster's list is how
   * the device that rotated vouches for the shares the team had then, and it lists only those last
   * signed, and whose terms were signed, by devices it kept (`liveSharesAt`). Returns the manifest's
   * digest.
   *
   * A manifest signed with the newest key is not asked who signed it or its terms here: the roster
   * that would say whether those devices are kept is the one made at the last rotation, and a device
   * granted since is not in it. So a share forged with the newest key, or an honest share whose terms
   * were changed with it, by someone who still holds it, is signed again by every publish until the
   * next rotation, which is where it stops (`liveSharesAt`). Until then the forger holds the key and
   * can read everything anyway. Every manifest signed again either carries the terms signature it
   * replaces unchanged or adds its own device to the terms signers (`signedManifest`), so that check
   * still sees every device that chose the terms.
   */
  private async vouchedManifest(shareId: string, doc: ShareDoc, body: ShareManifestBody, team: OpenedTeam): Promise<Uint8Array> {
    const digest = await guarded("A share's manifest", () => shareManifestDigest(doc.manifest));
    if (body.okv === team.newest.key.version) return digest;
    const listed = (team.roster.shares ?? []).find((entry) => entry.shareId === shareId);
    if (
      listed !== undefined &&
      bytesEqual(listed.digest, digest) &&
      signedByOneOf(doc.manifest, body, team.roster.devices) &&
      termsSignedByOneOf(doc.manifest, body, team.roster.devices)
    ) {
      return digest;
    }
    throw new CloudError("tampered", SHARE_NOT_LISTED);
  }

  /**
   * The team's shares a rotation from `opened`, the newest version this device holds, lists in the
   * next roster: each whose manifest this device checks, finds live (`vouchedManifest`), not revoked,
   * signed by one of `kept`, the devices the next roster holds, and whose terms were signed only by
   * devices of `kept`, the last with the key `kept` holds for it, most recently changed first. A
   * share signed, or whose terms were signed, by a device the rotation drops is left out: the device
   * may be a stolen one, or a member's who is leaving, and with the key being replaced it could have
   * made any share at all, or chosen any terms for an honest one, which any honest publish or change
   * since then would have signed again. A share that does not check is left out too, so its team
   * must share it again; the server can do that by hiding a share, which only denies it.
   */
  private async liveSharesAt(opened: OpenedTeam, kept: readonly RosterDevice[]): Promise<RosterShare[]> {
    const docs = await this.store().list({ collection: paths.shares(), where: [{ field: "ownerTeamId", value: opened.teamId }] });
    const found: { share: RosterShare; updated: number }[] = [];
    for (const stored of docs) {
      const doc = stored.data as unknown as ShareDoc;
      try {
        const { body } = await this.checkedManifest(stored.id, doc, { kind: "owner", team: opened });
        if (body.revoked || !signedByOneOf(doc.manifest, body, kept) || !termsSignedByOneOf(doc.manifest, body, kept)) continue;
        const digest = await this.vouchedManifest(stored.id, doc, body, opened);
        found.push({ share: { shareId: stored.id, digest }, updated: doc.updatedAt instanceof Date ? doc.updatedAt.getTime() : 0 });
      } catch (error) {
        if (isCloudError(error, "tampered") || isCloudError(error, "invalid")) continue;
        throw error;
      }
    }
    return found.sort((a, b) => b.updated - a.updated).map((entry) => entry.share);
  }

  /**
   * The newer of this device's two pins of `teamId`'s key, as a partner and as a member, or null for
   * none. Two pins of one version that differ are "tampered": a team never makes two keys there. The
   * partner pin counts here even when it was only trusted on first use (`Pin.firstUse`, kept on the
   * pin returned), since it still catches a key that changes; `checkedPinAt` leaves such pins out.
   */
  private pinnedTeamKey(teamId: string): Pin | null {
    const uid = this.uid();
    const partnerPin = readPin(this.trust, uid, "partner", teamId);
    const memberPin = readPin(this.trust, uid, "team", teamId);
    if (memberPin === null || (partnerPin !== null && partnerPin.v > memberPin.v)) return partnerPin;
    if (partnerPin === null || memberPin.v > partnerPin.v) return memberPin;
    if (!bytesEqual(memberPin.fingerprint, partnerPin.fingerprint) || !bytesEqual(memberPin.signSpki, partnerPin.signSpki)) {
      throw new CloudError("tampered", "This device holds two different keys for one team under the same version. Nothing is opened or sent. Compare the team safety code with that team.");
    }
    return memberPin;
  }

  /**
   * The signing key of version `okv` of team `teamId`, for a device that is not that team's: the key
   * this device pinned for it when `okv` is the pinned version, or one reached from the pin by the
   * team's signed rotations when `okv` is newer. With no pin, the team's key of that version is
   * trusted on first use, as a first share to a team trusts its key. A version older than the pin
   * cannot be checked, since signatures only reach forward, so it is "tampered". `pin` raises the
   * partner pin to `okv`, for the caller to run once the rest checks. A key trusted with no pin, or
   * reached from a pin that was itself only trusted on first use, is pinned as `first-use`: the
   * server alone can make a share "from" any team, so what it pins proves nothing about that team,
   * and a proposal's signer is never anchored on it (`checkedPinAt`). A key reached from a checked
   * pin, or from this device's pin of its own team, is pinned as `checked`.
   */
  private async partnerSigningKey(teamId: string, okv: number): Promise<{ signSpki: Uint8Array; pin: () => void }> {
    const uid = this.uid();
    const anchor = this.pinnedTeamKey(teamId);
    if (anchor !== null && okv < anchor.v) throw new CloudError("tampered", SHARE_SIGNED_WITH_OLDER_KEY);
    if (anchor !== null && okv === anchor.v) return { signSpki: anchor.signSpki, pin: () => undefined };
    const target = await this.publicKeyAt(teamId, okv);
    if (target === null || (anchor !== null && !(await this.signedFrom(teamId, anchor, target)))) {
      throw new CloudError("tampered", "This share's manifest is signed with a key the team that made it cannot be shown to hold. Nothing is opened or sent. Compare the team safety code with that team.");
    }
    const trust = anchor === null || anchor.firstUse === true ? "first-use" : "checked";
    return { signSpki: target.signSpki, pin: () => writePartnerPin(this.trust, uid, teamId, target, trust) };
  }

  /** Team `teamId`'s public keys of version `v`: its `encKey` when that is the version, else its `teamKeys/{v}` record; null when missing. */
  private async publicKeyAt(teamId: string, v: number): Promise<Pick<TeamDoc["encKey"], "v" | "fingerprint" | "signSpki" | "sig"> | null> {
    const team = await this.keys.team(teamId);
    if (team.encKey.v === v) return team.encKey;
    return this.keyRecordAt(teamId, v);
  }

  /** Team `teamId`'s public keys of version `v` from its `teamKeys/{v}` record alone; null when missing. */
  private async keyRecordAt(teamId: string, v: number): Promise<Pick<TeamDoc["encKey"], "v" | "fingerprint" | "signSpki" | "sig"> | null> {
    const record = (await this.getOrNull(keyPaths.teamKey(teamId, v))) as TeamKeyRecord | null;
    if (record === null || record.kv !== v || !(record.pairSpki instanceof Uint8Array) || !(record.signSpki instanceof Uint8Array)) return null;
    const fingerprint = await guarded("The team's public key", () => teamKeyFingerprint(record.pairSpki));
    return { v, fingerprint, signSpki: record.signSpki, sig: record.sig };
  }

  /** A share document with its projection opened, and for the team that made it the sharer's choices. */
  private async openShareDoc(shareId: string, doc: ShareDoc, access: ShareAccess): Promise<Share> {
    const { key, manifest } = await this.openShareKey(shareId, doc, access);
    const projection = await guarded("A share's projection", () =>
      openText(key, doc.projection, aadFor.shareProjection({ shareId, autoId: doc.autoId, kv: doc.projection.kv })),
    );
    const share: Share = { ...summaryOf(shareId, doc), projection };
    if (doc.audience === "link") {
      if (access.kind === "link") share.linkSecret = linkSecretToText(access.secret);
      else if (access.kind === "owner" && manifest !== null) share.linkSecret = linkSecretToText(await this.linkSecretOf(shareId, doc, access.team, manifest));
    }
    if (access.kind === "owner" && manifest !== null) {
      const choice = await this.ownerChoiceOf(shareId, doc, access.team, manifest);
      if (choice !== null) share.ownerChoice = choice;
    }
    return share;
  }

  /**
   * The sharer's choices on a share, opened by the team that made it: the sealed `ownerChoice` whose
   * digest the verified manifest names, or null when the manifest names none. A choice the server
   * takes away, or one sealed again by anyone who holds an older team key, no longer matches.
   */
  private async ownerChoiceOf(shareId: string, doc: ShareDoc, team: OpenedTeam, manifest: ShareManifestBody): Promise<string | null> {
    const sealed = doc.ownerChoice;
    if (sealed === undefined || sealed === null) {
      if (manifest.choice !== null) throw new CloudError("tampered", "This share's choices are missing, though its manifest names them. Nothing is opened or sent.");
      return null;
    }
    const digest = await guarded("A share's choices", () => ownerChoiceDigest({ shareId, choice: sealed }));
    if (manifest.choice === null || !bytesEqual(digest, manifest.choice)) {
      throw new CloudError("tampered", "This share's choices are not the ones its manifest names. Nothing is opened or sent.");
    }
    return guarded("A share's choices", () => openText(teamKeyAt(team, sealed.kv), sealed, aadFor.ownerChoice({ shareId, teamId: doc.ownerTeamId, kv: sealed.kv })));
  }

  /**
   * The newest version of `teamId`'s key this device knows of: the larger of what the team shows,
   * this device's pins of it as a partner and as a member, and `floor` (a version this device holds).
   * A team that is gone shows none.
   */
  private async newestKnownKeyVersion(teamId: string, floor = 0): Promise<number> {
    let shown = 0;
    try {
      shown = (await this.keys.team(teamId)).encKey.v;
    } catch (error) {
      // A team that is gone shows no newer key; wrapping to it again would fail in the same way.
      if (!isCloudError(error, "not-found")) throw error;
    }
    const uid = this.uid();
    return Math.max(shown, floor, readPin(this.trust, uid, "partner", teamId)?.v ?? 0, readPin(this.trust, uid, "team", teamId)?.v ?? 0);
  }

  /**
   * True when a share to teams was keyed before a team key it depends on changed: its verified
   * `manifest` says the share key is sealed for the sharing team under a key older than
   * `ownerKeyVersion` (`wkv`), or a team it names has a newer key than the one the manifest says its
   * wrap was made to, by what that team shows, this device's pins of it, or `known` (for a team whose
   * newest key this device holds). A member taken off that team, or a device it revoked, still has
   * the old key, and through it this share key, so nothing new may be sealed under the share key
   * until the share is re-keyed. The versions come from the manifest, which the owner team signed,
   * never from the wraps, whose `ekv` the server could raise. A link share is never stale this way:
   * its key comes from its link.
   */
  private async shareKeyStale(manifest: ShareManifestBody | null, ownerKeyVersion: number, known: ReadonlyMap<string, number> = new Map()): Promise<boolean> {
    if (manifest === null || manifest.audience === "link") return false;
    if (manifest.wkv < ownerKeyVersion) return true;
    for (const [teamId, ekv] of manifest.teams) {
      if (ekv < (await this.newestKnownKeyVersion(teamId, known.get(teamId)))) return true;
    }
    return false;
  }

  /**
   * `body` signed with the owner team's newest signing key, at that version (`okv`), and by this
   * device, which it names (`device`). Callers build `body` from what this device made or verified:
   * a new share, or the body of `replaces`, the stored manifest the caller verified
   * (`checkedManifest`), with one higher `seq`. Only the keys this device wrapped to are signed,
   * never keys the server reports.
   *
   * Who signs the terms follows from what the write changes, never from what the caller says. When
   * `body` names the same terms as `replaces`, at the same key version, the terms signature, its
   * signers and its count are carried byte for byte: a follow publish, or a new share key for the
   * same teams and keys. Otherwise this device signs the terms, one count higher. At a new share it
   * is their one signer, and at the first manifest signed at a newer key version too: that share was
   * listed by the rotation that made the key (`vouchedManifest`), which kept every device that had
   * signed its terms. At any other change of terms it is added to the signers, which keep every
   * device that signed the terms at this key: an honest change on top of terms a forger chose still
   * names the forger, so the rotation that drops the forger drops the share. A change that would name
   * more than `MAX_TERMS_DEVICES` is refused (`SHARE_TERMS_SIGNERS_FULL`), except a revocation, which
   * names only its own device: nothing is sealed into a revoked share again, nor is one listed, so
   * who chose its terms before no longer matters. `tseq` is the count signed.
   */
  private async signedManifest(
    owner: OpenedTeam,
    body: Omit<ShareManifestBody, "okv" | "device" | "termsSeq" | "termsDevices">,
    replaces: { manifest: ShareManifest; body: ShareManifestBody } | null,
  ): Promise<{ manifest: ShareManifest; tseq: number }> {
    const okv = owner.newest.key.version;
    const me = owner.device.deviceId;
    let terms: Pick<ShareManifestBody, "termsSeq" | "termsDevices"> = { termsSeq: 1, termsDevices: [me] };
    let carried: Pick<ShareManifest, "tsig" | "tkeys"> | undefined;
    if (replaces !== null) {
      const prior = replaces.body;
      const same = { termsSeq: prior.termsSeq, termsDevices: prior.termsDevices };
      const next: ShareManifestBody = { ...body, okv, device: me, ...same };
      if (prior.okv === okv && (await guarded("A share's manifest", async () => sameShareTerms(next, prior)))) {
        terms = same;
        carried = { tsig: replaces.manifest.tsig, tkeys: replaces.manifest.tkeys };
      } else {
        const devices = prior.okv === okv && !body.revoked ? [...prior.termsDevices.filter((deviceId) => deviceId !== me), me] : [me];
        if (devices.length > MAX_TERMS_DEVICES) throw new CloudError("invalid", SHARE_TERMS_SIGNERS_FULL);
        terms = { termsSeq: prior.termsSeq + 1, termsDevices: devices };
      }
    }
    const manifest = await guarded("A share's manifest", () =>
      signShareManifest({
        body: { ...body, okv, device: me, ...terms },
        signingKey: owner.newest.pair.signingKey,
        device: owner.device,
        ...(carried === undefined ? {} : { terms: carried }),
      }),
    );
    return { manifest, tseq: terms.termsSeq };
  }

  /**
   * The fields that move a share to teams onto a new share key one version up: `projectionText`
   * sealed under it, the owner wrap under the sharing team's newest key, a wrap to each of `teamIds`
   * at the public key it shows now, `current` (the key it replaces, opened extractable) sealed under
   * it in `prevKeys`, so everything sealed before still opens for the teams that keep the share, and
   * the manifest after `manifest`, the verified one of `current`, one `seq` higher and naming
   * `revisionId`, the revision `projectionText` shows, and the key each team was wrapped to. A team
   * `manifest` names is wrapped only to the key it names for that team or a newer one the team signed
   * from it (`wrapToTeams`), and `answers` is as for `wrapToTeams`.
   */
  private async rekeyedShareFields(
    shareId: string,
    doc: ShareDoc,
    owner: OpenedTeam,
    current: ShareKey,
    manifest: ShareManifestBody,
    teamIds: readonly string[],
    projectionText: string,
    answers: PartnerKeyAnswers = {},
    revisionId: string = manifest.revisionId,
  ): Promise<{ fields: DocData; signed: Signed }> {
    const prevKeys = doc.prevKeys ?? {};
    if (Object.keys(prevKeys).length >= MAX_PREVIOUS_SHARE_KEYS) {
      throw new CloudError("invalid", "This share has been re-keyed as often as one share can be. Make a new share for these teams instead.");
    }
    const fresh = await guarded("A share's key", () => newShareKey(current.version + 1, this.random));
    const projection = await guarded("A share's projection", () =>
      sealText(fresh, projectionText, aadFor.shareProjection({ shareId, autoId: manifest.autoId, kv: fresh.version }), this.random),
    );
    refuseSealedOversize(projection, MAX_SHARE_PROJECTION_BYTES, "What this share would show");
    const { wraps: keyWraps, teams } = await this.wrapToTeams(shareId, fresh, teamIds, answers, signedTeamKeys(manifest));
    const seq = manifest.seq + 1;
    const signed = await this.signedManifest(
      owner,
      {
        ...manifest,
        revisionId,
        seq,
        skv: fresh.version,
        wkv: owner.newest.key.version,
        teams,
        commit: await guarded("A share's key", () => commitShareKey({ shareId, shareKey: fresh })),
        projection: await guarded("A share's projection", () => shareProjectionDigest({ shareId, projection })),
      },
      { manifest: doc.manifest, body: manifest },
    );
    const fields: DocData = {
      projection,
      keyWraps,
      ownerWrap: await guarded("A share's key", () => wrapShareKeyForOwner({ shareId, teamId: doc.ownerTeamId, shareKey: fresh, teamKey: owner.newest.key, random: this.random })),
      prevKeys: { ...prevKeys, [String(current.version)]: await guarded("A share's key", () => sealPreviousShareKey({ shareId, previous: current, next: fresh, random: this.random })) },
      manifest: signed.manifest,
    };
    return { fields, signed: { kv: fresh.version, okv: owner.newest.key.version, seq, tseq: signed.tseq } };
  }

  /**
   * The fields that show `text`, built from revision `revisionId`, as a share's projection, for the
   * sharing team to write, with the manifest after the share's verified one, one `seq` higher and
   * naming `revisionId`. Under the share's key when that key is current; when a team key it depends
   * on changed since, under a new share key, with the fields `rekeyedShareFields` gives, so a member
   * or device taken off a team cannot open it. `signed` is where the write moves the share.
   * `following`, for a publish, is the auto published: the share's verified manifest must say it
   * follows that auto, or nothing is sealed (`SHARE_NOT_FOLLOWING`). Nothing is sealed into a share
   * whose signed end has passed by this device's clock (`SHARE_ENDED`).
   */
  private async projectionFields(
    shareId: string,
    doc: ShareDoc,
    owner: OpenedTeam,
    text: string,
    revisionId: string,
    following?: string,
  ): Promise<{ fields: DocData; signed: Signed }> {
    const { key, manifest } = await this.ownedShareKey(shareId, doc, owner, doc.audience === "teams");
    if (manifest.revoked) throw new CloudError("invalid", "That share was revoked; make a new one instead.");
    if (following !== undefined && (manifest.mode !== "follow" || manifest.autoId !== following)) throw new CloudError("tampered", SHARE_NOT_FOLLOWING);
    if (manifest.expiresAtMs <= this.now().getTime()) throw new CloudError("invalid", SHARE_ENDED);
    if (await this.shareKeyStale(manifest, owner.newest.key.version)) {
      return this.rekeyedShareFields(shareId, doc, owner, key, manifest, doc.teamIds, text, {}, revisionId);
    }
    const projection = await guarded("A share's projection", () =>
      sealText(key, text, aadFor.shareProjection({ shareId, autoId: manifest.autoId, kv: key.version }), this.random),
    );
    refuseSealedOversize(projection, MAX_SHARE_PROJECTION_BYTES, "What this share would show");
    const seq = manifest.seq + 1;
    const digest = await guarded("A share's projection", () => shareProjectionDigest({ shareId, projection }));
    const signed = await this.signedManifest(owner, { ...manifest, revisionId, seq, projection: digest }, { manifest: doc.manifest, body: manifest });
    return {
      fields: { projection, manifest: signed.manifest },
      signed: { kv: key.version, okv: owner.newest.key.version, seq, tseq: signed.tseq },
    };
  }

  /**
   * Once a write that signed new manifests is stored, this device refuses the share keys, the
   * manifests signed with an older key of the sharing team, and the manifests with a lower `seq` or
   * `tseq`, that it replaced. Not before: a write the rules refuse leaves the old manifest current, and this
   * device must still open it.
   */
  private pinSharesWhenSent(sent: Promise<unknown>, signed: ReadonlyMap<string, Signed>): void {
    if (signed.size === 0) return;
    const uid = this.uid();
    sent.then(
      () => {
        for (const [shareId, { kv, okv, seq, tseq }] of signed) {
          writeShareKeyPin(this.trust, uid, shareId, kv);
          writeShareSignerPin(this.trust, uid, shareId, okv);
          writeShareSeqPin(this.trust, uid, shareId, seq);
          writeShareTermsPin(this.trust, uid, shareId, tseq);
        }
      },
      () => undefined,
    );
  }

  /** The teams' public keys, each checked, and compared with what this device used for them before. */
  async checkPartnerKeys(teamIds: string[]): Promise<PartnerKeyCheck[]> {
    const out: PartnerKeyCheck[] = [];
    for (const teamId of teamIds) out.push((await this.partnerKey(teamId)).check);
    return out;
  }

  /**
   * One team's public key, checked, with how it compares with this device's pin for it. A newer
   * version is `rotated` only when each version from the pinned one up is signed by the version
   * below it, starting from the signing key this device pinned; otherwise it is `changed`, which
   * needs the safety code compared and `acceptKeyChanges`.
   *
   * When this user is also a member of that team, this device's pin of the team's own key (checked
   * against its grant and chain) counts too. A key shown at the version of that team pin that is not
   * the team pin's key is `member-key-differs`, which no answer accepts: this device holds that
   * team's real key at that version, so the key shown is not the team's, whatever any partner pin
   * says. So a server cannot hand a member a made-up key for their own team when they share with it
   * from another team, even one this device first met in a share the server made itself. Otherwise
   * the newer of the two pins is compared, and two pins of the same version that differ make it
   * `changed`. `pin` is the pin compared, which is the team pin for `member-key-differs`, or null
   * for none.
   *
   * A partner pin that was only trusted on first use (`Pin.firstUse`, such as the one opening a
   * received share writes) is compared too, so a key that differs from it is still `changed` or
   * `older`; but a key that matches it, or was signed from it, is `first-use`, not `same` or
   * `rotated`, since nobody on this device has checked that key yet, and the share dialog shows its
   * safety code as for a team met for the first time. `rotated` says the key shown was signed from
   * `pin` at a lower version, whatever `first-use` hides of that.
   */
  private async partnerKey(teamId: string): Promise<{ encKey: TeamDoc["encKey"]; check: PartnerKeyCheck; pin: Pin | null; rotated: boolean }> {
    const uid = this.uid();
    const team = await this.keys.team(teamId);
    const partnerPin = readPin(this.trust, uid, "partner", teamId);
    const memberPin = readPin(this.trust, uid, "team", teamId);
    if (memberPin !== null && memberPin.v === team.encKey.v && !sameKeyAs(memberPin, team.encKey)) {
      return { encKey: team.encKey, check: await this.keyCheck(teamId, team.encKey, "member-key-differs"), pin: memberPin, rotated: false };
    }
    let pin = partnerPin;
    let pinsDisagree = false;
    if (memberPin !== null) {
      if (pin === null || memberPin.v > pin.v) pin = memberPin;
      else if (memberPin.v === pin.v) {
        pinsDisagree = !sameKeyAs(memberPin, pin);
        // The same key as the team pin is one this device checked, whatever the partner pin says.
        if (!pinsDisagree) pin = memberPin;
      }
    }
    let status: PartnerKeyCheck["status"] = pinsDisagree ? "changed" : comparePin(pin, team.encKey);
    if (status === "rotated" && pin !== null && !(await this.signedFrom(teamId, pin, team.encKey))) status = "changed";
    const rotated = status === "rotated";
    if ((status === "same" || status === "rotated") && pin?.firstUse === true) status = "first-use";
    return { encKey: team.encKey, check: await this.keyCheck(teamId, team.encKey, status), pin, rotated };
  }

  /** The check of the key `encKey` that team `teamId` shows now, with `status`. */
  private async keyCheck(teamId: string, encKey: TeamDoc["encKey"], status: PartnerKeyCheck["status"]): Promise<PartnerKeyCheck> {
    return {
      teamId,
      status,
      keyVersion: encKey.v,
      safetyCode: await guarded("The team's public key", () => teamSafetyCode(encKey)),
      keyId: teamKeyId(encKey),
    };
  }

  /**
   * True when `encKey` is reached from `pin` by signatures: each `teamKeys/{v}` record from the pinned
   * version plus one up to `encKey.v` minus one, then `encKey` itself, verifies with the signing key
   * of the version below. Records are public keys and ciphertext only, which any signed-in user may
   * read by id. At most `MAX_PARTNER_KEY_STEPS` steps.
   */
  private async signedFrom(teamId: string, pin: { v: number; signSpki: Uint8Array }, encKey: Pick<TeamDoc["encKey"], "v" | "fingerprint" | "signSpki" | "sig">): Promise<boolean> {
    if (encKey.v - pin.v > MAX_PARTNER_KEY_STEPS) return false;
    try {
      let signer = pin.signSpki;
      for (let v = pin.v + 1; v < encKey.v; v++) {
        const record = (await this.getOrNull(keyPaths.teamKey(teamId, v))) as TeamKeyRecord | null;
        if (record === null || record.kv !== v || !(record.pairSpki instanceof Uint8Array) || !(record.signSpki instanceof Uint8Array)) return false;
        const fingerprint = await teamKeyFingerprint(record.pairSpki);
        if (!(await checkTeamKeyStep(teamId, signer, { v, fingerprint, signSpki: record.signSpki, sig: record.sig }))) return false;
        signer = record.signSpki;
      }
      return await checkTeamKeyStep(teamId, signer, encKey);
    } catch (error) {
      if (isCryptoError(error)) return false;
      throw error;
    }
  }

  /**
   * The team's safety code as this device knows it. With no pin, the key the server shows now, as
   * the first share shows it. With a pin, the key the server shows when it is that key or a rotation
   * the team signed from it, which is the code on the team's own page; any other key, and the code is
   * the pinned key's, with `serverKeyDiffers`, so comparing codes later still catches a swap. For a
   * team this user is a member of whose key shown differs from this device's team pin at that
   * version (`member-key-differs`), that is the team pin's code, whatever a partner pin says. A pin
   * that was only trusted on first use (`Pin.firstUse`) gives its code the same way, but `pinned` is
   * false for it: nobody on this device has checked that key. `keyReplaced` is set when the key shown
   * is newer than the first one this device trusted for the team: a rotation the team signed from the
   * pin, or a pin that already moved forward and kept the ones before it (`readEarlierPartnerPins`).
   */
  async teamSafetyCode(teamId: string): Promise<KnownSafetyCode> {
    const { check, pin, rotated } = await this.partnerKey(teamId);
    if (pin === null) return { safetyCode: check.safetyCode, pinned: false, serverKeyDiffers: false };
    const replaced = rotated || readEarlierPartnerPins(this.trust, this.uid(), teamId).length > 0 ? { keyReplaced: true as const } : {};
    if (check.status === "first-use") return { safetyCode: check.safetyCode, pinned: false, serverKeyDiffers: false, ...replaced };
    if (check.status === "same" || check.status === "rotated") return { safetyCode: check.safetyCode, pinned: true, serverKeyDiffers: false, ...replaced };
    const pinned = await guarded("The team's public key", () => safetyCodeOfKeys(pin.fingerprint, pin.signSpki));
    return { safetyCode: pinned, pinned: pin.firstUse !== true, serverKeyDiffers: true };
  }

  teamNumberPin(teamNumber: number): TeamNumberPin | null {
    return readTeamNumberPin(this.trust, this.uid(), teamNumber);
  }

  pinTeamNumber(teamNumber: number, teamId: string, options: { safetyCodeSeen: boolean }): void {
    writeTeamNumberPin(this.trust, this.uid(), teamNumber, { teamId, seen: options.safetyCodeSeen });
  }

  /**
   * Refuses with "key-changed" when team `teamId` says it holds an FTC number that this device and
   * user pinned to a different team. The server writes a team's number, name and status, so a team
   * of its own can claim the number of a team this device shares with; a proposal sealed to it would
   * go to whoever holds that team's key. A team with no number claims one by its name when the name
   * reads as a number ("36596", "Team 36596"), and is refused the same way. A team with no number
   * whose name claims no number pinned elsewhere is not refused: as with a first share from a number,
   * the key the share was first opened with is the one proposals go to, and its safety code is the
   * one the Partners panel shows to compare.
   */
  private async refuseNumberPinnedElsewhere(teamId: string): Promise<void> {
    const team = await this.keys.team(teamId);
    const number = team.number ?? numberInTeamName(team.name);
    if (number === null) return;
    const pin = readTeamNumberPin(this.trust, this.uid(), number);
    if (pin === null || pin.teamId === teamId) return;
    const text = String(number);
    const claim = team.number === null ? `is from a team with no number that calls itself ${text}` : `says it is from team ${text}`;
    throw new CloudError(
      "key-changed",
      `This share ${claim}, but it is not the team this device knows as ${text}, so nothing was sent. Compare its safety code with the team you know as ${text}.`,
    );
  }

  /**
   * `shareKey` wrapped to each team's public key, after comparing each with the key this device used
   * for it before, with the key each was wrapped to as a manifest names it (`teamKeyDigest`). A team
   * named in `answers.expectedKeys` must show exactly the key named there, the one whose safety code
   * the person was shown, or everything stops with "key-changed": a server that serves one key to the
   * dialog and another to the send gets nothing, and no key the person was not shown is pinned. A key
   * that is `changed` or `older` stops everything with "key-changed" too, unless the team is in
   * `answers.acceptKeyChanges` and its key is the one named. A key that is `member-key-differs` stops
   * everything with "key-changed" whatever the answers say. Each team's key is read once, so the key
   * compared is the key wrapped to, whatever the server answers to a second read. The pins move on
   * only after every wrap is made.
   *
   * `onShare` holds, for each team already on the share, the key its verified manifest says the share
   * key was wrapped to. Such a team is wrapped only to that key, or to a newer one reached from it by
   * the team's signed rotations (`reachesSignedKey`), whatever this device's pins say: a device that
   * never pinned the team, another member's or the sharer's second device, would otherwise trust on
   * first use whatever key the server shows, and the server would show one of its own. Anything else
   * stops everything with "key-changed", and no answer accepts it; a team whose key truly changed
   * another way is taken off the share and shared with again. A key older than the one named is the
   * server putting back a key a member taken off that team still holds ("tampered"). Only a team new
   * to the share is trusted on first use, as a first share is.
   *
   * Each pin is written `checked` (`PartnerPinTrust`) when the key is the one named in
   * `answers.expectedKeys`, which the person was shown, when the team is on the share and the key
   * is reached from the one its verified manifest names, or when it is the key of a checked pin, or
   * of this device's own team pin, or one signed from it; otherwise, a first share made without a
   * shown key or a key matching a pin only trusted on first use, it is written `first-use`.
   */
  private async wrapToTeams(
    shareId: string,
    shareKey: ShareKey,
    teamIds: readonly string[],
    answers: PartnerKeyAnswers = {},
    onShare: ReadonlyMap<string, SignedTeamKey> = new Map(),
  ): Promise<{ wraps: Record<string, ShareKeyWrap>; teams: SignedTeamKey[] }> {
    const uid = this.uid();
    const keys: [string, TeamDoc["encKey"], PartnerPinTrust][] = [];
    const expectedKeys = answers.expectedKeys ?? {};
    for (const teamId of teamIds) {
      const { encKey, check, pin } = await this.partnerKey(teamId);
      const expected = Object.hasOwn(expectedKeys, teamId) ? expectedKeys[teamId] : undefined;
      if (expected !== undefined && expected !== check.keyId) {
        throw new CloudError(
          "key-changed",
          `A team you are sharing with now shows a key that is not the one whose safety code you were shown, so nothing was sent. Share again to see its safety code now, ${check.safetyCode}, and compare it with that team.`,
        );
      }
      if (check.status === "member-key-differs") {
        throw new CloudError(
          "key-changed",
          "A team you are sharing with shows a key that is not the one this device holds for it, and this device holds that team's real key because you are a member of it, so the server may be showing a key of its own and nothing was sent. No answer accepts that key. Compare the safety code on that team's page with a teammate.",
        );
      }
      const accepted = expected !== undefined && (answers.acceptKeyChanges ?? []).includes(teamId);
      const signed = onShare.get(teamId);
      if (signed !== undefined) {
        if (encKey.v < signed[1]) {
          throw new CloudError(
            "tampered",
            "A team on this share shows an older key than the one the share was last wrapped to, so the server may have put back a key someone taken off that team still has. Nothing was changed.",
          );
        }
        if (!(await this.reachesSignedKey(teamId, signed, encKey))) {
          throw new CloudError(
            "key-changed",
            `A team on this share shows a key that is neither the one the share was wrapped to nor a newer one that team signed from it, so the server may be showing a key of its own, and nothing was sent. Compare that team's safety code, ${check.safetyCode}, with the team; if its key really changed, take it off the share and share with it again.`,
          );
        }
      }
      if ((check.status === "changed" || check.status === "older") && !accepted) {
        throw new CloudError(
          "key-changed",
          `A team you are sharing with shows a different key from the one this device used for it before. Compare its safety code, ${check.safetyCode}, with that team before sharing with it.`,
        );
      }
      // `partnerKey` says `same` or `rotated` only from a pin that was checked, or a team pin.
      const reachedFromChecked = pin !== null && (check.status === "same" || check.status === "rotated");
      keys.push([teamId, encKey, expected !== undefined || signed !== undefined || reachedFromChecked ? "checked" : "first-use"]);
    }
    const wraps: Record<string, ShareKeyWrap> = {};
    const teams: SignedTeamKey[] = [];
    for (const [teamId, encKey] of keys) {
      wraps[teamId] = await guarded("A team's public key", () => wrapShareKeyToTeam({ shareId, teamId, shareKey, encKey, random: this.random }));
      teams.push([teamId, encKey.v, await guarded("A team's public key", () => teamKeyDigest({ teamId, ...encKey }))]);
    }
    for (const [teamId, encKey, trust] of keys) writePartnerPin(this.trust, uid, teamId, encKey, trust);
    return { wraps, teams };
  }

  /**
   * True when `encKey`, the key team `teamId` shows now, is the key `signed` names for it (a share's
   * verified manifest), or a newer one reached from it by the team's signed rotations: the team's
   * `teamKeys` record of the version named must give the digest named, and each version from there up
   * to `encKey` must be signed by the one below (`signedFrom`), as the safety code this device shows
   * for a rotation signed from its pin is.
   */
  private async reachesSignedKey(teamId: string, signed: SignedTeamKey, encKey: TeamDoc["encKey"]): Promise<boolean> {
    const [, ekv, digest] = signed;
    if (encKey.v < ekv) return false;
    const named = encKey.v === ekv ? encKey : await this.keyRecordAt(teamId, ekv);
    if (named === null) return false;
    try {
      if (!bytesEqual(await teamKeyDigest({ teamId, ...named }), digest)) return false;
    } catch (error) {
      if (isCryptoError(error)) return false;
      throw error;
    }
    return encKey.v === ekv || this.signedFrom(teamId, named, encKey);
  }

  async createShare(input: CreateShareInput): Promise<Queued<Share>> {
    const uid = this.uid();
    const level = input.level ?? "view";
    const mode = input.mode ?? "pinned";
    const teamIds = [...new Set(input.teamIds ?? [])];
    if (input.audience === "link") {
      if (teamIds.length > 0) throw new CloudError("invalid", "An anyone-with-the-link share does not name teams.");
      if (level !== "view") throw new CloudError("invalid", "An anyone-with-the-link share is view only.");
    } else {
      if (teamIds.length === 0) throw new CloudError("invalid", "Choose at least one team to share with.");
      if (teamIds.length > MAX_SHARE_TEAMS) {
        throw new CloudError("invalid", `One share can name at most ${String(MAX_SHARE_TEAMS)} teams. Make a second share for the others.`);
      }
      if (teamIds.includes(input.teamId)) throw new CloudError("invalid", "Your own team already sees the library; share with other teams.");
    }
    const created = this.now();
    const expiresAt = input.expiresAt ?? new Date(created.getTime() + DEFAULT_EXPIRY_S * 1000);
    if (expiresAt.getTime() <= created.getTime()) throw new CloudError("invalid", "A share must expire after the moment it is made.");
    if (input.projection.length === 0) throw new CloudError("invalid", "A share needs a projection to show.");
    refuseOversize(input.projection, MAX_SHARE_PROJECTION_BYTES, "What this share would show");

    const opened = await this.openTeamToSeal(input.teamId);
    const teamKey = opened.newest.key;
    let shareId: string;
    let shareKey: ShareKey;
    let commit: Uint8Array;
    let teams: SignedTeamKey[] = [];
    const keyFields: DocData = {};
    let linkSecret: string | undefined;
    if (input.audience === "link") {
      const secret = newLinkSecret(this.random);
      shareId = await guarded("A link share", () => deriveLinkId(secret));
      shareKey = await guarded("A link share", () => deriveLinkKey(secret));
      commit = await guarded("A link share", () => commitLinkKey({ shareId, secret }));
      keyFields.linkWrap = await guarded("A link share", () =>
        wrapLinkSecretForOwner({ shareId, teamId: input.teamId, autoId: input.autoId, secret, teamKey, random: this.random }),
      );
      linkSecret = linkSecretToText(secret);
    } else {
      shareId = randomId(this.random);
      shareKey = await guarded("A share's key", () => newShareKey(1, this.random));
      const wrapped = await this.wrapToTeams(shareId, shareKey, teamIds, { acceptKeyChanges: input.acceptKeyChanges, expectedKeys: input.expectedKeys });
      keyFields.keyWraps = wrapped.wraps;
      keyFields.ownerWrap = await guarded("A share's key", () => wrapShareKeyForOwner({ shareId, teamId: input.teamId, shareKey, teamKey, random: this.random }));
      commit = await guarded("A share's key", () => commitShareKey({ shareId, shareKey }));
      teams = wrapped.teams;
    }
    let choice: Uint8Array | null = null;
    if (input.ownerChoice !== undefined) {
      const text = input.ownerChoice;
      const sealed = await guarded("A share's choices", () => sealText(teamKey, text, aadFor.ownerChoice({ shareId, teamId: input.teamId, kv: teamKey.version }), this.random));
      refuseSealedOversize(sealed, MAX_OWNER_CHOICE_BYTES, "The choices made for this share");
      keyFields.ownerChoice = sealed;
      choice = await guarded("A share's choices", () => ownerChoiceDigest({ shareId, choice: sealed }));
    }
    const projection = await guarded("A share's projection", () =>
      sealText(shareKey, input.projection, aadFor.shareProjection({ shareId, autoId: input.autoId, kv: shareKey.version }), this.random),
    );
    refuseSealedOversize(projection, MAX_SHARE_PROJECTION_BYTES, "What this share would show");
    const signed = await this.signedManifest(opened, {
      shareId,
      ownerTeamId: input.teamId,
      autoId: input.autoId,
      revisionId: input.revision,
      audience: input.audience,
      mode,
      level,
      revoked: false,
      expiresAtMs: expiresAt.getTime(),
      seq: 1,
      skv: shareKey.version,
      wkv: teamKey.version,
      choice,
      projection: await guarded("A share's projection", () => shareProjectionDigest({ shareId, projection })),
      teams,
      commit,
    }, null);
    keyFields.manifest = signed.manifest;
    const meta = {
      ownerTeamId: input.teamId,
      autoId: input.autoId,
      audience: input.audience,
      teamIds,
      level,
      mode,
      revision: input.revision,
      expiresAt,
      revokedAt: null,
      createdBy: uid,
    };
    const writes: Write[] = [
      { op: "set", path: paths.share(shareId), data: { ...meta, projection, ...keyFields, createdAt: SERVER_TIME, updatedAt: SERVER_TIME } },
      ...teamIds.map((teamId): Write => ({
        op: "set",
        path: paths.inboxEntry(teamId, shareId),
        data: { shareId, ownerTeamId: input.teamId, createdBy: uid, createdAt: SERVER_TIME },
      })),
      this.activity(input.teamId, "share.create", shareId, input.audience === "link" ? "link" : teamIds.join(",")),
    ];
    const who = input.audience === "link" ? "anyone with the link" : `${String(teamIds.length)} team${teamIds.length === 1 ? "" : "s"}`;
    const value: Share = { id: shareId, ...meta, createdAt: created, updatedAt: created, projection: input.projection };
    if (linkSecret !== undefined) value.linkSecret = linkSecret;
    if (input.ownerChoice !== undefined) value.ownerChoice = input.ownerChoice;
    const queued = this.write("share", `Share an auto with ${who}.`, writes, value);
    this.pinSharesWhenSent(queued.sent, new Map([[shareId, { kv: shareKey.version, okv: teamKey.version, seq: 1, tseq: signed.tseq }]]));
    return queued;
  }

  async getShare(shareId: string, asTeamId?: string): Promise<Share | null> {
    // Only a member of one of its teams opens a share by id; nobody signed out is.
    if (this.currentUser() === null) return null;
    const doc = await this.shareDoc(shareId);
    if (doc === null) return null;
    const candidates = asTeamId !== undefined ? [asTeamId] : [doc.ownerTeamId, ...(doc.audience === "teams" ? doc.teamIds : [])];
    let waiting: CloudError | null = null;
    for (const teamId of candidates) {
      if (teamId !== doc.ownerTeamId && !doc.teamIds.includes(teamId)) continue;
      let team: OpenedTeam | null;
      try {
        team = await this.openTeam(teamId);
      } catch (error) {
        if (isCloudError(error, "no-key")) {
          waiting = error;
          continue;
        }
        if (isCloudError(error, "permission-denied") || isCloudError(error, "not-found")) continue;
        throw error;
      }
      return this.openShareDoc(shareId, doc, { kind: teamId === doc.ownerTeamId ? "owner" : "recipient", team });
    }
    // The share is there, but only a team whose key this device is still waiting for can open it.
    if (waiting !== null) throw waiting;
    return null;
  }

  async openLinkShare(secretText: string): Promise<Share | null> {
    let secret: Uint8Array;
    let shareId: string;
    try {
      secret = linkSecretFromText(secretText);
      shareId = await deriveLinkId(secret);
    } catch {
      return null;
    }
    const doc = await this.shareDoc(shareId);
    if (doc === null || doc.audience !== "link") return null;
    return this.openShareDoc(shareId, doc, { kind: "link", secret });
  }

  async listTeamShares(teamId: string): Promise<Share[]> {
    const docs = await this.store().list({ collection: paths.shares(), where: [{ field: "ownerTeamId", value: teamId }] });
    if (docs.length === 0) return [];
    const opened = await this.openTeam(teamId);
    const shares: Share[] = [];
    for (const doc of docs) {
      try {
        shares.push(await this.openShareDoc(doc.id, doc.data as unknown as ShareDoc, { kind: "owner", team: opened }));
      } catch (error) {
        // A share the team's newest key neither signed nor listed is not shown as the team's own:
        // someone taken off the team may have made it.
        if (isNotListed(error)) continue;
        throw error;
      }
    }
    return shares.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  /**
   * The team's shares that stopped at a change of its key: each whose manifest checks with the
   * team's own key of the version it names (`checkedManifest`), is not revoked and has not ended by
   * its signed end, and which this device refuses to seal into (`vouchedManifest`: signed with an
   * older key, and not listed by the newest roster with every device that signed it). The terms come
   * from that manifest, so the database cannot choose them, and whether a share stopped comes from
   * the roster the team signed, so the database cannot stop one; it can only leave one out, which
   * hides it. A share that does not check at all is left out as well: it is not the team's.
   */
  async listStoppedShares(teamId: string): Promise<StoppedShare[]> {
    const docs = await this.store().list({ collection: paths.shares(), where: [{ field: "ownerTeamId", value: teamId }] });
    if (docs.length === 0) return [];
    const opened = await this.openTeam(teamId);
    const nowMs = this.now().getTime();
    const stopped: StoppedShare[] = [];
    for (const stored of docs) {
      const doc = stored.data as unknown as ShareDoc;
      if (doc.revokedAt !== null && doc.revokedAt !== undefined) continue;
      let body: ShareManifestBody;
      try {
        ({ body } = await this.checkedManifest(stored.id, doc, { kind: "owner", team: opened }));
      } catch (error) {
        if (isCloudError(error, "tampered") || isCloudError(error, "invalid")) continue;
        throw error;
      }
      if (body.revoked || body.expiresAtMs <= nowMs) continue;
      try {
        await this.vouchedManifest(stored.id, doc, body, opened);
        continue;
      } catch (error) {
        if (!isNotListed(error)) throw error;
      }
      const kept = opened.roster.devices;
      const removed = !signedByOneOf(doc.manifest, body, kept) || !termsSignedByOneOf(doc.manifest, body, kept);
      stopped.push({
        id: stored.id,
        ownerTeamId: body.ownerTeamId,
        autoId: body.autoId,
        audience: body.audience,
        teamIds: body.teams.map(([id]) => id),
        level: body.level,
        mode: body.mode,
        revision: body.revisionId,
        expiresAt: new Date(body.expiresAtMs),
        createdAt: doc.createdAt instanceof Date ? doc.createdAt : new Date(0),
        reason: removed ? "device-removed" : "not-listed",
      });
    }
    return stopped.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || a.id.localeCompare(b.id));
  }

  async listAllShares(): Promise<ShareSummary[]> {
    this.uid(); // Refuses a caller who is not signed in, with the sentence every call uses.
    let docs: StoredDoc[];
    try {
      docs = await this.store().list({ collection: paths.shares() });
    } catch (error) {
      if (isCloudError(error, "permission-denied")) {
        throw new CloudError("permission-denied", "Only Horizon admins can see every share.", { cause: error });
      }
      throw error;
    }
    return docs
      .map((doc) => summaryOf(doc.id, doc.data as unknown as ShareDoc))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || a.id.localeCompare(b.id));
  }

  async listReceivedShares(teamId: string): Promise<Share[]> {
    return (await this.receivedShares(teamId)).shares;
  }

  async listWaitingShares(teamId: string): Promise<WaitingShare[]> {
    return (await this.receivedShares(teamId)).waiting;
  }

  /**
   * The live shares made to the team, opened, and those this device refuses as signed with an older
   * key of the sharing team than it has seen. Such a share is not a reason to list nothing: its team
   * has not yet carried it forward to its newer key, stopped it when that key changed (and may have
   * shared it again), or someone that team took off made it. Nothing of it is opened, so it is
   * listed by id and the team the database says made it, and opening it still says why it waits.
   */
  private async receivedShares(teamId: string): Promise<{ shares: Share[]; waiting: WaitingShare[] }> {
    const inbox = await this.store().list({ collection: paths.inbox(teamId) });
    const shares: Share[] = [];
    const waiting: WaitingShare[] = [];
    let opened: OpenedTeam | null = null;
    for (const entry of inbox) {
      const shareId = lastSegment(entry.path);
      const doc = await this.shareDoc(shareId);
      if (doc === null || doc.revokedAt !== null || doc.expiresAt.getTime() <= this.now().getTime()) continue;
      // A share that stopped naming this team is not this team's to open.
      if (!doc.teamIds.includes(teamId)) continue;
      opened ??= await this.openTeam(teamId);
      try {
        shares.push(await this.openShareDoc(shareId, doc, { kind: "recipient", team: opened }));
      } catch (error) {
        if (!isSignedWithOlderKey(error)) throw error;
        waiting.push({ id: shareId, ownerTeamId: doc.ownerTeamId });
      }
    }
    shares.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
    waiting.sort((a, b) => a.id.localeCompare(b.id));
    return { shares, waiting };
  }

  async carryForwardShares(teamId: string): Promise<CarriedShares> {
    const running = this.carrying.get(teamId);
    if (running !== undefined) return running;
    const run = this.carrySharesForward(teamId).finally(() => this.carrying.delete(teamId));
    this.carrying.set(teamId, run);
    return run;
  }

  /**
   * `carryForwardShares`: each share due is re-keyed as a write after the team's key changed re-keys
   * it (`rekeyedShareFields`), for the same teams and the revision its manifest names, and the
   * writes go in groups, each sent and stored before the next is built. A group the database
   * refuses is sent again one share at a time, so one share it refuses does not hold back the rest.
   */
  private async carrySharesForward(teamId: string): Promise<CarriedShares> {
    const docs = await this.store().list({ collection: paths.shares(), where: [{ field: "ownerTeamId", value: teamId }] });
    const result: CarriedShares = { carried: [], left: [] };
    if (docs.length === 0) return result;
    const owner = await this.openTeam(teamId);
    let group: CarriedShare[] = [];
    let bytes = 0;
    for (const stored of docs) {
      const doc = stored.data as unknown as ShareDoc;
      let share: CarriedShare | null;
      try {
        share = await this.carriedShare(stored.id, doc, owner);
      } catch (error) {
        if (!isCloudError(error)) throw error;
        result.left.push(stored.id);
        continue;
      }
      if (share === null) continue;
      if (group.length > 0 && (group.length >= CARRY_FORWARD_SHARES_PER_WRITE || bytes + share.bytes > CARRY_FORWARD_PROJECTION_BYTES_PER_WRITE)) {
        await this.sendCarried(group, result);
        group = [];
        bytes = 0;
      }
      group.push(share);
      bytes += share.bytes;
    }
    if (group.length > 0) await this.sendCarried(group, result);
    result.carried.sort();
    result.left.sort();
    return result;
  }

  /**
   * The write that carries one of the team's shares forward, or null when it is not due: a link
   * share (its key comes from its link, and a partner opens it by the link alone), a revoked or
   * ended one, one already signed with the team's newest key, one whose manifest does not check,
   * and one the newest roster does not list (`SHARE_NOT_LISTED`: the rotation stopped it, or someone
   * the team took off made it). Throws a `CloudError` for a share that is due but that this device
   * cannot carry: one the rules let only an owner, an admin or its maker change, a partner key that
   * changed in a way no signature explains ("key-changed"), or a share re-keyed as often as one can be.
   */
  private async carriedShare(shareId: string, doc: ShareDoc, owner: OpenedTeam): Promise<CarriedShare | null> {
    if (doc.audience !== "teams" || (doc.revokedAt !== null && doc.revokedAt !== undefined) || isPast(doc.expiresAt, this.now())) return null;
    let body: ShareManifestBody;
    try {
      ({ body } = await this.checkedManifest(shareId, doc, { kind: "owner", team: owner }));
      if (body.revoked || body.okv >= owner.newest.key.version || body.expiresAtMs <= this.now().getTime()) return null;
      await this.vouchedManifest(shareId, doc, body, owner);
    } catch (error) {
      if (isCloudError(error, "tampered") || isCloudError(error, "invalid")) return null;
      throw error;
    }
    const uid = this.uid();
    const role = roleIn(owner.roster, uid);
    if (!isAdminRole(role) && !(role === "editor" && (body.mode === "follow" || doc.createdBy === uid))) {
      throw new CloudError("permission-denied", "Only an owner or admin, or the editor who made it, may carry this share forward.");
    }
    const { key, manifest } = await this.ownedShareKey(shareId, doc, owner, true);
    const text = await guarded("A share's projection", () =>
      openText(key, doc.projection, aadFor.shareProjection({ shareId, autoId: manifest.autoId, kv: key.version })),
    );
    const { fields, signed } = await this.rekeyedShareFields(shareId, doc, owner, key, manifest, doc.teamIds, text);
    return { shareId, fields, signed, bytes: (fields.projection as Envelope).ct.byteLength };
  }

  /**
   * Sends `group` as one write and waits until it is stored, adding each share to `result`. A group
   * of several the database refuses is sent again one share at a time.
   */
  private async sendCarried(group: readonly CarriedShare[], result: CarriedShares): Promise<void> {
    const summary = group.length === 1 ? "Carry a share forward to the team's new key." : `Carry ${String(group.length)} shares forward to the team's new key.`;
    const queued = this.write("share", summary, group.map((share): Write => ({ op: "update", path: paths.share(share.shareId), data: { ...share.fields, updatedAt: SERVER_TIME } })), undefined);
    this.pinSharesWhenSent(queued.sent, new Map(group.map((share) => [share.shareId, share.signed])));
    try {
      await queued.sent;
      result.carried.push(...group.map((share) => share.shareId));
    } catch (error) {
      if (!isCloudError(error)) throw error;
      if (group.length === 1) {
        result.left.push(group[0]!.shareId);
        return;
      }
      for (const share of group) await this.sendCarried([share], result);
    }
  }

  private async changeShare(shareId: string, patch: DocData, kind: ActivityKind, summary: string): Promise<Queued<void>> {
    const share = await this.shareDoc(shareId);
    if (share === null) throw new CloudError("not-found", "That share does not exist, or you cannot open it.");
    if (share.revokedAt !== null) throw new CloudError("invalid", "That share was revoked; make a new one instead.");
    return this.write("share", summary, [
      { op: "update", path: paths.share(shareId), data: { ...patch, updatedAt: SERVER_TIME } },
      this.activity(share.ownerTeamId, kind, shareId),
    ], undefined);
  }

  async extendShare(shareId: string, expiresAt: Date): Promise<Queued<void>> {
    return this.changeShareTerms(shareId, { expiresAt }, { expiresAtMs: expiresAt.getTime() }, "share.extend", "Extend a share.");
  }

  /**
   * Changes a share's terms and signs, in the same write, the manifest that says them, one `seq`
   * higher and with the owner team's newest key, so no device takes the old terms back from the
   * server afterwards. The share must be live for the owner team (`vouchedManifest`): its key is
   * opened, and its manifest checked, as for any seal into it.
   */
  private async changeShareTerms(
    shareId: string,
    patch: DocData,
    terms: Partial<Pick<ShareManifestBody, "level" | "mode" | "revoked" | "expiresAtMs">>,
    kind: ActivityKind,
    summary: string,
  ): Promise<Queued<void>> {
    const share = await this.shareDoc(shareId);
    if (share === null) throw new CloudError("not-found", "That share does not exist, or you cannot open it.");
    if (share.revokedAt !== null) throw new CloudError("invalid", "That share was revoked; make a new one instead.");
    if (share.audience === "link" && terms.level !== undefined && terms.level !== "view") throw new CloudError("invalid", "An anyone-with-the-link share is view only.");
    const owner = await this.openTeam(share.ownerTeamId);
    const { manifest } = await this.ownedShareKey(shareId, share, owner);
    const seq = manifest.seq + 1;
    const signed = await this.signedManifest(owner, { ...manifest, ...terms, seq }, { manifest: share.manifest, body: manifest });
    const queued = this.write("share", summary, [
      { op: "update", path: paths.share(shareId), data: { ...patch, manifest: signed.manifest, updatedAt: SERVER_TIME } },
      this.activity(share.ownerTeamId, kind, shareId),
    ], undefined);
    this.pinSharesWhenSent(queued.sent, new Map([[shareId, { kv: share.projection.kv, okv: owner.newest.key.version, seq, tseq: signed.tseq }]]));
    return queued;
  }

  async revokeShare(shareId: string): Promise<Queued<void>> {
    return this.changeShareTerms(shareId, { revokedAt: SERVER_TIME }, { revoked: true }, "share.revoke", "Revoke a share.");
  }

  async setShareLevel(shareId: string, level: ShareLevel): Promise<Queued<void>> {
    return this.changeShareTerms(shareId, { level }, { level }, "share.level", `Change a share to ${level}.`);
  }

  async setShareMode(shareId: string, mode: ShareMode): Promise<Queued<void>> {
    const summary = mode === "follow" ? "Make a share follow the latest version." : "Pin a share to its version.";
    return this.changeShareTerms(shareId, { mode }, { mode }, "share.mode", summary);
  }

  async updateShare(shareId: string, input: { revision: string; projection: string }): Promise<Queued<void>> {
    refuseOversize(input.projection, MAX_SHARE_PROJECTION_BYTES, "What this share would show");
    const share = await this.shareDoc(shareId);
    if (share === null) throw new CloudError("not-found", "That share does not exist, or you cannot open it.");
    const { fields, signed } = await this.projectionFields(shareId, share, await this.openTeamToSeal(share.ownerTeamId), input.projection, input.revision);
    const queued = await this.changeShare(shareId, { revision: input.revision, ...fields }, "share.update", "Update a share to a newer version.");
    this.pinSharesWhenSent(queued.sent, new Map([[shareId, signed]]));
    return queued;
  }

  async setShareTeams(shareId: string, teamIds: string[], options: PartnerKeyAnswers = {}): Promise<Queued<void>> {
    const doc = await this.shareDoc(shareId);
    if (doc === null) throw new CloudError("not-found", "That share does not exist, or you cannot open it.");
    if (doc.audience !== "teams") throw new CloudError("invalid", "An anyone-with-the-link share names no teams.");
    if (doc.revokedAt !== null) throw new CloudError("invalid", "That share was revoked; make a new one instead.");
    const next = [...new Set(teamIds)];
    if (next.length === 0) throw new CloudError("invalid", "A share names at least one team; revoke it to stop sharing.");
    if (next.length > MAX_SHARE_TEAMS) throw new CloudError("invalid", `One share can name at most ${String(MAX_SHARE_TEAMS)} teams. Make a second share for the others.`);
    if (next.includes(doc.ownerTeamId)) throw new CloudError("invalid", "Your own team already sees the library; share with other teams.");
    const added = next.filter((teamId) => !doc.teamIds.includes(teamId));
    // Taking a team off always goes ahead; adding one hands it the share under the current key.
    const owner = added.length > 0 ? await this.openTeamToSeal(doc.ownerTeamId) : await this.openTeam(doc.ownerTeamId);
    const { key: current, manifest } = await this.ownedShareKey(shareId, doc, owner, true);
    const removed = doc.teamIds.filter((teamId) => !next.includes(teamId));
    // A new key when a team is taken off, or when a team key this share's key is wrapped under
    // changed since (a member removed or a device revoked), so neither can open anything new.
    const rekey = removed.length > 0 || (await this.shareKeyStale(manifest, owner.newest.key.version));
    let patch: DocData;
    let signed: Signed;
    if (!rekey) {
      // Only teams added: the same key, wrapped again to every team, so the new manifest signs only
      // key versions this device wrapped to, none older than the manifest it replaces names.
      const { wraps: keyWraps, teams } = await this.wrapToTeams(shareId, current, next, options, signedTeamKeys(manifest));
      const seq = manifest.seq + 1;
      const resigned = await this.signedManifest(owner, { ...manifest, seq, teams }, { manifest: doc.manifest, body: manifest });
      patch = { teamIds: next, keyWraps, manifest: resigned.manifest };
      signed = { kv: current.version, okv: owner.newest.key.version, seq, tseq: resigned.tseq };
    } else {
      // The old key is sealed under the new one for what was made under it, and the projection is
      // sealed again under the new key.
      const plain = await guarded("A share's projection", () =>
        openText(current, doc.projection, aadFor.shareProjection({ shareId, autoId: manifest.autoId, kv: current.version })),
      );
      const rekeyed = await this.rekeyedShareFields(shareId, doc, owner, current, manifest, next, plain, options);
      patch = { teamIds: next, ...rekeyed.fields };
      signed = rekeyed.signed;
    }
    const uid = this.uid();
    const queued = await this.write("share", removed.length === 0 ? "Share with more teams." : "Take a team off a share.", [
      { op: "update", path: paths.share(shareId), data: { ...patch, updatedAt: SERVER_TIME } },
      ...added.map((teamId): Write => ({
        op: "set",
        path: paths.inboxEntry(teamId, shareId),
        data: { shareId, ownerTeamId: doc.ownerTeamId, createdBy: uid, createdAt: SERVER_TIME },
      })),
      this.activity(doc.ownerTeamId, "share.teams", shareId, next.join(",")),
    ], undefined);
    this.pinSharesWhenSent(queued.sent, new Map([[shareId, signed]]));
    return queued;
  }

  // ------------------------------------------------------------ proposals

  async sendProposal(input: SendProposalInput): Promise<Queued<Proposal>> {
    const uid = this.uid();
    const share = await this.shareDoc(input.shareId);
    if (share === null || share.revokedAt !== null || share.expiresAt.getTime() <= this.now().getTime()) {
      throw new CloudError("not-found", "That share has expired, was revoked, or was never shared with your team.");
    }
    if (share.level !== "propose") throw new CloudError("permission-denied", "That share is view only, so it does not take proposals.");
    if (!share.teamIds.includes(input.fromTeamId)) throw new CloudError("permission-denied", "That share was not made to the team you are proposing from.");
    if (input.diff.length === 0) throw new CloudError("invalid", "A proposal needs at least one change.");
    refuseOversize(input.diff, MAX_PROPOSAL_DIFF_BYTES, "This proposal");
    // A pinned share shows one revision, and the rules take a proposal only against that one; a
    // following share takes one against any revision of the auto (spec 13 section 14).
    if (share.mode === "pinned" && input.baseRevision !== share.revision) {
      throw new CloudError(
        "conflict",
        "That share now shows a different version of the auto from the one this proposal was made against. Reload the partner and make the proposal again.",
      );
    }
    // The share key opens only once the share's manifest checks, and that check is what makes this
    // device trust the owner team's key of the version the manifest was signed under.
    const team = await this.openTeamToSeal(input.fromTeamId);
    const { manifest } = await this.openShareKey(input.shareId, share, { kind: "recipient", team });
    // A team that proposes cannot re-key the sharing team's share, so it sends nothing while a key the
    // share depends on is stale: the owner team's key version it wraps to must be that team's newest,
    // so a member the owner team took off cannot open it. The versions the key was wrapped to come
    // from the verified manifest, and the newest versions from what the teams show and what this
    // device has pinned of them, whichever is newer.
    if (manifest === null) throw new CloudError("permission-denied", "A link share does not take proposals.");
    const ownerKeyVersion = await this.newestKnownKeyVersion(share.ownerTeamId);
    if (await this.shareKeyStale(manifest, ownerKeyVersion, new Map([[input.fromTeamId, team.newest.key.version]]))) {
      throw new CloudError(
        "conflict",
        "A team on this share changed its team key since the share was last updated, so someone taken off that team could read a proposal sent now. Nothing was sent. Ask the team that shared this auto to update the share, then send the proposal again.",
      );
    }
    // The diff is sealed under a key of its own, never under the share key, which every team on the
    // share holds. That key is wrapped to the owner team's verified key and sealed under this team's
    // newest key, so the owner team reads the proposal, this team reads what it sent, and no other
    // team on the share reads either.
    await this.refuseNumberPinnedElsewhere(share.ownerTeamId);
    const ownerEncKey = await this.verifiedOwnerEncKey(share.ownerTeamId, manifest.okv);
    const proposalId = randomId(this.random);
    const binding: ProposalBinding = {
      proposalId,
      shareId: input.shareId,
      ownerTeamId: share.ownerTeamId,
      fromTeamId: input.fromTeamId,
      okv: ownerEncKey.v,
      fkv: team.newest.key.version,
    };
    const sealed = await guarded("A proposal", () =>
      sealProposal({ binding, diffText: input.diff, ownerEncKey, fromTeamKey: team.newest.key, random: this.random }),
    );
    const { diff, ownerWrap, fromWrap } = sealed;
    refuseSealedOversize(diff, MAX_PROPOSAL_DIFF_BYTES, "This proposal");
    // Signed with this team's signing key of the version the proposal key is sealed under, so the
    // owner team can tell a proposal this team made from one anyone made by wrapping to its encKey.
    const sig = await guarded("A proposal", () =>
      signProposal({ binding, context: { autoId: share.autoId, baseRevision: input.baseRevision }, sealed, signingKey: team.newest.pair.signingKey }),
    );
    const meta = {
      shareId: input.shareId,
      ownerTeamId: share.ownerTeamId,
      autoId: share.autoId,
      fromTeamId: input.fromTeamId,
      baseRevision: input.baseRevision,
      status: "open" as const,
      createdBy: uid,
    };
    return this.write("proposal", "Send a proposed change.", [
      { op: "set", path: paths.proposal(proposalId), data: { ...meta, diff, ownerWrap, fromWrap, sig, createdAt: SERVER_TIME } },
      this.activity(input.fromTeamId, "proposal.send", proposalId),
    ], { id: proposalId, ...meta, createdAt: this.now(), diff: input.diff });
  }

  async listProposals(teamId: string, direction: "received" | "sent"): Promise<Proposal[]> {
    const fieldName = direction === "received" ? "ownerTeamId" : "fromTeamId";
    const docs = await this.store().list({ collection: paths.proposals(), where: [{ field: fieldName, value: teamId }] });
    if (docs.length === 0) return [];
    const team = await this.openTeam(teamId);
    // Each share is read and its manifest checked once per listing, however many proposals name it.
    const anchors = new Map<string, Promise<ProposalAnchor | null>>();
    const proposals: Proposal[] = [];
    for (const doc of docs) {
      const data = doc.data as unknown as ProposalDoc;
      // A received proposal is listed only when the team it says it is from signed it, with a key
      // this team's own share names for that team or this device pinned for it: anyone can wrap a
      // key to this team's public key, the server included, and the server can show any key as
      // another team's.
      if (direction === "received" && !(await this.signedByProposer(doc.id, data, team, anchors))) continue;
      proposals.push(await this.openProposal(doc.id, data, team, direction));
    }
    return proposals.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  /**
   * True when a received proposal belongs to a share of this team (`owner`) and its signature checks
   * with a signing key of the proposing team that this device can anchor, in this order: the
   * proposal names `owner` as its owner team; the share it names is `owner`'s, and its manifest
   * checks with `owner`'s own key chain and is live (`proposalAnchor`); the proposal is for the auto
   * that manifest names; the signing key of the version the proposal is sealed under (`fromWrap.kv`)
   * is anchored on the key the manifest names for the proposing team, or on this device's pin of that
   * team, and never trusted on first use (`proposerSigningKey`); and the signature, over the binding,
   * the auto, the base revision and the sealed fields, verifies with that key. False otherwise, and
   * the proposal is not listed: the server alone could have made it. Nothing here moves this
   * device's pins. `anchors` caches each share's answer for one listing.
   */
  private async signedByProposer(proposalId: string, doc: ProposalDoc, owner: OpenedTeam, anchors: Map<string, Promise<ProposalAnchor | null>>): Promise<boolean> {
    if (doc.ownerWrap === undefined || doc.fromWrap === undefined || "ekv" in doc.fromWrap) return true; // openProposal refuses these with its own sentence.
    if (doc.ownerTeamId !== owner.teamId || typeof doc.shareId !== "string") return false;
    let pending = anchors.get(doc.shareId);
    if (pending === undefined) {
      pending = this.proposalAnchor(doc.shareId, owner);
      anchors.set(doc.shareId, pending);
    }
    const share = await pending;
    if (share === null || share.autoId !== doc.autoId) return false;
    const signSpki = await this.proposerSigningKey(doc.fromTeamId, doc.fromWrap.kv, share.teams.get(doc.fromTeamId));
    if (signSpki === null) return false;
    try {
      return await verifyProposal({
        binding: { proposalId, shareId: doc.shareId, ownerTeamId: doc.ownerTeamId, fromTeamId: doc.fromTeamId, okv: doc.ownerWrap.ekv, fkv: doc.fromWrap.kv },
        context: { autoId: doc.autoId, baseRevision: doc.baseRevision },
        sealed: { diff: doc.diff, ownerWrap: doc.ownerWrap, fromWrap: doc.fromWrap },
        sig: doc.sig,
        signSpki,
      });
    } catch (error) {
      if (isCryptoError(error)) return false;
      throw error;
    }
  }

  /**
   * What share `shareId` says about the proposals made on it, as the owner team's device `owner`
   * checks it: the auto its manifest names and, for each team it names, the version and digest of
   * the key the share key was wrapped to. Null, so that no proposal on it is listed, when the share
   * is missing or not readable, is not `owner`'s, or its manifest does not check with `owner`'s key
   * chain (`checkedManifest`) or is not live (`vouchedManifest`: a manifest signed with an older key
   * that the newest roster does not list may be one a member taken off the team made, naming any
   * team with any key), or is a link share, which takes no proposals. Reads pins but moves none.
   */
  private async proposalAnchor(shareId: string, owner: OpenedTeam): Promise<ProposalAnchor | null> {
    try {
      const doc = await this.shareDoc(shareId);
      if (doc === null || doc.ownerTeamId !== owner.teamId) return null;
      const { body } = await this.checkedManifest(shareId, doc, { kind: "owner", team: owner });
      await this.vouchedManifest(shareId, doc, body, owner);
      // A link share takes no proposals (`sendProposal`), so none is listed on one, whatever pins say.
      if (body.audience !== "teams") return null;
      return { autoId: body.autoId, teams: signedTeamKeys(body) };
    } catch (error) {
      if (isCloudError(error, "tampered") || isCloudError(error, "invalid") || isCloudError(error, "not-found")) return null;
      throw error;
    }
  }

  /**
   * The signing public key of version `fkv` of team `teamId`, for checking a proposal that team made
   * on a share whose verified manifest names it by `named` (`[teamId, ekv, digest]`), or does not
   * name it (undefined), or null when this device cannot anchor it. Two anchors, and never trust on
   * first use:
   *
   * - **The manifest.** When the manifest names the team and `fkv` is `ekv` or newer, the team's key
   *   of version `ekv` must have the digest the manifest names, and the key of version `fkv` must be
   *   that key or one reached from it by the team's signed rotations (`signedFrom`), as a re-key
   *   checks it (`reachesSignedKey`).
   * - **A pin.** This device's newest checked pin of the team at `fkv` or below (`checkedPinAt`):
   *   its partner pin, for a member its team pin, or one of the partner pins it held before
   *   (`readEarlierPartnerPins`). A partner pin that was only trusted on first use, such as the one
   *   opening a received share writes, counts as no pin at all: the server alone can make that
   *   share. When there is one, the key of version `fkv` must be the pinned key or one reached from
   *   it, whether or not the manifest also anchors it, so a pin still catches a key the server
   *   swapped in.
   *
   * The manifest cannot anchor a key older than `ekv`, since signatures only reach forward, nor any
   * key of a team it does not name (a team taken off the share since the proposal was sent): those
   * need the pin, and with none there, it is null. Unlike `partnerSigningKey` it never moves a pin,
   * so the proposals of one listing are checked against the same pins in any order.
   */
  private async proposerSigningKey(teamId: string, fkv: number, named: SignedTeamKey | undefined): Promise<Uint8Array | null> {
    let pin: Pin | null;
    try {
      pin = this.checkedPinAt(teamId, fkv);
    } catch (error) {
      if (isCloudError(error, "tampered")) return null;
      throw error;
    }
    const byManifest = named !== undefined && fkv >= named[1];
    if (!byManifest && pin === null) return null;
    try {
      const target = await this.publicKeyAt(teamId, fkv);
      if (target === null) return null;
      if (byManifest) {
        const [, ekv, digest] = named;
        const manifestKey = fkv === ekv ? target : await this.keyRecordAt(teamId, ekv);
        if (manifestKey === null || !bytesEqual(await teamKeyDigest({ teamId, ...manifestKey }), digest)) return null;
        if (fkv > ekv && !(await this.signedFrom(teamId, manifestKey, target))) return null;
      }
      if (pin !== null) {
        const same = pin.v === fkv && bytesEqual(pin.fingerprint, target.fingerprint) && bytesEqual(pin.signSpki, target.signSpki);
        if (!same && (pin.v === fkv || !(await this.signedFrom(teamId, pin, target)))) return null;
      }
      return target.signSpki;
    } catch (error) {
      // A team deleted since, or one whose public key does not check, signs nothing this device can trust.
      if (isCloudError(error, "not-found") || isCloudError(error, "tampered") || isCryptoError(error)) return null;
      throw error;
    }
  }

  /**
   * The newest pin of `teamId`'s key at version `fkv` or below that this device checked: its team
   * pin, for a member, its partner pin, and the partner pins it held before, leaving out every
   * partner pin that was only trusted on first use (`Pin.firstUse`). Null for none. "Tampered" when
   * the partner pin and the team pin differ under one version (`pinnedTeamKey`).
   */
  private checkedPinAt(teamId: string, fkv: number): Pin | null {
    this.pinnedTeamKey(teamId);
    const uid = this.uid();
    const pins = [readPin(this.trust, uid, "team", teamId), readPin(this.trust, uid, "partner", teamId), ...readEarlierPartnerPins(this.trust, uid, teamId)];
    let newest: Pin | null = null;
    for (const pin of pins) {
      if (pin === null || pin.firstUse === true || pin.v > fkv) continue;
      if (newest === null || pin.v > newest.v) newest = pin;
    }
    return newest;
  }

  /**
   * The owner team's public key of version `okv`, the version the share's manifest was signed under,
   * for a proposal key to be wrapped to. `openShareKey` checked that manifest with the signing key of
   * that version, from this device's pin of the owner team or reached from it by the team's signed
   * rotations, and pinned it; the key wrapped to must be the one that pin holds, whatever the server
   * shows now. Anything else is "tampered". A pin trusted on first use counts here: the share was
   * checked against that key, and a proposal goes only to the team whose share it answers.
   */
  private async verifiedOwnerEncKey(teamId: string, okv: number): Promise<TeamEncKey> {
    const pin = this.pinnedTeamKey(teamId);
    const refused = new CloudError(
      "tampered",
      "The key of the team that shared this auto is not the one this device checked the share against, so a proposal wrapped to it could be read by someone else. Nothing was sent. Compare the team safety code with that team.",
    );
    if (pin === null || pin.v !== okv) throw refused;
    const team = await this.keys.team(teamId);
    let encKey: TeamEncKey;
    if (team.encKey.v === okv) {
      encKey = team.encKey;
    } else {
      const record = (await this.getOrNull(keyPaths.teamKey(teamId, okv))) as TeamKeyRecord | null;
      if (record === null || record.kv !== okv || !(record.pairSpki instanceof Uint8Array) || !(record.signSpki instanceof Uint8Array)) throw refused;
      encKey = { v: okv, spki: record.pairSpki, fingerprint: await guarded("The team's public key", () => teamKeyFingerprint(record.pairSpki)), signSpki: record.signSpki, sig: record.sig };
    }
    await guarded("The team's public key", () => checkTeamEncKey(encKey));
    if (!bytesEqual(encKey.fingerprint, pin.fingerprint) || !bytesEqual(encKey.signSpki, pin.signSpki)) throw refused;
    return encKey;
  }

  /**
   * A proposal with its diff opened. The team that sent it opens the proposal key from `fromWrap`
   * with its team key of that version; the team that owns the share opens it from `ownerWrap` with its
   * team key pair of that version. Both come from the key chain `openTeam` checked. No other team,
   * including another team the share was made to, holds either key.
   */
  private async openProposal(proposalId: string, doc: ProposalDoc, team: OpenedTeam, direction: "received" | "sent"): Promise<Proposal> {
    if (doc.ownerWrap === undefined || doc.fromWrap === undefined || "ekv" in doc.fromWrap) {
      throw new CloudError(
        "tampered",
        "This proposal was sealed in a format from before each proposal had its own key, which this version of Zenith does not open. Ask the team that sent it to send it again.",
      );
    }
    const binding: ProposalBinding = {
      proposalId,
      shareId: doc.shareId,
      ownerTeamId: doc.ownerTeamId,
      fromTeamId: doc.fromTeamId,
      okv: doc.ownerWrap.ekv,
      fkv: doc.fromWrap.kv,
    };
    const diff = await guarded("A proposal", () =>
      direction === "sent"
        ? openProposalAsSender({ binding, diff: doc.diff, fromWrap: doc.fromWrap, teamKey: teamKeyAt(team, doc.fromWrap.kv) })
        : openProposalAsOwner({ binding, diff: doc.diff, ownerWrap: doc.ownerWrap, pair: teamPairAt(team, doc.ownerWrap.ekv) }),
    );
    const { diff: _diff, ownerWrap: _ownerWrap, fromWrap: _fromWrap, sig: _sig, ...meta } = doc;
    return { id: proposalId, ...meta, diff };
  }

  private async closeProposal(proposalId: string, status: "accepted" | "rejected" | "withdrawn"): Promise<Queued<void>> {
    const data = await this.require(paths.proposal(proposalId), "That proposal");
    const proposal = data as unknown as ProposalDoc;
    const teamId = status === "withdrawn" ? proposal.fromTeamId : proposal.ownerTeamId;
    return this.write("proposal", `Mark a proposal ${status}.`, [
      { op: "update", path: paths.proposal(proposalId), data: { status, decidedBy: this.uid(), decidedAt: SERVER_TIME } },
      this.activity(teamId, "proposal.decide", proposalId, status),
    ], undefined);
  }

  async decideProposal(proposalId: string, decision: "accepted" | "rejected"): Promise<Queued<void>> {
    return this.closeProposal(proposalId, decision);
  }

  async withdrawProposal(proposalId: string): Promise<Queued<void>> {
    return this.closeProposal(proposalId, "withdrawn");
  }

  // ------------------------------------------------------------ more time (spec 13 section 8.4)

  async requestMoreTime(input: RequestMoreTimeInput): Promise<Queued<TimeRequest>> {
    const uid = this.uid();
    if (input.reason !== undefined && !TIME_REQUEST_REASONS.includes(input.reason)) {
      throw new CloudError("invalid", "Pick a reason from the list, or none.");
    }
    const asked = this.now();
    if (input.wantedUntil !== undefined && input.wantedUntil.getTime() <= asked.getTime()) {
      throw new CloudError("invalid", "The end you would like has already passed. Pick a later one.");
    }
    // Both reads are queries, which answer from this device's cache offline, so a request can be
    // made at an event with no connection and wait in the outbox (ADR 0009 section 3).
    const pointers = await this.store().list({ collection: paths.inbox(input.teamId), where: [{ field: "shareId", value: input.shareId }] });
    const pointer = pointers[0];
    if (pointer === undefined) {
      throw new CloudError("not-found", "That share was not made to your team, so there is no team to ask.");
    }
    const earlier = await this.store().list({
      collection: `${paths.share(input.shareId)}/timeRequests`,
      where: [{ field: "teamId", value: input.teamId }],
    });
    if (earlier.some((doc) => doc.data.status === "open")) {
      throw new CloudError("conflict", "Your team has already asked for more time on this share, and the team that made it has not answered yet.");
    }
    const doc: TimeRequestDoc = {
      shareId: input.shareId,
      teamId: input.teamId,
      ownerTeamId: String(pointer.data.ownerTeamId),
      requestedBy: uid,
      requestedAt: asked,
      status: "open",
    };
    if (input.reason !== undefined) doc.reason = input.reason;
    if (input.wantedUntil !== undefined) doc.wantedUntil = input.wantedUntil;
    return this.write("share", "Ask for more time on a share.", [
      { op: "set", path: paths.timeRequest(input.shareId, input.teamId), data: { ...doc, requestedAt: SERVER_TIME } },
      this.activity(input.teamId, "time.request", input.shareId, input.reason),
    ], doc);
  }

  async listTimeRequests(teamId: string, direction: "received" | "sent"): Promise<TimeRequest[]> {
    const fieldName = direction === "received" ? "ownerTeamId" : "teamId";
    const docs = await this.store().list({ collection: paths.timeRequestsGroup(), group: true, where: [{ field: fieldName, value: teamId }] });
    return docs
      .map((doc) => doc.data as unknown as TimeRequest)
      .sort((a, b) => b.requestedAt.getTime() - a.requestedAt.getTime() || a.teamId.localeCompare(b.teamId));
  }

  async decideTimeRequest(shareId: string, teamId: string, decision: TimeRequestDecision): Promise<Queued<void>> {
    const uid = this.uid();
    const path = paths.timeRequest(shareId, teamId);
    const request = (await this.require(path, "That request for more time")) as unknown as TimeRequestDoc;
    if (request.status !== "open") throw new CloudError("conflict", "That request for more time has already been answered.");
    if (decision.status === "declined") {
      return this.write("share", "Decline a request for more time.", [
        { op: "update", path, data: { status: "declined", decidedBy: uid, decidedAt: SERVER_TIME } },
        this.activity(request.ownerTeamId, "time.decline", shareId, teamId),
      ], undefined);
    }
    const share = await this.shareDoc(shareId);
    if (share === null) throw new CloudError("not-found", "That share does not exist, or you cannot open it.");
    if (share.revokedAt !== null) throw new CloudError("invalid", "That share was revoked, so it cannot be given more time; make a new one instead.");
    const later = Math.max(share.expiresAt.getTime(), this.now().getTime());
    if (decision.expiresAt.getTime() <= later) {
      throw new CloudError("invalid", "Giving more time must move the end later than it is now. Pick a later end.");
    }
    // The new end is one of the share's terms, so the manifest that signs them is signed again with it.
    const owner = await this.openTeam(share.ownerTeamId);
    const { manifest } = await this.ownedShareKey(shareId, share, owner);
    const seq = manifest.seq + 1;
    const signed = await this.signedManifest(owner, { ...manifest, expiresAtMs: decision.expiresAt.getTime(), seq }, { manifest: share.manifest, body: manifest });
    const queued = this.write("share", "Give another team more time on a share.", [
      { op: "update", path: paths.share(shareId), data: { expiresAt: decision.expiresAt, manifest: signed.manifest, updatedAt: SERVER_TIME } },
      {
        op: "update",
        path,
        data: { status: "granted", decidedBy: uid, decidedAt: SERVER_TIME, grantedUntil: decision.expiresAt },
      },
      this.activity(request.ownerTeamId, "time.grant", shareId, teamId),
    ], undefined);
    this.pinSharesWhenSent(queued.sent, new Map([[shareId, { kv: share.projection.kv, okv: owner.newest.key.version, seq, tseq: signed.tseq }]]));
    return queued;
  }

  async listEndedShares(teamId: string): Promise<EndedShare[]> {
    const inbox = await this.store().list({ collection: paths.inbox(teamId) });
    const nowMs = this.now().getTime();
    const ended: EndedShare[] = [];
    for (const entry of inbox) {
      const shareId = lastSegment(entry.path);
      const share = await this.shareDoc(shareId);
      if (share !== null && share.revokedAt === null && share.expiresAt.getTime() > nowMs && share.teamIds.includes(teamId)) continue;
      const receivedAt = entry.data.createdAt;
      ended.push({
        shareId,
        ownerTeamId: String(entry.data.ownerTeamId),
        receivedAt: receivedAt instanceof Date ? receivedAt : new Date(nowMs),
      });
    }
    return ended.sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime());
  }

  // ------------------------------------------------------------ team numbers (spec 13 section 4.4)

  /** The public part of a claim, which anyone signed in reads. */
  private async claimRecord(teamNumber: number): Promise<ClaimRecord | null> {
    const data = await this.getOrNull(paths.claim(teamNumber));
    return data === null ? null : { teamNumber, ...(data as unknown as ClaimDoc) };
  }

  async getClaim(teamNumber: number, forTeamId?: string): Promise<Claim | null> {
    const claim = await this.claimRecord(teamNumber);
    if (claim === null) return null;
    return { ...claim, history: await this.claimHistory(teamNumber, forTeamId) };
  }

  /**
   * The history steps the caller may read, oldest first. The rules let a team's active members list
   * the steps filtered on either team field, and a Horizon admin list them all; a refusal is no steps.
   */
  private async claimHistory(teamNumber: number, forTeamId?: string): Promise<ClaimHistoryEntry[]> {
    return (await this.claimSteps(teamNumber, forTeamId)).map(([, entry]) => entry);
  }

  /** `claimHistory` with each step's index. */
  private async claimSteps(teamNumber: number, forTeamId?: string): Promise<[number, ClaimHistoryEntry][]> {
    const collection = paths.claimHistory(teamNumber);
    const listed = async (query: Query): Promise<StoredDoc[]> => {
      try {
        return await this.store().list(query);
      } catch (error) {
        if (isCloudError(error, "permission-denied")) return [];
        throw error;
      }
    };
    const docs =
      forTeamId === undefined
        ? await listed({ collection })
        : [
            ...(await listed({ collection, where: [{ field: "teamId", value: forTeamId }] })),
            ...(await listed({ collection, where: [{ field: "otherTeamId", value: forTeamId }] })),
          ];
    const byIndex = new Map<number, ClaimHistoryEntry>();
    for (const doc of docs) byIndex.set(Number(doc.id), doc.data as unknown as ClaimHistoryEntry);
    return [...byIndex.entries()].sort(([a], [b]) => a - b);
  }

  /** The step to add to a claim's history; the rules require it to be by the caller, at the server's time. */
  private stepWrite(teamNumber: number, index: number, entry: ClaimHistoryEntry): Write {
    return { op: "set", path: paths.claimStep(teamNumber, index), data: { ...entry, at: SERVER_TIME } };
  }

  /**
   * The claim on a team's number, as deleting the team leaves it. A claim that is nothing but that
   * team's claim is dropped with its one step. A claim with more history (a request, a review, a
   * decision) is kept, because its history belongs to every team involved, but detached: nobody holds
   * the number, it is no longer verified to anyone, and a `release` step records why. A review still
   * open keeps its status for the reviewer to decide. Another team may then claim the number afresh.
   */
  private async detachClaimWrites(teamNumber: number, teamId: string): Promise<Write[]> {
    const claim = await this.claimRecord(teamNumber);
    if (claim === null || claim.teamId !== teamId) return [];
    if (claim.historyCount === 1) {
      return [
        { op: "delete", path: paths.claim(teamNumber) },
        { op: "delete", path: paths.claimStep(teamNumber, 0) },
      ];
    }
    const status = (claim.disputeId ?? null) === null ? "unverified" : claim.status;
    return [
      { op: "update", path: paths.claim(teamNumber), data: { teamId: null, status, historyCount: claim.historyCount + 1 } },
      this.stepWrite(teamNumber, claim.historyCount, this.historyEntry("release", teamId, null)),
    ];
  }

  private requireNumber(teamNumber: number): void {
    if (!Number.isInteger(teamNumber) || teamNumber < 1 || teamNumber > 999_999) {
      throw new CloudError("invalid", "An FTC team number is a whole number from 1 to 999999.");
    }
  }

  private historyEntry(
    kind: ClaimHistoryEntry["kind"],
    teamId: string,
    otherTeamId: string | null,
    extra: Partial<ClaimHistoryEntry> = {},
  ): ClaimHistoryEntry {
    const entry: ClaimHistoryEntry = { kind, teamId, otherTeamId, by: this.uid(), at: this.now() };
    if (extra.disputeId !== undefined) entry.disputeId = extra.disputeId;
    if (extra.requestId !== undefined) entry.requestId = extra.requestId;
    if (extra.note !== undefined) entry.note = extra.note;
    return entry;
  }

  async claimNumber(teamId: string, teamNumber: number): Promise<Queued<ClaimOutcome>> {
    this.requireNumber(teamNumber);
    const team = await this.getTeam(teamId);
    if (team === null) throw new CloudError("not-found", "That team does not exist, or you cannot open it.");
    if (team.number !== null) {
      throw new CloudError("conflict", `Your team already has number ${String(team.number)}. A team holds one number.`);
    }
    const reviews = (await this.listDisputes(teamId)).filter(
      (d) => d.challengerTeamId === teamId && (d.status === "open" || d.status === "appealed"),
    );
    if (reviews.length > 0) {
      throw new CloudError(
        "conflict",
        `Your team's claim on number ${String(reviews[0]?.teamNumber)} is still under review. Wait for the decision before claiming another number.`,
      );
    }
    const claim = await this.claimRecord(teamNumber);
    if (claim === null || claim.teamId === null) {
      const released = claim === null ? null : await this.claimableRecord(teamNumber);
      const writes: Write[] = [
        { op: "update", path: paths.team(teamId), data: { number: teamNumber } },
        ...this.claimWrites(teamNumber, teamId, released),
        this.activity(teamId, "team.claim", String(teamNumber)),
      ];
      const value: Claim = {
        teamNumber,
        teamId,
        status: "unverified",
        claimedAt: this.now(),
        historyCount: (released?.historyCount ?? 0) + 1,
        history: [this.historyEntry("claim", teamId, null)],
        disputeId: null,
        requestId: null,
      };
      return this.write("team", `Claim team number ${String(teamNumber)}.`, writes, { outcome: "claimed", claim: value });
    }
    if (claim.status === "verified") {
      throw new CloudError(
        "conflict",
        `Team number ${String(teamNumber)} is verified to another team, so it cannot be claimed. If that team is wrong, ask for a review of the number, with your evidence, and a Horizon admin will decide.`,
      );
    }
    const dispute = await this.openDispute({ teamNumber, challengerTeamId: teamId });
    return { value: { outcome: "contested", dispute: dispute.value }, outboxId: dispute.outboxId, sent: dispute.sent };
  }

  async openDispute(input: { teamNumber: number; challengerTeamId: string }): Promise<Queued<Dispute>> {
    const uid = this.uid();
    this.requireNumber(input.teamNumber);
    const claim = await this.claimRecord(input.teamNumber);
    if (claim === null || claim.teamId === null) {
      throw new CloudError("not-found", `No team holds number ${String(input.teamNumber)}, so your team can simply claim it.`);
    }
    if (claim.teamId === input.challengerTeamId) throw new CloudError("invalid", "Your team already holds that number.");
    if ((claim.disputeId ?? null) !== null) {
      throw new CloudError(
        "conflict",
        `Team number ${String(input.teamNumber)} is already under review. A Horizon admin decides one review at a time; try again after that decision.`,
      );
    }
    const challenger = await this.getTeam(input.challengerTeamId);
    if (challenger === null) throw new CloudError("not-found", "That team does not exist, or you cannot open it.");
    if (challenger.number !== null) {
      throw new CloudError("conflict", `Your team already has number ${String(challenger.number)}. A team holds one number.`);
    }
    const disputeId = randomId(this.random);
    const doc: DisputeDoc = {
      teamNumber: input.teamNumber,
      holderTeamId: claim.teamId,
      challengerTeamId: input.challengerTeamId,
      openedBy: uid,
      createdAt: this.now(),
      status: "open",
      evidence: [],
      decision: null,
      appeal: null,
      appealDecision: null,
    };
    const contest = this.historyEntry("contest", input.challengerTeamId, claim.teamId, { disputeId });
    const status = claim.status === "verified" ? "verified" : "contested";
    const writes: Write[] = [
      { op: "set", path: paths.dispute(disputeId), data: { ...doc, createdAt: SERVER_TIME } },
      { op: "update", path: paths.claim(input.teamNumber), data: { status, historyCount: claim.historyCount + 1, disputeId } },
      this.stepWrite(input.teamNumber, claim.historyCount, contest),
    ];
    // Spec 13 section 4.4: on an unverified number both claims become contested, so both teams wear
    // the label until a Horizon admin decides. A review of a verified number labels neither.
    if (status === "contested") {
      const holder = await this.getTeam(claim.teamId);
      if (holder !== null && holder.status === "unverified" && holder.number === input.teamNumber) {
        writes.push({ op: "update", path: paths.team(claim.teamId), data: { status: "contested" } });
      }
      if (challenger.status === "unverified") {
        // The label names the review this write opens: the rules take it only together with that review.
        writes.push({ op: "update", path: paths.team(input.challengerTeamId), data: { status: "contested", disputeId } });
      }
    }
    writes.push(this.activity(input.challengerTeamId, "dispute.open", disputeId, String(input.teamNumber)));
    return this.write("dispute", `Open a review of team number ${String(input.teamNumber)}.`, writes, { id: disputeId, ...doc });
  }

  private checkEvidence(evidence: EvidenceInput[]): Evidence[] {
    const at = this.now();
    const by = this.uid();
    return evidence.map((row) => {
      const problem = evidenceProblem(row);
      if (problem !== null) throw new CloudError("invalid", problem);
      return { ...cleanEvidence(row), by, at };
    });
  }

  async requestVerification(teamId: string, evidence: EvidenceInput[]): Promise<Queued<VerificationRequest>> {
    if (evidence.length === 0) throw new CloudError("invalid", "Add at least one piece of evidence for the reviewer.");
    if (evidence.length > MAX_REQUEST_EVIDENCE) {
      throw new CloudError("invalid", `A request carries at most ${String(MAX_REQUEST_EVIDENCE)} pieces of evidence; choose the clearest.`);
    }
    const rows = this.checkEvidence(evidence);
    const team = await this.getTeam(teamId);
    if (team === null) throw new CloudError("not-found", "That team does not exist, or you cannot open it.");
    if (team.number === null) throw new CloudError("invalid", "Claim a team number before asking for it to be verified.");
    const claim = await this.claimRecord(team.number);
    if (claim === null || claim.teamId !== teamId) {
      throw new CloudError("conflict", `Your team does not hold number ${String(team.number)}, so it cannot be verified for you.`);
    }
    if (claim.status === "verified") throw new CloudError("invalid", `Number ${String(team.number)} is already verified to your team.`);
    if (claim.status === "contested" || (claim.disputeId ?? null) !== null) {
      throw new CloudError("conflict", `Number ${String(team.number)} is contested. Add your evidence to its review instead, and a Horizon admin will decide the dispute.`);
    }
    if ((claim.requestId ?? null) !== null) {
      throw new CloudError("conflict", "Your team has already asked for verification. A Horizon admin will decide it; you will see the reason here.");
    }
    const requestId = randomId(this.random);
    const doc: VerificationRequestDoc = {
      teamNumber: team.number,
      teamId,
      requestedBy: this.uid(),
      createdAt: this.now(),
      status: "open",
      evidence: rows,
      decision: null,
    };
    const writes: Write[] = [
      { op: "set", path: paths.verification(requestId), data: { ...doc, createdAt: SERVER_TIME } },
      { op: "update", path: paths.claim(team.number), data: { historyCount: claim.historyCount + 1, requestId } },
      this.stepWrite(team.number, claim.historyCount, this.historyEntry("request", teamId, null, { requestId })),
      this.activity(teamId, "verification.request", requestId, String(team.number)),
    ];
    return this.write("dispute", `Ask for team number ${String(team.number)} to be verified.`, writes, { id: requestId, ...doc });
  }

  async listVerificationRequests(teamId: string): Promise<VerificationRequest[]> {
    const docs = await this.store().list({ collection: paths.verifications(), where: [{ field: "teamId", value: teamId }] });
    return docs
      .map((doc) => ({ id: doc.id, ...(doc.data as unknown as VerificationRequestDoc) }))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  private async dispute(disputeId: string): Promise<Dispute> {
    const data = await this.require(paths.dispute(disputeId), "That review");
    return { id: disputeId, ...(data as unknown as DisputeDoc) };
  }

  async getDispute(disputeId: string): Promise<Dispute | null> {
    const data = await this.getOrNull(paths.dispute(disputeId));
    return data === null ? null : { id: disputeId, ...(data as unknown as DisputeDoc) };
  }

  async addDisputeEvidence(disputeId: string, evidence: EvidenceInput & { team: string }): Promise<Queued<void>> {
    const dispute = await this.dispute(disputeId);
    if (evidence.team !== dispute.holderTeamId && evidence.team !== dispute.challengerTeamId) {
      throw new CloudError("invalid", "Only the two teams in a review can add evidence to it.");
    }
    if (dispute.status !== "open" && dispute.status !== "appealed") {
      throw new CloudError("invalid", "This review has been decided, so it takes no more evidence.");
    }
    if (dispute.evidence.length >= MAX_DISPUTE_EVIDENCE) {
      throw new CloudError("invalid", `A review holds at most ${String(MAX_DISPUTE_EVIDENCE)} pieces of evidence from both teams.`);
    }
    const [row] = this.checkEvidence([evidence]);
    const entry: DisputeEvidence = { team: evidence.team, ...(row as Evidence) };
    return this.write("dispute", "Add evidence to a review.", [
      { op: "update", path: paths.dispute(disputeId), data: { evidence: [...dispute.evidence, entry] } },
      this.activity(evidence.team, "dispute.evidence", disputeId),
    ], undefined);
  }

  async appealDispute(disputeId: string, appeal: { team: string; reason: string }): Promise<Queued<void>> {
    const dispute = await this.dispute(disputeId);
    const problem = appealProblem(dispute, appeal.team, this.now());
    if (problem !== null) throw new CloudError("invalid", problem);
    const reason = appeal.reason.trim();
    if (reason.length === 0 || reason.length > MAX_EVIDENCE_TEXT) {
      throw new CloudError("invalid", `Say why the decision is wrong, in at most ${String(MAX_EVIDENCE_TEXT)} characters.`);
    }
    const claim = await this.claimRecord(dispute.teamNumber);
    const writes: Write[] = [
      {
        op: "update",
        path: paths.dispute(disputeId),
        data: { status: "appealed", appeal: { team: appeal.team, by: this.uid(), reason, at: SERVER_TIME } },
      },
    ];
    if (claim !== null) {
      const winner = dispute.decision?.winner ?? null;
      writes.push(
        { op: "update", path: paths.claim(dispute.teamNumber), data: { historyCount: claim.historyCount + 1 } },
        this.stepWrite(dispute.teamNumber, claim.historyCount, this.historyEntry("appeal", appeal.team, winner, { disputeId, note: reason })),
      );
    }
    writes.push(this.activity(appeal.team, "dispute.appeal", disputeId));
    return this.write("dispute", `Appeal the decision on team number ${String(dispute.teamNumber)}.`, writes, undefined);
  }

  async listDisputes(teamId: string): Promise<Dispute[]> {
    const held = await this.store().list({ collection: paths.disputes(), where: [{ field: "holderTeamId", value: teamId }] });
    const opened = await this.store().list({ collection: paths.disputes(), where: [{ field: "challengerTeamId", value: teamId }] });
    const byId = new Map<string, Dispute>();
    for (const doc of [...held, ...opened]) byId.set(doc.id, { id: doc.id, ...(doc.data as unknown as DisputeDoc) });
    return [...byId.values()].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  // ------------------------------------------------------------ the private beta

  /** A name for the beta lists, trimmed; "invalid" with a sentence when it is empty or too long. */
  private betaName(name: string): string {
    const trimmed = name.trim();
    if (trimmed.length === 0 || trimmed.length > MAX_BETA_NAME) {
      throw new CloudError("invalid", `A name must have 1 to ${String(MAX_BETA_NAME)} characters.`);
    }
    return trimmed;
  }

  /**
   * The signed-in user's request for beta access left from before 2026-10-03, or null. Only Export
   * my data and Delete my account read it: nobody can send one any more.
   */
  private async myBetaRequest(): Promise<BetaRequest | null> {
    const uid = this.uid();
    const data = await this.getOrNull(paths.betaRequest(uid));
    return data === null ? null : { uid, ...(data as unknown as BetaRequestDoc) };
  }

  // ------------------------------------------------------------ Horizon admins

  async isHorizonAdmin(): Promise<boolean> {
    if (this.currentUser() === null) return false;
    return (await this.getOrNull(paths.admin(this.uid()))) !== null;
  }

  /** The three documents `hasBetaAccess()` in the rules reads, read as the signed-in user, in its order. */
  async hasBetaAccess(): Promise<boolean> {
    if (this.currentUser() === null) return false;
    if ((await this.getOrNull(paths.betaTester(this.uid()))) !== null) return true;
    if (await this.isHorizonAdmin()) return true;
    const access = await this.getOrNull(paths.accessConfig());
    return access !== null && access.betaOpen === true;
  }

  async listReviewQueue(): Promise<ReviewQueue> {
    this.uid(); // Signed in, or this throws "signed-out" before any read.
    const oldestFirst = <T extends { createdAt: Date }>(a: T, b: T) => a.createdAt.getTime() - b.createdAt.getTime();
    const disputesWhere = async (status: DisputeDoc["status"]) =>
      (await this.store().list({ collection: paths.disputes(), where: [{ field: "status", value: status }] }))
        .map((doc) => ({ id: doc.id, ...(doc.data as unknown as DisputeDoc) }))
        .sort(oldestFirst);
    const requests = (await this.store().list({ collection: paths.verifications(), where: [{ field: "status", value: "open" }] }))
      .map((doc) => ({ id: doc.id, ...(doc.data as unknown as VerificationRequestDoc) }))
      .sort(oldestFirst);
    const disputes = await disputesWhere("open");
    const appeals = await disputesWhere("appealed");
    return { requests, disputes, appeals };
  }

  /** The write that adds `action` to the admin access log, by the caller at the server's time. */
  private adminLogWrite(action: AdminAction, target?: string): Write {
    const data: DocData = { by: this.uid(), at: SERVER_TIME, action };
    if (target !== undefined) data.target = target;
    return { op: "set", path: paths.adminLogEntry(randomId(this.random)), data };
  }

  async recordAdminAccess(action: AdminAction, target?: string): Promise<Queued<void>> {
    return this.write("admin", "Record a Horizon admin's access in the admin log.", [this.adminLogWrite(action, target)], undefined);
  }

  async listAdminLog(): Promise<AdminLogEntry[]> {
    this.uid();
    let docs: StoredDoc[];
    try {
      docs = await this.store().list({ collection: paths.adminLog() });
    } catch (error) {
      if (isCloudError(error, "permission-denied")) {
        throw new CloudError("permission-denied", "Only Horizon admins can read the admin access log.", { cause: error });
      }
      throw error;
    }
    return docs
      .map((doc) => ({ id: doc.id, ...(doc.data as unknown as AdminLogDoc) }))
      .sort((a, b) => b.at.getTime() - a.at.getTime() || a.id.localeCompare(b.id));
  }

  async listBetaAccess(): Promise<BetaAccessLists> {
    this.uid();
    const listed = async (collection: string): Promise<StoredDoc[]> => {
      try {
        return await this.store().list({ collection });
      } catch (error) {
        if (isCloudError(error, "permission-denied")) {
          throw new CloudError("permission-denied", "Only Horizon admins can read the beta lists.", { cause: error });
        }
        throw error;
      }
    };
    const byName = (a: { name: string | null; uid: string }, b: { name: string | null; uid: string }) =>
      a.name === null ? (b.name === null ? a.uid.localeCompare(b.uid) : 1) : b.name === null ? -1 : a.name.localeCompare(b.name) || a.uid.localeCompare(b.uid);
    const testers = (await listed(paths.betaTesters()))
      .map((doc) => ({ uid: doc.id, name: typeof doc.data.name === "string" ? doc.data.name : doc.id }))
      .sort(byName);
    const admins = (await listed(paths.admins()))
      .map((doc) => ({ uid: doc.id, name: typeof doc.data.name === "string" && doc.data.name !== "" ? doc.data.name : null }))
      .sort(byName);
    return { testers, admins };
  }

  /** A user code typed or pasted by an admin: trimmed, and one path segment. */
  private userCode(uid: string): string {
    const trimmed = uid.trim();
    if (trimmed.length === 0 || trimmed.length > 128 || trimmed.includes("/")) {
      throw new CloudError("invalid", "A user code has 1 to 128 characters and no slash.");
    }
    // Firestore cannot use these as document ids.
    if (trimmed === "." || trimmed === ".." || /^__.*__$/.test(trimmed)) {
      throw new CloudError("invalid", "That is not a user code. Copy it again from the person's private-beta screen.");
    }
    return trimmed;
  }

  /** The delete of `uid`'s beta request left from before 2026-10-03, if any: made in the write that adds them. */
  private async requestDeletes(uid: string): Promise<Write[]> {
    return (await this.getOrNull(paths.betaRequest(uid))) === null ? [] : [{ op: "delete", path: paths.betaRequest(uid) }];
  }

  async addBetaTester(input: { uid: string; name: string }): Promise<Queued<void>> {
    const uid = this.userCode(input.uid);
    const name = this.betaName(input.name);
    if ((await this.getOrNull(paths.betaTester(uid))) !== null) throw new CloudError("conflict", "This person is already on the beta list.");
    return this.write("admin", "Add a beta tester.", [
      { op: "set", path: paths.betaTester(uid), data: { name } },
      ...(await this.requestDeletes(uid)),
      this.adminLogWrite("beta.add", uid),
    ], undefined);
  }

  async removeBetaTester(uid: string): Promise<Queued<void>> {
    await this.require(paths.betaTester(uid), "That beta tester");
    return this.write("admin", "Take a beta tester off the list.", [
      { op: "delete", path: paths.betaTester(uid) },
      this.adminLogWrite("beta.remove", uid),
    ], undefined);
  }

  async addHorizonAdmin(input: { uid: string; name: string }): Promise<Queued<void>> {
    const uid = this.userCode(input.uid);
    const name = this.betaName(input.name);
    if ((await this.getOrNull(paths.admin(uid))) !== null) throw new CloudError("conflict", "This person is already a Horizon admin.");
    return this.write("admin", "Make someone a Horizon admin.", [
      { op: "set", path: paths.admin(uid), data: { name } },
      ...(await this.requestDeletes(uid)),
      this.adminLogWrite("admin.add", uid),
    ], undefined);
  }

  async removeHorizonAdmin(uid: string): Promise<Queued<void>> {
    if (uid === this.uid()) throw new CloudError("invalid", "You cannot remove yourself. Another Horizon admin can.");
    await this.require(paths.admin(uid), "That Horizon admin");
    return this.write("admin", "Remove a Horizon admin.", [
      { op: "delete", path: paths.admin(uid) },
      this.adminLogWrite("admin.remove", uid),
    ], undefined);
  }

  // ------------------------------------------------------------ bug reports

  async sendBugReport(input: BugReportInput): Promise<Queued<{ id: string }>> {
    const reporter = this.uid();
    const problem = bugReportProblem(input);
    if (problem !== null) throw new CloudError("invalid", problem);
    const id = randomId(this.random);
    const data: DocData = {
      reporter,
      createdAt: SERVER_TIME,
      status: "new",
      whatHappened: input.whatHappened.trim(),
      setup: { ...input.setup },
    };
    const expected = (input.expected ?? "").trim();
    const steps = (input.steps ?? "").trim();
    if (expected !== "") data.expected = expected;
    if (steps !== "") data.steps = steps;
    if (input.autoFile !== undefined) data.autoFile = input.autoFile;
    return this.write("report", "Send a bug report to Horizon.", [{ op: "set", path: paths.bugReport(id), data }], { id });
  }

  async listBugReports(): Promise<BugReport[]> {
    this.uid();
    let docs: StoredDoc[];
    try {
      docs = await this.store().list({ collection: paths.bugReports() });
    } catch (error) {
      if (isCloudError(error, "permission-denied")) {
        throw new CloudError("permission-denied", "Only Horizon admins can read bug reports.", { cause: error });
      }
      throw error;
    }
    return docs
      .map((doc) => ({ id: doc.id, ...(doc.data as unknown as BugReportDoc) }))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || a.id.localeCompare(b.id));
  }

  async setBugReportStatus(reportId: string, status: BugReportStatus): Promise<Queued<void>> {
    if (!BUG_REPORT_STATUSES.includes(status)) throw new CloudError("invalid", "Choose new, triaged or closed.");
    const writes: Write[] = [
      { op: "update", path: paths.bugReport(reportId), data: { status, updatedBy: this.uid(), updatedAt: SERVER_TIME } },
      this.adminLogWrite("report.status", reportId),
    ];
    return this.write("admin", `Mark a bug report ${status}.`, writes, undefined);
  }

  private checkReason(reason: string): string {
    const problem = oneSentenceProblem(reason);
    if (problem !== null) throw new CloudError("invalid", problem);
    return reason.trim();
  }

  async decideVerification(requestId: string, input: Pick<VerificationDecision, "verdict" | "reason">): Promise<Queued<void>> {
    const reason = this.checkReason(input.reason);
    if (input.verdict !== "verified" && input.verdict !== "declined") throw new CloudError("invalid", "Choose verify or decline.");
    const data = await this.require(paths.verification(requestId), "That request");
    const request = { id: requestId, ...(data as unknown as VerificationRequestDoc) };
    if (request.status !== "open") throw new CloudError("conflict", "This request has already been decided.");
    const claim = await this.claimRecord(request.teamNumber);
    if (claim === null || (claim.requestId ?? null) !== requestId) {
      throw new CloudError("conflict", "The number's claim no longer points at this request, so it cannot be decided from here.");
    }
    if (input.verdict === "verified" && (claim.status !== "unverified" || claim.teamId !== request.teamId)) {
      throw new CloudError("conflict", "The number is contested or held by another team now; decide its dispute instead, and decline this request.");
    }
    const writes: Write[] = [
      {
        op: "update",
        path: paths.verification(requestId),
        data: { status: "decided", decision: { verdict: input.verdict, reason, by: this.uid(), at: SERVER_TIME } },
      },
      {
        op: "update",
        path: paths.claim(request.teamNumber),
        data: {
          status: input.verdict === "verified" ? "verified" : claim.status,
          requestId: null,
          historyCount: claim.historyCount + 1,
        },
      },
      this.stepWrite(
        request.teamNumber,
        claim.historyCount,
        this.historyEntry(input.verdict === "verified" ? "verify" : "decline", request.teamId, null, { requestId, note: reason }),
      ),
    ];
    if (input.verdict === "verified") writes.push({ op: "update", path: paths.team(request.teamId), data: { status: "verified" } });
    writes.push(this.adminLogWrite("verification.decide", requestId));
    const word = input.verdict === "verified" ? "Verify" : "Decline to verify";
    return this.write("admin", `${word} team number ${String(request.teamNumber)}.`, writes, undefined);
  }

  /** The writes that give `teamNumber` to `winner` and take it from the other team of `dispute`. */
  private async awardWrites(dispute: Dispute, winner: string): Promise<Write[]> {
    const loser = this.loserOf(dispute, winner);
    // Both teams' pointers at the review they opened are cleared with the decision.
    const writes: Write[] = [
      { op: "update", path: paths.team(winner), data: { status: "verified", number: dispute.teamNumber, disputeId: null } },
    ];
    // The loser gives the number up if it held it, and loses the contested label either way.
    const loserTeam = await this.getTeam(loser);
    if (loserTeam !== null && (loserTeam.number === dispute.teamNumber || loserTeam.status === "contested")) {
      writes.push({ op: "update", path: paths.team(loser), data: { status: "unverified", number: null, disputeId: null } });
    }
    return writes;
  }

  private loserOf(dispute: Dispute, winner: string): string {
    return winner === dispute.holderTeamId ? dispute.challengerTeamId : dispute.holderTeamId;
  }

  private checkWinner(dispute: Dispute, winner: string): void {
    if (winner !== dispute.holderTeamId && winner !== dispute.challengerTeamId) {
      throw new CloudError("invalid", "The winner must be one of the two teams in the review.");
    }
  }

  async decideDispute(disputeId: string, input: DisputeDecisionInput): Promise<Queued<void>> {
    const reason = this.checkReason(input.reason);
    const dispute = await this.dispute(disputeId);
    this.checkWinner(dispute, input.winner);
    if (dispute.status !== "open") throw new CloudError("conflict", "This review has already been decided.");
    const claim = await this.claimRecord(dispute.teamNumber);
    if (claim === null || (claim.disputeId ?? null) !== disputeId) {
      throw new CloudError("conflict", "The number's claim no longer points at this review, so it cannot be decided from here.");
    }
    const writes: Write[] = [
      {
        op: "update",
        path: paths.dispute(disputeId),
        data: { status: "decided", decision: { winner: input.winner, reason, by: this.uid(), at: SERVER_TIME } },
      },
      {
        op: "update",
        path: paths.claim(dispute.teamNumber),
        data: { teamId: input.winner, status: "verified", disputeId: null, historyCount: claim.historyCount + 1 },
      },
      this.stepWrite(
        dispute.teamNumber,
        claim.historyCount,
        this.historyEntry("decision", input.winner, this.loserOf(dispute, input.winner), { disputeId, note: reason }),
      ),
      ...(await this.awardWrites(dispute, input.winner)),
      this.adminLogWrite("dispute.decide", disputeId),
    ];
    return this.write("admin", `Decide the review of team number ${String(dispute.teamNumber)}.`, writes, undefined);
  }

  async decideAppeal(disputeId: string, input: DisputeDecisionInput): Promise<Queued<void>> {
    const reason = this.checkReason(input.reason);
    const dispute = await this.dispute(disputeId);
    this.checkWinner(dispute, input.winner);
    if (dispute.status !== "appealed") throw new CloudError("conflict", "This review has no appeal waiting for a decision.");
    const claim = await this.claimRecord(dispute.teamNumber);
    if (claim === null) throw new CloudError("conflict", "The number's claim is gone, so the appeal cannot be decided from here.");
    const writes: Write[] = [
      {
        op: "update",
        path: paths.dispute(disputeId),
        data: { status: "final", appealDecision: { winner: input.winner, reason, by: this.uid(), at: SERVER_TIME } },
      },
      {
        op: "update",
        path: paths.claim(dispute.teamNumber),
        data: { teamId: input.winner, status: "verified", historyCount: claim.historyCount + 1 },
      },
      this.stepWrite(
        dispute.teamNumber,
        claim.historyCount,
        this.historyEntry("appeal-decision", input.winner, this.loserOf(dispute, input.winner), { disputeId, note: reason }),
      ),
      ...(await this.awardWrites(dispute, input.winner)),
      this.adminLogWrite("appeal.decide", disputeId),
    ];
    return this.write("admin", `Decide the appeal on team number ${String(dispute.teamNumber)}.`, writes, undefined);
  }

  // ------------------------------------------------------------ keys (spec 14)

  async thisDevice(): Promise<ThisDevice> {
    const device = await this.keys.device();
    const registration = await this.keys.registration();
    if (registration.length > 0) this.writeRegistered("profile", "Register this device's public keys.", registration, [], undefined);
    return { deviceId: device.deviceId, code: await guarded("This device's keys", () => deviceVerificationCode(device.encSpki, device.signSpki)) };
  }

  async teamKeyStatus(teamId: string): Promise<TeamKeyStatus> {
    const device = await this.thisDevice();
    try {
      const opened = await this.openTeam(teamId);
      return {
        state: "ready",
        keyVersion: opened.team.encKey.v,
        rotationPending: await this.rotationDue(opened),
        safetyCode: await guarded("The team's public key", () => teamSafetyCode(opened.team.encKey)),
        device,
      };
    } catch (error) {
      if (!isCloudError(error, "no-key")) throw error;
    }
    const request = await this.getOrNull(keyPaths.request(teamId, device.deviceId));
    const settings = await this.getTeamSettings(teamId).catch(() => null);
    const approvalCode = await this.approvalCode(teamId);
    return {
      state: "waiting",
      requested: request !== null,
      membersMayApproveDevices: settings?.membersMayApproveDevices ?? false,
      approvalCode,
      savedOnDevice: this.trust.failedToSave?.() !== true,
      device,
    };
  }

  /**
   * The approval code this device shows for `teamId`, made the first time it is needed and kept (on
   * this device only) until a grant is accepted or the request is withdrawn.
   */
  private async approvalCode(teamId: string): Promise<string> {
    const uid = this.uid();
    const device = await this.keys.device();
    let stored = readApprovalSecret(this.trust, uid, teamId);
    if (stored === null || stored.deviceId !== device.deviceId) {
      stored = { deviceId: device.deviceId, secret: newApprovalSecret(this.random) };
      writeApprovalSecret(this.trust, uid, teamId, stored);
    }
    const secret = stored.secret;
    return guarded("This device's keys", () => approvalCodeFor({ teamId, uid, fingerprint: device.fingerprint }, secret));
  }

  async requestTeamKey(teamId: string): Promise<Queued<void>> {
    const uid = this.uid();
    const device = await this.keys.device();
    const registration = await this.keys.registration();
    await this.approvalCode(teamId);
    // A grant this device never accepted (it has no pin for the team) did not match its code: it is
    // deleted, so the next approval makes a new one rather than updating it.
    const unaccepted = readPin(this.trust, uid, "team", teamId) === null && (await this.keys.grantOf(teamId, device.deviceId)) !== null;
    return this.writeRegistered("member", "Ask for the team key on this device.", registration, [
      ...(unaccepted ? [{ op: "delete", path: keyPaths.grant(teamId, device.deviceId) } as Write] : []),
      { op: "set", path: keyPaths.request(teamId, device.deviceId), data: { uid, deviceId: device.deviceId, createdAt: SERVER_TIME } },
    ], undefined);
  }

  async listKeyRequests(teamId: string): Promise<KeyRequest[]> {
    const uid = this.uid();
    let docs: StoredDoc[];
    let everyone = true;
    try {
      docs = await this.store().list({ collection: keyPaths.requests(teamId) });
    } catch (error) {
      if (!isCloudError(error, "permission-denied")) throw error;
      everyone = false;
      docs = await this.store().list({ collection: keyPaths.requests(teamId), where: [{ field: "uid", value: uid }] });
    }
    const me = everyone ? ((await this.getOrNull(paths.member(teamId, uid))) as MemberDoc | null) : null;
    const admin = me !== null && ADMIN_ROLE_SET.has(me.role);
    const members = new Map<string, MemberDoc>();
    try {
      for (const doc of await this.store().list({ collection: paths.members(teamId) })) members.set(doc.id, doc.data as unknown as MemberDoc);
    } catch (error) {
      if (!isCloudError(error, "permission-denied")) throw error;
    }
    const out: KeyRequest[] = [];
    for (const doc of docs) {
      const request = doc.data as unknown as KeyRequestDoc;
      // A request whose device has no valid record cannot be granted, so it is not offered. Owners
      // and admins are shown it, marked, because it keeps the real device at that id from asking.
      let record;
      try {
        record = await this.keys.deviceRecordOf(request.uid, doc.id);
      } catch (error) {
        if (!isCloudError(error, "tampered")) throw error;
        record = null;
      }
      const member = members.get(request.uid);
      if (record === null || request.deviceId !== doc.id) {
        if (!admin) continue;
        out.push({
          deviceId: doc.id,
          uid: request.uid,
          displayName: member?.displayName ?? "",
          kind: member?.role === "pending" ? "member" : "device",
          code: "",
          requestedAt: request.createdAt,
          isYours: request.uid === uid,
          matchesDevice: false,
        });
        continue;
      }
      const matched = record;
      out.push({
        deviceId: request.deviceId,
        uid: request.uid,
        displayName: member?.displayName ?? "",
        kind: member?.role === "pending" ? "member" : "device",
        code: await guarded("A device's keys", () => deviceVerificationCode(matched.encSpki, matched.signSpki)),
        requestedAt: request.createdAt,
        isYours: request.uid === uid,
        matchesDevice: true,
      });
    }
    return out.sort((a, b) => a.requestedAt.getTime() - b.requestedAt.getTime());
  }

  async keyRequestForCode(teamId: string, uid: string, approvalCode: string): Promise<string | null> {
    let docs: StoredDoc[];
    try {
      docs = await this.store().list({ collection: keyPaths.requests(teamId), where: [{ field: "uid", value: uid }] });
    } catch (error) {
      if (isCloudError(error, "permission-denied")) return null;
      throw error;
    }
    const matched: string[] = [];
    for (const doc of docs) {
      const request = doc.data as unknown as KeyRequestDoc;
      if (request.uid !== uid || request.deviceId !== doc.id) continue;
      let record;
      try {
        record = await this.keys.deviceRecordOf(uid, request.deviceId);
      } catch (error) {
        if (isCloudError(error, "tampered")) continue;
        throw error;
      }
      if (record === null) continue;
      const subject = { teamId, uid, fingerprint: record.fingerprint };
      if ((await guarded("The approval code", () => approvalSecretFrom(approvalCode, subject))) !== null) matched.push(request.deviceId);
    }
    // Two devices matching one code happens once in 2^50 by chance, and otherwise only when someone
    // made one to match: grant neither.
    if (matched.length > 1) throw new CloudError("tampered", "That code matches more than one waiting device, so neither is given the key. Ask the member to ask again.");
    return matched[0] ?? null;
  }

  async grantDeviceKey(teamId: string, deviceId: string, approvalCode: string): Promise<Queued<void>> {
    if (typeof approvalCode !== "string") throw new CloudError("invalid", "Giving a device the team key needs the approval code it shows.");
    const request = (await this.require(keyPaths.request(teamId, deviceId), "That request for the team key")) as unknown as KeyRequestDoc;
    if (request.deviceId !== deviceId) throw new CloudError("tampered", "That request for the team key names a different device.");
    const member = (await this.getOrNull(paths.member(teamId, request.uid))) as MemberDoc | null;
    if (member === null) throw new CloudError("not-found", "The member who asked is no longer in the team.");
    if (member.role === "pending") throw new CloudError("invalid", "That member is still waiting to join. Approve them, which gives their device the key too.");
    const opened = await this.openTeam(teamId, { extractable: true });
    const writes = await this.grantRequestWrites(opened, request, approvalCode);
    const summary = request.uid === this.uid() ? "Give the team key to your new device." : `Give the team key to a device of ${member.displayName}.`;
    return this.write("member", summary, [...writes, this.activity(teamId, "key.grant", request.uid)], undefined);
  }

  async declineKeyRequest(teamId: string, deviceId: string): Promise<Queued<void>> {
    // Withdrawing this device's own request makes its approval code useless, so it is forgotten.
    const uid = this.uid();
    const secret = readApprovalSecret(this.trust, uid, teamId);
    if (secret !== null && secret.deviceId === deviceId) clearApprovalSecret(this.trust, uid, teamId);
    return this.write("member", "Decline a request for the team key.", [{ op: "delete", path: keyPaths.request(teamId, deviceId) }], undefined);
  }

  async listTeamDevices(teamId: string): Promise<TeamDevice[]> {
    const uid = this.uid();
    const device = await this.keys.device();
    let docs: StoredDoc[];
    try {
      docs = await this.store().list({ collection: keyPaths.grants(teamId) });
    } catch (error) {
      if (!isCloudError(error, "permission-denied")) throw error;
      docs = await this.store().list({ collection: keyPaths.grants(teamId), where: [{ field: "uid", value: uid }] });
    }
    const members = new Map<string, MemberDoc>();
    for (const doc of await this.store().list({ collection: paths.members(teamId) })) members.set(doc.id, doc.data as unknown as MemberDoc);
    const out: TeamDevice[] = [];
    for (const doc of docs) {
      const grant = doc.data as unknown as KeyGrantDoc;
      const record = await this.keys.deviceRecordOf(grant.uid, grant.deviceId).catch(() => null);
      out.push({
        deviceId: grant.deviceId,
        uid: grant.uid,
        displayName: members.get(grant.uid)?.displayName ?? "",
        keyVersion: grant.kv,
        code: record === null ? "" : await guarded("A device's keys", () => deviceVerificationCode(record.encSpki, record.signSpki)),
        isThisDevice: grant.deviceId === device.deviceId && grant.uid === uid,
        approvedBy: grant.approverUid,
        approvedAt: grant.updatedAt,
      });
    }
    return out.sort((a, b) => a.displayName.localeCompare(b.displayName) || a.deviceId.localeCompare(b.deviceId));
  }

  /**
   * Takes the team key from a device. A device the newest device roster gives the authority to make
   * the next one rotates the key in the same write, whatever the member documents say. Any other
   * device, and the device being revoked itself, deletes the grant and marks the key "rotation
   * pending" (spec 14 section 4.5), unless the revoked device could make the next roster
   * (`KeyRing.mayMakeNextRoster`): then it could make the next key until the key changes, so that is
   * refused (`CANNOT_REVOKE_ADMIN_DEVICE`). A device that cannot open the roster cannot tell, so it
   * refuses too, and a device the roster lets rotate never falls back to "rotation pending": a read
   * refused during its rotation is thrown instead.
   */
  async revokeDevice(teamId: string, deviceId: string): Promise<Queued<void>> {
    const uid = this.uid();
    const me = (await this.require(paths.member(teamId, uid), "Your membership")) as unknown as MemberDoc;
    this.keys.forget(teamId);
    // A rotation always keeps the device that makes it, so the device being revoked cannot rotate itself out.
    const thisDevice = (await this.keys.device()).deviceId;
    const own = thisDevice === deviceId;
    // A refused read during the rotation, as opposed to a `CannotRotateError`, is the server's word:
    // it is kept here and thrown again below if the roster says this device could have rotated.
    let refusedRead: unknown = null;
    if (!own) {
      try {
        const rotation = await this.keys.rotationWrites(teamId, { deviceIds: [deviceId] });
        return this.pinRotation(teamId, rotation, this.write("member", "Take the team key from a device.", [...rotation.writes, this.activity(teamId, "key.revoke", deviceId)], undefined));
      } catch (error) {
        // A member who is not an owner or admin may not read every grant, which a rotation needs,
        // so that refusal is "permission-denied".
        if (isCannotRotate(error)) refusedRead = null;
        else if (isCloudError(error, "no-key") || isCloudError(error, "permission-denied")) refusedRead = error;
        else throw error;
      }
    }
    const grant = await this.keys.grantOf(teamId, deviceId);
    if (grant === null) throw new CloudError("not-found", "That device does not hold the team key.");
    if (grant.uid !== uid && !ADMIN_ROLE_SET.has(me.role)) throw new CloudError("permission-denied", "Only owners and admins take the team key from another member's device.");
    let opened: OpenedTeam;
    try {
      opened = await this.keys.openTeam(teamId);
    } catch (error) {
      if (!isCloudError(error, "no-key")) throw error;
      throw new CannotRotateError(CANNOT_REVOKE_ADMIN_DEVICE);
    }
    // A device the roster lets make the next key never falls back to "rotation pending" because a
    // read was refused: the server could refuse one read to keep the revoked device's key current.
    if (refusedRead !== null && (await this.keys.mayMakeNextRoster(opened, thisDevice))) {
      const code = isCloudError(refusedRead, "no-key") ? "no-key" : "permission-denied";
      throw new CloudError(code, REVOKE_NEEDS_KEY_CHANGE);
    }
    if (await this.keys.mayMakeNextRoster(opened, deviceId)) throw new CannotRotateError(CANNOT_REVOKE_ADMIN_DEVICE);
    return this.write("member", "Take the team key from a device.", [
      { op: "delete", path: keyPaths.grant(teamId, deviceId) },
      { op: "update", path: paths.team(teamId), data: { rotationPending: true } },
      this.activity(teamId, "key.revoke", deviceId),
    ], undefined);
  }

  async completeKeyRotation(teamId: string): Promise<Queued<void>> {
    const rotation = await this.keys.rotationWrites(teamId);
    this.keys.forget(teamId);
    return this.pinRotation(teamId, rotation, this.write("team", "Make a new team key.", [...rotation.writes, this.activity(teamId, "key.rotate")], undefined));
  }

  async useRecoveryCode(teamId: string, codeText: string): Promise<Queued<void>> {
    const uid = this.uid();
    const code = await guarded("The recovery code", () => recoveryCodeFromText(codeText));
    const team = await this.keys.team(teamId);
    const member = (await this.getOrNull(paths.member(teamId, uid))) as MemberDoc | null;
    if (member === null || !ACTIVE_ROLE_SET.has(member.role)) {
      throw new CloudError("permission-denied", "Only an active member of the team can use its recovery code. Ask an owner or admin to approve you first.");
    }
    const record = (await this.store().get(keyPaths.recovery(teamId))) as RecoveryDoc | null;
    if (record === null) throw new CloudError("not-found", "The team has no recovery record.");
    const device = await this.keys.device();
    const registration = await this.keys.registration();
    const unlocked = await guarded("The recovery code or the team's recovery record", async () => {
      try {
        const teamKey = await openRecovery({ teamId, record, code, extractable: true });
        const signer = await openRecoverySigner({ teamId, record, code });
        if (teamKey.version !== team.encKey.v) throw new CloudError("tampered", "The recovery record does not hold the team's newest key.");
        const records = (await this.store().list({ collection: keyPaths.teamKeys(teamId) })).map((doc) => doc.data as unknown as TeamKeyDoc);
        const chain = await openChain(teamId, teamKey, records.filter((r) => r.kv <= teamKey.version));
        const newest = chain.get(teamKey.version);
        if (newest === undefined || !bytesEqual(newest.pair.spki, team.encKey.spki) || !bytesEqual(newest.pair.signSpki, team.encKey.signSpki)) {
          throw new CloudError("tampered", "The team's public key is not the one its key records hold.");
        }
        const pin = readPin(this.trust, uid, "team", teamId);
        const pinned = pin === null ? undefined : chain.get(pin.v);
        if (pin !== null && (pinned === undefined || !bytesEqual(pinned.pair.fingerprint, pin.fingerprint) || !bytesEqual(pinned.pair.signSpki, pin.signSpki))) {
          throw new CloudError("tampered", "The team's keys are not the ones this device saw before.");
        }
        return { newest, chain, records, pin, signer };
      } finally {
        code.fill(0);
      }
    }).catch((error: unknown) => {
      // A wrong code is the likely cause of a failed open, so say that first.
      if (isCloudError(error, "tampered") && error.message.startsWith("The recovery code or")) {
        throw new CloudError("invalid", "That recovery code does not open this team's recovery record. Check it against the printed sheet, including which team it is for.", { cause: error });
      }
      throw error;
    });
    // The device rosters are checked from this device's pin, or, on a device that never opened the
    // team, from the roster the code's own signing key vouches for; the newest must name the
    // recovery record the code just opened.
    const roster = await this.keys.checkRosters(teamId, unlocked.chain, unlocked.records, unlocked.pin, record);
    const named = await guarded("The team's recovery record", async () => bytesEqual(await recoveryFingerprint(record), roster.roster.recovery));
    if (!named) throw new CloudError("tampered", "The team's recovery record is not the one the team's device list names, so the key it holds is not used.");
    const opened: OpenedTeam = {
      teamId,
      team,
      device,
      grant: null as unknown as KeyGrantDoc,
      newest: unlocked.newest,
      chain: unlocked.chain,
      roster: roster.roster,
      rosterDigest: roster.digest,
    };
    // The recovery key's endorsement of this device is what lets it make the next device roster.
    const endorsement = await guarded("The recovery code", () =>
      endorseRecoveredDevice(unlocked.signer, { teamId, kv: team.encKey.v, deviceId: device.deviceId, uid, fingerprint: device.fingerprint }),
    );
    // While a rotation is pending, the rules take no grant a device makes for itself unless the same
    // write rotates the key: the device that was taken off may still hold the key it had. An owner or
    // admin therefore rotates here, with the key the recovery code opened; anyone else waits for one.
    // The pending mark is the server's word, so an owner or admin of the newest roster rotates
    // whether or not the mark is there: a member who left may hold the key this device would write under.
    let grants: Write[];
    let rotation: Rotation | null = null;
    // Both decisions follow the roster's role: a member document shown lower must not spare the rotation.
    const rosterAdmin = isAdminRole(roleIn(roster.roster, uid));
    if (team.rotationPending === true && !rosterAdmin) {
      throw new CloudError(
        "invalid",
        "The team key is waiting to be rotated, because a member left or a device was taken off. An owner or admin must rotate it before the recovery code can be used on this device.",
      );
    }
    if (rosterAdmin) {
      rotation = await this.keys.rotationWrites(teamId, {}, { opened, grantThisDevice: true, recoveryEndorsement: endorsement });
      grants = rotation.writes;
    } else {
      const existing = await this.keys.grantOf(teamId, device.deviceId);
      grants = [await this.keys.grantWrite(opened, { uid, deviceId: device.deviceId, record: deviceRecord(device) }, existing, { recoverySig: endorsement })];
    }
    // A key request at this device's id by another member (one who put a device record of their
    // own there first) would stop the grant: an owner or admin deletes it in the same write, and
    // anyone else is told to ask one.
    const request = (await this.getOrNull(keyPaths.request(teamId, device.deviceId))) as KeyRequestDoc | null;
    if (request !== null && request.uid !== uid && !ADMIN_ROLE_SET.has(member.role)) {
      throw new CloudError("conflict", ANOTHERS_REQUEST);
    }
    this.keys.forget(teamId);
    // The version the code opened is pinned, not a rotated one: it is on the chain either way.
    writePin(this.trust, uid, "team", teamId, team.encKey, roster.digest);
    clearApprovalSecret(this.trust, uid, teamId);
    return this.pinRotation(teamId, rotation, this.writeRegistered("member", "Unlock the team library with the recovery code.", registration, [
      ...grants,
      ...(request === null ? [] : [{ op: "delete", path: keyPaths.request(teamId, device.deviceId) } as Write]),
      this.activity(teamId, "recovery.use", device.deviceId),
    ], undefined));
  }

  /**
   * A new recovery code, in a write that also rotates the team key: the new record holds only the
   * new key, so the old code, and any copy of the old record the server kept, opens nothing made
   * from now on.
   */
  async replaceRecoveryCode(teamId: string): Promise<Queued<{ recoveryCode: string }>> {
    const uid = this.uid();
    const me = (await this.require(paths.member(teamId, uid), "Your membership")) as unknown as MemberDoc;
    if (me.role !== "owner") throw new CloudError("permission-denied", "Only an owner of the team can make a new recovery code.");
    const code = newRecoveryCode(this.random);
    let rotation;
    let recoveryCode: string;
    try {
      recoveryCode = await guarded("The new recovery code", () => recoveryCodeToText(code));
      rotation = await this.keys.rotationWrites(teamId, {}, { recoveryCode: code });
    } finally {
      code.fill(0);
    }
    this.keys.forget(teamId);
    return this.pinRotation(teamId, rotation, this.write("team", "Make a new team recovery code.", [...rotation.writes, this.activity(teamId, "recovery.replace")], { recoveryCode }));
  }

  // ------------------------------------------------------------ outbox

  outbox(): OutboxStatus {
    return this.outboxList.status();
  }

  onOutboxChange(listener: OutboxListener): () => void {
    return this.outboxList.subscribe(listener);
  }
}
