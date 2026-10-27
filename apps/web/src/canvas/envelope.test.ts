/**
 * Envelopes on the field (spec 13 section 10): the scene lists every step's envelope, commands
 * included, and the live layer draws each one as a hatched polygon, mirrored with the rest of the
 * routine when the file is viewed as the other alliance.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { estimate, loadField, loadRobot, plan, resolve, type MirrorMode } from "@horizon36596/zenith-core";
import { parseAuto, SCHEMA_ID } from "@horizon36596/zenith-schema";
import { describe, expect, it } from "vitest";
import { drawEnvelopes, type LiveLayerInput } from "./liveLayer.js";
import { buildScene, type Scene } from "./scene.js";
import { orientationFor, type View } from "./view.js";

const examples = fileURLToPath(new URL("../../../../examples/starter/autos/", import.meta.url));
const json = (name: string): unknown => JSON.parse(readFileSync(`${examples}${name}`, "utf8"));
const robot = loadRobot(json("robot.json"));
const field = loadField(json("field/biobuzz.field.json"));

const SQUARE = [
  { xIn: -48, yIn: -48 },
  { xIn: -24, yIn: -48 },
  { xIn: -24, yIn: -24 },
  { xIn: -48, yIn: -24 },
];

const auto = parseAuto({
  $schema: SCHEMA_ID.auto,
  formatVersion: 3,
  name: "canvas-envelope",
  alliance: "RED",
  start: { pose: { xIn: -36, yIn: -36, headingRad: 0 } },
  steps: [
    { id: "spin", kind: "command", name: "spinUp", envelope: { polygon: SQUARE, maxDurationS: 3, provenance: "SET BY HAND" } },
    {
      id: "go",
      kind: "path",
      segments: [{ kind: "line", from: "current", to: { xIn: -36, yIn: 0 } }],
      heading: { mode: "tangent" },
    },
  ],
});

function sceneOf(): Scene {
  const planned = plan(resolve(auto, undefined, robot), robot, field);
  return buildScene({ plan: planned, findings: [], estimate: estimate(planned, robot) });
}

/** Records the path a painter traces, in screen pixels, and how it strokes and fills it. */
function recorder() {
  const calls: string[] = [];
  const points: Array<{ xPx: number; yPx: number }> = [];
  const dashes: number[][] = [];
  const ctx = {
    globalAlpha: 1,
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    save: () => calls.push("save"),
    restore: () => calls.push("restore"),
    beginPath: () => calls.push("beginPath"),
    closePath: () => calls.push("closePath"),
    moveTo: (xPx: number, yPx: number) => {
      calls.push("moveTo");
      points.push({ xPx, yPx });
    },
    lineTo: (xPx: number, yPx: number) => {
      calls.push("lineTo");
      points.push({ xPx, yPx });
    },
    fill: () => calls.push("fill"),
    clip: () => calls.push("clip"),
    stroke: () => calls.push("stroke"),
    setLineDash: (dash: number[]) => dashes.push(dash),
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls, points, dashes };
}

const view: View = { pxPerIn: 1, originXPx: 0, originYPx: 0, orientation: orientationFor("bottom") };

const input = (scene: Scene, mirror: MirrorMode, stepId?: string): LiveLayerInput =>
  ({
    scene,
    view,
    mirror,
    selection: stepId === undefined ? {} : { stepId },
    theme: { canvasAnnotation: "#71c9fa", canvasUnknown: "#9695ff" },
  }) as unknown as LiveLayerInput;

describe("envelopes on the canvas", () => {
  it("lists a command's envelope in the scene, though a command draws no path", () => {
    const scene = sceneOf();
    expect(scene.envelopes).toEqual([{ stepId: "spin", polygonIn: SQUARE, maxDurationS: 3 }]);
    expect(scene.steps.map((step) => step.stepId)).toEqual(["go"]);
  });

  it("fills, hatches inside a clip and outlines each envelope, dashed until its step is selected", () => {
    const scene = sceneOf();
    const idle = recorder();
    drawEnvelopes(idle.ctx, input(scene, "none"));
    expect(idle.calls).toContain("fill");
    expect(idle.calls).toContain("clip");
    expect(idle.calls.filter((call) => call === "stroke")).toHaveLength(2);
    // The first four points are the polygon's own corners, (x, -y) on this view.
    expect(idle.points.slice(0, 4)).toEqual(SQUARE.map((corner) => ({ xPx: corner.xIn, yPx: -corner.yIn })));
    expect(idle.dashes[0]).toEqual([4, 3]);

    const selected = recorder();
    drawEnvelopes(selected.ctx, input(scene, "none", "spin"));
    expect(selected.dashes[0]).toEqual([]);
  });

  it("mirrors the corners with the routine when viewed as the other alliance", () => {
    const flipped = recorder();
    drawEnvelopes(flipped.ctx, input(sceneOf(), "pointSymmetry"));
    expect(flipped.points.slice(0, 4)).toEqual(SQUARE.map((corner) => ({ xPx: -corner.xIn, yPx: corner.yIn })));
  });

  it("draws the envelope of a step whose position is a guess in the unknown colour, the partner way (issue #481)", () => {
    const styles: string[] = [];
    const ghost = recorder();
    const ctx = ghost.ctx as unknown as { strokeStyle: string; stroke: () => void };
    const stroke = ctx.stroke;
    ctx.stroke = () => {
      styles.push(ctx.strokeStyle);
      stroke();
    };
    drawEnvelopes(ghost.ctx, { ...input(sceneOf(), "none"), unknownEnvelopeStepId: "spin" });
    expect(styles).toEqual(["#9695ff", "#9695ff"]);
    expect(ghost.dashes[0]).toEqual([4, 3]);

    const plain: string[] = [];
    const idle = recorder();
    const idleCtx = idle.ctx as unknown as { strokeStyle: string; stroke: () => void };
    const idleStroke = idleCtx.stroke;
    idleCtx.stroke = () => {
      plain.push(idleCtx.strokeStyle);
      idleStroke();
    };
    drawEnvelopes(idle.ctx, { ...input(sceneOf(), "none"), unknownEnvelopeStepId: "other" });
    expect(plain).toEqual(["#71c9fa", "#71c9fa"]);
  });

  it("draws nothing for a routine without envelopes", () => {
    const empty = recorder();
    drawEnvelopes(empty.ctx, input({ ...sceneOf(), envelopes: [] }, "none"));
    expect(empty.calls).toEqual([]);
  });
});
