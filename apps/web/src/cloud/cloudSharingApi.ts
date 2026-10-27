/**
 * The sharing UI's `SharingApi` on top of `packages/cloud`'s `CloudBackend`
 * (spec 13 section 8), so sharing runs on the same backend, and the same
 * sign-in, as the account and the team library. The account session hands this adapter to the
 * sharing store with `setSharingBackend` once someone is signed in with a team (`account/wiring.ts`).
 *
 * What it translates:
 *
 * - **Teams.** The sharing UI names teams by FTC number; the cloud stores team ids. A number is
 *   turned into a team with the backend's own lookup (`findTeamByNumber`, which reads the number's
 *   claim), and a stored id back into a number with `getTeam`. Both are cached for the adapter's life.
 * - **Instants.** ISO 8601 strings here, `Date`s in the cloud.
 * - **Revisions.** The cloud stores the revision id (`000004-q8Yx…`); the UI also shows its number.
 * - **Errors.** Every failure becomes one sentence the UI can show as it is (`sharingErrorSentence`).
 * - **The outbox.** A write returns once the server has it while the device is online, so a refusal
 *   by the rules is reported where it was asked for. Offline it returns at once with the value as it
 *   stands on this device, and the outbox sends it later (section 6).
 * - **Teams not looked up yet, offline.** A share to a team number this device has never looked up
 *   cannot be made offline: the team's id and public key come from the server. It waits on this page
 *   instead, and is made when the connection is back (`waitsForConnection`); how that went is said
 *   through `onPendingResult`.
 * - **Partner keys (spec 14).** `checkPartnerKeys` says which teams' keys changed since this device
 *   last shared with them, so the dialog can warn before anything is sent.
 * - **Team numbers.** The claim that turns a number into a team is the server's word, even once a
 *   Horizon admin verified it, so this device pins each number to the team it shared with under it
 *   (`teamNumberPin`). A number that later leads to another team is refused like a changed key until
 *   the person compares both safety codes (`acceptNumberChanges`). A team this device never showed
 *   the safety code of is asked about once, with its code (`first-use`), and the share records that
 *   the person saw it (`safetyCodesSeen`). A share made online to a number whose code was neither
 *   shown now nor seen before for the team it leads to is refused (`SafetyCodeNotShownError`), and a
 *   number the check finds no team for is said to be nobody's rather than skipped, so a server that
 *   hides a team from the check and shows it to the send gets nothing.
 * - **The key shown is the key wrapped to.** Each warning names the team and the exact key its safety
 *   code is of, and each answer carries them back (`shownKeys`). The cloud wraps the share key to that
 *   key or makes nothing (`expectedKeys`), so a server that serves one key to the dialog and another
 *   to the send gets nothing, and the number is never recorded as seen for a key that was not shown.
 * - **Who a received share is from.** The server writes the sharing team's number, name and status,
 *   so each received share is compared with the team this device pinned under that number
 *   (`fromTeamCheck`); a first share from a number shows the sharing team's safety code. A team with
 *   no number always shows its safety code, and one whose name reads as a number this device knows
 *   as another team is flagged like a team claiming that number.
 *
 * Only types come from the cloud package's main entry, which carries the Firebase SDK; the limits
 * and the number a team's name reads as come from its Firebase-free `sharing` entry.
 */
import type {
  CloudBackend,
  Invite as CloudInvite,
  Queued,
  Share as CloudShare,
  StoppedShare as CloudStoppedShare,
  Team,
  TeamStatus,
  WaitingShare as CloudWaitingShare,
} from "@horizon36596/zenith-cloud";
import { MAX_SHARE_TEAMS, numberInTeamName, revisionNumber } from "@horizon36596/zenith-cloud/sharing";
import { KEY_ERRORS, cloudErrorCode } from "../account/keys/errors";
import { OFFLINE, cloudErrorSentence, ownSentence } from "./errorSentence";
import { SafetyCodeNotShownError } from "./keyAnswers";
import { encodeSharerChoice, readSharerChoice } from "./projectionModel";
import { teamOrNull, teamReader } from "./teams";
import type {
  CreateShareOptions,
  FromTeamCheck,
  Invite,
  PartnerKeyWarning,
  PendingShareResult,
  ReceivedShare,
  RevisionFiles,
  Share,
  ShareRequest,
  SharingApi,
  ShownKey,
  StoppedShare,
  WaitingShare,
} from "./types";

/** The sharer's choices a share carries, when the sharing team reads them and they are well formed. */
function choiceOf(share: CloudShare): Pick<Share, "choice"> {
  const choice = share.ownerChoice === undefined ? null : readSharerChoice(share.ownerChoice);
  return choice === null ? {} : { choice };
}

/** The most teams one share names (ADR 0009 section 4: the rules engine's document read limit). */
export const SHARE_TEAM_LIMIT = MAX_SHARE_TEAMS;

/** Why a list of teams is too long for one share, or null. The dialog checks it before sending. */
export function teamLimitProblem(count: number): string | null {
  if (count <= SHARE_TEAM_LIMIT) return null;
  return `One share can name at most ${String(SHARE_TEAM_LIMIT)} teams, and this one names ${String(count)}. Share with the first ${String(SHARE_TEAM_LIMIT)}, then make a second share for the others.`;
}

/** The `CloudError` code, found by its fields so this file needs no value from the cloud package. */
const cloudCode = cloudErrorCode;

/**
 * Why a cloud call failed, as a sentence the sharing UI shows as it is: the app's one cloud
 * translator (`cloudErrorSentence`), in sharing's words. A refusal names what most often causes it
 * on a share, and the offline sentence wins over a store's own, because a share is always read
 * from the cloud.
 */
export function sharingErrorSentence(error: unknown): string {
  switch (cloudCode(error)) {
    case "permission-denied":
      return "The cloud refused that. Your role in the team may not allow it, or the share has ended or was revoked.";
    case "unavailable":
      return OFFLINE;
    case "no-key":
      return KEY_ERRORS.noKey;
    case "tampered":
      return KEY_ERRORS.tampered;
    case "key-changed":
      return ownSentence(error) ?? "A team's key is not the one this computer saw before. Compare its safety code with that team before sharing.";
    default:
      return cloudErrorSentence(error, { signedOut: "Sign in to share." });
  }
}

/** Why a share to a number that now leads to another team was refused, as the UI shows it. */
function numberChangedSentence(teamNumber: number): string {
  return `Team number ${String(teamNumber)} now leads to a different team from the one this device shared with before. Compare both teams' safety codes before sharing with it.`;
}

/**
 * Why a share to a team this user is a member of is not made when the key it shows is not the one
 * this device holds for it, as the UI shows it. No answer in the share dialog accepts that key.
 */
function memberKeyDiffersSentence(teamNumber: number): string {
  const team = `Team ${String(teamNumber)}`;
  return `${team} shows a key that is not the one this device holds for it. You are a member of that team, so this device holds its real key, and the key shown may be the server's own. Nothing was sent. Compare the safety code on that team's page with a teammate.`;
}

/** Why a share to a number that no team has claimed is not made, as the UI shows it. */
function noTeamSentence(teamNumber: number): string {
  return `No team on Zenith has claimed number ${String(teamNumber)}, so there is nobody to share with. Check the number, or ask that team to create its team in Zenith first.`;
}

/** "team 12345" or "teams 12345, 23456", for the sentences about one share. */
const teamsPhrase = (numbers: readonly number[]): string => `${numbers.length === 1 ? "team" : "teams"} ${numbers.join(", ")}`;

const iso = (at: Date): string => at.toISOString();

/** Runs one call and turns any failure into a sentence. */
async function guard<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw new Error(sharingErrorSentence(error), { cause: error });
  }
}

export interface CloudSharingApi extends SharingApi {
  readonly backend: CloudBackend;
}

export interface CloudSharingOptions {
  /** The device clock in epoch milliseconds, for "has this share ended". Tests pass a fixed one. */
  now?: () => number;
  /**
   * Told how a share that waited for the connection went, once it is back: the sentence to show,
   * and whether the share was made.
   */
  onPendingResult?: (result: PendingShareResult) => void;
  /**
   * Whether the page is online as well as the backend (the account's `online`). A share written
   * while either says offline waits in the Outbox, and the dialog says so.
   */
  online?: () => boolean;
}


/** The shares waiting on this page for the connection, per backend, so a new session keeps them. */
interface PendingShares {
  items: Array<{ waitingId: string; teamId: string; request: ShareRequest; options: CreateShareOptions }>;
  flushing: boolean;
  report: ((result: PendingShareResult) => void) | null;
}
const pendingByBackend = new WeakMap<CloudBackend, PendingShares>();
let pendingCount = 0;

/** True for a failure that means the server could not be reached. */
const unreachable = (error: unknown): boolean => cloudCode(error) === "unavailable";

export function createCloudSharingApi(backend: CloudBackend, options: CloudSharingOptions = {}): CloudSharingApi {
  const now = options.now ?? (() => Date.now());
  const teams = teamReader(backend);
  let pending = pendingByBackend.get(backend);
  if (pending === undefined) {
    const made: PendingShares = { items: [], flushing: false, report: null };
    pending = made;
    pendingByBackend.set(backend, made);
    backend.onOutboxChange((status) => {
      if (status.online && made.items.length > 0) void flushPending(made);
    });
  }
  if (options.onPendingResult !== undefined) pending.report = options.onPendingResult;

  /** Waits for the server while online, so a refusal is reported here; offline, the outbox has it. */
  async function settle<T>(queued: Queued<T>): Promise<T> {
    return (await settleReporting(queued)).value;
  }

  /** `settle`, also saying whether the write was left in the outbox instead of waited for. */
  async function settleReporting<T>(queued: Queued<T>): Promise<{ value: T; inOutbox: boolean }> {
    if (!backend.isOnline() || options.online?.() === false) return { value: queued.value, inOutbox: true };
    await queued.sent;
    return { value: queued.value, inOutbox: false };
  }

  async function teamById(teamId: string): Promise<Team | null> {
    return teamOrNull(await teams.read(teamId));
  }

  /**
   * The team and key whose safety code the dialog showed for `number`, as the answer carries them
   * back. An answer about a number counts only for that team and that key.
   */
  const shownFor = (createOptions: CreateShareOptions, number: number): ShownKey | undefined => createOptions.shownKeys?.[number];

  /**
   * The numbers the person answered a question about, a first share or a number that changed, each
   * with the team and key it was shown. An answer that names no key it was about counts for nothing.
   */
  const answeredNumbers = (createOptions: CreateShareOptions): Set<number> =>
    new Set(
      [...(createOptions.safetyCodesSeen ?? []), ...(createOptions.acceptNumberChanges ?? [])].filter(
        (number) => shownFor(createOptions, number) !== undefined,
      ),
    );

  /**
   * The team ids for the FTC numbers a share names, or a sentence naming the first that is not one.
   * A number that leads to another team than the one this device shared with under it stops here,
   * unless the person chose that team after comparing both safety codes (`acceptNumberChanges`). A
   * number that leads to another team than the one the dialog just showed stops here too.
   */
  async function teamIdsFor(ownTeamId: string, numbers: readonly number[], createOptions: CreateShareOptions = {}): Promise<string[]> {
    const answered = answeredNumbers(createOptions);
    const ids: string[] = [];
    for (const number of numbers) {
      const team = await backend.findTeamByNumber(number);
      if (team === null) throw new Error(noTeamSentence(number));
      if (team.id === ownTeamId) throw new Error("That is your own team, which already sees this auto.");
      const shown = shownFor(createOptions, number)?.teamId;
      if (answered.has(number) && shown !== undefined && shown !== team.id) {
        throw new Error(
          `Team number ${String(number)} led to a different team a moment ago, so nothing was sent. Share again to see the team it leads to now.`,
        );
      }
      const pin = backend.teamNumberPin(number);
      const chosen = (createOptions.acceptNumberChanges ?? []).includes(number) && shown === team.id;
      if (pin !== null && pin.teamId !== team.id && !chosen) throw new Error(numberChangedSentence(number));
      teams.remember(team);
      ids.push(team.id);
    }
    return ids;
  }

  /**
   * Refuses a share that names a number whose safety code this device has not shown for the team it
   * leads to: neither answered in this send, about that team, nor recorded as seen for that team by
   * an earlier share. The share dialog shows the code of every such number before it sends, so this
   * is met only when the team the send found is not the one the dialog's check found, for example
   * when the server said no team held the number to the check and pointed it at a team of its own
   * for the send. The dialog checks again when it meets this refusal (`needsSafetyCodeShown`).
   */
  function refuseUnseen(request: ShareRequest, teamIds: readonly string[], createOptions: CreateShareOptions): void {
    const answered = new Set([...answeredNumbers(createOptions), ...(createOptions.acceptKeyChanges ?? [])]);
    const unseen = request.teamNumbers.filter((number, index) => {
      const id = teamIds[index];
      if (answered.has(number) && shownFor(createOptions, number)?.teamId === id) return false;
      const pin = backend.teamNumberPin(number);
      return !(pin !== null && pin.seen && pin.teamId === id);
    });
    if (unseen.length === 0) return;
    const one = unseen.length === 1;
    throw new SafetyCodeNotShownError(
      `Did not share with ${teamsPhrase(request.teamNumbers)}: this device has not shown you ${one ? "that team's" : "those teams'"} safety code yet. Share again to see it, and compare it with ${one ? "that team" : "those teams"}.`,
      unseen,
    );
  }

  /**
   * Pins each number of a share to the team it was made to, once the share is made. A number whose
   * safety code the person saw now, or whose new team they chose, records that they saw it, when the
   * code the dialog showed was that team's.
   */
  function pinNumbers(request: ShareRequest, teamIds: readonly string[], createOptions: CreateShareOptions): void {
    const answered = answeredNumbers(createOptions);
    request.teamNumbers.forEach((number, index) => {
      const id = teamIds[index];
      if (id === undefined) return;
      backend.pinTeamNumber(number, id, { safetyCodeSeen: answered.has(number) && shownFor(createOptions, number)?.teamId === id });
    });
  }

  async function toShare(share: CloudShare): Promise<Share> {
    const numbers: number[] = [];
    const statuses: Partial<Record<number, TeamStatus>> = {};
    let deleted = 0;
    for (const teamId of share.teamIds) {
      const team = await teams.read(teamId);
      if (team === "deleted") deleted += 1;
      if (team === null || team === "deleted" || team.number === null) continue;
      numbers.push(team.number);
      statuses[team.number] = team.status;
    }
    const gone: Pick<Share, "deletedTeams" | "everyTeamDeleted"> =
      deleted === 0 ? {} : deleted === share.teamIds.length ? { deletedTeams: deleted, everyTeamDeleted: true } : { deletedTeams: deleted };
    return {
      ...gone,
      id: share.id,
      autoId: share.autoId,
      audience: share.audience,
      teamNumbers: numbers,
      teamStatuses: statuses,
      level: share.level,
      mode: share.mode,
      revision: revisionNumber(share.revision),
      revisionId: share.revision,
      projection: share.projection,
      ...(share.linkSecret === undefined ? {} : { linkSecret: share.linkSecret }),
      ...choiceOf(share),
      expiresAt: iso(share.expiresAt),
      revokedAt: share.revokedAt === null ? null : iso(share.revokedAt),
      createdAt: iso(share.createdAt),
      createdBy: share.createdBy,
    };
  }

  /**
   * A stopped share as the Sharing page lists it. A team it names that has no number, or was deleted,
   * cannot be named by a new share, so it is counted instead.
   */
  async function toStopped(share: CloudStoppedShare): Promise<StoppedShare> {
    const numbers: number[] = [];
    for (const teamId of share.teamIds) {
      const team = await teams.read(teamId);
      if (team !== null && team !== "deleted" && team.number !== null) numbers.push(team.number);
    }
    const unnamed = share.teamIds.length - numbers.length;
    return {
      id: share.id,
      autoId: share.autoId,
      audience: share.audience,
      teamNumbers: numbers,
      ...(unnamed === 0 ? {} : { unnamedTeams: unnamed }),
      level: share.level,
      mode: share.mode,
      revision: revisionNumber(share.revision),
      revisionId: share.revision,
      expiresAt: iso(share.expiresAt),
      createdAt: iso(share.createdAt),
      reason: share.reason,
    };
  }

  /**
   * Whether the team a received share is from is the team this device pinned under the number it
   * claims, or, with no pin yet, that team's safety code to compare. A team with no number claims
   * the number its name reads as, if any, and is otherwise always shown with its safety code, since
   * nothing else says who it is. Nothing when the team cannot be read, or nobody is signed in to hold
   * pins.
   */
  async function fromTeamCheck(ownerTeamId: string, from: Team | null): Promise<FromTeamCheck | undefined> {
    if (from === null || backend.currentUser() === null) return undefined;
    const claimed = from.number ?? numberInTeamName(from.name);
    const pin = claimed === null ? null : backend.teamNumberPin(claimed);
    if (pin !== null && pin.teamId !== ownerTeamId) return { kind: "mismatch" };
    if (from.number === null) return { kind: "no-number", ...(await safetyCodeOf(ownerTeamId)) };
    if (pin !== null) return { kind: "known" };
    return { kind: "first-use", ...(await safetyCodeOf(ownerTeamId)) };
  }

  /**
   * The team's safety code as this device knows it, or null when it cannot be read now, with
   * `keyReplaced` when the team replaced its key since this device first met it.
   */
  async function safetyCodeOf(teamId: string): Promise<{ safetyCode: string | null; keyReplaced?: true }> {
    try {
      const known = await backend.teamSafetyCode(teamId);
      return known.keyReplaced === true ? { safetyCode: known.safetyCode, keyReplaced: true } : { safetyCode: known.safetyCode };
    } catch (error) {
      if (unreachable(error)) throw error;
      return { safetyCode: null };
    }
  }

  async function toReceived(share: CloudShare): Promise<ReceivedShare> {
    const from = await teamById(share.ownerTeamId);
    const check = await fromTeamCheck(share.ownerTeamId, from);
    return {
      id: share.id,
      audience: share.audience,
      fromTeamNumber: from?.number ?? null,
      fromTeamName: from?.name ?? null,
      fromTeamStatus: from?.status ?? null,
      fromTeamId: share.ownerTeamId,
      ...(check === undefined ? {} : { fromTeamCheck: check }),
      teamIds: [...share.teamIds],
      level: share.level,
      mode: share.mode,
      revision: revisionNumber(share.revision),
      revisionId: share.revision,
      expiresAt: iso(share.expiresAt),
      updatedAt: iso(share.updatedAt),
      projection: share.projection,
    };
  }

  /** A share waiting for its team to sign it again: who it is from, named and checked as for a received share. */
  async function toWaiting(share: CloudWaitingShare): Promise<WaitingShare> {
    const from = await teamById(share.ownerTeamId);
    const check = await fromTeamCheck(share.ownerTeamId, from);
    return {
      id: share.id,
      fromTeamId: share.ownerTeamId,
      fromTeamNumber: from?.number ?? null,
      fromTeamName: from?.name ?? null,
      fromTeamStatus: from?.status ?? null,
      ...(check === undefined ? {} : { fromTeamCheck: check }),
    };
  }

  const toInvite = (invite: CloudInvite): Invite => ({
    code: invite.code,
    role: invite.role,
    expiresAt: iso(invite.expiresAt),
    maxUses: invite.maxUses,
    uses: invite.uses,
    autoApprove: invite.autoApprove,
    revoked: invite.revoked,
  });

  /** A share as it stands after a write, read back from the backend (its cache while offline). */
  async function reread(id: string): Promise<Share> {
    const share = await backend.getShare(id);
    if (share === null) throw new Error("That share no longer exists, or you cannot open it.");
    return toShare(share);
  }

  const isLive = (share: CloudShare): boolean =>
    share.revokedAt === null && share.expiresAt.getTime() > now();

  /**
   * Makes the share with the team ids found. Each team the person answered a warning about must
   * still show the key that warning showed (`expectedKeys`), and a changed key they accepted is
   * trusted only as that key. Online, where the team ids just came from the server, a number whose
   * safety code this device never showed for that team stops the share (`refuseUnseen`), so no
   * team's key is trusted on first use without its code shown.
   */
  async function makeShare(teamId: string, request: ShareRequest, teamIds: string[], createOptions: CreateShareOptions): Promise<Share> {
    if (request.audience === "teams" && backend.isOnline()) refuseUnseen(request, teamIds, createOptions);
    const accept: string[] = [];
    const expectedKeys: Record<string, string> = {};
    const answered = new Set([...answeredNumbers(createOptions), ...(createOptions.acceptKeyChanges ?? [])]);
    request.teamNumbers.forEach((number, index) => {
      const id = teamIds[index];
      const shown = shownFor(createOptions, number);
      if (id === undefined || shown === undefined || shown.teamId !== id || !answered.has(number)) return;
      expectedKeys[id] = shown.keyId;
      if ((createOptions.acceptKeyChanges ?? []).includes(number)) accept.push(id);
    });
    const write = await backend.createShare({
      teamId,
      autoId: request.autoId,
      revision: request.revisionId,
      audience: request.audience,
      teamIds,
      level: request.level,
      mode: request.mode,
      expiresAt: new Date(request.expiresAt ?? now()),
      projection: request.projection,
      ...(request.choice === undefined ? {} : { ownerChoice: encodeSharerChoice(request.choice) }),
      ...(accept.length === 0 ? {} : { acceptKeyChanges: accept }),
      ...(Object.keys(expectedKeys).length === 0 ? {} : { expectedKeys }),
    });
    const { value: created, inOutbox } = await settleReporting(write);
    pinNumbers(request, teamIds, createOptions);
    const share = await toShare(created);
    // A share left in the Outbox, offline when the create finished, waits there; the dialog says
    // the other team cannot see it yet, and follows its Outbox entry to say how it went.
    return inOutbox ? { ...share, queued: true, outboxId: write.outboxId } : share;
  }

  /**
   * The name and safety code of the team a number led to before, for the warning that it changed.
   * The code is of the key this device pinned for that team, whatever key the server shows for it now.
   */
  async function previousTeam(teamId: string): Promise<{ previousTeamName: string | null; previousSafetyCode: string | null }> {
    const name = (await teamById(teamId))?.name ?? null;
    try {
      return { previousTeamName: name, previousSafetyCode: (await backend.teamSafetyCode(teamId)).safetyCode };
    } catch (error) {
      if (unreachable(error)) throw error;
      // The team was deleted, or its key cannot be read: the warning says so instead of a code.
      return { previousTeamName: name, previousSafetyCode: null };
    }
  }

  /** Holds a share to teams not looked up yet until the connection is back. */
  function waitForConnection(teamId: string, request: ShareRequest, createOptions: CreateShareOptions): Share {
    pendingCount += 1;
    const waitingId = `waiting-${String(pendingCount)}`;
    pending?.items.push({ waitingId, teamId, request, options: createOptions });
    return {
      id: waitingId,
      autoId: request.autoId,
      audience: request.audience,
      teamNumbers: [...request.teamNumbers],
      level: request.level,
      mode: request.mode,
      revision: request.revision,
      revisionId: request.revisionId,
      projection: request.projection,
      ...(request.choice === undefined ? {} : { choice: request.choice }),
      expiresAt: request.expiresAt,
      revokedAt: null,
      createdAt: iso(new Date(now())),
      createdBy: backend.currentUser()?.uid ?? "",
      queued: true,
      waitsForConnection: true,
    };
  }

  /**
   * Makes each share that waited, once the connection is back. A team that turns out not to exist,
   * whose key changed, whose number now leads to another team, or whose safety code this device
   * never showed, stops that share, and the person is told; nothing is sent to it.
   */
  async function flushPending(queue: PendingShares): Promise<void> {
    if (queue.flushing) return;
    queue.flushing = true;
    try {
      while (queue.items.length > 0 && backend.isOnline()) {
        const item = queue.items.shift();
        if (item === undefined) break;
        const who = teamsPhrase(item.request.teamNumbers);
        try {
          const teamIds = await teamIdsFor(item.teamId, item.request.teamNumbers, item.options);
          refuseUnseen(item.request, teamIds, item.options);
          const accepted = new Set(item.options.acceptKeyChanges ?? []);
          const checks = await backend.checkPartnerKeys(teamIds);
          const notTheTeams = checks.find((check) => check.status === "member-key-differs");
          if (notTheTeams !== undefined) {
            const number = item.request.teamNumbers[teamIds.indexOf(notTheTeams.teamId)] ?? 0;
            throw new Error(`Did not share with ${who}: ${memberKeyDiffersSentence(number)}`);
          }
          const changed = checks.filter((check) => check.status === "changed" || check.status === "older");
          const unaccepted = changed.filter((check) => !accepted.has(item.request.teamNumbers[teamIds.indexOf(check.teamId)] ?? -1));
          if (unaccepted.length > 0) {
            throw new Error(
              `Did not share with ${who}: a team's key is not the one this device saw before. Compare its safety code with that team, then share again.`,
            );
          }
          const made = await makeShare(item.teamId, item.request, teamIds, item.options);
          queue.report?.({ ok: true, sentence: `Back online: shared with ${who}.`, waitingId: item.waitingId, share: made });
        } catch (error) {
          if (unreachable(error)) {
            queue.items.unshift(item);
            break;
          }
          const sentence = error instanceof Error && error.message.startsWith("Did not share") ? error.message : `Did not share with ${who}: ${sharingErrorSentence(error)}`;
          queue.report?.({ ok: false, sentence, waitingId: item.waitingId });
        }
      }
    } finally {
      queue.flushing = false;
    }
  }

  return {
    backend,

    listShares: (teamId) =>
      guard(async () => {
        try {
          return await Promise.all((await backend.listTeamShares(teamId)).map((share) => toShare(share)));
        } catch (error) {
          // A device waiting for the team key cannot read the shares; the waiting screen says so.
          if (cloudCode(error) === "no-key") return [];
          throw error;
        }
      }),

    listStopped: (teamId) =>
      guard(async () => {
        try {
          return await Promise.all((await backend.listStoppedShares(teamId)).map((share) => toStopped(share)));
        } catch (error) {
          // A device waiting for the team key cannot tell which shares stopped; the waiting screen says so.
          if (cloudCode(error) === "no-key") return [];
          throw error;
        }
      }),

    checkPartnerKeys: (numbers) =>
      guard(async () => {
        const ids: Array<{ number: number; id: string }> = [];
        for (const number of numbers) {
          let team: Team | null;
          try {
            team = await backend.findTeamByNumber(number);
          } catch (error) {
            // Offline and never looked up: the share waits, and once online it is refused unless
            // this device showed the team's code before, so the person shares again to see it.
            if (unreachable(error) && !backend.isOnline()) continue;
            throw error;
          }
          // Said here, not skipped: a share the dialog then sent would find a team the dialog never
          // showed the code of, and be refused for it.
          if (team === null) throw new Error(noTeamSentence(number));
          teams.remember(team);
          ids.push({ number, id: team.id });
        }
        if (ids.length === 0) return [];
        const checks = await backend.checkPartnerKeys(ids.map((entry) => entry.id));
        const warnings: PartnerKeyWarning[] = [];
        for (const [index, { number, id }] of ids.entries()) {
          const check = checks[index];
          if (check === undefined || check.teamId !== id) continue;
          // Not a warning to answer: this device holds that team's real key, and the key shown is not it.
          if (check.status === "member-key-differs") throw new Error(memberKeyDiffersSentence(number));
          const teamName = (await teamById(id))?.name ?? null;
          const named = { teamNumber: number, teamName, safetyCode: check.safetyCode, teamId: id, keyId: check.keyId };
          // A verified claim is checked the same way: the server writes its status too.
          const pin = backend.teamNumberPin(number);
          const numberChanged = pin !== null && pin.teamId !== id;
          if (numberChanged) warnings.push({ kind: "number-changed", ...named, ...(await previousTeam(pin.teamId)) });
          if (check.status === "changed" || check.status === "older") warnings.push({ kind: "key-changed", ...named });
          else if (!numberChanged && (pin === null || !pin.seen || check.status === "first-use")) warnings.push({ kind: "first-use", ...named });
        }
        return warnings;
      }),

    createShare: (teamId, request, createOptions = {}) =>
      guard(async () => {
        if (request.audience === "teams") {
          const problem = teamLimitProblem(request.teamNumbers.length);
          if (problem !== null) throw new Error(problem);
          if (request.teamNumbers.length === 0) throw new Error("Add at least one team number first.");
        }
        if (request.expiresAt === null) throw new Error("A share needs a date it ends. Pick one.");
        let teamIds: string[] = [];
        if (request.audience === "teams") {
          try {
            teamIds = await teamIdsFor(teamId, request.teamNumbers, createOptions);
          } catch (error) {
            if (!unreachable(error) || backend.isOnline()) throw error;
            // Offline, with a team this device never looked up: the share waits on this page.
            return waitForConnection(teamId, request, createOptions);
          }
        }
        return makeShare(teamId, request, teamIds, createOptions);
      }),

    extendShare: (id, expiresAt) =>
      guard(async () => {
        if (expiresAt === null) throw new Error("A share needs a date it ends. Pick one.");
        await settle(await backend.extendShare(id, new Date(expiresAt)));
        return reread(id);
      }),

    setLevel: (id, level) =>
      guard(async () => {
        await settle(await backend.setShareLevel(id, level));
        return reread(id);
      }),

    setMode: (id, mode) =>
      guard(async () => {
        await settle(await backend.setShareMode(id, mode));
        return reread(id);
      }),

    revokeShare: (id) =>
      guard(async () => {
        await settle(await backend.revokeShare(id));
      }),

    updateShare: (id, input) =>
      guard(async () => {
        if (input.projection.length === 0) throw new Error("A share needs a projection to show.");
        await settle(await backend.updateShare(id, { revision: input.revisionId, projection: input.projection }));
        return reread(id);
      }),

    listInvites: (teamId) =>
      guard(async () => {
        try {
          return (await backend.listInvites(teamId)).map(toInvite);
        } catch (error) {
          // Only owners and admins read the team's invites; for everyone else there are none to show.
          if (cloudCode(error) === "permission-denied") return [];
          throw error;
        }
      }),

    extendInvite: (code, expiresAt) =>
      guard(async () => {
        await settle(await backend.extendInvite(code, new Date(expiresAt)));
        const invite = await backend.getInvite(code);
        if (invite === null) throw new Error("That invite no longer exists.");
        return toInvite(invite);
      }),

    revokeInvite: (code) =>
      guard(async () => {
        await settle(await backend.revokeInvite(code));
      }),

    listReceived: (teamId) =>
      guard(async () => {
        try {
          return await Promise.all((await backend.listReceivedShares(teamId)).map((share) => toReceived(share)));
        } catch (error) {
          if (cloudCode(error) === "no-key") return [];
          throw error;
        }
      }),

    listWaiting: (teamId) =>
      guard(async () => {
        try {
          return await Promise.all((await backend.listWaitingShares(teamId)).map((share) => toWaiting(share)));
        } catch (error) {
          if (cloudCode(error) === "no-key") return [];
          throw error;
        }
      }),

    openShare: (id) =>
      guard(async () => {
        const share = await backend.getShare(id);
        return share === null || !isLive(share) ? null : toReceived(share);
      }),

    openLink: (secret) =>
      guard(async () => {
        const share = await backend.openLinkShare(secret);
        return share === null || !isLive(share) ? null : { ...(await toReceived(share)), linkSecret: secret };
      }),

    revisionFiles: (teamId, autoId, revisionId) =>
      guard(async () => {
        const revision = await backend.openRevision(teamId, autoId, revisionId);
        if (revision === null) return null;
        const files: RevisionFiles = { content: revision.content };
        if (revision.robot !== undefined) files.robot = revision.robot;
        if (revision.field !== undefined) files.field = revision.field;
        if (revision.waypoints !== undefined) files.waypoints = revision.waypoints;
        return files;
      }),
  };
}
