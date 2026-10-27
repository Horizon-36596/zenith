/**
 * An auto may name its own robot or field file (`auto.robot`/`auto.field`); when it does, that file
 * wins over `zenith.json`'s, resolved through the project's `ProjectBackend` relative to the project
 * root exactly like `backend.readAuto` resolves the auto itself. The CLI
 * (`packages/cli/src/autoLoad.ts`'s `override`) and MCP (`packages/mcp/src/findings.ts`'s
 * `override`) already apply this; the web editor did not (finding 23), so the same document could
 * validate differently in the browser than at the command line.
 *
 * A broken override (missing file, bad JSON, fails its own schema) falls back to the project's own
 * robot/field rather than leaving the editor stuck, the same way the other two front ends do.
 */
import { loadField, loadRobot } from "@horizon36596/zenith-core";
import type { Auto, Field, Robot } from "@horizon36596/zenith-schema";
import type { ProjectBackend } from "./backend";
import type { Project } from "./types";

export interface ResolvedOverrides {
  robot: Robot;
  field: Field;
  /** Set when `auto.robot` or `auto.field` named a file that could not be read or parsed. */
  error: string | null;
}

/** A repository path in one spelling, so `./autos/robot.json` and `autos/robot.json` compare equal. */
const samePath = (a: string, b: string): boolean => {
  const norm = (path: string): string => path.replaceAll("\\", "/").replace(/^(\.\/)+/, "");
  return norm(a) === norm(b);
};

async function overrideOf<T>(
  backend: ProjectBackend,
  path: string | undefined,
  projectPath: string,
  load: (json: unknown) => T,
  fallback: T,
): Promise<{ value: T; error: string | null }> {
  // Naming the project's own file is no override: it is already loaded, and a project opened from
  // picked files or the bundled example cannot read a file by its path a second time.
  if (path === undefined || samePath(path, projectPath)) return { value: fallback, error: null };
  try {
    const text = await backend.readText(path);
    return { value: load(JSON.parse(text) as unknown), error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { value: fallback, error: `Cannot use ${path}: ${message}` };
  }
}

/** Resolves `auto.robot`/`auto.field` against the backend, falling back to `project`'s own. */
export async function resolveAutoOverrides(
  project: Project,
  backend: ProjectBackend,
  auto: Auto,
): Promise<ResolvedOverrides> {
  const robotResult = await overrideOf(backend, auto.robot, project.link.robot, loadRobot, project.robot);
  const fieldResult = await overrideOf(backend, auto.field, project.link.field, loadField, project.field);
  return {
    robot: robotResult.value,
    field: fieldResult.value,
    error: robotResult.error ?? fieldResult.error,
  };
}
