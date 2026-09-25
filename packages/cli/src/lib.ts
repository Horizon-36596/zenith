/**
 * The CLI's reusable pieces, for another host of the same logic (the desktop app's main process).
 * This module has no side effects, unlike `index.ts`, which runs the
 * program when it is the entry point; import it as `@horizon36596/zenith-cli/lib` from a bundle that cannot take
 * the entry module's top-level await. `index.ts` re-exports all of it.
 */
export { confinePath, loadProject, ProjectError, type Project } from "./project.js";
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
