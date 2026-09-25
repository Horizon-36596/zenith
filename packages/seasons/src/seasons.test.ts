import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadField } from "@horizon36596/zenith-core";
import type { Field } from "@horizon36596/zenith-schema";
import { beforeAll, describe, expect, it } from "vitest";
import { listSeasons, resolveSeason, seasonFor } from "./index.js";

const fieldPath = fileURLToPath(
  new URL("../../season-biobuzz/field/biobuzz.field.json", import.meta.url),
);

let biobuzz: Field;

beforeAll(() => {
  biobuzz = loadField(JSON.parse(readFileSync(fieldPath, "utf8")) as unknown);
});

/** The field file with its `rules` block rewritten, which is the only knob this package reads. */
const withPlugin = (field: Field, plugin: string | undefined): Field =>
  ({
    ...field,
    rules: { ...(field.rules ?? {}), ...(plugin === undefined ? {} : { plugin }) },
  }) as Field;

describe("seasonFor", () => {
  it("resolves the BIOBUZZ field file to the BIOBUZZ rules", () => {
    const resolution = resolveSeason(biobuzz);
    expect(resolution.known).toBe(true);
    expect(resolution.plugin).toBe("season-biobuzz");
    expect(resolution.warnings).toEqual([]);
    expect(resolution.rules.id).toBe("season-biobuzz");
    expect(seasonFor(biobuzz).id).toBe("season-biobuzz");
  });

  it("falls back to the season name when the file names no plugin", () => {
    const field = { ...biobuzz, rules: undefined } as unknown as Field;
    expect(seasonFor(field).id).toBe("season-biobuzz");
  });

  it("returns inert rules and a warning for a plugin this build does not carry", () => {
    const resolution = resolveSeason(withPlugin(biobuzz, "season-centerstage"));
    expect(resolution.known).toBe(false);
    expect(resolution.rules.id).toBe("none");
    expect(resolution.warnings).toHaveLength(1);
    expect(resolution.warnings[0]).toContain("season-centerstage");
    expect(resolution.warnings[0]).toContain("season-biobuzz");
  });

  it("lists the seasons this build carries", () => {
    expect(listSeasons().map((season) => season.plugin)).toContain("season-biobuzz");
  });
});
