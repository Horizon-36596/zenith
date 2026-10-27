import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseAuto, SCHEMA_ID, type Auto, type Field, type Robot, type Waypoints } from "@horizon36596/zenith-schema";
import { describe, expect, it } from "vitest";
import { check } from "./check.js";
import { estimate } from "./estimate.js";
import { sha256Hex, stableJson } from "./hash.js";
import { loadAuto, loadField, loadLink, loadRobot, loadWaypoints } from "./load.js";
import { flattenSteps, plan } from "./plan.js";
import { resolve } from "./resolve.js";
import { testField, testRobot, testWaypoints } from "./testing/fixtures.js";

/**
 * OPT-01 (owner ruling 2026-10-08) moved the heading on a Bezier to the runtime's mapping, linear in
 * each segment's parametric t. On a line the two mappings are the same, so nothing that is made of
 * lines may move by even a rounding error: these digests were taken from `main` before the change, over
 * every sample's pose and footprint, every finding and every step's estimate, and they must not change.
 *
 * The starter autos are here too. Their curves use tangent headings, which OPT-01 does not touch.
 */

const starterRoot = fileURLToPath(new URL("../../../examples/starter/", import.meta.url));
const readStarter = (relative: string): unknown => JSON.parse(readFileSync(`${starterRoot}${relative}`, "utf8"));

function starter(): { robot: Robot; field: Field; waypoints: Waypoints } {
  const link = loadLink(readStarter("zenith.json"));
  return {
    robot: loadRobot(readStarter(link.robot)),
    field: loadField(readStarter(link.field)),
    waypoints: loadWaypoints(readStarter(link.waypoints ?? "autos/waypoints.json")),
  };
}

const line = (from: unknown, to: { xIn: number; yIn: number }): unknown => ({ kind: "line", from, to });

const autoOf = (steps: unknown[]): Auto =>
  parseAuto({
    $schema: SCHEMA_ID.auto,
    formatVersion: 2,
    name: "line-headings",
    alliance: "RED",
    start: { pose: { xIn: -50, yIn: -20, headingRad: 0 } },
    steps,
  });

/** Line-only paths with every heading mode OPT-01 touches: linear over several legs, and piecewise. */
const lineFixtures: Record<string, Auto> = {
  linearThreeLegs: autoOf([
    {
      id: "sweep",
      kind: "path",
      segments: [
        line("current", { xIn: -20, yIn: -20 }),
        line({ xIn: -20, yIn: -20 }, { xIn: -20, yIn: 30 }),
        line({ xIn: -20, yIn: 30 }, { xIn: 40, yIn: 35 }),
      ],
      heading: { mode: "linear", fromRad: 0, toRad: 4.7124 },
    },
  ]),
  piecewiseAcrossJoints: autoOf([
    {
      id: "ranges",
      kind: "path",
      segments: [
        line("current", { xIn: -10, yIn: -20 }),
        line({ xIn: -10, yIn: -20 }, { xIn: 10, yIn: 40 }),
      ],
      heading: {
        mode: "piecewise",
        ranges: [
          { startT: 0, endT: 0.2, heading: { mode: "constant", headingRad: 0 } },
          { startT: 0.2, endT: 0.85, heading: { mode: "linear", fromRad: 0, toRad: -2.5 } },
          { startT: 0.85, endT: 1, heading: { mode: "facePoint", xIn: 60, yIn: 60 } },
        ],
      },
    },
    {
      id: "back",
      kind: "path",
      segments: [line("current", { xIn: -40, yIn: 0 })],
      heading: { mode: "linear", fromRad: 1, toRad: 0.2 },
    },
  ]),
};

interface Project {
  robot: Robot;
  field: Field;
  waypoints: Waypoints;
}

/**
 * The CLEARANCE warning came after these digests were taken (issue #289), and the starter's routes pass
 * within the robot's clearance of a structure, so it is left out: OPT-01 does not touch it, and every
 * other finding is still pinned. The `optimizeRoute` fixes that came with issue #309 are left out for
 * the same reason: they only ask the editor to open the Optimize card, and say nothing about the plan.
 */
function digest(auto: Auto, project: Project): string {
  const planned = plan(resolve(auto, project.waypoints, project.robot), project.robot, project.field, { memoize: false });
  const estimated = estimate(planned, project.robot);
  const findings = check(planned, estimated, project.robot, project.field)
    .filter((finding) => finding.code !== "CLEARANCE")
    .map((finding) => {
      const { fixes, ...rest } = finding;
      const kept = (fixes ?? []).filter((fix) => fix.kind !== "optimizeRoute");
      return kept.length === 0 ? rest : { ...rest, fixes: kept };
    });
  const steps = flattenSteps(planned.steps).map((step) => ({
    id: step.id,
    samples: step.samples.map((sample) => ({
      sIn: sample.sIn,
      t: sample.t,
      pose: sample.pose,
      footprintIn: sample.footprintIn,
      mouthsIn: sample.mouthsIn,
    })),
  }));
  return sha256Hex(stableJson({ steps, findings, byStepId: estimated.byStepId, nominalS: estimated.nominalS }));
}

describe("OPT-01 leaves lines alone", () => {
  const test: Project = { robot: testRobot, field: testField, waypoints: testWaypoints };

  it.each(Object.keys(lineFixtures))("a line-only %s plans, estimates and checks byte for byte as before", (name) => {
    expect(digest(lineFixtures[name] as Auto, test)).toBe(LINE_DIGESTS[name]);
  });

  it.each(["first-auto", "collect-and-score", "all-step-kinds", "cycle-and-park"])(
    "the starter's %s (collect-and-score as the route it had before issue #367) plans, estimates and checks byte for byte as before",
    (name) => {
      // The shipped collect-and-score now uses heading ranges itself (issue #367), so the digest taken before
      // OPT-01 is of the route it had then, kept in test-fixtures/. The shipped file is pinned below.
      const file = name === "collect-and-score" ? new URL("../test-fixtures/corridor-collect-and-score.auto.json", import.meta.url) : null;
      const auto = loadAuto(file === null ? readStarter(`autos/${name}.auto.json`) : (JSON.parse(readFileSync(file, "utf8")) as unknown));
      expect(digest(auto, starter())).toBe(STARTER_DIGESTS[name]);
    },
  );

  it("the shipped collect-and-score keeps the plan, estimate and findings it had when issue #367 pinned it", () => {
    expect(digest(loadAuto(readStarter("autos/collect-and-score.auto.json")), starter())).toBe(SHIPPED_COLLECT_AND_SCORE_DIGEST);
  });
});

/**
 * Taken from the shipped `examples/starter/autos/collect-and-score.auto.json` once it went around the west
 * of the hive frame (issue #367). A deliberate change to the route, its heading ranges or the robot it is
 * planned for means taking this again. Taken again for #478, for five legs' `strafeCostS` alone (see
 * LINE_DIGESTS below).
 */
const SHIPPED_COLLECT_AND_SCORE_DIGEST = "48f6e60a96b93c80f136d037441c4ad48fe37d50dfddd55cf30c192867f66eb8";

/**
 * Taken from `main` at 7fff764a, before OPT-01. Taken again for the 0.1.2 UX sweep fixes (#478),
 * where only what they meant to change moved: STRAFE_FRACTION's geometry gives `tRange` and
 * `tRanges` in place of the path's points as `polygonIn` (W2-1), and a leg's `strafeCostS` compares
 * it with its nose-first version, turn on the spot included. Every pose, footprint, time and other
 * finding is as it was.
 */
const LINE_DIGESTS: Record<string, string> = {
  linearThreeLegs: "1848e25de7544665d4b9fba2a287e0db5da4b175bd62a746e14a1e356f799235",
  piecewiseAcrossJoints: "6e546064589163e1314824628dd13a9014b71e6766a8225ddce743a5e4879f8f",
};

/**
 * First taken from `main` at 7fff764a, before OPT-01, and taken again when issue #365 moved the
 * starter's waypoints and routes onto RED's side of the centre line; the line-only digests above
 * still hold OPT-01 to the code before it. collect-and-score's is still the one from 7fff764a: the
 * corridor fixture keeps that route and the waypoint poses it had then, written into the file.
 * cycle-and-park's was taken again for #478, for its park leg's `strafeCostS` alone (see above).
 */
const STARTER_DIGESTS: Record<string, string> = {
  "first-auto": "b4fbe0ffcb407d6c04b955cdbdaccc20348a323465c6676835fbc7b0b033f7f9",
  "collect-and-score": "6259932fa0187f1d762377807cd9bb37ffaf72b2182f26959e2bde1b65907eb6",
  "all-step-kinds": "ddb314a18943d433b7c391c042d1a75a91427e6a201ba86ceaae94028960ab0e",
  "cycle-and-park": "6c56debf2a246584f82196fd6cf576e647e708a818a5259643cd2ea8d8441840",
};
