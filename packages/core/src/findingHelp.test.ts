import { describe, expect, it } from "vitest";
import {
  FINDING_HELP,
  FINDING_HELP_BY_SEVERITY,
  SEGMENT_GAP_HELP,
  helpByCode,
  helpForFinding,
  type FindingHelp,
} from "./findingHelp.js";
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
  CLEARANCE: true,
  KEEPOUT: true,
  OPPONENT_SIDE: true,
  START_ILLEGAL: true,
  LEGAL_APPROACH: true,
  TURRET_RANGE: true,
  CAPACITY: true,
  EMPTY_SHOT: true,
  LAUNCH_TARGET: true,
  STRAFE_FRACTION: true,
  MOUTH_LEADING: true,
  SWEEP_SPEED: true,
  TIME_BUDGET: true,
  TIMEOUT_TIGHT: true,
  WAIT_NO_TIMEOUT: true,
  STATIONARY_MARKER: true,
  MOVES_ROBOT: true,
  PROVENANCE: true,
  ENVELOPE_SHAPE: true,
  TRANSFER: true,
  STEP_ID: true,
  ALLIANCE_COLLISION: true,
  ALLIANCE_NEAR_MISS: true,
  ALLIANCE_START_OVERLAP: true,
  ALLIANCE_ELEMENT_CONFLICT: true,
  ALLIANCE_ENVELOPE: true,
  PROPOSAL_SHARE: true,
  PROPOSAL_STALE: true,
  PROPOSAL_TOKEN: true,
  PROPOSAL_CHANGE: true,
  PROPOSAL_CONFLICT: true,
  REGISTRY: true,
};

const sentences = (text: string): number => text.split(/(?<=[.!?])\s+/).filter((part) => part.length > 0).length;

describe("FINDING_HELP", () => {
  it("covers every finding code and nothing else", () => {
    expect(Object.keys(FINDING_HELP).sort()).toEqual(Object.keys(CODES).sort());
  });

  // The code's own entries, then the ones a severity has of its own, under "CODE severity".
  const everyEntry = (): Array<[string, FindingHelp]> => [
    ...Object.entries(FINDING_HELP),
    ...Object.entries(FINDING_HELP_BY_SEVERITY).flatMap(([code, bySeverity]) =>
      Object.entries(bySeverity ?? {}).map(([severity, help]): [string, FindingHelp] => [`${code} ${severity}`, help]),
    ),
  ];

  it("says what each code means and how to fix it in one or two short sentences", () => {
    for (const [code, help] of everyEntry()) {
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
    for (const [code, help] of everyEntry()) {
      expect(`${help.means} ${help.fix}`, code).not.toContain(code.split(" ")[0]);
    }
  });

  it("gives TIME_BUDGET's info note its own words, and keeps the code's for a warning or an error", () => {
    const info = helpForFinding({ code: "TIME_BUDGET", severity: "info" });
    expect(info).toBe(FINDING_HELP_BY_SEVERITY.TIME_BUDGET?.info);
    expect(info.title).not.toBe(FINDING_HELP.TIME_BUDGET.title);
    expect(helpForFinding({ code: "TIME_BUDGET", severity: "warning" })).toBe(FINDING_HELP.TIME_BUDGET);
    expect(helpForFinding({ code: "PERIMETER", severity: "error" })).toBe(FINDING_HELP.PERIMETER);
  });

  it("keys help once per code, with the words for the most severe finding of it", () => {
    expect(helpByCode([{ code: "TIME_BUDGET", severity: "info" }]).TIME_BUDGET).toBe(
      FINDING_HELP_BY_SEVERITY.TIME_BUDGET?.info,
    );
    expect(
      helpByCode([
        { code: "TIME_BUDGET", severity: "info" },
        { code: "TIME_BUDGET", severity: "warning" },
      ]).TIME_BUDGET,
    ).toBe(FINDING_HELP.TIME_BUDGET);
  });

  it("gives a segment gap its own words in a row, and keeps CONTINUITY's per-code help (issue #146)", () => {
    const fixes = [{ kind: "joinSegments" as const, stepId: "drive", label: "Join path 2 to path 1", params: { segmentIndex: 1 } }];
    expect(helpForFinding({ code: "CONTINUITY", severity: "error", fixes })).toBe(SEGMENT_GAP_HELP);
    expect(helpForFinding({ code: "CONTINUITY", severity: "error" })).toBe(FINDING_HELP.CONTINUITY);
    const gap = { code: "CONTINUITY" as const, severity: "error" as const, fixes };
    expect(helpByCode([gap]).CONTINUITY).toBe(FINDING_HELP.CONTINUITY);
  });
});
