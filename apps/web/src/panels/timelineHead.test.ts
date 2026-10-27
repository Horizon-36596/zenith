/**
 * The timeline head's total (issue #411): the "~" rough chip goes only with a number on the
 * estimate's clock, a level with no total yet says the estimate stands in, and every hint the head
 * can build, the estimate's seconds included, stays within the tooltip cap.
 */
import { describe, expect, it } from "vitest";
import { parseTrace } from "@horizon36596/zenith-core";
import { TOOLTIP_HINT_CAP } from "../help/textCaps";
import type { PlaybackLevel } from "../state/playback";
import { BOUND_HINT, ESTIMATE_TOTAL_HINT, fullSimLengths, headTotal } from "./timelineHead";

const LEVELS: readonly PlaybackLevel[] = ["ideal", "instant", "full"];

describe("the timeline head total", () => {
  it("shows the rough chip on Ideal only, never beside a sim total", () => {
    expect(headTotal({ level: "ideal", levelS: 16.2, estimateS: 15.85, bound: "upper" }).rough).toBe(true);
    expect(headTotal({ level: "instant", levelS: 16.9, estimateS: 15.85, bound: "upper" }).rough).toBe(false);
    expect(headTotal({ level: "full", levelS: 17.1, estimateS: 15.85, bound: "lower" }).rough).toBe(false);
    expect(headTotal({ level: "ideal", levelS: 16.2, estimateS: 15.85, bound: null }).rough).toBe(false);
  });

  it("says the estimate stands in while the level has no total yet, with the chip when it is rough", () => {
    for (const level of LEVELS) {
      const head = headTotal({ level, levelS: null, estimateS: 15.85, bound: "upper" });
      expect(head).toEqual({ seconds: 15.85, label: "Estimate total", hint: ESTIMATE_TOTAL_HINT, rough: true });
    }
    expect(headTotal({ level: "instant", levelS: null, estimateS: null, bound: null })).toMatchObject({ seconds: null, rough: false });
  });

  it("names the level and adds the estimate only when it differs", () => {
    const sim = headTotal({ level: "instant", levelS: 16.9, estimateS: 15.85, bound: null });
    expect(sim.label).toBe("Instant sim total");
    expect(sim.hint).toMatch(/The estimate alone is 15\.85 s\.$/);
    expect(headTotal({ level: "instant", levelS: 15.852, estimateS: 15.85, bound: null }).hint).not.toContain("estimate alone");
  });

  it("keeps every hint it can build within the tooltip cap", () => {
    const hints = [ESTIMATE_TOTAL_HINT, ...Object.values(BOUND_HINT)];
    for (const level of LEVELS) {
      // A three-digit total is the longest the estimate's seconds can read.
      hints.push(headTotal({ level, levelS: 1.5, estimateS: 123.45, bound: "lower" }).hint);
    }
    for (const hint of hints) expect(hint.length, hint).toBeLessThanOrEqual(TOOLTIP_HINT_CAP);
  });
});

describe("the Full sim level's lengths", () => {
  // A SimLoop run records the 30 s period and a 2 s margin, long after a 4.86 s routine has ended.
  const trace = parseTrace({
    steps: [
      { id: "scorePreload", startS: 0, endS: 2.61 },
      { id: "driveOut", startS: 2.61, endS: 4.86 },
    ],
    poses: [
      [0, -40, -63, 1.5708],
      [4.86, -20, -40, 1.5708],
      [31.98, -20, -40, 1.5708],
    ],
  });

  it("totals the routine to its last step's end, and plays no further, once the run is complete", () => {
    expect(fullSimLengths(trace, false)).toEqual({ totalS: 4.86, runS: 4.86 });
    const head = headTotal({ level: "full", levelS: fullSimLengths(trace, false).totalS, estimateS: 5, bound: null });
    expect(head.seconds).toBe(4.86);
  });

  it("plays to the last time received while the run is still streaming in", () => {
    expect(fullSimLengths(trace, true)).toEqual({ totalS: 4.86, runS: 31.98 });
  });

  it("runs to the end of the recording when the trace records no steps", () => {
    const stepless = parseTrace({
      poses: [
        [0, 0, 0, 0],
        [1.5, 1, 0, 0],
      ],
    });
    expect(fullSimLengths(stepless, false)).toEqual({ totalS: 1.5, runS: 1.5 });
    expect(fullSimLengths(null, false)).toEqual({ totalS: null, runS: null });
  });
});
