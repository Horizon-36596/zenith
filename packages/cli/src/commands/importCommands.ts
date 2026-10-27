import { existsSync, lstatSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve as resolvePath } from "node:path";
import { canonicalize, type Finding } from "@horizon36596/zenith-core";
import {
  checkCommandRegistry,
  formatDiff,
  isScannableSource,
  isSkippedSourcePath,
  mergeCommandScan,
  scanCommands,
  type CommandScan,
  type RegistryFinding,
  type RobotChange,
  type SourceFile,
} from "@horizon36596/zenith-import";
import { javaDirsOf, parseRobot, type Robot } from "@horizon36596/zenith-schema";
import type { FileFindings } from "../findings.js";
import { confinePath, loadProject, ProjectError, readJsonFile, type Project } from "../project.js";

const slash = (path: string): string => path.split("\\").join("/");

/**
 * Every `.java` and `.kt` file under `dirs`, read, with its path relative to the project root, in
 * a stable order. Build output, dot directories and test sources are skipped
 * (`isSkippedSourcePath`); a directory outside the project is refused, like every path `zenith`
 * reads for a project. Symbolic links inside the tree are not followed.
 */
export function readJavaSources(
  root: string,
  dirs: readonly string[],
  cwd: string,
  options: { confine?: boolean } = {},
): SourceFile[] {
  const out: SourceFile[] = [];
  const seen = new Set<string>();
  for (const dir of dirs) {
    const full = isAbsolute(dir) ? resolvePath(dir) : resolvePath(cwd, dir);
    if (options.confine !== false) confinePath(root, full);
    if (!existsSync(full)) throw new ProjectError(`No such directory: ${dir}`);
    const walk = (current: string): void => {
      let entries: string[];
      try {
        entries = readdirSync(current).sort();
      } catch {
        throw new ProjectError(`Cannot read the directory ${slash(relative(root, current)) || "."}.`);
      }
      for (const name of entries) {
        const path = join(current, name);
        const rel = slash(relative(root, path));
        let stat;
        try {
          // lstat, so a symbolic link is skipped rather than followed: a link back up the tree
          // would otherwise be walked for ever.
          stat = lstatSync(path);
        } catch {
          continue;
        }
        if (stat.isSymbolicLink()) continue;
        if (stat.isDirectory()) {
          // A directory is skipped by the same rule as a file inside it.
          if (!isSkippedSourcePath(`${rel}/x.java`)) walk(path);
        } else if (isScannableSource(rel) && !isSkippedSourcePath(rel) && !seen.has(rel)) {
          seen.add(rel);
          out.push({ path: rel, text: readFileSync(path, "utf8") });
        }
      }
    };
    if (statSync(full).isDirectory()) walk(full);
    else {
      const rel = slash(relative(root, full));
      if (!isScannableSource(rel)) throw new ProjectError(`${dir} is not a .java or .kt file or a directory.`);
      if (!seen.has(rel)) {
        seen.add(rel);
        out.push({ path: rel, text: readFileSync(full, "utf8") });
      }
    }
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** A registry finding as a `validate` finding, so it prints in the same table and JSON. */
export function toFinding(finding: RegistryFinding): Finding {
  const stepId =
    finding.subject === "scan"
      ? finding.at === undefined
        ? "(java)"
        : `${finding.at.path}:${String(finding.at.line)}`
      : `${finding.subject}:${finding.name ?? ""}${finding.key === undefined ? "" : `.${finding.key}`}`;
  return { severity: finding.severity, stepId, code: "REGISTRY", message: finding.message };
}

/**
 * `robot.json` checked against the Java under `dirs`, as one file's findings, for
 * `zenith validate --java`, where `dirs` are relative to `cwd` and must be inside the project.
 */
export function registryFileFindings(project: Project, dirs: readonly string[], cwd: string): FileFindings {
  const scan = scanCommands(readJavaSources(project.root, dirs, cwd));
  return {
    path: slash(relative(cwd, join(project.root, project.link.robot))),
    findings: checkCommandRegistry(project.robot, scan).map(toFinding),
  };
}

/**
 * `robot.json` checked against `zenith.json`'s `javaDir`, for `zenith validate` without `--java`.
 * The directories are relative to the project root and may lie outside it, since the robot code
 * can be in another checkout; they are only read. One that does not exist is a warning, not an
 * error, so a project whose robot code is not checked out beside it still validates.
 */
export function configuredRegistryFindings(project: Project, dirs: readonly string[], cwd: string): FileFindings {
  const found: string[] = [];
  const findings: Finding[] = [];
  for (const dir of dirs) {
    const full = isAbsolute(dir) ? dir : join(project.root, dir);
    if (existsSync(full)) found.push(full);
    else {
      findings.push({
        severity: "warning",
        stepId: "(javaDir)",
        code: "REGISTRY",
        message: `zenith.json's javaDir names ${dir}, which does not exist here, so robot.json was not checked against the Java there. Check it out beside the project, or fix javaDir.`,
      });
    }
  }
  if (found.length > 0) {
    const scan = scanCommands(readJavaSources(project.root, found, project.root, { confine: false }));
    findings.push(...checkCommandRegistry(project.robot, scan).map(toFinding));
  }
  return { path: slash(relative(cwd, join(project.root, project.link.robot))), findings };
}

export interface ImportCommandsOptions {
  cwd?: string;
  project?: string;
  /** Do not write; exit 1 when robot.json is missing something or disagrees with the Java. */
  check?: boolean;
  /** Also print the robot.json lines that change. */
  diff?: boolean;
  json?: boolean;
}

export interface ImportCommandsResult {
  robot: string;
  filesScanned: number;
  commands: CommandScan["commands"];
  conditions: CommandScan["conditions"];
  changes: RobotChange[];
  findings: RegistryFinding[];
  /** Where robot.json was written, or null for `--check` or when nothing changed. */
  written: string | null;
  /** The canonical robot.json lines that change, as `+`, `-` and context lines. */
  diff: string;
  /**
   * True when robot.json on disk is not in canonical form, so writing it also reformats lines the
   * diff does not show (the diff compares canonical text with canonical text).
   */
  reformats: boolean;
}

/**
 * Scans the robot's Java for its `NamedCommands` registrations and brings `robot.json` up to date
 * (Zenith's ADR 0014). Pure over the file system it is given: no network, no clock.
 */
export function importCommands(dirs: readonly string[], options: ImportCommandsOptions): ImportCommandsResult {
  const cwd = options.cwd ?? process.cwd();
  const project = loadProject(cwd, options.project);
  // Directories on the command line win; then zenith.json's javaDir, relative to the project root
  // and allowed outside it; then the whole project.
  const configured = javaDirsOf(project.link);
  let sources: SourceFile[];
  if (dirs.length > 0) sources = readJavaSources(project.root, dirs, cwd);
  else if (configured.length > 0) {
    const missing = configured.filter((dir) => !existsSync(isAbsolute(dir) ? dir : join(project.root, dir)));
    if (missing.length > 0) {
      throw new ProjectError(`zenith.json's javaDir names ${missing.join(", ")}, which does not exist here. Check the robot code out there, fix javaDir, or name the directories to scan.`);
    }
    sources = readJavaSources(project.root, configured.map((dir) => (isAbsolute(dir) ? dir : join(project.root, dir))), project.root, { confine: false });
  } else sources = readJavaSources(project.root, [project.root], cwd);
  const scan = scanCommands(sources);
  const robotPath = join(project.root, project.link.robot);
  const raw = readJsonFile(robotPath);
  const before = canonicalize("robot", parseRobot(raw));
  const onDisk = readFileSync(robotPath, "utf8").replace(/\r\n/g, "\n");
  const merged = mergeCommandScan(project.robot, scan);
  const robot: Robot = parseRobot(merged.robot);
  const after = canonicalize("robot", robot);
  let written: string | null = null;
  if (options.check !== true && merged.changes.length > 0) {
    writeFileSync(robotPath, after, "utf8");
    written = slash(relative(cwd, robotPath));
  }
  return {
    robot: slash(relative(cwd, robotPath)),
    filesScanned: scan.filesScanned,
    commands: scan.commands,
    conditions: scan.conditions,
    changes: merged.changes,
    findings: options.check === true ? checkCommandRegistry(project.robot, scan) : merged.findings,
    written,
    diff: before === after ? "" : formatDiff(before, after),
    reformats: merged.changes.length > 0 && onDisk !== before,
  };
}

const plural = (count: number, word: string): string => `${String(count)} ${word}${count === 1 ? "" : "s"}`;

/**
 * `zenith import-commands [dir...]`: exit 0 when robot.json agrees with the Java (after writing
 * the additions, unless `--check`), 1 when an error finding remains or, with `--check`, when
 * robot.json is missing something, 2 on a usage or IO problem.
 */
export function runImportCommands(dirs: readonly string[], options: ImportCommandsOptions): number {
  const result = importCommands(dirs, options);
  const errors = result.findings.filter((finding) => finding.severity === "error").length;
  const warnings = result.findings.filter((finding) => finding.severity === "warning").length;
  const failed = errors > 0 || (options.check === true && result.changes.length > 0);

  if (options.json === true) {
    process.stdout.write(`${JSON.stringify({ ...result, errors, warnings }, null, 2)}\n`);
    return failed ? 1 : 0;
  }

  const lines: string[] = [];
  lines.push(
    `Scanned ${plural(result.filesScanned, "file")}: ${plural(result.commands.length, "command")} and ${plural(result.conditions.length, "condition")} registered.`,
  );
  if (result.changes.length === 0) {
    lines.push(`${result.robot} already declares everything the Java registers.`);
  } else {
    lines.push(options.check === true ? `${result.robot} is missing:` : `${result.written === null ? "Would change" : "Changed"} ${result.robot}:`);
    for (const change of result.changes) lines.push(`  ${change.message}`);
    if (options.diff === true && result.diff !== "") {
      lines.push("", result.diff);
    }
    if (result.reformats) {
      lines.push(`${result.robot} is not in canonical form, so writing it also reformats it; the diff shows the canonical lines only.`);
    }
  }
  if (result.findings.length > 0) {
    lines.push("");
    const width = Math.max(...result.findings.map((finding) => finding.severity.length));
    for (const finding of result.findings) {
      lines.push(`  ${finding.severity.padEnd(width)}  ${finding.message}`);
    }
  }
  lines.push(`${plural(errors, "error")}, ${plural(warnings, "warning")}`);
  if (options.check === true && result.changes.length > 0) {
    lines.push("Run zenith import-commands without --check to add them.");
  }
  process.stdout.write(`${lines.join("\n")}\n`);
  return failed ? 1 : 0;
}
