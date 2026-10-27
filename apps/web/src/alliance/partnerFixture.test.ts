import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalize,
  loadAuto,
  loadField,
  loadLink,
  loadRobot,
  loadWaypoints,
  plan,
  projectShare,
  resolve,
  runLedger,
  simulate,
  type Plan,
} from "@horizon36596/zenith-core";
import { resolveSeason } from "@horizon36596/zenith-seasons";
import type { Projection, Waypoints } from "@horizon36596/zenith-schema";
import { describe, expect, it } from "vitest";
import { computeAlliance, partnerLabel, type PartnerEntry } from "./model";
import { readPartnerText } from "./source";
import { allianceFrameFor, ownRobotFor } from "./useAlliance";

/**
 * The example partner in `examples/starter/partners/`, and the proof it is what it says it is: the
 * starter's `first-auto`, planned from one tile west of the starter's start (its own start,
 * scoring pose and park moved; the steps untouched), simulated, and shared with `projectShare` as a
 * view projection. The file is generated, never written by hand: run this test with
 * `ZENITH_WRITE_PARTNER_FIXTURE=1` to write it again after a change to the starter or to core.
 *
 * Against the starter's `collect-and-score`, the auto the example opens, it raises one predicted
 * collision as that auto drives out past the partner's scoring spot, which a start delay clears.
 * That is what the alliance view's end-to-end test looks for. Since issue #365 the starter's start
 * and scoring spot are 4 in further west and its routes go round the west of the hive, so the
 * partner's start and scoring pose are 4 in further west too, and it parks north of the loading
 * zone's middle, where none of the starter's routes pass.
 */

const starter = fileURLToPath(new URL("../../../../examples/starter/", import.meta.url));
const FIXTURE = `${starter}partners/starter-partner.projection.json`;
const read = (relative: string): unknown => JSON.parse(readFileSync(`${starter}${relative}`, "utf8"));

function starterFiles() {
  const link = loadLink(read("zenith.json"));
  const robot = loadRobot(read(link.robot));
  const field = loadField(read(link.field));
  const waypoints = loadWaypoints(read(link.waypoints ?? "autos/waypoints.json"));
  return { robot, field, waypoints };
}

/**
 * The partner's waypoints: the starter's, with its start one tile west, its scoring pose beside the
 * starter's and its park in the loading zone.
 */
function partnerWaypoints(base: Waypoints): Waypoints {
  const moved = (xIn: number, yIn: number, headingRad: number, why: string) => ({
    xIn,
    yIn,
    headingRad,
    provenance: `PLACEHOLDER: example partner, ${why}`,
  });
  return {
    ...base,
    waypoints: {
      ...base.waypoints,
      start: moved(-37, -63, 1.5708, "one tile west of the starter's start"),
      scoreSouth: moved(-34, -38, 1.5708, "north of its start, beside the starter's scoring spot, facing the hive"),
      park: moved(-62, 44, 1.5708, "partly inside RED's loading zone, against the west wall, out of the starter's way"),
    },
  };
}

function buildPartner(extra: { includeCommands?: boolean } = {}): Projection {
  const { robot, field, waypoints } = starterFiles();
  const season = resolveSeason(field).rules;
  const planned = plan(resolve(loadAuto(read("autos/first-auto.auto.json")), partnerWaypoints(waypoints), robot), robot, field);
  const ledger = runLedger(planned, field, season);
  const trace = simulate(planned, robot, field, { ledger, season });
  return projectShare({ plan: planned, trace, robot, field, ledger }, { level: "view", title: "Starter partner", ...extra });
}

function starterPlan(name: string): Plan {
  const { robot, field, waypoints } = starterFiles();
  return plan(resolve(loadAuto(read(`autos/${name}.auto.json`)), waypoints, robot), robot, field);
}

describe("the example partner projection", () => {
  it("is exactly what projectShare builds from the starter's first-auto one tile west", () => {
    const expected = canonicalize("projection", buildPartner());
    if (process.env["ZENITH_WRITE_PARTNER_FIXTURE"] === "1") {
      mkdirSync(dirname(FIXTURE), { recursive: true });
      writeFileSync(FIXTURE, expected, "utf8");
    }
    expect(readFileSync(FIXTURE, "utf8").replace(/\r\n/g, "\n")).toBe(expected);
  });

  it("is byte for byte the same with Include command names off, and gains only a commands list with it on", () => {
    const fixture = readFileSync(FIXTURE, "utf8").replace(/\r\n/g, "\n");
    expect(canonicalize("projection", buildPartner({ includeCommands: false }))).toBe(fixture);
    const { commands, ...rest } = buildPartner({ includeCommands: true });
    expect(canonicalize("projection", rest)).toBe(fixture);
    expect(commands?.map((entry) => entry.name)).toContain("score");
  });

  it("loads through the partner source and collides once with collect-and-score, which a delay clears", () => {
    const load = readPartnerText("starter-partner.projection.json", readFileSync(FIXTURE, "utf8"));
    expect(load.ok).toBe(true);
    if (!load.ok) return;
    const entry: PartnerEntry = {
      id: "partner1",
      fileName: load.fileName,
      projection: load.projection,
      label: partnerLabel(load.projection, load.fileName),
      colour: 0,
      visible: true,
      offsetS: 0,
    };
    expect(entry.label).toBe("Starter partner");
    const planned = starterPlan("collect-and-score");
    const own = ownRobotFor(planned);
    if (!own.ok) throw new Error(own.reason);
    const result = computeAlliance(own.robot, [entry], 0, allianceFrameFor(planned));
    const collisions = result.findings.filter((item) => item.finding.code === "ALLIANCE_COLLISION");
    expect(collisions).toHaveLength(1);
    expect(collisions[0]?.finding.stepId).toBe("driveOut");
    expect(result.findings.some((item) => item.finding.code === "ALLIANCE_START_OVERLAP")).toBe(false);
    expect(result.clearingOffset?.offsetS).toBeGreaterThan(0);
    const delayed = computeAlliance(own.robot, [entry], result.clearingOffset?.offsetS ?? 0, allianceFrameFor(planned));
    expect(delayed.findings.some((item) => item.finding.code === "ALLIANCE_COLLISION")).toBe(false);
  });
});
