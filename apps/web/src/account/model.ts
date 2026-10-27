/**
 * The account, teams and team library state (spec 13 sections 4 to 6), as
 * one observable model over `CloudBackend`. It has no React and no DOM in it, so the whole flow runs
 * in node against `MemoryBackend` (account.test.ts); `store.ts` makes the page's one instance and
 * the components read it through `useAccount`.
 *
 * Only types come from `@horizon36596/zenith-cloud` here. The package itself, with the Firebase SDK,
 * is loaded by `backendFactory.ts` with a dynamic import, so a page with the cloud off never
 * downloads it.
 *
 * Writes go through the backend's outbox: each returns at once with the value as it stands on this
 * device, and the model never waits for the server before showing it (section 6). What a write
 * changed is read back from the backend, which answers from its cache while offline.
 */
import type {
  ActiveRole,
  ActivityEntry,
  AutoRecord,
  CloudBackend,
  CloudUser,
  DeleteAccountOptions,
  Invite,
  InviteRole,
  KeyRequest,
  Member,
  Membership,
  NativeCredential,
  OutboxStatus,
  Revision,
  Role,
  SignInProvider,
  TeamSettings,
  TeamDevice,
  TeamKeyStatus,
  TeamSettingsDoc,
  TeamStatus,
  UserDoc,
} from "@horizon36596/zenith-cloud";
import type { Project } from "../project/types";
import {
  chooseBase,
  findLibraryAuto,
  latestRevision,
  projectTexts,
  projectZipEntries,
  rememberBase,
  rememberedBase,
} from "../library/libraryModel";
import type { ZipEntry } from "../library/zip";
import { withoutClashes } from "../admin/fakeVerification";
import { OFFLINE, cloudErrorSentence } from "../cloud/errorSentence";
import { cloudErrorCode, isWrongCode } from "./keys/errors";
import type { CloudMode } from "./config";
import { expiresInSeconds, extendedMs, whyCannotCreateInvite, type InviteExpiryChoice } from "./invites";
import {
  isAdminRole,
  whyCannotDeleteTeam,
  whyCannotOpenLibrary,
  whyCannotPublish,
  whyCannotTransfer,
} from "./permissions";
import { KEYS, type DeviceStorage } from "./storage";
import { waitingChanges } from "./words";
import {
  accountSignInProvider,
  chooseSignInRoutes,
  POPUP_ROUTES,
  type DesktopSignInProgress,
  type NativeSignInPort,
  type SignInRoute,
} from "./nativeSignIn";

/**
 * Which account sheet is open. One at a time, docked at the right, never modal. The account itself
 * is a section of the Settings window, which is not a sheet.
 */
export type AccountPanel = "signIn" | "teams" | "library" | "outbox" | null;

/**
 * Where the sign-in sheet is. Someone signed out starts at the providers: there is no age screen
 * (owner ruling 2026-10-02); the Terms ask for 13 or older, or a school account the school approved.
 * `beta` is the private-beta screen: the account signed in but is not on the beta list, so it cannot
 * make a profile or join a team yet (owner ruling 2026-10-01, "Private beta allowlist").
 */
export type SignInStep = "providers" | "emailSent" | "emailConfirm" | "profile" | "join" | "beta";

export interface TeamView {
  teamId: string;
  members: Member[];
  /** Empty for members who are not owners or admins, who cannot read the invites. */
  invites: Invite[];
  settings: TeamSettings;
  /** Empty for members who are not owners or admins. */
  activity: ActivityEntry[];
}

export interface LibraryView {
  teamId: string | null;
  autos: AutoRecord[];
  /** Oldest first, by library auto id. */
  revisions: Record<string, Revision[]>;
  /** True once the library has been read; what was read stays when a later read fails. */
  loaded: boolean;
  /** Why the last read of the library failed, as a sentence, until a read succeeds. */
  readError: string | null;
}

/**
 * Where this device stands with the selected team's key (spec 14): ready, or waiting for a
 * teammate to approve it, and what the team page offers from there.
 */
export interface KeysView {
  teamId: string;
  /** Null until it is read, or when it could not be (`problem` says why). */
  status: TeamKeyStatus | null;
  /** While waiting: the approval code this device shows, for the approver to type. */
  approvalCode: string | null;
  /**
   * The devices waiting for the key that this viewer may approve: pending members' first devices
   * and members' new devices. Empty on a device that is itself waiting.
   */
  requests: KeyRequest[];
  /** The devices that hold the key: every one for owners and admins, otherwise the viewer's own. */
  devices: TeamDevice[];
  /** Why the key could not be read, as a plain sentence. */
  problem: string | null;
}

/** A recovery code to show once: a new team's, or one an owner just made to replace the old one. */
export interface NewRecoveryCode {
  teamId: string;
  code: string;
  /** When it was made, in epoch milliseconds; the sheet shows the date. */
  madeAtMs: number;
  /** True when it replaced an older code, which no longer works. */
  replacing: boolean;
}

export interface JoinView {
  code: string;
  invite: Invite | null;
  teamName: string | null;
  teamNumber: number | null;
  teamStatus: TeamStatus | null;
  /** Set once the invite was redeemed: the role the member now has. */
  joinedAs: Role | null;
  /** Why the invite cannot be used, as a sentence. */
  problem: string | null;
}

export interface AccountState {
  mode: CloudMode;
  /** True once the backend exists and the saved session, if any, has been read. */
  ready: boolean;
  user: CloudUser | null;
  profile: UserDoc | null;
  step: SignInStep;
  /**
   * Whether the signed-in account may make a profile and join teams during the private beta. Null
   * until it is asked, which happens only for an account with no profile yet, or after the cloud
   * refused a new profile or an invite. False shows the `beta` step.
   */
  betaAccess: boolean | null;
  /** The address the last sign-in link went to. */
  emailSentTo: string | null;
  /** The fake backend's link, which is shown instead of emailed. Null for the real service. */
  fakeLink: string | null;
  sharedComputer: boolean;
  memberships: Membership[];
  teamId: string | null;
  team: TeamView | null;
  /** Why the selected team could not be read, as a sentence, until a read of it succeeds. */
  teamReadError: string | null;
  /**
   * A team this device last saw the account in that the cloud no longer lists, and that this device
   * did not leave or delete (`lostTeams`): the Teams sheet names it in place of "not in a team yet".
   * Cleared when another team is chosen.
   */
  removedFrom: SeenTeam | null;
  /** The invite just made, so its link can be copied. */
  lastInvite: Invite | null;
  /**
   * The recovery code of the team just created on this device, or the one an owner just made in
   * place of the old one (spec 14): shown once on the Teams sheet (`RecoveryCodeSheet`), never
   * stored anywhere, and the only way back into the team if every member's devices are lost.
   * Cleared once the person continues, on sign-out, and by `dismissRecoveryCode`.
   */
  newRecoveryCode: NewRecoveryCode | null;
  /** The selected team's key on this device, or null before it is read. */
  keys: KeysView | null;
  /** The fake cloud only: which simulated device this page is, and how many there are. */
  fakeDevice: { index: number; count: number } | null;
  library: LibraryView;
  outbox: OutboxStatus | null;
  online: boolean;
  panel: AccountPanel;
  join: JoinView | null;
  busy: boolean;
  /** The last request's failure, as a sentence, until the next request. */
  error: string | null;
  /** The last request's success, as a sentence. */
  notice: string | null;
  /**
   * True after an owner removed a member, until the next request: the notice then offers a new
   * recovery code, since the member may have seen the old one.
   */
  suggestNewRecoveryCode: boolean;
  /** Whether the owner's New recovery code is asking to confirm, from its own button or the notice's. */
  askingNewRecoveryCode: boolean;
  /** How each provider signs in here: the popup, the desktop app's browser sign-in, or not at all. */
  signInRoutes: Record<SignInProvider, SignInRoute>;
  /** While a desktop sign-in waits on the browser: what to show, such as GitHub's code. */
  nativeProgress: DesktopSignInProgress | null;
}

export interface AccountDeps {
  mode: CloudMode;
  storage: DeviceStorage;
  /** Epoch milliseconds: the device clock, for expiry arithmetic and nothing else. */
  now: () => number;
  /** Makes the backend. The page's loads the cloud package lazily; tests hand in a MemoryBackend. */
  createBackend: (options: { persistence: boolean }) => Promise<CloudBackend>;
  /** The page's address, for the email link's return and the join links. */
  pageUrl: () => string;
  /** Whether the device reports a network connection (`navigator.onLine`). */
  deviceOnline?: () => boolean;
  /** Tells the person what happened, on the app's status line. */
  say?: (kind: "ok" | "info" | "error", message: string) => void;
  /**
   * Whether a sheet or Settings section that shows the account's last result (`Feedback`) is open
   * now. When none is, a failure goes to the status line too, so it is never silent: a publish from
   * the command palette or the share dialog, for one.
   */
  feedbackShown?: () => boolean;
  /**
   * The git commit a saved auto file came from, when the project knows it: a GitHub-mode save or a
   * desktop commit of exactly this text (spec 13 section 5.1). Null when it does not.
   */
  gitShaFor?: (fileName: string, canonical: string) => string | null;
  /**
   * Called once a revision is published, with the revision as this device wrote it: the
   * follow-latest hook (spec 13 section 8.3), which moves the shares that follow this auto.
   */
  onPublished?: (revision: Revision) => Promise<unknown>;
  /**
   * The desktop app's sign-in through the system browser (`window.zenithDesktop.cloudSignIn`), or
   * null in a browser. With the real cloud it replaces the popup, which the desktop app's page
   * cannot use (nativeSignIn.ts, ADR 0011).
   */
  nativeSignIn?: NativeSignInPort | null;
  /**
   * The fake cloud only: another simulated device on the same in-memory cloud, with keys of its
   * own, so one page can play a member's second device.
   */
  createFakeDevice?: (from: CloudBackend) => Promise<CloudBackend>;
}

const EMPTY_LIBRARY: LibraryView = { teamId: null, autos: [], revisions: {}, loaded: false, readError: null };

/**
 * A failure as the sentence the sheets show: the app's one cloud translator, which Sharing uses
 * too, so an offline or refused call reads the same on every screen.
 */
const message = (error: unknown): string => cloudErrorSentence(error);

/**
 * Why a read of `what` failed, ending with what to do, in `cloudErrorSentence`'s words: offline, the
 * sentence for a device with no saved copy, whatever the SDK threw; otherwise the call's own sentence.
 */
function readSentence(what: string, error: unknown, online: boolean): string {
  return `Could not read ${what}. ${online ? message(error) : OFFLINE}`;
}

/** The fake backend's extra controls, found by shape so the model needs no runtime import. */
interface FakeControls {
  lastSignInLink: string | null;
  setOnline(online: boolean): Promise<void>;
  signInAs(uid: string, options?: { providerIds?: string[] }): CloudUser;
  database: {
    paths(): string[];
    peek(path: string): Record<string, unknown> | null;
    seed(path: string, data: Record<string, unknown>): void;
  };
}

/** A user the fake cloud holds a profile for, whom the switch-user control can sign in as. */
export interface FakeUser {
  uid: string;
  displayName: string;
}
const fakeControls = (backend: CloudBackend | null): FakeControls | null =>
  backend !== null && backend.kind === "memory" ? (backend as unknown as FakeControls) : null;

export class AccountModel {
  private state: AccountState;
  private readonly listeners = new Set<() => void>();
  private backend: CloudBackend | null = null;
  private backendPersistence: boolean | null = null;
  private detach: Array<() => void> = [];
  private starting: Promise<void> | null = null;
  /** A sign-in link that arrived before its email address was known. */
  private pendingLink: string | null = null;
  /** Settles once `signInRoutes` holds the desktop app's answer (at once in a browser). */
  private routesLoaded: Promise<void> | null = null;
  /** The fake cloud only: the simulated devices this page has made, the first one first. */
  private fakeDevices: CloudBackend[] = [];
  /** The fake cloud only: true when the fake went offline because the browser did. */
  private fakeOfflineWithDevice = false;
  /** The devices and teams this page has asked for the key for, so each asks by itself once a session. */
  private readonly askedForKey = new Set<string>();
  /** The signed-in user and team pairs whose shares this page has carried forward (`carryForward`). */
  private readonly carriedForward = new Set<string>();
  /** Moves on when a key request starts and when it ends, so a read taken meanwhile is not trusted. */
  private keyRequestEpoch = 0;
  /** The key requests being written now. */
  private keyRequestsInFlight = 0;
  /** Counts the reads of the selected team started, so an older one never shows over a newer one. */
  private teamReads = 0;
  /** The newest read of the selected team. */
  private latestTeamRead: Promise<void> = Promise.resolve();
  /** On a shared computer, the teams each account was seen in, kept only for this page (`noteTeams`). */
  private readonly seenInSession = new Map<string, SeenTeam[]>();

  constructor(private readonly deps: AccountDeps) {
    const sharedComputer = deps.storage.get(KEYS.sharedComputer) === "on";
    // The removed age screen's device flag, which nothing reads any more, is not left behind.
    deps.storage.remove(KEYS.retiredAgeScreen);
    this.state = {
      mode: deps.mode,
      ready: false,
      user: null,
      profile: null,
      step: "providers",
      betaAccess: null,
      emailSentTo: null,
      fakeLink: null,
      sharedComputer,
      memberships: [],
      teamId: deps.storage.get(KEYS.team),
      team: null,
      teamReadError: null,
      removedFrom: null,
      lastInvite: null,
      newRecoveryCode: null,
      keys: null,
      fakeDevice: null,
      library: EMPTY_LIBRARY,
      outbox: null,
      online: deps.deviceOnline?.() ?? true,
      panel: null,
      join: null,
      busy: false,
      error: null,
      notice: null,
      suggestNewRecoveryCode: false,
      askingNewRecoveryCode: false,
      signInRoutes: POPUP_ROUTES,
      nativeProgress: null,
    };
  }

  // ------------------------------------------------------------ observable

  getState = (): AccountState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private set(patch: Partial<AccountState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  /** The backend, for the few page actions that read revisions directly. Null until `start`. */
  cloud(): CloudBackend | null {
    return this.backend;
  }

  /** The role the signed-in user has in the selected team, or null. */
  role(): Role | null {
    const { teamId, memberships } = this.state;
    return memberships.find((m) => m.teamId === teamId)?.role ?? null;
  }

  /**
   * Runs one request, keeping `busy`, `error` and `notice` honest. Returns null when it failed; the
   * failure's sentence is in `error`. `statusLine`, when given, is what the app's status line says in
   * place of a notice too long for it; the sheet still shows the whole notice.
   */
  private async run<T>(work: () => Promise<T>, done?: string | ((value: T) => string | undefined), statusLine?: string): Promise<T | null> {
    this.set({ busy: true, error: null, notice: null, suggestNewRecoveryCode: false });
    try {
      const value = await work();
      const said = typeof done === "function" ? done(value) : done;
      this.set({ busy: false, notice: said ?? null });
      if (said !== undefined) this.deps.say?.("ok", statusLine ?? said);
      return value;
    } catch (error) {
      if (error instanceof BetaRefused) {
        this.set({ busy: false });
        this.showBetaStep();
        return null;
      }
      this.failed(message(error));
      return null;
    }
  }

  /**
   * Keeps a request's failure for the open sheet to show, and puts it on the status line too when no
   * sheet or Settings section that shows it is open, so a failure is never quieter than a success.
   */
  private failed(sentence: string, statusLine: string = sentence): void {
    this.set({ busy: false, error: sentence });
    if (this.deps.feedbackShown?.() !== true) this.deps.say?.("error", statusLine);
  }

  /**
   * Like `run`, for a screen that shows its own failure where the person typed (a code): the
   * failure is thrown, as a plain sentence for the key errors and a wrong code, and not kept in `error`.
   */
  private async runOrThrow(work: () => Promise<void>, done: string): Promise<void> {
    this.set({ busy: true, error: null, notice: null });
    try {
      await work();
      this.set({ busy: false, notice: done });
      this.deps.say?.("ok", done);
    } catch (error) {
      this.set({ busy: false });
      if (isWrongCode(error)) throw error;
      throw new Error(message(error), { cause: error });
    }
  }

  private need(): CloudBackend {
    if (this.backend === null) throw new Error("The cloud is still starting. Try again in a moment.");
    return this.backend;
  }

  // ------------------------------------------------------------ start-up

  /** Makes the backend and reads any saved session. Never asks anything of the person. */
  start(): Promise<void> {
    // One start however often it is asked for: React runs a mount effect twice in development.
    this.starting ??= Promise.all([this.attach(!this.state.sharedComputer), this.loadSignInRoutes()]).then(() => undefined);
    return this.starting;
  }

  /** Asks the desktop app which providers it can sign in with, once (nativeSignIn.ts). */
  private loadSignInRoutes(): Promise<void> {
    this.routesLoaded ??= (async () => {
      const port = this.deps.nativeSignIn ?? null;
      if (port === null || this.deps.mode !== "firebase") return;
      let native: Awaited<ReturnType<NativeSignInPort["providers"]>>;
      try {
        native = await port.providers();
      } catch {
        const reason = "The desktop app could not say which ways to sign in it has. Restart it and try again.";
        native = {
          github: { available: false, reason },
          microsoft: { available: false, reason },
          google: { available: false, reason },
        };
      }
      this.set({ signInRoutes: chooseSignInRoutes({ mode: this.deps.mode, native, pageUrl: this.deps.pageUrl() }) });
    })();
    return this.routesLoaded;
  }

  private async attach(persistence: boolean): Promise<void> {
    const backend = await this.deps.createBackend({ persistence });
    this.backendPersistence = persistence;
    if (backend.kind === "memory" && !this.fakeDevices.includes(backend)) this.fakeDevices = [backend];
    await this.attachBackend(backend);
  }

  /** Listens to `backend` from now on, and reads its session. */
  private async attachBackend(backend: CloudBackend): Promise<void> {
    for (const stop of this.detach) stop();
    this.detach = [];
    this.backend = backend;
    const fakeIndex = this.fakeDevices.indexOf(backend);
    this.set({ fakeDevice: fakeIndex < 0 ? null : { index: fakeIndex, count: this.fakeDevices.length } });
    this.detach.push(
      backend.onOutboxChange((status) => {
        this.set({ outbox: status, online: status.online && (this.deps.deviceOnline?.() ?? true) });
      }),
    );
    this.set({ outbox: backend.outbox(), online: backend.isOnline() && (this.deps.deviceOnline?.() ?? true) });
    let first = true;
    await new Promise<void>((resolve) => {
      this.detach.push(
        backend.onAuthChange((user) => {
          void this.onUser(user).finally(() => {
            if (first) {
              first = false;
              resolve();
            }
          });
        }),
      );
    });
    this.set({ ready: true });
    this.deviceConnectionChanged();
  }

  /**
   * The device's own connection changed (`online` and `offline` events). The fake cloud follows it,
   * as the real one does: offline, its writes wait in the Outbox exactly as after **Go offline**, and
   * they are sent when the browser is back online, unless the person went offline in the Outbox.
   */
  deviceConnectionChanged(): void {
    const deviceOnline = this.deps.deviceOnline?.() ?? true;
    const fake = fakeControls(this.backend);
    if (fake !== null && this.backend !== null) {
      if (!deviceOnline && this.backend.isOnline()) {
        this.fakeOfflineWithDevice = true;
        void this.setFakeOnline(false);
        return;
      }
      if (deviceOnline && this.fakeOfflineWithDevice) {
        this.fakeOfflineWithDevice = false;
        void this.setFakeOnline(true);
        return;
      }
    }
    this.set({ online: (this.backend?.isOnline() ?? true) && deviceOnline });
  }

  private async onUser(user: CloudUser | null): Promise<void> {
    const before = this.state.user?.uid ?? null;
    if (user === null) {
      this.set({
        user: null,
        profile: null,
        memberships: [],
        team: null,
        teamReadError: null,
        library: EMPTY_LIBRARY,
        lastInvite: null,
        newRecoveryCode: null,
        keys: null,
        step: "providers",
        betaAccess: null,
      });
      return;
    }
    // Another account signed in without a sign-out between: what the last one was told about the
    // private beta is not this one's answer, and neither is a team it was taken off.
    this.set(before === user.uid ? { user } : { user, betaAccess: null, removedFrom: null });
    if (before === user.uid && this.state.profile !== null) return;
    try {
      const profile = await this.need().getProfile();
      this.set({ profile });
      if (profile === null) {
        // Signed in, but no profile yet: the display name, or the private-beta screen when the
        // account is not on the beta list.
        this.set({ step: await this.stepForNewProfile() });
        return;
      }
      await this.loadTeams();
    } catch (error) {
      this.set({ error: message(error) });
    }
  }

  // ------------------------------------------------------------ panels

  open(panel: Exclude<AccountPanel, null>): void {
    if (panel === "signIn") {
      this.set({ panel, error: null, notice: null, step: this.firstStep() });
      return;
    }
    this.set({ panel, error: null, notice: null });
    if (panel === "teams") void this.refreshTeam();
    if (panel === "library") {
      void this.refreshLibrary();
      void this.refreshKeys();
    }
  }

  close(): void {
    this.set({ panel: null, error: null, notice: null });
  }

  /** Where the sign-in sheet starts for whoever is at this device now. */
  private firstStep(): SignInStep {
    const { user, profile, join, betaAccess } = this.state;
    if (user !== null && betaAccess === false) return "beta";
    if (user !== null && profile === null) return "profile";
    if (user !== null && join !== null) return "join";
    return "providers";
  }

  /**
   * "This is a shared computer": no offline copy of the team's data (ADR 0009 section 8). The
   * Firebase backend takes it when it is made, so a change while signed out makes a new one.
   */
  async setSharedComputer(on: boolean): Promise<void> {
    if (on) {
      this.deps.storage.set(KEYS.sharedComputer, "on");
      // Nothing is kept offline on a shared computer, so the list of kept shares goes too.
      this.deps.storage.remove(KEYS.keptShares);
    } else {
      this.deps.storage.remove(KEYS.sharedComputer);
    }
    this.set({ sharedComputer: on });
    const wanted = !on;
    if (this.state.mode === "firebase" && this.state.user === null && this.backendPersistence !== wanted) {
      await this.attach(wanted);
    }
  }

  // ------------------------------------------------------------ sign-in (section 4.1)

  async signInWith(provider: SignInProvider): Promise<void> {
    await this.run(async () => {
      const backend = this.need();
      await this.loadSignInRoutes();
      const route = this.state.signInRoutes[provider];
      if (route.kind === "unavailable") throw new Error(route.reason);
      const port = this.deps.nativeSignIn ?? null;
      if (route.kind === "native" && port !== null) {
        await backend.signInWithNativeCredential(await this.nativeCredential(port, provider));
      } else {
        await backend.signInWithProvider(provider);
      }
      await this.afterSignIn();
    });
  }

  /** Runs one desktop sign-in in the browser, showing what to do there (GitHub's code) while it waits. */
  private async nativeCredential(port: NativeSignInPort, provider: SignInProvider): Promise<NativeCredential> {
    const stop = port.onProgress((progress) => {
      if (progress.provider === provider) this.set({ nativeProgress: progress });
    });
    try {
      return await port.start(provider);
    } finally {
      stop();
      this.set({ nativeProgress: null });
    }
  }

  /** Stops a desktop sign-in that is waiting on the browser; it then fails with "cancelled". */
  async cancelSignIn(): Promise<void> {
    await this.deps.nativeSignIn?.cancel();
  }

  async sendEmailLink(email: string): Promise<void> {
    await this.run(async () => {
      const address = email.trim();
      const backend = this.need();
      await backend.sendSignInLink(address, this.continueUrl());
      this.deps.storage.set(KEYS.signInEmail, address);
      this.set({ step: "emailSent", emailSentTo: address, fakeLink: fakeControls(backend)?.lastSignInLink ?? null });
    });
  }

  /** The fake backend's link, opened in place because nothing is emailed. */
  async openFakeLink(): Promise<void> {
    const link = this.state.fakeLink;
    const email = this.state.emailSentTo;
    if (link === null || email === null) return;
    await this.completeEmailLink(email, link);
  }

  /**
   * The page opened from a sign-in link. With the address this device sent it to, sign-in finishes
   * at once; opened on another device, the address is asked for first.
   */
  async handleIncomingLink(url: string): Promise<boolean> {
    const backend = this.backend;
    if (backend === null || !backend.isSignInLink(url)) return false;
    const email = this.deps.storage.get(KEYS.signInEmail);
    if (email === null) {
      this.pendingLink = url;
      this.set({ panel: "signIn", step: "emailConfirm" });
      return true;
    }
    this.set({ panel: "signIn" });
    await this.completeEmailLink(email, url);
    return true;
  }

  /** The address typed on the device the link was opened on. */
  async confirmEmail(email: string): Promise<void> {
    if (this.pendingLink === null) return;
    await this.completeEmailLink(email.trim(), this.pendingLink);
  }

  private async completeEmailLink(email: string, url: string): Promise<void> {
    await this.run(async () => {
      await this.need().completeSignInLink(email, url);
      this.deps.storage.remove(KEYS.signInEmail);
      this.pendingLink = null;
      this.set({ fakeLink: null });
      await this.afterSignIn();
    });
  }

  private continueUrl(): string {
    return this.deps.pageUrl().replace(/#.*$/, "").replace(/\?.*$/, "");
  }

  private async afterSignIn(): Promise<void> {
    const backend = this.need();
    const user = backend.currentUser();
    this.set({ user });
    const profile = await backend.getProfile();
    this.set({ profile });
    if (profile === null) {
      this.set({ step: await this.stepForNewProfile() });
      return;
    }
    await this.loadTeams();
    await this.afterProfile();
  }

  // ------------------------------------------------------------ the private beta (ruled 2026-10-01)

  /**
   * The step after sign-in for an account with no profile yet. The rules refuse a new profile unless
   * the account is on the beta list, is a Horizon admin, or the beta is open, so the account is asked
   * first and shown the private-beta screen when it may not. Accounts that already have a profile are
   * never asked here: the rules gate only new profiles and joining a team.
   */
  private async stepForNewProfile(): Promise<SignInStep> {
    let access: boolean;
    try {
      access = await this.need().hasBetaAccess();
    } catch {
      // It could not be asked, for example offline. The rules still decide, and a profile they
      // refuse brings the person back to the private-beta screen.
      access = true;
    }
    this.set({ betaAccess: access });
    return access ? "profile" : "beta";
  }

  /** Shows the private-beta screen on the sign-in sheet. */
  private showBetaStep(): void {
    this.set({ betaAccess: false, panel: "signIn", step: "beta", error: null, notice: null });
  }

  /**
   * True when the cloud refused with `error` because the account is not on the beta list: a
   * permission error, and the account does not have beta access now. Other refusals are left to
   * the caller.
   */
  private async refusedForBeta(error: unknown): Promise<boolean> {
    if (cloudErrorCode(error) !== "permission-denied" || this.backend === null) return false;
    try {
      return !(await this.backend.hasBetaAccess());
    } catch {
      return false;
    }
  }

  /**
   * The server refused a new profile after it was shown here, for example because the tester was
   * taken off the list meanwhile: the profile is gone again, and the private-beta screen says why.
   */
  private async profileRefused(error: unknown, uid: string): Promise<void> {
    if (!(await this.refusedForBeta(error)) || this.state.user?.uid !== uid) return;
    this.set({ profile: null, memberships: [], team: null, teamReadError: null, library: EMPTY_LIBRARY });
    this.showBetaStep();
  }

  /**
   * The server refused a join after it was shown here: back to the private-beta screen, with the
   * join put back unredeemed so **Check again** carries on to it. A different join link opened
   * meanwhile is newer and stays as it is.
   */
  private async joinRefused(error: unknown, uid: string, join: JoinView): Promise<void> {
    if (!(await this.refusedForBeta(error)) || this.state.user?.uid !== uid) return;
    const current = this.state.join;
    if (current === null || current.code === join.code) this.set({ join: { ...join, joinedAs: null } });
    this.showBetaStep();
    try {
      await this.loadTeams();
    } catch {
      // The teams are read again on the next change; the private-beta screen is what matters here.
    }
  }

  /**
   * **Check again** on the private-beta screen: asks the cloud again, and on yes carries on where
   * the person stopped, at the display name or at the join.
   */
  async checkBetaAgain(): Promise<void> {
    await this.run(async () => {
      const backend = this.need();
      const access = await backend.hasBetaAccess();
      this.set({ betaAccess: access });
      if (!access) throw new Error(STILL_NOT_ON_BETA_LIST);
      if (this.state.profile === null) {
        this.set({ step: "profile" });
        return;
      }
      await this.afterProfile();
    });
  }

  /** The display name, the only thing the profile holds that the person types (section 4.1). */
  async saveDisplayName(displayName: string): Promise<void> {
    await this.run(async () => {
      const backend = this.need();
      if (this.state.profile === null) {
        const queued = await backend.saveProfile({ displayName }).catch(async (error: unknown) => {
          throw (await this.refusedForBeta(error)) ? new BetaRefused() : error;
        });
        const uid = this.state.user?.uid ?? "";
        try {
          this.set({ profile: queued.value });
          await this.loadTeams();
          await this.afterProfile();
        } finally {
          // The write is shown at once; if the server refuses it, `profileRefused` takes it back.
          // It is watched only from here, so the steps above never cover a quick refusal.
          void queued.sent.catch((error: unknown) => this.profileRefused(error, uid));
        }
        return;
      }
      const queued = await backend.saveProfile({ displayName });
      this.set({ profile: queued.value });
      await this.loadTeams();
    }, "Saved your display name.");
  }

  private async afterProfile(): Promise<void> {
    if (this.state.join !== null) {
      this.set({ step: "join", panel: "signIn" });
      await this.loadJoin(this.state.join.code);
      return;
    }
    // Signed in with a team: the sign-in sheet has done its job and closes. With none, Teams opens to make or join one.
    this.set({
      panel: this.state.memberships.length === 0 ? "teams" : this.state.panel === "signIn" ? null : this.state.panel,
    });
  }

  /**
   * Signs out and clears the offline cache (section 6). Changes still waiting in the Outbox are in
   * that cache, so they are dropped and may never reach the server; Settings warns before it gets here (issue #319),
   * and the notice says how many went.
   */
  async signOut(): Promise<void> {
    let dropped = 0;
    await this.run(async () => {
      const backend = this.need();
      dropped = backend.outbox().queued;
      await backend.signOut();
      // The cloud's offline cache is gone, so the shares kept for offline are no longer here.
      this.deps.storage.remove(KEYS.keptShares);
      this.set({
        user: null,
        profile: null,
        memberships: [],
        team: null,
        teamReadError: null,
        library: EMPTY_LIBRARY,
        panel: null,
        lastInvite: null,
        newRecoveryCode: null,
        keys: null,
        betaAccess: null,
      });
    }, () =>
      dropped === 0
        ? "Signed out. The team library's offline copy on this computer was cleared."
        : `Signed out. The team library's offline copy on this computer was cleared, and ${waitingChanges(dropped)} waiting in the Outbox ${dropped === 1 ? "was" : "were"} dropped; ${dropped === 1 ? "it" : "they"} may not have reached the server.`,
    );
  }

  /** Everything the cloud holds about the signed-in user, as JSON (spec 13 section 12.3). */
  async exportMyData(): Promise<string | null> {
    return this.run(async () => {
      const data = await this.need().exportMyData();
      return `${JSON.stringify(data, null, 2)}\n`;
    }, "Downloaded your data.");
  }

  /** Why Delete my account cannot run, or null. An owner hands the team on first. */
  whyCannotDeleteAccount(): string | null {
    const owned = this.state.memberships.filter((m) => m.role === "owner");
    if (owned.length === 0) return null;
    return `You own ${owned.length === 1 ? "a team" : `${String(owned.length)} teams`}. Make another member an owner, or delete the team, first.`;
  }

  async deleteAccount(): Promise<boolean> {
    const done = await this.run(async () => {
      const why = this.whyCannotDeleteAccount();
      if (why !== null) throw new Error(why);
      await this.need().deleteAccount(await this.deleteAccountOptions());
      this.set({
        user: null,
        profile: null,
        memberships: [],
        team: null,
        teamReadError: null,
        library: EMPTY_LIBRARY,
        panel: null,
      });
      return true;
    }, "Deleted your account. Zenith keeps working here without one.");
    return done === true;
  }

  /**
   * How Delete my account signs the account in again: the way signing in with its provider goes here
   * (`signInRoutes`). The desktop app's browser sign-in hands its credential to the backend; the popup
   * needs nothing; a provider this build cannot sign in with stops here, before anything is deleted.
   */
  private async deleteAccountOptions(): Promise<DeleteAccountOptions> {
    await this.loadSignInRoutes();
    const provider = accountSignInProvider(this.state.user?.providerIds ?? []);
    const port = this.deps.nativeSignIn ?? null;
    if (provider === null || port === null) return {};
    const route = this.state.signInRoutes[provider];
    if (route.kind === "unavailable") {
      throw new Error(
        `${route.reason} Nothing was deleted: deleting your account needs you to sign in again with it first, so delete it from Zenith in a web browser instead.`,
      );
    }
    if (route.kind === "popup") return {};
    return { reauthenticate: (asked) => this.nativeCredential(port, asked) };
  }

  // ------------------------------------------------------------ teams (sections 4.2, 4.3)

  private async loadTeams(): Promise<void> {
    const memberships = await this.need().listMyTeams();
    const removed = this.noteTeams(memberships);
    let teamId = this.state.teamId;
    if (teamId === null || !memberships.some((m) => m.teamId === teamId)) teamId = memberships[0]?.teamId ?? null;
    this.set({ memberships });
    if (teamId !== this.state.teamId || this.state.team?.teamId !== teamId) this.selectTeam(teamId);
    if (removed !== null) this.set({ removedFrom: removed });
  }

  /**
   * Compares the teams the cloud lists for the account with the ones this device last saw it in,
   * remembers the new list, and returns a team it is no longer in (the selected one first), or null.
   * The list is kept per account; on a shared computer only until the page closes.
   */
  private noteTeams(memberships: readonly Membership[]): SeenTeam | null {
    const uid = this.state.user?.uid;
    if (uid === undefined) return null;
    const lost = lostTeams(this.seenTeams(uid), memberships);
    this.keepSeenTeams(uid, seenTeamsOf(memberships));
    return lost.find((team) => team.teamId === this.state.teamId) ?? lost[0] ?? null;
  }

  /** Forgets a team this device leaves or deletes, so it is never reported as one the account was taken off. */
  private forgetSeenTeam(teamId: string): void {
    const uid = this.state.user?.uid;
    if (uid !== undefined) this.keepSeenTeams(uid, this.seenTeams(uid).filter((team) => team.teamId !== teamId));
  }

  private seenTeams(uid: string): SeenTeam[] {
    if (this.state.sharedComputer) return this.seenInSession.get(uid) ?? [];
    return readSeenTeams(this.deps.storage.get(`${KEYS.teamsSeenPrefix}${encodeURIComponent(uid)}`));
  }

  private keepSeenTeams(uid: string, teams: SeenTeam[]): void {
    if (this.state.sharedComputer) this.seenInSession.set(uid, teams);
    else this.deps.storage.set(`${KEYS.teamsSeenPrefix}${encodeURIComponent(uid)}`, JSON.stringify(teams));
  }

  /**
   * Chooses the team shown. Moving to another team drops any word of a team the account was taken
   * off (`removedFrom`); reading the same team again, or none, keeps it.
   */
  selectTeam(teamId: string | null): void {
    if (teamId === null) this.deps.storage.remove(KEYS.team);
    else this.deps.storage.set(KEYS.team, teamId);
    const removedFrom = teamId !== null && teamId !== this.state.teamId ? null : this.state.removedFrom;
    this.set({ teamId, team: null, teamReadError: null, removedFrom, library: EMPTY_LIBRARY, lastInvite: null, keys: null, suggestNewRecoveryCode: false, askingNewRecoveryCode: false });
    if (teamId !== null) {
      void this.refreshTeam();
      // Read even with the Library closed: the share dialog needs to know which revision the open
      // auto is, and the Sharing page names each share's auto by its library title.
      void this.refreshLibrary();
    }
  }

  /**
   * Reads the selected team's members, settings and, for admins, invites and activity. Reads that
   * nothing waits for (choosing a team starts one) can overlap one that a change waits for, and
   * finish after it. The newest read started is the one shown: an older read that finishes later
   * shows nothing and settles when the newer one does, so whoever waits on it still sees the team
   * as it was read after they asked.
   */
  refreshTeam(): Promise<void> {
    this.teamReads += 1;
    const read = this.readTeam(this.teamReads);
    this.latestTeamRead = read;
    return read;
  }

  private async readTeam(read: number): Promise<void> {
    const teamId = this.state.teamId;
    const backend = this.backend;
    if (teamId === null || backend === null || this.state.user === null) return;
    // A newer read has started: this one's answer may be older than what that one finds.
    const superseded = (): boolean => read !== this.teamReads;
    try {
      const memberships = await backend.listMyTeams();
      if (superseded()) return await this.latestTeamRead;
      const removed = this.noteTeams(memberships);
      this.set({ memberships });
      if (removed !== null) {
        // Taken off a team: say which. When it is the one open here, show what is left instead.
        const lostOpen = this.state.teamId === teamId && !memberships.some((m) => m.teamId === teamId);
        if (lostOpen) this.selectTeam(memberships[0]?.teamId ?? null);
        this.set({ removedFrom: removed });
        if (lostOpen) return;
      }
      const role = memberships.find((m) => m.teamId === teamId)?.role ?? null;
      if (role === null || role === "pending") {
        this.set({ team: { teamId, members: [], invites: [], settings: DEFAULT_SETTINGS, activity: [] } });
        if (role === "pending") await this.refreshKeys();
        return;
      }
      const admin = isAdminRole(role);
      const [members, settings, invites, activity] = await Promise.all([
        backend.listMembers(teamId),
        backend.getTeamSettings(teamId),
        admin ? backend.listInvites(teamId) : Promise.resolve([]),
        admin ? backend.listActivity(teamId) : Promise.resolve([]),
      ]);
      if (superseded()) return await this.latestTeamRead;
      if (this.state.teamId !== teamId) return;
      this.set({ team: { teamId, members: sortMembers(members), settings, invites, activity }, teamReadError: null });
      await this.refreshKeys();
    } catch (error) {
      if (superseded()) return await this.latestTeamRead;
      if (this.state.teamId !== teamId) return;
      // The Teams sheet turns "Reading the team…" into this sentence and Try again.
      this.set({ teamReadError: readSentence("the team", error, this.state.online) });
      // With the team already shown (read again after a change), its lists stay as they were read
      // before, and the sheet's feedback says so, as the status line does when no sheet shows it.
      if (this.state.team?.teamId === teamId) {
        const sentence = `${readSentence("the team again", error, this.state.online)} The lists here may be out of date.`;
        this.set({ error: sentence });
        if (this.deps.feedbackShown?.() !== true) this.deps.say?.("error", sentence);
      }
    }
  }

  // ------------------------------------------------------------ keys (spec 14)

  /**
   * Reads where this device stands with the selected team's key. A device that is waiting and has
   * not asked yet asks, once a session (a member's new device; a new member's device asked when it
   * redeemed the invite). When the request it made is gone later, it was declined, or the grant it
   * led to did not carry this device's approval code, or the key changed before this device opened
   * it; the status then says `requested: false` and the waiting screen offers `askForKeyAgain`. A device holding
   * the key reads the requests it may approve and the devices that hold the key. When it has just
   * been given the key, the library is read again.
   */
  async refreshKeys(): Promise<void> {
    const teamId = this.state.teamId;
    const backend = this.backend;
    if (teamId === null || backend === null || this.state.user === null) return;
    const before = this.state.keys?.teamId === teamId ? this.state.keys.status?.state : undefined;
    let view: KeysView;
    try {
      const epoch = this.keyRequestEpoch;
      let status = await backend.teamKeyStatus(teamId);
      if (status.state === "waiting" && !status.requested) {
        const asked = `${status.device.deviceId}:${teamId}`;
        // A read taken while a request was being written may not show it yet.
        const stale = epoch !== this.keyRequestEpoch || this.keyRequestsInFlight > 0;
        if (!this.askedForKey.has(asked)) {
          this.askedForKey.add(asked);
          await this.requestKey(backend, teamId);
          status = { ...status, requested: true };
        } else if (stale) {
          status = { ...status, requested: true };
        }
      }
      const ready = status.state === "ready";
      const [requests, devices] = ready
        ? await Promise.all([
            backend.listKeyRequests(teamId).catch(() => [] as KeyRequest[]),
            backend.listTeamDevices(teamId).catch(() => [] as TeamDevice[]),
          ])
        : [[] as KeyRequest[], [] as TeamDevice[]];
      view = {
        teamId,
        status,
        approvalCode: status.state === "waiting" ? status.approvalCode : null,
        requests: requests.filter((request) => request.deviceId !== status.device.deviceId),
        devices,
        problem: null,
      };
    } catch (error) {
      view = { teamId, status: null, approvalCode: null, requests: [], devices: [], problem: message(error) };
    }
    if (this.state.teamId !== teamId) return;
    this.set({ keys: view });
    if (view.status?.state === "ready") this.carryForward(backend, teamId);
    if (before === "waiting" && view.status?.state === "ready") await this.refreshLibrary();
  }

  /**
   * Once this device holds the team key, carries the team's shares that a key change left signed
   * with an older key forward to the newest one, in the background (`carryForwardShares`), so a
   * partner that has seen the newer key opens them again. The device that changed the key does this
   * itself; this finishes a run it did not. Once per team each time the page loads, online, and only
   * for a role that may change shares; a failure is nothing for the person to act on, and is tried
   * again at the next load.
   */
  private carryForward(backend: CloudBackend, teamId: string): void {
    const role = this.state.memberships.find((m) => m.teamId === teamId)?.role;
    const key = `${this.state.user?.uid ?? ""}:${teamId}`;
    if (this.carriedForward.has(key) || !backend.isOnline() || (role !== "owner" && role !== "admin" && role !== "editor")) return;
    this.carriedForward.add(key);
    void backend.carryForwardShares(teamId).catch(() => {
      this.carriedForward.delete(key);
    });
  }

  /**
   * Writes this device's key request, counted until it reaches the cloud (later, when this computer
   * is offline), so that `refreshKeys` does not take a read made meanwhile as "no request".
   */
  private async requestKey(backend: CloudBackend, teamId: string): Promise<void> {
    this.keyRequestEpoch += 1;
    this.keyRequestsInFlight += 1;
    const done = () => {
      this.keyRequestsInFlight -= 1;
      this.keyRequestEpoch += 1;
    };
    let queued: Awaited<ReturnType<CloudBackend["requestTeamKey"]>>;
    try {
      queued = await backend.requestTeamKey(teamId);
    } catch (error) {
      done();
      throw error;
    }
    void queued.sent.then(done, done);
    await this.settled(queued);
  }

  /**
   * Asks for the selected team's key again, when the request this device made is gone: it was
   * declined, or this device refused a grant whose proof was not its code's, or the key changed
   * before this device opened its grant. The approver then types the code this device shows.
   */
  askForKeyAgain(): Promise<boolean> {
    return this.teamWrite((backend, teamId) => this.requestKey(backend, teamId), "Asked for the team key again.");
  }

  /** The key request of a pending member's device, which their approval grants. */
  memberKeyRequest(uid: string): KeyRequest | null {
    const requests = (this.state.keys?.requests ?? []).filter((request) => request.uid === uid && request.kind === "member" && request.matchesDevice);
    return requests[requests.length - 1] ?? null;
  }

  /**
   * Approves a pending member with the approval code their device shows (typed by the approver):
   * the role their invite offered, and the team key for the one device whose code it is, in one
   * write. A member with more than one waiting request gets the key on the device the approver read
   * the code from, not simply the newest. Throws a plain sentence on failure, or the cloud's
   * "wrong-code" error for a code that is none of the member's devices'.
   */
  approveWithCode(uid: string, approvalCode: string): Promise<void> {
    return this.runOrThrow(async () => {
      const teamId = this.state.teamId;
      if (teamId === null) throw new Error("Choose a team first.");
      const request = this.memberKeyRequest(uid);
      if (request === null) throw new Error(NO_MEMBER_REQUEST);
      const backend = this.need();
      // No match leaves the newest request, whose check then refuses the code as "wrong-code".
      const deviceId = (await backend.keyRequestForCode(teamId, uid, approvalCode)) ?? request.deviceId;
      await this.settled(await backend.approveMember(teamId, uid, { deviceId, approvalCode }));
      await this.refreshTeam();
    }, "Approved the member and sent their device the team key.");
  }

  /** Gives a member's new device the team key, with the approval code it shows; throws as above. */
  grantDevice(deviceId: string, approvalCode: string): Promise<void> {
    return this.runOrThrow(async () => {
      const teamId = this.state.teamId;
      if (teamId === null) throw new Error("Choose a team first.");
      const request = this.state.keys?.requests.find((r) => r.deviceId === deviceId && r.matchesDevice);
      if (request === undefined) throw new Error("That device is no longer waiting for the key.");
      await this.settled(await this.need().grantDeviceKey(teamId, deviceId, approvalCode));
      await this.refreshTeam();
    }, "Sent the new device the team key.");
  }

  declineDevice(deviceId: string): Promise<boolean> {
    return this.teamWrite((b, t) => b.declineKeyRequest(t, deviceId), "Declined the device. It did not get the team key.");
  }

  /** Takes the team key from a device; an owner or admin makes a new key in the same write. */
  revokeDevice(deviceId: string): Promise<boolean> {
    return this.teamWrite((b, t) => b.revokeDevice(t, deviceId), "Took the team key from the device. The team key changes.", { countStopped: true });
  }

  /** Makes the new team key after a member left ("rotation pending"). Owners and admins. */
  completeKeyRotation(): Promise<boolean> {
    return this.teamWrite((b, t) => b.completeKeyRotation(t), "Made a new team key. Every device still on the team has it.", { countStopped: true });
  }

  /** Unlocks the team library here with the printed recovery code. Throws a plain sentence on failure. */
  useRecoveryCode(text: string): Promise<void> {
    return this.runOrThrow(async () => {
      const teamId = this.state.teamId;
      if (teamId === null) throw new Error("Choose a team first.");
      await this.settled(await this.need().useRecoveryCode(teamId, text));
      await this.refreshTeam();
      await this.refreshLibrary();
    }, "Unlocked the team library on this device with the recovery code.");
  }

  /** Makes a new recovery code in place of the old one, which stops working. Owners only. */
  async replaceRecoveryCode(): Promise<boolean> {
    const result = await this.run(async () => {
      const teamId = this.state.teamId;
      if (teamId === null) throw new Error("Choose a team first.");
      const queued = await this.need().replaceRecoveryCode(teamId);
      await this.settled(queued);
      this.set({ newRecoveryCode: { teamId, code: queued.value.recoveryCode, madeAtMs: this.deps.now(), replacing: true }, askingNewRecoveryCode: false });
      return true;
    });
    return result === true;
  }

  /** Waits for the server while online, so a refusal is reported where it was asked for. */
  private async settled<T>(queued: { value: T; sent: Promise<unknown> }): Promise<T> {
    if (this.backend?.isOnline() === true) await queued.sent;
    return queued.value;
  }

  /**
   * Runs a team write, then reads the team back. With `countStopped`, for a write that can change the
   * team key, the notice also says how many of the team's shares stopped with it
   * (`stoppedSharesNotice`), so the team knows to share them again from the Sharing page. With
   * `statusLine`, the app's status line says only that, and the whole notice stays in the sheet.
   */
  private async teamWrite(
    work: (backend: CloudBackend, teamId: string) => Promise<unknown>,
    done: string,
    options: { countStopped?: boolean; statusLine?: string } = {},
  ): Promise<boolean> {
    const result = await this.run(
      async () => {
        const teamId = this.state.teamId;
        if (teamId === null) throw new Error("Choose a team first.");
        const before = options.countStopped === true ? await this.stoppedShareIds(teamId) : null;
        await work(this.need(), teamId);
        await this.refreshTeam();
        if (before === null) return 0;
        const after = await this.stoppedShareIds(teamId);
        return after === null ? 0 : [...after].filter((id) => !before.has(id)).length;
      },
      (stopped) => (stopped === 0 ? done : `${done} ${stoppedSharesNotice(stopped)}`),
      options.statusLine,
    );
    return result !== null;
  }

  /**
   * The ids of the team's shares that stopped when its key changed because a device that signed them
   * was removed, or null when they cannot be read here (no team key yet, or offline): the count in a
   * notice is an extra, never a reason to fail.
   */
  private async stoppedShareIds(teamId: string): Promise<Set<string> | null> {
    try {
      const stopped = await this.need().listStoppedShares(teamId);
      return new Set(stopped.filter((share) => share.reason === "device-removed").map((share) => share.id));
    } catch {
      return null;
    }
  }

  async createTeam(input: { number: number | null; name: string }): Promise<boolean> {
    const result = await this.run(
      async () => {
        const queued = await this.need().createTeam(input);
        // Kept before anything else can fail: the code exists only here, and only this once.
        this.set({
          newRecoveryCode: { teamId: queued.value.id, code: queued.value.recoveryCode, madeAtMs: this.deps.now(), replacing: false },
        });
        await this.loadTeams();
        this.selectTeam(queued.value.id);
        await this.refreshTeam();
        return queued.value;
      },
      (team) =>
        `Created team ${team.number === null ? team.name : `${String(team.number)} ${team.name}`}. Its number is unverified until a Horizon admin checks it.`,
    );
    return result !== null;
  }

  /** Forgets the recovery code once the person printed it or ticked that it is saved. */
  dismissRecoveryCode(): void {
    this.set({ newRecoveryCode: null });
  }

  setRole(uid: string, role: ActiveRole): Promise<boolean> {
    return this.teamWrite((b, t) => b.setRole(t, uid, role), `Changed the member's role to ${role}.`);
  }

  /**
   * Removes a member. For an owner, the notice suggests a new recovery code: with the old one, a
   * device that has never opened the team can be shown the team as it was when that code was made,
   * with a key the removed member still holds (spec 14 section 4.11). Either notice says that a link
   * the team made keeps working for whoever has it, the removed member included. The notice is long,
   * so it stays in the Teams sheet, and the app's status line says only `REMOVED_STATUS`.
   */
  async removeMember(uid: string): Promise<boolean> {
    const owner = this.role() === "owner";
    const removed = await this.teamWrite((b, t) => b.removeMember(t, uid), owner ? REMOVED_SUGGEST_NEW_CODE : REMOVED_LINKS_STAY, {
      countStopped: true,
      statusLine: REMOVED_STATUS,
    });
    if (removed && owner) this.set({ suggestNewRecoveryCode: true });
    return removed;
  }

  /** Opens or closes the owner's New recovery code confirmation. */
  askNewRecoveryCode(asking: boolean): void {
    this.set(asking ? { askingNewRecoveryCode: true, suggestNewRecoveryCode: false } : { askingNewRecoveryCode: false });
  }

  /** Makes another member an owner (see `whyCannotTransfer`). */
  transferOwnership(uid: string): Promise<boolean> {
    const target = this.state.team?.members.find((m) => m.uid === uid);
    const why =
      target === undefined
        ? "That member is not in the team."
        : whyCannotTransfer(this.role(), this.state.user?.uid ?? "", target);
    if (why !== null) {
      this.set({ error: why });
      return Promise.resolve(false);
    }
    return this.teamWrite(
      (b, t) => b.setRole(t, uid, "owner"),
      `${target?.displayName ?? "The member"} is now an owner. You stay an owner until they change your role.`,
    );
  }

  async leaveTeam(): Promise<boolean> {
    const result = await this.run(async () => {
      const teamId = this.state.teamId;
      if (teamId === null) throw new Error("Choose a team first.");
      await this.need().leaveTeam(teamId);
      this.forgetSeenTeam(teamId);
      this.selectTeam(null);
      await this.loadTeams();
      return true;
    }, "Left the team.");
    return result === true;
  }

  /** Deletes the team once the name has been typed exactly (section 4.3: owners only). */
  async deleteTeam(typedName: string): Promise<boolean> {
    const result = await this.run(
      async () => {
        const teamId = this.state.teamId;
        const team = this.state.memberships.find((m) => m.teamId === teamId)?.team ?? null;
        if (teamId === null || team === null) throw new Error("Choose a team first.");
        const why = whyCannotDeleteTeam(this.role());
        if (why !== null) throw new Error(why);
        if (typedName.trim() !== team.name)
          throw new Error(`Type the team's name, ${team.name}, exactly to delete it.`);
        await this.need().deleteTeam(teamId);
        this.forgetSeenTeam(teamId);
        this.selectTeam(null);
        await this.loadTeams();
        return team.name;
      },
      (name) => `Deleted team ${name}.`,
    );
    return result !== null;
  }

  updateSettings(patch: Partial<TeamSettingsDoc>): Promise<boolean> {
    return this.teamWrite((b, t) => b.updateTeamSettings(t, patch), "Changed the team's settings.");
  }

  // ------------------------------------------------------------ invites

  async createInvite(input: {
    role: InviteRole;
    expiry: InviteExpiryChoice;
    maxUses: number;
    autoApprove: boolean;
  }): Promise<Invite | null> {
    return this.run(async () => {
      const teamId = this.state.teamId;
      if (teamId === null) throw new Error("Choose a team first.");
      const nowMs = this.deps.now();
      const why = whyCannotCreateInvite(input.expiry, input.maxUses, nowMs);
      if (why !== null) throw new Error(why);
      const expiresInS = expiresInSeconds(input.expiry, nowMs) ?? 0;
      const queued = await this.need().createInvite(teamId, {
        role: input.role,
        expiresInS,
        maxUses: input.maxUses,
        autoApprove: input.autoApprove,
      });
      this.set({ lastInvite: queued.value });
      await this.refreshTeam();
      return queued.value;
    }, "Made the invite. Copy its link and send it to your teammate.");
  }

  extendInvite(code: string, choice: InviteExpiryChoice): Promise<boolean> {
    const invite = this.state.team?.invites.find((i) => i.code === code);
    const nowMs = this.deps.now();
    const next = invite === undefined ? null : extendedMs(invite.expiresAt.getTime(), choice, nowMs);
    if (next === null) {
      this.set({ error: "Pick a time later than the invite's current end." });
      return Promise.resolve(false);
    }
    return this.teamWrite((b) => b.extendInvite(code, new Date(next)), "Extended the invite.");
  }

  revokeInvite(code: string): Promise<boolean> {
    return this.teamWrite((b) => b.revokeInvite(code), "Revoked the invite. Its link no longer works.");
  }

  // ------------------------------------------------------------ joining by link (#/join/<code>)

  /** A join link was opened. Signing in comes first when nobody is signed in. */
  async openJoin(code: string): Promise<void> {
    this.set({
      join: { code, invite: null, teamName: null, teamNumber: null, teamStatus: null, joinedAs: null, problem: null },
      panel: "signIn",
    });
    if (this.state.user === null || this.state.profile === null) {
      this.set({ step: this.firstStep() });
      return;
    }
    this.set({ step: "join" });
    await this.loadJoin(code);
  }

  private async loadJoin(code: string): Promise<void> {
    const backend = this.need();
    const invite = await backend.getInvite(code);
    const team = invite === null ? null : await backend.getTeam(invite.teamId);
    // A newer join link opened, or the join closed, while this one was read: that one is shown.
    if (this.state.join?.code !== code) return;
    const nowMs = this.deps.now();
    let problem: string | null = null;
    if (invite === null) problem = "That invite does not exist. Check the link, or ask the team for a new one.";
    else if (invite.revoked) problem = "That invite was revoked. Ask the team for a new one.";
    else if (invite.expiresAt.getTime() <= nowMs) problem = "That invite has ended. Ask the team for a new one.";
    else if (invite.uses >= invite.maxUses) problem = "That invite has been used up. Ask the team for a new one.";
    else if (this.state.memberships.some((m) => m.teamId === invite.teamId)) problem = "You are already in this team.";
    this.set({
      join: {
        code,
        invite,
        teamName: team?.name ?? null,
        teamNumber: team?.number ?? null,
        teamStatus: team?.status ?? null,
        joinedAs: null,
        problem,
      },
    });
  }

  async redeemJoin(): Promise<boolean> {
    const join = this.state.join;
    if (join === null) return false;
    const result = await this.run(
      async () => {
        const queued = await this.need().redeemInvite(join.code).catch(async (error: unknown) => {
          throw (await this.refusedForBeta(error)) ? new BetaRefused() : error;
        });
        const uid = this.state.user?.uid ?? "";
        try {
          await this.loadTeams();
          this.selectTeam(queued.value.teamId);
          this.set({ join: { ...join, joinedAs: queued.value.role } });
        } finally {
          // The join is shown at once; if the server refuses it, `joinRefused` takes it back. It is
          // watched only from here, so the steps above never cover a quick refusal.
          void queued.sent.catch((error: unknown) => this.joinRefused(error, uid, join));
        }
        return queued.value.role;
      },
      (role) =>
        role === "pending"
          ? "Asked to join. An owner or admin of the team approves new members."
          : `Joined the team as ${role}.`,
    );
    return result !== null;
  }

  finishJoin(): void {
    this.set({ join: null, panel: this.state.memberships.length > 0 ? "teams" : null });
  }

  // ------------------------------------------------------------ team library (section 5)

  async refreshLibrary(): Promise<void> {
    const teamId = this.state.teamId;
    const backend = this.backend;
    if (teamId === null || backend === null || whyCannotOpenLibrary(this.role()) !== null) {
      this.set({ library: { ...EMPTY_LIBRARY, teamId } });
      return;
    }
    try {
      const autos = await backend.listAutos(teamId);
      const revisions: Record<string, Revision[]> = {};
      for (const auto of autos) revisions[auto.id] = await backend.listRevisions(teamId, auto.id);
      if (this.state.teamId !== teamId) return;
      this.set({ library: { teamId, autos, revisions, loaded: true, readError: null } });
    } catch (error) {
      // A device waiting for the key cannot read the library; the waiting screen says so instead.
      if (cloudErrorCode(error) === "no-key") {
        this.set({ library: { ...EMPTY_LIBRARY, teamId } });
        return;
      }
      if (this.state.teamId !== teamId) return;
      // The sheet turns "Reading the library…" into this sentence and Try again; what an earlier read
      // found stays on show under it.
      const before = this.state.library.teamId === teamId ? this.state.library : { ...EMPTY_LIBRARY, teamId };
      this.set({ library: { ...before, readError: readSentence("the team library", error, this.state.online) } });
    }
  }

  /** This device's base for a library auto: the revision the next publish is built on. */
  baseOf(autoId: string): string | null {
    const teamId = this.state.teamId;
    if (teamId === null) return null;
    return chooseBase(rememberedBase(this.deps.storage, teamId, autoId), this.state.library.revisions[autoId] ?? []);
  }

  /** Called when a revision is opened into the editor: it becomes the base of the next publish. */
  markOpened(autoId: string, revisionId: string): void {
    const teamId = this.state.teamId;
    if (teamId !== null) rememberBase(this.deps.storage, teamId, autoId, revisionId);
    this.set({ library: { ...this.state.library } });
  }

  /**
   * Publishes a saved auto as a new revision (section 5.2). The library auto is found by file name,
   * and made on the first publish. A file identical to its base revision publishes nothing.
   */
  async publish(
    file: { fileName: string; canonical: string; project: Pick<Project, "robot" | "field" | "waypoints"> | null },
    options: { quiet?: boolean } = {},
  ): Promise<Revision | null> {
    let waits = false;
    const work = async (): Promise<Revision> => {
      const teamId = this.state.teamId;
      if (teamId === null) throw new Error("Choose a team first.");
      const why = whyCannotPublish(this.role());
      if (why !== null) throw new Error(why);
      const backend = this.need();
      const autos = await backend.listAutos(teamId);
      const auto =
        findLibraryAuto(autos, file.fileName) ?? (await backend.createAuto(teamId, { title: file.fileName })).value;
      const revisions = await backend.listRevisions(teamId, auto.id);
      const base = chooseBase(rememberedBase(this.deps.storage, teamId, auto.id), revisions);
      const baseRevision = revisions.find((r) => r.id === base);
      if (baseRevision !== undefined && baseRevision.content === file.canonical) {
        throw new Unchanged(baseRevision);
      }
      // Shares that follow the latest version move after the write, one projection per share
      // (`onPublished`), not through `followProjection`, which would give every share one level.
      const gitSha = this.deps.gitShaFor?.(file.fileName, file.canonical) ?? null;
      // Offline the revision is kept here and waits in the Outbox (section 6), so the words say so.
      waits = !backend.isOnline() || !this.state.online;
      const queued = await backend.publishRevision({
        teamId,
        autoId: auto.id,
        baseRevision: base,
        content: file.canonical,
        ...projectTexts(file.project),
        ...(gitSha === null ? {} : { gitSha }),
      });
      rememberBase(this.deps.storage, teamId, auto.id, queued.value.id);
      await this.refreshLibrary();
      return queued.value;
    };
    const words = (revision: Revision): string =>
      waits
        ? `Revision ${String(revision.n)} of ${file.fileName} is saved on this computer and waits in the Outbox. It reaches the team library when this computer is back online.`
        : revision.diverged
        ? `Published revision ${String(revision.n)} of ${file.fileName}. Someone else published from the same revision, so both are kept and this one is marked diverged.`
        : `Published revision ${String(revision.n)} of ${file.fileName} to the team library.`;

    this.set({ busy: true, error: null, notice: null });
    try {
      const revision = await work();
      const said = words(revision);
      this.set({ busy: false, notice: said });
      this.deps.say?.(options.quiet === true && !revision.diverged ? "info" : waits ? "info" : "ok", said);
      await this.deps.onPublished?.(revision);
      return revision;
    } catch (error) {
      if (error instanceof Unchanged) {
        const said = `${file.fileName} is already revision ${String(error.revision.n)} in the library. Nothing new to publish.`;
        this.set({ busy: false, notice: said });
        if (options.quiet !== true) this.deps.say?.("info", said);
        return null;
      }
      if (options.quiet === true) {
        this.set({ busy: false, error: message(error) });
        this.deps.say?.("error", `Publish on save: ${message(error)}`);
      } else {
        this.failed(message(error), `Did not publish ${file.fileName}: ${message(error)}`);
      }
      return null;
    }
  }

  /** The editor saved a file. With the team's "Publish on every save" on, it is published too. */
  async onEditorSaved(file: {
    fileName: string;
    canonical: string;
    project: Pick<Project, "robot" | "field" | "waypoints"> | null;
  }): Promise<Revision | null> {
    if (this.state.user === null || this.state.team?.settings.publishOnSave !== true) return null;
    if (whyCannotPublish(this.role()) !== null) return null;
    return this.publish(file, { quiet: true });
  }

  /** Fetches the whole library and the team's received shares, so they open offline (section 6). */
  async saveForOffline(): Promise<void> {
    await this.run(async () => {
      const teamId = this.state.teamId;
      if (teamId === null) throw new Error("Choose a team first.");
      await this.need().saveForOffline(teamId);
      await this.refreshLibrary();
    }, "Saved the team library for offline use on this computer.");
  }

  /** The files of Download project, from the newest revision of every auto. */
  projectEntries(): ZipEntry[] {
    const { autos, revisions } = this.state.library;
    const latest: Array<{ title: string; revision: Revision }> = [];
    for (const auto of autos) {
      const revision = latestRevision(revisions[auto.id] ?? []);
      if (revision !== null) latest.push({ title: auto.title, revision });
    }
    return projectZipEntries(latest);
  }

  // ------------------------------------------------------------ the fake cloud only

  /** True when the in-memory fake is in use, whose connection can be switched off to try the outbox. */
  isFake(): boolean {
    return fakeControls(this.backend) !== null;
  }

  /** Every user the fake cloud holds a profile for, by name, for the switch-user control. */
  fakeUsers(): FakeUser[] {
    const fake = fakeControls(this.backend);
    if (fake === null) return [];
    const users: FakeUser[] = [];
    for (const path of fake.database.paths()) {
      const match = /^users\/([^/]+)$/.exec(path);
      if (match === null || match[1] === undefined) continue;
      const name = fake.database.peek(path)?.displayName;
      users.push({ uid: match[1], displayName: typeof name === "string" ? name : match[1] });
    }
    return users.sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  /**
   * Signs the fake cloud in as another user who already has a profile: how a test plays two teams
   * on one page.
   */
  async switchFakeUser(uid: string): Promise<boolean> {
    const fake = fakeControls(this.backend);
    if (fake === null) return false;
    const done = await this.run(async () => {
      if (fake.database.peek(`users/${uid}`) === null) throw new Error("That test user has no profile yet. Sign in as them first.");
      fake.signInAs(uid, { providerIds: ["memory"] });
      this.set({ team: null, teamReadError: null, library: EMPTY_LIBRARY, lastInvite: null, newRecoveryCode: null, keys: null, join: null });
      await this.afterSignIn();
      return true;
    });
    return done === true;
  }

  /** Writes documents into the fake cloud as the Firebase console would, skipping any that exist. */
  seedFake(docs: Record<string, Record<string, unknown>>): void {
    const fake = fakeControls(this.backend);
    if (fake === null) return;
    const exists = (path: string): boolean => fake.database.peek(path) !== null;
    for (const [path, data] of Object.entries(withoutClashes(docs, exists))) {
      if (!exists(path)) fake.database.seed(path, data);
    }
  }

  async setFakeOnline(online: boolean): Promise<void> {
    const fake = fakeControls(this.backend);
    if (fake === null) return;
    if (online) this.fakeOfflineWithDevice = false;
    await fake.setOnline(online);
    this.deviceConnectionChanged();
    if (online) {
      await this.refreshTeam();
      await this.refreshLibrary();
    }
  }

  /**
   * Moves this page to another simulated device of the fake cloud, signed in as the same user:
   * `index` is one made before, or "new" for a device with keys of its own, which has to be
   * approved like a member's new laptop. How a test plays a member's two devices on one page.
   */
  async switchFakeDevice(index: number | "new"): Promise<boolean> {
    const current = this.backend;
    const uid = this.state.user?.uid ?? null;
    if (fakeControls(current) === null || current === null) return false;
    const done = await this.run(async () => {
      if (uid === null || this.state.profile === null) throw new Error("Sign in first, then switch devices.");
      let target: CloudBackend | undefined;
      if (index === "new") {
        if (this.deps.createFakeDevice === undefined) throw new Error("This page cannot make another fake device.");
        target = await this.deps.createFakeDevice(current);
        this.fakeDevices = [...this.fakeDevices, target];
      } else {
        target = this.fakeDevices[index];
      }
      const fake = fakeControls(target ?? null);
      if (target === undefined || fake === null) throw new Error("That fake device does not exist.");
      if (target === current) return true;
      fake.signInAs(uid, { providerIds: ["memory"] });
      this.set({ team: null, teamReadError: null, library: EMPTY_LIBRARY, lastInvite: null, newRecoveryCode: null, keys: null });
      await this.attachBackend(target);
      await this.afterSignIn();
      return true;
    });
    return done === true;
  }
}

/** What a request throws when the cloud refused it because the account is not on the beta list. */
class BetaRefused extends Error {
  constructor() {
    super("This account is not on the beta list yet.");
  }
}

/** What **Check again** on the private-beta screen says when the account is still not listed. */
export const STILL_NOT_ON_BETA_LIST =
  "This account is still not on the beta list. Check again once a Horizon (FTC 36596) admin has added it.";

/** What `publish` throws when the file is the same as its base revision. */
class Unchanged extends Error {
  constructor(readonly revision: Revision) {
    super("Unchanged.");
  }
}

/**
 * A team this device saw the account in, as the Teams sheet would name it: its number and name, or
 * nulls when the membership could not read the team.
 */
export interface SeenTeam {
  teamId: string;
  number: number | null;
  name: string | null;
}

/** The teams the account is a member of in `memberships`, a request to join not counted. */
export function seenTeamsOf(memberships: readonly Membership[]): SeenTeam[] {
  return memberships
    .filter((m) => m.role !== "pending")
    .map((m) => ({ teamId: m.teamId, number: m.team?.number ?? null, name: m.team?.name ?? null }));
}

/**
 * The teams in `seen` that `memberships` no longer lists. A device that leaves or deletes a team
 * forgets it first, so these are teams the account was taken off some other way: removed by an owner
 * or admin, deleted by another member, or left from another device.
 */
export function lostTeams(seen: readonly SeenTeam[], memberships: readonly Membership[]): SeenTeam[] {
  return seen.filter((team) => !memberships.some((m) => m.teamId === team.teamId));
}

/** The seen teams as stored, or none when the value is missing or not what this device wrote. */
function readSeenTeams(text: string | null): SeenTeam[] {
  if (text === null) return [];
  try {
    const value = JSON.parse(text) as unknown;
    if (!Array.isArray(value)) return [];
    return value.filter(
      (entry): entry is SeenTeam =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as SeenTeam).teamId === "string" &&
        (typeof (entry as SeenTeam).number === "number" || (entry as SeenTeam).number === null) &&
        (typeof (entry as SeenTeam).name === "string" || (entry as SeenTeam).name === null),
    );
  } catch {
    return [];
  }
}

/** Why a pending member cannot be approved yet: their device has not asked for the key. */
export const NO_MEMBER_REQUEST =
  "Their device has not asked for the team key yet, so there is no code to type. Ask them to open Zenith again on the device they joined from.";

/** An owner's notice after removing a member, which offers a new recovery code. */
/** What a link share cannot take back: whoever has its link, a removed member included, still opens it. */
const LINKS_KEEP_WORKING =
  "Links the team made to share autos keep working for anyone who has them; to cut access, turn a link off or make a new one.";

/** The status line after removing a member; the whole notice is in the Teams sheet. */
export const REMOVED_STATUS = "Removed the member. See Teams for what to do next.";

export const REMOVED_LINKS_STAY = `Removed the member from the team. ${LINKS_KEEP_WORKING}`;

/**
 * The sentence a notice after a change of the team key adds when shares stopped with it: they were
 * made or last changed on a device the team removed, and get nothing new until shared again.
 */
export function stoppedSharesNotice(count: number): string {
  const shares = count === 1 ? "1 share" : `${String(count)} shares`;
  return `${shares} stopped, made or last changed on a removed device. Share ${count === 1 ? "it" : "them"} again from the Sharing page.`;
}

export const REMOVED_SUGGEST_NEW_CODE = `Removed the member from the team. If they ever saw the team's recovery code, make a new one: with the old code, a device that has never opened the team could be tricked into using a key they still have. ${LINKS_KEEP_WORKING}`;

const DEFAULT_SETTINGS: TeamSettings = {
  editorsMayProposeShare: false,
  editorsMayLinkShare: false,
  publishOnSave: false,
  membersMayApproveDevices: false,
};

const ROLE_ORDER: Record<Role, number> = { pending: 0, owner: 1, admin: 2, editor: 3, viewer: 4 };

/** Members waiting for approval first, then by role, then by name. */
export function sortMembers(members: readonly Member[]): Member[] {
  return [...members].sort(
    (a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || a.displayName.localeCompare(b.displayName),
  );
}
