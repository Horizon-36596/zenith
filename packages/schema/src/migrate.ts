import { autoSchema } from "./auto.js";
import { fieldSchema } from "./field.js";
import { FORMAT_VERSIONS, LEGACY_SCHEMA_ID, SCHEMA_ID, withCurrentSchemaId, type Kind } from "./ids.js";
import { linkSchema } from "./link.js";
import { robotSchema } from "./robot.js";
import { waypointsSchema } from "./waypoints.js";

export const schemaByKind = {
  link: linkSchema,
  robot: robotSchema,
  field: fieldSchema,
  waypoints: waypointsSchema,
  auto: autoSchema,
} as const;

export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationError";
  }
}

/** Both the current ids and their legacy aliases (`ids.ts`) name a kind. */
const idToKind = new Map<string, Kind>(
  (Object.keys(SCHEMA_ID) as Kind[]).flatMap((kind) => [
    [SCHEMA_ID[kind], kind] as const,
    [LEGACY_SCHEMA_ID[kind], kind] as const,
  ]),
);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Works out which of the five files this is: from `$schema` when it is there, otherwise from the
 * keys that only one kind has. Returns null when nothing identifies it.
 */
export function detectKind(json: unknown): Kind | null {
  if (!isRecord(json)) return null;
  const id = json["$schema"];
  if (typeof id === "string") {
    const known = idToKind.get(id);
    if (known !== undefined) return known;
  }
  if ("steps" in json && "start" in json) return "auto";
  if ("waypoints" in json) return "waypoints";
  if ("obstacles" in json || "season" in json) return "field";
  if ("kinematics" in json || "footprint" in json) return "robot";
  if ("autosDir" in json) return "link";
  return null;
}

export interface Migrated {
  kind: Kind;
  /** The version the data is now at, which is always `FORMAT_VERSIONS[kind]`. */
  formatVersion: number;
  /** The version the file was written at, before migration. */
  fromVersion: number;
  data: unknown;
}

/** One step up: takes a document at version `n` and returns it at `n + 1`. Pure; never mutates. */
type MigrationStep = (doc: Record<string, unknown>) => Record<string, unknown>;

/**
 * The same document at the next version with nothing else changed. Right for any bump whose new
 * version only adds optional keys or step kinds: every older file is already a valid newer one
 * once it says so.
 */
const bumpOnly =
  (to: number): MigrationStep =>
  (doc) => ({ ...doc, formatVersion: to });

/**
 * The migrations, per kind, indexed by the version they start from: `steps[kind][1]` takes a v1
 * file to v2. Every entry has a fixture pair under `packages/schema/fixtures/migrate/`.
 *
 * - auto 1 -> 2 (2026-09-22): v2 adds the `sequence` step kind. A v1 auto holds no sequence, so the
 *   migration is the identity plus the version bump.
 * - field 1 -> 2 (2026-09-22): v2 adds the optional `image` layer (site/docs/editor.md). A v1 field
 *   has none, so again the identity plus the bump.
 * - auto 2 -> 3 (2026-09-24): v3 adds the `piecewise` heading mode (site/docs/file-format.md,
 *   "Piecewise heading"). A v2 auto has none, so the identity plus the bump.
 */
const MIGRATIONS: Readonly<Record<Kind, Readonly<Record<number, MigrationStep>>>> = {
  link: {},
  robot: {},
  field: { 1: bumpOnly(2) },
  waypoints: {},
  auto: { 1: bumpOnly(2), 2: bumpOnly(3) },
};

/**
 * Brings a document up to its kind's current `formatVersion` (`FORMAT_VERSIONS`), one version at a
 * time. A file from the future is refused by name and number, the same way the robot runtime
 * refuses it (site/docs/file-format.md, Versioning). A legacy `$schema` alias comes back as the
 * current id, so whatever writes the result writes the current one. The input is never mutated.
 */
export function migrate(json: unknown, kindHint?: Kind): Migrated {
  if (!isRecord(json)) throw new MigrationError("A Zenith file must be a JSON object.");
  const kind = kindHint ?? detectKind(json);
  if (kind === null) {
    throw new MigrationError(
      "Cannot tell which kind of Zenith file this is: no $schema and no distinguishing keys.",
    );
  }
  const raw = json["formatVersion"];
  if (typeof raw !== "number" || !Number.isInteger(raw)) {
    throw new MigrationError(`A ${kind} file needs an integer formatVersion.`);
  }
  const current: number = FORMAT_VERSIONS[kind];
  if (raw > current) {
    throw new MigrationError(
      `This ${kind} file is formatVersion ${String(raw)}; this build of Zenith knows ${String(current)}.`,
    );
  }
  if (raw < 1) {
    throw new MigrationError(`formatVersion ${String(raw)} never existed; the first version is 1.`);
  }
  let doc: Record<string, unknown> = json;
  for (let version = raw; version < current; version += 1) {
    const step = MIGRATIONS[kind][version];
    if (step === undefined) {
      throw new MigrationError(
        `No migration takes a ${kind} file from formatVersion ${String(version)} to ${String(version + 1)}.`,
      );
    }
    doc = step(doc);
  }
  return { kind, formatVersion: current, fromVersion: raw, data: withCurrentSchemaId(kind, doc) };
}
