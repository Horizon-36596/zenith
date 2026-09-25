import { z } from "zod";

/** The five kinds of file Zenith reads and writes (site/docs/file-format.md). */
export const KINDS = ["link", "robot", "field", "waypoints", "auto"] as const;
export type Kind = (typeof KINDS)[number];

/** Where the v1 schemas are served, one file per kind. */
export const SCHEMA_ID_BASE = "https://libraries.horizon36596.org/zenith/schema/v1/";

/**
 * The schema ids, one per kind. The docs site serves the schemas at these URLs, and they also ship
 * in this package under `json/`; a reader never needs to fetch them.
 */
export const SCHEMA_ID: Record<Kind, string> = {
  link: `${SCHEMA_ID_BASE}link.json`,
  robot: `${SCHEMA_ID_BASE}robot.json`,
  field: `${SCHEMA_ID_BASE}field.json`,
  waypoints: `${SCHEMA_ID_BASE}waypoints.json`,
  auto: `${SCHEMA_ID_BASE}auto.json`,
};

/**
 * The ids files carried before v0.1.0, on a host that was never served. Files written in
 * development still name them, so every reader accepts them as aliases of `SCHEMA_ID`; every writer
 * writes the current id instead (site/docs/file-format.md, Schema ids). The data format is the
 * same under both, so this is not a `formatVersion` bump.
 */
export const LEGACY_SCHEMA_ID_BASE = "https://zenith.horizon36596.org/schema/v1/";

export const LEGACY_SCHEMA_ID: Record<Kind, string> = {
  link: `${LEGACY_SCHEMA_ID_BASE}link.json`,
  robot: `${LEGACY_SCHEMA_ID_BASE}robot.json`,
  field: `${LEGACY_SCHEMA_ID_BASE}field.json`,
  waypoints: `${LEGACY_SCHEMA_ID_BASE}waypoints.json`,
  auto: `${LEGACY_SCHEMA_ID_BASE}auto.json`,
};

/** Whether `id` names `kind`, by its current id or its legacy alias. */
export const isSchemaIdFor = (kind: Kind, id: string): boolean =>
  id === SCHEMA_ID[kind] || id === LEGACY_SCHEMA_ID[kind];

/**
 * The same document with a legacy `$schema` alias replaced by the current id; anything else is
 * returned as it is. Pure; never mutates.
 */
export function withCurrentSchemaId<T>(kind: Kind, doc: T): T {
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return doc;
  const record = doc as Record<string, unknown>;
  if (record["$schema"] !== LEGACY_SCHEMA_ID[kind]) return doc;
  return { ...record, $schema: SCHEMA_ID[kind] } as T;
}

/**
 * The `formatVersion` Zenith writes for each kind of file. Each kind is versioned on its own and
 * bumped only when its own canonical form changes, with a migration and a fixture
 * (`migrate.ts`). Version 2 (2026-09-22) added the `sequence` step to
 * autos and the optional `image` to fields; auto version 3 (2026-09-24) added the `piecewise`
 * heading mode. The link, robot and waypoints files did not change and stay at 1.
 *
 * The `$schema` ids above do not move with the version: they name the kind of file, and the
 * `formatVersion` inside it says which revision of that kind it is.
 */
export const FORMAT_VERSIONS = {
  link: 1,
  robot: 1,
  field: 2,
  waypoints: 1,
  auto: 3,
} as const satisfies Readonly<Record<Kind, number>>;

/**
 * The newest format version of any kind, which is the auto file's. Code that writes an auto file
 * uses this; code that writes any other kind reads `FORMAT_VERSIONS` for that kind.
 */
export const FORMAT_VERSION = FORMAT_VERSIONS.auto;

/**
 * `$schema` is optional on read, and the legacy alias is accepted; every file Zenith writes carries
 * the current id for its kind.
 */
export const schemaIdField = (kind: Kind) =>
  z
    .string()
    .refine((value) => isSchemaIdFor(kind, value), {
      message: `$schema must be ${SCHEMA_ID[kind]}`,
    })
    .optional();

/** The `formatVersion` key of one kind's current schema: exactly the version Zenith writes. */
export const formatVersionFor = <K extends Kind>(kind: K) =>
  z.literal<(typeof FORMAT_VERSIONS)[K]>(FORMAT_VERSIONS[kind]);
