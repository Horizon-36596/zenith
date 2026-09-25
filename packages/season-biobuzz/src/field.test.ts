import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PROVENANCE_LABELS } from "@horizon36596/zenith-core";
import { describe, expect, it } from "vitest";

const seasonField = fileURLToPath(new URL("../field/biobuzz.field.json", import.meta.url));
const exampleField = fileURLToPath(
  new URL("../../../examples/starter/autos/field/biobuzz.field.json", import.meta.url),
);

interface Sourced {
  id: string;
  provenance?: string;
}

function items(path: string): Sourced[] {
  const field = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  return ["obstacles", "zones", "elements", "targets"].flatMap(
    (key) => (field[key] as Sourced[] | undefined) ?? [],
  );
}

describe("BIOBUZZ field provenance", () => {
  it("finding 31: every item's provenance starts with a rule-4 label", () => {
    const unlabelled = items(seasonField)
      .filter((item) => !PROVENANCE_LABELS.some((label) => item.provenance?.startsWith(label)))
      .map((item) => item.id);
    expect(unlabelled).toEqual([]);
  });

  it("finding 31: the starter project's copy of the field matches the season's", () => {
    const normalise = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");
    expect(normalise(exampleField)).toBe(normalise(seasonField));
  });
});
