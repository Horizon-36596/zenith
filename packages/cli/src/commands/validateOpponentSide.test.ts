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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runValidate } from "./validate.js";

/**
 * OPPONENT_SIDE (issue #365, G402): `zenith validate` reports the same error the editor does for one
 * file, and exits non-zero on it. The editor runs `check()` with the real estimate and the season's
 * rules (`apps/web/src/state/derived.ts`), so that is the comparison. The MCP server's half is
 * `packages/mcp/src/opponentSide.test.ts`.
 */
const STARTER = fileURLToPath(new URL("../../../../examples/starter/", import.meta.url));
const AUTO = "autos/over-the-line.auto.json";

/** From the starter's start, north-east to where the robot's right side is 3 in past the centre line. */
const OVER_THE_LINE = {
  $schema: "https://libraries.horizon36596.org/zenith/schema/v1/auto.json",
  formatVersion: 4,
  name: "over-the-line",
  robot: "autos/robot.json",
  field: "autos/field/biobuzz.field.json",
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
};

const readFrom = (root: string, relative: string): unknown => JSON.parse(readFileSync(join(root, relative), "utf8"));

function editorFindings(root: string): Finding[] {
  const robot = loadRobot(readFrom(root, "autos/robot.json"));
  const field = loadField(readFrom(root, "autos/field/biobuzz.field.json"));
  const waypoints = loadWaypoints(readFrom(root, "autos/waypoints.json"));
  const planned = plan(resolve(loadAuto(readFrom(root, AUTO)), waypoints, robot), robot, field);
  return check(planned, estimate(planned, robot), robot, field, resolveSeason(field).rules).filter(
    (finding) => finding.code === "OPPONENT_SIDE",
  );
}

function cliFindings(root: string): { exitCode: number; findings: Finding[] } {
  const out: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    out.push(String(chunk));
    return true;
  });
  let exitCode: number;
  try {
    exitCode = runValidate([join(root, AUTO)], { json: true, project: root });
  } finally {
    spy.mockRestore();
  }
  const parsed = JSON.parse(out.join("")) as { files: { findings: Finding[] }[] };
  return { exitCode, findings: (parsed.files[0]?.findings ?? []).filter((finding) => finding.code === "OPPONENT_SIDE") };
}

const summary = (finding: Finding) => ({
  severity: finding.severity,
  stepId: finding.stepId,
  t: finding.t,
  message: finding.message,
  penetrationIn: finding.geometry?.penetrationIn,
});

let temp = "";
beforeEach(() => {
  temp = mkdtempSync(join(tmpdir(), "zenith-opponent-side-"));
  cpSync(STARTER, temp, { recursive: true });
  writeFileSync(join(temp, AUTO), canonicalize("auto", loadAuto(OVER_THE_LINE)));
});
afterEach(() => {
  rmSync(temp, { recursive: true, force: true });
});

describe("OPPONENT_SIDE: zenith validate and the editor agree about one file", () => {
  it("reports the same error, and validate exits 1 on it", () => {
    const editor = editorFindings(temp);
    expect(editor.map(summary)).toHaveLength(1);
    expect(editor[0]?.severity).toBe("error");
    expect(editor[0]?.message).toContain("3.00 in over");
    expect(editor[0]?.message).toContain("G402");
    const cli = cliFindings(temp);
    expect(cli.findings.map(summary)).toEqual(editor.map(summary));
    expect(cli.exitCode).toBe(1);
  });
});
