/**
 * The contract between the Zenith desktop app (`apps/desktop`) and this web build: the shape of
 * `window.zenithDesktop`, which the desktop app's preload script exposes and nothing else does
 * (site/docs/editor.md).
 *
 * This file is types only, with no DOM or Node access, so the desktop app's main process and preload
 * import them from here and both sides of the bridge are checked against one definition. The
 * detection (`desktopBridge()`) is in `desktop.ts`. Paths crossing the bridge are always relative to the
 * project root and use `/`; the main process confines every one of them to the root it opened.
 */

/**
 * Bumped when the bridge changes shape, so a web build never drives a desktop build it predates.
 * Version 2 added `cloudSignIn`, and version 3 added `saveCopy`.
 */
export const DESKTOP_API_VERSION = 3;

/** A robot repository the desktop app has opened: the folder holding `zenith.json`. */
export interface DesktopProjectRef {
  /** The absolute folder path, as the operating system spells it. */
  root: string;
  /** The folder's own name, for the toolbar and the recent list. */
  name: string;
}

/**
 * A folder Open folder picked (issue #159). `needsSetup` is true when it has no `zenith.json` yet:
 * the folder is granted, so Set up can read its code and write into it, but nothing is opened and
 * it is not on the recent list until Set up has written there. Optional, with no version bump: a
 * desktop build without it refuses such a folder as before.
 */
export interface DesktopPickedProject extends DesktopProjectRef {
  needsSetup?: boolean;
}

/** What Set up reads from a folder with no `zenith.json` before it asks anything (issue #159). */
export interface DesktopSetupScan {
  /** False when the folder has no TeamCode folder, so there was no code to read. */
  teamCode: boolean;
  /** The Java and Kotlin under TeamCode, with paths relative to the root and `/` separators. */
  sources: Array<{ path: string; text: string }>;
  /** Files Set up would write that are already in the folder; Set up writes nothing while there are any. */
  taken: string[];
  /**
   * The autos already in the folder and the files beside them (issue #496), or null when it holds
   * none. Optional, with no version bump: an older desktop build leaves it out and Set up writes the
   * five files as before.
   */
  existing?: DesktopExistingProject | null;
}

/**
 * A Zenith project already in a folder with no `zenith.json`: where its autos, robot, field and
 * waypoints are, relative to the root. Set up then writes `zenith.json` pointing at them, and a robot
 * or field only where there is none (`setupFiles.ts`, `inPlaceFileSet`).
 */
export interface DesktopExistingProject {
  autosDir: string;
  autos: string[];
  robot: string | null;
  field: string | null;
  waypoints: string | null;
}

/**
 * What Set up hands the desktop app (issue #159). Never a `zenith.json`: the main process builds it
 * from the command library, which must be one of the two, and the robot class, which must be a Java
 * class name, because `zenith.json` holds `sim.command`, which it runs. Main writes the waypoints,
 * the field and the skeleton auto itself.
 */
export interface DesktopSetupRequest {
  commandLibrary: "solverslib" | "ivy" | null;
  robotClass: string | null;
  /** The skeleton robot with the commands the scan found, as an object; main loads it with the schema. */
  robot: unknown;
  /**
   * Set up the autos already in the folder where they are (issue #496): main finds them itself and
   * writes `zenith.json` pointing at them, never over a file there. Left out for the five files.
   */
  inPlace?: true;
}

/** Where Set up wrote: the project, now on the recent list, and the files, in the order written. */
export interface DesktopSetupResult {
  project: DesktopProjectRef;
  written: string[];
}

export interface RecentProject extends DesktopProjectRef {
  /** Wall-clock milliseconds of the last open, newest first in the list. */
  openedAt: number;
}

/**
 * What Save the full project hands the desktop app (issue #103): the robot, field and waypoints
 * the editor has open and the autos, as text. Never a `zenith.json`: the main process writes its
 * own copy of the bundled example's, since `zenith.json` holds `sim.command`, which it runs.
 */
export interface DesktopProjectPayload {
  robot: string;
  field: string;
  waypoints: string | null;
  autos: Array<{ fileName: string; text: string }>;
}

/** Where Save just this auto put the auto: the project the person picked, and the auto's path in it. */
export interface DesktopAutoSaved {
  project: DesktopProjectRef;
  /** Relative to the project root, with `/` separators: `autos/first-auto.auto.json`. */
  path: string;
}

/**
 * The project Save just this auto picked, before anything is written (issue #158): where the auto
 * would go, and the waypoints file its `zenith.json` names, as text, so the editor can compare it
 * with the waypoints the auto follows and ask before it writes.
 */
export interface DesktopAutoTarget {
  project: DesktopProjectRef;
  /** Relative to the project root, with `/` separators: `autos/first-auto.auto.json`. */
  path: string;
  /** The waypoints file `zenith.json` names, relative to the root, or null when it names none. */
  waypointsPath: string | null;
  /** That file's text, or null when `zenith.json` names none or it cannot be read. */
  waypoints: string | null;
}

/** A file inside an open project changed on disk, and the change was not one of Zenith's writes. */
export interface DesktopFileChange {
  root: string;
  /** Relative to the root, with `/` separators. */
  path: string;
}

/**
 * How the high-fidelity sim runs (site/docs/full-sim-simloop.md, "Full sim speed"): `basic` runs
 * `zenith.json`'s `sim.command` for each run; `fast` keeps a sim server (`sim.server`) warm from the
 * first run until it has been idle a while; `ultrafast` starts it with the project and runs an auto
 * again in the background each time it is saved. A project with no `sim.server` always runs `basic`.
 */
export type DesktopSimSpeed = "basic" | "fast" | "ultrafast";

/** One event of a running high-fidelity sim. `runId` ties it to the `sim.start` call. */
export type DesktopSimEvent =
  | {
      runId: string;
      kind: "started";
      command: string;
      autoName: string;
      /** How this run is made; missing from a desktop build without the sim server, which is `basic`. */
      speed?: DesktopSimSpeed;
    }
  | { runId: string; kind: "line"; stream: "stdout" | "stderr"; text: string }
  | {
      runId: string;
      /**
       * Where a sim-server run is before its first rows: building the robot code, starting the
       * server, or giving up on it for this run and running `sim.command` instead (`fallback`, whose
       * message says why). After a `fallback`, rows already sent for this run are void.
       */
      kind: "status";
      status: "preparing" | "starting" | "fallback";
      message: string;
    }
  | {
      runId: string;
      /** A streamed run has begun: the trace file's header keys, everything but its arrays. */
      kind: "traceStart";
      header: unknown;
    }
  | {
      runId: string;
      /** More of a streamed run: rows to append to each of the trace's arrays, any of which may be missing. */
      kind: "rows";
      rows: unknown;
    }
  | {
      runId: string;
      kind: "done";
      /** The trace file as parsed JSON; the web side reads it with `core.parseTrace`. */
      trace: unknown;
      /** Relative to the project root. */
      tracePath: string;
      elapsedS: number;
      /** True when the rows were streamed first (`traceStart`, `rows`); the trace is the whole run either way. */
      streamed?: boolean;
      /** True when an Ultrafast background run of the same auto file had already made it. */
      cached?: boolean;
    }
  | {
      runId: string;
      kind: "failed";
      /** One or two plain sentences for someone who has never seen Gradle. */
      message: string;
      /** The last lines the command printed, for whoever wants the detail. */
      tail: string[];
      cancelled: boolean;
    };

export type DeployActionKind = "copy" | "write" | "keep" | "remove" | "skip";

export interface DesktopDeployAction {
  kind: DeployActionKind;
  /** Relative to the project root. */
  path: string;
  from?: string;
  reason?: string;
  /**
   * A skipped auto's "name", when its file loaded. Optional, with no version bump: a desktop build
   * without it leaves the panel to name the OpMode from the file name.
   */
  autoName?: string;
  /** False for a copy whose destination already had the same bytes, and for keep and skip. */
  changed: boolean;
}

export interface DesktopDeployResult {
  dryRun: boolean;
  actions: DesktopDeployAction[];
  /** Autos skipped because they have validation errors. */
  errors: number;
  /** How many files were (or would be) written, copied or removed with a different result. */
  changed: number;
  deployDir: string;
  /**
   * `zenith.json` `deploy.commandLibrary`: which runtime the generated stubs extend. Null only when
   * `zenith.json` has no `codegen` section, so the deploy writes no stubs, and names no library.
   */
  commandLibrary: "solverslib" | "ivy" | null;
  /**
   * Whether the deploy writes the `@Autonomous` stubs, which it does exactly when `zenith.json` has a
   * `codegen` section (issue #156). A library can be named while this is false. Optional, with no
   * version bump: a desktop build without it leaves the panel to infer it from `commandLibrary`.
   */
  stubs?: boolean;
}

export interface DesktopGitFile {
  /** Relative to the project root. */
  path: string;
  /** Two-letter porcelain status, e.g. ` M`, `??`, `A `. */
  status: string;
}

export interface DesktopGitStatus {
  isRepo: boolean;
  /** Null when HEAD is detached. */
  branch: string | null;
  /** The branch pull requests go into and Zenith never commits to or pushes. */
  base: string;
  onBase: boolean;
  /** The branch a commit would go to: the current one, or a new `auto/<name>/<who>` off the base. */
  workBranch: string | null;
  changedAutos: DesktopGitFile[];
  /** Changed files outside the autos directory, which Zenith never stages. */
  otherChanges: number;
  hasRemote: boolean;
  /** Commits on the branch the remote does not have yet; null when the branch has no upstream. */
  ahead: number | null;
}

export interface DesktopCommitResult {
  branch: string;
  createdBranch: boolean;
  sha: string;
  message: string;
  files: string[];
}

export interface DesktopPushResult {
  branch: string;
  remote: string;
}

export interface DesktopPullRequestResult {
  url: string;
  number: number;
  created: boolean;
}

export interface DesktopGitHubStatus {
  /** Where the token came from; null when there is none yet and the user must paste one. */
  source: "stored" | "gh" | "session" | null;
  login: string | null;
  /** False when the operating system offers no encryption, so a pasted token is kept for this session only. */
  canStore: boolean;
  /**
   * With no token, the GitHub CLI's state, so the git panel can say whether `gh auth login` would
   * help. Optional, with no version bump: an older desktop build leaves it out.
   */
  cli?: DesktopGhCliStatus["state"];
}

/**
 * Whether the GitHub CLI can sign GitHub mode in (issue #213): `ready` when `gh` is installed and
 * signed in to github.com, `signed-out` when it is installed and is not, `missing` when there is no
 * `gh` at all. The token is never part of it.
 */
export interface DesktopGhCliStatus {
  state: "ready" | "signed-out" | "missing";
}

/** A local clone's GitHub repository, from its `origin` remote, and the branch to open it at. */
export interface DesktopGitHubOrigin {
  owner: string;
  repo: string;
  /** The remote's default branch, else `main` or `master`, the same base the Commit panel uses. */
  base: string;
}

/**
 * A folder `zenith open` (or the MCP tool `zenith.app.open`) asked the app to open (issue #213), or
 * the sentence saying why it could not. The main process has already checked that the folder holds
 * a `zenith.json` and granted it, so the page opens it the way it reopens a recent one.
 */
export type DesktopOpenRequest =
  | {
      project: DesktopProjectRef;
      /** The auto to open first, as a file name in the autos folder, or null for the first one. */
      auto: string | null;
    }
  | { error: string };

/** The three ways to sign in to the optional cloud (spec 13 section 4.1). */
export type DesktopSignInProvider = "github" | "google" | "microsoft";

/** Whether this build of the desktop app can sign in with one provider, and if not, why not. */
export interface DesktopSignInAvailability {
  available: boolean;
  /** One sentence saying why the provider is off, or null when it is on. */
  reason: string | null;
}

export type DesktopSignInProviders = Record<DesktopSignInProvider, DesktopSignInAvailability>;

/**
 * What a sign-in through the system browser hands the page: exactly what Firebase's
 * `signInWithCredential` needs for that provider, and nothing more (ADR 0011). The shape matches
 * `NativeCredential` in the cloud package. The main process keeps none of it.
 */
export type DesktopSignInCredential =
  | { provider: "google"; idToken: string }
  | {
      provider: "microsoft";
      idToken: string;
      /** The nonce before hashing; the ID token carries its SHA-256 hash, which Firebase checks. */
      rawNonce: string;
    }
  | { provider: "github"; accessToken: string };

/** What the page shows while a sign-in waits on the browser. */
export type DesktopSignInProgress =
  | {
      provider: "google" | "microsoft";
      /** The provider's sign-in page is open in the system browser. */
      kind: "browser";
    }
  | {
      provider: "github";
      /** GitHub's device flow: the user types `userCode` at `verificationUri`, which is open in the browser. */
      kind: "code";
      userCode: string;
      verificationUri: string;
      /** Seconds until the code expires, as GitHub gave them. */
      expiresInS: number;
    };

/** A native menu item the web build carries out, named by an `ACTIONS` id or a `desktop.*` id. */
export interface DesktopMenuCommand {
  action: string;
  arg?: string;
}

/**
 * What the page tells the native menu about its keys: the resolved key of each menu item the person can
 * rebind, by the id of the action it runs, in the written form (`Ctrl Shift F5`, null for no key), and
 * the ids of the items its switches hide. Sent after load and after every change. An item left out
 * keeps its default key.
 */
export interface DesktopMenuKeys {
  keys: Record<string, string | null>;
  hidden: string[];
}

export interface ZenithDesktopBridge {
  readonly apiVersion: number;
  readonly platform: string;
  appVersion(): Promise<string>;

  project: {
    /** Shows the native folder picker. Null when the user cancels. */
    pick(): Promise<DesktopPickedProject | null>;
    recent(): Promise<RecentProject[]>;
    /** Opens a folder from the recent list again. */
    reopen(root: string): Promise<DesktopProjectRef>;
    listAutos(root: string): Promise<string[]>;
    read(root: string, path: string): Promise<string>;
    /**
     * Whether `<autosDir>/<fileName>` is there now, with case ignored as Windows and macOS disks do,
     * reading only `zenith.json` and the autos folder (issue #380). Rejects when the folder cannot be
     * listed. Optional, with no version bump: an older desktop build checks `listAutos` instead.
     */
    hasAuto?(root: string, fileName: string): Promise<boolean>;
    /** Writes `<autosDir>/<fileName>`; `fileName` must be a bare `*.auto.json` name. */
    writeAuto(root: string, fileName: string, text: string): Promise<void>;
    /**
     * Sets `deploy.commandLibrary` in `zenith.json` at the root and resolves with the text written.
     * It takes a library name, never file text: the main process reads the file, changes that one key
     * and refuses any other value, since `zenith.json` also holds `sim.command`, which it runs.
     * Optional, with no version bump: a desktop build without it still runs this web build, and
     * Settings says it cannot change the project's command library there.
     */
    setCommandLibrary?(root: string, library: "solverslib" | "ivy"): Promise<string>;
    /**
     * Writes the robot file `zenith.json` names from a robot object and resolves with the canonical
     * text written. It takes an object, never file text or a path: the main process loads it with
     * the schema, refuses anything that is not a valid robot, and writes only that one file.
     * Optional, with no version bump, like `setCommandLibrary`: an older desktop build leaves the
     * Robot and Commands sections in Settings read only.
     */
    writeRobot?(root: string, robot: unknown): Promise<string>;
    /**
     * Writes the waypoints file `zenith.json` names from a waypoints object and resolves with the
     * canonical text written (issue #134). Like `writeRobot` it takes an object, never file text or
     * a path: the main process loads it with the schema and writes only that one file. Optional,
     * with no version bump: with an older desktop build, waypoint editing is off and says why.
     */
    writeWaypoints?(root: string, waypoints: unknown): Promise<string>;
    /**
     * The preset files in `<autosDir>/presets/` (spec 15 section 6.5), as bare names, sorted; none
     * when the folder is missing. Each is read with `read`. Optional, with no version bump: with an
     * older desktop build Settings shows no project presets.
     */
    listPresets?(root: string): Promise<string[]>;
    /**
     * Writes `<autosDir>/presets/<fileName>`, making the folder when it is missing: Add to project.
     * `fileName` must be a bare `*.zenith-preset.json` name, and `text` a preset file of at most
     * 64 KB; main checks its `kind` and `presetVersion` and refuses anything else. Optional, with no
     * version bump: with an older desktop build Add to project is off and says why.
     */
    writePreset?(root: string, fileName: string, text: string): Promise<void>;
    /**
     * Save the full project (issue #103): shows the native folder picker, and writes a new project
     * into the folder picked, which must be empty but for hidden entries, so never a robot
     * repository (issue #159). Its zenith.json names no sim command, robot class or command
     * library. Resolves with the folder,
     * now open-able like any picked one, or null when the person cancelled. Optional, with no
     * version bump, like `setCommandLibrary`: without it Save the full project downloads a zip.
     */
    saveFullProject?(payload: DesktopProjectPayload): Promise<DesktopProjectRef | null>;
    /**
     * Save just this auto (issue #103): shows the native folder picker for an existing project (the
     * folder with `zenith.json`) and writes the auto into the autos folder its `zenith.json` names,
     * never over a file already there. Null when the person cancelled. Optional, like the above.
     */
    saveAutoInto?(fileName: string, text: string): Promise<DesktopAutoSaved | null>;
    /**
     * Save just this auto in two steps (issue #158), so the editor sees the project picked before
     * anything is written. `pickAutoTarget` shows the native folder picker for an existing project,
     * checks it as `saveAutoInto` does and writes nothing; null when the person cancelled. The folder
     * is then granted, as a picked one is. `writeAutoInto` writes the auto into it, in canonical form
     * and never over a file already there, after adding `addWaypoints` (name to waypoint) to the
     * waypoints file `zenith.json` names, never over a name already there. Optional, with no version
     * bump, like the above: without them Save just this auto uses `saveAutoInto`.
     */
    pickAutoTarget?(fileName: string): Promise<DesktopAutoTarget | null>;
    writeAutoInto?(
      root: string,
      fileName: string,
      text: string,
      addWaypoints: Record<string, unknown> | null,
    ): Promise<DesktopAutoSaved>;
    /**
     * Set up Zenith in a folder `pick` returned with `needsSetup` (issue #159). `setupScan` reads the
     * Java and Kotlin under its TeamCode folder and says which of Set up's files are already there,
     * writing nothing. `setup` writes `zenith.json`, the robot, the waypoints, the season's field and
     * one skeleton auto, never over a file already there; a refusal writes nothing. Optional, with no
     * version bump: without them Open folder says the folder has no `zenith.json`, as before.
     */
    setupScan?(root: string): Promise<DesktopSetupScan>;
    setup?(root: string, request: DesktopSetupRequest): Promise<DesktopSetupResult>;
    /**
     * The GitHub repository an open folder is a clone of, read from its `origin` remote, or null
     * when the folder is not a git clone or its origin is not on github.com (issue #213). Optional,
     * with no version bump: without it the open-project dialog makes no such offer.
     */
    githubOrigin?(root: string): Promise<DesktopGitHubOrigin | null>;
    /** Starts reporting external edits to the project's files. Replaces any earlier watch. */
    watch(root: string): Promise<void>;
    onChange(listener: (change: DesktopFileChange) => void): () => void;
  };

  /**
   * Shows the native Save As dialog for a copy of an auto that cannot be saved in place (the
   * bundled example, or files opened on their own), and writes `text` where the person chose.
   * Resolves with the saved file's name, or null when they cancelled the dialog. Closing the window
   * waits on it, so the close goes ahead only once the copy is on disk.
   */
  saveCopy(suggestedName: string, text: string): Promise<string | null>;

  /**
   * Saves a file the page made (a picture of the auto, or a copy of it) through the native Save As
   * dialog, and resolves with the saved file's name only once it is written, or null when the person
   * cancelled. A plain download cannot say either: the desktop app's own Save dialog decides, and the
   * page would claim a download that never happened. `data` is text, or bytes for a PNG. Optional,
   * with no version bump: an older desktop build leaves it out and the page downloads as before.
   */
  saveFile?(suggestedName: string, data: string | Uint8Array): Promise<string | null>;

  /**
   * The page's unsaved edits, kept by the main process in memory, so a crash does not lose them
   * (apps/desktop/src/main/crashRecovery.ts). `hold` sends the latest, or null once there are none;
   * `take` hands them back once, to a page reloaded after a crash, and null to any other page.
   * Optional, with no version bump.
   */
  drafts?: {
    hold(draft: DesktopDraft | null): Promise<void>;
    take(): Promise<DesktopDraft | null>;
  };

  /**
   * A newer Zenith on the releases page, or null when this one is the newest or the check could not
   * reach GitHub. Asked once at start-up. Optional, with no version bump.
   */
  updates?: {
    check(): Promise<DesktopUpdate | null>;
  };

  sim: {
    /**
     * Starts the high-fidelity sim for one auto and resolves with its run id: `zenith.json`'s sim
     * command, or its sim server at the Fast and Ultrafast speeds. `options` is optional, with no
     * version bump: an older desktop build ignores it and runs the sim command.
     */
    start(root: string, fileName: string, options?: { speed?: DesktopSimSpeed }): Promise<string>;
    /**
     * Tells the desktop app which project is open and the person's Full sim speed, after an open and
     * after every change, so Ultrafast can start the sim server with the project and Basic can stop
     * it. A null root closes it. Optional, with no version bump, like `start`'s options.
     */
    configure?(root: string | null, speed: DesktopSimSpeed): Promise<void>;
    cancel(runId: string): Promise<void>;
    onEvent(listener: (event: DesktopSimEvent) => void): () => void;
  };

  deploy: {
    run(root: string, options: { dryRun: boolean }): Promise<DesktopDeployResult>;
  };

  git: {
    status(root: string, fileName: string | null): Promise<DesktopGitStatus>;
    commit(root: string, input: { fileName: string; summary: string }): Promise<DesktopCommitResult>;
    push(root: string): Promise<DesktopPushResult>;
    openPullRequest(root: string, input: { fileName: string }): Promise<DesktopPullRequestResult>;
  };

  github: {
    status(): Promise<DesktopGitHubStatus>;
    /**
     * Checks a pasted personal access token against GitHub and keeps it encrypted, or until Zenith
     * closes when `remember` is false. An older desktop build ignores `remember` and keeps it.
     */
    setToken(token: string, remember?: boolean): Promise<DesktopGitHubStatus>;
    forgetToken(): Promise<DesktopGitHubStatus>;
    /**
     * Whether the GitHub CLI is installed and signed in, so the sign-in dialog can offer it
     * (issue #213). It never carries the token. Optional, with no version bump, like `cliToken`.
     */
    cliStatus?(): Promise<DesktopGhCliStatus>;
    /**
     * The GitHub CLI's token for github.com (`gh auth token`), for GitHub mode in this page. The page
     * holds it in memory only: never in storage, a URL or a log, and only ever sent to
     * api.github.com. Rejects with a sentence when the CLI is missing or signed out.
     */
    cliToken?(): Promise<string>;
    /**
     * Whether "Sign in with GitHub" works in GitHub mode here: it needs this build's GitHub OAuth
     * client (the same one the cloud sign-in uses), not the cloud. Optional, with no version bump.
     */
    oauthAvailability?(): Promise<DesktopSignInAvailability>;
    /**
     * "Sign in with GitHub" for GitHub mode: GitHub's device flow with the `repo` scope, shown through
     * `cloudSignIn.onProgress` and stopped by `cloudSignIn.cancel`. Resolves with GitHub's token,
     * which the page keeps exactly as it keeps a pasted one; the main process keeps nothing.
     */
    oauthToken?(): Promise<string>;
  };

  /**
   * Folders `zenith open` asked the app to open (issue #213). `take` hands over the waiting request,
   * once, or null; `onRequest` says one is waiting. Optional, with no version bump: an older desktop
   * build simply never has one.
   */
  openRequests?: {
    take(): Promise<DesktopOpenRequest | null>;
    onRequest(listener: () => void): () => void;
  };

  /**
   * Signing in to the optional cloud through the system browser (ADR 0011), because Firebase's
   * popup refuses a page on the app's own `zenith://` address.
   */
  cloudSignIn: {
    /** Which providers this build has an OAuth client for. */
    providers(): Promise<DesktopSignInProviders>;
    /**
     * Runs one sign-in in the browser and resolves with the credential for Firebase. Starting
     * another cancels the one before. Rejects with a sentence when it is cancelled, times out or
     * is refused.
     */
    start(provider: DesktopSignInProvider): Promise<DesktopSignInCredential>;
    cancel(): Promise<void>;
    onProgress(listener: (progress: DesktopSignInProgress) => void): () => void;
  };

  /**
   * Opens the native application menu as a popup at `(x, y)` in the page's CSS pixels. The window
   * has no menu bar of its own (the title bar is the web build's, UI_GUIDE section 9.1), so this is
   * how the menu button, Alt and F10 reach File, Edit, View, Robot and Help.
   */
  showMenu(x: number, y: number): Promise<void>;

  onMenu(listener: (command: DesktopMenuCommand) => void): () => void;

  /**
   * Tells the native menu which key each of its items shows and registers, and which items are
   * hidden. The main process refuses a message with an unknown id, a key the menu cannot show, or a
   * reserved one, and leaves the menu as it was. Optional, with no version bump: a desktop build
   * without it keeps the default keys, and the page then shows those keys as fixed.
   */
  setMenuKeys?(keys: DesktopMenuKeys): Promise<void>;

  /**
   * Closing the window or quitting asks the page first (QA-12). Subscribing tells main this page
   * can answer; each request must be answered with `answerClose`: true when the window may close
   * (nothing unsaved, Discard, or a Save that went through), false to keep it open.
   */
  onCloseRequest(listener: () => void): () => void;
  answerClose(ok: boolean): Promise<void>;

  /**
   * The window's back and forward commands (issue #83): on Windows, a mouse's side buttons and a
   * keyboard's Back and Forward keys reach the window as `app-command` events, which main forwards
   * here. Optional, so adding it did not change the bridge's version: a bridge without it simply
   * sends none, and the page still hears the side buttons as mouse events.
   */
  onNavigate?(listener: (direction: DesktopNavigation) => void): () => void;
}

/** The unsaved edits the main process keeps for a crash: the open auto, as canonical text. */
export interface DesktopDraft {
  /** The project folder the auto is in, or null for one that has none (the example, picked files). */
  root: string | null;
  fileName: string;
  text: string;
}

/** A Zenith release newer than this one. */
export interface DesktopUpdate {
  version: string;
  /** The release's page on github.com. */
  url: string;
}

/** A step back or forward between screens, as the desktop window's `app-command` names it. */
export type DesktopNavigation = "back" | "forward";
