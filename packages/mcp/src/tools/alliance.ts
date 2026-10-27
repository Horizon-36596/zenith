import { basename } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { allianceRobotFromProjection, loadAuto } from "@horizon36596/zenith-core";
import { allianceReport } from "@horizon36596/zenith-cli/lib";
import { parseProjection } from "@horizon36596/zenith-schema";
import { z } from "zod";
import { loadAutoAndPlan } from "../findings.js";
import { confinePath, readJsonFile, relativeToRoot, resolveAutoPath, resolveProject } from "../project.js";
import { guarded, jsonResult } from "../result.js";
import { autoRefField, projectField } from "../schemas.js";

/**
 * `zenith.alliance`: the alliance checks of spec 13 section 9, through the
 * CLI's `allianceReport`, so it returns exactly what `zenith alliance --json` prints for the same files.
 */
export function registerAllianceTools(server: McpServer): void {
  server.registerTool(
    "zenith.alliance",
    {
      title: "Compare an auto with alliance partners",
      description:
        "Runs the auto through the instant sim and compares it, on a 0.1 s grid, with each partner's " +
        "shared projection file (kind \"projection\"), mirroring a partner written for the other " +
        "alliance. Returns the predicted alliance findings: ALLIANCE_COLLISION and " +
        "ALLIANCE_START_OVERLAP (errors), ALLIANCE_NEAR_MISS, ALLIANCE_ELEMENT_CONFLICT and " +
        "ALLIANCE_ENVELOPE (warnings), each with timeS in seconds, plus the two fixes the editor offers. " +
        "`clearingOffsets` gives, for each of ALLIANCE_COLLISION, ALLIANCE_NEAR_MISS and ALLIANCE_ENVELOPE " +
        "found, the smallest start delay for this auto, in 0.1 s steps up to 10 s, that clears every finding " +
        "of that code without a collision (null when none does); `clearingOffset` is its collision entry. " +
        "`clearingWaits` gives, for each of those findings by its index in `findings`, the smallest wait " +
        "step to insert before `wait.stepId` that does the same (`wait` null when none does or the finding " +
        "names no step); zenith.edit.addStep with a wait step makes it real. " +
        "The same result `zenith alliance --json` prints. These findings are " +
        "never part of zenith.validate and block nothing: use them to agree timing with a partner.",
      inputSchema: {
        auto: autoRefField,
        projections: z
          .array(z.string().min(1))
          .min(1)
          .describe("Partner projection files: paths relative to the project root, or absolute (inside it)."),
        offsetS: z
          .number()
          .min(0)
          .optional()
          .describe("Seconds this auto's robot waits at its start pose before it begins. Default 0."),
        project: projectField,
      },
    },
    guarded(({ auto, projections, offsetS, project }) => {
      const proj = resolveProject(project);
      const autoPath = resolveAutoPath(proj, auto);
      const parsed = loadAuto(readJsonFile(autoPath));
      const { plan, field } = loadAutoAndPlan(parsed, proj);

      const partners = projections.map((file) => {
        const path = confinePath(proj.root, file);
        let projection;
        try {
          projection = parseProjection(readJsonFile(path));
        } catch (error) {
          throw new Error(`${file}: ${error instanceof Error ? error.message : String(error)}`);
        }
        const label = projection.title ?? basename(path).replace(/\.json$/i, "").replace(/\.projection$/i, "");
        return { path: relativeToRoot(proj, path), robot: allianceRobotFromProjection(projection, label) };
      });

      const report = allianceReport(plan, field, partners, offsetS ?? 0, proj.waypoints);
      return jsonResult({ auto: relativeToRoot(proj, autoPath), alliance: parsed.alliance, ...report });
    }),
  );
}
