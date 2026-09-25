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

/** Bumped when the bridge changes shape, so a web build never drives a desktop build it predates. */
export const DESKTOP_API_VERSION = 1;

/** A robot repository the desktop app has opened: the folder holding `zenith.json`. */
export interface DesktopProjectRef {
  /** The absolute folder path, as the operating system spells it. */
  root: string;
  /** The folder's own name, for the toolbar and the recent list. */
  name: string;
}

export interface RecentProject extends DesktopProjectRef {
  /** Wall-clock milliseconds of the last open, newest first in the list. */
  openedAt: number;
}

/** A file inside an open project changed on disk, and the change was not one of Zenith's writes. */
export interface DesktopFileChange {
  root: string;
  /** Relative to the root, with `/` separators. */
  path: string;
}

/** One event of a running high-fidelity sim. `runId` ties it to the `sim.start` call. */
export type DesktopSimEvent =
  | { runId: string; kind: "started"; command: string; autoName: string }
  | { runId: string; kind: "line"; stream: "stdout" | "stderr"; text: string }
  | {
      runId: string;
      kind: "done";
      /** The trace file as parsed JSON; the web side reads it with `core.parseTrace`. */
      trace: unknown;
      /** Relative to the project root. */
      tracePath: string;
      elapsedS: number;
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
}

/** A native menu item the web build carries out, named by an `ACTIONS` id or a `desktop.*` id. */
export interface DesktopMenuCommand {
  action: string;
  arg?: string;
}

export interface ZenithDesktopBridge {
  readonly apiVersion: number;
  readonly platform: string;
  appVersion(): Promise<string>;

  project: {
    /** Shows the native folder picker. Null when the user cancels. */
    pick(): Promise<DesktopProjectRef | null>;
    recent(): Promise<RecentProject[]>;
    /** Opens a folder from the recent list again. */
    reopen(root: string): Promise<DesktopProjectRef>;
    listAutos(root: string): Promise<string[]>;
    read(root: string, path: string): Promise<string>;
    /** Writes `<autosDir>/<fileName>`; `fileName` must be a bare `*.auto.json` name. */
    writeAuto(root: string, fileName: string, text: string): Promise<void>;
    /** Starts reporting external edits to the project's files. Replaces any earlier watch. */
    watch(root: string): Promise<void>;
    onChange(listener: (change: DesktopFileChange) => void): () => void;
  };

  sim: {
    /** Starts `zenith.json`'s sim command for one auto and resolves with its run id. */
    start(root: string, fileName: string): Promise<string>;
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
    /** Checks a pasted personal access token against GitHub and keeps it encrypted. */
    setToken(token: string): Promise<DesktopGitHubStatus>;
    forgetToken(): Promise<DesktopGitHubStatus>;
  };

  /**
   * Opens the native application menu as a popup at `(x, y)` in the page's CSS pixels. The window
   * has no menu bar of its own (the title bar is the web build's, UI_GUIDE section 9.1), so this is
   * how the menu button, Alt and F10 reach File, Edit, View, Robot and Help.
   */
  showMenu(x: number, y: number): Promise<void>;

  onMenu(listener: (command: DesktopMenuCommand) => void): () => void;

  /**
   * Closing the window or quitting asks the page first (QA-12). Subscribing tells main this page
   * can answer; each request must be answered with `answerClose`: true when the window may close
   * (nothing unsaved, Discard, or a Save that went through), false to keep it open.
   */
  onCloseRequest(listener: () => void): () => void;
  answerClose(ok: boolean): Promise<void>;
}
