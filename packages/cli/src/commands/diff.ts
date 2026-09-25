import { isAbsolute, relative, resolve as resolvePath } from "node:path";
import { diff as coreDiff, diffToMarkdown, loadAuto } from "@horizon36596/zenith-core";
import { SchemaError } from "@horizon36596/zenith-schema";
import { CORE_NOT_LANDED_EXIT_CODE, tryCore } from "../coreGate.js";
import { findProjectRoot, readJsonFile } from "../project.js";

export interface DiffOptions {
  cwd?: string;
  json?: boolean;
}

const slash = (path: string): string => path.split("\\").join("/");

function loadOne(cwd: string, arg: string): { ok: true; auto: ReturnType<typeof loadAuto> } | { ok: false; message: string } {
  const full = isAbsolute(arg) ? arg : resolvePath(cwd, arg);
  let json: unknown;
  try {
    json = readJsonFile(full);
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
  try {
    return { ok: true, auto: loadAuto(json) };
  } catch (error) {
    if (error instanceof SchemaError) return { ok: false, message: error.message };
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * `zenith diff <a> <b> [--json]`: the structural diff of site/docs/github.md, for review and for an
 * agent comparing its own iterations. Needs only the two `Auto` documents, so it does not touch
 * `zenith.json` at all beyond finding it for a nicer relative path.
 */
export function runDiff(aArg: string, bArg: string, options: DiffOptions): number {
  const cwd = options.cwd ?? process.cwd();
  const a = loadOne(cwd, aArg);
  const b = loadOne(cwd, bArg);
  if (!a.ok || !b.ok) {
    const problems: string[] = [];
    if (!a.ok) problems.push(`${aArg}: ${a.message}`);
    if (!b.ok) problems.push(`${bArg}: ${b.message}`);
    const message = `cannot diff: ${problems.join("; ")}`;
    if (options.json === true) process.stdout.write(`${JSON.stringify({ error: message }, null, 2)}\n`);
    else process.stderr.write(`${message}\n`);
    return 2;
  }

  const outcome = tryCore(() => coreDiff(a.auto, b.auto));
  if (!outcome.ok) {
    if (options.json === true) process.stdout.write(`${JSON.stringify({ error: outcome.message }, null, 2)}\n`);
    else process.stderr.write(`${outcome.message}\n`);
    return CORE_NOT_LANDED_EXIT_CODE;
  }

  const root = findProjectRoot(cwd);
  const label = (arg: string): string => {
    const full = isAbsolute(arg) ? arg : resolvePath(cwd, arg);
    return slash(root === null ? relative(cwd, full) : relative(root, full));
  };

  if (options.json === true) {
    process.stdout.write(`${JSON.stringify({ a: label(aArg), b: label(bArg), diff: outcome.value }, null, 2)}\n`);
  } else {
    process.stdout.write(`# ${label(aArg)} vs ${label(bArg)}\n\n${diffToMarkdown(outcome.value)}\n`);
  }
  return 0;
}
