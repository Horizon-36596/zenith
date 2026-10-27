/**
 * The sharing UI's state (spec 13 section 8): the cloud session, the
 * team's shares and invites, the shares it has received, and which sharing sheet is open. A small
 * observable store beside the editor's, so the editor's state and its tests stay as they were.
 *
 * There is one sign-in. The account session (`account/wiring.ts`) hands this store the adapter over
 * its own `CloudBackend` with `setSharingBackend`, and the session it is signed in to; until it does,
 * and whenever nobody is signed in with a team, the session is signed out and every request says
 * "Sign in to share.". With `?cloud=fake` both run on the account's one in-memory backend.
 */
import { useSyncExternalStore } from "react";
import { effectiveShareLevel, isShareActive } from "@horizon36596/zenith-core";
import { needsSafetyCodeShown } from "./keyAnswers";
import { rebuildChoice, type ProjectionChoice } from "./projectionModel";
import { revisionProjector, type ProjectFiles } from "./revisionProjection";
import { SharedAgain } from "./stoppedSharesModel";
import { browserStorage } from "../account/storage";
import type {
  CreateShareOptions,
  Invite,
  Level,
  Mode,
  PartnerKeyWarning,
  PendingShareResult,
  ReceivedShare,
  RevisionFiles,
  Share,
  ShareRequest,
  SharingApi,
  StoppedShare,
  WaitingShare,
} from "./types";
import { clearStaleStatus, getState as getEditor, setStatus } from "../state/store";

/** Who is signed in to the cloud, and for which team. */
export interface CloudSession {
  signedIn: boolean;
  /** The team whose library and shares are shown; null when signed out. */
  teamId: string | null;
  teamNumber: number | null;
  teamName: string | null;
}

/**
 * Which non-modal sharing sheet is open: the share dialog, the Sharing page, the read-only viewer
 * of a received share (section 9, with no project open), or none.
 */
export type SharingSheet = "share" | "sharing" | "viewer" | null;

export interface CloudState {
  session: CloudSession;
  shares: Share[];
  /**
   * The team's shares that stopped when its key changed, as the cloud lists them, newest first.
   * The Sharing page lists those not shared again (`stoppedToList`).
   */
  stopped: StoppedShare[];
  /** The ids of stopped shares this device shared again, for the session's team. */
  sharedAgain: ReadonlySet<string>;
  /** The stopped share the share dialog was opened to share again, or null. */
  shareAgain: StoppedShare | null;
  invites: Invite[];
  /** The live shares made to the session's team, newest change first. */
  received: ReceivedShare[];
  /** The live shares made to the session's team that wait for their team to sign them with its newer key. */
  waiting: WaitingShare[];
  /** The share the read-only viewer shows, while `sheet` is "viewer". */
  viewing: ReceivedShare | null;
  sheet: SharingSheet;
  /**
   * The team library auto the Sharing page is narrowed to ("Showing shares of …"), or null for
   * every share and invite. The library's sharing chip opens the page on its own auto.
   */
  sharingAutoId: string | null;
  /** True while a request is in flight, so buttons do not send it twice. */
  busy: boolean;
  /** The last request's failure, as a sentence, until the next request. */
  error: string | null;
  /**
   * How each share that waited on this page for the connection went, by the id the dialog was
   * given for it, so the open share dialog can say so instead of still saying it waits.
   */
  pendingShares: Readonly<Record<string, PendingShareResult>>;
}

export const SIGNED_OUT: CloudSession = { signedIn: false, teamId: null, teamNumber: null, teamName: null };

const SIGN_IN = "Sign in to share.";

/** The backend before the account session has one: every call says to sign in. */
const signedOutApi: SharingApi = {
  listShares: () => Promise.reject(new Error(SIGN_IN)),
  listStopped: () => Promise.reject(new Error(SIGN_IN)),
  checkPartnerKeys: () => Promise.reject(new Error(SIGN_IN)),
  createShare: () => Promise.reject(new Error(SIGN_IN)),
  extendShare: () => Promise.reject(new Error(SIGN_IN)),
  setLevel: () => Promise.reject(new Error(SIGN_IN)),
  setMode: () => Promise.reject(new Error(SIGN_IN)),
  revokeShare: () => Promise.reject(new Error(SIGN_IN)),
  updateShare: () => Promise.reject(new Error(SIGN_IN)),
  listInvites: () => Promise.reject(new Error(SIGN_IN)),
  extendInvite: () => Promise.reject(new Error(SIGN_IN)),
  revokeInvite: () => Promise.reject(new Error(SIGN_IN)),
  listReceived: () => Promise.reject(new Error(SIGN_IN)),
  listWaiting: () => Promise.reject(new Error(SIGN_IN)),
  openShare: () => Promise.reject(new Error("The cloud is not set up on this page, so a share cannot be opened here.")),
  openLink: () => Promise.reject(new Error("The cloud is not set up on this page, so a share link cannot be opened here.")),
  revisionFiles: () => Promise.reject(new Error(SIGN_IN)),
};

let api: SharingApi = signedOutApi;
let clock: () => number = () => Date.now();
let sharedAgainStore = new SharedAgain(browserStorage());

let state: CloudState = {
  session: SIGNED_OUT,
  shares: [],
  stopped: [],
  sharedAgain: new Set(),
  shareAgain: null,
  invites: [],
  received: [],
  waiting: [],
  viewing: null,
  sheet: null,
  sharingAutoId: null,
  busy: false,
  error: null,
  pendingShares: {},
};

const listeners = new Set<() => void>();

function set(patch: Partial<CloudState>): void {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

export const getCloud = (): CloudState => state;

export function subscribeCloud(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export const useCloud = (): CloudState => useSyncExternalStore(subscribeCloud, getCloud, getCloud);

/** The time the sharing UI reads, in epoch milliseconds. */
export const cloudNow = (): number => clock();

/**
 * Replaces the backend and the session: how the account session comes in (`account/wiring.ts`), and
 * how tests start from a known state. Clears the cached lists; the viewer stays open, because a
 * share opened by its link does not depend on who is signed in.
 */
export function setSharingBackend(
  next: SharingApi,
  session: CloudSession,
  options: { now?: () => number; storage?: SharedAgain } = {},
): void {
  api = next;
  if (options.now !== undefined) clock = options.now;
  if (options.storage !== undefined) sharedAgainStore = options.storage;
  const sheet = state.sheet === "viewer" ? "viewer" : session.signedIn ? state.sheet : null;
  const sharedAgain = session.teamId === null ? new Set<string>() : sharedAgainStore.ids(session.teamId);
  set({ session, shares: [], stopped: [], sharedAgain, shareAgain: null, invites: [], received: [], waiting: [], sheet, sharingAutoId: null, busy: false, error: null });
  if (session.signedIn) {
    void refreshSharing();
    void refreshReceived();
  }
}

export const isSignedIn = (): boolean => state.session.signedIn;

/** Why sharing is unavailable, or null when it is available. */
export function sharingBlockedReason(hasAuto: boolean): string | null {
  if (!state.session.signedIn) return SIGN_IN;
  if (!hasAuto) return "Open an auto first.";
  return null;
}

/**
 * Opens the share dialog or the Sharing page. `autoId` narrows the Sharing page to the shares of one
 * team library auto; without it the page lists every share and invite.
 */
export function openSharingSheet(sheet: Exclude<SharingSheet, null | "viewer">, options: { autoId?: string | null } = {}): void {
  set({ sheet, sharingAutoId: sheet === "sharing" ? (options.autoId ?? null) : null, shareAgain: null, error: null });
  clearStaleStatus();
  if (state.session.signedIn) void refreshSharing();
}

/**
 * "Share again" on a stopped share: opens the share dialog with its audience, teams, level, version
 * mode and end, for the person to check and send as any share, safety codes included.
 */
export function openShareAgain(stopped: StoppedShare): void {
  set({ sheet: "share", sharingAutoId: null, shareAgain: stopped, error: null });
  if (state.session.signedIn) void refreshSharing();
}

export function closeSharingSheet(): void {
  set({ sheet: null, viewing: null, sharingAutoId: null, shareAgain: null, error: null });
}

/** "Show all" on a Sharing page narrowed to one auto: every share and invite again. */
export function showAllShares(): void {
  set({ sharingAutoId: null });
}

/** Opens the read-only viewer on a received share (section 9: the partner's auto alone). */
export function openShareViewer(share: ReceivedShare): void {
  set({ sheet: "viewer", viewing: share, error: null });
}

/**
 * Runs one request, keeping `busy` and `error` honest, and refreshes the lists after it. A request
 * that went through returns its result even when the lists cannot be read again afterwards: that
 * failure is the store's error, but reporting the change itself as failed would invite a retry that
 * makes it twice.
 */
async function request<T>(work: (teamId: string) => Promise<T>, done?: string): Promise<T | null> {
  const teamId = state.session.teamId;
  if (!state.session.signedIn || teamId === null) {
    set({ error: SIGN_IN });
    return null;
  }
  set({ busy: true, error: null });
  let result: T;
  try {
    result = await work(teamId);
  } catch (error) {
    set({ busy: false, error: messageOf(error) });
    return null;
  }
  if (done !== undefined) setStatus("ok", done);
  try {
    const [shares, invites, stopped] = await Promise.all([api.listShares(teamId), api.listInvites(teamId), stoppedOrNone(teamId)]);
    // A session that changed while the request was out keeps its own lists.
    if (state.session.teamId === teamId) set({ shares, invites, stopped, busy: false });
  } catch (error) {
    set({ busy: false, error: messageOf(error) });
  }
  return result;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The team's stopped shares, or none when they cannot be read: the notice about them is an extra,
 * and a failure to read it should not hide the shares and invites.
 */
async function stoppedOrNone(teamId: string): Promise<StoppedShare[]> {
  try {
    return await api.listStopped(teamId);
  } catch {
    return [];
  }
}

export async function refreshSharing(): Promise<void> {
  await request(() => Promise.resolve(undefined));
}

/**
 * Reads the shares made to the session's team, for the Partners panel, and those waiting for their
 * team to sign them again. The waiting ones are an extra: a failure to read them lists none.
 */
export async function refreshReceived(): Promise<void> {
  const teamId = state.session.teamId;
  if (!state.session.signedIn || teamId === null) return;
  try {
    const [received, waiting] = await Promise.all([api.listReceived(teamId), api.listWaiting(teamId).catch((): WaitingShare[] => [])]);
    if (state.session.teamId === teamId) set({ received, waiting });
  } catch (error) {
    set({ error: error instanceof Error ? error.message : String(error) });
  }
}

const openedListeners = new Set<(share: ReceivedShare) => void>();

/**
 * Calls `listener` with each share `openShareById` or `openShareByLink` opens, so the list of link shares opened on this
 * device (`keptSharesStore.ts`) can offer them again offline. Returns the unsubscribe.
 */
export function onShareOpened(listener: (share: ReceivedShare) => void): () => void {
  openedListeners.add(listener);
  return () => {
    openedListeners.delete(listener);
  };
}

/**
 * One share made to the signed-in team, by its id: how a kept share opens again. Resolves to the
 * share, or to the sentence saying why it cannot be opened.
 */
export function openShareById(id: string): Promise<{ ok: true; share: ReceivedShare } | { ok: false; why: string }> {
  return openShareWith(() => api.openShare(id));
}

/**
 * One anyone-with-the-link share by the secret in its link (section 8.5). Needs no sign-in.
 * Resolves to the share, or to the sentence saying why it cannot be opened.
 */
export function openShareByLink(secret: string): Promise<{ ok: true; share: ReceivedShare } | { ok: false; why: string }> {
  return openShareWith(() => api.openLink(secret));
}

async function openShareWith(read: () => Promise<ReceivedShare | null>): Promise<{ ok: true; share: ReceivedShare } | { ok: false; why: string }> {
  try {
    const share = await read();
    if (share !== null) {
      for (const listener of openedListeners) listener(share);
      return { ok: true, share };
    }
    return {
      ok: false,
      why: state.session.signedIn
        ? "That share has ended, was revoked, or was not shared with your team. Ask the team that sent it for a new link."
        : "That share has ended or was revoked, or it is for specific teams: sign in as a member of one of them to open it.",
    };
  } catch (error) {
    return { ok: false, why: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Makes a share. `done` is the status line afterwards; as a function it is given the share, whose
 * `queued` says whether it is still waiting in the Outbox, so the line can say so. `onCodeNotShown`
 * is called when the share was refused because it names a team whose safety code this device never
 * showed, so the dialog can check the teams again and show the code; the refusal's sentence is the
 * store's error either way.
 */
export async function createShare(
  share: ShareRequest,
  done: string | ((created: Share) => string),
  options: CreateShareOptions = {},
  onCodeNotShown?: () => void,
  sharesAgain?: string,
): Promise<Share | null> {
  const created = await request(async (teamId) => {
    let made: Share;
    try {
      made = await api.createShare(teamId, share, options);
    } catch (error) {
      if (needsSafetyCodeShown(error)) onCodeNotShown?.();
      throw error;
    }
    // The stopped share this one shares again is no longer listed, whatever was changed in the dialog.
    if (sharesAgain !== undefined) {
      sharedAgainStore.add(teamId, sharesAgain);
      set({ sharedAgain: sharedAgainStore.ids(teamId), shareAgain: null });
    }
    return made;
  });
  // A share still waiting on this computer has not reached anyone: the line informs, it does not say done.
  if (created !== null) setStatus(created.queued === true ? "info" : "ok", typeof done === "string" ? done : done(created));
  return created;
}

/**
 * A share that waited on this page for the connection was made, or was not: the status line says
 * so, and the share dialog that is still open reads it here (`pendingShares`).
 */
export function settlePendingShare(result: PendingShareResult): void {
  set({ pendingShares: { ...state.pendingShares, [result.waitingId]: result } });
  setStatus(result.ok ? "ok" : "error", result.sentence);
}

/**
 * The partner teams whose key changed, before a share to them is sent (spec 14 section 4.6), or the
 * sentence saying why the keys could not be checked, in which case nothing should be sent.
 */
export async function checkPartnerKeys(
  teamNumbers: readonly number[],
): Promise<{ ok: true; warnings: PartnerKeyWarning[] } | { ok: false; why: string }> {
  set({ busy: true, error: null });
  try {
    const warnings = await api.checkPartnerKeys(teamNumbers);
    set({ busy: false });
    return { ok: true, warnings };
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    set({ busy: false, error: why });
    return { ok: false, why };
  }
}

export const extendShare = (id: string, expiresAt: string | null, done: string): Promise<Share | null> =>
  request(() => api.extendShare(id, expiresAt), done);

/** The open project's robot and field, for a revision that was published without its own. */
function openProjectFiles(): ProjectFiles | null {
  const project = getEditor().project;
  return project === null ? null : { robot: project.robot, field: project.field, waypoints: project.waypoints };
}

/**
 * Changes a share's level, and rebuilds its projection at the new level from the revision it is
 * on, read back from the team library (spec 13 section 8.2: what a view share carries and what a
 * propose share carries differ), keeping its coarseness and whether it names its commands.
 *
 * The revision is the one the share's signed manifest names: the share is read again from the
 * cloud, which refuses a share whose plain revision is not the one its team signed, so a server
 * cannot point a pinned share at a revision that was never shared and have it rebuilt from that.
 * A share this page listed earlier may have been moved on since by another device, which is why
 * the list it holds is not used.
 *
 * The level and the projection are two writes, so they go in the order that never shows more than
 * the share's level allows while the second is on its way: going up to propose, the level first and
 * then the fuller projection; going down to view, the view projection first and then the level.
 */
export const setShareLevel = (id: string, level: Level, done: string): Promise<Share | null> =>
  request(async (teamId) => {
    const share = (await api.listShares(teamId)).find((entry) => entry.id === id);
    if (share === undefined) throw new Error("That share no longer exists.");
    const files = await api.revisionFiles(teamId, share.autoId, share.revisionId);
    if (files === null) {
      throw new Error(
        `Revision ${String(share.revision)} is no longer in the team library, so what they see cannot be rebuilt at the new level.`,
      );
    }
    const projector = revisionProjector(files, openProjectFiles(), share.revision);
    if (!projector.ok) throw new Error(projector.reason);
    const projection = projector.build(rebuildChoice(share, effectiveShareLevel({ audience: share.audience, level })));
    if (projection === null) {
      throw new Error(`Revision ${String(share.revision)} could not be projected at the new level.`);
    }
    const update = { revisionId: share.revisionId, projection };
    if (level === "propose") {
      await api.setLevel(id, level);
      return api.updateShare(id, update);
    }
    await api.updateShare(id, update);
    return api.setLevel(id, level);
  }, done);

export const setShareMode = (id: string, mode: Mode, done: string): Promise<Share | null> =>
  request(() => api.setMode(id, mode), done);

export const revokeShare = (id: string, done: string): Promise<void | null> =>
  request(() => api.revokeShare(id), done);

export const extendInvite = (code: string, expiresAt: string, done: string): Promise<Invite | null> =>
  request(() => api.extendInvite(code, expiresAt), done);

export const revokeInvite = (code: string, done: string): Promise<void | null> =>
  request(() => api.revokeInvite(code), done);

/**
 * Builds the projection for one share, at the choice that share needs, as canonical text; or null
 * when the auto cannot be projected just now (the reason is then the caller's to report).
 */
export type ProjectionBuilder = (choice: ProjectionChoice) => string | null;

/**
 * The follow-latest hook (spec 13 section 8.3): after library auto `autoId` is published as
 * revision `revisionId`, every live share of it that follows the latest version is moved to that
 * revision, with a projection rebuilt on this computer at the share's own level, coarseness and
 * choice of command names (the sharer's own choices, which the cloud keeps sealed for this team, by
 * `rebuildChoice`; never the projection the share carries, which the other team can open).
 * Pinned, revoked and ended shares are left alone; a share's end is the one its manifest signs, since
 * the cloud refuses to list a share whose plain end differs, and refuses to seal into one after it.
 * Resolves to how many shares were updated, or null when the request failed (the store's `error`
 * says why). `followLatest.ts` calls it from the team library's publish.
 */
export const publishFollowedShares = (
  autoId: string,
  revisionId: string,
  build: ProjectionBuilder,
  done?: string,
): Promise<number | null> =>
  request(async (teamId) => {
    const nowMs = clock();
    const followed = (await api.listShares(teamId)).filter(
      (share) => share.autoId === autoId && share.mode === "follow" && isShareActive(share, nowMs),
    );
    let updated = 0;
    for (const share of followed) {
      if (share.revisionId === revisionId) continue;
      const projection = build(rebuildChoice(share, effectiveShareLevel(share)));
      if (projection === null) continue;
      await api.updateShare(share.id, { revisionId, projection });
      updated += 1;
    }
    return updated;
  }, done);

/**
 * "Update share" on a pinned share whose auto has a newer revision in the team library (spec 13
 * section 8.3): rebuilds the projection from `revision` on this computer, with the share's own
 * level, coarseness and choice of command names, and moves the share to it. The revision's files
 * are the library's own, so what the share then shows is exactly that revision.
 */
export const updateShareToRevision = (
  id: string,
  revision: { id: string; n: number; files: RevisionFiles },
  done: string,
): Promise<Share | null> =>
  request(async (teamId) => {
    const share = state.shares.find((entry) => entry.id === id) ?? (await api.listShares(teamId)).find((entry) => entry.id === id);
    if (share === undefined) throw new Error("That share no longer exists.");
    const projector = revisionProjector(revision.files, openProjectFiles(), revision.n);
    if (!projector.ok) throw new Error(projector.reason);
    const projection = projector.build(rebuildChoice(share, effectiveShareLevel(share)));
    if (projection === null) throw new Error(`Revision ${String(revision.n)} could not be projected for this share.`);
    return api.updateShare(id, { revisionId: revision.id, projection });
  }, done);

/** The shares the Sharing page lists: every one, or those of the auto it is narrowed to. */
export function sharesOnPage(shares: readonly Share[], autoId: string | null): Share[] {
  return autoId === null ? [...shares] : shares.filter((share) => share.autoId === autoId);
}

/** The shares made from one auto, newest first. */
export function sharesOf(shares: readonly Share[], autoId: string | null): Share[] {
  if (autoId === null) return [];
  return shares.filter((share) => share.autoId === autoId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
