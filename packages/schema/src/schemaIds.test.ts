import { describe, expect, it } from "vitest";
import { KINDS, LEGACY_SCHEMA_ID, SCHEMA_ID, withCurrentSchemaId } from "./ids.js";
import { detectKind, migrate } from "./migrate.js";
import { parseAuto, validateKind } from "./parse.js";

/** The smallest legal v2 auto, under the id named in the test. */
const autoWith = (id: string) => ({
  $schema: id,
  formatVersion: 2,
  name: "one-line",
  alliance: "RED",
  start: { pose: { xIn: -40, yIn: -63, headingRad: 1.5708 } },
  steps: [
    {
      id: "leg1",
      kind: "path",
      segments: [{ kind: "line", from: "current", to: { xIn: -40, yIn: -40 } }],
      heading: { mode: "tangent" },
    },
  ],
});

describe("schema ids", () => {
  it("serves every kind from libraries.horizon36596.org/zenith/schema/v1/", () => {
    for (const kind of KINDS) {
      expect(SCHEMA_ID[kind]).toBe(`https://libraries.horizon36596.org/zenith/schema/v1/${kind}.json`);
    }
  });

  it("keeps the legacy zenith.horizon36596.org ids as aliases, one per kind", () => {
    for (const kind of KINDS) {
      expect(LEGACY_SCHEMA_ID[kind]).toBe(`https://zenith.horizon36596.org/schema/v1/${kind}.json`);
      expect(detectKind({ $schema: LEGACY_SCHEMA_ID[kind] })).toBe(kind);
    }
  });

  it("loads a file that still names the legacy id, and hands it back under the current id", () => {
    const legacy = autoWith(LEGACY_SCHEMA_ID.auto);
    expect(validateKind("auto", legacy).ok).toBe(true);
    expect(migrate(legacy).data).toMatchObject({ $schema: SCHEMA_ID.auto });
    expect(parseAuto(legacy).$schema).toBe(SCHEMA_ID.auto);
    // The input is not mutated.
    expect(legacy.$schema).toBe(LEGACY_SCHEMA_ID.auto);
  });

  it("still refuses another kind's id, current or legacy", () => {
    expect(() => parseAuto(autoWith(SCHEMA_ID.robot))).toThrow(/\$schema must be/);
    expect(() => parseAuto(autoWith(LEGACY_SCHEMA_ID.robot))).toThrow(/\$schema must be/);
  });

  it("rewrites only the legacy alias of the kind asked for", () => {
    expect(withCurrentSchemaId("auto", { $schema: LEGACY_SCHEMA_ID.auto })).toEqual({ $schema: SCHEMA_ID.auto });
    const other = { $schema: LEGACY_SCHEMA_ID.robot };
    expect(withCurrentSchemaId("auto", other)).toBe(other);
    expect(withCurrentSchemaId("auto", null)).toBeNull();
  });
});
