/**
 * Issue #403: a stop's task check is not part of the tour state, so `tourSignal` told the listeners
 * with the same snapshot and `useTour` drew nothing again. The check showed only when something else
 * drew the card. Each change of the check now gives a new snapshot.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalize, loadAuto } from "@horizon36596/zenith-core";
import { DEFAULT_PREFS, NO_TOUR_PROGRESS } from "../state/prefs";
import { ESSENTIAL_UNCHOSEN } from "../settings/presets";
import { clearStatus, commit, getState, openAuto, setPrefs, setStatus, undo } from "../state/store";
import { currentStop } from "./model";
import { currentTourStops } from "./stops";
import { TRY_IT_PUT_BACK, dispatchTour, getTour, isTaskDone, startCoreTour, tourSignal } from "./store";

const starter = fileURLToPath(new URL("../../../../examples/starter/autos/", import.meta.url));
const stored = new Map<string, string>();

beforeEach(() => {
  vi.useFakeTimers();
  stored.clear();
  (globalThis as { window?: unknown }).window = {
    localStorage: {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => {
        stored.set(key, value);
      },
    },
  };
  const { theme: _theme, ...rest } = DEFAULT_PREFS;
  setPrefs({ ...rest, tour: NO_TOUR_PROGRESS, preset: ESSENTIAL_UNCHOSEN });
  const auto = loadAuto(JSON.parse(readFileSync(`${starter}first-auto.auto.json`, "utf8")));
  openAuto("first-auto.auto.json", auto, canonicalize("auto", auto));
  clearStatus();
});

afterEach(() => {
  dispatchTour({ type: "exit" });
  vi.useRealTimers();
});

describe("a stop's task check", () => {
  it("gives the tour's readers a new snapshot when it shows, then moves on", () => {
    startCoreTour();
    const stop = currentStop(getTour(), currentTourStops());
    const signal = stop?.task?.signal;
    if (signal === undefined) throw new Error("The first core stop has a task.");
    const before = getTour();
    tourSignal(signal);
    expect(getTour()).not.toBe(before);
    expect(getTour()).toEqual(before);
    expect(isTaskDone(getTour())).toBe(true);
    vi.advanceTimersByTime(700);
    expect(getTour().index).toBe(before.index + 1);
    expect(isTaskDone(getTour())).toBe(false);
  });
});

describe("the tour's end on the status line (UI_GUIDE 9.15)", () => {
  it("Skip tour says how to replay it", async () => {
    setStatus("ok", "Saved your display name.");
    await Promise.resolve();
    startCoreTour();
    dispatchTour({ type: "exit" });
    expect(getState().status).toMatchObject({ kind: "info", message: "Tour skipped.", hint: "Replay it from Help, Take the tour." });
  });

  it("an exit with no tour running leaves the line alone", () => {
    setStatus("ok", "Saved.");
    dispatchTour({ type: "exit" });
    expect(getState().status?.message).toBe("Saved.");
  });
});

/** The open auto as canonical text. */
const text = (): string => {
  const auto = getState().auto;
  if (auto === null) throw new Error("no auto open");
  return canonicalize("auto", auto);
};

/** An edit as a Try it task makes one: the auto with its last step gone. */
const edit = (): void => {
  const auto = getState().auto;
  if (auto === null) throw new Error("no auto open");
  commit({ ...auto, steps: auto.steps.slice(0, -1) });
};

// UX review, S2: a Try it task is a demonstration, so what it changed goes back when its stop is left.
describe("a Try it edit", () => {
  it("is put back when its stop moves on, as one edit that Undo takes back", () => {
    const original = text();
    startCoreTour();
    expect(currentStop(getTour(), currentTourStops())?.task?.signal).toBe("pointDragged");
    edit();
    const edited = text();
    expect(edited).not.toBe(original);
    tourSignal("pointDragged");
    vi.advanceTimersByTime(700);
    expect(getTour().index).toBe(1);
    expect(text()).toBe(original);
    expect(getState().status?.message).toBe(TRY_IT_PUT_BACK);
    undo();
    expect(text()).toBe(edited);
  });

  it("is put back when the tour is skipped on that stop", () => {
    const original = text();
    startCoreTour();
    edit();
    dispatchTour({ type: "exit" });
    expect(text()).toBe(original);
  });

  it("leaves alone an edit made on a stop whose task changes nothing, and a stop left with no edit", () => {
    startCoreTour();
    dispatchTour({ type: "next" });
    expect(getState().status?.message).not.toBe(TRY_IT_PUT_BACK);
    expect(currentStop(getTour(), currentTourStops())?.task?.signal).toBe("stepSelected");
    edit();
    const edited = text();
    dispatchTour({ type: "next" });
    expect(text()).toBe(edited);
  });
});
