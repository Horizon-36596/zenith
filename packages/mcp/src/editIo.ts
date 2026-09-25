import { writeFileSync } from "node:fs";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { canonicalize, loadAuto } from "@horizon36596/zenith-core";
import type { Auto } from "@horizon36596/zenith-schema";
import { errorCount, findingsForAuto, helpFor, warningCount } from "./findings.js";
import { confinePath, readJsonFile, relativeToRoot, resolveAutoPath, type Project } from "./project.js";
import { jsonResult } from "./result.js";

/** Reads and schema-validates the auto a `zenith.edit.*` tool is about to change. */
export function loadCurrent(project: Project, autoRef: string): { path: string; auto: Auto } {
  const path = resolveAutoPath(project, autoRef);
  return { path, auto: loadAuto(readJsonFile(path)) };
}

/**
 * The common tail of every `zenith.edit.*` tool: write the edit's result back in canonical form,
 * then run the same validate pipeline `zenith.validate` does, so the agent sees the effect of its
 * edit immediately instead of having to call `zenith.validate` separately.
 */
export function writeEditResult(
  project: Project,
  path: string,
  updated: Auto,
  extra: Record<string, unknown> = {},
): CallToolResult {
  // `path` normally already came from `resolveAutoPath` (itself confined), but this is the actual
  // write call, so it is confined again here too: the one place every `zenith.edit.*` primitive's
  // output reaches disk is the one place that must refuse to write outside the project on its own.
  writeFileSync(confinePath(project.root, path), canonicalize("auto", updated), "utf8");
  const { findings, seasonWarnings } = findingsForAuto(updated, project);
  return jsonResult({
    written: relativeToRoot(project, path),
    auto: updated,
    findings,
    errors: errorCount(findings),
    warnings: warningCount(findings),
    seasonWarnings,
    help: helpFor(findings),
    ...extra,
  });
}
