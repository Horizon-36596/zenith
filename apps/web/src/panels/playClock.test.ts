import { describe, expect, it } from "vitest";
import { advancePlayhead, MAX_FRAME_GAP_S, type PlayClock } from "./playClock";

/** Plays through frames at the given timestamps and returns the playhead. */
function play(framesMs: readonly number[]): number {
  let clock: PlayClock = { lastMs: null };
  let playheadS = 0;
  for (const nowMs of framesMs) ({ clock, playheadS } = advancePlayhead(clock, playheadS, nowMs));
  return playheadS;
}

describe("the playback clock", () => {
  it("advances by the wall time between frames at 60 Hz", () => {
    const frames = Array.from({ length: 121 }, (_, i) => 1000 + (i * 1000) / 60);
    expect(play(frames)).toBeCloseTo(2, 9);
  });

  it("keeps real time on a slow machine that draws few, uneven frames", () => {
    // A weak laptop under load: 4 to 400 ms between frames, 2 s in all.
    const frames = [500, 504, 604, 904, 1304, 1350, 1700, 2100, 2400, 2500];
    expect(play(frames)).toBeCloseTo(2, 9);
  });

  it("does not count the time before the first frame", () => {
    expect(play([5000])).toBe(0);
    expect(play([5000, 5100])).toBeCloseTo(0.1, 9);
  });

  it("counts a backgrounded tab's gap as one long frame, not the whole gap", () => {
    expect(play([0, 16, 60_016, 60_032])).toBeCloseTo(0.016 + MAX_FRAME_GAP_S + 0.016, 9);
  });

  it("never runs backwards on an out-of-order timestamp", () => {
    expect(play([100, 90, 190])).toBeCloseTo(0.1, 9);
  });
});
