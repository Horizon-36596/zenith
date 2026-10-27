/**
 * Issue #152 on the field: a STRUCTURE finding tints the whole stretch the robot stays in contact
 * with the obstacle, not a sliver round one point, and pointing at its row outlines the obstacle,
 * because a 2 in bar such as `frameBarWest` is a thin strip that its id alone does not find.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  boxCorners,
  check,
  estimate,
  loadField,
  loadRobot,
  mirrorVec,
  obstacleShadowIn,
  plan,
  robotHeightIn,
  resolve,
  type Finding,
  type MirrorMode,
} from "@horizon36596/zenith-core";
import { biobuzzRules } from "@horizon36596/zenith-season-biobuzz";
import { parseAuto, type BoxObstacle } from "@horizon36596/zenith-schema";
import { describe, expect, it } from "vitest";
import { clipGhosts, findingKey, ghostsToDraw, outlinedObstacle } from "./clipGhosts";
import { drawClipGhosts, type LiveLayerInput } from "./liveLayer";
import { buildScene } from "./scene";
import { fallbackTheme } from "./theme";
import { orientationFor, worldToScreen, type View } from "./view";

const examples = fileURLToPath(new URL("../../../../examples/starter/autos/", import.meta.url));
const read = (relative: string): unknown => JSON.parse(readFileSync(`${examples}${relative}`, "utf8"));
const robot = loadRobot(read("robot.json"));
const field = loadField(read("field/biobuzz.field.json"));

/**
 * North along frameBarWest's centre line, x = -23.65: in contact from t 0.15 to 0.85, 10.11 in deep.
 * The same run also drives into the hive frame's two west legs (issue #229), so the bar's finding is
 * picked by its obstacle.
 */
const alongTheBar = parseAuto({
  formatVersion: 1,
  name: "along-the-bar",
  alliance: "RED",
  start: { pose: { xIn: -23.65, yIn: -40, headingRad: Math.PI / 2 } },
  steps: [
    {
      id: "alongTheBar",
      kind: "path",
      segments: [{ kind: "line", from: "current", to: { xIn: -23.65, yIn: 40 } }],
      heading: { mode: "tangent" },
    },
  ],
});
const planned = plan(resolve(alongTheBar, { formatVersion: 1, waypoints: {} }), robot, field);
const findings = check(planned, null, robot, field, biobuzzRules);
const structure = findings.find(
  (finding) => finding.code === "STRUCTURE" && finding.geometry?.obstacleId === "frameBarWest",
) as Finding;

describe("a STRUCTURE finding on the field", () => {
  it("tints the whole stretch in contact", () => {
    expect(structure.geometry?.obstacleId).toBe("frameBarWest");
    const step = buildScene({ plan: planned, findings, estimate: null }).steps.find((each) => each.stepId === "alongTheBar");
    const tint = step?.highlights.find((highlight) => highlight.severity === "error");
    expect(tint?.t0).toBeCloseTo(0.15, 6);
    expect(tint?.t1).toBeCloseTo(0.85, 6);
  });

  it("keeps at least the band round the worst point when the contact is shorter", () => {
    const point: Finding = { ...structure, t: 0.5, geometry: { ...structure.geometry, tRange: [0.5, 0.5] } };
    const step = buildScene({ plan: planned, findings: [point], estimate: null }).steps[0];
    expect(step?.highlights[0]?.t0).toBeCloseTo(0.47, 6);
    expect(step?.highlights[0]?.t1).toBeCloseTo(0.53, 6);
  });

  it("carries the obstacle's box on its ghost, outlined only while its row is hovered", () => {
    const ghosts = clipGhosts(findings, field);
    const ghost = ghosts.find((each) => each.code === "STRUCTURE" && each.obstacle?.id === "frameBarWest");
    const bar = (field.obstacles ?? []).find((obstacle) => obstacle.kind === "box" && obstacle.id === "frameBarWest");
    expect(bar).toBeDefined();
    expect(ghost?.obstacle).toEqual({ id: "frameBarWest", cornersIn: boxCorners(bar as BoxObstacle) });
    expect(outlinedObstacle(ghostsToDraw(ghosts, true, null))).toBeNull();
    expect(outlinedObstacle(ghostsToDraw(ghosts, true, findingKey(structure)))).toBe("frameBarWest");
    // Hidden ghosts still outline the hovered one's obstacle.
    expect(outlinedObstacle(ghostsToDraw(ghosts, false, findingKey(structure)))).toBe("frameBarWest");
    // Without the field there is no box to outline, and nothing else changes.
    expect(clipGhosts(findings).find((each) => each.code === "STRUCTURE")?.obstacle).toBeUndefined();
  });

  it("outlines a hive frame leg by its shadow at the robot's height, not by a box (issue #230)", () => {
    const heightIn = robotHeightIn(robot);
    const ghosts = clipGhosts(findings, field, heightIn);
    for (const id of ["frameLegNorthWest", "frameLegSouthWest"]) {
      const leg = (field.obstacles ?? []).find((obstacle) => obstacle.id === id);
      expect(leg?.kind, id).toBe("strut");
      const ghost = ghosts.find((each) => each.code === "STRUCTURE" && each.obstacle?.id === id);
      expect(ghost?.obstacle, id).toEqual({ id, cornersIn: obstacleShadowIn(leg as NonNullable<typeof leg>, heightIn) });
      const finding = findings.find((each) => each.code === "STRUCTURE" && each.geometry?.obstacleId === id) as Finding;
      expect(outlinedObstacle(ghostsToDraw(ghosts, false, findingKey(finding)))).toBe(id);
    }
    // A box's outline is its own box at any height it blocks.
    const bar = ghosts.find((each) => each.obstacle?.id === "frameBarWest");
    const box = (field.obstacles ?? []).find((obstacle) => obstacle.id === "frameBarWest") as BoxObstacle;
    expect(bar?.obstacle?.cornersIn).toEqual(boxCorners(box));
  });

  it("draws the outline through the alliance mirror, on top of the hovered ghost", () => {
    const view: View = { pxPerIn: 2, originXPx: 300, originYPx: 300, orientation: orientationFor("bottom") };
    // Only the bar's ghost, so the counts below are one ghost's; the legs' ghosts are left out.
    const ghosts = clipGhosts([structure], field);
    const record = (hovered: string | null, mirror: MirrorMode = "none"): { moves: Array<[number, number]>; fills: number } => {
      const moves: Array<[number, number]> = [];
      let fills = 0;
      const ctx = {
        moveTo: (x: number, y: number) => moves.push([x, y]),
        lineTo: () => undefined,
        beginPath: () => undefined,
        closePath: () => undefined,
        stroke: () => undefined,
        setLineDash: () => undefined,
        fill: () => {
          fills += 1;
        },
      } as unknown as CanvasRenderingContext2D;
      const input = { view, mirror, theme: fallbackTheme(), clipGhosts: ghostsToDraw(ghosts, true, hovered) } as unknown as LiveLayerInput;
      drawClipGhosts(ctx, input);
      return { moves, fills };
    };
    // The one ghost moves from the plain pass to the hovered one, and the obstacle adds a fill.
    expect(record(findingKey(structure)).fills).toBe(record(null).fills + 1);
    for (const mirror of ["none", "pointSymmetry", "mirrorX"] as const) {
      const { moves } = record(findingKey(structure), mirror);
      const corner = worldToScreen(view, mirrorVec({ xIn: -24.76, yIn: -19.48 }, mirror));
      expect(moves[moves.length - 1], mirror).toEqual([corner.xPx, corner.yPx]);
    }
  });
});

describe("a STRAFE_FRACTION finding on the field (0.1.2 UX sweep W2-1)", () => {
  /** North for 40 in nose-first, then 40 in east still facing north: the second half is sideways. */
  const halfSideways = parseAuto({
    formatVersion: 1,
    name: "half-sideways",
    alliance: "RED",
    start: { pose: { xIn: -60, yIn: -60, headingRad: Math.PI / 2 } },
    steps: [
      {
        id: "dogleg",
        kind: "path",
        segments: [
          { kind: "line", from: "current", to: { xIn: -60, yIn: -20 } },
          { kind: "line", from: { xIn: -60, yIn: -20 }, to: { xIn: -20, yIn: -20 } },
        ],
        heading: { mode: "constant", headingRad: Math.PI / 2 },
      },
    ],
  });
  const dogleg = plan(resolve(halfSideways, { formatVersion: 1, waypoints: {} }), robot, field);
  const strafe = check(dogleg, estimate(dogleg, robot), robot, field, biobuzzRules).find((finding) => finding.code === "STRAFE_FRACTION");

  it("names the sideways stretch, not a polygon the canvas would close back to the start", () => {
    expect(strafe?.geometry?.polygonIn).toBeUndefined();
    expect(strafe?.geometry?.tRange?.[0]).toBeGreaterThan(0.45);
    expect(strafe?.geometry?.tRange?.[1]).toBe(1);
  });

  it("tints only that stretch along the path", () => {
    const step = buildScene({ plan: dogleg, findings: [strafe as Finding], estimate: null }).steps[0];
    expect(step?.highlights[0]?.t0).toBeGreaterThan(0.45);
    expect(step?.highlights[0]?.t1).toBe(1);
  });

  it("gives a stretch of one sample the band round a point, not a width of nothing", () => {
    const one: Finding = { ...(strafe as Finding), geometry: { tRange: [0.5, 0.5] } };
    const step = buildScene({ plan: dogleg, findings: [one], estimate: null }).steps[0];
    expect(step?.highlights[0]?.t0).toBeCloseTo(0.47, 6);
    expect(step?.highlights[0]?.t1).toBeCloseTo(0.53, 6);
  });

  it("tints stretches in several parts apart, not as one span", () => {
    /** Sideways east, nose-first north, sideways east again, facing north throughout. */
    const zigzag = parseAuto({
      formatVersion: 1,
      name: "zigzag",
      alliance: "RED",
      start: { pose: { xIn: -60, yIn: -60, headingRad: Math.PI / 2 } },
      steps: [
        {
          id: "zigzag",
          kind: "path",
          segments: [
            { kind: "line", from: "current", to: { xIn: -30, yIn: -60 } },
            { kind: "line", from: { xIn: -30, yIn: -60 }, to: { xIn: -30, yIn: -30 } },
            { kind: "line", from: { xIn: -30, yIn: -30 }, to: { xIn: 0, yIn: -30 } },
          ],
          heading: { mode: "constant", headingRad: Math.PI / 2 },
        },
      ],
    });
    const planned = plan(resolve(zigzag, { formatVersion: 1, waypoints: {} }), robot, field);
    const found = check(planned, estimate(planned, robot), robot, field, biobuzzRules).find((finding) => finding.code === "STRAFE_FRACTION");
    const parts = found?.geometry?.tRanges ?? [];
    expect(parts).toHaveLength(2);
    expect(found?.geometry?.tRange).toEqual([parts[0]?.[0], parts[1]?.[1]]);
    const tints = buildScene({ plan: planned, findings: [found as Finding], estimate: null }).steps[0]?.highlights ?? [];
    expect(tints).toHaveLength(2);
    // The nose-first middle third is left untinted.
    expect(tints[0]?.t1).toBeLessThan(0.4);
    expect(tints[1]?.t0).toBeGreaterThan(0.6);
  });
});
