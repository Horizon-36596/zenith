import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  childLists,
  withChildLists,
  type Auto,
  type PoseSource,
  type Segment,
  type Step,
  type Waypoints,
} from "@horizon36596/zenith-schema";
import {
  canonicalize,
  loadAuto,
  loadField,
  loadWaypoints,
  mirrorAuto,
  mirrorForField,
  type MirrorMode,
} from "@horizon36596/zenith-core";
import { describe, expect, it } from "vitest";
import { biobuzzRules } from "./rules.js";

/**
 * The editor's half of the robot runtime's mirror cross-check.
 *
 * `robot/auto-runtime`'s `MirrorConformanceTest` runs every starter auto and every conformance
 * fixture as the other alliance, which mirrors it on the robot, and runs what `mirrorAuto` makes of
 * the same file saved as its own alliance, which is not mirrored at all. The two must drive the same
 * paths, face the same way along them and log the same events. This writes the second set of files,
 * under `robot/auto-runtime/src/test/resources/mirrored/<mode>/<source>/`, and fails when the
 * checked-in copies have drifted from what `mirrorAuto` writes now.
 *
 * Two mirrors are written. `pointSymmetry` is the one BIOBUZZ's field declares, which the starter's
 * field file is asked for rather than assumed. `mirrorX`, a reflection, is not any season's; it is
 * there because a reflection reverses the way a turn goes and a point symmetry does not, and the
 * runtime has to get both right.
 *
 * Waypoint references are written out as their numbers before mirroring. `mirrorAuto` keeps a
 * reference as it is, meaning the other alliance's waypoint of that name, and the runtime mirrors the
 * one waypoint the file names; inlining them first compares the mirror itself and nothing else.
 *
 * Set `ZENITH_UPDATE_GOLDEN=1` to write the files instead of comparing against them.
 */
const repo = fileURLToPath(new URL("../../../", import.meta.url));
const starterAutos = `${repo}examples/starter/autos/`;
const conformance = `${repo}robot/auto-runtime/src/test/resources/conformance/`;
const mirroredRoot = `${repo}robot/auto-runtime/src/test/resources/mirrored/`;

const read = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));

const autosIn = (dir: string): string[] =>
  readdirSync(dir)
    .filter((file) => file.endsWith(".auto.json"))
    .sort();

/** `source` with every waypoint reference replaced by the waypoint's numbers. */
function inline(source: PoseSource, waypoints: Waypoints): PoseSource {
  if (source === "current" || !("ref" in source)) return source;
  const waypoint = waypoints.waypoints[source.ref];
  if (waypoint === undefined) throw new Error(`no waypoint named ${JSON.stringify(source.ref)}`);
  return { xIn: waypoint.xIn, yIn: waypoint.yIn, headingRad: waypoint.headingRad };
}

function inlineSegment(segment: Segment, waypoints: Waypoints): Segment {
  return { ...segment, from: inline(segment.from, waypoints), to: inline(segment.to, waypoints) } as Segment;
}

function inlineStep(step: Step, waypoints: Waypoints): Step {
  if (step.kind === "path") {
    return { ...step, segments: step.segments.map((segment) => inlineSegment(segment, waypoints)) };
  }
  return withChildLists(
    step,
    childLists(step).map((list) => list.map((child) => inlineStep(child, waypoints))),
  );
}

function inlineAuto(auto: Auto, waypoints: Waypoints): Auto {
  return {
    ...auto,
    start: { ...auto.start, pose: inline(auto.start.pose, waypoints) as Auto["start"]["pose"] },
    steps: auto.steps.map((step) => inlineStep(step, waypoints)),
  };
}

interface Source {
  name: string;
  dir: string;
  /** The season's `mirrorId`, for the files that name BIOBUZZ field elements. */
  mirrorId?: (id: string) => string | null;
}

const SOURCES: Source[] = [
  { name: "starter", dir: starterAutos, mirrorId: biobuzzRules.mirrorId },
  { name: "conformance", dir: conformance },
];

/** The mirror BIOBUZZ's field file declares, read from the starter project rather than assumed. */
const biobuzzMirror = mirrorForField(loadField(read(`${starterAutos}field/biobuzz.field.json`)));
const MODES: MirrorMode[] = [biobuzzMirror, "mirrorX"];

describe.skipIf(!existsSync(starterAutos) || !existsSync(conformance))("the mirrored runtime fixtures", () => {
  it("mirror BIOBUZZ by a point symmetry, the mirror the runtime tests give the robot", () => {
    expect(biobuzzMirror).toBe("pointSymmetry");
  });

  for (const mode of MODES) {
    for (const source of SOURCES) {
      it(`match what mirrorAuto writes for ${source.name}, ${mode}`, () => {
        const waypoints = loadWaypoints(read(`${source.dir}waypoints.json`));
        const outDir = `${mirroredRoot}${mode}/${source.name}/`;
        const names = autosIn(source.dir);
        expect(names.length, source.dir).toBeGreaterThan(0);
        for (const file of names) {
          const auto = loadAuto(read(`${source.dir}${file}`));
          const mirrored = canonicalize("auto", mirrorAuto(inlineAuto(auto, waypoints), mode, source.mirrorId));
          const checkedIn = `${outDir}${file}`;
          if (process.env["ZENITH_UPDATE_GOLDEN"] === "1") {
            mkdirSync(outDir, { recursive: true });
            writeFileSync(checkedIn, mirrored, "utf8");
            continue;
          }
          expect(existsSync(checkedIn), `${checkedIn} is missing; regenerate with ZENITH_UPDATE_GOLDEN=1`).toBe(true);
          expect(
            readFileSync(checkedIn, "utf8").replace(/\r\n/g, "\n"),
            `${checkedIn} is stale; regenerate with ZENITH_UPDATE_GOLDEN=1`,
          ).toBe(mirrored);
        }
        // A file left behind by an auto that was renamed or removed would still run in the robot tests.
        if (existsSync(outDir)) {
          expect(autosIn(outDir), outDir).toEqual(names);
        }
      });
    }
  }
});
