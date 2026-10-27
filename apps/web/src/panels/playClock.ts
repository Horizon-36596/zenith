/**
 * The playback clock (site/docs/simulation.md: "one second of routine per second"). Playback
 * advances by the wall time that really passed between animation frames, so a slow machine that
 * draws fewer frames still plays in real time and only looks choppier. The one exception is a gap
 * too long to be a frame at all: a backgrounded tab, a laptop lid, a debugger pause. That gap
 * counts as `MAX_FRAME_GAP_S` and no more, so coming back to the tab does not find the robot
 * teleported to the end of the routine.
 *
 * Pure: the caller hands in the frame timestamps.
 */

/** Longer than any frame a loaded machine really draws; shorter than a tab left in the background. */
export const MAX_FRAME_GAP_S = 1;

export interface PlayClock {
  /** The previous frame's timestamp, in milliseconds, or null before the first frame. */
  lastMs: number | null;
}

/**
 * The playhead after the frame at `nowMs`. The first frame only sets the baseline: the frame
 * timestamp `requestAnimationFrame` passes is the frame's start, which can be earlier than any
 * clock read when Play was pressed, so measuring from that read would lose part of a frame.
 */
export function advancePlayhead(clock: PlayClock, playheadS: number, nowMs: number): { clock: PlayClock; playheadS: number } {
  if (clock.lastMs === null) return { clock: { lastMs: nowMs }, playheadS };
  const gapS = Math.min(Math.max(0, nowMs - clock.lastMs) / 1000, MAX_FRAME_GAP_S);
  return { clock: { lastMs: nowMs }, playheadS: playheadS + gapS };
}

/**
 * What one frame of playback does with the playhead `nextS` would move to, against the run's end
 * `runS`: keep playing, or stop at the end. While the run is still streaming in (a Full sim run from
 * the desktop app's sim server), its end is only the last time received, so the playhead waits there
 * and goes on as more arrives, rather than stopping as at the end of a finished run. A null
 * `playheadS` leaves the playhead where it is.
 */
export function playFrame(nextS: number, runS: number | null, streaming: boolean): { playheadS: number | null; playing: boolean } {
  // No run yet: the playhead stays where it is (null), and waits only for a run on its way.
  if (runS === null || runS <= 0) return { playheadS: null, playing: streaming };
  if (nextS < runS) return { playheadS: nextS, playing: true };
  return { playheadS: runS, playing: streaming };
}
