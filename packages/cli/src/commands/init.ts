import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve as resolvePath } from "node:path";
import { linkSkeleton, robotSkeleton, STARTER_CODEGEN_SECTION, waypointsSkeleton } from "@horizon36596/zenith-core";
import { zenithRobotClasses } from "@horizon36596/zenith-import";
import { linkSchema } from "@horizon36596/zenith-schema";
import { LIBRARIES, type CommandLibrary } from "../commandLibrary.js";
import { LINK_FILE, ProjectError } from "../project.js";
import { readJavaSources } from "./importCommands.js";

export interface InitOptions {
  cwd?: string;
  force?: boolean;
  json?: boolean;
  /** `--command-library`: written to `deploy.commandLibrary`. Left out of the file when not given. */
  commandLibrary?: string;
  /** `--robot-class`: written to `deploy.robotClass`. Left out of the file when not given. */
  robotClass?: string;
}

export interface Written {
  path: string;
  status: "written" | "kept";
}

function write(root: string, relative: string, contents: string, force: boolean): Written {
  const full = join(root, relative);
  if (existsSync(full) && !force) return { path: relative, status: "kept" };
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, contents, "utf8");
  return { path: relative, status: "written" };
}

/** Copies the season's field file out of `@horizon36596/zenith-season-biobuzz` when it can be resolved. */
function copySeasonField(root: string, relative: string, force: boolean): Written | null {
  const full = join(root, relative);
  if (existsSync(full) && !force) return { path: relative, status: "kept" };
  try {
    const require = createRequire(import.meta.url);
    const source = require.resolve("@horizon36596/zenith-season-biobuzz/field/biobuzz.field.json");
    mkdirSync(dirname(full), { recursive: true });
    copyFileSync(source, full);
    return { path: relative, status: "written" };
  } catch {
    return null;
  }
}

/** The schema's own rule for `deploy.robotClass`, so `--robot-class` is checked exactly as the file is. */
const robotClassRule = linkSchema.shape.deploy.unwrap().shape.robotClass;

/**
 * The `ZenithRobot` classes already in the Java folder `zenith init` points `codegen` at, to print as a
 * suggestion. Init never writes one into `zenith.json`: the person chooses. A folder that is not there
 * or cannot be read just gives no suggestion. The scan is the import package's, which the editor's Set
 * up reads too (issue #159).
 */
function suggestRobotClasses(root: string): string[] {
  if (!existsSync(join(root, STARTER_CODEGEN_SECTION.dir))) return [];
  try {
    return zenithRobotClasses(readJavaSources(root, [STARTER_CODEGEN_SECTION.dir], root));
  } catch {
    return [];
  }
}

export interface InitResult {
  root: string;
  commandLibrary: CommandLibrary | null;
  robotClass: string | null;
  robotClassSuggestions: string[];
  written: Written[];
  /** False when the season's field file could not be found to copy. */
  seasonCopied: boolean;
}

/**
 * The work of `zenith init` with nothing printed, which `zenith setup` and the MCP server's
 * `zenith.setup` call too. Never overwrites a file unless `force` is set.
 */
export function initProject(options: Omit<InitOptions, "json">): InitResult {
  const root = resolvePath(options.cwd ?? process.cwd());
  const force = options.force === true;
  // Any case is accepted on the command line (`--command-library Ivy`); the file always gets the
  // lowercase name, which is the only form the schema accepts.
  const commandLibrary = options.commandLibrary?.toLowerCase();
  if (commandLibrary !== undefined && !(LIBRARIES as readonly string[]).includes(commandLibrary)) {
    throw new ProjectError(
      `--command-library must be "solverslib" or "ivy", not ${JSON.stringify(options.commandLibrary)}.`,
    );
  }
  const robotClass = options.robotClass;
  if (robotClass !== undefined && !robotClassRule.safeParse(robotClass).success) {
    throw new ProjectError(
      `--robot-class must be a fully qualified Java class name, such as "org.firstinspires.ftc.teamcode.zenith.MyRobot", ` +
        `not ${JSON.stringify(robotClass)}.`,
    );
  }
  const library = commandLibrary as CommandLibrary | undefined;
  const written: Written[] = [
    // The codegen section is always written, because without one zenith deploy writes no OpMode (issue #156).
    write(root, LINK_FILE, linkSkeleton({ commandLibrary: library, robotClass, codegen: true }), force),
    write(root, "autos/robot.json", robotSkeleton(basename(root)), force),
    write(root, "autos/waypoints.json", waypointsSkeleton(), force),
  ];
  const season = copySeasonField(root, "autos/field/biobuzz.field.json", force);
  if (season !== null) written.push(season);
  const suggestions = robotClass === undefined ? suggestRobotClasses(root) : [];
  return {
    root,
    commandLibrary: library ?? null,
    robotClass: robotClass ?? null,
    robotClassSuggestions: suggestions,
    written,
    seasonCopied: season !== null,
  };
}

/** `zenith init`: writes zenith.json and an autos directory that validates. */
export function runInit(options: InitOptions): number {
  const result = initProject(options);
  const { root, written, robotClassSuggestions: suggestions } = result;
  const library = result.commandLibrary ?? undefined;
  const robotClass = result.robotClass ?? undefined;

  if (options.json === true) {
    process.stdout.write(
      `${JSON.stringify(
        { root, commandLibrary: library ?? null, robotClass: robotClass ?? null, robotClassSuggestions: suggestions, written },
        null,
        2,
      )}\n`,
    );
    return 0;
  }
  for (const file of written) process.stdout.write(`${file.status}: ${file.path}\n`);
  if (!result.seasonCopied) {
    process.stdout.write(
      "note: no season field file was copied. Put one at autos/field/biobuzz.field.json.\n",
    );
  }
  if (library === undefined) {
    process.stdout.write(
      'note: zenith.json names no command library yet. Add "commandLibrary": "solverslib" or "commandLibrary": "ivy" ' +
        'to its "deploy" section, or re-run with --command-library, before zenith codegen or zenith deploy, ' +
        "which write Java.\n",
    );
  }
  for (const found of suggestions) {
    process.stdout.write(
      `found: ${found} implements ZenithRobot. Zenith did not write it into zenith.json; if it is your robot, ` +
        `add "robotClass": ${JSON.stringify(found)} to its "deploy" section.\n`,
    );
  }
  process.stdout.write('Next: "zenith new <name>", then "zenith validate autos/<name>.auto.json".\n');
  if (robotClass === undefined) {
    process.stdout.write(
      'note: set "deploy.robotClass" in zenith.json to your ZenithRobot class, fully qualified, before zenith deploy, ' +
        "because every OpMode it writes constructs one. zenith init --robot-class <class> writes it when it makes a project.\n",
    );
  }
  return 0;
}
