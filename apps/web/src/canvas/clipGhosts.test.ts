/**
 * Clip ghosts (`clipGhosts.ts`): the robot drawn in red where a path clips, at the worst pose the
 * check found. A path that looks fine at both ends and clips in the middle has its ghost in the
 * middle; the ghosts follow the alliance mirror like everything else on the field; hiding them
 * leaves only the hovered one; the choice is remembered per browser; and clicking the finding moves
 * the playhead onto the ghost.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  check,
  estimate,
  idealPoseAt,
  idealTrajectory,
  loadAuto,
  loadField,
  loadRobot,
  loadWaypoints,
  mirrorVec,
  obstacleShadowIn,
  plan,
  resolve,
  robotHeightIn,
  type Finding,
  type MirrorMode,
} from "@horizon36596/zenith-core";
import { parseAuto } from "@horizon36596/zenith-schema";
import { resolveSeason } from "@horizon36596/zenith-seasons";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { actionById } from "../app/actions";
import { DEFAULT_PREFS, loadPrefs } from "../state/prefs";
import { findingTimeS } from "../state/playback";
import { getState, initPrefs, toggleClipGhosts } from "../state/store";
import { clipGhosts, findingKey, ghostsToDraw, MAX_CLIP_GHOSTS, type ClipGhost } from "./clipGhosts";
import { drawClipGhosts, type LiveLayerInput } from "./liveLayer";
import { fallbackTheme } from "./theme";
import { orientationFor, worldToScreen, type View } from "./view";

const examples = fileURLToPath(new URL("../../../../examples/starter/autos/", import.meta.url));
const read = (relative: string): unknown => JSON.parse(readFileSync(`${examples}${relative}`, "utf8"));
const robot = loadRobot(read("robot.json"));
const field = loadField(read("field/biobuzz.field.json"));

/**
 * Starts and ends well inside the field, but runs out to x = 66 and back: the robot's nose leaves
 * the field in the middle of the leg only.
 */
const outAndBack = parseAuto({
  formatVersion: 1,
  name: "out-and-back",
  alliance: "RED",
  start: { pose: { xIn: 30, yIn: 30, headingRad: 0 } },
  steps: [
    {
      id: "leg1",
      kind: "path",
      segments: [
        { kind: "line", from: "current", to: { xIn: 66, yIn: 30 } },
        { kind: "line", from: { xIn: 66, yIn: 30 }, to: { xIn: 30, yIn: 30 } },
      ],
      heading: { mode: "constant", headingRad: 0 },
    },
  ],
});

const planned = plan(resolve(outAndBack, { formatVersion: 1, waypoints: {} }), robot, field);
const estimated = estimate(planned, robot);
const findings = check(planned, estimated, robot, field);

describe("clipGhosts", () => {
  it("puts the PERIMETER ghost at the far end of the leg, not at the start", () => {
    const perimeter = findings.find((finding) => finding.code === "PERIMETER");
    expect(perimeter?.stepId).toBe("leg1");
    const ghosts = clipGhosts(findings);
    const ghost = ghosts.find((candidate) => candidate.code === "PERIMETER");
    expect(ghost).toBeDefined();
    expect(ghost?.severity).toBe("error");
    expect(ghost?.poseIn.xIn).toBeCloseTo(66, 0);
    expect(ghost?.polygonsIn.length).toBe(1 + (robot.mouths ?? []).length);
    // The offending polygon is one that really is outside the field.
    const worst = ghost?.polygonsIn[ghost.worstIndex] ?? [];
    expect(Math.max(...worst.map((corner) => corner.xIn))).toBeGreaterThan(72);
  });

  it("skips findings that are not about the footprint, or carry no pose", () => {
    const bare: Finding[] = [
      { severity: "error", stepId: "a", code: "PERIMETER", message: "old shape, no pose" },
      { severity: "warning", stepId: "a", code: "STRAFE_FRACTION", message: "x", geometry: { polygonIn: [{ xIn: 0, yIn: 0 }] } },
    ];
    expect(clipGhosts(bare)).toEqual([]);
  });

  it("keys a finding by what it is, so a recheck keeps the hover", () => {
    const again = check(planned, estimated, robot, field);
    expect(clipGhosts(again).map((ghost) => ghost.key)).toEqual(clipGhosts(findings).map((ghost) => ghost.key));
  });
});

/**
 * Issue #230 on the starter project, and issue #365: collect-and-score once went under the RED hive
 * between the hive frame's legs, with its scoring spot on x = -9 and its under-hive controls on
 * x = -5. There an 18 in robot clears the west legs but goes over the centre line, which the canvas
 * draws as an OPPONENT_SIDE ghost; moved back to the old x = -12, it drives into both west legs, and
 * the canvas draws a red ghost there that outlines the leg's band at the robot's height. The starter
 * now goes round the west side of the frame and draws neither.
 */
describe("clipGhosts on a route under the hive", () => {
  const season = resolveSeason(field).rules;
  const ghostsOf = (auto: ReturnType<typeof loadAuto>, waypoints: Parameters<typeof resolve>[1]): ClipGhost[] => {
    const planned = plan(resolve(auto, waypoints), robot, field);
    return clipGhosts(check(planned, null, robot, field, season), field, robotHeightIn(robot));
  };
  /** The old toOtherSide alone, from the scoring spot south of the hive on `spotXIn`, under the hive on `controlXIn`. */
  const underHive = (spotXIn: number, controlXIn: number): ClipGhost[] =>
    ghostsOf(
      parseAuto({
        formatVersion: 4,
        name: "under-the-hive",
        alliance: "RED",
        start: { pose: { xIn: spotXIn, yIn: -36, headingRad: Math.PI / 2 } },
        steps: [
          {
            id: "toOtherSide",
            kind: "path",
            segments: [
              {
                kind: "bezier",
                from: "current",
                control: [
                  { xIn: controlXIn, yIn: 10 },
                  { xIn: controlXIn, yIn: 40 },
                  { xIn: -24, yIn: 34 },
                ],
                to: { xIn: -24, yIn: 46 },
              },
            ],
            heading: { mode: "tangent" },
          },
        ],
      }),
      { formatVersion: 1, waypoints: {} },
    );

  it("draws no footprint ghost on the starter's collect-and-score as it is", () => {
    const starter = fileURLToPath(new URL("../../../../examples/starter/autos/", import.meta.url));
    const readStarter = (relative: string): unknown => JSON.parse(readFileSync(`${starter}${relative}`, "utf8"));
    expect(ghostsOf(loadAuto(readStarter("collect-and-score.auto.json")), loadWaypoints(readStarter("waypoints.json")))).toEqual([]);
  });

  it("draws an OPPONENT_SIDE ghost, and no STRUCTURE one, on the old route east of the legs", () => {
    const ghosts = underHive(-9, -5);
    expect(ghosts.filter((ghost) => ghost.code === "STRUCTURE")).toEqual([]);
    const over = ghosts.find((ghost) => ghost.code === "OPPONENT_SIDE");
    expect(over?.severity).toBe("error");
    expect(over?.stepId).toBe("toOtherSide");
    // The offending polygon is one that really is past the line, x = 0.
    const worst = over?.polygonsIn[over.worstIndex] ?? [];
    expect(Math.max(...worst.map((corner) => corner.xIn))).toBeGreaterThan(0.05);
  });

  it("draws a red ghost at each west leg when the route is moved back to x = -12", () => {
    const ghosts = underHive(-12, -12).filter((ghost) => ghost.code === "STRUCTURE" && ghost.stepId === "toOtherSide");
    for (const id of ["frameLegNorthWest", "frameLegSouthWest"]) {
      const ghost = ghosts.find((each) => each.obstacle?.id === id);
      expect(ghost, id).toBeDefined();
      expect(ghost?.severity).toBe("error");
      // About on the old line (the curve under the hive bows a little), beside the leg.
      expect(Math.abs((ghost?.poseIn.xIn ?? NaN) + 12)).toBeLessThan(2);
      expect(Math.abs(ghost?.poseIn.yIn ?? NaN)).toBeLessThan(20);
      const leg = (field.obstacles ?? []).find((obstacle) => obstacle.id === id);
      expect(ghost?.obstacle?.cornersIn).toEqual(obstacleShadowIn(leg as NonNullable<typeof leg>, robotHeightIn(robot)));
    }
  });
});

const ghostAt = (key: string): ClipGhost => ({
  key,
  code: "STRUCTURE",
  severity: "error",
  stepId: "leg",
  poseIn: { xIn: 10, yIn: 5, headingRad: 0 },
  polygonsIn: [
    [
      { xIn: 19, yIn: 12 },
      { xIn: 1, yIn: 12 },
      { xIn: 1, yIn: -2 },
      { xIn: 19, yIn: -2 },
    ],
  ],
  worstIndex: 0,
});

describe("ghostsToDraw", () => {
  const ghosts = [ghostAt("a"), ghostAt("b"), ghostAt("c")];

  it("draws every ghost while they are shown, and marks the hovered one", () => {
    expect(ghostsToDraw(ghosts, true, "b").map((entry) => [entry.ghost.key, entry.hovered])).toEqual([
      ["a", false],
      ["b", true],
      ["c", false],
    ]);
  });

  it("draws only the hovered ghost while they are hidden", () => {
    expect(ghostsToDraw(ghosts, false, null)).toEqual([]);
    expect(ghostsToDraw(ghosts, false, "c").map((entry) => entry.ghost.key)).toEqual(["c"]);
  });

  it("draws only the selected finding's ghosts while its step is selected (issue #412)", () => {
    const mixed = [ghostAt("a"), { ...ghostAt("b"), stepId: "other" }, ghostAt("c")];
    expect(ghostsToDraw(mixed, true, null, "other").map((entry) => entry.ghost.key)).toEqual(["b"]);
    // The hovered row's ghost still draws; a selected step with no ghost of its own leaves them all.
    expect(ghostsToDraw(mixed, true, "a", "other").map((entry) => entry.ghost.key)).toEqual(["a", "b"]);
    expect(ghostsToDraw(mixed, true, null, "nothing").map((entry) => entry.ghost.key)).toEqual(["a", "b", "c"]);
  });

  it("caps how many it draws, but never drops the hovered one", () => {
    const many = Array.from({ length: MAX_CLIP_GHOSTS + 20 }, (_, index) => ghostAt(String(index)));
    const last = String(MAX_CLIP_GHOSTS + 19);
    const drawn = ghostsToDraw(many, true, last);
    expect(drawn.filter((entry) => !entry.hovered)).toHaveLength(MAX_CLIP_GHOSTS);
    expect(drawn.some((entry) => entry.ghost.key === last && entry.hovered)).toBe(true);
  });
});

/** A canvas that records the path calls and counts the fills. */
function recordingContext(): { ctx: CanvasRenderingContext2D; moves: Array<[number, number]>; fills: () => number } {
  const moves: Array<[number, number]> = [];
  let fills = 0;
  const target: Record<string, unknown> = {
    moveTo: (x: number, y: number) => moves.push([x, y]),
    lineTo: () => undefined,
    beginPath: () => undefined,
    closePath: () => undefined,
    stroke: () => undefined,
    setLineDash: () => undefined,
    fill: () => {
      fills += 1;
    },
  };
  return { ctx: target as unknown as CanvasRenderingContext2D, moves, fills: () => fills };
}

const view: View = { pxPerIn: 2, originXPx: 300, originYPx: 300, orientation: orientationFor("bottom") };

const inputFor = (ghosts: readonly ClipGhost[], mirror: MirrorMode, hovered: string | null = null): LiveLayerInput =>
  ({
    view,
    mirror,
    theme: fallbackTheme(),
    clipGhosts: ghostsToDraw(ghosts, true, hovered),
  }) as unknown as LiveLayerInput;

describe("drawClipGhosts", () => {
  it("puts each corner through the alliance mirror like the rest of the canvas", () => {
    for (const mirror of ["none", "pointSymmetry", "mirrorX"] as const) {
      const { ctx, moves } = recordingContext();
      drawClipGhosts(ctx, inputFor([ghostAt("a")], mirror));
      const first = ghostAt("a").polygonsIn[0]?.[0] ?? { xIn: 0, yIn: 0 };
      const expected = worldToScreen(view, mirrorVec(first, mirror));
      expect(moves[0]).toEqual([expected.xPx, expected.yPx]);
    }
  });

  it("fills once per severity however many ghosts there are, plus once for the hovered one", () => {
    const few = recordingContext();
    drawClipGhosts(few.ctx, inputFor([ghostAt("a")], "none"));
    const many = recordingContext();
    drawClipGhosts(many.ctx, inputFor(Array.from({ length: 40 }, (_, index) => ghostAt(String(index))), "none"));
    expect(many.fills()).toBe(few.fills());
    const hovered = recordingContext();
    drawClipGhosts(hovered.ctx, inputFor([ghostAt("a"), ghostAt("b")], "none", "b"));
    expect(hovered.fills()).toBe(few.fills() + 1);
  });

  it("draws nothing when there are no ghosts", () => {
    const { ctx, fills } = recordingContext();
    drawClipGhosts(ctx, inputFor([], "none"));
    expect(fills()).toBe(0);
  });
});

describe("the clip ghosts preference", () => {
  const store = new Map<string, string>();
  let blocked = false;
  beforeEach(() => {
    store.clear();
    blocked = false;
    (globalThis as { window?: unknown }).window = {
      localStorage: {
        getItem: (key: string) => {
          if (blocked) throw new Error("storage blocked");
          return store.get(key) ?? null;
        },
        setItem: (key: string, value: string) => {
          if (blocked) throw new Error("storage blocked");
          store.set(key, value);
        },
      },
    };
  });
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it("is on by default, including for prefs saved before it existed", () => {
    expect(DEFAULT_PREFS.clipGhosts).toBe(true);
    expect(loadPrefs().clipGhosts).toBe(true);
    store.set("zenith.ui", JSON.stringify({ theme: "light" }));
    expect(loadPrefs().clipGhosts).toBe(true);
  });

  it("is remembered when turned off, and back on", () => {
    store.set("zenith.ui", JSON.stringify({ ...DEFAULT_PREFS }));
    // `initPrefs` applies the theme to the document, which a node test does not have.
    (globalThis as { document?: unknown }).document = { documentElement: { dataset: {} } };
    try {
      initPrefs();
      expect(getState().prefs.clipGhosts).toBe(true);
      expect(actionById("view.clipGhosts")?.active?.(getState())).toBe(true);
      toggleClipGhosts();
      expect(getState().prefs.clipGhosts).toBe(false);
      expect(JSON.parse(store.get("zenith.ui") ?? "{}").clipGhosts).toBe(false);
      expect(loadPrefs().clipGhosts).toBe(false);
      expect(actionById("view.clipGhosts")?.active?.(getState())).toBe(false);
      toggleClipGhosts();
      expect(loadPrefs().clipGhosts).toBe(true);
    } finally {
      delete (globalThis as { document?: unknown }).document;
    }
  });

  it("falls back to shown when storage is blocked, and toggling still works", () => {
    blocked = true;
    expect(loadPrefs().clipGhosts).toBe(true);
    const before = getState().prefs.clipGhosts;
    expect(() => {
      toggleClipGhosts();
    }).not.toThrow();
    expect(getState().prefs.clipGhosts).toBe(!before);
  });
});

describe("findingTimeS", () => {
  it("puts the playhead where the robot is on the ghost", () => {
    const trajectory = idealTrajectory(planned, estimated);
    const perimeter = findings.find((finding) => finding.code === "PERIMETER") as Finding;
    const atS = findingTimeS(perimeter, trajectory);
    expect(atS).not.toBeNull();
    const pose = idealPoseAt(trajectory, atS as number);
    const ghost = clipGhosts([perimeter])[0];
    expect(pose.xIn).toBeCloseTo(ghost?.poseIn.xIn ?? Number.NaN, 1);
    expect(pose.yIn).toBeCloseTo(ghost?.poseIn.yIn ?? Number.NaN, 1);
  });

  it("leaves the playhead alone for a finding with no t, or with no clock", () => {
    const perimeter = findings.find((finding) => finding.code === "PERIMETER") as Finding;
    expect(findingTimeS(perimeter, null)).toBeNull();
    const { t: _t, ...noT } = perimeter;
    expect(findingTimeS(noT, idealTrajectory(planned, estimated))).toBeNull();
    expect(findingKey(noT)).not.toBe(findingKey(perimeter));
  });
});
