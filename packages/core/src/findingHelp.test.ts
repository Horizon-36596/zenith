import { describe, expect, it } from "vitest";
import { FINDING_HELP } from "./findingHelp.js";
import type { FindingCode } from "./types.js";

/** Item 4: plain-language help for every finding code. */

// Every code in the union, written out so a new code without help fails to compile here.
const CODES: Record<FindingCode, true> = {
  SCHEMA: true,
  CONTINUITY: true,
  HEADING_MISSING: true,
  HEADING: true,
  HEADING_RANGES: true,
  PERIMETER: true,
  STRUCTURE: true,
  KEEPOUT: true,
  START_ILLEGAL: true,
  LEGAL_APPROACH: true,
  TURRET_RANGE: true,
  CAPACITY: true,
  EMPTY_SHOT: true,
  STRAFE_FRACTION: true,
  MOUTH_LEADING: true,
  SWEEP_SPEED: true,
  TIME_BUDGET: true,
  TIMEOUT_TIGHT: true,
  STATIONARY_MARKER: true,
  MOVES_ROBOT: true,
  PROVENANCE: true,
};

const sentences = (text: string): number => text.split(/(?<=[.!?])\s+/).filter((part) => part.length > 0).length;

describe("FINDING_HELP", () => {
  it("covers every finding code and nothing else", () => {
    expect(Object.keys(FINDING_HELP).sort()).toEqual(Object.keys(CODES).sort());
  });

  it("says what each code means and how to fix it in one or two short sentences", () => {
    for (const [code, help] of Object.entries(FINDING_HELP)) {
      expect(help.title.length, code).toBeGreaterThan(0);
      expect(help.title.length, code).toBeLessThanOrEqual(32);
      for (const text of [help.means, help.fix]) {
        expect(sentences(text), `${code}: ${text}`).toBeGreaterThanOrEqual(1);
        expect(sentences(text), `${code}: ${text}`).toBeLessThanOrEqual(2);
        expect(text.length, `${code}: ${text}`).toBeLessThanOrEqual(200);
        expect(text.endsWith("."), `${code}: ${text}`).toBe(true);
      }
    }
  });

  it("does not lean on the code itself to explain it", () => {
    for (const [code, help] of Object.entries(FINDING_HELP)) {
      expect(`${help.means} ${help.fix}`, code).not.toContain(code);
    }
  });
});
