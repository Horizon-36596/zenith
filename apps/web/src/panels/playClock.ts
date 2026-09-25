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
