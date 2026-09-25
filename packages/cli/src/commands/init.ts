import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve as resolvePath } from "node:path";
import { LIBRARIES, type CommandLibrary } from "../commandLibrary.js";
import { LINK_FILE, ProjectError } from "../project.js";
import { linkSkeleton, robotSkeleton, waypointsSkeleton } from "../skeletons.js";

export interface InitOptions {
  cwd?: string;
  force?: boolean;
  json?: boolean;
  /** `--command-library`: written to `deploy.commandLibrary`. Left out of the file when not given. */
  commandLibrary?: string;
}

interface Written {
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

/** `zenith init`: writes zenith.json and an autos directory that validates. */
export function runInit(options: InitOptions): number {
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
  const library = commandLibrary as CommandLibrary | undefined;
  const written: Written[] = [
    write(root, LINK_FILE, linkSkeleton(library), force),
    write(root, "autos/robot.json", robotSkeleton(basename(root)), force),
    write(root, "autos/waypoints.json", waypointsSkeleton(), force),
  ];
  const season = copySeasonField(root, "autos/field/biobuzz.field.json", force);
  if (season !== null) written.push(season);

  if (options.json === true) {
    process.stdout.write(`${JSON.stringify({ root, commandLibrary: library ?? null, written }, null, 2)}\n`);
    return 0;
  }
  for (const file of written) process.stdout.write(`${file.status}: ${file.path}\n`);
  if (season === null) {
    process.stdout.write(
      "note: no season field file was copied. Put one at autos/field/biobuzz.field.json.\n",
    );
  }
  if (library === undefined) {
    process.stdout.write(
      'note: zenith.json names no command library yet. Add "commandLibrary": "solverslib" or "commandLibrary": "ivy" ' +
        'to its "deploy" section, or re-run with --command-library, before Zenith writes Java: zenith codegen, ' +
        'or zenith deploy once zenith.json has a "codegen" section.\n',
    );
  }
  process.stdout.write('Next: "zenith new <name>", then "zenith validate autos/<name>.auto.json".\n');
  return 0;
}
