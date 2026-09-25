import { describe, expect, it } from "vitest";
import { NO_TOUR_PROGRESS } from "../state/prefs";
import {
  TOUR_OFF,
  currentStop,
  positionLabel,
  progressAfter,
  shouldAutoStart,
  tourReducer,
  type TourEvent,
  type TourState,
  type TourStops,
} from "./model";
import { CORE_STOPS, FULL_STOPS, TOUR_STOPS } from "./stops";

const STOPS: TourStops = {
  core: [
    { id: "a", anchor: "a", title: "A", body: "a", task: { label: "drag", signal: "pointDragged" } },
    { id: "b", anchor: "b", title: "B", body: "b" },
  ],
  full: [
    { id: "x", anchor: "x", title: "X", body: "x" },
    { id: "y", anchor: null, title: "Y", body: "y", task: { label: "play", signal: "playToggled" } },
  ],
};

const run = (events: TourEvent[], from: TourState = TOUR_OFF): TourState =>
  events.reduce((state, event) => tourReducer(state, event, STOPS), from);

describe("the tour state machine", () => {
  it("walks the core tour, then offers the choice", () => {
    expect(run([{ type: "startCore" }])).toEqual({ phase: "core", index: 0 });
    expect(run([{ type: "startCore" }, { type: "next" }])).toEqual({ phase: "core", index: 1 });
    expect(run([{ type: "startCore" }, { type: "next" }, { type: "next" }])).toEqual({
      phase: "choice",
      index: 0,
    });
  });

  it("goes into the full tour from the choice, and closes after its last stop", () => {
    const choice = run([{ type: "startCore" }, { type: "next" }, { type: "next" }]);
    const full = run([{ type: "chooseFull" }], choice);
    expect(full).toEqual({ phase: "full", index: 0 });
    const finished = run([{ type: "next" }, { type: "next" }], full);
    expect(finished).toEqual({ phase: "finished", index: 0 });
    expect(run([{ type: "next" }], finished)).toEqual(TOUR_OFF);
  });

  it("closes on Jump in, and Jump in means nothing outside the choice", () => {
    const choice = run([{ type: "startCore" }, { type: "next" }, { type: "next" }]);
    expect(run([{ type: "jumpIn" }], choice)).toEqual(TOUR_OFF);
    const core = run([{ type: "startCore" }]);
    expect(run([{ type: "jumpIn" }], core)).toBe(core);
  });

  it("advances a stop when its task's signal arrives, and ignores any other signal", () => {
    const core = run([{ type: "startCore" }]);
    expect(run([{ type: "signal", signal: "playToggled" }], core)).toBe(core);
    expect(run([{ type: "signal", signal: "pointDragged" }], core)).toEqual({ phase: "core", index: 1 });
    // Stop b has no task, so no signal moves it.
    const b = run([{ type: "next" }], core);
    expect(run([{ type: "signal", signal: "pointDragged" }], b)).toBe(b);
  });

  it("a task on the last full stop finishes the tour", () => {
    const last = run([{ type: "startFull" }, { type: "next" }]);
    expect(run([{ type: "signal", signal: "playToggled" }], last)).toEqual({
      phase: "finished",
      index: 0,
    });
  });

  it("goes back one stop, from the choice to the last core stop, and never below zero", () => {
    expect(run([{ type: "startCore" }, { type: "back" }])).toEqual({ phase: "core", index: 0 });
    const choice = run([{ type: "startCore" }, { type: "next" }, { type: "next" }]);
    expect(run([{ type: "back" }], choice)).toEqual({ phase: "core", index: 1 });
  });

  it("starts the full tour at a named stop, and at the first when the name is unknown", () => {
    expect(run([{ type: "startFull", at: "y" }])).toEqual({ phase: "full", index: 1 });
    expect(run([{ type: "startFull", at: "nope" }])).toEqual({ phase: "full", index: 0 });
  });

  it("exits from anywhere", () => {
    expect(run([{ type: "startFull" }, { type: "exit" }])).toEqual(TOUR_OFF);
    expect(run([{ type: "startCore" }, { type: "next" }, { type: "next" }, { type: "exit" }])).toEqual(
      TOUR_OFF,
    );
  });

  it("says which stop is showing and where it is in its tour", () => {
    const state = run([{ type: "startCore" }, { type: "next" }]);
    expect(currentStop(state, STOPS)?.id).toBe("b");
    expect(positionLabel(state, STOPS)).toBe("2 / 2");
    expect(currentStop({ phase: "choice", index: 0 }, STOPS)).toBeNull();
    expect(positionLabel({ phase: "choice", index: 0 }, STOPS)).toBeNull();
  });
});

describe("tour progress", () => {
  it("marks the tour seen as soon as it starts, so it never starts by itself again", () => {
    const started = run([{ type: "startCore" }]);
    const progress = progressAfter(NO_TOUR_PROGRESS, TOUR_OFF, started);
    expect(progress.seen).toBe(true);
    expect(shouldAutoStart(progress, true)).toBe(false);
  });

  it("records the core tour done at the choice, and the full tour done at the closing card", () => {
    const beforeChoice = run([{ type: "startCore" }, { type: "next" }]);
    const choice = run([{ type: "next" }], beforeChoice);
    const afterCore = progressAfter({ ...NO_TOUR_PROGRESS, seen: true }, beforeChoice, choice);
    expect(afterCore).toEqual({ seen: true, coreDone: true, fullDone: false });

    const lastFull = run([{ type: "startFull" }, { type: "next" }]);
    const finished = run([{ type: "next" }], lastFull);
    expect(progressAfter(afterCore, lastFull, finished).fullDone).toBe(true);
  });

  it("leaves progress alone for a transition that changed nothing", () => {
    const progress = { seen: true, coreDone: false, fullDone: false };
    const state = run([{ type: "startCore" }]);
    expect(progressAfter(progress, state, state)).toBe(progress);
  });

  it("starts by itself only on a first visit with a document open", () => {
    expect(shouldAutoStart(NO_TOUR_PROGRESS, true)).toBe(true);
    expect(shouldAutoStart(NO_TOUR_PROGRESS, false)).toBe(false);
  });
});

describe("the shipped stops", () => {
  it("has a core tour of about six stops and a full tour after it", () => {
    expect(CORE_STOPS.length).toBeGreaterThanOrEqual(5);
    expect(CORE_STOPS.length).toBeLessThanOrEqual(7);
    expect(FULL_STOPS.length).toBeGreaterThan(CORE_STOPS.length);
  });

  it("gives every stop a unique id, a title and a short body", () => {
    const ids = [...TOUR_STOPS.core, ...TOUR_STOPS.full].map((stop) => stop.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const stop of [...TOUR_STOPS.core, ...TOUR_STOPS.full]) {
      expect(stop.title.length).toBeGreaterThan(0);
      expect(stop.body.length).toBeGreaterThan(0);
      // A coach mark is a sentence or two, not a manual page.
      expect(stop.body.length).toBeLessThanOrEqual(300);
    }
  });

  it("covers the core features in the order the owner asked for", () => {
    expect(CORE_STOPS.map((stop) => stop.id)).toEqual([
      "field",
      "steps",
      "insert",
      "inspector",
      "findings",
      "run",
    ]);
  });
});
