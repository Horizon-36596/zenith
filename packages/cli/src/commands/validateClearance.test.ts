import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalize,
  check,
  estimate,
  loadAuto,
  loadField,
  loadRobot,
  loadWaypoints,
  plan,
  resolve,
  type Finding,
} from "@horizon36596/zenith-core";
import { resolveSeason } from "@horizon36596/zenith-seasons";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runValidate } from "./validate.js";

/**
 * Owner ruling D8: the clearance is per robot, in robot.json, and no per-person setting changes it,
 * so `zenith validate` and the editor report the same CLEARANCE findings for one file. The editor
 * runs `check()` with the real estimate and the season's rules (`apps/web/src/state/derived.ts`);
 * `apps/web/src/state/clearanceParity.test.ts` pins the same two findings from `derive()` itself.
 *
 * The fixture is the starter's toGarden as it was before issue #365, from the scoring spot north of
 * the hive on x = -9 south under the hive, between the hive frame's legs: it passes within the
 * robot's clearance of both west legs without touching either. The starter itself now goes round
 * the west of the frame, because that route also crosses the centre line, and has no CLEARANCE.
 */
const STARTER = fileURLToPath(new URL("../../../../examples/starter/", import.meta.url));
const AUTO = "autos/near-the-legs.auto.json";

/** The starter's toGarden as it was before issue #365, alone, from the scoring spot north of the hive on x = -9. */
const NEAR_THE_LEGS = {
  $schema: "https://libraries.horizon36596.org/zenith/schema/v1/auto.json",
  formatVersion: 4,
  name: "near-the-legs",
  robot: "autos/robot.json",
  field: "autos/field/biobuzz.field.json",
  alliance: "RED",
  start: { pose: { xIn: -9, yIn: 36, headingRad: -1.5708, provenance: "SET BY HAND: test fixture" } },
  steps: [
    {
      id: "toGarden",
      kind: "path",
      segments: [
        {
          kind: "bezier",
          from: "current",
          control: [
            { xIn: -5, yIn: -56, provenance: "SET BY HAND: test fixture" },
            { xIn: -16, yIn: -62, provenance: "SET BY HAND: test fixture" },
          ],
          to: { ref: "gardenSweepStart" },
        },
      ],
      heading: { mode: "tangent" },
    },
  ],
};

/** The starter's own collect-and-score, as it ships. */
const SHIPPED = "autos/collect-and-score.auto.json";

const readFrom = (root: string, relative: string): unknown => JSON.parse(readFileSync(join(root, relative), "utf8"));

/** Core's CLEARANCE findings for `auto` in the project at `root`, computed the editor's way. */
function editorClearance(root: string, auto = AUTO): Finding[] {
  const robot = loadRobot(readFrom(root, "autos/robot.json"));
  const field = loadField(readFrom(root, "autos/field/biobuzz.field.json"));
  const waypoints = loadWaypoints(readFrom(root, "autos/waypoints.json"));
  const planned = plan(resolve(loadAuto(readFrom(root, auto)), waypoints, robot), robot, field);
  return check(planned, estimate(planned, robot), robot, field, resolveSeason(field).rules).filter(
    (finding) => finding.code === "CLEARANCE",
  );
}

/** What `zenith validate --json` reports as CLEARANCE for `auto` in the project at `root`. */
function cliClearance(root: string, auto = AUTO): Finding[] {
  const out: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    out.push(String(chunk));
    return true;
  });
  try {
    runValidate([join(root, auto)], { json: true, project: root });
  } finally {
    spy.mockRestore();
  }
  const parsed = JSON.parse(out.join("")) as { files: { findings: Finding[] }[] };
  return (parsed.files[0]?.findings ?? []).filter((finding) => finding.code === "CLEARANCE");
}

/** The parts of a finding both paths must agree on. */
const summary = (finding: Finding) => ({
  severity: finding.severity,
  stepId: finding.stepId,
  obstacleId: finding.geometry?.obstacleId,
  message: finding.message,
});

let temp: string | null = null;
afterEach(() => {
  if (temp !== null) rmSync(temp, { recursive: true, force: true });
  temp = null;
});

/** A copy of the starter project with the fixture auto in it. */
function project(): string {
  const root = mkdtempSync(join(tmpdir(), "zenith-clearance-"));
  cpSync(STARTER, root, { recursive: true });
  writeFileSync(join(root, AUTO), canonicalize("auto", loadAuto(NEAR_THE_LEGS)));
  return root;
}

describe("CLEARANCE: zenith validate and the editor agree about one file (D8)", () => {
  it("reports the same CLEARANCE findings for a route between the hive frame's legs", () => {
    temp = project();
    const editor = editorClearance(temp);
    // The same messages, word for word, as clearanceParity.test.ts pins for the editor's derive().
    expect(editor.map(summary)).toEqual([
      {
        severity: "warning",
        stepId: "toGarden",
        obstacleId: "frameLegNorthWest",
        message:
          "The robot passes 0.69 in from the north-west leg of the hive frame (frameLegNorthWest) at t 0.21, within 1 in (Zenith's default; set it in Settings, Robot).",
      },
      {
        severity: "warning",
        stepId: "toGarden",
        obstacleId: "frameLegSouthWest",
        message:
          "The robot passes 0.47 in from the south-west leg of the hive frame (frameLegSouthWest) at t 0.38, within 1 in (Zenith's default; set it in Settings, Robot).",
      },
    ]);
    expect(cliClearance(temp).map(summary)).toEqual(editor.map(summary));
  });

  it("finds none on the shipped starter, whose toGarden goes around the hive frame", () => {
    expect(editorClearance(STARTER, SHIPPED)).toEqual([]);
    expect(cliClearance(STARTER, SHIPPED)).toEqual([]);
  });

  it("follows footprint.clearanceIn in robot.json, the same on both paths", () => {
    temp = project();
    const robotPath = join(temp, "autos/robot.json");
    const robot = loadRobot(JSON.parse(readFileSync(robotPath, "utf8")) as unknown);
    const withClearance = {
      ...robot,
      footprint: { ...robot.footprint, clearanceIn: { value: 0.5, provenance: "SET BY HAND: test fixture" } },
    };
    writeFileSync(robotPath, canonicalize("robot", withClearance));

    const editor = editorClearance(temp);
    // 0.47 in from the south-west leg is inside 0.5 in; 0.69 in from the north-west one is not.
    expect(editor.map((finding) => finding.geometry?.obstacleId)).toEqual(["frameLegSouthWest"]);
    expect(editor[0]?.message).toContain("within 0.5 in (robot.json, SET BY HAND)");
    expect(cliClearance(temp).map(summary)).toEqual(editor.map(summary));
  });
});
