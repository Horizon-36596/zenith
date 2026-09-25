import { FORMAT_VERSIONS, migrate, schemaByKind, withCurrentSchemaId, type Kind } from "@horizon36596/zenith-schema";
import { z } from "zod";

/**
 * Canonical form (site/docs/file-format.md): UTF-8, LF, two-space indent, object keys in schema
 * declaration order (not alphabetical), numbers rounded to 3 decimals for inches, 4 for radians and
 * 3 for seconds (and so for in/s and in/s²) by the key that names the unit, trailing newline. A file round-trips byte-identically through load and save, which
 * is what makes a git diff of an auto readable.
 *
 * The key order comes from the zod schemas themselves, so the schema is the single definition of
 * the order and the two cannot drift apart.
 */
export function canonicalize(kind: Kind, doc: unknown): string {
  return `${write(atCurrentVersion(kind, doc), schemaByKind[kind] as z.ZodTypeAny, null, "")}\n`;
}

/**
 * Every writer writes the current format version (site/docs/file-format.md, Versioning), so a
 * document handed over at an older version is migrated first. One that cannot be migrated is
 * written as it is: canonical form is about bytes, and refusing the file is the loader's job. A
 * legacy `$schema` alias is always written as the current id (Schema ids, same document).
 */
function atCurrentVersion(kind: Kind, input: unknown): unknown {
  const doc = withCurrentSchemaId(kind, input);
  if (!isRecord(doc)) return doc;
  const version = doc["formatVersion"];
  if (typeof version !== "number" || version >= FORMAT_VERSIONS[kind]) return doc;
  try {
    return migrate(doc, kind).data;
  } catch {
    return doc;
  }
}

const INDENT = "  ";

/**
 * Digits after the point for a key, by the unit its name declares, or null for a key that names no
 * unit and is written exactly as given.
 *
 * Only the key that names the unit is rounded. A number inside an object under such a key — the
 * `value` of `maxForwardVelInPerS: { value, provenance }`, the `rapid` of `cadenceS` — names no
 * unit of its own and keeps its full precision: inheriting the parent's unit rounded a MEASURED
 * 72.3456 to 72.346 while the `…InPerS2` values beside it kept every digit. An array's elements do
 * take the unit of the key holding the array, because an array has no keys of its own to name one.
 */
export function digitsForKey(key: string): number | null {
  if (key.endsWith("Rad")) return 4;
  if (key.endsWith("In")) return 3;
  // An acceleration (`accelInPerS2`) is inches per second squared, rounded like a speed.
  if (key.endsWith("S2")) return 3;
  if (key.endsWith("S")) return 3;
  return null;
}

/** Rounds to `digits` decimals, without -0 and without exponent notation for our magnitudes. */
export function formatNumber(value: number, digits: number | null): string {
  if (!Number.isFinite(value)) throw new Error(`Cannot canonicalize the number ${String(value)}.`);
  if (digits === null) return JSON.stringify(value === 0 ? 0 : value);
  const rounded = Number(value.toFixed(digits));
  return JSON.stringify(rounded === 0 ? 0 : rounded);
}

type AnySchema = z.ZodTypeAny | null;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Peels the wrappers that do not change an object's shape. */
function unwrap(schema: AnySchema): AnySchema {
  let current = schema;
  for (let guard = 0; guard < 32 && current !== null; guard += 1) {
    if (
      current instanceof z.ZodOptional ||
      current instanceof z.ZodNullable ||
      current instanceof z.ZodDefault ||
      current instanceof z.ZodReadonly
    ) {
      current = current._def.innerType as z.ZodTypeAny;
      continue;
    }
    if (current instanceof z.ZodEffects) {
      current = current._def.schema as z.ZodTypeAny;
      continue;
    }
    if (current instanceof z.ZodLazy) {
      current = (current._def.getter as () => z.ZodTypeAny)();
      continue;
    }
    return current;
  }
  return current;
}

/** The literal values an object schema pins, so a union option can be matched without parsing. */
function literalsOf(schema: z.ZodObject<z.ZodRawShape>): Map<string, unknown> {
  const literals = new Map<string, unknown>();
  for (const [key, value] of Object.entries(schema.shape)) {
    const inner = unwrap(value as z.ZodTypeAny);
    if (inner instanceof z.ZodLiteral) literals.set(key, inner.value);
  }
  return literals;
}

/** Picks the union member this value belongs to: by its discriminator first, then by parsing. */
function resolveSchema(schema: AnySchema, value: unknown): AnySchema {
  const current = unwrap(schema);
  if (current === null) return null;

  if (current instanceof z.ZodDiscriminatedUnion) {
    const discriminator = current._def.discriminator as string;
    if (isRecord(value)) {
      const option = (current._def.optionsMap as Map<unknown, z.ZodTypeAny>).get(
        value[discriminator],
      );
      if (option !== undefined) return unwrap(option);
    }
    return pickByParsing(current._def.options as z.ZodTypeAny[], value);
  }

  if (current instanceof z.ZodUnion) {
    const options = current._def.options as z.ZodTypeAny[];
    if (isRecord(value)) {
      for (const option of options) {
        const inner = unwrap(option);
        if (!(inner instanceof z.ZodObject)) continue;
        const literals = literalsOf(inner);
        if (literals.size === 0) continue;
        let matches = true;
        for (const [key, literal] of literals) {
          if (value[key] !== literal) matches = false;
        }
        if (matches) return inner;
      }
    }
    return pickByParsing(options, value);
  }

  return current;
}

function pickByParsing(options: readonly z.ZodTypeAny[], value: unknown): AnySchema {
  for (const option of options) {
    if (option.safeParse(value).success) return unwrap(option);
  }
  return null;
}

function childSchema(schema: AnySchema, key: string): AnySchema {
  const current = unwrap(schema);
  if (current instanceof z.ZodObject) {
    const shape = current.shape as z.ZodRawShape;
    return (shape[key] as z.ZodTypeAny | undefined) ?? null;
  }
  if (current instanceof z.ZodRecord) return current._def.valueType as z.ZodTypeAny;
  return null;
}

/** Schema declaration order first, then any key the schema does not name, in insertion order. */
function orderedKeys(schema: AnySchema, value: Record<string, unknown>): string[] {
  const current = unwrap(schema);
  const present = Object.keys(value).filter((key) => value[key] !== undefined);
  if (!(current instanceof z.ZodObject)) return present;
  const declared = Object.keys(current.shape as z.ZodRawShape);
  const known = declared.filter((key) => present.includes(key));
  const extra = present.filter((key) => !declared.includes(key));
  return [...known, ...extra];
}

function write(value: unknown, schema: AnySchema, unitKey: string | null, indent: string): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    return formatNumber(value, unitKey === null ? null : digitsForKey(unitKey));
  }

  const resolved = resolveSchema(schema, value);
  const inner = indent + INDENT;

  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const element =
      resolved instanceof z.ZodArray ? (resolved._def.type as z.ZodTypeAny) : null;
    const items = value.map((item) => `${inner}${write(item, element, unitKey, inner)}`);
    return `[\n${items.join(",\n")}\n${indent}]`;
  }

  if (isRecord(value)) {
    const keys = orderedKeys(resolved, value);
    if (keys.length === 0) return "{}";
    const lines = keys.map((key) => {
      // A key names its own unit or none at all; the parent's never reaches into an object.
      const childUnit = digitsForKey(key) === null ? null : key;
      const child = write(value[key], childSchema(resolved, key), childUnit, inner);
      return `${inner}${JSON.stringify(key)}: ${child}`;
    });
    return `{\n${lines.join(",\n")}\n${indent}}`;
  }

  throw new Error(`Cannot canonicalize a value of type ${typeof value}.`);
}
