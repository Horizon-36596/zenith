import type { Field } from "@horizon36596/zenith-schema";
import { ImportError, type ImportIssue } from "./errors.js";
import { importPath } from "./path/importPath.js";
import { PATH_SCHEMA_ID } from "./path/schema.js";
import { readTrajectory } from "./trajectory/importTrajectory.js";
import { TRAJECTORY_SCHEMA_ID } from "./trajectory/schema.js";

/**
 * The interchange files, told apart by their `kind` key, the same key every Zenith file uses to
 * say what it is: `"trajectory"` for `trajectory.json`, `"path"` for `path.json`.
 */
export const INTERCHANGE_KINDS = ["trajectory", "path"] as const;
export type InterchangeKind = (typeof INTERCHANGE_KINDS)[number];

/** Where each interchange kind's JSON Schema is served. */
export const INTERCHANGE_SCHEMA_ID: Record<InterchangeKind, string> = {
  trajectory: TRAJECTORY_SCHEMA_ID,
  path: PATH_SCHEMA_ID,
};

/** The interchange kind a parsed JSON document declares, or null when it is not an interchange file. */
export function interchangeKindOf(doc: unknown): InterchangeKind | null {
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return null;
  const kind = (doc as Record<string, unknown>)["kind"];
  return (INTERCHANGE_KINDS as readonly unknown[]).includes(kind) ? (kind as InterchangeKind) : null;
}

/** What `checkInterchange` found: the problems that stop the import, and the warnings that do not. */
export interface InterchangeReport {
  kind: InterchangeKind;
  /** Each names its field by JSON path. Empty when the file imports. */
  errors: ImportIssue[];
  /** Full sentences, from the importer: what was changed, or could not be checked. */
  warnings: string[];
}

/**
 * Checks an interchange file the way importing it would, without keeping the result: every schema
 * problem and every import problem named by its field, and the importer's warnings. This is what
 * `zenith validate` and the MCP server's `zenith.validate` report for an interchange file.
 *
 * Pure. `field` is the season's field the file is read against.
 */
export function checkInterchange(kind: InterchangeKind, doc: unknown, field: Field): InterchangeReport {
  try {
    const warnings = kind === "trajectory" ? readTrajectory(doc, field).warnings : importPath(doc, field).warnings;
    return { kind, errors: [], warnings };
  } catch (error) {
    if (error instanceof ImportError) return { kind, errors: [...error.issues], warnings: [] };
    throw error;
  }
}
