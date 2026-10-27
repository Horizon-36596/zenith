import { describe, expect, it } from "vitest";
import { NO_TOUR_PROGRESS } from "../state/prefs";
import {
  TOUR_OFF,
  currentStop,
  isFirstRunAddress,
  positionLabel,
  progressAfter,
  shouldAutoStart,
  shouldOfferPreset,
  tourReducer,
  withinStops,
  type TourEvent,
  type TourState,
  type TourStops,
} from "./model";
import { ALL_FEATURES, NO_FEATURES, type Feature, type FeatureSwitches } from "../state/features";
import { ESSENTIAL_UNCHOSEN, presetSettings } from "../settings/presets";
import { SETTINGS } from "../settings/registry";
import { CORE_STOPS, FULL_STOPS, SIMULATE_IN_BROWSER, TOUR_STOPS, browserStops, stopsShown, tourStopsFor } from "./stops";

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

  it("says what Save does in the example, where the tour runs (sweep items A21 and D11)", () => {
    const run = CORE_STOPS.find((stop) => stop.id === "run");
    expect(run?.body).toContain("the example is read only, so there Save asks whether to save the full project or just the auto");
  });

  // The 0.1.2 UX sweep (W1-4): a browser cannot run the robot's sim, so there Simulate loads its trace.
  it("says in a browser that Simulate loads the trace the robot repository's sim records", () => {
    const simulate = (stops: typeof TOUR_STOPS) => stops.full.find((stop) => stop.id === "run.simulate")?.body;
    expect(simulate(tourStopsFor(null))).toContain("Runs the high-fidelity sim");
    expect(simulate(browserStops(tourStopsFor(null)))).toBe(SIMULATE_IN_BROWSER);
    expect(SIMULATE_IN_BROWSER).toContain("trace recorded by the high-fidelity sim in your robot repository");
    // The tests run as a browser, with no desktop bridge.
    expect(simulate(TOUR_STOPS)).toBe(SIMULATE_IN_BROWSER);
  });

  it("covers the core features in the order the owner asked for", () => {
    expect(CORE_STOPS.map((stop) => stop.id)).toEqual([
      "field",
      "steps",
      "insert",
      "inspector",
      // Issue #217: the owner asked for waypoints to be explained the first time someone meets them.
      "waypoints",
      "findings",
      "run",
    ]);
  });
});

describe("where a first visit starts the tour", () => {
  it("is the editor's own page, however its address is written", () => {
    expect(isFirstRunAddress("/", "", "", "/")).toBe(true);
    expect(isFirstRunAddress("/zenith/app/", "", "", "/zenith/app/")).toBe(true);
    expect(isFirstRunAddress("/zenith/app", "", "", "/zenith/app/")).toBe(true);
    expect(isFirstRunAddress("/zenith/app/index.html", "", "", "/zenith/app/")).toBe(true);
  });

  it("ignores a query that does not open anything, such as a link's tracking parameters", () => {
    expect(isFirstRunAddress("/", "?utm_source=discord", "", "/")).toBe(true);
    expect(isFirstRunAddress("/", "?ref=readme", "", "/")).toBe(true);
  });

  it("is not host mode, a review link or another page", () => {
    // Host mode starts the tour itself, once the host's project has opened.
    expect(isFirstRunAddress("/", "?host=dsim", "", "/")).toBe(false);
    expect(isFirstRunAddress("/", "?review=fixture", "", "/")).toBe(false);
    expect(isFirstRunAddress("/", "", "#/review/owner/repo/3", "/")).toBe(false);
    expect(isFirstRunAddress("/other", "", "", "/")).toBe(false);
  });

  it("never starts again for someone who has seen it, however they left it", () => {
    expect(shouldAutoStart({ seen: true, coreDone: false, fullDone: false }, true)).toBe(false);
  });
});

describe("when the first visit asks for a preset", () => {
  it("does so only on a true first run: nothing seen, nothing chosen, the example open", () => {
    expect(shouldOfferPreset(NO_TOUR_PROGRESS, ESSENTIAL_UNCHOSEN, true)).toBe(true);
  });

  it("waits for the example, so the card never sits over an empty field", () => {
    expect(shouldOfferPreset(NO_TOUR_PROGRESS, ESSENTIAL_UNCHOSEN, false)).toBe(false);
  });

  it("never asks someone who has seen the tour, however they left it", () => {
    expect(shouldOfferPreset({ seen: true, coreDone: false, fullDone: false }, ESSENTIAL_UNCHOSEN, true)).toBe(false);
  });

  it("never asks someone who already chose a preset, in Settings or on the card", () => {
    expect(shouldOfferPreset(NO_TOUR_PROGRESS, { id: "basic", chosen: true }, true)).toBe(false);
    expect(shouldOfferPreset(NO_TOUR_PROGRESS, { id: "user:abc", chosen: true, basedOn: "full" }, true)).toBe(false);
  });
});

describe("the stops in host mode", () => {
  const host = tourStopsFor("DSIM");

  it("talk about the host's auto and Save to the host, not the example or a repository", () => {
    const field = host.core.find((stop) => stop.id === "field");
    const run = host.core.find((stop) => stop.id === "run");
    expect(field?.body).toContain("DSIM");
    expect(field?.body).not.toMatch(/example/);
    expect(run?.body).toContain("Save to DSIM");
    expect(run?.body).not.toMatch(/repository/);
    // Save to the host is on the host bar, so the stop's spotlight is there too.
    expect(run?.anchor).toBe("host.save");
    expect(CORE_STOPS.find((stop) => stop.id === "run")?.anchor).toBe("run");
  });

  it("keep the same core stops in the same order, and drop Propose from the full tour", () => {
    expect(host.core.map((stop) => stop.id)).toEqual(CORE_STOPS.map((stop) => stop.id));
    expect(host.full.some((stop) => stop.id === "run.propose")).toBe(false);
    expect(tourStopsFor(null).full.some((stop) => stop.id === "run.propose")).toBe(true);
  });
});

describe("the stops the settings hide", () => {
  const ids = (stops: TourStops): string[] => [...stops.core, ...stops.full].map((stop) => stop.id);
  const body = (stops: TourStops, id: string): string => [...stops.core, ...stops.full].find((stop) => stop.id === id)?.body ?? "";
  const every = ids(TOUR_STOPS);
  const switchOf = (entry: (typeof SETTINGS)[number]): Feature => entry.storage.slice("features.".length) as Feature;

  it("drops every stop each switch gates while that switch is off, and no other stop", () => {
    const switches = SETTINGS.filter((entry) => entry.kind === "feature");
    expect(switches.map(switchOf).sort()).toEqual(Object.keys(ALL_FEATURES).sort());
    for (const entry of switches) {
      const gated: readonly string[] = entry.gates?.tourStops ?? [];
      const shown = ids(stopsShown(TOUR_STOPS, { ...ALL_FEATURES, [switchOf(entry)]: false }));
      expect(shown, `${entry.id} off`).toEqual(every.filter((id) => !gated.includes(id)));
    }
    expect(ids(stopsShown(TOUR_STOPS, ALL_FEATURES))).toEqual(every);
  });

  it("gives Basic a tour without the group or ledger stops", () => {
    const basic = presetSettings("basic");
    const features = Object.fromEntries(
      (Object.keys(ALL_FEATURES) as Feature[]).map((feature) => [feature, basic[`features.${feature}`] === true]),
    ) as unknown as FeatureSwitches;
    const shown = ids(stopsShown(TOUR_STOPS, features));
    for (const id of ["groups", "ledger"]) expect(shown).not.toContain(id);
    // Basic keeps Commands on.
    expect(shown).toContain("tool.marker");
    expect(shown).toContain("timeline");
  });

  it("does not mention groups, waypoints, piecewise headings or finding codes while they are off", () => {
    const off = stopsShown(TOUR_STOPS, { ...ALL_FEATURES, groups: false, waypoints: false, advancedHeading: false }, { findingCodes: false });
    expect(body(off, "steps")).toBe("The robot runs these top to bottom. A step drives a path, runs a command, or waits.");
    expect(body(off, "inspector")).not.toMatch(/waypoint/);
    expect(body(off, "section.heading")).not.toMatch(/Piecewise/);
    expect(body(off, "tool.heading")).not.toMatch(/split/i);
    expect(body(TOUR_STOPS, "tool.heading")).toMatch(/Right-click a path for Split heading here./);
    expect(body(off, "findings.fixes")).not.toMatch(/code/);
    // The example has no problems, so the stop speaks of a row the list may have (0.1.2 UX sweep, W1-7).
    expect(body(off, "findings.fixes")).toMatch(/^When the Problems list has a row, click it/);
    expect(body(TOUR_STOPS, "findings.fixes")).toMatch(/^When the Problems list has a row, hover its code/);
    const pathsOnly = stopsShown(TOUR_STOPS, NO_FEATURES);
    expect(body(pathsOnly, "steps")).toBe("The robot runs these top to bottom. A step drives a path or waits.");
    const on = stopsShown(TOUR_STOPS, ALL_FEATURES, { findingCodes: true });
    for (const id of ["steps", "inspector", "section.heading", "tool.heading", "findings.fixes"]) {
      expect(body(on, id), id).toBe(body(TOUR_STOPS, id));
    }
  });

  it("writes every key into its stop's text, leaving no {key:...} marker behind", () => {
    const shown = stopsShown(TOUR_STOPS, ALL_FEATURES);
    for (const stop of [...shown.core, ...shown.full]) {
      expect(stop.body, stop.id).not.toContain("{key:");
      expect(stop.task?.label ?? "", stop.id).not.toContain("{key:");
    }
    expect(shown.full.find((stop) => stop.id === "tool.select")?.body).toContain("V switches back to it");
  });

  it("drops the stop on a toolbar button the person took off the toolbar", () => {
    const shown = ids(stopsShown(TOUR_STOPS, ALL_FEATURES, { buttonShown: (id) => id !== "tool.measure" && id !== "view.alliance" }));
    expect(shown).toEqual(every.filter((id) => id !== "tool.measure" && id !== "view.alliance"));
  });

  it("drops the Play and save stop once every button of the run group is off the toolbar", () => {
    const run = ["run.validate", "view.play", "run.simulate", "run.save", "run.propose"];
    const none = ids(stopsShown(TOUR_STOPS, ALL_FEATURES, { buttonShown: (id) => !run.includes(id) }));
    expect(none).not.toContain("run");
    const one = ids(stopsShown(TOUR_STOPS, ALL_FEATURES, { buttonShown: (id) => id === "view.play" || !run.includes(id) }));
    expect(one).toContain("run");
  });
});

describe("a tour whose stop Settings hides (issue #403)", () => {
  const fewer: TourStops = { core: STOPS.core, full: STOPS.full.slice(0, 1) };

  it("moves back onto the last stop it still has, instead of showing nothing", () => {
    const past: TourState = { phase: "full", index: 1 };
    expect(currentStop(past, fewer)).toBeNull();
    const synced = tourReducer(past, { type: "sync" }, fewer);
    expect(synced).toEqual({ phase: "full", index: 0 });
    expect(currentStop(synced, fewer)?.id).toBe("x");
  });

  it("goes on to the next card when the phase has no stops left", () => {
    expect(withinStops({ phase: "full", index: 0 }, { core: STOPS.core, full: [] })).toEqual({ phase: "finished", index: 0 });
    expect(withinStops({ phase: "core", index: 0 }, { core: [], full: STOPS.full })).toEqual({ phase: "choice", index: 0 });
  });

  it("walks on from where it is held to", () => {
    expect(tourReducer({ phase: "full", index: 1 }, { type: "next" }, fewer)).toEqual({ phase: "finished", index: 0 });
    expect(tourReducer({ phase: "core", index: 5 }, { type: "back" }, STOPS)).toEqual({ phase: "core", index: 0 });
  });

  it("leaves a state that is on a stop it has as it is", () => {
    const on: TourState = { phase: "full", index: 0 };
    expect(withinStops(on, fewer)).toBe(on);
    expect(tourReducer(on, { type: "sync" }, fewer)).toBe(on);
  });
});
