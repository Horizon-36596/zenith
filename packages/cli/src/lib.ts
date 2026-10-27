/**
 * The CLI's reusable pieces, for another host of the same logic (the desktop app's main process).
 * This module has no side effects, unlike `index.ts`, which runs the
 * program when it is the entry point; import it as `@horizon36596/zenith-cli/lib` from a bundle that cannot take
 * the entry module's top-level await. `index.ts` re-exports all of it.
 */
export { confinePath, loadProject, ProjectError, type Project } from "./project.js";
export { isEntryPoint } from "./entryPoint.js";
export { splitShellWords } from "./commands/sim.js";
export {
  findJava,
  hostPlatform,
  LauncherError,
  MissingToolError,
  resolveLauncher,
  withRerun,
  type Platform,
  type SimLaunch,
} from "./launcher.js";
export {
  applyDeploy,
  planDeploy,
  type DeployAction,
  type DeployActionKind,
  type DeployPlan,
} from "./commands/deploy.js";
export { AUTO_NAME_PATTERN, loadAutoAndPlan, type LoadAutoResult, type LoadedAuto } from "./autoLoad.js";
export { tryCore, type CoreResult } from "./coreGate.js";
export {
  AUTO_SWITCH,
  DesktopAppError,
  findDesktopApp,
  openInDesktop,
  OPEN_SWITCH,
  planDesktopOpen,
  type DesktopAppEnv,
  type DesktopOpenInput,
  type DesktopOpenPlan,
  type Launcher,
} from "./desktopApp.js";
export {
  bundledSeasonField,
  interchangeKindOf,
  readInterchange,
  validateInterchange,
  type InterchangeFinding,
  type InterchangeKind,
  type InterchangeValidation,
} from "./interchange.js";
export {
  importDocument,
  importKindOf,
  ImportUsageError,
  type ImportDocumentOptions,
  type ImportedDocument,
  type ImportKind,
} from "./commands/import.js";
export { buildProjectionFile, type ProjectionChoices } from "./commands/projection.js";
export { initProject, type InitResult } from "./commands/init.js";
export {
  defaultGitHubDeps,
  NextStepError,
  nodeRunner,
  redactCredentials,
  type GitHubDeps,
} from "./github.js";
export {
  connectGitHub,
  githubStatus,
  type GitHubConnection,
  type GitHubStatus,
  type StatusPullRequest,
} from "./commands/githubStatus.js";
export { MCP_SERVER_ENTRY, mergeMcpConfig, setup, type SetupAuto, type SetupResult } from "./commands/setup.js";
export {
  prepareProposal,
  proposeDryRun,
  proposeToGitHub,
  type BlockedProposal,
  type DryRunProposal,
  type GitHubProposal,
  type PreparedProposal,
} from "./commands/propose.js";
export { allianceReport, type AllianceReport, type AlliancePartnerReport } from "./commands/alliance.js";
export {
  importCommands,
  configuredRegistryFindings,
  readJavaSources,
  registryFileFindings,
  type ImportCommandsOptions,
  type ImportCommandsResult,
} from "./commands/importCommands.js";
