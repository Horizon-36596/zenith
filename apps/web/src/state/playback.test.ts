import { describe, expect, it } from "vitest";
import { DEFAULT_PREFS } from "./prefs";
import { effectiveLevel, levelInputs, levelUnavailable, PLAYBACK_LEVELS } from "./playback";

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
  });

  it("plays Ideal while the chosen level is unavailable", () => {
    expect(effectiveLevel("full", nothing)).toBe("ideal");
    expect(effectiveLevel("instant", nothing)).toBe("ideal");
    expect(effectiveLevel("full", everything)).toBe("full");
    expect(effectiveLevel("instant", everything)).toBe("instant");
  });
});
