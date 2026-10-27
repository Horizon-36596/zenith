import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve as resolvePath } from "node:path";
import { canonicalize, hasErrors, projectShare, ProjectionError, runLedger, simulate } from "@horizon36596/zenith-core";
import type { Projection } from "@horizon36596/zenith-schema";
import { resolveSeason } from "@horizon36596/zenith-seasons";
import { loadAutoAndPlan, resolveAutoPath, type LoadedAuto } from "../autoLoad.js";
import { formatFindingsTable, type FileFindings } from "../findings.js";
import { loadProject } from "../project.js";

export interface ProjectionOptions {
  cwd?: string;
  project?: string;
  json?: boolean;
  /** `view` (the default) or `propose`. */
  level?: string;
  /** The title the other team sees. The auto's own title is never sent unless it is passed here. */
  title?: string;
  /** Round the timed layer to 2 in, 5 degrees and 0.25 s instead of 0.5 in, 1 degree and 1 ms. */
  coarsen?: boolean;
  /**
   * Add the optional `commands` list, which names each command token with its arguments: the share
   * dialog's "Include command names" checkbox. Off by default, and off leaves the projection byte
   * for byte what it was without the option.
   */
  includeCommands?: boolean;
  /** Where to write the projection. Absent: print it on stdout. */
  out?: string;
  force?: boolean;
}

/** What `zenith projection --json` prints. */
export interface ProjectionReport {
  project: string;
  auto: string;
  level: "view" | "propose";
  /** The file written, relative to the working directory, or null when the projection was printed. */
  written: string | null;
  /** The projection's size in canonical form, in bytes. */
  bytes: number;
  projection: Projection;
  /** Full sentences when the season plugin is missing: the claims may be incomplete. */
  seasonWarnings: string[];
}

const slash = (path: string): string => path.split("\\").join("/");

/** What a projection file is built at: the choices the share dialog offers. */
export interface ProjectionChoices {
  level: "view" | "propose";
  title?: string;
  coarsen?: boolean;
  /** The "Include command names" checkbox, off by default. */
  includeCommands?: boolean;
}

/**
 * The projection a share of a loaded auto would send, and its canonical text: the one code path
 * `zenith projection` and the MCP server's `zenith.projection` share. It is built as the editor's
 * share dialog builds it: the ledger with the season's rules, the instant sim run with that ledger
 * (the editor's own run, so a branch the ledger can read takes the same side), and core's
 * `projectShare`. Throws `ProjectionError` when the projection would
 * break its own caps.
 */
export function buildProjectionFile(
  loaded: Pick<LoadedAuto, "plan" | "robot" | "field">,
  choices: ProjectionChoices,
): { projection: Projection; text: string; bytes: number } {
  const { plan, robot, field } = loaded;
  const season = resolveSeason(field).rules;
  const ledger = runLedger(plan, field, season);
  const trace = simulate(plan, robot, field, { ledger, season });
  const projection = projectShare(
    { plan, trace, robot, field, ledger },
    {
      level: choices.level,
      ...(choices.title === undefined ? {} : { title: choices.title }),
      ...(choices.coarsen === true ? { coarsen: true } : {}),
      ...(choices.includeCommands === true ? { includeCommands: true } : {}),
    },
  );
  const text = canonicalize("projection", projection);
  return { projection, text, bytes: new TextEncoder().encode(text).length };
}

/**
 * `zenith projection <auto> [--level view|propose] [--title <text>] [--coarsen] [--include-commands]
 * [--out <file>]`:
 * writes the projection a share of `<auto>` would send, as a file, without the cloud (spec 13
 * section 8.2). It is built exactly as the editor's share dialog builds it: the instant sim's run of
 * the auto, the ledger with the season's rules, and core's `projectShare`, in canonical form. A
 * partner loads the file in the Partners panel or passes it to `zenith alliance`.
 *
 * Exit codes: 0 written or printed; 1 the auto has an error, so there is nothing to share, or the
 * projection would break its own caps (a run over 300 s, say); 2 a usage or IO problem. Under
 * `--json` an exit 2 prints `{ error }`.
 */
export function runProjection(autoArg: string, options: ProjectionOptions): number {
  const cwd = options.cwd ?? process.cwd();
  const fail = (message: string): number => {
    if (options.json === true) process.stdout.write(`${JSON.stringify({ error: `zenith projection: ${message}` }, null, 2)}\n`);
    else process.stderr.write(`zenith projection: ${message}\n`);
    return 2;
  };
  const level = options.level ?? "view";
  if (level !== "view" && level !== "propose") return fail(`--level must be view or propose, not ${JSON.stringify(level)}.`);
  const outPath = options.out === undefined ? undefined : isAbsolute(options.out) ? options.out : resolvePath(cwd, options.out);
  if (outPath !== undefined && existsSync(outPath) && options.force !== true) {
    return fail(`${options.out ?? ""} already exists. Pass --force to overwrite it.`);
  }

  const project = loadProject(cwd, options.project, autoArg);
  const path = resolveAutoPath(cwd, project, autoArg);
  const relPath = slash(relative(project.root, path));
  const result = loadAutoAndPlan(path, project);
  const findings = result.ok ? result.loaded.findings : result.findings;
  if (!result.ok || hasErrors(findings)) {
    // As in the editor's Download share file: an auto with an error has nothing to share yet.
    const files: FileFindings[] = [{ path: relPath, findings }];
    if (options.json === true) process.stdout.write(`${JSON.stringify({ project: slash(project.root), files }, null, 2)}\n`);
    else process.stdout.write(`${formatFindingsTable(files)}\nThis auto has errors, so there is nothing to share yet. Fix them first.\n`);
    return 1;
  }

  const { seasonWarnings } = result.loaded;
  let built: ReturnType<typeof buildProjectionFile>;
  try {
    built = buildProjectionFile(result.loaded, {
      level,
      ...(options.title === undefined ? {} : { title: options.title }),
      ...(options.coarsen === true ? { coarsen: true } : {}),
      ...(options.includeCommands === true ? { includeCommands: true } : {}),
    });
  } catch (error) {
    if (!(error instanceof ProjectionError)) throw error;
    if (options.json === true) process.stdout.write(`${JSON.stringify({ project: slash(project.root), auto: relPath, error: error.message }, null, 2)}\n`);
    else process.stdout.write(`${error.message}\n`);
    return 1;
  }
  const { projection, text } = built;

  let written: string | null = null;
  if (outPath !== undefined) {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, text, "utf8");
    written = slash(relative(cwd, outPath));
  }
  for (const warning of seasonWarnings) process.stderr.write(`warning: ${warning}\n`);

  if (options.json === true) {
    const report: ProjectionReport = {
      project: slash(project.root),
      auto: relPath,
      level,
      written,
      bytes: built.bytes,
      projection,
      seasonWarnings,
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else if (written === null) {
    process.stdout.write(text);
  } else {
    process.stdout.write(`written: ${written} (a ${level} projection of ${relPath})\n`);
  }
  return 0;
}
