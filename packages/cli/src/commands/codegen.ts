import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { canonicalize } from "@horizon36596/zenith-core";
import { loadAutoAndPlan, resolveAutoPath } from "../autoLoad.js";
import { countErrors, formatFindingsTable, type FileFindings } from "../findings.js";
import { commandLibraryOf } from "../commandLibrary.js";
import { generateAutoJava, pascalCase } from "../javaCodegen.js";
import { loadProject, ProjectError } from "../project.js";

export interface CodegenOptions {
  cwd?: string;
  project?: string;
  json?: boolean;
}

const slash = (path: string): string => path.split("\\").join("/");

/**
 * `zenith codegen <auto>`: the readable, derived `AutoFromFile` subclass of
 * site/docs/robot-runtime.md. Needs only schema and M0's `check()`, so it
 * does not wait on M1's estimator or ledger.
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
      process.stdout.write(`${formatFindingsTable(files)}\n`);
    }
    return 1;
  }
  if (!result.ok) {
    // Unreachable given countErrors gated above, but keeps the type narrowing honest.
    return 1;
  }

  const codegenConfig = project.link.codegen;
  if (codegenConfig === undefined) {
    throw new ProjectError(
      'zenith.json has no "codegen" section (package and dir); add one before running zenith codegen.',
    );
  }

  const canonicalBytes = canonicalize("auto", result.loaded.auto);
  const shaHex = createHash("sha256").update(canonicalBytes, "utf8").digest("hex").slice(0, 8);
  const packagePath = codegenConfig.package.split(".").join("/");
  const fileName = `${pascalCase(result.loaded.auto.name)}Generated.java`;
  const outRelative = join(codegenConfig.dir, packagePath, fileName);
  const outFull = join(project.root, outRelative);

  const java = generateAutoJava(result.loaded.plan, {
    packageName: codegenConfig.package,
    shaHex,
    sourcePath: relPath,
    commandLibrary: commandLibraryOf(project.link),
  });

  mkdirSync(dirname(outFull), { recursive: true });
  writeFileSync(outFull, java, "utf8");

  if (options.json === true) {
    process.stdout.write(`${JSON.stringify({ written: slash(outRelative), shaHex }, null, 2)}\n`);
  } else {
    process.stdout.write(`written: ${slash(outRelative)}\n`);
  }
  return 0;
}
