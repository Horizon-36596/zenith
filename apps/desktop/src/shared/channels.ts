/**
 * The IPC channel names between the preload script and the main process. Requests go through
 * `ipcRenderer.invoke`; the event channels are pushed from main with `webContents.send`.
 */
export const CHANNELS = {
  appVersion: "zenith:app-version",
  projectPick: "zenith:project-pick",
  projectRecent: "zenith:project-recent",
  projectReopen: "zenith:project-reopen",
  projectListAutos: "zenith:project-list-autos",
  projectRead: "zenith:project-read",
  projectHasAuto: "zenith:project-has-auto",
  projectWriteAuto: "zenith:project-write-auto",
  projectSetCommandLibrary: "zenith:project-set-command-library",
  projectWriteRobot: "zenith:project-write-robot",
  projectWriteWaypoints: "zenith:project-write-waypoints",
  projectListPresets: "zenith:project-list-presets",
  projectWritePreset: "zenith:project-write-preset",
  projectWatch: "zenith:project-watch",
  projectSaveFull: "zenith:project-save-full",
  projectSaveAutoInto: "zenith:project-save-auto-into",
  projectPickAutoTarget: "zenith:project-pick-auto-target",
  projectWriteAutoInto: "zenith:project-write-auto-into",
  projectSetupScan: "zenith:project-setup-scan",
  projectSetup: "zenith:project-setup",
  projectGitHubOrigin: "zenith:project-github-origin",
  saveCopy: "zenith:save-copy",
  saveFile: "zenith:save-file",
  draftHold: "zenith:draft-hold",
  draftTake: "zenith:draft-take",
  updateCheck: "zenith:update-check",
  simStart: "zenith:sim-start",
  simCancel: "zenith:sim-cancel",
  simConfigure: "zenith:sim-configure",
  deployRun: "zenith:deploy-run",
  gitStatus: "zenith:git-status",
  gitCommit: "zenith:git-commit",
  gitPush: "zenith:git-push",
  gitPullRequest: "zenith:git-pull-request",
  githubStatus: "zenith:github-status",
  githubSetToken: "zenith:github-set-token",
  githubForgetToken: "zenith:github-forget-token",
  githubCliStatus: "zenith:github-cli-status",
  githubCliToken: "zenith:github-cli-token",
  openRequestTake: "zenith:open-request-take",
  menuShow: "zenith:menu-show",
  menuKeys: "zenith:menu-keys",
  closeListen: "zenith:close-listen",
  closeAnswer: "zenith:close-answer",
  signInProviders: "zenith:sign-in-providers",
  signInStart: "zenith:sign-in-start",
  signInCancel: "zenith:sign-in-cancel",
  signInRepoAvailability: "zenith:sign-in-repo-availability",
  signInRepoStart: "zenith:sign-in-repo-start",
} as const;

export const EVENTS = {
  fileChanged: "zenith:file-changed",
  simEvent: "zenith:sim-event",
  menu: "zenith:menu",
  closeRequest: "zenith:close-request",
  signInProgress: "zenith:sign-in-progress",
  navigate: "zenith:navigate",
  openRequest: "zenith:open-request",
} as const;

/** How a handler's failure crosses the bridge: the message only, never a stack. */
export interface IpcFailure {
  __zenithError: string;
}
