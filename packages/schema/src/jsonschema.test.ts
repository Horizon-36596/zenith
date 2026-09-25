import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { KINDS, SCHEMA_ID } from "./ids.js";
import { JSON_SCHEMA_DIALECT, jsonSchemaText, toJsonSchema } from "./jsonschema.js";

describe("published JSON Schema", () => {
  it("carries the 2020-12 dialect and this kind's $id", () => {
    for (const kind of KINDS) {
      const generated = toJsonSchema(kind);
      expect(generated["$schema"]).toBe(JSON_SCHEMA_DIALECT);
      expect(generated["$id"]).toBe(SCHEMA_ID[kind]);
      expect(generated["type"]).toBe("object");
    }
  });

  it("matches the files checked into json/", () => {
    for (const kind of KINDS) {
      const path = fileURLToPath(new URL(`../json/${kind}.json`, import.meta.url));
      const onDisk = readFileSync(path, "utf8").split("\r\n").join("\n");
      expect(onDisk, `json/${kind}.json is stale; run pnpm --filter @horizon36596/zenith-schema gen:json`).toBe(
        jsonSchemaText(kind),
      );
    }
  });
});
