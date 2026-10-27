/**
 * The heading of a new path is a per-person setting (owner ruling D6): Tangent, Linear or Constant,
 * Linear until chosen. `edits.ts` builds it from `editing.defaultHeading` and hands it to
 * `newPathStep`; core never reads a preference. The leg that has no room ahead holds its heading as
 * Linear from it to itself, and as Constant only for a person whose setting is Constant (issue #445).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { canonicalize, loadAuto, loadField, loadRobot, wrapAngle } from "@horizon36596/zenith-core";
import type { Auto, Heading, PathStep } from "@horizon36596/zenith-schema";
import { SCHEMA_ID } from "@horizon36596/zenith-schema";
import { beforeEach, describe, expect, it } from "vitest";
import type { DefaultHeadingMode } from "../state/prefs";
import { DEFAULT_PREFS } from "../state/prefs";
import { getState, openAuto, selectStep, setAutoOverrides, setPrefs, setSetting } from "../state/store";
import { ADD_POINT_MIN_IN } from "../canvas/pointDrag";
import { canvasActions } from "./canvasMenu";
import { indexSteps } from "../lib/stepOps";
import { actionById } from "./actions";
import { addParallelStep, addPathStep, addPathStepTo, addSequenceStep, addTurnStep, appendPathToChain, duplicateSelection } from "./edits";

const examples = fileURLToPath(new URL("../../../../examples/starter/autos/", import.meta.url));
const read = (relative: string): unknown => JSON.parse(readFileSync(`${examples}${relative}`, "utf8"));

/** A leg from the origin to (24, 24), so the robot ends it facing a quarter of a turn from where it started. */
const diagonal = (): Auto =>
  loadAuto({
    $schema: SCHEMA_ID.auto,
    formatVersion: 1,
    name: "default-heading-fixture",
    title: "Default heading fixture",
    alliance: "RED",
    start: { pose: { xIn: 0, yIn: 0, headingRad: 0 } },
    steps: [
      {
        id: "leg",
        kind: "path",
        segments: [{ kind: "line", from: "current", to: { xIn: 24, yIn: 24, headingRad: 0 } }],
        heading: { mode: "tangent" },
      },
    ],
  });

/** The heading the robot has where `leg` ends, read from the plan the way a person sees it. */
const ARRIVAL_RAD = Math.PI / 4;

const open = (auto: Auto = diagonal()): void => {
  openAuto("default-heading-fixture.auto.json", auto, canonicalize("auto", auto));
  setAutoOverrides(loadRobot(read("robot.json")), loadField(read("field/biobuzz.field.json")));
};

const pathNamed = (id: string | null): PathStep => {
  const step = getState().auto?.steps.find((candidate) => candidate.id === id);
  if (step?.kind !== "path") throw new Error(`expected a path step ${String(id)}`);
  return step;
};

const headingOf = (id: string | null): Heading | undefined => pathNamed(id).heading;

const choose = (mode: DefaultHeadingMode): void => {
  setSetting("editing.defaultHeading", mode);
};

beforeEach(() => {
  // Everything but the theme, which would reach for the document.
  const { theme: _theme, ...rest } = DEFAULT_PREFS;
  setPrefs(rest);
  open();
  selectStep("leg");
});

describe("a path added with Insert or the palette", () => {
  it("is Linear until the person chooses, from the heading the robot arrives with to the same heading", () => {
    const heading = headingOf(addPathStep());
    expect(heading?.mode).toBe("linear");
    if (heading?.mode !== "linear") throw new Error("expected linear");
    expect(heading.fromRad).toBeCloseTo(ARRIVAL_RAD, 9);
    expect(heading.toRad).toBeCloseTo(ARRIVAL_RAD, 9);
  });

  it("is Tangent when the setting is Tangent", () => {
    choose("tangent");
    expect(headingOf(addPathStep())).toEqual({ mode: "tangent" });
  });

  it("is Constant at the arrival heading when the setting is Constant", () => {
    choose("constant");
    const heading = headingOf(addPathStep());
    expect(heading?.mode).toBe("constant");
    if (heading?.mode !== "constant") throw new Error("expected constant");
    expect(heading.headingRad).toBeCloseTo(ARRIVAL_RAD, 9);
  });

  it("starts a Linear path at the end heading of the step before it, wherever that step sits", () => {
    const auto = loadAuto({
      ...(JSON.parse(canonicalize("auto", diagonal())) as object),
      steps: [
        {
          id: "leg",
          kind: "path",
          segments: [{ kind: "line", from: "current", to: { xIn: 24, yIn: 24, headingRad: 0 } }],
          heading: { mode: "constant", headingRad: 2 },
        },
      ],
    });
    open(auto);
    selectStep("leg");
    const heading = headingOf(addPathStep());
    if (heading?.mode !== "linear") throw new Error("expected linear");
    expect(heading.fromRad).toBeCloseTo(2, 9);
  });

  it("reads the setting each time, so the next path follows a change", () => {
    choose("tangent");
    const first = addPathStep();
    choose("constant");
    const second = addPathStep();
    expect(headingOf(first)?.mode).toBe("tangent");
    expect(headingOf(second)?.mode).toBe("constant");
  });
});

describe("the leg with no room ahead", () => {
  const facingTheWall = (): Auto =>
    loadAuto({
      $schema: SCHEMA_ID.auto,
      formatVersion: 1,
      name: "default-heading-fixture",
      title: "Default heading fixture",
      alliance: "RED",
      start: { pose: { xIn: 0, yIn: 0, headingRad: 0 } },
      steps: [
        {
          id: "leg",
          kind: "path",
          segments: [{ kind: "line", from: "current", to: { xIn: 58, yIn: 0, headingRad: 0 } }],
          heading: { mode: "tangent" },
        },
      ],
    });

  /** The held heading the no-room leg gets: Linear from the anchor's heading to itself, here 0. */
  const HELD = { mode: "linear", fromRad: 0, toRad: 0 } as const;

  /** Asserts that `id` is the no-room leg: it turns back toward the centre from the wall it faces. */
  const expectTurnedBack = (step: PathStep | undefined): void => {
    const to = step?.segments[0]?.to;
    if (to === undefined || to === "current" || "ref" in to) throw new Error("expected an inline end");
    expect(to.xIn).toBeLessThan(58);
  };

  /** Every path step the auto has now that it did not have before `run`, in list order. */
  const pathsAddedBy = (run: () => void): PathStep[] => {
    const before = new Set(indexSteps(getState().auto as Auto).map((entry) => entry.id));
    run();
    return indexSteps(getState().auto as Auto)
      .filter((entry) => !before.has(entry.id) && entry.step.kind === "path")
      .map((entry) => entry.step as PathStep);
  };

  beforeEach(() => {
    open(facingTheWall());
    selectStep("leg");
  });

  // Issue #445: the leg held its heading as Constant whatever the setting said, so a person on the
  // defaults who inserted a path beside a wall got a Constant heading they never asked for.
  it("holds the anchor's heading as Linear from it to itself with the default settings", () => {
    const id = addPathStep();
    expect(headingOf(id)).toEqual(HELD);
    expectTurnedBack(pathNamed(id));
  });

  for (const mode of ["tangent", "linear"] as const) {
    it(`is Linear from the anchor's heading to itself with the setting at ${mode}, since Tangent would turn the robot beside the wall`, () => {
      choose(mode);
      const id = addPathStep();
      expect(headingOf(id)).toEqual(HELD);
      expectTurnedBack(pathNamed(id));
    });
  }

  it("is Linear from the anchor's heading to itself with Start a new path with the previous path's end heading off", () => {
    setSetting("editing.newPathKeepsHeading", false);
    const id = addPathStep();
    expect(headingOf(id)).toEqual(HELD);
    expectTurnedBack(pathNamed(id));
  });

  it("is Constant at the anchor's heading only when the person's setting is Constant", () => {
    choose("constant");
    const id = addPathStep();
    expect(headingOf(id)).toEqual({ mode: "constant", headingRad: 0 });
    expectTurnedBack(pathNamed(id));
  });

  it("is Linear from the anchor's heading to itself from the palette's Insert a path", () => {
    const [added] = pathsAddedBy(() => {
      const action = actionById("insert.path");
      if (action === undefined) throw new Error("the palette has no Insert a path");
      action.run();
    });
    expect(added?.heading).toEqual(HELD);
    expectTurnedBack(added);
  });

  it("is Linear from the anchor's heading to itself for the first path of a new sequence", () => {
    const [added] = pathsAddedBy(() => {
      expect(addSequenceStep()).not.toBeNull();
    });
    expect(added?.heading).toEqual(HELD);
    expectTurnedBack(added);
  });

  // The palette's parallel and race groups, and the Insert menu's deadline group, which asks which
  // member ends it and then calls `addParallelStep` with that choice.
  for (const insert of ["insert.parallel", "insert.race"] as const) {
    it(`is Linear from the anchor's heading to itself for the drive of a new group from ${insert}`, () => {
      const [added] = pathsAddedBy(() => {
        const action = actionById(insert);
        if (action === undefined) throw new Error(`the palette has no ${insert}`);
        action.run();
      });
      expect(added?.heading).toEqual(HELD);
      expectTurnedBack(added);
    });
  }

  for (const deadline of ["drive", "command"] as const) {
    it(`is Linear from the anchor's heading to itself for the drive of a new deadline group ended by the ${deadline}`, () => {
      const [added] = pathsAddedBy(() => {
        expect(addParallelStep("deadline", deadline)).not.toBeNull();
      });
      expect(added?.heading).toEqual(HELD);
      expectTurnedBack(added);
    });
  }

  it("is Constant for a new sequence or group's first path only when the setting is Constant", () => {
    choose("constant");
    const [sequenced] = pathsAddedBy(() => {
      addSequenceStep();
    });
    expect(sequenced?.heading).toEqual({ mode: "constant", headingRad: 0 });
    selectStep("leg");
    const [driven] = pathsAddedBy(() => {
      addParallelStep("all");
    });
    expect(driven?.heading).toEqual({ mode: "constant", headingRad: 0 });
  });

  it("gives a click on the field and Add a path here a Linear heading too when the anchor faces the wall", () => {
    const clicked = pathsAddedBy(() => {
      addPathStepTo({ xIn: 24, yIn: 24, headingRad: 1.5 });
    })[0];
    expect(clicked?.heading).toEqual(HELD);
    selectStep("leg");
    const here = pathsAddedBy(() => {
      const item = canvasActions({ kind: "field", atIn: { xIn: 24, yIn: 24 } }).find((candidate) => candidate.id === "field.addPathHere");
      if (item === undefined) throw new Error("the menu has no Add a path to here");
      item.run();
    })[0];
    expect(here?.heading).toEqual(HELD);
  });

  it("stays Linear when Extend this chain adds a path to it, with no Constant range", () => {
    const id = addPathStep();
    setSetting("editing.addPathExtends", true);
    expect(addPathStepTo({ xIn: 24, yIn: 24, headingRad: 1.5 })).toBe(id);
    expect(appendPathToChain(id as string)).toBe(true);
    // A held Linear heading stays one plain heading as the chain grows (W2-17 of the 0.1.2 sweep);
    // were it ever split into ranges, every one would still be the same Linear, never Constant.
    const heading = headingOf(id);
    if (heading?.mode === "piecewise") {
      expect(heading.ranges.length).toBeGreaterThanOrEqual(2);
      for (const range of heading.ranges) expect(range.heading).toEqual(HELD);
    } else {
      expect(heading).toEqual(HELD);
    }
  });

  it("stays Linear when Duplicate copies it", () => {
    const id = addPathStep();
    selectStep(id as string);
    const [copy] = pathsAddedBy(duplicateSelection);
    expect(copy?.heading).toEqual(HELD);
  });
});

describe("a path added by a click on the field", () => {
  const CLICK = { xIn: 24, yIn: 72, headingRad: 1.5 };

  // The preview's own heading, which Start a new path with the previous path's end heading replaces below.
  beforeEach(() => {
    setSetting("editing.newPathKeepsHeading", false);
  });

  it("is Tangent when the setting is Tangent", () => {
    choose("tangent");
    expect(headingOf(addPathStepTo(CLICK))).toEqual({ mode: "tangent" });
  });

  it("turns Linear from the arrival heading to the heading the click's preview shows", () => {
    const heading = headingOf(addPathStepTo(CLICK));
    if (heading?.mode !== "linear") throw new Error("expected linear");
    expect(heading.fromRad).toBeCloseTo(ARRIVAL_RAD, 9);
    expect(heading.toRad).toBeCloseTo(ARRIVAL_RAD + wrapAngle(CLICK.headingRad - ARRIVAL_RAD), 9);
  });

  it("goes the short way round when the click's heading is more than half a turn away", () => {
    const heading = headingOf(addPathStepTo({ xIn: 24, yIn: 72, headingRad: ARRIVAL_RAD - 3.5 }));
    if (heading?.mode !== "linear") throw new Error("expected linear");
    expect(Math.abs(heading.toRad - heading.fromRad)).toBeLessThanOrEqual(Math.PI + 1e-9);
  });

  it("holds the arrival heading when the setting is Constant", () => {
    choose("constant");
    const heading = headingOf(addPathStepTo(CLICK));
    if (heading?.mode !== "constant") throw new Error("expected constant");
    expect(heading.headingRad).toBeCloseTo(ARRIVAL_RAD, 9);
  });

  it("still writes no heading into the new end, since the heading mode decides it", () => {
    choose("linear");
    const id = addPathStepTo(CLICK);
    const auto = getState().auto;
    if (auto === null) throw new Error("no document");
    const written = JSON.parse(canonicalize("auto", auto)) as { steps: Array<{ id: string; segments?: Array<{ to: unknown }> }> };
    expect(written.steps.find((step) => step.id === id)?.segments?.[0]?.to).toEqual({
      xIn: 24,
      yIn: 72,
      provenance: "SET FROM EDITOR",
    });
  });
});

describe("the field menu's Add a path to here on a spot the preview draws nothing for", () => {
  beforeEach(() => {
    setSetting("editing.newPathKeepsHeading", false);
  });

  /** Runs the menu item for a right-click at `atIn` that no Add path click would place a point at. */
  const addHere = (atIn: { xIn: number; yIn: number }): string | null => {
    const item = canvasActions({ kind: "field", atIn }).find((candidate) => candidate.id === "field.addPathHere");
    if (item === undefined) throw new Error("the menu has no Add a path to here");
    const before = new Set(getState().auto?.steps.map((step) => step.id));
    item.run();
    return getState().auto?.steps.find((step) => !before.has(step.id))?.id ?? null;
  };

  it("keeps the arrival heading within the click's minimum distance of the anchor, rather than turning to a bearing nothing drew", () => {
    // 0.3 in to the left of the end of "leg", whose bearing from it is half a turn from the arrival heading.
    const heading = headingOf(addHere({ xIn: 24 - 0.3, yIn: 24 }));
    if (heading?.mode !== "linear") throw new Error("expected linear");
    expect(heading.fromRad).toBeCloseTo(ARRIVAL_RAD, 9);
    expect(heading.toRad).toBeCloseTo(ARRIVAL_RAD, 9);
  });

  it("keeps the arrival heading on the anchor itself, where there is no bearing at all", () => {
    const heading = headingOf(addHere({ xIn: 24, yIn: 24 }));
    if (heading?.mode !== "linear") throw new Error("expected linear");
    expect(heading.toRad).toBeCloseTo(ARRIVAL_RAD, 9);
  });

  it("still faces the way it drives once the spot is far enough from the anchor", () => {
    const heading = headingOf(addHere({ xIn: 24, yIn: 24 + ADD_POINT_MIN_IN + 5 }));
    if (heading?.mode !== "linear") throw new Error("expected linear");
    expect(heading.toRad).toBeCloseTo(ARRIVAL_RAD + wrapAngle(Math.PI / 2 - ARRIVAL_RAD), 9);
  });
});

describe("what the setting does not change", () => {
  it("leaves a turn on the spot Linear whatever the setting says", () => {
    choose("tangent");
    const heading = headingOf(addTurnStep());
    expect(heading?.mode).toBe("linear");
  });
});

/**
 * Start a new path with the previous path's end heading (issue #435, `editing.newPathKeepsHeading`),
 * on until the person turns it off: every entry point that makes a path starts it at the heading the
 * robot has where the step before ends, and a Linear one ends there too.
 */
describe("Start a new path with the previous path's end heading", () => {
  const CLICK = { xIn: 24, yIn: 72, headingRad: 1.5 };

  /** The Linear heading a path has, with its From and To. */
  const linearOf = (id: string | null): { fromRad: number; toRad: number } => {
    const heading = headingOf(id);
    if (heading?.mode !== "linear") throw new Error(`expected linear, got ${String(heading?.mode)}`);
    return heading;
  };

  it("is on by default", () => {
    expect(getState().prefs.newPathKeepsHeading).toBe(true);
  });

  it("keeps the arrival heading for a path added by a click, whatever heading the click's preview gave", () => {
    const heading = linearOf(addPathStepTo(CLICK));
    expect(heading.fromRad).toBeCloseTo(ARRIVAL_RAD, 9);
    expect(heading.toRad).toBeCloseTo(ARRIVAL_RAD, 9);
  });

  it("keeps it for Add a path here, in the field menu", () => {
    const item = canvasActions({ kind: "field", atIn: { xIn: 24, yIn: 96 } }).find((candidate) => candidate.id === "field.addPathHere");
    if (item === undefined) throw new Error("the menu has no Add a path to here");
    const before = new Set(getState().auto?.steps.map((step) => step.id));
    item.run();
    const id = getState().auto?.steps.find((step) => !before.has(step.id))?.id ?? null;
    const heading = linearOf(id);
    expect(heading.fromRad).toBeCloseTo(ARRIVAL_RAD, 9);
    expect(heading.toRad).toBeCloseTo(ARRIVAL_RAD, 9);
  });

  it("keeps it for Insert and the palette's Add path", () => {
    const heading = linearOf(addPathStep());
    expect(heading.fromRad).toBeCloseTo(ARRIVAL_RAD, 9);
    expect(heading.toRad).toBeCloseTo(ARRIVAL_RAD, 9);
  });

  it("holds the arrival heading in Constant mode, and leaves Tangent as it was", () => {
    choose("constant");
    const held = headingOf(addPathStepTo(CLICK));
    if (held?.mode !== "constant") throw new Error("expected constant");
    expect(held.headingRad).toBeCloseTo(ARRIVAL_RAD, 9);
    choose("tangent");
    expect(headingOf(addPathStepTo(CLICK))).toEqual({ mode: "tangent" });
  });

  it("goes back to the click's heading when it is turned off", () => {
    setSetting("editing.newPathKeepsHeading", false);
    const heading = linearOf(addPathStepTo(CLICK));
    expect(heading.toRad).toBeCloseTo(ARRIVAL_RAD + wrapAngle(CLICK.headingRad - ARRIVAL_RAD), 9);
  });

  describe("Extend this chain", () => {
    /** One path turning from 0 to 1 rad over 24 in, so the chain turns and its end heading is 1. */
    const turning = (): Auto =>
      loadAuto({
        ...(JSON.parse(canonicalize("auto", diagonal())) as object),
        steps: [
          {
            id: "leg",
            kind: "path",
            segments: [{ kind: "line", from: "current", to: { xIn: 24, yIn: 0, headingRad: 0 } }],
            heading: { mode: "linear", fromRad: 0, toRad: 1 },
          },
        ],
      });

    beforeEach(() => {
      open(turning());
      selectStep("leg");
      setSetting("editing.addPathExtends", true);
    });

    const chainHeading = (): Heading | undefined => headingOf("leg");

    const expectHeld = (): void => {
      const heading = chainHeading();
      if (heading?.mode !== "piecewise") throw new Error("expected the turn to be kept to the old part of the chain");
      expect(heading.ranges).toHaveLength(2);
      const [turn, hold] = heading.ranges;
      expect(turn?.heading).toEqual({ mode: "linear", fromRad: 0, toRad: 1 });
      expect(hold?.heading).toEqual({ mode: "linear", fromRad: 1, toRad: 1 });
      expect(turn?.endT).toBeCloseTo(hold?.startT ?? NaN, 9);
      expect(turn?.endT).toBeGreaterThan(0);
      expect(hold?.endT).toBe(1);
    };

    it("keeps the chain's end heading through a path added by a click", () => {
      expect(addPathStepTo({ xIn: 24, yIn: 24, headingRad: 1.5 })).toBe("leg");
      expect(pathNamed("leg").segments).toHaveLength(2);
      expectHeld();
    });

    it("keeps it through Insert and the inspector's Add path to chain", () => {
      expect(addPathStep()).toBe("leg");
      expectHeld();
      open(turning());
      selectStep("leg");
      expect(appendPathToChain("leg")).toBe(true);
      expectHeld();
    });

    it("stretches the turn over the whole chain, as before, when it is off", () => {
      setSetting("editing.newPathKeepsHeading", false);
      addPathStepTo({ xIn: 24, yIn: 24, headingRad: 1.5 });
      expect(chainHeading()).toEqual({ mode: "linear", fromRad: 0, toRad: 1 });
    });

    it("leaves Constant and Tangent chains as they are", () => {
      for (const heading of [{ mode: "constant", headingRad: 1 }, { mode: "tangent" }] as const) {
        const base = turning();
        const step = base.steps[0];
        if (step?.kind !== "path") throw new Error("expected a path");
        open({ ...base, steps: [{ ...step, heading }] });
        selectStep("leg");
        addPathStepTo({ xIn: 24, yIn: 24, headingRad: 1.5 });
        expect(chainHeading()).toEqual(heading);
      }
    });
  });
});
