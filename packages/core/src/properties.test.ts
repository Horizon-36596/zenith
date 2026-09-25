import { parseAuto, SCHEMA_ID, type Auto, type PathStep, type Step } from "@horizon36596/zenith-schema";
import { describe, expect, it } from "vitest";
import { check } from "./check.js";
import { estimate } from "./estimate.js";
import { wrapAngle } from "./geometry/angle.js";
import { canonicalize } from "./canonicalize.js";
import { mirrorAuto, mirrorHeadingRad, mirrorPose, mirrorTurnSign, mirrorVec, type MirrorMode } from "./mirror.js";
import { makePath } from "./geometry/path.js";
import { linearHeadingPieces } from "./heading.js";
import { plan } from "./plan.js";
import { resolve } from "./resolve.js";
import { testField, testRobot, testWaypoints } from "./testing/fixtures.js";

/**
 * The properties the planning model promises. They are the statements the model
 * has to keep whatever the numbers are, so they are checked over a spread of inputs rather than on
 * one example. The spread is a fixed lattice, not a random sample: a property test that fails only
 * on some seeds is a bug report nobody can reproduce.
 */

const MODES: MirrorMode[] = ["pointSymmetry", "mirrorX", "mirrorY", "none"];

/** A lattice of poses across the field, with headings all the way round. */
const POSES = (() => {
  const out: { xIn: number; yIn: number; headingRad: number }[] = [];
  for (let x = -60; x <= 60; x += 20) {
    for (let y = -60; y <= 60; y += 20) {
      for (let turn = 0; turn < 8; turn += 1) {
        out.push({ xIn: x, yIn: y, headingRad: wrapAngle((turn / 8) * 2 * Math.PI) });
      }
    }
  }
  return out;
})();

const sameAngle = (a: number, b: number): boolean => Math.abs(wrapAngle(a - b)) < 1e-9;

const auto = (steps: Step[]): Auto =>
  parseAuto({
    $schema: SCHEMA_ID.auto,
    formatVersion: 1,
    name: "properties",
    alliance: "RED",
    start: { pose: { xIn: -40, yIn: -60, headingRad: 0 } },
    steps,
  });

const leg = (id: string, to: { xIn: number; yIn: number }, step: Partial<PathStep> = {}): PathStep => ({
  id,
  kind: "path",
  segments: [{ kind: "line", from: "current", to }],
  heading: { mode: "tangent" },
  ...step,
});

describe("property: mirroring is an involution", () => {
  it("brings every pose back, in every mode", () => {
    for (const mode of MODES) {
      for (const pose of POSES) {
        const there = mirrorPose(pose, mode);
        const back = mirrorPose(there, mode);
        expect(back.xIn, `${mode} x`).toBeCloseTo(pose.xIn, 9);
        expect(back.yIn, `${mode} y`).toBeCloseTo(pose.yIn, 9);
        expect(sameAngle(back.headingRad ?? 0, pose.headingRad), `${mode} heading`).toBe(true);
        expect(mirrorVec(mirrorVec(pose, mode), mode)).toEqual({ xIn: pose.xIn, yIn: pose.yIn });
        expect(sameAngle(mirrorHeadingRad(mirrorHeadingRad(pose.headingRad, mode), mode), pose.headingRad)).toBe(true);
      }
    }
  });

  it("brings a whole routine back, alliance included", () => {
    const original = auto([
      leg("out", { xIn: 0, yIn: -60 }),
      {
        id: "curve",
        kind: "path",
        segments: [
          {
            kind: "bezier",
            from: "current",
            control: [
              { xIn: 20, yIn: -40 },
              { xIn: 30, yIn: -10 },
            ],
            to: { xIn: 40, yIn: 0 },
          },
        ],
        heading: { mode: "facePoint", xIn: 58, yIn: 58, offsetRad: 0.2 },
      },
      {
        id: "group",
        kind: "parallel",
        mode: "all",
        steps: [leg("nested", { xIn: 20, yIn: 20 }, { heading: { mode: "constant", headingRad: 2.9 } })],
      },
      { id: "volley", kind: "command", name: "shootAll", args: { count: 2 } },
    ]);

    for (const mode of MODES) {
      const back = mirrorAuto(mirrorAuto(original, mode), mode);
      expect(back.alliance, mode).toBe(original.alliance);
      // Angles come back wrapped, so the two documents are compared after wrapping every angle.
      const wrapAngles = (value: unknown): unknown =>
        JSON.parse(
          JSON.stringify(value, (key, raw: unknown) =>
            typeof raw === "number" && key.endsWith("Rad") ? Number(wrapAngle(raw).toFixed(9)) : raw,
          ),
        ) as unknown;
      expect(wrapAngles(back), mode).toEqual(wrapAngles(original));
    }
  });
});

describe("property: the estimate is monotone in speedFraction", () => {
  it("never takes longer when the step is allowed to go faster", () => {
    let slower = Infinity;
    for (const speedFraction of [0.1, 0.2, 0.35, 0.5, 0.65, 0.8, 0.9, 1]) {
      const planned = plan(
        resolve(auto([leg("out", { xIn: 40, yIn: -60 }, { speedFraction })]), testWaypoints),
        testRobot,
        testField,
      );
      const seconds = estimate(planned, testRobot).steps[0]?.nominalS ?? 0;
      expect(seconds, `at ${String(speedFraction)}`).toBeLessThanOrEqual(slower);
      slower = seconds;
    }
  });
});

describe("property: STRUCTURE fires on the obstacle and not beside it", () => {
  // The second fixture obstacle is the one at floor level; the first is a bar above the robot.
  const obstacle = testField.obstacles?.find((box) => box.minZIn === 0);

  it("has an obstacle to aim at", () => {
    expect(obstacle).toBeDefined();
  });

  it("fires for a line through a solid box and stays quiet 1 in clear of it", () => {
    if (obstacle === undefined) return;
    const halfWidth = (obstacle.maxXIn - obstacle.minXIn) / 2;
    const centreX = (obstacle.minXIn + obstacle.maxXIn) / 2;
    const centreY = (obstacle.minYIn + obstacle.maxYIn) / 2;
    const half = testRobot.footprint.expandedIn ?? testRobot.footprint.startIn;
    const clearance = (half.widthIn + half.lengthIn) / 4 + 1;

    const across = auto([
      {
        ...leg("through", { xIn: centreX + halfWidth + 20, yIn: centreY }),
        segments: [
          {
            kind: "line",
            from: { xIn: centreX - halfWidth - 20, yIn: centreY },
            to: { xIn: centreX + halfWidth + 20, yIn: centreY },
          },
        ],
      },
    ]);
    const beside = auto([
      {
        ...leg("clear", { xIn: centreX + halfWidth + 20, yIn: obstacle.minYIn - clearance }),
        segments: [
          {
            kind: "line",
            from: { xIn: centreX - halfWidth - 20, yIn: obstacle.minYIn - clearance },
            to: { xIn: centreX + halfWidth + 20, yIn: obstacle.minYIn - clearance },
          },
        ],
      },
    ]);

    const codes = (document: Auto): string[] => {
      const planned = plan(resolve(document, testWaypoints), testRobot, testField);
      return check(planned, estimate(planned, testRobot), testRobot, testField).map((f) => f.code);
    };
    expect(codes(across)).toContain("STRUCTURE");
    expect(codes(beside)).not.toContain("STRUCTURE");
  });
});

describe("property: the strafe fraction reads the geometry", () => {
  const strafeOf = (step: PathStep): number => {
    const planned = plan(resolve(auto([step]), testWaypoints), testRobot, testField);
    return estimate(planned, testRobot).steps[0]?.strafeFraction ?? -1;
  };

  it("is 0 on a tangent line, whichever way the line runs", () => {
    for (const turn of [0, 1, 2, 3, 4, 5, 6, 7]) {
      const angle = (turn / 8) * 2 * Math.PI;
      const to = { xIn: -40 + Math.cos(angle) * 40, yIn: -60 + Math.sin(angle) * 40 };
      expect(strafeOf(leg("tangent", to)), `at ${String(turn)}`).toBe(0);
    }
  });

  it("is 1 on a constant heading square to the travel", () => {
    for (const turn of [0, 1, 2, 3, 4, 5, 6, 7]) {
      const angle = (turn / 8) * 2 * Math.PI;
      const to = { xIn: -40 + Math.cos(angle) * 40, yIn: -60 + Math.sin(angle) * 40 };
      const step = leg("sideways", to, {
        heading: { mode: "constant", headingRad: wrapAngle(angle + Math.PI / 2) },
      });
      expect(strafeOf(step), `at ${String(turn)}`).toBe(1);
    }
  });
});

describe("mirroring a half turn", () => {
  const HALF_TURNS = [3.1416, -3.1416, 0, 1.5708, -1.5708, 2.9, -0.0001];

  /** What canonical form would write, which is the level the round trip has to hold at. */
  const asWritten = (rad: number): number => Number(rad.toFixed(4));

  for (const mode of MODES) {
    it(`finding 37: ${mode} gives back the number the file carried, half turns included`, () => {
      for (const headingRad of HALF_TURNS) {
        const back = mirrorHeadingRad(mirrorHeadingRad(headingRad, mode), mode);
        expect(asWritten(back), `${mode} ${String(headingRad)}`).toBe(headingRad);
      }
      // The half turn is the case that used to come back with its sign flipped, and it comes back
      // exactly, not merely to within the rounding.
      expect(mirrorHeadingRad(mirrorHeadingRad(-3.1416, mode), mode), mode).toBe(-3.1416);
    });
  }

  it("finding 37: the canonical bytes of a half-turn waypoint survive two mirrors", () => {
    const document = auto([leg("out", { xIn: 0, yIn: -60 }, { heading: { mode: "constant", headingRad: -3.1416 } })]);
    const back = mirrorAuto(mirrorAuto(document, "pointSymmetry"), "pointSymmetry");
    expect(canonicalize("auto", back)).toBe(canonicalize("auto", document));
  });

  it("finding 37: an expect id is remapped when the season says how", () => {
    const document = auto([
      {
        id: "volley",
        kind: "command",
        name: "shootAll",
        args: { count: 2 },
        expect: { launchesInto: "hiveRedUpCell" },
      },
    ]);
    const mirrored = mirrorAuto(document, "pointSymmetry", (id) =>
      id.includes("Red") ? id.split("Red").join("Blue") : id,
    );
    expect(mirrored.steps[0]).toMatchObject({ expect: { launchesInto: "hiveBlueUpCell" } });
  });

  it("finding 37: mirroring is refused when an expect id has no counterpart", () => {
    const document = auto([
      {
        id: "volley",
        kind: "command",
        name: "shootAll",
        args: { count: 2 },
        expect: { launchesInto: "hiveRedUpCell" },
      },
    ]);
    expect(() => mirrorAuto(document, "pointSymmetry", () => null)).toThrow(/no counterpart/);
  });
});

describe("mirroring a linear sweep", () => {
  const FROM = [-3.1416, -2.3562, -1, 0, 1, 2.3562, 3.1416];
  const SWEEPS = [-4.7124, -3.1, -1.5708, 0, 1.5708, 3.1, 4.7124];

  /** A two-segment path along y = -40, so each segment carries half the sweep. */
  const sweep = (fromRad: number, toRad: number): Auto =>
    auto([
      {
        id: "turn",
        kind: "path",
        segments: [
          { kind: "line", from: { xIn: -40, yIn: -40 }, to: { xIn: 0, yIn: -40 } },
          { kind: "line", from: { xIn: 0, yIn: -40 }, to: { xIn: 40, yIn: -40 } },
        ],
        heading: { mode: "linear", fromRad, toRad },
      },
    ]);

  const linearOf = (document: Auto): { fromRad: number; toRad: number } => {
    const step = document.steps[0];
    const heading = step?.kind === "path" ? step.heading : undefined;
    if (heading?.mode !== "linear") throw new Error("expected a linear heading");
    return heading;
  };

  for (const mode of MODES) {
    const sign = mirrorTurnSign(mode);

    it(`${mode} keeps the sweep's size and turns it ${sign > 0 ? "the same" : "the other"} way`, () => {
      for (const fromRad of FROM) {
        for (const size of SWEEPS) {
          const original = sweep(fromRad, Number((fromRad + size).toFixed(4)));
          const written = linearOf(original);
          const mirrored = linearOf(mirrorAuto(original, mode));
          const label = `${mode} from ${String(fromRad)} by ${String(size)}`;
          expect(mirrored.toRad - mirrored.fromRad, label).toBeCloseTo(sign * (written.toRad - written.fromRad), 9);
          expect(sameAngle(mirrored.fromRad, mirrorHeadingRad(fromRad, mode)), label).toBe(true);
          const back = mirrorAuto(mirrorAuto(original, mode), mode);
          expect(canonicalize("auto", back), label).toBe(canonicalize("auto", original));
        }
      }
    });
  }

  it("turns 270 degrees the mirrored way over two segments, not 90 degrees back", () => {
    // Each end mirrored on its own gives 0.7854 to -0.7854 here: a 90 degree turn clockwise.
    const mirrored = linearOf(mirrorAuto(sweep(-2.3562, 2.3562), "pointSymmetry"));
    expect(mirrored.fromRad).toBeCloseTo(0.7854, 4);
    expect(mirrored.toRad - mirrored.fromRad).toBeCloseTo(4.7124, 9);
  });

  it("gives each segment the mirrored share of the sweep, turning the mirrored way", () => {
    const original = sweep(-2.3562, 2.3562);
    const geometry = makePath([
      [
        { xIn: -40, yIn: -40 },
        { xIn: 0, yIn: -40 },
      ],
      [
        { xIn: 0, yIn: -40 },
        { xIn: 40, yIn: -40 },
      ],
    ]);
    const before = linearHeadingPieces({ mode: "linear", ...linearOf(original) }, geometry);
    for (const mode of MODES) {
      const after = linearHeadingPieces({ mode: "linear", ...linearOf(mirrorAuto(original, mode)) }, geometry);
      after.forEach((piece, index) => {
        const was = before[index];
        if (was === undefined) throw new Error("missing piece");
        expect(piece.turnRad, `${mode} segment ${String(index)}`).toBeCloseTo(mirrorTurnSign(mode) * was.turnRad, 9);
        expect(sameAngle(piece.fromRad, mirrorHeadingRad(was.fromRad, mode)), `${mode} segment ${String(index)}`).toBe(
          true,
        );
      });
    }
  });

  it("keeps a piecewise range's linear sweep the same way", () => {
    const document = auto([
      {
        id: "turn",
        kind: "path",
        segments: [
          { kind: "line", from: { xIn: -40, yIn: -40 }, to: { xIn: 0, yIn: -40 } },
          { kind: "line", from: { xIn: 0, yIn: -40 }, to: { xIn: 40, yIn: -40 } },
        ],
        heading: {
          mode: "piecewise",
          ranges: [
            { startT: 0, endT: 0.3, heading: { mode: "constant", headingRad: 0 } },
            // Each end mirrored on its own under point symmetry gives pi to -1.5708: three quarters
            // of a turn the wrong way.
            { startT: 0.3, endT: 1, heading: { mode: "linear", fromRad: 0, toRad: 1.5708 } },
          ],
        },
      },
    ]);
    for (const mode of MODES) {
      const step = mirrorAuto(document, mode).steps[0];
      const heading = step?.kind === "path" ? step.heading : undefined;
      if (heading?.mode !== "piecewise") throw new Error("expected a piecewise heading");
      const inner = heading.ranges[1]?.heading;
      if (inner?.mode !== "linear") throw new Error("expected a linear range");
      expect(inner.toRad - inner.fromRad, mode).toBeCloseTo(mirrorTurnSign(mode) * 1.5708, 9);
      expect(heading.ranges.map((range) => [range.startT, range.endT]), mode).toEqual([
        [0, 0.3],
        [0.3, 1],
      ]);
      expect(canonicalize("auto", mirrorAuto(mirrorAuto(document, mode), mode)), mode).toBe(
        canonicalize("auto", document),
      );
    }
  });

  it("leaves a sweep whose ends already agree exactly as the heading mirror writes them", () => {
    const mirrored = linearOf(mirrorAuto(sweep(0.5, 1.5708), "pointSymmetry"));
    expect(mirrored).toEqual({
      mode: "linear",
      fromRad: mirrorHeadingRad(0.5, "pointSymmetry"),
      toRad: mirrorHeadingRad(1.5708, "pointSymmetry"),
    });
  });
});
