import type { TracePoseRow } from "@horizon36596/zenith-core";
import { describe, expect, it } from "vitest";
import { traceBreaks } from "./liveLayer.js";
import type { TraceOverlay } from "./types.js";

const trace = (poses: TracePoseRow[], tickS?: number): TraceOverlay => ({
  poses,
  steps: [],
  ...(tickS === undefined ? {} : { tickS }),
});

describe("traceBreaks", () => {
  it("starts one sub-path for a run with no reset", () => {
    const rows: TracePoseRow[] = [
      [0, 0, 0, 0],
      [0.02, 1, 0, 0],
      [0.04, 2, 0, 0],
      [0.06, 3, 0.5, 0],
    ];
    expect(traceBreaks(trace(rows, 0.02))).toEqual([0]);
  });

  it("starts a new sub-path at a mid-run pose reset instead of joining across the jump", () => {
    const rows: TracePoseRow[] = [
      [0, -40, -63, 0],
      [0.02, -40, -62, 0],
      [0.04, -40, -61, 0],
      // The localizer is re-seeded: 61 in in one tick.
      [0.06, 0, 0, 0],
      [0.08, 0.5, 0, 0],
    ];
    expect(traceBreaks(trace(rows, 0.02))).toEqual([0, 3]);
  });

  it("does not call a fast but drivable move a reset", () => {
    // 40 in over half a second is 80 in/s, and 1.6 in in one tick is under the 6 in floor.
    expect(traceBreaks(trace([[0, 0, 0, 0], [0.5, 40, 0, 0]], 0.02))).toEqual([0]);
    expect(traceBreaks(trace([[0, 0, 0, 0], [0.02, 1.6, 0, 0]], 0.02))).toEqual([0]);
  });

  it("uses the time between rows when the overlay carries no tick", () => {
    expect(traceBreaks(trace([[0, 0, 0, 0], [0.02, 7, 0, 0]]))).toEqual([0, 1]);
    expect(traceBreaks(trace([[0, 0, 0, 0], [1, 7, 0, 0]]))).toEqual([0]);
  });

  it("returns nothing for an empty trace", () => {
    expect(traceBreaks(trace([]))).toEqual([]);
  });
});
