import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { check, estimate, loadAuto, loadField, loadRobot, loadWaypoints, plan, resolve, type Finding } from "@horizon36596/zenith-core";
import { resolveSeason } from "@horizon36596/zenith-seasons";
import { describe, expect, it } from "vitest";
import { derive } from "./derived";

/**
 * OPPONENT_SIDE (issue #365, G402): the editor's `derive()`, its one caller of `check()`, reports the
 * error `zenith validate` and the MCP server report for the same file
 * (`packages/cli/src/commands/validateOpponentSide.test.ts`, `packages/mcp/src/opponentSide.test.ts`).
 */
const repo = fileURLToPath(new URL("../../../../", import.meta.url));
const read = (path: string): unknown => JSON.parse(readFileSync(`${repo}examples/starter/${path}`, "utf8")) as unknown;

const summary = (finding: Finding) => ({ severity: finding.severity, stepId: finding.stepId, t: finding.t, message: finding.message });

describe("the editor's OPPONENT_SIDE findings", () => {
  const robot = loadRobot(read("autos/robot.json"));
  const field = loadField(read("autos/field/biobuzz.field.json"));
  const waypoints = loadWaypoints(read("autos/waypoints.json"));
  // From the starter's start, north-east to where the robot's right side is 3 in past the centre line.
  const auto = loadAuto({
    formatVersion: 4,
    name: "over-the-line",
    alliance: "RED",
    start: { pose: { ref: "start" } },
    steps: [
      {
        id: "overTheLine",
        kind: "path",
        segments: [{ kind: "line", from: { ref: "start" }, to: { xIn: -6, yIn: -36, provenance: "SET BY HAND: test fixture" } }],
        heading: { mode: "constant", headingRad: 1.5708 },
      },
    ],
  });

  it("are the ones check() gives with the season's rules", () => {
    const planned = plan(resolve(auto, waypoints, robot), robot, field);
    const core = check(planned, estimate(planned, robot), robot, field, resolveSeason(field).rules).filter((f) => f.code === "OPPONENT_SIDE");
    const editor = derive(auto, robot, field, waypoints).findings.filter((f) => f.code === "OPPONENT_SIDE");
    expect(core).toHaveLength(1);
    expect(editor.map(summary)).toEqual(core.map(summary));
    // What the canvas draws: the worst pose, its polygons, and the stretch to tint.
    expect(editor[0]?.geometry?.poseIn).toBeDefined();
    expect(editor[0]?.geometry?.tRange).toBeDefined();
  });
});
