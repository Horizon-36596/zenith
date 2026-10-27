/**
 * The timeline's recorded total (W4-4 of the 0.1.2 sweep): when the routine ended, never every
 * step's duration added up, which counted a parallel group and each step inside it again, and the
 * same end the Full level's total uses.
 */
import { describe, expect, it } from "vitest";
import { parseTrace } from "@horizon36596/zenith-core";
import { fullSimLengths } from "./timelineHead";
import { againstPlan, fullSimSentence, RECORDED_CLOCK_HINT, RECORDED_ROUTINE_HINT, RECORDED_SAMPLE_HINT, recordedTotal, signedSeconds } from "./recordedTotal";

/** A drive, then a parallel group of a drive and an intake sequence, then a shot: 9.22 s in all. */
const STEPS = [
  { id: "driveOut", startS: 0, endS: 2 },
  { id: "collect", startS: 2, endS: 6 },
  { id: "collect.1", startS: 2, endS: 6 },
  { id: "collect.2", startS: 2, endS: 5 },
  { id: "collect.2.1", startS: 2, endS: 2.5 },
  { id: "collect.2.2", startS: 2.5, endS: 5 },
  { id: "score", startS: 6, endS: 9.22 },
];

describe("the recorded total", () => {
  it("ends at the routine's last step, not the sum of every step with a group's children", () => {
    // The sim records on to 31.98 s, the period and its margin, long after the routine.
    const trace = parseTrace({ simTimeS: 31.98, steps: STEPS, poses: [[0, 0, 0, 0], [31.98, 0, 0, 0]] });
    const every = STEPS.reduce((sum, row) => sum + row.endS - row.startS, 0);
    expect(every).toBeGreaterThan(9.22 + 3);
    const total = recordedTotal(trace);
    expect(total.seconds).toBeCloseTo(9.22, 9);
    expect(total.hint).toBe(RECORDED_ROUTINE_HINT);
    // The Full level's total says the same.
    expect(fullSimLengths(trace, false).totalS).toBe(total.seconds);
  });

  it("is the trace's own clock when it records no steps", () => {
    expect(recordedTotal(parseTrace({ simTimeS: 9.22, poses: [[0, 0, 0, 0], [9.2, 0, 0, 0]] }))).toEqual({
      seconds: 9.22,
      hint: RECORDED_CLOCK_HINT,
    });
  });

  it("is the last pose sample's time with neither steps nor a clock", () => {
    expect(recordedTotal(parseTrace({ poses: [[0, 0, 0, 0], [9.2, 0, 0, 0]] }))).toEqual({
      seconds: 9.2,
      hint: RECORDED_SAMPLE_HINT,
    });
  });
});

describe("the recorded total in words (0.1.2 UX review)", () => {
  it("says the level once, the total, and how it stands against the plan, in one sentence", () => {
    expect(fullSimSentence(6.2, 5.95)).toBe("Full sim 6.20 s, +0.25 s on the 5.95 s plan");
    expect(fullSimSentence(5.8, 5.95)).toBe("Full sim 5.80 s, -0.15 s on the 5.95 s plan");
    expect(fullSimSentence(6.2, null)).toBe("Full sim 6.20 s");
    expect(againstPlan(6.2, 5.95)).toBe("+0.25 s on the 5.95 s plan");
  });

  it("signs the difference as printed, and prints one that rounds to zero with no sign", () => {
    expect(signedSeconds(6.2004 - 6.2)).toBe("0.00 s");
    expect(signedSeconds(-0.001)).toBe("0.00 s");
    expect(signedSeconds(0)).toBe("0.00 s");
    expect(signedSeconds(-0.1)).toBe("-0.10 s");
    expect(signedSeconds(0.006)).toBe("+0.01 s");
  });
});
