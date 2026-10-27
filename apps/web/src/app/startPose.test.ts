/**
 * The start pose moves from the field (`FieldCanvas.tsx` drag kind "start", wired to
 * `writeStartPose` in `App.tsx`) and from the keyboard once the start mark is selected. A drag is
 * one undo entry however many frames it writes, because the canvas brackets it in
 * `onDragStart`/`onDragEnd` (`beginTransaction`/`endTransaction`). The heading is kept and the
 * provenance becomes the editor's. A start that follows a waypoint is unlinked when it moves, which
 * `waypointUnlink.test.ts` covers.
 */
import { canonicalize, EDITOR_PROVENANCE, loadAuto, type Pose } from "@horizon36596/zenith-core";
import { SCHEMA_ID, type Auto } from "@horizon36596/zenith-schema";
import { beforeEach, describe, expect, it } from "vitest";
import { headingDrag, resolveLeader } from "../canvas/pointDrag";
import { NO_KEYS, resolveModifiers } from "../canvas/modifiers";
import type { SnapContext } from "../canvas/snap";
import { movePoint, rotateHeading, writeStartPose } from "./edits";
import { beginTransaction, endTransaction, getState, openAuto, setSelection, undo } from "../state/store";
import { NUDGE_IN } from "./shortcuts";

const fixture = (start: Auto["start"]["pose"]) =>
  loadAuto({
    $schema: SCHEMA_ID.auto,
    formatVersion: 1,
    name: "start-fixture",
    title: "Start fixture",
    alliance: "RED",
    start: { pose: start },
    steps: [
      {
        id: "leg1",
        kind: "path",
        segments: [{ kind: "line", from: "current", to: { xIn: 0, yIn: 24, headingRad: 0 } }],
        heading: { mode: "tangent" },
      },
    ],
  });

const open = (start: Auto["start"]["pose"]): void => {
  const auto = fixture(start);
  openAuto("start-fixture.auto.json", auto, canonicalize("auto", auto));
};

const startPose = () => getState().auto?.start.pose;

describe("dragging the start pose", () => {
  beforeEach(() => {
    open({ xIn: 10, yIn: -20, headingRad: 1.2, provenance: "MEASURED" });
  });

  it("writes every frame to auto.start.pose and leaves one undo entry for the whole drag", () => {
    const undoBefore = getState().undo.length;
    const pressed: Pose = { xIn: 10, yIn: -20, headingRad: 1.2 };
    const context: SnapContext = {
      enabled: true,
      altHeld: false,
      pxPerIn: 4,
      waypoints: [],
      bounds: { minXIn: -72, maxXIn: 72, minYIn: -72, maxYIn: 72 },
      footprintBounds: () => null,
    };
    beginTransaction();
    for (const pointer of [{ xIn: 12.2, yIn: -19.1 }, { xIn: 20.3, yIn: -10.4 }, { xIn: 30.1, yIn: 5.2 }]) {
      // One frame of the canvas's start drag: resolveLeader from the pose at the press.
      const { pose } = resolveLeader(pressed, pointer, resolveModifiers(true, NO_KEYS), context);
      writeStartPose({ xIn: pose.xIn, yIn: pose.yIn });
    }
    endTransaction();

    expect(startPose()).toEqual({ xIn: 30, yIn: 5, headingRad: 1.2, provenance: EDITOR_PROVENANCE });
    expect(getState().undo.length).toBe(undoBefore + 1);
    undo();
    expect(startPose()).toEqual({ xIn: 10, yIn: -20, headingRad: 1.2, provenance: "MEASURED" });
  });

  it("turns the start with its heading knob as one undo entry, keeping x and y", () => {
    const undoBefore = getState().undo.length;
    const pressed: Pose = { xIn: 10, yIn: -20, headingRad: 1.2 };
    const context: SnapContext = {
      enabled: true,
      altHeld: false,
      pxPerIn: 4,
      waypoints: [],
      bounds: { minXIn: -72, maxXIn: 72, minYIn: -72, maxYIn: 72 },
      footprintBounds: () => null,
    };
    beginTransaction();
    for (const pointer of [{ xIn: 12, yIn: -10 }, { xIn: 0, yIn: -10 }, { xIn: 0, yIn: -20.2 }]) {
      // One frame of the canvas's knob drag: the bearing from the start at the press, snapped.
      const { headingRad } = headingDrag(pressed, pointer, resolveModifiers(true, NO_KEYS), context);
      writeStartPose({ headingRad });
    }
    endTransaction();

    const pose = startPose();
    expect(pose).toMatchObject({ xIn: 10, yIn: -20, provenance: EDITOR_PROVENANCE });
    // The last pointer is straight toward -x, a snapped half turn.
    expect(pose !== undefined && "headingRad" in pose && Math.abs(pose.headingRad ?? 0)).toBeCloseTo(Math.PI, 9);
    expect(getState().undo.length).toBe(undoBefore + 1);
    undo();
    expect(startPose()).toEqual({ xIn: 10, yIn: -20, headingRad: 1.2, provenance: "MEASURED" });
  });

  it("keeps a start written without a heading without one", () => {
    open({ xIn: 0, yIn: 0 });
    writeStartPose({ xIn: 5, yIn: 6 });
    expect(startPose()).toEqual({ xIn: 5, yIn: 6, provenance: EDITOR_PROVENANCE });
  });
});

describe("the keyboard on a selected start", () => {
  beforeEach(() => {
    open({ xIn: 10, yIn: -20, headingRad: 0, provenance: "MEASURED" });
    setSelection({ start: true });
  });

  it("nudges the start, not a step", () => {
    movePoint(NUDGE_IN, 0);
    expect(startPose()).toMatchObject({ xIn: 10 + NUDGE_IN, yIn: -20, headingRad: 0, provenance: EDITOR_PROVENANCE });
    const leg = getState().auto?.steps[0];
    expect(leg?.kind === "path" && leg.segments[0]?.to).toEqual({ xIn: 0, yIn: 24, headingRad: 0 });
  });

  it("turns the start's heading", () => {
    rotateHeading(1);
    const pose = startPose();
    expect(pose !== undefined && "headingRad" in pose && (pose.headingRad ?? 0) > 0).toBe(true);
    expect(pose).toMatchObject({ xIn: 10, yIn: -20 });
  });
});
