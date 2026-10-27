import { describe, expect, it } from "vitest";
import { canonicalize, check, estimate, headingFunction, loadAuto, makeCurve, makePath, plan, resolve } from "@horizon36596/zenith-core";
import type { Auto, Field, Robot } from "@horizon36596/zenith-schema";
import { resolveSeason } from "@horizon36596/zenith-seasons";
import { bezierPoint, interpolateThrough, type Point } from "../bezier.js";
import { ImportError } from "../errors.js";
import { fixtureFiles, fixturePath, readJson, starterField, starterRobot } from "../testSupport.js";
import { MAX_PEDRO_LIST_LENGTH, MAX_PEDRO_NESTING_DEPTH, MAX_PEDRO_STRING_LENGTH } from "./format.js";
import { assumedAllianceWarning, importPedroProject, PEDRO_PROVENANCE, visualizerTurnDeg } from "./importPedro.js";

const field: Field = starterField();
const robot: Robot = starterRobot();
const CENTRE = 70.75;

type Raw = Record<string, unknown>;

/** The visualizer's own geometry, read straight from the fixture: one list of control polygons per top-level path. */
function referencePolygons(doc: Raw): Point[][][] {
  const start = doc["startPoint"] as { x: number; y: number };
  let cursor: Point = { xIn: start.x - CENTRE, yIn: start.y - CENTRE };
  const toField = (p: { x: number; y: number }): Point => ({ xIn: p.x - CENTRE, yIn: p.y - CENTRE });
  const leaves = (node: Raw): Raw[] => (Array.isArray(node["segments"]) ? (node["segments"] as Raw[]).flatMap(leaves) : [node]);
  return (doc["lines"] as Raw[]).map((line) =>
    leaves(line).map((leaf) => {
      const polygon = [cursor, ...((leaf["controlPoints"] as { x: number; y: number }[]) ?? []).map(toField), toField(leaf["endPoint"] as { x: number; y: number })];
      cursor = polygon[polygon.length - 1] as Point;
      return polygon;
    }),
  );
}

const sample = (polygons: readonly Point[][], perCurve = 400): Point[] =>
  polygons.flatMap((polygon) => Array.from({ length: perCurve + 1 }, (_, i) => bezierPoint(polygon, i / perCurve)));

/** Distance from p to the polyline through `line`. */
function distanceToPolyline(p: Point, line: readonly Point[]): number {
  let best = Infinity;
  for (let i = 0; i + 1 < line.length; i += 1) {
    const a = line[i] as Point;
    const b = line[i + 1] as Point;
    const dx = b.xIn - a.xIn;
    const dy = b.yIn - a.yIn;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.xIn - a.xIn) * dx + (p.yIn - a.yIn) * dy) / len2));
    best = Math.min(best, Math.hypot(p.xIn - (a.xIn + t * dx), p.yIn - (a.yIn + t * dy)));
  }
  return best;
}

/** The larger of the two one-sided distances between two sampled curves (a Hausdorff distance). */
function hausdorff(a: readonly Point[], b: readonly Point[]): number {
  let worst = 0;
  for (const p of a) worst = Math.max(worst, distanceToPolyline(p, b));
  for (const p of b) worst = Math.max(worst, distanceToPolyline(p, a));
  return worst;
}

/** An auto after the canonical writer's rounding, read back the way the CLI reads a file. */
const roundTrip = (auto: Auto): Auto => loadAuto(JSON.parse(canonicalize("auto", auto)));

const findings = (auto: Auto) => {
  const planned = plan(resolve(auto), robot, field);
  return check(planned, estimate(planned, robot), robot, field, resolveSeason(field).rules);
};

const goodFixtures = fixtureFiles("pedro", ".pp");

describe("importPedroProject: the M-C8 contract", () => {
  it("has at least two realistic fixtures to hold it to", () => {
    expect(goodFixtures.length).toBeGreaterThanOrEqual(2);
  });

  for (const name of goodFixtures) {
    describe(name, () => {
      const doc = readJson(fixturePath(`pedro/${name}`)) as Raw;
      const result = importPedroProject(doc, field, { name: name.replace(/\.pp$/, "") });
      const auto = roundTrip(result.auto);

      it("imports to an auto that loads, and whose only SCHEMA findings are placeholder commands to map", () => {
        const schema = findings(auto).filter((finding) => finding.code === "SCHEMA");
        for (const finding of schema) expect(finding.message).toMatch(/"imported\d+", which robot\.json does not register/);
      });

      it("matches the visualizer's path within 0.5 in, after canonical rounding", () => {
        const reference = referencePolygons(doc);
        const resolved = resolve(auto).steps.filter((step) => step.kind === "path");
        expect(resolved).toHaveLength(reference.length);
        resolved.forEach((step, i) => {
          const zenith = (step.segments ?? []).flatMap((segment) => {
            const curve = makeCurve(segment.pointsIn);
            return Array.from({ length: 401 }, (_, k) => curve.pointAt(k / 400));
          });
          expect(hausdorff(sample(reference[i] as Point[][]), zenith), `step ${step.id}`).toBeLessThanOrEqual(0.5);
        });
      });

      it("labels every pose it wrote as carried over from the Pedro Visualizer", () => {
        const poses: unknown[] = [auto.start.pose];
        for (const step of auto.steps) {
          if (step.kind !== "path") continue;
          for (const segment of step.segments) {
            poses.push(segment.from, segment.to, ...(segment.kind === "bezier" ? segment.control : []));
          }
        }
        const written = poses.filter((pose) => pose !== "current");
        expect(written.length).toBeGreaterThan(1);
        for (const pose of written) expect(pose).toMatchObject({ provenance: PEDRO_PROVENANCE });
      });
    });
  }

  it("imports the two 1.5.0 fixtures with no error but the ones their own routes make", () => {
    // Each fixture's route goes a little past the centre line (OPPONENT_SIDE, issue #365): score-and-park's
    // backToScore arrives turned so a corner is 0.07 in over. The import keeps the visualizer's routes as they are.
    const routeErrors: Record<string, string[]> = {
      "score-and-park.pp": ["OPPONENT_SIDE backToScore"],
      "groups-and-piecewise.pp": ["OPPONENT_SIDE hookAround"],
    };
    for (const [name, expected] of Object.entries(routeErrors)) {
      const { auto } = importPedroProject(readJson(fixturePath(`pedro/${name}`)), field, { name: "x" });
      const errors = findings(roundTrip(auto)).filter((finding) => finding.severity === "error");
      expect(errors.map((finding) => `${finding.code} ${finding.stepId}`), name).toEqual(expected);
    }
  });
});

describe("importPedroProject: what each part of a .pp file becomes", () => {
  const scoreAndPark = importPedroProject(readJson(fixturePath("pedro/score-and-park.pp")), field, { name: "score-and-park" });
  const steps = scoreAndPark.auto.steps;

  it("converts the start pose from the visualizer's corner frame and degrees", () => {
    const pose = scoreAndPark.auto.start.pose as { xIn: number; yIn: number; headingRad: number };
    expect(pose.xIn).toBeCloseTo(-12, 9);
    expect(pose.yIn).toBeCloseTo(-63, 9);
    expect(pose.headingRad).toBeCloseTo(Math.PI / 2, 9);
  });

  it("keeps the sequence order and turns its waits into wait steps, in seconds", () => {
    expect(steps.map((step) => step.kind)).toEqual(["path", "wait", "path", "path", "wait", "path", "wait", "path"]);
    expect(steps.filter((step) => step.kind === "wait").map((step) => (step as { seconds: number }).seconds)).toEqual([1.5, 0.8, 1.5]);
    expect(steps[1]?.notes).toBe('Pedro Visualizer wait "Score preload".');
  });

  it("maps each heading one to one onto ADR 0006's modes", () => {
    const headings = steps.filter((step) => step.kind === "path").map((step) => (step as { heading: unknown }).heading);
    expect(headings[0]).toEqual({ mode: "tangent" });
    // 90 to -90 degrees is half a turn, which the visualizer draws counter-clockwise; the import keeps
    // that direction as two quarter turns.
    const halfTurn = headings[1] as { mode: string; ranges: { heading: { fromRad: number; toRad: number } }[] };
    expect(halfTurn.mode).toBe("piecewise");
    expect(halfTurn.ranges[0]?.heading.fromRad).toBeCloseTo(Math.PI / 2, 9);
    expect(halfTurn.ranges[1]?.heading.toRad).toBeCloseTo((3 * Math.PI) / 2, 9);
    expect(headings[2]).toEqual({ mode: "constant", headingRad: -Math.PI / 2 });
    expect(headings[3]).toEqual({ mode: "tangentReversed" });
    expect(headings[4]).toEqual({ mode: "constant", headingRad: Math.PI });
  });

  it("writes lines as line segments and curves as bezier segments, chained with from current", () => {
    const paths = steps.filter((step) => step.kind === "path") as { segments: { kind: string; from: unknown; control?: unknown[] }[] }[];
    expect(paths.map((path) => path.segments.map((segment) => segment.kind))).toEqual([["line"], ["bezier"], ["line"], ["bezier"], ["line"]]);
    expect(paths[3]?.segments[0]?.control).toHaveLength(2);
    expect(paths[0]?.segments[0]?.from).toMatchObject({ xIn: -12, yIn: -63 });
    for (const path of paths.slice(1)) expect(path.segments[0]?.from).toBe("current");
  });

  it("names steps after the visualizer's paths", () => {
    expect(steps.filter((step) => step.kind === "path").map((step) => step.id)).toEqual([
      "toScore",
      "gardenApproach",
      "gardenPickup",
      "backToScore",
      "park",
    ]);
  });

  it("gives the robot's size from settings, rWidth along the heading, with its provenance", () => {
    expect(scoreAndPark.robotFootprint).toMatchObject({ lengthIn: 18, widthIn: 18 });
    expect(scoreAndPark.robotFootprint?.provenance).toMatch(/^CARRIED OVER \(Pedro Visualizer import\)/);
    const groups = importPedroProject(readJson(fixturePath("pedro/groups-and-piecewise.pp")), field);
    expect(groups.robotFootprint).toMatchObject({ lengthIn: 17, widthIn: 16.5 });
  });

  it("says what it left out: playback pauses, motion settings, obstacles, and the alliance it assumed", () => {
    const text = scoreAndPark.warnings.join("\n");
    expect(text).toMatch(/lines\[2\]\.waitAfterMs \(250 ms\)/);
    expect(text).toMatch(/settings\.xVelocity/);
    expect(text).toMatch(/shapes \(1 obstacle drawing\) were not imported/);
    expect(text).toMatch(/written for RED/);
    expect(scoreAndPark.assumedAlliance).toBe("RED");
    expect(scoreAndPark.warnings).toContain(assumedAllianceWarning("RED"));
    const blue = importPedroProject(readJson(fixturePath("pedro/score-and-park.pp")), field, { alliance: "BLUE" });
    expect(blue.auto.alliance).toBe("BLUE");
    expect(blue.assumedAlliance).toBeUndefined();
    expect(blue.warnings.join("\n")).not.toMatch(/written for RED/);
  });
});

describe("importPedroProject: groups, piecewise headings and long curves", () => {
  const result = importPedroProject(readJson(fixturePath("pedro/groups-and-piecewise.pp")), field, { name: "groups" });
  const paths = result.auto.steps.filter((step) => step.kind === "path") as {
    id: string;
    segments: { kind: string; control?: unknown[] }[];
    heading: { mode: string; ranges?: { startT: number; endT: number; heading: { mode: string; headingRad?: number; xIn?: number; yIn?: number } }[] };
  }[];

  it("makes a compound path one step, and its group heading the step's heading", () => {
    expect(paths[0]?.segments.map((segment) => segment.kind)).toEqual(["line", "bezier"]);
    expect(paths[0]?.heading).toMatchObject({ mode: "linear", fromRad: Math.PI / 2, toRad: 0 });
  });

  it("splits a curve with more control points than the format allows into cubic pieces, and says so", () => {
    expect(paths[1]?.segments.length).toBeGreaterThan(1);
    for (const segment of paths[1]?.segments ?? []) expect(segment.control?.length ?? 0).toBeLessThanOrEqual(3);
    expect(result.warnings.join("\n")).toMatch(/lines\[1\] is a Bézier curve with 4 control points/);
  });

  it("keeps piecewise ranges, taking a continued angle from the tangent where the range before ends", () => {
    const heading = paths[1]?.heading;
    expect(heading?.mode).toBe("piecewise");
    expect(heading?.ranges?.map((range) => [range.startT, range.endT, range.heading.mode])).toEqual([
      [0, 0.4, "tangent"],
      [0.4, 0.7, "constant"],
      [0.7, 1, "facePoint"],
    ]);
    const facing = heading?.ranges?.[2]?.heading;
    expect(facing?.xIn).toBeCloseTo(-61, 9);
    expect(facing?.yIn).toBeCloseTo(-62, 9);
    // The curve heads roughly south at 40 per cent of its length, so the continued constant does too.
    expect(heading?.ranges?.[1]?.heading.headingRad).toBeCloseTo(-Math.PI / 2, 1);
  });

  it("gives a group without a heading its children's headings as piecewise ranges by length", () => {
    const heading = paths[2]?.heading;
    expect(heading?.mode).toBe("piecewise");
    // 22 in of linear turn, then 8 in held.
    expect(heading?.ranges?.[0]?.endT).toBeCloseTo(22 / 30, 9);
    expect(heading?.ranges?.map((range) => range.heading.mode)).toEqual(["linear", "constant"]);
  });

  it("collapses the sequence items of one compound path into one step", () => {
    expect(result.auto.steps.map((step) => step.kind)).toEqual(["path", "path", "path", "wait", "path"]);
  });
});

describe("importPedroProject: newer files and sequence items it does not know", () => {
  const result = importPedroProject(readJson(fixturePath("pedro/newer-version-with-event.pp")), field, { name: "newer" });

  it("warns with both versions", () => {
    expect(result.warnings.join("\n")).toMatch(/project version 1\.7\.0; the importer understands 1\.5\.0/);
  });

  it("lists every unknown field by its path", () => {
    const text = result.warnings.join("\n");
    expect(text).toMatch(/^markers is not a field Pedro Visualizer 1\.5\.0 writes/m);
    expect(text).toMatch(/^lines\[0\]\.speedFraction is not a field/m);
  });

  it("turns an event into the placeholder command imported1 and asks for it to be mapped", () => {
    expect(result.auto.steps.map((step) => [step.kind, step.id])).toEqual([
      ["path", "driveOut"],
      ["command", "imported1"],
      ["path", "park"],
    ]);
    expect(result.auto.steps[1]).toMatchObject({ kind: "command", name: "imported1" });
    expect(result.auto.steps[1]?.notes).toMatch(/"event" named "Intake on"/);
    expect(result.warnings.join("\n")).toMatch(/sequence\[1\] is an item of kind "event".*placeholder command imported1\. Map it/);
  });
});

describe("importPedroProject: broken files name the field that is wrong", () => {
  const cases: [string, string][] = [
    ["missing-lines.pp", "lines"],
    ["end-point-not-a-number.pp", "lines[1].endPoint.x"],
    ["unknown-heading-type.pp", "lines[0].heading.type"],
    ["start-point-not-an-object.pp", "startPoint"],
  ];

  it("covers every broken fixture", () => {
    expect(cases.map(([name]) => name).sort()).toEqual(fixtureFiles("pedro/broken", ".pp"));
  });

  for (const [name, path] of cases) {
    it(`${name}: ${path}`, () => {
      let error: unknown;
      try {
        importPedroProject(readJson(fixturePath(`pedro/broken/${name}`)), field);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(ImportError);
      expect((error as ImportError).issues.map((issue) => issue.path)).toContain(path);
      expect((error as ImportError).message).toContain(path);
    });
  }

  it("refuses a document that is not an object", () => {
    expect(() => importPedroProject([1, 2], field)).toThrow(ImportError);
  });
});

describe("importPedroProject: the smaller cases", () => {
  const base = (lines: unknown[], extra: Raw = {}): Raw => ({
    startPoint: { x: 58.75, y: 7.75, headingDeg: 90 },
    lines,
    shapes: [],
    sequence: [],
    ...extra,
  });

  it("reads the heading kept on the end point by versions up to 1.3.0", () => {
    const { auto, warnings } = importPedroProject(
      base([{ id: "a", endPoint: { x: 58.75, y: 34.75, heading: "constant", degrees: 45 }, controlPoints: [] }]),
      field,
    );
    expect((auto.steps[0] as { heading: unknown }).heading).toEqual({ mode: "constant", headingRad: Math.PI / 4 });
    expect(warnings.join("\n")).toMatch(/^lines\[0\]\.heading is in the form visualizer versions up to 1\.3\.0 wrote/m);
  });

  it("drives every path in lines order when there is no sequence", () => {
    const { auto } = importPedroProject(
      base([
        { id: "a", endPoint: { x: 58.75, y: 34.75 }, controlPoints: [], heading: { type: "tangential", reverse: false } },
        { id: "b", endPoint: { x: 30.75, y: 34.75 }, controlPoints: [], heading: { type: "tangential", reverse: false } },
      ]),
      field,
    );
    expect(auto.steps.map((step) => step.id)).toEqual(["path1", "path2"]);
  });

  it("skips a sequence item that names no path, and warns", () => {
    const { auto, warnings } = importPedroProject(
      base([{ id: "a", endPoint: { x: 58.75, y: 34.75 }, controlPoints: [], heading: { type: "tangential", reverse: false } }], {
        sequence: [{ kind: "path", lineId: "a" }, { kind: "path", lineId: "zzz" }],
      }),
      field,
    );
    expect(auto.steps).toHaveLength(1);
    expect(warnings.join("\n")).toMatch(/sequence\[1\]\.lineId "zzz" names no path/);
  });

  it("writes a reversed linear piecewise range as two short turns that go the long way round", () => {
    const { auto, warnings } = importPedroProject(
      base([
        {
          id: "a",
          endPoint: { x: 58.75, y: 34.75 },
          controlPoints: [],
          heading: {
            type: "piecewise",
            piecewiseHeading: {
              segments: [{ startProgress: 0, endProgress: 1, interpolationType: "linear", reversed: true, parameters: { startDeg: 0, endDeg: 90 } }],
            },
          },
        },
      ]),
      field,
    );
    const ranges = (auto.steps[0] as { heading: { ranges: { startT: number; endT: number; heading: { fromRad: number; toRad: number } }[] } }).heading.ranges;
    expect(ranges.map((range) => [range.startT, range.endT])).toEqual([
      [0, 0.5],
      [0.5, 1],
    ]);
    // The short way from 0 to 90 degrees is +90; the long way is -270, in two halves of -135.
    expect(ranges[0]?.heading.toRad).toBeCloseTo((-135 * Math.PI) / 180, 9);
    expect(ranges[1]?.heading.toRad).toBeCloseTo((-270 * Math.PI) / 180, 9);
    expect(warnings.join("\n")).toMatch(/reversed linear heading/);
  });

  it("follows Pedro's BezierCurve.through for through points, and warns that the visualizer draws another curve", () => {
    const through = [
      { xIn: 0, yIn: 0 },
      { xIn: 10, yIn: 12 },
      { xIn: 20, yIn: 5 },
      { xIn: 30, yIn: 9 },
    ];
    const polygon = interpolateThrough(through);
    through.forEach((point, i) => {
      const onCurve = bezierPoint(polygon, i / (through.length - 1));
      expect(onCurve.xIn).toBeCloseTo(point.xIn, 9);
      expect(onCurve.yIn).toBeCloseTo(point.yIn, 9);
    });
    const { auto, warnings } = importPedroProject(
      base([
        {
          id: "a",
          endPoint: { x: 30.75, y: 34.75 },
          controlPoints: [],
          throughPoints: [{ x: 50.75, y: 20.75 }],
          heading: { type: "tangential", reverse: false },
        },
      ]),
      field,
    );
    const segment = (auto.steps[0] as { segments: { kind: string; control: { xIn: number; yIn: number }[] }[] }).segments[0];
    expect(segment?.kind).toBe("bezier");
    const polygonIn = [{ xIn: -12, yIn: -63 }, ...(segment?.control ?? []), { xIn: -40, yIn: -36 }];
    const middle = bezierPoint(polygonIn, 0.5);
    expect(middle.xIn).toBeCloseTo(50.75 - 70.75, 9);
    expect(middle.yIn).toBeCloseTo(20.75 - 70.75, 9);
    expect(warnings.join("\n")).toMatch(/Catmull-Rom/);
  });

  it("refuses a list, a string or a nesting over the caps path.json has, naming each by its path", () => {
    const refused = (doc: unknown): string[] => {
      try {
        importPedroProject(doc, field);
      } catch (error) {
        expect(error).toBeInstanceOf(ImportError);
        return (error as ImportError).issues.map((issue) => issue.path);
      }
      return [];
    };
    const line = { id: "a", endPoint: { x: 58.75, y: 34.75 }, controlPoints: [] };
    expect(refused(base(Array.from({ length: MAX_PEDRO_LIST_LENGTH + 1 }, () => line)))).toEqual(["lines"]);
    expect(refused(base([{ ...line, name: "n".repeat(MAX_PEDRO_STRING_LENGTH + 1) }]))).toEqual(["lines[0].name"]);
    let deep: unknown = 1;
    for (let i = 0; i < MAX_PEDRO_NESTING_DEPTH + 2; i += 1) deep = [deep];
    expect(refused(base([line], { shapes: deep }))[0]).toMatch(/^shapes(\[0\])+$/);
    // At the caps themselves, the file imports.
    expect(refused(base(Array.from({ length: MAX_PEDRO_LIST_LENGTH }, () => line)))).toEqual([]);
    expect(refused(base([{ ...line, name: "n".repeat(MAX_PEDRO_STRING_LENGTH) }]))).toEqual([]);
  });

  it("lets the embedded images in settings be longer than the string cap, since it never reads them", () => {
    const image = `data:image/png;base64,${"A".repeat(50_000)}`;
    const { warnings } = importPedroProject(
      base([{ id: "a", endPoint: { x: 58.75, y: 34.75 }, controlPoints: [] }], { settings: { customFieldImage: image, robotImage: image } }),
      field,
    );
    expect(Array.isArray(warnings)).toBe(true);
  });

  it("refuses an auto name the CLI could not use", () => {
    expect(() => importPedroProject(base([]), field, { name: "../x" })).toThrow(ImportError);
  });
});

/**
 * Files the visualizer itself wrote. `visualizer-1.5.0-*.pp` were made in the visualizer at commit
 * d0d538e (project version 1.5.0), `visualizer-1.3.0-*.pp` in the visualizer at 12574b9 (1.3.0),
 * each driven through its own editor and saved with Save As; `hand-1.2.1-path-chains.pp` rebuilds by
 * hand, with made-up numbers, the shape of a public 1.2.1 team file. `visualizer-drawn.json` records
 * what the visualizer draws for every fixture, and each fix below has its own test.
 */
describe("importPedroProject: files the visualizer wrote, against what it draws", () => {
  interface DrawnSample {
    segment: number;
    completion: number;
    x: number;
    y: number;
    headingDeg: number;
  }
  const drawn = readJson(fixturePath("pedro/visualizer-drawn.json")) as { samples: Record<string, DrawnSample[]> };
  const wrapDeg = (deg: number): number => {
    const a = ((((deg + 180) % 360) + 360) % 360) - 180;
    return a === -180 ? 180 : a;
  };
  const leavesOf = (node: Raw): Raw[] => (Array.isArray(node["segments"]) ? (node["segments"] as Raw[]).flatMap(leavesOf) : [node]);

  it("has drawn samples for every good fixture", () => {
    expect(Object.keys(drawn.samples).sort()).toEqual(goodFixtures);
  });

  for (const [name, samples] of Object.entries(drawn.samples)) {
    it(`${name}: every point within 0.05 in and every heading within 1.5 degrees of the visualizer's drawing`, () => {
      const doc = readJson(fixturePath(`pedro/${name}`)) as Raw;
      const auto = roundTrip(importPedroProject(doc, field, { name: "drawn" }).auto);
      const steps = resolve(auto).steps.filter((step) => step.kind === "path");
      // Every fixture runs its paths in lines order, so top-level path i is path step i.
      const leafPlace: { step: number; beforeIn: number; lengthIn: number }[] = [];
      let cursor = { x: (doc["startPoint"] as { x: number }).x, y: (doc["startPoint"] as { y: number }).y };
      (doc["lines"] as Raw[]).forEach((line, stepIndex) => {
        let beforeIn = 0;
        for (const leaf of leavesOf(line)) {
          const points = [cursor, ...((leaf["controlPoints"] as { x: number; y: number }[]) ?? []), leaf["endPoint"] as { x: number; y: number }];
          const lengthIn = makeCurve(points.map((p) => ({ xIn: p.x - CENTRE, yIn: p.y - CENTRE }))).lengthIn;
          leafPlace.push({ step: stepIndex, beforeIn, lengthIn });
          beforeIn += lengthIn;
          cursor = points[points.length - 1] as { x: number; y: number };
        }
      });
      const geometry = steps.map((step) => {
        const path = makePath((step.segments ?? []).map((segment) => segment.pointsIn));
        const heading = (step.step as { heading: Parameters<typeof headingFunction>[0] }).heading;
        // The visualizer draws a linear heading linearly in arc length. The robot turns it linearly in
        // each Bezier's own parametric t instead (OPT-01), so on a curve the two part, and what this
        // test holds the import to is the file's numbers read the visualizer's way.
        return { path, h: headingFunction(heading, path, { along: "arcLength" }) };
      });
      // The visualizer finds a tangent by a finite difference, which is up to about a degree off on
      // a tight curve; 1.5 degrees leaves room for that and for nothing else.
      for (const sample of samples) {
        const place = leafPlace[sample.segment] as { step: number; beforeIn: number; lengthIn: number };
        const { path, h } = geometry[place.step] as { path: ReturnType<typeof makePath>; h: (t: number) => number };
        const distance = place.beforeIn + sample.completion * place.lengthIn;
        const point = path.pointAtDistance(distance);
        const at = `${name} segment ${String(sample.segment)} at ${String(sample.completion)}`;
        expect(Math.hypot(point.xIn - (sample.x - CENTRE), point.yIn - (sample.y - CENTRE)), at).toBeLessThanOrEqual(0.05);
        const headingDeg = (h(path.tAtDistance(distance)) * 180) / Math.PI;
        expect(Math.abs(wrapDeg(headingDeg - sample.headingDeg)), at).toBeLessThanOrEqual(1.5);
      }
    });
  }
});

describe("importPedroProject: what real files showed the importer got wrong", () => {
  const base = (lines: unknown[], extra: Raw = {}): Raw => ({
    startPoint: { x: 58.75, y: 7.75, headingDeg: 90 },
    lines,
    shapes: [],
    sequence: [],
    ...extra,
  });
  const line = (heading: unknown, extra: Raw = {}): Raw => ({ id: "a", endPoint: { x: 58.75, y: 34.75 }, controlPoints: [], heading, ...extra });

  it("takes the fields a heading kept from the type it had before as the visualizer does, without calling them unknown", () => {
    // The visualizer's heading picker changes the type in place, so its exports carry leftovers.
    const real = importPedroProject(readJson(fixturePath("pedro/visualizer-1.5.0-lines-curves-headings.pp")), field);
    expect(real.warnings.join("\n")).not.toMatch(/heading\.\w+ is not a field/);
    const { auto, warnings } = importPedroProject(
      base([line({ type: "constant", reverse: true, startDeg: 10, endDeg: 20, degrees: 45, piecewiseHeading: { segments: [] }, spin: 1 })]),
      field,
    );
    expect((auto.steps[0] as { heading: unknown }).heading).toEqual({ mode: "constant", headingRad: Math.PI / 4 });
    const unknown = warnings.filter((warning) => / is not a field /.test(warning));
    expect(unknown).toEqual(["lines[0].heading.spin is not a field Pedro Visualizer 1.5.0 writes; it was not imported."]);
  });

  it("turns an exact half turn the way the visualizer draws it, which depends on the order of the two angles", () => {
    expect(visualizerTurnDeg(90, -90)).toBe(180);
    expect(visualizerTurnDeg(-90, 90)).toBe(-180);
    expect(visualizerTurnDeg(0, 180)).toBe(180);
    expect(visualizerTurnDeg(180, 0)).toBe(-180);
    expect(visualizerTurnDeg(170, -170)).toBe(20);
    expect(visualizerTurnDeg(270, 0)).toBe(90);
    for (const [startDeg, endDeg, midDeg] of [
      [90, -90, 180],
      [-90, 90, 180],
      [0, 180, 90],
      [180, 0, 90],
    ] as const) {
      const { auto, warnings } = importPedroProject(base([line({ type: "linear", startDeg, endDeg })]), field);
      const step = resolve(roundTrip(auto)).steps[0];
      const path = makePath((step?.segments ?? []).map((segment) => segment.pointsIn));
      const h = headingFunction((step?.step as { heading: Parameters<typeof headingFunction>[0] }).heading, path);
      // Halfway along, the robot faces the way the visualizer's shortestRotation puts it.
      const drawnMid = startDeg + visualizerTurnDeg(startDeg, endDeg) / 2;
      expect(Math.cos(((h(0.5) * 180) / Math.PI - drawnMid) * (Math.PI / 180)), `${String(startDeg)} to ${String(endDeg)}`).toBeCloseTo(1, 6);
      expect(Math.abs(Math.cos((midDeg * Math.PI) / 180 - h(0.5)))).toBeCloseTo(1, 6);
      expect(warnings.join("\n")).toMatch(/turns exactly half a turn/);
    }
  });

  it("keeps the direction of an exact half turn inside a piecewise heading too", () => {
    const { auto } = importPedroProject(
      base([
        line({
          type: "piecewise",
          piecewiseHeading: { segments: [{ startProgress: 0, endProgress: 1, interpolationType: "linear", parameters: { startDeg: -90, endDeg: 90 } }] },
        }),
      ]),
      field,
    );
    const ranges = (auto.steps[0] as { heading: { ranges: { startT: number; endT: number; heading: { toRad: number } }[] } }).heading.ranges;
    expect(ranges.map((range) => [range.startT, range.endT])).toEqual([
      [0, 0.5],
      [0.5, 1],
    ]);
    // -90 to 90 turns clockwise in the visualizer: through -180.
    expect(ranges[0]?.heading.toRad).toBeCloseTo(-Math.PI, 9);
    expect(ranges[1]?.heading.toRad).toBeCloseTo((-3 * Math.PI) / 2, 9);
  });

  /** The heading in degrees, wrapped to (-180, 180], at t along the first step of the written file. */
  const writtenHeadingDeg = (auto: Auto, t: number): number => {
    const step = resolve(roundTrip(auto)).steps[0];
    const path = makePath((step?.segments ?? []).map((segment) => segment.pointsIn));
    const h = headingFunction((step?.step as { heading: Parameters<typeof headingFunction>[0] }).heading, path);
    const deg = (h(t) * 180) / Math.PI;
    return Math.abs(deg + 180) < 1e-6 ? 180 : deg;
  };

  it("turns a half turn that continues from the range before it the way the visualizer draws it", () => {
    // Held at -176 degrees, then on to 4 degrees: the visualizer puts -176 at 184 and 4 at 4, so the
    // half turn goes clockwise, through -266 (94) degrees at the middle of the second range. At
    // these angles a trip of the held angle through radians and back lands a hair off -176 and would
    // flip the turn, so the importer must take the held angle in the visualizer's own degrees.
    for (const [heldDeg, endDeg, midDeg] of [
      [-176, 4, 94],
      [-165, 15, 105],
      [-357.5, -177.5, 92.5],
    ] as const) {
      const { auto } = importPedroProject(
        base([
          line({
            type: "piecewise",
            piecewiseHeading: {
              segments: [
                { startProgress: 0, endProgress: 0.5, interpolationType: "constant", parameters: { degrees: heldDeg } },
                { startProgress: 0.5, endProgress: 1, interpolationType: "linear", continueFromPrevious: true, parameters: { startDeg: 0, endDeg } },
              ],
            },
          }),
        ]),
        field,
      );
      const drawnMid = heldDeg + visualizerTurnDeg(heldDeg, endDeg) / 2;
      expect(Math.cos(((writtenHeadingDeg(auto, 0.75) - drawnMid) * Math.PI) / 180), `${String(heldDeg)} to ${String(endDeg)}`).toBeCloseTo(1, 6);
      expect(Math.cos(((writtenHeadingDeg(auto, 0.75) - midDeg) * Math.PI) / 180), `${String(heldDeg)} to ${String(endDeg)}`).toBeCloseTo(1, 6);
    }
  });

  it("keeps a reversed linear range whose two angles are equal a whole clockwise turn once the file is written", () => {
    // The visualizer's reversedRotation turns the long way round, which for equal angles is -360
    // degrees. Written as two exact half turns, rounding to four decimals could send either half
    // either way; the robot must be seen turning clockwise all the way round.
    for (const deg of [0, 30, 90, -135]) {
      const { auto } = importPedroProject(
        base([
          line({
            type: "piecewise",
            piecewiseHeading: {
              segments: [{ startProgress: 0, endProgress: 1, interpolationType: "linear", reversed: true, parameters: { startDeg: deg, endDeg: deg } }],
            },
          }),
        ]),
        field,
      );
      for (const t of [0.1, 0.25, 0.4, 0.5, 0.6, 0.75, 0.9]) {
        const expected = deg - 360 * t;
        expect(Math.cos(((writtenHeadingDeg(auto, t) - expected) * Math.PI) / 180), `${String(deg)} at t ${String(t)}`).toBeCloseTo(1, 6);
      }
    }
  });

  it("says once, naming every path, that a file keeps its headings on the end points as 1.3.0 and older do", () => {
    const { warnings } = importPedroProject(readJson(fixturePath("pedro/visualizer-1.3.0-heading-on-end-point.pp")), field);
    const legacy = warnings.filter((warning) => /on the end point/.test(warning));
    expect(legacy).toEqual([
      "lines[0].heading, lines[1].heading, lines[2].heading, lines[3].heading, lines[4].heading are in the form visualizer versions up to 1.3.0 wrote (a heading name with its numbers on the end point); read the way the current visualizer reads them.",
    ]);
  });

  it("knows the fields 1.2.1 and 1.3.0 wrote that 1.5.0 no longer reads, and says what it did with path chains", () => {
    for (const name of ["visualizer-1.3.0-heading-on-end-point.pp", "hand-1.2.1-path-chains.pp"]) {
      const { warnings } = importPedroProject(readJson(fixturePath(`pedro/${name}`)), field);
      const text = warnings.join("\n");
      expect(text, name).not.toMatch(/is not a field/);
      expect(text, name).toMatch(/^pathChains \(one path chain, from a visualizer version up to 1\.3\.0\) was not imported/m);
    }
    const chained = importPedroProject(
      base([line({ type: "piecewise", piecewiseHeading: { scope: "chain", segments: [{ startProgress: 0, endProgress: 1, interpolationType: "tangential" }] } })]),
      field,
    );
    expect(chained.warnings.join("\n")).toMatch(/lines\[0\]\.heading\.piecewiseHeading\.scope is "chain"/);
    expect(chained.warnings.join("\n")).not.toMatch(/is not a field/);
  });

  it("drives every path in lines order when the sequence names none of them, as the visualizer's code export does", () => {
    const { auto, warnings } = importPedroProject(
      base([line({ type: "tangential", reverse: false })], { sequence: [{ kind: "path", lineId: "gone" }] }),
      field,
    );
    expect(auto.steps.map((step) => step.kind)).toEqual(["path"]);
    expect(warnings.join("\n")).toMatch(/sequence names none of the paths in lines/);
  });

  it("warns about a pause kept in the older waitAfter object, which the visualizer still reads", () => {
    const { warnings } = importPedroProject(
      base([line({ type: "tangential", reverse: false }, { waitAfter: { name: "", durationMs: 400 }, waitBefore: { durationMs: 100 } })]),
      field,
    );
    const text = warnings.join("\n");
    expect(text).toMatch(/lines\[0\]\.waitAfter\.durationMs \(400 ms\) is a pause the visualizer shows in playback only/);
    expect(text).toMatch(/lines\[0\]\.waitBefore\.durationMs \(100 ms\) is not used/);
  });
});
