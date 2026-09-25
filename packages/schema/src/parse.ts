import { z } from "zod";
import type { Auto } from "./auto.js";
import type { Field } from "./field.js";
import type { Kind } from "./ids.js";
import type { Link } from "./link.js";
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

function parseAs<T>(kind: Kind, json: unknown): T {
  const migrated = migrate(json, kind);
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
  const result = schemaByKind[kind].safeParse(migrated.data);
  if (result.success) return { ok: true, data: result.data };
  return { ok: false, issues: result.error.issues.map(formatIssue) };
}
