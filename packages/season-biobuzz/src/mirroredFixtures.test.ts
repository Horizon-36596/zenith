import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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
 * `mirrorAuto` is given the waypoints, as any caller that saves its result has to be, so a waypoint
 * reference is written as the mirrored waypoint's numbers: the pose the runtime drives when it
 * mirrors the named waypoint itself.
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
          const mirrored = canonicalize("auto", mirrorAuto(auto, mode, source.mirrorId, waypoints));
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
