/**
 * Issue #145: a scrub across a number field (`NumberField` in `fields.tsx`) is one undo step, starts
 * from the edge of its dead zone so the value does not jump, puts the start back on Esc, moves an
 * angle one degree per pixel, writes only values the field can show, and never completes the tour's
 * "drag one of the dots" stop, which asks for a drag on the field. Before, every pointer move was an
 * undo step of its own, an angle moved five degrees per pixel, and nothing told the tour the scrub
 * was not a drag on the field. In review, a pixel was a quarter step written unrounded, so an 8 px
 * drag left 5.25 pieces under a Holds at start that showed 5.
 */
import { canonicalize, loadAuto } from "@horizon36596/zenith-core";
import { SCHEMA_ID, type PathStep } from "@horizon36596/zenith-schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeSpeed, writeTimeout } from "../app/edits";
import { beginTransaction, endTransaction, getState, openAuto, undo } from "../state/store";
import { currentStop } from "../tour/model";
import { currentTourStops } from "../tour/stops";
import { dispatchTour, getTour, isTaskDone, startCoreTour } from "../tour/store";
import { SCRUB_DEAD_ZONE_PX, SCRUB_PX_PER_STEP, scrubPxPerStepFor, startScrub, type ScrubSpec } from "./numberScrub";

const fixture = () =>
  loadAuto({
    $schema: SCHEMA_ID.auto,
    formatVersion: 1,
    name: "scrub-fixture",
    title: "Scrub fixture",
    alliance: "RED",
    start: { pose: { xIn: 0, yIn: 0, headingRad: 0 } },
    steps: [
      {
        id: "leg1",
        kind: "path",
        segments: [{ kind: "line", from: "current", to: { xIn: 0, yIn: 24, headingRad: 0 } }],
        heading: { mode: "tangent" },
        speedFraction: 0.3,
      },
    ],
  });

beforeEach(() => {
  openAuto("scrub-fixture.auto.json", fixture(), canonicalize("auto", fixture()));
});

const leg = (): PathStep => {
  const step = getState().auto?.steps.find((candidate) => candidate.id === "leg1");
  if (step?.kind !== "path") throw new Error("leg1 is not a path");
  return step;
};

/** The inspector's Speed fraction field (`SpeedFractionField.tsx`), pressed at x = 100. */
const speedScrub = (overrides: Partial<ScrubSpec> = {}) =>
  startScrub({
    x: 100,
    from: 0.3,
    fromEmpty: false,
    step: 0.05,
    pxPerStep: SCRUB_PX_PER_STEP,
    digits: 2,
    range: { min: 0.01, max: 1 },
    nullable: true,
    write: (value) => {
      writeSpeed("leg1", value);
    },
    ...overrides,
  });

/** Every pointer position from `from` to `to`, one pixel apart, as a real drag sends them. */
const frames = (scrub: ReturnType<typeof startScrub>, from: number, to: number): void => {
  const step = to >= from ? 1 : -1;
  for (let x = from; x !== to + step; x += step) scrub.move(x);
};

describe("a number field's scrub", () => {
  it("does nothing inside its dead zone, so a press that stays there is a click", () => {
    const written: Array<number | null> = [];
    const scrub = speedScrub({ write: (value) => written.push(value) });
    expect(scrub.move(100 + SCRUB_DEAD_ZONE_PX - 1)).toBe(false);
    expect(scrub.move(100 - SCRUB_DEAD_ZONE_PX + 1)).toBe(false);
    expect(scrub.started).toBe(false);
    expect(scrub.finish()).toBe(false);
    expect(written).toEqual([]);
    expect(getState().undo).toHaveLength(0);
  });

  it("starts at the edge of the dead zone, so the value does not jump, then moves one step per 4 px", () => {
    expect(SCRUB_DEAD_ZONE_PX).toBe(3);
    expect(SCRUB_PX_PER_STEP).toBe(4);
    const scrub = speedScrub();
    // The move that leaves the dead zone starts the scrub and writes nothing yet.
    expect(scrub.move(103)).toBe(true);
    expect(scrub.started).toBe(true);
    expect(leg().speedFraction).toBe(0.3);
    // 20 px past the edge is five steps of 0.05.
    scrub.move(123);
    expect(leg().speedFraction).toBeCloseTo(0.55, 9);
    expect(scrub.finish()).toBe(true);
  });

  it("measures a scrub to the left from the left edge of the dead zone", () => {
    const scrub = speedScrub();
    scrub.move(97);
    expect(leg().speedFraction).toBe(0.3);
    scrub.move(77);
    expect(leg().speedFraction).toBeCloseTo(0.05, 9);
    scrub.finish();
  });

  it("is one undo step however many frames it takes, and one undo puts the start back", () => {
    const scrub = speedScrub();
    frames(scrub, 101, 123);
    expect(scrub.finish()).toBe(true);
    expect(leg().speedFraction).toBeCloseTo(0.55, 9);
    expect(getState().undo).toHaveLength(1);
    undo();
    expect(leg().speedFraction).toBe(0.3);
    expect(getState().undo).toHaveLength(0);
  });

  it("moves four times as far with Shift and a quarter as far with Alt", () => {
    const scrub = speedScrub();
    scrub.move(103);
    scrub.move(107, 4);
    expect(leg().speedFraction).toBeCloseTo(0.5, 9);
    scrub.move(119, 0.25);
    expect(leg().speedFraction).toBeCloseTo(0.35, 9);
    scrub.finish();
  });

  it("puts the start back on Esc and leaves no undo step", () => {
    const scrub = speedScrub();
    frames(scrub, 101, 140);
    expect(leg().speedFraction).not.toBe(0.3);
    scrub.cancel();
    expect(leg().speedFraction).toBe(0.3);
    expect(getState().undo).toHaveLength(0);
    // The pointer still moving or coming up afterwards changes nothing.
    scrub.move(160);
    expect(scrub.finish()).toBe(true);
    expect(leg().speedFraction).toBe(0.3);
    expect(getState().undo).toHaveLength(0);
  });

  it("empties a field again on Esc when the scrub began on it empty", () => {
    writeSpeed("leg1", null);
    const before = getState().undo.length;
    const scrub = speedScrub({ from: 0.8, fromEmpty: true });
    frames(scrub, 101, 123);
    expect(leg().speedFraction).toBe(1);
    scrub.cancel();
    expect(leg().speedFraction).toBeUndefined();
    expect(getState().undo).toHaveLength(before);
  });

  it("empties a Timeout that began empty once, when the scrub comes back below its floor", () => {
    const written: Array<number | null> = [];
    const scrub = speedScrub({
      from: 0,
      fromEmpty: true,
      step: 0.1,
      range: { min: 0.01 },
      write: (value) => {
        written.push(value);
        writeTimeout("leg1", value);
      },
    });
    scrub.move(103);
    scrub.move(111);
    expect(leg().timeoutS).toBeCloseTo(0.2, 9);
    scrub.move(92);
    scrub.move(90);
    expect(leg().timeoutS).toBeUndefined();
    expect(written).toHaveLength(2);
    expect(written[1]).toBeNull();
    scrub.finish();
  });
});

describe("what a scrub writes", () => {
  /** The Auto details dialog's Holds at start (`MetaDialog` in Dialogs.tsx), pressed at x = 100. */
  const holdsScrub = (written: Array<number | null>) =>
    startScrub({
      x: 100,
      from: 4,
      fromEmpty: false,
      step: 1,
      pxPerStep: scrubPxPerStepFor(undefined, 1),
      digits: 0,
      range: { min: 0 },
      nullable: false,
      write: (value) => {
        written.push(value);
      },
    });

  it("is a whole count on a step-1 field with no decimals, as Holds at start shows it", () => {
    const written: Array<number | null> = [];
    const scrub = holdsScrub(written);
    // The review's 8 px drag: 5 px past the edge of the dead zone is a step and a quarter.
    scrub.move(103);
    scrub.move(108);
    expect(written).toEqual([5]);
    scrub.finish();
  });

  it("writes only whole counts however the pointer moves, Alt and Shift included", () => {
    const written: Array<number | null> = [];
    const scrub = holdsScrub(written);
    frames(scrub, 101, 117);
    for (let x = 118; x <= 125; x += 1) scrub.move(x, 0.25);
    for (let x = 126; x <= 129; x += 1) scrub.move(x, 4);
    frames(scrub, 128, 60);
    scrub.finish();
    expect(written.length).toBeGreaterThan(5);
    for (const value of written) expect(Number.isInteger(value)).toBe(true);
    // A long drag to the left stops at the floor.
    expect(written.at(-1)).toBe(0);
  });

  it("writes a 1 px Speed scrub as the two decimals the field shows, and the file keeps them", () => {
    const scrub = speedScrub();
    scrub.move(103);
    scrub.move(104);
    // A quarter step from 0.30 is 0.3125, which the field shows as 0.31.
    expect(leg().speedFraction).toBe(0.31);
    // The review's 8 px drag stored 0.3625 under a field that showed 0.36.
    scrub.move(108);
    expect(leg().speedFraction).toBe(0.36);
    scrub.finish();
    const auto = getState().auto;
    if (auto === null) throw new Error("no auto is open");
    const saved = JSON.parse(canonicalize("auto", auto)) as { steps: Array<{ speedFraction?: number }> };
    expect(saved.steps[0]?.speedFraction).toBe(0.36);
  });

  it("writes every frame of a Speed scrub as a value the field shows", () => {
    const written: number[] = [];
    const scrub = speedScrub({
      write: (value) => {
        if (value !== null) written.push(value);
      },
    });
    frames(scrub, 101, 140);
    for (let x = 141; x <= 150; x += 1) scrub.move(x, 0.25);
    scrub.finish();
    expect(written.length).toBeGreaterThan(10);
    for (const value of written) expect(value).toBe(Number(value.toFixed(2)));
  });

  it("still turns an angle a whole degree per pixel, and a quarter degree with Alt, to its one decimal", () => {
    const written: number[] = [];
    const scrub = startScrub({
      x: 100,
      from: 90,
      fromEmpty: false,
      step: 5,
      pxPerStep: scrubPxPerStepFor("°", 5),
      digits: 1,
      range: {},
      nullable: false,
      write: (value) => {
        if (value !== null) written.push(value);
      },
    });
    scrub.move(103);
    scrub.move(104);
    expect(written.at(-1)).toBe(91);
    // Two pixels at a quarter degree is 0.5°, which one decimal shows.
    scrub.move(105, 0.25);
    expect(written.at(-1)).toBe(90.5);
    scrub.finish();
  });

  it("leaves a value with more decimals than the field shows as it was until the pointer moves on", () => {
    // A heading of 3.1416 rad in the file, which the field shows as 180.0°.
    const from = (3.1416 * 180) / Math.PI;
    const written: number[] = [];
    const scrub = startScrub({
      x: 100,
      from,
      fromEmpty: false,
      step: 5,
      pxPerStep: scrubPxPerStepFor("°", 5),
      digits: 1,
      range: {},
      nullable: false,
      write: (value) => {
        if (value !== null) written.push(value);
      },
    });
    // Leaving the dead zone does not rewrite it as 180°, which would be π in the file.
    scrub.move(103);
    expect(written).toEqual([]);
    scrub.move(104);
    expect(written).toEqual([181]);
    // Back where the scrub started, it is the value from the press again, not 180.
    scrub.move(103);
    expect(written).toEqual([181, from]);
    scrub.finish();
  });
});

describe("how many pixels make one step", () => {
  it("is 4 px for a field that does not set it, and the field's own number when it does", () => {
    expect(scrubPxPerStepFor("in", 0.5)).toBe(4);
    expect(scrubPxPerStepFor(undefined, 0.05)).toBe(4);
    expect(scrubPxPerStepFor("in", 0.5, 2)).toBe(2);
    expect(scrubPxPerStepFor("°", 5, 2)).toBe(2);
  });

  it("moves an angle one degree per pixel, whatever its arrow-key step", () => {
    expect(scrubPxPerStepFor("°", 5)).toBe(5);
    expect(scrubPxPerStepFor("°", 1)).toBe(1);
    const written: number[] = [];
    const scrub = startScrub({
      x: 100,
      from: 90,
      fromEmpty: false,
      step: 5,
      pxPerStep: scrubPxPerStepFor("°", 5),
      digits: 1,
      range: {},
      nullable: false,
      write: (value) => {
        if (value !== null) written.push(value);
      },
    });
    scrub.move(103);
    scrub.move(123);
    scrub.finish();
    expect(written.at(-1)).toBeCloseTo(110, 9);
  });
});

describe("the tour", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    startCoreTour();
  });

  afterEach(() => {
    dispatchTour({ type: "exit" });
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it("does not count an Inspector scrub as the drag its first stop asks for", () => {
    expect(currentStop(getTour(), currentTourStops())?.task?.signal).toBe("pointDragged");
    const scrub = speedScrub();
    frames(scrub, 101, 123);
    scrub.finish();
    expect(getState().undo).toHaveLength(1);
    expect(isTaskDone(getTour())).toBe(false);
    vi.runOnlyPendingTimers();
    expect(currentStop(getTour(), currentTourStops())?.id).toBe("field");

    // A drag on the field, which brackets its edits the same way, still completes it.
    beginTransaction();
    writeSpeed("leg1", 0.9);
    endTransaction();
    expect(isTaskDone(getTour())).toBe(true);
  });
});
