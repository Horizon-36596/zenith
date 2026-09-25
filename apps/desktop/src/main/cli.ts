/**
 * The CLI logic the desktop app reuses, in one place.
 *
 * These come from `@horizon36596/zenith-cli/lib`, the CLI's side-effect-free library entry, rather than from
 * `@horizon36596/zenith-cli` itself: the CLI's `index.ts` runs the program with a top-level await when it is the
 * entry point, which esbuild cannot bundle into this CommonJS main process. esbuild bundles
 * `@horizon36596/zenith-cli/lib` into the main process.
 */
export {
  AUTO_NAME_PATTERN,
  applyDeploy,
  confinePath,
  findJava,
  hostPlatform,
  LauncherError,
  loadAutoAndPlan,
  loadProject,
  MissingToolError,
  planDeploy,
  ProjectError,
  resolveLauncher,
  splitShellWords,
  tryCore,
  withRerun,
  type Platform,
  type SimLaunch,
  type DeployAction,
  type DeployPlan,
  type LoadedAuto,
  type Project,
} from "@horizon36596/zenith-cli/lib";
