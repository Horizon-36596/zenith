import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import {
  canonicalize,
  codegenBlockedMessage,
  exportedClassName,
  generatedClassName,
  NO_CODEGEN_SECTION_MESSAGE,
  NO_ROBOT_CLASS_EXPORT_MESSAGE,
} from "@horizon36596/zenith-core";
import { loadAutoAndPlan, resolveAutoPath } from "../autoLoad.js";
import { countErrors, formatFindingsTable, type FileFindings } from "../findings.js";
import { commandLibraryOf } from "../commandLibrary.js";
import { generateAutoJava } from "../javaCodegen.js";
import { loadProject, ProjectError } from "../project.js";

export interface CodegenOptions {
  cwd?: string;
  project?: string;
  json?: boolean;
  /**
   * Write the exported OpMode (`<PascalName>Exported.java`) instead of the reference class: a concrete
   * `@Autonomous` class the team owns, which reads no auto file (issue #535). Not recommended.
   */
  export?: boolean;
}

/** What `zenith codegen --export` prints after it writes, so nobody exports by accident. */
export const EXPORT_WARNING =
  "not recommended: the exported class is yours now and Zenith no longer tracks it. A change made in it is " +
  "not in the auto file, and exporting again overwrites it. Delete the generated OpMode for this auto, or the " +
  "Driver Station lists both.";

const slash = (path: string): string => path.split("\\").join("/");

/**
 * `zenith codegen <auto>`: the readable, derived `AutoFromFile` subclass of
 * site/docs/robot-runtime.md. Needs only schema and M0's `check()`, so it
 * does not wait on M1's estimator or ledger. With `--export`, the standalone OpMode a team owns instead.
 */
export function runCodegen(autoArg: string, options: CodegenOptions): number {
  const cwd = options.cwd ?? process.cwd();
  const project = loadProject(cwd, options.project, autoArg);
  const path = resolveAutoPath(cwd, project, autoArg);
  const relPath = slash(relative(project.root, path));
  const result = loadAutoAndPlan(path, project);
  const findings = result.ok ? result.loaded.findings : result.findings;
  const files: FileFindings[] = [{ path: relPath, findings }];

  if (countErrors(files) > 0) {
    if (options.json === true) {
      process.stdout.write(
        `${JSON.stringify({ project: slash(project.root), files, errors: countErrors(files) }, null, 2)}\n`,
      );
    } else {
      process.stdout.write(`${formatFindingsTable(files)}\n${codegenBlockedMessage(countErrors(files))}\n`);
    }
    return 1;
  }
  if (!result.ok) {
    // Unreachable given countErrors gated above, but keeps the type narrowing honest.
    return 1;
  }

  const codegenConfig = project.link.codegen;
  if (codegenConfig === undefined) {
    throw new ProjectError(NO_CODEGEN_SECTION_MESSAGE);
  }
  const commandLibrary = commandLibraryOf(project.link);
  const robotClass = project.link.deploy?.robotClass;
  if (options.export === true && robotClass === undefined) {
    throw new ProjectError(NO_ROBOT_CLASS_EXPORT_MESSAGE);
  }

  const canonicalBytes = canonicalize("auto", result.loaded.auto);
  const shaHex = createHash("sha256").update(canonicalBytes, "utf8").digest("hex").slice(0, 8);
  const packagePath = codegenConfig.package.split(".").join("/");
  const autoName = result.loaded.auto.name;
  const fileName = `${options.export === true ? exportedClassName(autoName) : generatedClassName(autoName)}.java`;
  const outRelative = join(codegenConfig.dir, packagePath, fileName);
  const outFull = join(project.root, outRelative);

  const java = generateAutoJava(result.loaded.plan, {
    packageName: codegenConfig.package,
    shaHex,
    sourcePath: relPath,
    commandLibrary,
    ...(options.export === true && robotClass !== undefined
      ? {
          exported: {
            robotClass,
            ...(project.link.deploy?.preselectTeleOp === undefined
              ? {}
              : { preselectTeleOp: project.link.deploy.preselectTeleOp }),
          },
        }
      : {}),
  });

  mkdirSync(dirname(outFull), { recursive: true });
  writeFileSync(outFull, java, "utf8");

  if (options.json === true) {
    const exported = options.export === true ? { exported: true, warning: EXPORT_WARNING } : {};
    process.stdout.write(`${JSON.stringify({ written: slash(outRelative), shaHex, ...exported }, null, 2)}\n`);
  } else {
    process.stdout.write(`written: ${slash(outRelative)}\n`);
    if (options.export === true) process.stdout.write(`warning: ${EXPORT_WARNING}\n`);
  }
  return 0;
}
