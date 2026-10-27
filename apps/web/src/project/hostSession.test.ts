/**
 * Sweep W4-1: a host too old to read the autos this Zenith writes (DSIM build 1, which vendors
 * Zenith 0.1.1 and refuses auto format 4) gets "Simulate in" turned off with the out-of-date
 * sentence as the reason, instead of a run it would refuse inside its own window.
 */
import { afterEach, describe, expect, it } from "vitest";
import { setHost, type HostView } from "../state/store";
import { hostRunBlockedReason, runFailedAnswers } from "./hostSession";

describe("runFailedAnswers (sweep W4-2)", () => {
  const fileNameOf = (auto: string): string => (auto.endsWith(".auto.json") ? auto : `${auto}.auto.json`);

  it("answers the run that is waiting, named either way or not named", () => {
    expect(runFailedAnswers("first-auto", "first-auto", fileNameOf)).toBe(true);
    expect(runFailedAnswers("first-auto", "first-auto.auto.json", fileNameOf)).toBe(true);
    // No auto named, which is also what `auto: null` parses to.
    expect(runFailedAnswers("first-auto", undefined, fileNameOf)).toBe(true);
  });

  it("answers nothing when no run is waiting: none sent, a trace already came, or the wait timed out", () => {
    expect(runFailedAnswers(null, "first-auto", fileNameOf)).toBe(false);
    expect(runFailedAnswers(null, undefined, fileNameOf)).toBe(false);
  });

  it("answers nothing when it names another auto than the one waiting", () => {
    expect(runFailedAnswers("first-auto", "collect-and-score", fileNameOf)).toBe(false);
  });
});

const view = (patch: Partial<HostView>): HostView => ({
  id: "dsim",
  name: "DSIM",
  phase: "open",
  closedBy: null,
  failure: null,
  label: null,
  readOnlyRobot: true,
  simulate: true,
  running: null,
  outdated: null,
  ...patch,
});

afterEach(() => {
  setHost(null);
});

describe("hostRunBlockedReason", () => {
  it("gives the out-of-date sentence while the host is too old for this Zenith", () => {
    setHost(view({ outdated: "DSIM needs an update before it can read autos from this Zenith." }));
    expect(hostRunBlockedReason()).toBe("DSIM needs an update before it can read autos from this Zenith.");
  });

  it("does not blame the host's build when it is new enough", () => {
    setHost(view({}));
    expect(hostRunBlockedReason()).not.toMatch(/needs an update/);
  });
});
