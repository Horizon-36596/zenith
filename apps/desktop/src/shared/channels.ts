/**
 * The IPC channel names between the preload script and the main process. Requests go through
 * `ipcRenderer.invoke`; the three event channels are pushed from main with `webContents.send`.
 */
export const CHANNELS = {
  appVersion: "zenith:app-version",
  projectPick: "zenith:project-pick",
  projectRecent: "zenith:project-recent",
  projectReopen: "zenith:project-reopen",
  projectListAutos: "zenith:project-list-autos",
  projectRead: "zenith:project-read",
  projectWriteAuto: "zenith:project-write-auto",
  projectWatch: "zenith:project-watch",
  simStart: "zenith:sim-start",
  simCancel: "zenith:sim-cancel",
  deployRun: "zenith:deploy-run",
  gitStatus: "zenith:git-status",
  gitCommit: "zenith:git-commit",
  gitPush: "zenith:git-push",
  gitPullRequest: "zenith:git-pull-request",
  githubStatus: "zenith:github-status",
  githubSetToken: "zenith:github-set-token",
  githubForgetToken: "zenith:github-forget-token",
  menuShow: "zenith:menu-show",
  closeListen: "zenith:close-listen",
  closeAnswer: "zenith:close-answer",
} as const;

export const EVENTS = {
  fileChanged: "zenith:file-changed",
  simEvent: "zenith:sim-event",
  menu: "zenith:menu",
  closeRequest: "zenith:close-request",
} as const;

/** How a handler's failure crosses the bridge: the message only, never a stack. */
export interface IpcFailure {
  __zenithError: string;
}
