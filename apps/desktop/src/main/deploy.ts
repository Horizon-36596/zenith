/**
 * The Deploy button: `zenith deploy`, in process. Copies every valid auto, the waypoints, the robot
 * and the field file into `zenith.json`'s `deploy.dir` and writes or refreshes the generated
 * `@Autonomous` stubs, using the CLI's own `planDeploy` and `applyDeploy`
 * (packages/cli/src/commands/deploy.ts), so the button and the command can never disagree about
 * what a deploy is. Nothing is built or installed on the robot; that stays out of scope
 * (site/docs/editor.md).
 *
 * What this adds is the answer to "what changed?": each action is marked with whether it actually
 * changes a file, worked out before anything is written.
 */
import { existsSync, readFileSync } from "node:fs";
import type { DesktopDeployAction, DesktopDeployResult } from "../../../web/src/project/desktopBridge.js";
import { applyDeploy, confinePath, planDeploy, type DeployAction, type Project } from "./cli.js";
import { BridgeError } from "./confine.js";
import { loadDesktopProject } from "./project.js";

const sameBytes = (a: string, b: string): boolean => {
  if (!existsSync(a) || !existsSync(b)) return false;
  return readFileSync(a).equals(readFileSync(b));
};

/** Whether applying `action` would leave a file different from how it is now. */
export function changes(project: Project, action: DeployAction): boolean {
  switch (action.kind) {
    case "copy":
      return action.from === undefined
        ? false
        : !sameBytes(confinePath(project.root, action.from), confinePath(project.root, action.path));
    case "write":
    case "remove":
      return true;
    default:
      return false;
  }
}

export function runDeploy(root: string, dryRun: boolean): DesktopDeployResult {
  const project = loadDesktopProject(root);
  if (project.link.deploy === undefined) {
    throw new BridgeError('zenith.json has no "deploy" section, so Zenith does not know where the robot reads autos from.');
  }
  let plan;
  try {
    plan = planDeploy(project);
  } catch (error) {
    throw new BridgeError(error instanceof Error ? error.message : String(error));
  }
  const actions: DesktopDeployAction[] = plan.actions.map((action) => ({
    kind: action.kind,
    path: action.path,
    ...(action.from === undefined ? {} : { from: action.from }),
    ...(action.reason === undefined ? {} : { reason: action.reason }),
    changed: changes(project, action),
  }));
  if (!dryRun) applyDeploy(project, plan);
  return {
    dryRun,
    actions,
    errors: plan.errors,
    changed: actions.filter((action) => action.changed).length,
    deployDir: project.link.deploy.dir,
    commandLibrary: plan.commandLibrary ?? null,
  };
}
