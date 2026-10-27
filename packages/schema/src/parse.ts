import { z } from "zod";
import type { Auto } from "./auto.js";
import type { Field } from "./field.js";
import type { Kind } from "./ids.js";
import type { Link } from "./link.js";
import { projectionDepthIssue, type Projection } from "./projection.js";
import type { Proposal } from "./proposal.js";
import type { Robot } from "./robot.js";
import type { Waypoints } from "./waypoints.js";
import { migrate, schemaByKind } from "./migrate.js";

export class SchemaError extends Error {
  constructor(
    message: string,
    readonly kind: Kind,
    readonly issues: z.ZodIssue[],
  ) {
    super(message);
    this.name = "SchemaError";
  }
}

/** `path/to/key: message`, the shape the CLI prints and the SCHEMA finding carries. */
export function formatIssue(issue: z.ZodIssue): string {
  const where = issue.path.length === 0 ? "(root)" : issue.path.join(".");
  return `${where}: ${issue.message}`;
}

/**
 * What must be refused before the schema runs, because the schema itself could not refuse it
 * safely: a projection nested so deep that the recursive step schema would overflow the stack.
 */
function preParseIssue(kind: Kind, data: unknown): z.ZodIssue | null {
  if (kind !== "projection") return null;
  const message = projectionDepthIssue(data);
  return message === null ? null : { code: "custom", path: ["structure", "steps"], message };
}

function parseAs<T>(kind: Kind, json: unknown): T {
  const migrated = migrate(json, kind);
  const early = preParseIssue(kind, migrated.data);
  if (early !== null) {
    throw new SchemaError(`Invalid ${kind} file:
  ${formatIssue(early)}`, kind, [early]);
  }
  const result = schemaByKind[kind].safeParse(migrated.data);
  if (!result.success) {
    const issues = result.error.issues;
    throw new SchemaError(
      `Invalid ${kind} file:\n  ${issues.map(formatIssue).join("\n  ")}`,
      kind,
      issues,
    );
  }
  return result.data as T;
}

export const parseLink = (json: unknown): Link => parseAs<Link>("link", json);
export const parseRobot = (json: unknown): Robot => parseAs<Robot>("robot", json);
export const parseField = (json: unknown): Field => parseAs<Field>("field", json);
export const parseWaypoints = (json: unknown): Waypoints => parseAs<Waypoints>("waypoints", json);
export const parseAuto = (json: unknown): Auto => parseAs<Auto>("auto", json);
/**
 * A projection another team shared. The schema is strict (`projection.ts`), so anything this
 * returns holds only the keys the format names, within its caps.
 */
export const parseProjection = (json: unknown): Projection => parseAs<Projection>("projection", json);
/**
 * A proposal another team sent against a propose-level share. Strict like the projection
 * (`proposal.ts`): only the closed set of changes, within its caps.
 */
export const parseProposal = (json: unknown): Proposal => parseAs<Proposal>("proposal", json);

/** Validates without throwing; the SCHEMA check wants the issue list, not an exception. */
export function validateKind(
  kind: Kind,
  json: unknown,
): { ok: true; data: unknown } | { ok: false; issues: string[] } {
  let migrated;
  try {
    migrated = migrate(json, kind);
  } catch (error) {
    return { ok: false, issues: [error instanceof Error ? error.message : String(error)] };
  }
  const early = preParseIssue(kind, migrated.data);
  if (early !== null) return { ok: false, issues: [formatIssue(early)] };
  const result = schemaByKind[kind].safeParse(migrated.data);
  if (result.success) return { ok: true, data: result.data };
  return { ok: false, issues: result.error.issues.map(formatIssue) };
}
