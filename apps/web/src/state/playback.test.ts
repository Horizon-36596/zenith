import { describe, expect, it } from "vitest";
import { DEFAULT_PREFS } from "./prefs";
import {
  clampPlayhead,
  effectiveLevel,
  levelInputs,
  levelUnavailable,
  PLAYBACK_LEVELS,
  shownLevels,
  stepPlayhead,
} from "./playback";

/** The playback levels' availability rules (site/docs/simulation.md, "Playback levels"). */
describe("playback levels", () => {
  const nothing = levelInputs({ trace: null, reason: null }, null);
  const everything = levelInputs({ trace: {}, reason: null }, {});

  it("defaults to Ideal", () => {
    expect(DEFAULT_PREFS.playbackLevel).toBe("ideal");
    expect(PLAYBACK_LEVELS).toEqual(["ideal", "instant", "full"]);
  });

  it("always offers Ideal", () => {
    expect(levelUnavailable("ideal", nothing)).toBeNull();
  });

  it("offers Instant sim once the sim has run, and says why not when it could not", () => {
    expect(levelUnavailable("instant", everything)).toBeNull();
    expect(levelUnavailable("instant", nothing)).toMatch(/has not run/);
    const failed = levelInputs({ trace: null, reason: "no heading" }, null);
    expect(levelUnavailable("instant", failed)).toMatch(/could not run this routine: no heading/);
  });

  it("offers Full sim only with a trace, and says how to get one", () => {
    expect(levelUnavailable("full", everything)).toBeNull();
    // Outside the desktop app the Gradle sim cannot be started from here.
    expect(levelUnavailable("full", nothing)).toMatch(/only the desktop app can start/);
    // In the words the Simulate dialog uses (0.1.2 UX review): the sim command runs in the team's own repository.
    expect(levelUnavailable("full", nothing)).toContain("run the sim command in your robot repository");
    expect(levelUnavailable("full", nothing)).not.toContain("that repository");
  });

  describe("while the Full sim switch is off (issue #207)", () => {
    const hidden = (sim: { trace: unknown; reason: string | null }, trace: unknown = null) => levelInputs(sim, trace, null, false);

    it("offers only Ideal and Instant sim", () => {
      expect(shownLevels(hidden({ trace: {}, reason: null }))).toEqual(["ideal", "instant"]);
      expect(shownLevels(everything)).toEqual(PLAYBACK_LEVELS);
      expect(levelUnavailable("full", hidden({ trace: {}, reason: null }, {}))).toMatch(/switched off in this version/);
    });

    it("plays a remembered Full sim as Instant sim, or Ideal when the instant sim has no run", () => {
      expect(effectiveLevel("full", hidden({ trace: {}, reason: null }))).toBe("instant");
      // Even a loaded trace does not bring the level back.
      expect(effectiveLevel("full", hidden({ trace: {}, reason: null }, {}))).toBe("instant");
      expect(effectiveLevel("full", hidden({ trace: null, reason: "no heading" }))).toBe("ideal");
      expect(effectiveLevel("instant", hidden({ trace: {}, reason: null }))).toBe("instant");
      expect(effectiveLevel("ideal", hidden({ trace: {}, reason: null }))).toBe("ideal");
    });

    it("still offers Full sim when a host simulates", () => {
      const host = levelInputs({ trace: {}, reason: null }, {}, { name: "DSIM", simulate: true }, false);
      expect(shownLevels(host)).toEqual(PLAYBACK_LEVELS);
      expect(effectiveLevel("full", host)).toBe("full");
    });
  });

  it("plays Ideal while the chosen level is unavailable", () => {
    expect(effectiveLevel("full", nothing)).toBe("ideal");
    expect(effectiveLevel("instant", nothing)).toBe("ideal");
    expect(effectiveLevel("full", everything)).toBe("full");
    expect(effectiveLevel("instant", everything)).toBe("instant");
    // With the switch on, a remembered Full sim with no trace plays Ideal, not the instant sim.
    expect(effectiveLevel("full", levelInputs({ trace: {}, reason: null }, null))).toBe("ideal");
  });
});

/** The playhead never runs past the run's end, whatever moves it (issue #316). */
describe("playhead bounds", () => {
  it("stops a step forward at the run's end and a step back at 0", () => {
    expect(stepPlayhead(23.95, 0.1, 24.01)).toBe(24.01);
    expect(stepPlayhead(24.01, 0.1, 24.01)).toBe(24.01);
    expect(stepPlayhead(0.05, -0.1, 24.01)).toBe(0);
    expect(stepPlayhead(5, 0.1, 24.01)).toBeCloseTo(5.1);
  });

  it("brings a playhead past a shorter run back to its new end", () => {
    expect(clampPlayhead(23.51, 21.5)).toBe(21.5);
    expect(clampPlayhead(10, 21.5)).toBe(10);
  });

  it("leaves the end open when there is no run length", () => {
    expect(stepPlayhead(30, 0.1, null)).toBeCloseTo(30.1);
    expect(clampPlayhead(-1, null)).toBe(0);
  });
});
