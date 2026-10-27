import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { KINDS, SCHEMA_ID } from "./ids.js";
import { JSON_SCHEMA_DIALECT, jsonSchemaText, toJsonSchema } from "./jsonschema.js";

describe("published JSON Schema", () => {
  it("uses numeric exclusive bounds required by its declared dialect", () => {
    const bounds: { path: string; value: unknown }[] = [];
    const visit = (value: unknown, path: string): void => {
      if (value === null || typeof value !== "object") return;
      for (const [key, child] of Object.entries(value)) {
        const childPath = `${path}.${key}`;
        if (key === "exclusiveMinimum" || key === "exclusiveMaximum") {
          bounds.push({ path: childPath, value: child });
        } else visit(child, childPath);
      }
    };
    for (const kind of KINDS) visit(toJsonSchema(kind), kind);
    expect(bounds.length).toBeGreaterThan(0);
    expect(bounds.filter((bound) => typeof bound.value !== "number")).toEqual([]);
    expect(bounds.some((bound) => bound.value === 0)).toBe(true);
  });

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
