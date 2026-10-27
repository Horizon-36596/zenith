import { zodToJsonSchema } from "zod-to-json-schema";
import { FORMAT_VERSIONS, SCHEMA_ID, type Kind } from "./ids.js";
import { schemaByKind } from "./migrate.js";

/** The meta-schema every generated file declares. */
export const JSON_SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema";

/**
 * Generates the JSON Schema for one kind from its zod schema.
 *
 * zod-to-json-schema has no 2020-12 target. Its draft-7 output uses numeric exclusive bounds and
 * validates under 2020-12 for these schemas (we use no tuples). Version 3.25.2 emits obsolete boolean
 * bounds for its 2019-09 target, so use draft 7 and set the dialect and `$id` here.
 */
export function toJsonSchema(kind: Kind): Record<string, unknown> {
  const generated = zodToJsonSchema(schemaByKind[kind], {
    target: "jsonSchema7",
    definitionPath: "$defs",
    errorMessages: false,
  }) as Record<string, unknown>;
  delete generated["$schema"];
  return {
    $schema: JSON_SCHEMA_DIALECT,
    $id: SCHEMA_ID[kind],
    title: `Zenith ${kind} file, formatVersion ${String(FORMAT_VERSIONS[kind])}`,
    ...generated,
  };
}

/** The canonical text of a generated schema file: two-space indent, LF, trailing newline. */
export function jsonSchemaText(kind: Kind): string {
  return `${JSON.stringify(toJsonSchema(kind), null, 2)}\n`;
}
