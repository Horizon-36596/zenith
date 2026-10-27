/**
 * The estimate in the selection header (issues #239 and #431), such as `1.59 s`, that replaces the
 * Estimated and Strafe fraction rows. The strafe fraction is in its hint, and it never reads `— s`.
 */
import type { StepEstimate } from "@horizon36596/zenith-core";
import { describe, expect, it } from "vitest";
import { metaLineHint, metaLineText } from "./metaLine";

const row = (patch: Partial<StepEstimate>): StepEstimate => ({
  stepId: "s",
  kind: "path",
  nominalS: 1.59,
  lowS: 1.4,
  highS: 1.8,
  strafeFraction: null,
  strafeCostS: null,
  unknown: false,
  exitVelocityInPerS: 0,
  ...patch,
});

describe("the header estimate", () => {
  it("reads the estimate with its unit, and no est (issue #431)", () => {
    expect(metaLineText(row({}))).toBe("1.59 s");
  });

  it("says at most for a time that comes from the envelope", () => {
    expect(metaLineText(row({ kind: "command", nominalS: 2.6, fromEnvelope: true }))).toBe("at most 2.60 s");
  });

  it("says what-if for a time that comes from the envelope's Actual run time (issue #481)", () => {
    expect(metaLineText(row({ kind: "command", nominalS: 1.5, fromEnvelope: true, fromActualDuration: true }))).toBe(
      "what-if 1.50 s",
    );
  });

  it("reads a wait-until's cap, not a dash, when only its Timeout bounds it", () => {
    expect(metaLineText(row({ kind: "wait", nominalS: null, lowS: null, highS: 1, unknown: true }))).toBe(
      "≤ 1.00 s",
    );
  });

  it("says no estimate when nothing bounds the step", () => {
    expect(metaLineText(row({ kind: "wait", nominalS: null, lowS: null, highS: null, unknown: true }))).toBe(
      "no estimate",
    );
    expect(metaLineText(undefined)).toBe("no estimate");
  });

  it("never reads a dash followed by a unit, on any step kind", () => {
    const kinds: Array<StepEstimate["kind"]> = ["path", "command", "wait", "transfer", "sequence", "parallel", "branch"];
    for (const kind of kinds) {
      for (const nominalS of [null, 0, 1.25]) {
        for (const highS of [null, 2]) {
          const text = metaLineText(row({ kind, nominalS, highS }));
          expect(text, `${kind} ${String(nominalS)} ${String(highS)}`).not.toMatch(/—/);
        }
      }
    }
  });

  it("carries the strafe fraction in its hint, not on the line", () => {
    expect(metaLineText(row({ strafeFraction: 0.25 }))).not.toContain("0.25");
    const hint = metaLineHint("inspector.estimated", [{ value: "0.25", describe: "inspector.strafeFraction" }]);
    expect(hint).toBe(
      "How long the plan expects this step to take. 'at most' means the time comes from the step's envelope, and 'what-if' from its Actual time. " +
        "Strafe fraction 0.25: how much of this path the robot drives sideways. From 0 to 1. Sideways is slower than nose first.",
    );
    expect(metaLineHint("inspector.estimated")).not.toContain("Strafe");
  });
});
