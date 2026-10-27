import type { ZodTypeAny } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { PATH_FORMAT_VERSION, PATH_SCHEMA_ID, pathFileSchema } from "./path/schema.js";
import { TRAJECTORY_FORMAT_VERSION, TRAJECTORY_SCHEMA_ID, trajectoryFileSchema } from "./trajectory/schema.js";

/** The meta-schema every generated file declares, as `@horizon36596/zenith-schema` does. */
const JSON_SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema";

/**
 * A published JSON Schema, generated from its zod schema, with its served id and a title. Draft 7, as
 * in `@horizon36596/zenith-schema`: zod-to-json-schema 3.25.2 writes obsolete boolean exclusive bounds
 * for its 2019-09 target, which a 2020-12 validator rejects.
 */
function generate(schema: ZodTypeAny, id: string, title: string): Record<string, unknown> {
  const generated = zodToJsonSchema(schema, {
    target: "jsonSchema7",
    definitionPath: "$defs",
    errorMessages: false,
  }) as Record<string, unknown>;
  delete generated["$schema"];
  return { $schema: JSON_SCHEMA_DIALECT, $id: id, title, ...generated };
}

/** The canonical text of a generated schema: two-space indent, LF, trailing newline. */
const text = (schema: Record<string, unknown>): string => `${JSON.stringify(schema, null, 2)}\n`;

/** The published JSON Schema of `trajectory.json`, generated from its zod schema. */
export function trajectoryJsonSchema(): Record<string, unknown> {
  return generate(trajectoryFileSchema, TRAJECTORY_SCHEMA_ID, `Zenith interchange trajectory file, formatVersion ${String(TRAJECTORY_FORMAT_VERSION)}`);
}

/** The published JSON Schema of `path.json`, generated from its zod schema. */
export function pathJsonSchema(): Record<string, unknown> {
  return generate(pathFileSchema, PATH_SCHEMA_ID, `Zenith interchange path file, formatVersion ${String(PATH_FORMAT_VERSION)}`);
}

/** The canonical text of the generated `trajectory.json` schema. */
export const trajectoryJsonSchemaText = (): string => text(trajectoryJsonSchema());

/** The canonical text of the generated `path.json` schema. */
export const pathJsonSchemaText = (): string => text(pathJsonSchema());

/** Every interchange schema this package publishes, by the file name it is served under. */
export const interchangeJsonSchemaTexts = (): Record<string, string> => ({
  "trajectory.json": trajectoryJsonSchemaText(),
  "path.json": pathJsonSchemaText(),
});
