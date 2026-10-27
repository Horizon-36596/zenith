/**
 * The Optimize card's preview on the field (UI_GUIDE 9.11, issue #308): the proposed route is a second
 * scene that nothing can press, and hovering it shows one robot outline at the nearest point, never a
 * row of stamped ghosts.
 */
import { loadRobot, mirrorVec, plan, resolve, loadField, type MirrorMode, type Pose } from "@horizon36596/zenith-core";
import { parseAuto } from "@horizon36596/zenith-schema";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CANDIDATE_HOVER_PX, candidateOutlinePoses, candidateHoverPose } from "./candidate";
import { buildScene, type SceneStep } from "./scene";
import { orientationFor, worldToScreen, type View } from "./view";

const examples = fileURLToPath(new URL("../../../../examples/starter/autos/", import.meta.url));
const read = (relative: string): unknown => JSON.parse(readFileSync(`${examples}${relative}`, "utf8"));
const robot = loadRobot(read("robot.json"));
const field = loadField(read("field/biobuzz.field.json"));

const auto = parseAuto({
  formatVersion: 1,
  name: "candidate",
  alliance: "RED",
  start: { pose: { xIn: -60, yIn: -60, headingRad: 0 } },
  steps: [{ id: "across", kind: "path", segments: [{ kind: "line", from: "current", to: { xIn: 0, yIn: -60 } }], heading: { mode: "tangent" } }],
});
const step = buildScene({ plan: plan(resolve(auto, { formatVersion: 1, waypoints: {} }), robot, field), findings: [], estimate: null }).steps[0];
const view: View = { pxPerIn: 2, originXPx: 300, originYPx: 300, orientation: orientationFor("bottom") };

describe("hovering the proposed route", () => {
  it("gives the pose at the nearest point within the hover distance, and nothing farther off", () => {
    if (step === undefined) throw new Error("no scene step");
    const on = worldToScreen(view, { xIn: -30, yIn: -60 });
    const pose = candidateHoverPose(step, { xPx: on.xPx, yPx: on.yPx + CANDIDATE_HOVER_PX - 1 }, view, "none");
    expect(pose?.xIn).toBeCloseTo(-30, 0);
    expect(pose?.yIn).toBeCloseTo(-60, 6);
    expect(candidateHoverPose(step, { xPx: on.xPx, yPx: on.yPx + CANDIDATE_HOVER_PX + 2 }, view, "none")).toBeNull();
    expect(candidateHoverPose(step, null, view, "none")).toBeNull();
  });

  /** A straight route along y = -60 sampled every 2 in, each sample with its own heading. */
  const samples: Pose[] = Array.from({ length: 31 }, (_, index) => ({ xIn: -60 + 2 * index, yIn: -60, headingRad: index / 100 }));
  const sampled = { poses: samples } as unknown as SceneStep;

  it("interpolates between the two samples it falls between, with the nearer sample's heading", () => {
    // -31.5 in is a quarter of the way from the sample at -32 in (index 14) to the one at -30 in (index 15).
    const nearA = worldToScreen(view, { xIn: -31.5, yIn: -60 });
    const a = candidateHoverPose(sampled, nearA, view, "none");
    expect(a?.xIn).toBeCloseTo(-31.5, 6);
    expect(a?.yIn).toBeCloseTo(-60, 6);
    expect(a?.headingRad).toBe(0.14);
    const nearB = worldToScreen(view, { xIn: -30.5, yIn: -60 });
    const b = candidateHoverPose(sampled, nearB, view, "none");
    expect(b?.xIn).toBeCloseTo(-30.5, 6);
    expect(b?.headingRad).toBe(0.15);
  });

  for (const mirror of ["pointSymmetry", "mirrorX", "mirrorY"] as const satisfies readonly MirrorMode[]) {
    it(`hovers the route where it is drawn mirrored (${mirror}) and gives the pose in the file's own frame`, () => {
      const drawnAt = worldToScreen(view, mirrorVec({ xIn: -31.5, yIn: -60 }, mirror));
      const pose = candidateHoverPose(sampled, drawnAt, view, mirror);
      expect(pose?.xIn).toBeCloseTo(-31.5, 6);
      expect(pose?.yIn).toBeCloseTo(-60, 6);
      expect(pose?.headingRad).toBe(0.14);
      // Where the route would be drawn unmirrored is nowhere near it on a mirrored view.
      expect(candidateHoverPose(sampled, worldToScreen(view, { xIn: -31.5, yIn: -60 }), view, mirror)).toBeNull();
    });
  }

  it("draws at most one robot outline for the candidate: the hovered pose, or the infeasible run's clip ghost", () => {
    if (step === undefined) throw new Error("no scene step");
    const hovered = { xIn: -30, yIn: -60, headingRad: 0 };
    expect(candidateOutlinePoses({ hoverPoseIn: hovered, ghostPoseIn: null })).toEqual([hovered]);
    expect(candidateOutlinePoses({ hoverPoseIn: null, ghostPoseIn: null })).toEqual([]);
    expect(candidateOutlinePoses({ hoverPoseIn: null, ghostPoseIn: hovered })).toEqual([hovered]);
    // An infeasible run has no route to hover, so the ghost is the one outline even if both were given.
    expect(candidateOutlinePoses({ hoverPoseIn: hovered, ghostPoseIn: { ...hovered, xIn: 0 } })).toHaveLength(1);
  });
});
