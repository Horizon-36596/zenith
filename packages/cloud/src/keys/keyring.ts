/**
 * The key session (spec 14 section 4): this device's own keys, and the team keys it holds. Every
 * team key the client uses comes from `openTeam`, which checks, before anything is decrypted:
 *
 * 1. the team's `encKey`: a fingerprint that is the SHA-256 of its key;
 * 2. this device's grant: for this team, this device and this member, at the newest version;
 * 3. the approving device's record against its id, and its signature over the grant;
 * 4. the grant's proof, under the key it holds;
 * 5. the chain of team key records from that key down, each pair's private half against its public
 *    half, and the newest pair against `encKey`;
 * 6. the key this device pinned for the team before (trust on first use): never an older version, and
 *    at the pinned version the same fingerprint and signing key, reached through the chain from the
 *    newest key;
 * 7. the device rosters (keys/roster.ts): the pinned version's roster must be the one this device
 *    saw, and each newer one must be signed by a device that the one before it gave the authority to
 *    make it;
 * 8. with no pin yet (this device's first grant for the team), the grant's approval MAC, under the
 *    key derived from the approval code this device showed (crypto/approval.ts), which covers the
 *    newest roster too. A team key the server made up has no such MAC, so a new device never takes
 *    one. The founder's first device and a device that used the recovery code pin the team
 *    themselves and need no code.
 *
 * Who may approve a device is the rules' job when it is approved: the client checks signatures and
 * the chain when it opens a grant, never roles, because a member demoted since they approved someone
 * would otherwise lock that person out. Roles count once, at the next rotation, which keeps only the
 * approvals roster n allows (`rotationWrites`).
 *
 * Nothing here writes: it returns the writes, and the client sends them in one batch with the rest.
 */
import {
  approvalKey,
  checkApprovalMac,
  checkDeviceRecord,
  checkGrantProof,
  checkTeamEncKey,
  createRecovery,
  deviceRecord,
  generateDeviceKeys,
  makeApprovalMac,
  makeGrantProof,
  makeKeyGrant,
  openChain,
  openKeyGrant,
  openRecoverySigner,
  recoveryFingerprint,
  rewrapRecovery,
  rotateTeamKeys,
  type DeviceKeys,
  type DeviceKeyStore,
  type DeviceRecord,
  type KeyGrant,
  type NewTeamKeys,
  type TeamEncKey,
  type TeamKey,
  type TeamKeyPair,
  type TeamKeyVersion,
} from "../crypto/index.js";
import { base64urlEncode, bytesEqual } from "../crypto/bytes.js";
import { isKeyVersion } from "../crypto/aad.js";
import { isCryptoError } from "../crypto/errors.js";
import { CloudError, isCloudError } from "../errors.js";
import type { RandomBytes } from "../ids.js";
import { paths } from "../paths.js";
import { DELETE_FIELD, SERVER_TIME, type DocData, type DocRead, type DocStore, type Write } from "../store.js";
import { MAX_ROSTER_BYTES, type ActiveRole, type DeviceDoc, type GrantApproval, type KeyGrantDoc, type MemberDoc, type RecoveryDoc, type TeamDoc, type TeamKeyDoc, type TeamSettingsDoc } from "../types.js";
import {
  anchorRecovery,
  checkRecoveryAnchor,
  checkRosterStep,
  deviceIn,
  isAdminRole,
  lowerRole,
  NEW_MEMBER_ROLE_CAP,
  openRoster,
  MAX_ROSTER_LINKS,
  MAX_ROSTER_SHARES,
  mayApproveAt,
  raisesAuthority,
  recordOfKeys,
  roleIn,
  rootGrants,
  rosterNonce,
  rotationAuthority,
  sealRoster,
  type Approver,
  type GrantEvidence,
  type GrantLink,
  type OpenedRoster,
  type Roster,
  type RosterDevice,
  type RosterLink,
  type RosterShare,
  type RootedGrant,
} from "./roster.js";
import { clearApprovalSecret, readApprovalSecret, readPin, writePin, type Pin, type TrustStore } from "./trust.js";

/** Key paths, next to the rest in `paths` but kept here with the code that owns them. */
export const keyPaths = {
  devices: (uid: string) => `users/${uid}/devices`,
  device: (uid: string, deviceId: string) => `users/${uid}/devices/${deviceId}`,
  teamKeys: (teamId: string) => `teams/${teamId}/teamKeys`,
  teamKey: (teamId: string, kv: number) => `teams/${teamId}/teamKeys/${String(kv)}`,
  recovery: (teamId: string) => `teams/${teamId}/recovery/current`,
  grants: (teamId: string) => `teams/${teamId}/keyGrants`,
  grant: (teamId: string, deviceId: string) => `teams/${teamId}/keyGrants/${deviceId}`,
  requests: (teamId: string) => `teams/${teamId}/keyRequests`,
  request: (teamId: string, deviceId: string) => `teams/${teamId}/keyRequests/${deviceId}`,
} as const;

const ACTIVE = new Set(["owner", "admin", "editor", "viewer"]);

/** The sentence for a device that is waiting for the team key. */
export const WAITING_FOR_KEY =
  "This device does not have the team key yet. Ask an owner or admin, or use another of your devices where the team is open, to approve this one.";

/** The sentence for a first grant that carries no approval code, or one for another team key. */
export const GRANT_NOT_APPROVED =
  "This device was given a team key without its approval code, so it is not used: it may not be your team's. Ask for the key again from this device, and have the approver type the code it shows.";

/** The sentence for a first grant whose approval code does not match the one this device showed. */
export const GRANT_WRONG_CODE =
  "The team key this device was given does not match the approval code it showed, so it is not used. Ask for the key again, and have the approver type the code exactly.";

/** The sentence for a rotation whose roster would be too big (`RosterTooLargeError`). */
export const ROSTER_TOO_LARGE =
  "The team has too many members and devices to list in one team key, so the key cannot be changed. Take the key from devices nobody uses, or remove members who have left, from Team keys first, then try again.";

/**
 * The sentence for raising a role, or letting members approve devices, from a device whose only
 * authority to change the team key is the recovery code.
 */
export const RECOVERY_CANNOT_RAISE =
  "This device has the team key only through the recovery code, which cannot make anyone an owner or admin or let members approve devices. Change the key once from this device first (or have another owner or admin approve it), then make the change again.";

/** The sentence for removing an owner or admin from a device that cannot make the team's next key. */
export const CANNOT_REMOVE_ADMIN =
  "An owner or admin can only be removed from a device that makes the team's next key in the same step, because until the key changes they could still make one. Remove them from another owner's or admin's device, or use the recovery code on this one first.";

/** The sentence for lowering an owner's or admin's role from a device that cannot make the team's next key. */
export const CANNOT_DEMOTE_ADMIN =
  "An owner or admin can only be given a lower role from a device that makes the team's next key in the same step, because until the key changes they could still make one. Change their role from another owner's or admin's device, or use the recovery code on this one first.";

/** The sentence for taking the key from an owner's or admin's device from a device that cannot make the team's next key. */
export const CANNOT_REVOKE_ADMIN_DEVICE =
  "The key can only be taken from an owner's or admin's device by a device that makes the team's next key in the same step, because until the key changes that device could still make one. A device cannot do this for itself. Take the key from it on another owner's or admin's device, or use the recovery code on one first.";

/** The sentence for turning off members approving each other's devices from a device that cannot make the team's next key. */
export const CANNOT_STOP_MEMBER_APPROVALS =
  "Members can only be stopped from approving each other's devices from a device that makes the team's next key in the same step, because until the key changes their approvals still count. Change the setting from another owner's or admin's device, or use the recovery code on this one first.";

/**
 * The most devices of one member a rotation keeps. SET BY HAND: 10 covers a phone, a laptop, a
 * desktop and a few browsers, and 50 members at 10 each fill the 500 a roster holds, so one member
 * who registers device after device cannot make the roster too big for anyone to rotate.
 */
export const MAX_DEVICES_PER_MEMBER = 10;

/** Thrown by `rotationWrites` when the next roster would not fit in its key record. */
export class RosterTooLargeError extends CloudError {
  constructor() {
    super("invalid", ROSTER_TOO_LARGE);
    this.name = "RosterTooLargeError";
  }
}

/** The sentence for a device that cannot make the team's next key (`CannotRotateError`). */
export const CANNOT_ROTATE =
  "This device cannot make the team's next key. Only a device that an owner or admin had when the key last changed can, or one approved from such a device by the same member or by an owner or admin, or one that used the team's recovery code. Make the new key from another owner's or admin's device, or use the recovery code on this one.";

/**
 * Thrown by `rotationWrites` when the newest device roster gives this device no authority to make
 * the next one (keys/roster.ts), so nothing a teammate's app checks would accept its rotation. It is
 * not a sign of tampering: a new admin's device, or one an editor approved, is in this state until
 * the next rotation made from a device that can. A removal or a revocation then marks the key
 * "rotation pending" instead of rotating. A change that takes away someone's authority to make the
 * next key (removing or demoting an owner or admin, taking the key from their device, or stopping
 * members approving devices) is refused instead, with its own sentence, since until the key changes
 * they could still make it.
 */
export class CannotRotateError extends CloudError {
  constructor(message: string = CANNOT_ROTATE) {
    super("permission-denied", message);
    this.name = "CannotRotateError";
  }
}

/** True for a `CannotRotateError`. */
export function isCannotRotate(error: unknown): error is CannotRotateError {
  return error instanceof CannotRotateError;
}

/**
 * A `CryptoError` as the `CloudError` the app shows; anything else unchanged. A failed check is
 * "tampered": Zenith's own writes always check out, so only a changed or forged record fails.
 */
export function cryptoToCloud(error: unknown, what = "Encrypted data"): unknown {
  if (!isCryptoError(error)) return error;
  switch (error.code) {
    case "bad-recovery-code":
      return new CloudError("invalid", error.message, { cause: error });
    case "too-large":
      return new CloudError("invalid", error.message, { cause: error });
    case "unavailable":
      return new CloudError("unavailable", error.message, { cause: error });
    default:
      return new CloudError(
        "tampered",
        `${what} did not check out, so it is not used: it was changed or moved on the server, or made without the team's key.`,
        { cause: error },
      );
  }
}

/** Runs `work`, turning a `CryptoError` into the `CloudError` for `what`. */
export async function guarded<T>(what: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw cryptoToCloud(error, what);
  }
}

/** A team's keys as this device opened and checked them. */
export interface OpenedTeam {
  teamId: string;
  team: TeamDoc;
  device: DeviceKeys;
  /** This device's grant, as read. */
  grant: KeyGrantDoc;
  /** The newest version: extractable only when `openTeam` was asked for it. */
  newest: TeamKeyVersion;
  /** Every version this device can reach, newest included. */
  chain: Map<number, TeamKeyVersion>;
  /** The newest version's device roster, checked as the file's comment says. */
  roster: Roster;
  /** Its 32-byte digest (`rosterDigest`), which the pin and approval MACs hold. */
  rosterDigest: Uint8Array;
}

/** Team key `kv` from an opened team, or "tampered" when the chain does not reach it. */
export function teamKeyAt(opened: OpenedTeam, kv: number): TeamKey {
  const version = opened.chain.get(kv);
  if (version === undefined) {
    throw new CloudError("tampered", `This names team key version ${String(kv)}, which the team's key records do not hold, so it cannot be opened.`);
  }
  return version.key;
}

/** Team key pair `kv` from an opened team, or "tampered" when the chain does not reach it. */
export function teamPairAt(opened: OpenedTeam, kv: number): TeamKeyPair {
  const version = opened.chain.get(kv);
  if (version === undefined) {
    throw new CloudError("tampered", `This names team key version ${String(kv)}, which the team's key records do not hold, so it cannot be opened.`);
  }
  return version.pair;
}

export interface KeyRingOptions {
  store: () => DocStore;
  uid: () => string;
  random: RandomBytes;
  deviceKeys: DeviceKeyStore;
  trust: TrustStore;
  /**
   * The team's shares that are live at the newest key version `opened` holds, signed by one of
   * `kept`, the devices the next roster holds, and whose terms were signed only by devices of `kept`,
   * each with the digest of its manifest, for the next
   * roster to list (`Roster.shares`). The client checks each share's manifest, which this file does
   * not know how to; without it a rotation lists none.
   */
  liveShares?: (opened: OpenedTeam, kept: readonly RosterDevice[]) => Promise<RosterShare[]>;
  /**
   * PBKDF2 iterations for an approval code's key. Tests of the in-memory cloud may pass fewer; the
   * app always uses `APPROVAL_KDF_ITERATIONS`, the default.
   */
  approvalKdfIterations?: number;
}

/** What `rotationWrites` did, for the activity entry and the tests. */
export interface Rotation {
  writes: Write[];
  /** The new team key version. */
  kv: number;
  /**
   * The new version's public key and its roster's digest, which the device that made them pins once
   * the write is acknowledged (`CloudClient.pinRotation`), so a server that later puts back the state
   * from before is refused as an older one.
   */
  encKey: TeamEncKey;
  rosterDigest: Uint8Array;
  kept: string[];
  dropped: string[];
}

/** How a rotation is made, beyond the usual (see `rotationWrites`). */
export interface RotationOptions {
  /** The team as this device opened it another way (with the recovery code), instead of `openTeam`. */
  opened?: OpenedTeam;
  /** A new recovery code, raw: the rotation writes a new recovery record for it instead of moving the old one on. */
  recoveryCode?: Uint8Array;
  /** Give this device the new key even though it holds no grant of the newest key (after using the recovery code). */
  grantThisDevice?: boolean;
  /**
   * The recovery signing key's endorsement of this device at the newest version
   * (`endorseRecoveredDevice`), after using the recovery code: the evidence, put in the new roster,
   * that lets this device make it although no teammate approved it.
   */
  recoveryEndorsement?: Uint8Array;
  /**
   * Role changes this device's user makes in the same write, which the new roster records. They are
   * this user's own decision, never read from the server, so only an owner or admin of the newest
   * roster may pass them (`CannotRotateError` otherwise).
   */
  roles?: Readonly<Record<string, ActiveRole>>;
  /** The sharing setting `membersMayApproveDevices` as this device's user sets it in the same write; the same limits as `roles`. */
  membersMayApprove?: boolean;
}

/** What a grant write carries beyond the key. */
export interface GrantExtras {
  /** The random part of the approval code the approver typed: the grant gets an approval MAC. */
  approvalSecret?: Uint8Array;
  /** On a device's grant to itself after the recovery code: the recovery signing key's endorsement of it. */
  recoverySig?: Uint8Array;
}

export class KeyRing {
  private readonly devices = new Map<string, Promise<DeviceKeys>>();
  /** Devices whose record this session already wrote or queued, as `uid|deviceId`. */
  private readonly registered = new Set<string>();
  private readonly opened = new Map<string, OpenedTeam>();
  /** Opens of a team still running, as `uid|teamId`, which a second open waits for (`openTeam`). */
  private readonly opening = new Map<string, Promise<OpenedTeam>>();
  /** Approval keys already derived, by team, device and secret, because each takes a PBKDF2 run. */
  private readonly approvalKeys = new Map<string, Promise<CryptoKey>>();

  constructor(private readonly options: KeyRingOptions) {}

  private store(): DocStore {
    return this.options.store();
  }

  // ------------------------------------------------------------ this device

  /** This device's keys for the signed-in user, loaded or made on first use. */
  device(): Promise<DeviceKeys> {
    const uid = this.options.uid();
    let keys = this.devices.get(uid);
    if (keys === undefined) {
      keys = this.loadOrMake(uid);
      this.devices.set(uid, keys);
      keys.catch(() => this.devices.delete(uid));
    }
    return keys;
  }

  private async loadOrMake(uid: string): Promise<DeviceKeys> {
    let saved: DeviceKeys | null = null;
    try {
      saved = await this.options.deviceKeys.load(uid);
    } catch (error) {
      // Damaged or unavailable storage: this device starts afresh, as a new device would.
      if (!isCryptoError(error)) throw error;
    }
    if (saved !== null) return saved;
    const made = await guarded("This device's keys", () => generateDeviceKeys());
    try {
      await this.options.deviceKeys.save(uid, made);
    } catch (error) {
      // Without storage the keys last for this session only, which a shared computer wants anyway.
      if (!isCryptoError(error)) throw error;
    }
    return made;
  }

  /**
   * The write that registers this device's public record, or none when the server (or this
   * device's outbox) already has it. Put it in the same batch as whatever needs the record to exist:
   * the rules refuse a grant or a key request for a device with no record, and a record is never
   * written twice. Call `registrationQueued` once that batch is committed, and `registrationFailed`
   * if it is refused.
   */
  async registration(): Promise<Write[]> {
    const uid = this.options.uid();
    const keys = await this.device();
    const marker = `${uid}|${keys.deviceId}`;
    if (this.registered.has(marker)) return [];
    const stored = (await this.store().get(keyPaths.device(uid, keys.deviceId))) as DeviceDoc | null;
    if (stored !== null) {
      await guarded("This device's record", () => checkDeviceRecord(keys.deviceId, stored));
      if (!bytesEqual(stored.fingerprint, keys.fingerprint)) throw new CloudError("tampered", "This device's record on the server is not this device's.");
      this.registered.add(marker);
      return [];
    }
    return [{ op: "set", path: keyPaths.device(uid, keys.deviceId), data: { ...deviceRecord(keys), createdAt: SERVER_TIME } }];
  }

  /** Remembers that a batch carrying `registration` was committed, so the next batch leaves it out. */
  registrationQueued(registration: readonly Write[]): void {
    const uid = this.options.uid();
    for (const write of registration) this.registered.add(`${uid}|${write.path.slice(write.path.lastIndexOf("/") + 1)}`);
  }

  /** Forgets that `registration` was queued, after the batch carrying it was refused. */
  registrationFailed(uid: string, registration: readonly Write[]): void {
    for (const write of registration) this.registered.delete(`${uid}|${write.path.slice(write.path.lastIndexOf("/") + 1)}`);
  }

  /** A device's public record, checked against its id; "tampered" for one that does not match, null when missing. */
  async deviceRecordOf(uid: string, deviceId: string): Promise<DeviceRecord | null> {
    const stored = (await this.store().get(keyPaths.device(uid, deviceId))) as DeviceDoc | null;
    if (stored === null) return null;
    await guarded("A device's record", () => checkDeviceRecord(deviceId, stored));
    return stored;
  }

  // ------------------------------------------------------------ opening a team

  /** Forgets every opened key and loaded device key, at sign-out. The stores keep what they hold. */
  clear(): void {
    this.opened.clear();
    this.devices.clear();
    this.registered.clear();
    this.opening.clear();
    this.approvalKeys.clear();
  }

  /** The HMAC key for an approval code's random part, derived once per team, device and secret. */
  approvalKeyFor(teamId: string, deviceId: string, secret: Uint8Array): Promise<CryptoKey> {
    const cacheKey = `${teamId}|${deviceId}|${base64urlEncode(secret)}`;
    let key = this.approvalKeys.get(cacheKey);
    if (key === undefined) {
      const iterations = this.options.approvalKdfIterations;
      key = guarded("The approval code", () => approvalKey({ teamId, deviceId, secret, ...(iterations === undefined ? {} : { iterations }) }));
      this.approvalKeys.set(cacheKey, key);
      key.catch(() => this.approvalKeys.delete(cacheKey));
    }
    return key;
  }

  /** Forgets the opened keys of a team, after this device changed them. */
  forget(teamId: string): void {
    this.opened.delete(`${this.options.uid()}|${teamId}`);
  }

  /** The team document, with its `encKey` checked. */
  async team(teamId: string): Promise<TeamDoc> {
    return (await this.teamRead(teamId)).team;
  }

  /**
   * The team document, with its `encKey` checked, and whether it was read with writes of this device
   * that the server has not acknowledged applied (`DocRead.pendingWrites`).
   */
  private async teamRead(teamId: string): Promise<{ team: TeamDoc; pendingWrites: boolean }> {
    let read: DocRead;
    try {
      read = await this.store().getWithPending(paths.team(teamId));
    } catch (error) {
      if (isCloudError(error, "permission-denied")) read = { data: null, pendingWrites: false };
      else throw error;
    }
    if (read.data === null) throw new CloudError("not-found", "That team does not exist, or you cannot open it.");
    const team = read.data as unknown as TeamDoc;
    await guarded("The team's public key", () => checkTeamEncKey(team.encKey));
    return { team, pendingWrites: read.pendingWrites };
  }

  /**
   * This device's keys for `teamId`, checked as the file's comment lists. Throws "no-key" while the
   * device waits for a grant, "permission-denied" for someone who is not a member, and "tampered"
   * for anything that does not check out. `extractable` opens the newest key so it can be wrapped
   * again, which only granting and rotating need; it is never cached.
   *
   * One open runs at a time per team. The first open of a grant checks it against the approval code
   * and then forgets the code, so a second open checking the same grant beside it would find no code
   * and call the device still waiting. A second open while one runs takes its result, or, when it
   * needs an extractable key, waits for it and then opens again.
   */
  async openTeam(teamId: string, options: { extractable?: boolean } = {}): Promise<OpenedTeam> {
    const cacheKey = `${this.options.uid()}|${teamId}`;
    const running = this.opening.get(cacheKey);
    if (running !== undefined && options.extractable !== true) return running;
    const open = (async () => {
      if (running !== undefined) await running.catch(() => undefined);
      return this.openTeamNow(teamId, options);
    })();
    this.opening.set(cacheKey, open);
    try {
      return await open;
    } finally {
      if (this.opening.get(cacheKey) === open) this.opening.delete(cacheKey);
    }
  }

  private async openTeamNow(teamId: string, options: { extractable?: boolean }): Promise<OpenedTeam> {
    const uid = this.options.uid();
    const cacheKey = `${uid}|${teamId}`;
    const { team, pendingWrites } = await this.teamRead(teamId);
    const cached = this.opened.get(cacheKey);
    // A cached open is served only while the pin still names the team's key: a rotation this device
    // made since, then undone by the server, leaves the pin ahead of it. And only while the team
    // document shows every public field of the key the cached open checked: a signing key or
    // signature swapped beside the right encryption key would otherwise give a false safety code.
    const pinNow = readPin(this.options.trust, uid, "team", teamId);
    const pinIsTeamKey = pinNow !== null && pinNow.v === team.encKey.v && bytesEqual(pinNow.fingerprint, team.encKey.fingerprint);
    if (options.extractable !== true && cached !== undefined && pinIsTeamKey && sameEncKey(cached.team.encKey, team.encKey)) {
      return { ...cached, team };
    }
    const member = (await this.getOrNull(paths.member(teamId, uid))) as MemberDoc | null;
    if (member === null) throw new CloudError("permission-denied", "You are not a member of that team.");
    if (!ACTIVE.has(member.role)) throw new CloudError("no-key", WAITING_FOR_KEY);
    const device = await this.device();
    const grant = (await this.getOrNull(keyPaths.grant(teamId, device.deviceId))) as KeyGrantDoc | null;
    if (grant === null || grant.kv < team.encKey.v) throw new CloudError("no-key", WAITING_FOR_KEY);
    if (grant.kv > team.encKey.v || grant.uid !== uid || grant.deviceId !== device.deviceId || grant.teamId !== teamId) {
      throw new CloudError("tampered", "This device's key grant does not match the team, so it is not used.");
    }
    const pin = readPin(this.options.trust, uid, "team", teamId);
    // A first grant is checked against the approval code, which needs the raw team keys, so it is
    // opened as extractable and not cached; every later open is not.
    const extractable = options.extractable === true || pin === null;
    const approver: DeviceRecord | null =
      grant.approverDeviceId === device.deviceId ? deviceRecord(device) : await this.deviceRecordOf(grant.approverUid, grant.approverDeviceId);
    if (approver === null) throw new CloudError("tampered", "The device that approved this one has no record, so its approval cannot be checked.");
    const opened = await guarded("This device's key grant", async () => {
      const key = await openKeyGrant({
        teamId,
        grant: grant as unknown as KeyGrant,
        device,
        approver: { deviceId: grant.approverDeviceId, record: approver },
        extractable,
      });
      await checkGrantProof({ teamId, deviceId: device.deviceId, uid, record: deviceRecord(device), teamKey: key, proof: grant.proof });
      const records = (await this.store().list({ collection: keyPaths.teamKeys(teamId) })).map((doc) => doc.data as unknown as TeamKeyDoc);
      const chain = await openChain(teamId, key, records.filter((record) => record.kv <= key.version), { extractable });
      const newest = chain.get(key.version);
      if (newest === undefined) throw new CloudError("tampered", "The team's newest key record is missing.");
      return { newest, chain, records };
    });
    const pair = opened.newest.pair;
    const sameSig = pair.sig === null ? team.encKey.sig === null : team.encKey.sig !== null && bytesEqual(pair.sig, team.encKey.sig);
    if (!bytesEqual(pair.spki, team.encKey.spki) || !bytesEqual(pair.signSpki, team.encKey.signSpki) || !sameSig) {
      throw new CloudError("tampered", "The team's public key is not the one its newest key record holds, so the team's keys are not used.");
    }
    let roster: OpenedRoster;
    if (pin !== null) {
      const pinned = opened.chain.get(pin.v);
      if (pin.v > team.encKey.v || pinned === undefined || !bytesEqual(pinned.pair.fingerprint, pin.fingerprint) || !bytesEqual(pinned.pair.signSpki, pin.signSpki)) {
        throw new CloudError(
          "tampered",
          "The team's keys are not the ones this device saw before: they are older, or different under the same version. Nothing is decrypted. Compare the team safety code with a teammate.",
        );
      }
      roster = await this.checkRosters(teamId, opened.chain, opened.records, pin);
    } else {
      // The approver's MAC covers the newest roster's digest, so the roster is the one the approver
      // checked. A key with no roster that opens was approved by nobody who checked one.
      try {
        roster = await guarded("The team's device roster", () => openRoster(teamId, opened.newest.key, this.recordAt(opened.records, opened.newest.key.version)));
      } catch (error) {
        if (isCloudError(error, "tampered")) throw new CloudError("no-key", GRANT_NOT_APPROVED, { cause: error });
        throw error;
      }
      await this.checkApproval(teamId, uid, device, grant, opened.chain, roster.digest);
    }
    // A rotation this device made may have been acknowledged, and pinned, while this open awaited its
    // reads: the pin is read again with no await before it is written, so an open of the older state
    // can neither lower the pin nor be cached.
    const latest = readPin(this.options.trust, uid, "team", teamId);
    if (latest !== null && (latest.v > team.encKey.v || (latest.v === team.encKey.v && !bytesEqual(latest.fingerprint, team.encKey.fingerprint)))) {
      throw new CloudError(
        "tampered",
        "The team's keys are not the ones this device saw before: they are older, or different under the same version. Nothing is decrypted. Compare the team safety code with a teammate.",
      );
    }
    const result: OpenedTeam = { teamId, team, device, grant, newest: opened.newest, chain: opened.chain, roster: roster.roster, rosterDigest: roster.digest };
    // A team document read with this device's unsent writes applied may show a key that exists only
    // on this device: a rotation the server has not acknowledged, and may still refuse because
    // another admin rotated first. Pinning it would then lock the device out, so such an open leaves
    // the pin where it is and is not cached, unless the pin already names this key. The rotation is
    // pinned when its write is acknowledged (`CloudClient.pinRotation`); a refused one pins nothing.
    // At the same version the check above has made the fingerprints equal.
    const pinNamesKey = latest !== null && latest.v === team.encKey.v;
    if (pendingWrites && !pinNamesKey) return result;
    writePin(this.options.trust, uid, "team", teamId, team.encKey, roster.digest);
    // The approval code is used once: the grant it approved is taken, so it is forgotten.
    if (pin === null) clearApprovalSecret(this.options.trust, uid, teamId);
    if (!extractable) this.opened.set(cacheKey, result);
    return result;
  }

  /** The team key record of version `kv` in `records`, or "tampered" when it is missing. */
  private recordAt(records: readonly TeamKeyDoc[], kv: number): TeamKeyDoc {
    const record = records.find((candidate) => candidate.kv === kv);
    if (record === undefined) throw new CloudError("tampered", `The team's key record of version ${String(kv)} is missing.`);
    return record;
  }

  /**
   * The newest roster of `chain`, checked from a roster this device already trusts up to the newest
   * version, one step at a time (`checkRosterStep`). With `pin`, the start is the pinned version's
   * roster, which must have the pinned digest. With no pin (a device that used the recovery code for
   * its first key), the start is the newest roster that carries the anchor of `recovery`, the record
   * the code opened: the roster made with that code, which only its holder could sign for. Throws
   * "tampered" for any roster that does not check, or when no roster carries the anchor.
   */
  async checkRosters(
    teamId: string,
    chain: ReadonlyMap<number, TeamKeyVersion>,
    records: readonly TeamKeyDoc[],
    pin: Pin | null,
    recovery?: Pick<RecoveryDoc, "spki" | "signSpki">,
  ): Promise<OpenedRoster> {
    const newestKv = Math.max(...chain.keys());
    const keyAt = (kv: number): TeamKey => {
      const version = chain.get(kv);
      if (version === undefined) throw new CloudError("tampered", `The team's key records do not reach version ${String(kv)}.`);
      return version.key;
    };
    let current: OpenedRoster | null = null;
    if (pin !== null) {
      current = await guarded("The team's device roster", () => openRoster(teamId, keyAt(pin.v), this.recordAt(records, pin.v)));
    } else if (recovery !== undefined) {
      const fingerprint = await guarded("The team's recovery record", () => recoveryFingerprint(recovery));
      for (let kv = newestKv; kv >= 1 && current === null; kv -= 1) {
        const record = this.recordAt(records, kv);
        const opened = await guarded("The team's device roster", () => openRoster(teamId, keyAt(kv), record));
        if (await guarded("The team's recovery record", () => checkRecoveryAnchor(teamId, record, opened, recovery.signSpki, fingerprint))) current = opened;
      }
    }
    if (current === null) {
      throw new CloudError(
        "tampered",
        "None of the team's key versions was made with this recovery record, so the keys it opens may not be your team's, and nothing is decrypted. Ask a teammate to approve this device instead.",
      );
    }
    const start = current.roster.kv;
    if (pin !== null && (pin.rosterDigest === undefined || !bytesEqual(current.digest, pin.rosterDigest))) {
      throw new CloudError(
        "tampered",
        "The team's device list is not the one this device saw before, under the same key. Nothing is decrypted. Compare the team safety code with a teammate.",
      );
    }
    for (let kv = start + 1; kv <= newestKv; kv += 1) {
      const previous: Roster = current.roster;
      const record = this.recordAt(records, kv);
      current = await guarded(`The team's device roster of key version ${String(kv)}`, () => checkRosterStep({ teamId, previous, record, key: keyAt(kv) }));
    }
    return current;
  }

  /**
   * False only when the newest roster of `opened` shows that `deviceId` could not make the next one:
   * it is in the roster as the device of a member who is not an owner or admin there, or its grant of
   * the newest key reaches the roster through approvals by a device of the same member or of an owner
   * or admin of the roster (the only approvals that give a rotator authority, `rotationAuthority`'s
   * `grants`), in the name of a member who is
   * not an owner or admin there. Anything else is taken as a device that could, a grant that does not
   * reach the roster that way included: the grant the server shows may not be the one it holds.
   */
  async mayMakeNextRoster(opened: OpenedTeam, deviceId: string): Promise<boolean> {
    const { teamId, roster } = opened;
    const entry = deviceIn(roster, deviceId);
    if (entry !== null) return isAdminRole(roleIn(roster, entry.uid));
    const kv = opened.newest.key.version;
    let docs;
    try {
      docs = await this.store().list({ collection: keyPaths.grants(teamId) });
    } catch (error) {
      // A member who is not an owner or admin may list only their own grants.
      if (!isCloudError(error, "permission-denied")) throw error;
      docs = await this.store().list({ collection: keyPaths.grants(teamId), where: [{ field: "uid", value: this.options.uid() }] });
    }
    const grants: GrantEvidence[] = docs
      .filter((doc) => doc.id === String(doc.data.deviceId))
      .map((doc) => doc.data as unknown as KeyGrantDoc)
      .filter((grant) => grant.kv === kv && grant.teamId === teamId)
      .map((grant) => ({ deviceId: grant.deviceId, uid: grant.uid, kv: grant.kv, approverDeviceId: grant.approverDeviceId, wrap: grant.wrap, signature: grant.signature }));
    const rooted = await rootGrants({
      teamId,
      kv,
      grants,
      anchorOf: (id) => {
        const device = deviceIn(roster, id);
        return device === null ? null : { deviceId: id, uid: device.uid, record: recordOfKeys(device) };
      },
      mayApprove: (approverUid, grantUid) => approverUid === grantUid || isAdminRole(roleIn(roster, approverUid)),
      recordOf: (uid, id) => this.checkedRecordOrNull(uid, id),
    });
    const reached = rooted.get(deviceId);
    return reached === undefined || isAdminRole(roleIn(roster, reached.uid));
  }

  /** A device's record checked against its id, or null when it is missing or does not check. */
  private async checkedRecordOrNull(uid: string, deviceId: string): Promise<DeviceRecord | null> {
    try {
      return await this.deviceRecordOf(uid, deviceId);
    } catch (error) {
      if (isCloudError(error, "tampered") || isCloudError(error, "permission-denied")) return null;
      throw error;
    }
  }

  /**
   * Throws "no-key" unless `grant`, this device's first for the team, carries the MAC made with the
   * approval code this device showed, over the key version the grant gives and that version's roster.
   */
  private async checkApproval(
    teamId: string,
    uid: string,
    device: DeviceKeys,
    grant: KeyGrantDoc,
    chain: Map<number, TeamKeyVersion>,
    rosterDigest: Uint8Array,
  ): Promise<void> {
    const approval = grant.approval as Partial<GrantApproval> | undefined;
    if (
      typeof approval !== "object" ||
      approval === null ||
      approval.v !== 1 ||
      !isKeyVersion(approval.kv) ||
      approval.kv !== grant.kv ||
      !(approval.mac instanceof Uint8Array)
    ) {
      throw new CloudError("no-key", GRANT_NOT_APPROVED);
    }
    const version = chain.get(approval.kv);
    const stored = readApprovalSecret(this.options.trust, uid, teamId);
    if (version === undefined || stored === null || stored.deviceId !== device.deviceId) throw new CloudError("no-key", GRANT_NOT_APPROVED);
    const key = await this.approvalKeyFor(teamId, device.deviceId, stored.secret);
    const mac = approval.mac;
    const matches = await guarded("The approval code", () =>
      checkApprovalMac(
        key,
        { teamId, deviceId: device.deviceId, uid, teamKey: version.key, encFingerprint: version.pair.fingerprint, signSpki: version.pair.signSpki, rosterDigest },
        mac,
      ),
    );
    if (!matches) throw new CloudError("no-key", GRANT_WRONG_CODE);
  }

  private async getOrNull(path: string): Promise<DocData | null> {
    try {
      return await this.store().get(path);
    } catch (error) {
      if (isCloudError(error, "permission-denied")) return null;
      throw error;
    }
  }

  // ------------------------------------------------------------ grants

  /**
   * The write that gives the newest team key of `opened` (opened as extractable) to `recipient`'s
   * device, signed by this device: a new grant, or an update of the one it has. `extras.approvalSecret`
   * is the random part of the code the approver typed, which puts an approval MAC on the grant over
   * the key it gives and that key's roster. `extras.recoverySig` is the recovery key's endorsement of
   * a device granting itself the key with the recovery code. A rotation passes neither, and removes
   * any the grant has: they were made over the old key, so a device that had not yet opened its
   * grant asks again, and a device the recovery code let in is in the new roster only as its maker.
   */
  async grantWrite(opened: OpenedTeam, recipient: { uid: string; deviceId: string; record: DeviceRecord }, existing: KeyGrantDoc | null, extras: GrantExtras = {}): Promise<Write> {
    const me = this.options.uid();
    const teamKey = opened.newest.key;
    const { grant, proof } = await guarded("A key grant", async () => ({
      grant: await makeKeyGrant({
        teamId: opened.teamId,
        teamKey,
        recipient: { deviceId: recipient.deviceId, uid: recipient.uid, record: recipient.record },
        approver: opened.device,
        random: this.options.random,
      }),
      proof: await makeGrantProof({
        teamId: opened.teamId,
        deviceId: recipient.deviceId,
        uid: recipient.uid,
        fingerprint: recipient.record.fingerprint,
        teamKey,
        random: this.options.random,
      }),
    }));
    const changed: DocData = {
      kv: grant.kv,
      wrap: grant.wrap,
      proof,
      approverDeviceId: grant.approverDeviceId,
      approverUid: me,
      signature: grant.signature,
      updatedAt: SERVER_TIME,
    };
    if (extras.approvalSecret !== undefined) {
      const key = await this.approvalKeyFor(opened.teamId, recipient.deviceId, extras.approvalSecret);
      const mac = await guarded("The approval code", () =>
        makeApprovalMac(key, {
          teamId: opened.teamId,
          deviceId: recipient.deviceId,
          uid: recipient.uid,
          teamKey,
          encFingerprint: opened.newest.pair.fingerprint,
          signSpki: opened.newest.pair.signSpki,
          rosterDigest: opened.rosterDigest,
        }),
      );
      const approval: GrantApproval = { v: 1, kv: teamKey.version, mac };
      changed.approval = approval as unknown as DocData;
    } else if (existing !== null && Object.hasOwn(existing, "approval")) {
      changed.approval = DELETE_FIELD;
    }
    if (extras.recoverySig !== undefined) {
      if (recipient.deviceId !== opened.device.deviceId) throw new CloudError("invalid", "Only a device granting itself the key carries the recovery key's endorsement.");
      changed.recoverySig = extras.recoverySig;
    } else if (existing !== null && Object.hasOwn(existing, "recoverySig")) {
      changed.recoverySig = DELETE_FIELD;
    }
    const path = keyPaths.grant(opened.teamId, recipient.deviceId);
    // An update names only what changes: rewriting createdAt would be refused.
    if (existing !== null) return { op: "update", path, data: changed };
    return { op: "set", path, data: { v: 1, teamId: opened.teamId, deviceId: recipient.deviceId, uid: recipient.uid, ...changed, createdAt: SERVER_TIME } };
  }

  /** The grant a device has in a team, or null when it has none or the caller may not read it. */
  async grantOf(teamId: string, deviceId: string): Promise<KeyGrantDoc | null> {
    return (await this.getOrNull(keyPaths.grant(teamId, deviceId))) as KeyGrantDoc | null;
  }

  // ------------------------------------------------------------ rotation

  /**
   * The writes that rotate a team's key (spec 14 section 4.5): team key n+1 and its pairs, signed by
   * pair n; its device roster, signed by this device; the recovery record moved on to it (or a new
   * one, for `options.recoveryCode`); and a new grant for every device that keeps access. Owners and
   * admins only, from a device that holds the newest key and that roster n gives the authority to
   * make roster n+1 (`CannotRotateError` otherwise).
   *
   * The kept set is roster n's devices, less those of members who go and those revoked, plus the
   * grants of key n made since whose approvals reach roster n. In full:
   *
   * - a device of roster n is kept when its member stays, it is not revoked, it still has a grant of
   *   key n in its member's name, and its device record still has the fingerprint roster n holds;
   * - a grant of key n for a device not in roster n is kept when its member stays, it is not revoked,
   *   its proof checks under key n, and its approving device is a kept device of roster n or a grant
   *   already kept, whose signature over it checks, and whose member may approve it, by roster n
   *   alone: the same member, an owner or admin in roster n, or, with roster n's
   *   `membersMayApprove` on, any member of roster n, for a device of a member of roster n who is
   *   not an owner or admin there (`mayApproveUnderSetting`);
   * - this device, once it has the authority to rotate.
   *
   * When that authority is the recovery code's alone, roster n+1 also carries, in `via`, the grants
   * from a device of roster n down to every other device it adds, which a device checking it needs
   * (`rootedNewDevices`); a device whose grants do not fit is not kept, and asks again.
   *
   * Roster n+1's members are roster n's who stay, the members of kept devices new since, the
   * members `options.roles` names, and this device's user. Each keeps roster n's role, lowered to
   * the member document's when that says less; a member new since roster n gets their member
   * document's role, but at most an editor. Only `options.roles` raises a role, and only
   * `options.membersMayApprove` turns the setting on; otherwise roster n+1 keeps roster n's setting,
   * turned off when the sharing settings say off.
   *
   * So a grant a device made for itself (after the recovery code) is not kept unless it is this
   * device's own: the code lets a device in until the next rotation, no further. Nor is a grant whose
   * approver has no grant, was dropped, belongs to a member who goes, or only approves in a loop
   * with no roster device behind it. Dropped grants, and key requests of members who go, are
   * deleted. The recovery record must hold key n and be the one roster n names, so an older record
   * the server puts back, or one a member who holds the key made, is refused.
   *
   * What is still the server's word: that a member or a setting is lowered or gone. So the server
   * can only take authority away (drop a member, lower a role, turn the setting off), never give it:
   * a member counts as staying only when roster n, a kept device or this user's own role change
   * names them and their member document says active, and every approval is judged by roster n. A
   * member removed, or a
   * device revoked, by a device that could not rotate at once has its grant deleted and the team
   * marked "rotation pending"; if the server puts that grant and member document back before the
   * rotation, the rotating device cannot tell, and re-grants it. `listTeamDevices` shows every
   * device a rotation keeps.
   */
  async rotationWrites(teamId: string, remove: { uids?: readonly string[]; deviceIds?: readonly string[] } = {}, options: RotationOptions = {}): Promise<Rotation> {
    const me = this.options.uid();
    const opened = options.opened ?? (await this.openTeam(teamId, { extractable: true }));
    const roster = opened.roster;
    const kv = opened.newest.key.version;
    const myDeviceId = opened.device.deviceId;
    const removedUids = new Set(remove.uids ?? []);
    const removedDevices = new Set(remove.deviceIds ?? []);
    const members = (await this.store().list({ collection: paths.members(teamId) })).map((doc) => doc.data as unknown as MemberDoc);
    // The member documents only take away: who is active, and the most each may be.
    const active = new Map<string, ActiveRole>();
    for (const member of members) {
      if (ACTIVE.has(member.role) && !removedUids.has(member.uid)) active.set(member.uid, member.role as ActiveRole);
    }
    if (!active.has(me)) throw new CloudError("invalid", "A device of a member who stays in the team must rotate its key.");
    const changes = options.roles ?? {};
    if ((Object.keys(changes).length > 0 || options.membersMayApprove !== undefined) && !isAdminRole(roleIn(roster, me))) throw new CannotRotateError();
    // Roster n's members who stay, with roster n's role, lowered to the member document's; then this user's own changes.
    const roles = new Map<string, ActiveRole>();
    for (const member of roster.members) {
      const now = active.get(member.uid);
      if (now !== undefined) roles.set(member.uid, lowerRole(member.role, now));
    }
    for (const [uid, role] of Object.entries(changes)) if (active.has(uid) && ACTIVE.has(role)) roles.set(uid, role);
    const newMember = (uid: string) => {
      const now = active.get(uid);
      if (now !== undefined && !roles.has(uid)) roles.set(uid, lowerRole(now, NEW_MEMBER_ROLE_CAP));
    };
    newMember(me);
    const membersMayApprove = options.membersMayApprove ?? (roster.membersMayApprove && (await this.membersMayApproveDevices(teamId)));
    const allGrants = (await this.store().list({ collection: keyPaths.grants(teamId) }))
      .filter((doc) => doc.id === String(doc.data.deviceId))
      .map((doc) => doc.data as unknown as KeyGrantDoc);
    const grants = new Map(allGrants.filter((grant) => grant.kv === kv && grant.teamId === teamId).map((grant) => [grant.deviceId, grant]));
    const stays = (uid: string, deviceId: string) => active.has(uid) && !removedDevices.has(deviceId);
    // This device's record comes from its own keys: after the recovery code it may be registered in this very write.
    const recordOf = async (uid: string, deviceId: string): Promise<DeviceRecord | null> =>
      uid === me && deviceId === myDeviceId ? deviceRecord(opened.device) : this.checkedRecordOrNull(uid, deviceId);

    // Roster n's devices that stay, and still hold their grant, are the anchors every other grant
    // must reach. Their keys come from roster n itself, never from a device record the server holds.
    const anchors = new Map<string, Approver>();
    for (const entry of roster.devices) {
      const grant = grants.get(entry.deviceId);
      if (!stays(entry.uid, entry.deviceId) || grant === undefined || grant.uid !== entry.uid) continue;
      anchors.set(entry.deviceId, { deviceId: entry.deviceId, uid: entry.uid, record: recordOfKeys(entry) });
    }
    // Grants made since roster n, each with a proof under key n, rooted through approvals with authority.
    const candidates: GrantEvidence[] = [];
    for (const grant of grants.values()) {
      if (deviceIn(roster, grant.deviceId) !== null || !stays(grant.uid, grant.deviceId)) continue;
      candidates.push({ deviceId: grant.deviceId, uid: grant.uid, kv: grant.kv, approverDeviceId: grant.approverDeviceId, wrap: grant.wrap, signature: grant.signature });
    }
    const rooted = await rootGrants({
      teamId,
      kv,
      grants: candidates,
      anchorOf: (deviceId) => anchors.get(deviceId) ?? null,
      // Authority comes from roster n alone, never from the member documents or the settings the server holds.
      mayApprove: (approverUid, grantUid) => mayApproveAt(roster, approverUid, grantUid),
      recordOf: async (uid, deviceId) => {
        const record = await recordOf(uid, deviceId);
        const grant = grants.get(deviceId);
        if (record === null || grant === undefined) return null;
        try {
          await checkGrantProof({ teamId, deviceId, uid, record, teamKey: opened.newest.key, proof: grant.proof });
          return record;
        } catch (error) {
          if (isCryptoError(error)) return null;
          throw error;
        }
      },
    });

    // This device must be able to make roster n+1, and is always in it.
    const myEntry: RosterDevice = { deviceId: myDeviceId, uid: me, encSpki: opened.device.encSpki, signSpki: opened.device.signSpki, fingerprint: opened.device.fingerprint };
    const recovery = (await this.store().get(keyPaths.recovery(teamId))) as RecoveryDoc | null;
    let via = rotatorLinks(kv, myEntry, anchors, isAdminRole(roleIn(roster, me)), rooted, grants.get(myDeviceId) ?? null, recovery, options.recoveryEndorsement);
    if (via.length > MAX_ROSTER_LINKS) throw new CannotRotateError();
    const authority = await guarded("The team's device roster", () => rotationAuthority({ teamId, previous: roster, rotator: myEntry, via }));
    if (authority === null) throw new CannotRotateError();
    const reachable: Approver[] = [...anchors.values(), ...[...rooted.values()].map(({ deviceId, uid, record }) => ({ deviceId, uid, record }))];
    const selfKept = reachable.some((device) => device.deviceId === myDeviceId);
    if (!selfKept && options.grantThisDevice !== true && via.every((link) => link.kind !== "recovery")) {
      throw new CloudError("tampered", "This device's own grant did not check out, so it cannot rotate the team key.");
    }
    // At most MAX_DEVICES_PER_MEMBER of each member's: this device first, then roster n's, then the
    // rest in device id order, which nobody chooses.
    let keptDevices: Approver[] = [{ deviceId: myDeviceId, uid: me, record: deviceRecord(opened.device) }];
    const perMember = new Map<string, number>([[me, 1]]);
    const ordered = [...anchors.values(), ...[...rooted.values()].sort((a, b) => compare(a.deviceId, b.deviceId))];
    for (const { deviceId, uid, record } of ordered) {
      const count = perMember.get(uid) ?? 0;
      if (deviceId === myDeviceId || count >= MAX_DEVICES_PER_MEMBER) continue;
      perMember.set(uid, count + 1);
      keptDevices.push({ deviceId, uid, record });
    }
    // With only the recovery code's authority, which any member who saw the code has, roster n+1
    // must show who approved each device it adds, or a device that checks it refuses it.
    if (authority === "recovery") ({ kept: keptDevices, via } = withApprovalLinks(kv, keptDevices, anchors, rooted, via, myDeviceId));
    // A member new since roster n comes in only through a kept device.
    for (const device of keptDevices) newMember(device.uid);

    const next: NewTeamKeys = await guarded("The team's keys", () => rotateTeamKeys(teamId, opened.newest, this.options.random));
    let recoveryAfter;
    let recoveryAnchor: Uint8Array | null = null;
    if (options.recoveryCode !== undefined) {
      const code = options.recoveryCode;
      recoveryAfter = await guarded("The new recovery code", () => createRecovery({ teamId, teamKey: next.key, code, random: this.options.random }));
      const made = recoveryAfter;
      // The new code vouches for this version, which a device with no pin that uses it starts from.
      recoveryAnchor = await guarded("The new recovery code", async () =>
        anchorRecovery(await openRecoverySigner({ teamId, record: made, code }), {
          teamId,
          kv: next.key.version,
          pairSpki: next.record.pairSpki,
          signSpki: next.record.signSpki,
          recovery: await recoveryFingerprint(made),
          rotatorSignSpki: opened.device.signSpki,
        }),
      );
    } else {
      if (recovery === null) throw new CloudError("tampered", "The team's recovery record is missing, so the key cannot be rotated. An owner can make a new recovery code first.");
      if (recovery.kv !== kv) {
        throw new CloudError(
          "tampered",
          "The team's recovery record does not hold the team's newest key, so it may be an old one put back. The key is not rotated. An owner can make a new recovery code, which rotates the key too.",
        );
      }
      const named = await guarded("The team's recovery record", async () => bytesEqual(await recoveryFingerprint(recovery), roster.recovery));
      if (!named) {
        throw new CloudError(
          "tampered",
          "The team's recovery record is not the one the team's device list names, so it may have been swapped for someone else's. The key is not rotated. An owner can make a new recovery code, which rotates the key too.",
        );
      }
      recoveryAfter = await guarded("The team's recovery record", () =>
        rewrapRecovery({ teamId, record: recovery, currentKey: opened.newest.key, newKey: next.key, random: this.options.random }),
      );
    }

    const nextDevices: RosterDevice[] = keptDevices
      .map(({ deviceId, uid, record }) => ({ deviceId, uid, encSpki: record.encSpki, signSpki: record.signSpki, fingerprint: record.fingerprint }))
      .sort((a, b) => compare(a.deviceId, b.deviceId));
    const nextRoster: Roster = {
      v: 1,
      teamId,
      kv: next.key.version,
      rotator: myDeviceId,
      nonce: rosterNonce(this.options.random),
      members: [...roles].map(([uid, role]) => ({ uid, role })).sort((a, b) => compare(a.uid, b.uid)),
      membersMayApprove,
      devices: nextDevices,
      recovery: await guarded("The team's recovery record", () => recoveryFingerprint(recoveryAfter)),
      via,
      recoveryAnchor,
      // Only the shares a kept device signed: a device dropped here could have signed any share.
      shares: await this.liveShares(opened, nextDevices),
    };
    // Every device that checks a roster made with only the recovery code's authority refuses one that
    // raises a role or turns the setting on, so such a change is refused here, before anything is written.
    if (authority === "recovery" && raisesAuthority(roster, nextRoster)) throw new CloudError("invalid", RECOVERY_CANNOT_RAISE);
    let sealed;
    try {
      sealed = await sealRoster({
        teamId,
        key: next.key,
        pairSpki: next.record.pairSpki,
        signSpki: next.record.signSpki,
        roster: nextRoster,
        signer: opened.device.signing.privateKey,
        random: this.options.random,
      });
    } catch (error) {
      if (isCryptoError(error) && error.code === "too-large") throw new RosterTooLargeError();
      throw cryptoToCloud(error, "The team's device roster");
    }
    if (sealed.roster.ct.byteLength > MAX_ROSTER_BYTES) throw new RosterTooLargeError();
    const rotated: OpenedTeam = { ...opened, newest: { key: next.key, pair: next.pair }, roster: nextRoster, rosterDigest: sealed.digest };

    const writes: Write[] = [
      { op: "update", path: paths.team(teamId), data: { encKey: next.encKey, rotationPending: false } },
      { op: "set", path: keyPaths.teamKey(teamId, next.key.version), data: { ...next.record, roster: sealed.roster, rosterSig: sealed.rosterSig } },
      { op: "set", path: keyPaths.recovery(teamId), data: { ...recoveryAfter, updatedBy: me, updatedAt: SERVER_TIME } },
    ];
    const keptIds = new Set(keptDevices.map((device) => device.deviceId));
    for (const { deviceId, uid, record } of keptDevices) {
      const existing = grants.get(deviceId) ?? allGrants.find((grant) => grant.deviceId === deviceId) ?? null;
      writes.push(await this.grantWrite(rotated, { uid, deviceId, record }, existing));
    }
    const dropped = allGrants.filter((grant) => !keptIds.has(grant.deviceId)).map((grant) => grant.deviceId);
    for (const deviceId of dropped) writes.push({ op: "delete", path: keyPaths.grant(teamId, deviceId) });
    const requests = await this.store().list({ collection: keyPaths.requests(teamId) });
    for (const request of requests) {
      const uid = String(request.data.uid);
      if (removedUids.has(uid) || removedDevices.has(request.id)) writes.push({ op: "delete", path: request.path });
    }
    return { writes, kv: next.key.version, encKey: next.encKey, rosterDigest: sealed.digest, kept: [...keptIds], dropped };
  }

  /**
   * Roster 1 of a new team, made and signed by this device, the founder's: the founder as its only
   * member (an owner) and this device as its only device, with `recoveryAnchor`, the new recovery
   * code's anchor of version 1 (`anchorRecovery`). Returns the fields for `teamKeys/1`, the roster,
   * and its digest for the pin.
   */
  async foundingRoster(
    teamId: string,
    made: Pick<NewTeamKeys, "key" | "record">,
    recovery: Pick<RecoveryDoc, "spki" | "signSpki">,
    recoveryAnchor: Uint8Array,
  ): Promise<{ fields: { roster: DocData; rosterSig: Uint8Array }; roster: Roster; digest: Uint8Array }> {
    const uid = this.options.uid();
    const device = await this.device();
    return guarded("The new team's device roster", async () => {
      const roster: Roster = {
        v: 1,
        teamId,
        kv: made.key.version,
        rotator: device.deviceId,
        nonce: rosterNonce(this.options.random),
        members: [{ uid, role: "owner" }],
        membersMayApprove: false,
        devices: [{ deviceId: device.deviceId, uid, encSpki: device.encSpki, signSpki: device.signSpki, fingerprint: device.fingerprint }],
        recovery: await recoveryFingerprint(recovery),
        via: [],
        recoveryAnchor,
        shares: [],
      };
      const sealed = await sealRoster({
        teamId,
        key: made.key,
        pairSpki: made.record.pairSpki,
        signSpki: made.record.signSpki,
        roster,
        signer: device.signing.privateKey,
        random: this.options.random,
      });
      return { fields: { roster: sealed.roster as unknown as DocData, rosterSig: sealed.rosterSig }, roster, digest: sealed.digest };
    });
  }

  /** The team's membersMayApproveDevices setting, as the server holds it (false when there is none). It can only turn roster n's setting off. */
  /**
   * The shares the next roster lists (`KeyRingOptions.liveShares`), at most MAX_ROSTER_SHARES of
   * them, sorted by id. A share left out is only one its team must share again.
   */
  private async liveShares(opened: OpenedTeam, kept: readonly RosterDevice[]): Promise<RosterShare[]> {
    const found = this.options.liveShares === undefined ? [] : await this.options.liveShares(opened, kept);
    return found.slice(0, MAX_ROSTER_SHARES).sort((a, b) => compare(a.shareId, b.shareId));
  }

  private async membersMayApproveDevices(teamId: string): Promise<boolean> {
    const docs = await this.store().list({ collection: paths.settingsCollection(teamId) });
    const settings = (docs.find((doc) => doc.path === paths.settings(teamId))?.data ?? null) as TeamSettingsDoc | null;
    return settings?.membersMayApproveDevices === true;
  }

  /** The records a team's key chain holds, as read. For tests and the export. */
  async teamKeyDocs(teamId: string): Promise<TeamKeyDoc[]> {
    return (await this.store().list({ collection: keyPaths.teamKeys(teamId) })).map((doc) => doc.data as unknown as TeamKeyDoc);
  }
}

/** True when two `encKey`s are the same key: version, both public halves, the fingerprint and the signature. */
function sameEncKey(a: TeamDoc["encKey"], b: TeamDoc["encKey"]): boolean {
  const sameSig = a.sig === null || b.sig === null ? a.sig === b.sig : bytesEqual(a.sig, b.sig);
  return a.v === b.v && bytesEqual(a.fingerprint, b.fingerprint) && bytesEqual(a.spki, b.spki) && bytesEqual(a.signSpki, b.signSpki) && sameSig;
}

/** Orders ids by code unit, the same in every browser and in Node. */
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The links roster n+1 carries to show that the rotating device `me` may make it: none when it is in
 * roster n (an anchor) and its member an owner or admin there (`fromRoster`); the kept grants from a device of roster n down to it when it was approved
 * since; or the recovery key's endorsement of it, from `endorsement` or from its own grant's
 * `recoverySig`, after it used the recovery code. `rotatorRecord` then decides whether they give it
 * the authority.
 */
function rotatorLinks(
  kv: number,
  me: RosterDevice,
  anchors: ReadonlyMap<string, Approver>,
  fromRoster: boolean,
  rooted: ReadonlyMap<string, RootedGrant>,
  ownGrant: KeyGrantDoc | null,
  recovery: Pick<RecoveryDoc, "spki" | "signSpki"> | null,
  endorsement: Uint8Array | undefined,
): RosterLink[] {
  if (anchors.has(me.deviceId) && fromRoster) return [];
  if (rooted.has(me.deviceId)) return grantChain(kv, rooted, me.deviceId);
  const ownEndorsement =
    ownGrant !== null && ownGrant.approverDeviceId === me.deviceId && ownGrant.uid === me.uid && ownGrant.recoverySig instanceof Uint8Array ? ownGrant.recoverySig : undefined;
  const signature = endorsement ?? ownEndorsement;
  if (signature === undefined || recovery === null || !(recovery.spki instanceof Uint8Array) || !(recovery.signSpki instanceof Uint8Array)) return [];
  return [{ kind: "recovery", ...me, kv, recoverySpki: recovery.spki, recoverySignSpki: recovery.signSpki, signature }];
}

/** The kept grants of version `kv` from a device of roster n down to `deviceId`, approver first; empty when `rooted` does not hold it. */
function grantChain(kv: number, rooted: ReadonlyMap<string, RootedGrant>, deviceId: string): GrantLink[] {
  const links: GrantLink[] = [];
  let current: RootedGrant | undefined = rooted.get(deviceId);
  // Each kept grant's approver was kept before it, so the walk ends at an anchor.
  while (current !== undefined && links.length <= MAX_ROSTER_LINKS) {
    const { grant, record } = current;
    links.push({
      kind: "grant",
      deviceId: grant.deviceId,
      uid: grant.uid,
      encSpki: record.encSpki,
      signSpki: record.signSpki,
      fingerprint: record.fingerprint,
      kv,
      approverDeviceId: grant.approverDeviceId,
      wrap: grant.wrap,
      signature: grant.signature,
    });
    current = rooted.get(grant.approverDeviceId);
  }
  return links.reverse();
}

/**
 * For a rotation whose maker has only the recovery code's authority: the devices of `kept` that
 * roster n+1 can show were approved, and `via` with the grant links that show it, from a device of
 * roster n down to each device it adds (`rootedNewDevices` in keys/roster.ts). This device, `me`, and
 * roster n's own devices (`anchors`) need none. A device whose links would take `via` past
 * MAX_ROSTER_LINKS is left out, and asks for the key again.
 */
function withApprovalLinks(
  kv: number,
  kept: readonly Approver[],
  anchors: ReadonlyMap<string, Approver>,
  rooted: ReadonlyMap<string, RootedGrant>,
  via: readonly RosterLink[],
  me: string,
): { kept: Approver[]; via: RosterLink[] } {
  const links = new Map<string, GrantLink>();
  const shown: Approver[] = [];
  for (const device of kept) {
    if (device.deviceId === me || anchors.has(device.deviceId)) {
      shown.push(device);
      continue;
    }
    if (!rooted.has(device.deviceId)) continue;
    const chain = grantChain(kv, rooted, device.deviceId).filter((link) => !links.has(link.deviceId));
    if (via.length + links.size + chain.length > MAX_ROSTER_LINKS) continue;
    for (const link of chain) links.set(link.deviceId, link);
    shown.push(device);
  }
  return { kept: shown, via: [...via, ...links.values()] };
}
