import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { canonicalize, check, estimate, loadAuto, makeCurve, plan, resolve } from "@horizon36596/zenith-core";
import type { Auto, Field, Robot } from "@horizon36596/zenith-schema";
import { resolveSeason } from "@horizon36596/zenith-seasons";
import { bezierPoint, type Point } from "../bezier.js";
import { ImportError } from "../errors.js";
import { checkInterchange, interchangeKindOf } from "../interchange.js";
import { pathJsonSchema, pathJsonSchemaText } from "../jsonschema.js";
import { fixtureFiles, fixturePath, readJson, starterField, starterRobot } from "../testSupport.js";
import { importPath, PATH_PROVENANCE } from "./importPath.js";
import { PATH_SCHEMA_ID, pathFileSchema } from "./schema.js";

const field: Field = starterField();
const robot: Robot = starterRobot();

type Raw = Record<string, unknown>;
type RawPoint = { x: number; y: number };

/**
 * Each good fixture's frame, written out by hand from its declared frame (not through `frame.ts`),
 * so the tests check the importer's conversion against an independent reading of the same frame.
 */
const REFERENCE_FRAMES: Record<string, (p: RawPoint) => Point> = {
  // The Pedro Visualizer's corner origin: a translation by its centre, 70.75 in.
  "pedro-score-and-park.path.json": (p) => ({ xIn: p.x - 70.75, yIn: p.y - 70.75 }),
  // MeepMeep's frame for BIOBUZZ: field x is RoadRunner's y, field y is minus RoadRunner's x.
  "roadrunner-piecewise.path.json": (p) => ({ xIn: p.y, yIn: -p.x }),
  // Millimetres from (-72, -72), the planner's x along the field's +y and its y along the field's +x.
  "explicit-millimetres.path.json": (p) => ({ xIn: -72 + p.y / 25.4, yIn: -72 + p.x / 25.4 }),
};

/** The file's own control polygons, one list per path step, in the field frame. */
function referencePolygons(doc: Raw, toField: (p: RawPoint) => Point): Point[][][] {
  const steps = (doc["steps"] as Raw[]).filter((step) => step["kind"] === "path");
  return steps.map((step) =>
    (step["segments"] as Raw[]).map((segment) => [
      toField(segment["from"] as RawPoint),
      ...((segment["control"] as RawPoint[] | undefined) ?? []).map(toField),
      toField(segment["to"] as RawPoint),
    ]),
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

const goodFixtures = fixtureFiles("path", ".json");

/**
 * The one game rule a fixture's own route breaks, which a faithful import keeps: score-and-park's
 * backToScore arrives at its scoring spot turned so that a corner is 0.07 in past the centre line
 * (OPPONENT_SIDE, issue #365). Everything else imports with no error.
 */
const ROUTE_ERRORS: Readonly<Record<string, string[]>> = { "pedro-score-and-park.path.json": ["OPPONENT_SIDE backToScore"] };

describe("importPath: the M-C8 contract", () => {
  it("has a reference frame for every good fixture", () => {
    expect(Object.keys(REFERENCE_FRAMES).sort()).toEqual(goodFixtures);
  });

  for (const name of goodFixtures) {
    describe(name, () => {
      const doc = readJson(fixturePath(`path/${name}`)) as Raw;
      const result = importPath(doc, field, { name: name.replace(/\.path\.json$/, "") });
      const auto = roundTrip(result.auto);

      it("imports to an auto that validates with no error but the ones its own route makes", () => {
        const errors = findings(auto).filter((finding) => finding.severity === "error");
        expect(errors.map((finding) => `${finding.code} ${finding.stepId}`)).toEqual(ROUTE_ERRORS[name] ?? []);
      });

      it("lies within 0.5 in of the file's own path, after canonical rounding", () => {
        const reference = referencePolygons(doc, REFERENCE_FRAMES[name] as (p: RawPoint) => Point);
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

      it("labels every pose it wrote as carried over from path.json", () => {
        const poses: unknown[] = [auto.start.pose];
        for (const step of auto.steps) {
          if (step.kind !== "path") continue;
          for (const segment of step.segments) {
            poses.push(segment.from, segment.to, ...(segment.kind === "bezier" ? segment.control : []));
          }
        }
        const written = poses.filter((pose) => pose !== "current");
        expect(written.length).toBeGreaterThan(1);
        for (const pose of written) expect(pose).toMatchObject({ provenance: PATH_PROVENANCE });
      });

      it("keeps the file's alliance and the order and kinds of its steps", () => {
        expect(auto.alliance).toBe(doc["alliance"]);
        expect(auto.steps.map((step) => step.kind)).toEqual((doc["steps"] as Raw[]).map((step) => step["kind"]));
      });
    });
  }
});

describe("importPath: what each part of a path.json file becomes", () => {
  const { auto, warnings } = importPath(readJson(fixturePath("path/pedro-score-and-park.path.json")), field, { name: "score-and-park" });
  const pathSteps = auto.steps.filter((step) => step.kind === "path");

  it("has nothing to warn about in a clean file", () => {
    expect(warnings).toEqual([]);
  });

  it("converts the start pose from the declared frame", () => {
    expect(auto.start.pose).toEqual({ xIn: -12, yIn: -63, headingRad: expect.closeTo(Math.PI / 2, 12), provenance: PATH_PROVENANCE });
  });

  it("keeps the file's step ids and names the rest by kind", () => {
    expect(auto.steps.map((step) => step.id)).toEqual(["toScore", "scorePreload", "gardenApproach", "gardenPickup", "wait1", "backToScore", "wait2", "park"]);
  });

  it("starts a path step that continues from the one before it from current", () => {
    expect(pathSteps[0]?.segments[0]?.from).toMatchObject({ xIn: -12, yIn: -63 });
    for (const step of pathSteps.slice(1)) expect(step.segments[0]?.from).toBe("current");
  });

  it("maps every heading mode and keeps a linear turn's direction and size", () => {
    expect(pathSteps[0]?.heading).toEqual({ mode: "tangent" });
    // 90 to 270 degrees is half a turn counter-clockwise, written that way; it is not shortened.
    expect(pathSteps[1]?.heading).toEqual({ mode: "linear", fromRad: expect.closeTo(Math.PI / 2, 12), toRad: expect.closeTo((3 * Math.PI) / 2, 12) });
    expect(pathSteps[2]?.heading).toEqual({ mode: "constant", headingRad: expect.closeTo(-Math.PI / 2, 12) });
    expect(pathSteps[3]?.heading).toEqual({ mode: "tangentReversed" });
    expect(pathSteps[4]?.heading).toEqual({ mode: "constant", headingRad: expect.closeTo(Math.PI, 12) });
  });

  it("keeps speed fractions, timeouts and wait seconds", () => {
    expect(pathSteps[2]?.speedFraction).toBe(0.6);
    expect(pathSteps[3]?.timeoutS).toBe(4);
    expect(auto.steps.filter((step) => step.kind === "wait").map((step) => (step as { seconds: number }).seconds)).toEqual([1.5, 0.8, 1.5]);
  });

  it("describes where the auto came from, and takes the title from the file", () => {
    expect(auto.title).toBe("Score and park, Pedro frame");
    expect(auto.description).toBe("Imported from a path.json file written by hand-written fixture.");
  });

  it("converts a piecewise heading range by range, face-point targets and offsets included", () => {
    const { auto: rr } = importPath(readJson(fixturePath("path/roadrunner-piecewise.path.json")), field);
    const heading = rr.steps[0]?.kind === "path" ? rr.steps[0].heading : undefined;
    expect(heading).toEqual({
      mode: "piecewise",
      ranges: [
        { startT: 0, endT: 0.4, heading: { mode: "constant", headingRad: expect.closeTo(Math.PI / 2, 12) } },
        { startT: 0.4, endT: 0.7, heading: { mode: "linear", fromRad: expect.closeTo(Math.PI / 2, 12), toRad: expect.closeTo(Math.PI, 12) } },
        { startT: 0.7, endT: 1, heading: { mode: "facePoint", xIn: -60, yIn: -60, offsetRad: 0.25 } },
      ],
    });
  });

  it("turns a clockwise heading the other way on the field, and a mirrored frame back again", () => {
    const base = {
      formatVersion: 1,
      kind: "path",
      season: "biobuzz",
      alliance: "RED",
      startPose: { x: 0, y: 0, heading: 0 },
      steps: [{ kind: "path", segments: [{ kind: "line", from: { x: 0, y: 0 }, to: { x: 0, y: 20 } }], heading: { mode: "linear", from: 0, to: 90 } }],
    };
    const clockwise = { originIn: { xIn: 0, yIn: 0 }, xAxis: "+x", yAxis: "+y", units: "in", headingUnit: "deg", headingZero: "+x", headingPositive: "cw" };
    const cw = importPath({ ...base, frame: clockwise }, field).auto.steps[0];
    expect(cw?.kind === "path" ? cw.heading : undefined).toEqual({ mode: "linear", fromRad: 0, toRad: expect.closeTo(-Math.PI / 2, 12) });
    const mirrored = importPath({ ...base, frame: { ...clockwise, yAxis: "-y" } }, field).auto.steps[0];
    expect(mirrored?.kind === "path" ? mirrored.heading : undefined).toEqual({ mode: "linear", fromRad: 0, toRad: expect.closeTo(Math.PI / 2, 12) });
  });

  it("reads a mirrored millimetre frame whose headings run clockwise from its +y", () => {
    const { auto: blue } = importPath(readJson(fixturePath("path/explicit-millimetres.path.json")), field);
    // 270 degrees clockwise from the planner's +y (the field's +x) is the field's -y: facing the audience.
    expect(blue.start.pose).toMatchObject({ xIn: expect.closeTo(12, 9), yIn: expect.closeTo(63, 9), headingRad: expect.closeTo(-Math.PI / 2, 12) });
    const last = blue.steps[2];
    // 270 to 360 is a quarter turn clockwise in the planner's mirrored axes, so counter-clockwise on the field.
    expect(last?.kind === "path" ? last.heading : undefined).toEqual({
      mode: "linear",
      fromRad: expect.closeTo(-Math.PI / 2, 12),
      toRad: expect.closeTo(0, 12),
    });
  });

  it("warns when a path step does not start where the one before it ends", () => {
    const doc = readJson(fixturePath("path/pedro-score-and-park.path.json")) as { steps: { segments?: { from: RawPoint }[] }[] };
    const moved = structuredClone(doc);
    const first = moved.steps[2]?.segments?.[0];
    if (first !== undefined) first.from = { x: 60.75, y: 34.75 };
    const result = importPath(moved, field);
    expect(result.warnings.join("\n")).toMatch(/steps\[2\]\.segments\[0\]\.from is 2\.00 in from where the path step before it ends/);
    const step = result.auto.steps[2];
    expect(step?.kind === "path" ? step.segments[0]?.from : undefined).toMatchObject({ xIn: -10, yIn: -36 });
  });

  it("gives a step id outside the step id rule one inside it, and says so", () => {
    const doc = readJson(fixturePath("path/pedro-score-and-park.path.json")) as { steps: { id?: string }[] };
    const renamed = structuredClone(doc);
    const [first, second] = renamed.steps;
    if (first !== undefined) first.id = "to score";
    if (second !== undefined) second.id = "2nd";
    const result = importPath(renamed, field);
    expect(result.auto.steps.slice(0, 2).map((step) => step.id)).toEqual(["toScore", "step2nd"]);
    expect(result.warnings).toContain('steps[0].id "to score" is not an id a step can have, so the step was imported as toScore.');
    expect(result.warnings).toContain('steps[1].id "2nd" is not an id a step can have, so the step was imported as step2nd.');
  });
});

describe("importPath: broken files name the field that is wrong", () => {
  const cases: [string, string][] = [
    ["bezier-too-many-controls.path.json", "steps[2].segments[0].control"],
    ["command-step.path.json", "steps[1].kind"],
    ["duplicate-step-id.path.json", "steps[3].id"],
    ["frame-without-preset-or-keys.path.json", "frame.originIn"],
    ["linear-heading-missing-to.path.json", "steps[2].heading.to"],
    ["missing-start-pose.path.json", "startPose"],
    ["piecewise-gap.path.json", "steps[2].heading.ranges[1].startT"],
    ["segments-do-not-join.path.json", "steps[0].segments[1].from"],
    ["unknown-field.path.json", "steps[0]"],
    ["wrong-season.path.json", "season"],
  ];

  it("covers every broken fixture", () => {
    expect(cases.map(([name]) => name)).toEqual(fixtureFiles("path/broken", ".json"));
  });

  for (const [name, path] of cases) {
    it(`${name}: ${path}`, () => {
      let error: unknown;
      try {
        importPath(readJson(fixturePath(`path/broken/${name}`)), field);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(ImportError);
      expect((error as ImportError).issues.map((issue) => issue.path)).toContain(path);
      if (name === "unknown-field.path.json") expect((error as ImportError).message).toMatch(/markers.*the path format has no such field/);
    });

    it(`${name}: checkInterchange reports ${path} as an error`, () => {
      const doc = readJson(fixturePath(`path/broken/${name}`));
      const kind = interchangeKindOf(doc);
      expect(kind).toBe("path");
      const report = checkInterchange("path", doc, field);
      expect(report.errors.map((issue) => issue.path)).toContain(path);
    });
  }
});

describe("path.json: the published schema and the fixtures", () => {
  it("accepts every good fixture", () => {
    for (const name of goodFixtures) {
      expect(pathFileSchema.safeParse(readJson(fixturePath(`path/${name}`))).success, name).toBe(true);
    }
  });

  it("is published at its served id", () => {
    const schema = pathJsonSchema();
    expect(schema["$id"]).toBe(PATH_SCHEMA_ID);
    expect(PATH_SCHEMA_ID).toBe("https://libraries.horizon36596.org/zenith/schema/v1/path.json");
    expect(schema["$schema"]).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(schema["additionalProperties"]).toBe(false);
  });

  it("matches the file checked into json/", () => {
    const path = fileURLToPath(new URL("../../json/path.json", import.meta.url));
    const onDisk = readFileSync(path, "utf8").split("\r\n").join("\n");
    expect(onDisk, "json/path.json is stale; run pnpm --filter @horizon36596/zenith-import gen:json").toBe(pathJsonSchemaText());
  });
});

describe("interchangeKindOf", () => {
  it("tells the two interchange files apart by kind, and nothing else is one", () => {
    expect(interchangeKindOf(readJson(fixturePath("path/pedro-score-and-park.path.json")))).toBe("path");
    expect(interchangeKindOf(readJson(fixturePath("trajectory/pedro-20hz.trajectory.json")))).toBe("trajectory");
    expect(interchangeKindOf({ kind: "projection" })).toBeNull();
    expect(interchangeKindOf([])).toBeNull();
    expect(interchangeKindOf(null)).toBeNull();
  });

  it("passes a good trajectory with its warnings, and names the field of a broken one", () => {
    const good = checkInterchange("trajectory", readJson(fixturePath("trajectory/pedro-20hz.trajectory.json")), field);
    expect(good).toEqual({ kind: "trajectory", errors: [], warnings: [] });
    const broken = checkInterchange("trajectory", readJson(fixturePath("trajectory/broken/pose-row-too-short.trajectory.json")), field);
    expect(broken.errors.map((issue) => issue.path)).toContain("poses[1]");
  });
});
