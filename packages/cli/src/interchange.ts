import { createRequire } from "node:module";
import { loadField, type Finding } from "@horizon36596/zenith-core";
import { checkInterchange, interchangeKindOf, type InterchangeKind } from "@horizon36596/zenith-import";
import type { Field } from "@horizon36596/zenith-schema";
import { readJsonFile } from "./project.js";

export { interchangeKindOf, type InterchangeKind };

/**
 * A finding about an interchange file (`trajectory.json` or `path.json`). It is an ordinary
 * `Finding` with code `SCHEMA` and step id `(file)`, so every table and every agent that reads
 * findings reads these too, plus `field`: the JSON path of the value it is about, such as
 * `steps[2].heading.ranges[1].startT`, or the empty string for the whole file or a warning. An
 * error's message starts with the same path, for a reader of the table; a warning is the
 * importer's own sentence, which names what it is about.
 */
export interface InterchangeFinding extends Finding {
  field: string;
}

/** The result of validating one interchange document against a season's field. */
export interface InterchangeValidation {
  kind: InterchangeKind;
  findings: InterchangeFinding[];
}

const error = (field: string, message: string): InterchangeFinding => ({
  severity: "error",
  stepId: "(file)",
  code: "SCHEMA",
  message: `${field === "" ? "(file)" : field}: ${message}`,
  field,
});

/** An importer warning is already a full sentence that names what it is about. */
const warning = (sentence: string): InterchangeFinding => ({
  severity: "warning",
  stepId: "(file)",
  code: "SCHEMA",
  message: sentence,
  field: "",
});

/** A season id that is safe to put in a package path: lower-case letters, digits and dashes. */
const SEASON_ID = /^[a-z0-9-]{1,64}$/;

/**
 * The field file a season package ships (`@horizon36596/zenith-season-<season>`), for reading an
 * interchange file outside any project. Null when this build carries no package for that season.
 */
export function bundledSeasonField(season: string): Field | null {
  if (!SEASON_ID.test(season)) return null;
  try {
    const require = createRequire(import.meta.url);
    return loadField(readJsonFile(require.resolve(`@horizon36596/zenith-season-${season}/field/${season}.field.json`)));
  } catch {
    return null;
  }
}

/**
 * Checks one interchange document the way `zenith import` would read it: every problem that stops
 * the import is an error finding naming its field, and every warning the importer gives is a
 * warning finding. `field` is the project's field, or null outside a project, when the season
 * package's own field is used instead.
 */
export function validateInterchange(kind: InterchangeKind, doc: unknown, field: Field | null): InterchangeValidation {
  let against = field;
  if (against === null) {
    const season = (doc as Record<string, unknown>)["season"];
    against = typeof season === "string" ? bundledSeasonField(season) : null;
    if (against === null) {
      const message =
        typeof season === "string"
          ? `names the season ${JSON.stringify(season)}, and there is no project here and no field file for that season in this build to read it against. Run it inside a project with --project.`
          : "must name the season the file is for, such as \"biobuzz\".";
      return { kind, findings: [error("season", message)] };
    }
  }
  const report = checkInterchange(kind, doc, against);
  return {
    kind,
    findings: [
      ...report.errors.map((issue) => error(issue.path, issue.message)),
      ...report.warnings.map(warning),
    ],
  };
}

/** Reads a file and returns its interchange kind with the parsed document, or null when it is not one. */
export function readInterchange(path: string): { kind: InterchangeKind; doc: unknown } | null {
  let doc: unknown;
  try {
    doc = readJsonFile(path);
  } catch {
    return null;
  }
  const kind = interchangeKindOf(doc);
  return kind === null ? null : { kind, doc };
}
