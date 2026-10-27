import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { check, estimate, loadAuto, plan, resolve, type Finding } from "@horizon36596/zenith-core";
import { resolveSeason } from "@horizon36596/zenith-seasons";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findingsForAuto, helpFor } from "./findings.js";
import { resolveProject, type Project } from "./project.js";

/**
 * OPPONENT_SIDE (issue #365, G402): `zenith.validate` reports the same error the editor and
 * `zenith validate` do for one file (`packages/cli/src/commands/validateOpponentSide.test.ts` is the
 * CLI's half), with the same plain-language help.
 */
const here = dirname(fileURLToPath(import.meta.url));
const starter = join(here, "..", "..", "..", "examples", "starter");

/** From the starter's start, north-east to where the robot's right side is 3 in past the centre line. */
const overTheLine = () =>
  loadAuto({
    $schema: "https://libraries.horizon36596.org/zenith/schema/v1/auto.json",
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

const summary = (finding: Finding) => ({ severity: finding.severity, stepId: finding.stepId, t: finding.t, message: finding.message });

let temp = "";
let project: Project;
beforeAll(() => {
  temp = mkdtempSync(join(tmpdir(), "zenith-mcp-opponent-side-"));
  cpSync(starter, temp, { recursive: true });
  project = resolveProject(temp);
});
afterAll(() => {
  rmSync(temp, { recursive: true, force: true });
});

describe("OPPONENT_SIDE over MCP", () => {
  it("is the error the editor reports, with the same help", () => {
    const auto = overTheLine();
    const planned = plan(resolve(auto, project.waypoints, project.robot), project.robot, project.field);
    const editor = check(planned, estimate(planned, project.robot), project.robot, project.field, resolveSeason(project.field).rules).filter(
      (finding) => finding.code === "OPPONENT_SIDE",
    );
    expect(editor).toHaveLength(1);
    const { findings } = findingsForAuto(auto, project);
    const mcp = findings.filter((finding) => finding.code === "OPPONENT_SIDE");
    expect(mcp.map(summary)).toEqual(editor.map(summary));
    expect(mcp[0]?.severity).toBe("error");
    expect(helpFor(mcp).OPPONENT_SIDE?.title).toBe("Crosses the centre line");
  });
});
