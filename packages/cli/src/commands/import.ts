import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, relative, resolve as resolvePath } from "node:path";
import { canonicalize, check, estimate, plan, resolve, type Finding } from "@horizon36596/zenith-core";
import {
  ImportError,
  importPath,
  importPedroProject,
  importTrajectoryAsAuto,
  interchangeKindOf,
  readTrajectory,
  type ImportIssue,
  type PedroImportResult,
} from "@horizon36596/zenith-import";
import { parseProjection, SCHEMA_ID, type Auto, type Projection } from "@horizon36596/zenith-schema";
import { resolveSeason } from "@horizon36596/zenith-seasons";
import { formatFindingsTable } from "../findings.js";
import { loadProject, readJsonFile, type Project } from "../project.js";

export interface ImportOptions {
  cwd?: string;
  project?: string;
  /** Where to write the result: an auto for a `.pp` file, a projection for a trajectory. Absent: print it. */
  out?: string;
  /** The auto's name for a `.pp` import; default the file's own name. */
  name?: string;
  /** The alliance a `.pp` file was drawn for; default the field's canonical alliance. */
  alliance?: string;
  /**
   * The Pedro Visualizer's field centre in its own inches, for a `.pp` file: default 70.75, half the
   * visualizer's 141.5 in field; a team that treats (72, 72) as the centre passes 72.
   */
  pedroCentre?: string;
  /** For a `trajectory.json`: make an auto that can be edited and shared, instead of a projection. */
  asAuto?: boolean;
  force?: boolean;
  json?: boolean;
}

/** Which importer a file needs. */
export type ImportKind = "pedro" | "trajectory" | "path";

/**
 * Which importer a file needs: `.pp` is always Pedro; an interchange file says what it is by its
 * `kind` key (`interchangeKindOf`); any other JSON file with Pedro's keys is a `.pp` saved as `.json`.
 */
export function importKindOf(path: string, doc: unknown): ImportKind | null {
  if (extname(path).toLowerCase() === ".pp") return "pedro";
  const interchange = interchangeKindOf(doc);
  if (interchange !== null) return interchange;
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return null;
  const record = doc as Record<string, unknown>;
  if (Array.isArray(record["lines"]) || "startPoint" in record) return "pedro";
  return null;
}

/** A file's own name as an auto name: the letters, digits, dots, dashes and underscores of its stem. */
function nameFromFile(path: string): string {
  const stem = basename(path).replace(/\.(pp|json)$/i, "").replace(/\.(trajectory|path)$/i, "");
  const cleaned = stem.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned === "" ? "imported" : cleaned;
}

/** What to import a document as, apart from the file itself. */
export interface ImportDocumentOptions {
  name?: string;
  /** `RED` or `BLUE`, any case, for a `.pp` file. */
  alliance?: string;
  /** The Pedro Visualizer's field centre, in its own inches, for a `.pp` file. */
  pedroCentreIn?: number;
  /** For a `trajectory.json`: an auto instead of a projection. */
  asAuto?: boolean;
}

/** A usage problem with the options an import was given: exit 2, like a file that cannot be imported. */
export class ImportUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportUsageError";
  }
}

/** What an import made: an auto, with its findings against the project, or a view projection. */
export type ImportedDocument =
  | {
      kind: ImportKind;
      result: "auto";
      auto: Auto;
      /** The robot's size the file records (a `.pp` or a `trajectory.json`); never written to `robot.json`. */
      robotFootprint?: { lengthIn: number; widthIn: number };
      /** What `zenith validate` would say of the auto in this project. */
      findings: Finding[];
      warnings: string[];
      /** The file to write: the auto in canonical form. */
      text: string;
    }
  | {
      kind: "trajectory";
      result: "projection";
      projection: Projection;
      warnings: string[];
      /** The file to write: the projection in canonical form, which `zenith alliance` reads. */
      text: string;
    };

/**
 * Imports one parsed document against `project`: the one code path `zenith import` and the MCP
 * server's `zenith.import` share. `path` is the file's path, for its extension and its name.
 * Throws `ImportError` naming every wrong field of a file that cannot be imported, and
 * `ImportUsageError` for options that do not fit the file.
 */
export function importDocument(path: string, doc: unknown, project: Project, options: ImportDocumentOptions = {}): ImportedDocument {
  const kind = importKindOf(path, doc);
  if (kind === null) {
    throw new ImportUsageError(
      `${basename(path)} is neither a Pedro Visualizer project (.pp) nor an interchange file (a JSON file with "kind": "trajectory" or "kind": "path").`,
    );
  }
  const name = options.name ?? nameFromFile(path);
  if (kind !== "pedro" && (options.alliance !== undefined || options.pedroCentreIn !== undefined)) {
    throw new ImportUsageError(`--alliance and --pedro-centre are for a .pp file; a ${kind}.json file names its own alliance and frame.`);
  }
  if (kind !== "trajectory" && options.asAuto === true) {
    throw new ImportUsageError("--as-auto is for a trajectory.json; a .pp project and a path.json always become an auto.");
  }

  if (kind === "trajectory" && options.asAuto !== true) {
    const { projection: imported, warnings } = readTrajectory(doc, project.field);
    // With its schema id, the projection passes the schema's own validator, so `zenith alliance`
    // and the Partners panel read the file this writes.
    const projection = parseProjection({ $schema: SCHEMA_ID.projection, ...imported });
    return { kind, result: "projection", projection, warnings, text: canonicalize("projection", projection) };
  }

  if (kind === "trajectory") {
    const result = importTrajectoryAsAuto(doc, project.field, { name });
    return autoOutcome(kind, result.auto, result.warnings, project, result.robotFootprint);
  }

  if (kind === "path") {
    const result = importPath(doc, project.field, { name });
    return autoOutcome(kind, result.auto, result.warnings, project);
  }

  const pedroOptions: Parameters<typeof importPedroProject>[2] = { name };
  if (options.alliance !== undefined) {
    const upper = options.alliance.toUpperCase();
    if (upper !== "RED" && upper !== "BLUE") throw new ImportUsageError(`--alliance must be RED or BLUE, not ${JSON.stringify(options.alliance)}.`);
    pedroOptions.alliance = upper;
  }
  if (options.pedroCentreIn !== undefined) {
    if (!Number.isFinite(options.pedroCentreIn)) throw new ImportUsageError("--pedro-centre must be a finite number of inches, such as 72.");
    pedroOptions.centreIn = options.pedroCentreIn;
  }
  const result: PedroImportResult = importPedroProject(doc, project.field, pedroOptions);
  return autoOutcome(kind, result.auto, result.warnings, project, result.robotFootprint);
}

function autoOutcome(
  kind: ImportKind,
  auto: Auto,
  warnings: string[],
  project: Project,
  robotFootprint?: { lengthIn: number; widthIn: number },
): ImportedDocument {
  return {
    kind,
    result: "auto",
    auto,
    ...(robotFootprint === undefined ? {} : { robotFootprint }),
    findings: checkAuto(auto, project),
    warnings,
    text: canonicalize("auto", auto),
  };
}

/**
 * `zenith import <file.pp|path.json|trajectory.json> [--out <file>] [--as-auto] [--json]`
 *
 * A Pedro Pathing Visualizer project or an interchange `path.json` becomes an auto, checked against
 * the project's robot and field so the findings to fix come straight back; an interchange
 * `trajectory.json` becomes a view projection at 10 Hz in the season's frame, or, with
 * `--as-auto`, an auto. Without `--out` the result is printed. Exit codes: 0 the file was imported
 * (findings on the new auto do not change that; `zenith validate` is the gate), 2 a usage or IO
 * problem, or a file that cannot be imported, with every field that is wrong named. Under `--json`
 * every exit 2 the verb reaches itself prints `{ error, issues }` on stdout, the usage errors
 * (`--out`, `--alliance`, `--pedro-centre`) included; only a project that cannot be found is still
 * reported by the CLI's own handler.
 */
export function runImport(fileArg: string, options: ImportOptions): number {
  const cwd = options.cwd ?? process.cwd();
  const full = isAbsolute(fileArg) ? fileArg : resolvePath(cwd, fileArg);
  const fail = (message: string, issues?: readonly ImportIssue[]): number => {
    if (options.json === true) process.stdout.write(`${JSON.stringify({ error: message, issues: issues ?? [] }, null, 2)}\n`);
    else process.stderr.write(`${message}\n`);
    return 2;
  };

  let doc: unknown;
  try {
    doc = readJsonFile(full);
  } catch (error) {
    return fail((error as Error).message);
  }
  if (importKindOf(full, doc) === null) {
    return fail(`${fileArg} is neither a Pedro Visualizer project (.pp) nor an interchange file (a JSON file with "kind": "trajectory" or "kind": "path").`);
  }

  const project = loadProject(cwd, options.project, fileArg);
  const outPath = options.out === undefined ? undefined : isAbsolute(options.out) ? options.out : resolvePath(cwd, options.out);
  if (outPath !== undefined && existsSync(outPath) && options.force !== true) {
    return fail(`${options.out ?? ""} already exists. Pass --force to overwrite it.`);
  }
  const documentOptions: ImportDocumentOptions = {};
  if (options.name !== undefined) documentOptions.name = options.name;
  if (options.alliance !== undefined) documentOptions.alliance = options.alliance;
  if (options.asAuto === true) documentOptions.asAuto = true;
  if (options.pedroCentre !== undefined) {
    const centreIn = Number(options.pedroCentre);
    if (!Number.isFinite(centreIn) || options.pedroCentre.trim() === "") {
      return fail(`--pedro-centre must be a number of inches, such as 72, not ${JSON.stringify(options.pedroCentre)}.`);
    }
    documentOptions.pedroCentreIn = centreIn;
  }

  let imported: ImportedDocument;
  try {
    imported = importDocument(full, doc, project, documentOptions);
  } catch (error) {
    if (error instanceof ImportError) return fail(error.message, error.issues);
    if (error instanceof ImportUsageError) return fail(error.message);
    throw error;
  }
  return report(options, imported, outPath, (path) => relative(cwd, path).split("\\").join("/"));
}

/** An imported auto's findings against the project's robot and field, the ones `zenith validate` would give. */
function checkAuto(auto: Auto, project: Project): Finding[] {
  const planned = plan(resolve(auto, project.waypoints), project.robot, project.field);
  return check(planned, estimate(planned, project.robot), project.robot, project.field, resolveSeason(project.field).rules);
}

function report(options: ImportOptions, outcome: ImportedDocument, outPath: string | undefined, shown: (path: string) => string): number {
  if (outPath !== undefined) {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, outcome.text, "utf8");
  }
  const written = outPath === undefined ? undefined : shown(outPath);

  if (options.json === true) {
    const body: Record<string, unknown> = { kind: outcome.kind };
    if (written !== undefined) body["written"] = written;
    if (outcome.result === "auto") {
      body["auto"] = outcome.auto;
      if (outcome.robotFootprint !== undefined) body["robotFootprint"] = outcome.robotFootprint;
      body["findings"] = outcome.findings;
    } else {
      body["projection"] = outcome.projection;
    }
    body["warnings"] = outcome.warnings;
    process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
    return 0;
  }

  if (written === undefined) process.stdout.write(outcome.text);
  const lines: string[] = [];
  if (written !== undefined) lines.push(`written: ${written}`);
  for (const warning of outcome.warnings) lines.push(`warning: ${warning}`);
  if (outcome.result === "auto" && outcome.robotFootprint !== undefined && outcome.kind === "pedro") {
    // A trajectory's importer says the size in its own warnings; a .pp import says it here.
    lines.push(
      `robot size in the file: ${String(outcome.robotFootprint.lengthIn)} in long, ${String(outcome.robotFootprint.widthIn)} in wide (not written to robot.json).`,
    );
  }
  if (outcome.result === "auto" && outcome.findings.length > 0) {
    lines.push("Checked against this project's robot and field (run zenith validate once these are fixed):");
    lines.push(formatFindingsTable([{ path: written ?? "imported auto", findings: outcome.findings }]));
  }
  // With the result on stdout, everything else goes to stderr so the result can be redirected cleanly.
  const text = lines.length === 0 ? "" : `${lines.join("\n")}\n`;
  if (written === undefined) process.stderr.write(text);
  else process.stdout.write(text);
  return 0;
}
