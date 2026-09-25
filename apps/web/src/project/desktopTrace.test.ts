import { parseTrace, type TracePoseRow } from "@horizon36596/zenith-core";
import { describe, expect, it } from "vitest";
import { isPoseReset, settleTrace } from "./desktopTrace";

const trace = (poses: TracePoseRow[]) => parseTrace({ formatVersion: 1, auto: "first-auto", tickS: 0.02, poses, steps: [] });

describe("settleTrace", () => {
  it("drops the start pose the harness overwrote on its first tick", () => {
    // The shape a desktop sim trace has when the harness resets the follower after logging the
    // start: the first row is the starter's start pose, and from the second tick on the robot
    // reports poses near the follower's own origin.
    const settled = settleTrace(
      trace([
        [0, -12, -63, 1.571],
        [0.02, 0.039, 0.118, 1.571],
        [0.04, 0.039, 0.236, 1.571],
        [0.06, 0.079, 0.354, 1.571],
      ]),
    );
    expect(settled.droppedLeading).toBe(1);
    expect(settled.trace.poses[0]).toEqual([0.02, 0.039, 0.118, 1.571]);
    expect(settled.resets).toEqual([]);
  });

  it("drops a leading frame at the origin logged before the start pose was set", () => {
    const settled = settleTrace(
      trace([
        [0, 0, 0, 0],
        [0.02, -62.992, -35.984, 0],
        [0.04, -62.9, -35.9, 0],
      ]),
    );
    expect(settled.droppedLeading).toBe(1);
    expect(settled.trace.poses.map((row) => row[1])).toEqual([-62.992, -62.9]);
  });

  it("leaves a clean run alone, and returns the same trace", () => {
    const clean = trace([
      [0, -63, -36, 0],
      [0.02, -62.9, -36, 0],
      [0.04, -62.7, -36, 0],
    ]);
    expect(settleTrace(clean)).toEqual({ trace: clean, droppedLeading: 0, resets: [] });
  });

  it("keeps a reset in the middle of a run and says where it is", () => {
    const settled = settleTrace(
      trace([
        [0, -63, -36, 0],
        [0.5, -40, -36, 0],
        [0.52, 0, 0, 1.571],
        [0.54, 0.1, 0, 1.571],
      ]),
    );
    expect(settled.droppedLeading).toBe(0);
    expect(settled.resets).toEqual([2]);
    expect(settled.trace.poses).toHaveLength(4);
  });

  it("does not call a fast drive a reset", () => {
    expect(isPoseReset([0, 0, 0, 0], [0.02, 1.6, 0, 0], 0.02)).toBe(false);
    expect(isPoseReset([0, 0, 0, 0], [0.5, 40, 0, 0], 0.02)).toBe(false);
    expect(isPoseReset([0, 0, 0, 0], [0.02, 7, 0, 0], 0.02)).toBe(true);
  });
});
