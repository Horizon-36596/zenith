/**
 * The first visit's preset card: it shows once the example is open, on a true first run only; a choice
 * applies the preset and starts the core tour; Esc and Skip are Essential; and replaying the tour never
 * brings it back.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canonicalize, loadAuto } from "@horizon36596/zenith-core";
import type { Auto } from "@horizon36596/zenith-schema";
import { DEFAULT_PREFS, NO_TOUR_PROGRESS } from "../state/prefs";
import { ESSENTIAL_UNCHOSEN } from "../settings/presets";
import { getState, openAuto, setPrefs } from "../state/store";
import { TOUR_OFF } from "./model";
import { currentTourStops } from "./stops";
import { choosePresetOnFirstRun, importPresetOnFirstRun, startFirstRun } from "./firstRun";
import { closePresetCard, dispatchTour, getPresetCardOpen, getTour, startFullTour } from "./store";

const starter = fileURLToPath(new URL("../../../../examples/starter/autos/", import.meta.url));
const first = (): Auto => loadAuto(JSON.parse(readFileSync(`${starter}first-auto.auto.json`, "utf8")));

const stored = new Map<string, string>();

beforeEach(() => {
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
  dispatchTour({ type: "exit" });
  closePresetCard();
  const auto = first();
  openAuto("first-auto.auto.json", auto, canonicalize("auto", auto));
});
afterEach(() => {
  dispatchTour({ type: "exit" });
  delete (globalThis as { window?: unknown }).window;
});

describe("the first run", () => {
  it("asks for a preset before the tour, and starts nothing yet", () => {
    startFirstRun();
    expect(getPresetCardOpen()).toBe(true);
    expect(getTour()).toEqual(TOUR_OFF);
    expect(getState().prefs.tour.seen).toBe(false);
  });

  it("asks again after a reload that came before any choice", () => {
    startFirstRun();
    startFirstRun();
    expect(getPresetCardOpen()).toBe(true);
  });

  it("shows no card and does not start the tour again for someone who has seen it", () => {
    setPrefs({ tour: { seen: true, coreDone: true, fullDone: false } });
    startFirstRun();
    expect(getPresetCardOpen()).toBe(false);
    expect(getTour()).toEqual(TOUR_OFF);
  });

  it("starts the core tour with no card when a preset was already chosen in Settings", () => {
    setPrefs({ preset: { id: "full", chosen: true } });
    startFirstRun();
    expect(getPresetCardOpen()).toBe(false);
    expect(getTour().phase).toBe("core");
  });

});

describe("choosing a preset on the card", () => {
  it("applies it, records it as chosen, closes the card and starts the core tour", () => {
    startFirstRun();
    choosePresetOnFirstRun("basic");
    expect(getPresetCardOpen()).toBe(false);
    expect(getState().prefs.preset).toEqual({ id: "basic", chosen: true });
    expect(getState().prefs.features.groups).toBe(false);
    expect(getState().prefs.features.ledger).toBe(false);
    expect(getTour()).toEqual({ phase: "core", index: 0 });
    expect(getState().prefs.tour.seen).toBe(true);
  });

  it("gives Basic a tour with no group, waypoint or optimizer stop, in the core tour or the full one", () => {
    startFirstRun();
    choosePresetOnFirstRun("basic");
    const stops = currentTourStops();
    const ids = [...stops.core, ...stops.full].map((stop) => stop.id);
    for (const id of ["groups", "ledger"]) expect(ids).not.toContain(id);
    expect(ids.join(" ")).not.toMatch(/optimi|waypoint/);
    // Snap still names waypoints as a place points stop; the Inspector stop must not offer the list.
    expect(stops.core.find((stop) => stop.id === "inspector")?.body).not.toMatch(/waypoint/i);
  });

  it("keeps every stop for Full, so the full tour has one for each switch", () => {
    startFirstRun();
    choosePresetOnFirstRun("full");
    const ids = currentTourStops().full.map((stop) => stop.id);
    expect(ids).toEqual(expect.arrayContaining(["groups", "ledger"]));
  });

  it("applies Essential, which Esc and Skip choose too, and records it as chosen", () => {
    startFirstRun();
    choosePresetOnFirstRun("essential");
    expect(getState().prefs.preset).toEqual({ id: "essential", chosen: true });
    expect(getTour().phase).toBe("core");
  });
});

describe("importing a preset file on the card", () => {
  const file = JSON.stringify({
    kind: "zenith-preset",
    presetVersion: 1,
    name: "Drive team",
    description: "",
    basedOn: "essential",
    settings: { "features.ledger": true },
  });

  it("adds the preset, applies it as the person's choice and starts the core tour", () => {
    startFirstRun();
    const result = importPresetOnFirstRun(file);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(getPresetCardOpen()).toBe(false);
    expect(getState().prefs.preset.chosen).toBe(true);
    expect(getState().prefs.preset.id.startsWith("user:")).toBe(true);
    expect(getState().prefs.features.ledger).toBe(true);
    expect(getTour().phase).toBe("core");
  });

  it("applies nothing when a choice closed the card while the file was still being read", () => {
    startFirstRun();
    choosePresetOnFirstRun("full");
    dispatchTour({ type: "next" });
    const tour = getTour();
    const result = importPresetOnFirstRun(file);
    expect(result.ok).toBe(false);
    expect(getState().prefs.preset).toEqual({ id: "full", chosen: true });
    expect(getState().prefs.features.groups).toBe(true);
    // The tour goes on where it was, rather than starting again.
    expect(getTour()).toEqual(tour);
  });

  it("says why when the file is not a preset, and leaves the card open", () => {
    startFirstRun();
    const result = importPresetOnFirstRun("not json");
    expect(result.ok).toBe(false);
    expect(getPresetCardOpen()).toBe(true);
    expect(getState().prefs.preset.chosen).toBe(false);
    expect(getTour()).toEqual(TOUR_OFF);
  });
});

describe("replaying the tour", () => {
  it("never brings the card back", () => {
    startFirstRun();
    choosePresetOnFirstRun("basic");
    dispatchTour({ type: "exit" });
    startFirstRun();
    expect(getPresetCardOpen()).toBe(false);
  });

  it("closes a card that is still open, because the tour has begun", () => {
    startFirstRun();
    startFullTour();
    expect(getPresetCardOpen()).toBe(false);
    expect(getTour().phase).toBe("full");
  });
});
