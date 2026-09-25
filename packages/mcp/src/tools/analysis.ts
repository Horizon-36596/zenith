import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { diff, estimate, hasErrors, ledger, loadAuto, render } from "@horizon36596/zenith-core";
import { resolveSeason } from "@horizon36596/zenith-seasons";
import { z } from "zod";
import { errorCount, loadAutoAndPlan } from "../findings.js";
import { confinePath, readJsonFile, relativeToRoot, resolveAutoPath, resolveProject, type Project } from "../project.js";
import { guarded, jsonResult } from "../result.js";
import { runZenithCli } from "../spawnCli.js";
import { autoRefField, projectField } from "../schemas.js";

const outField = z
  .string()
  .min(1)
  .describe("Where to write the render: a path relative to the project root, or absolute (must resolve inside it).");

/** Confined to the project root (finding 2): an `out` an agent supplies is untrusted input, the
 * same as any other tool argument, and `zenith.render` writes there without asking. */
const resolveOut = (project: Project, out: string): string => confinePath(project.root, out);

/** `zenith.estimate`, `zenith.render`, `zenith.diff`, `zenith.sim`. */
export function registerAnalysisTools(server: McpServer): void {
  server.registerTool(
    "zenith.estimate",
    {
      title: "Estimate an auto's timing",
      description:
        "Returns the per-step timing table (nominalS/lowS/highS/strafeFraction) and the total, from " +
        "the estimate's kinematic model. A step whose " +
        "command has estimateS \"unknown\" makes the total a lower bound (hasUnknown: true). Plans " +
        "against the auto's own robot/field override when it has one, the same as zenith.validate, " +
        "and refuses to return a number (estimate: null) when the auto has any error finding — read " +
        "findings and seasonWarnings first, the way zenith estimate's CLI exit code forces a human to.",
      inputSchema: { auto: autoRefField, project: projectField },
    },
    guarded(({ auto, project }) => {
      const proj = resolveProject(project);
      const path = resolveAutoPath(proj, auto);
      const parsed = loadAuto(readJsonFile(path));
      const { plan: planned, robot, findings, seasonWarnings } = loadAutoAndPlan(parsed, proj);
      const blocked = hasErrors(findings);
      return jsonResult({
        estimate: blocked ? null : estimate(planned, robot),
        findings,
        errors: errorCount(findings),
        seasonWarnings,
      });
    }),
  );

  server.registerTool(
    "zenith.render",
    {
      title: "Render an auto to a picture",
      description:
        "Renders the field, path, footprint ghosts and findings to SVG (format \"svg\") or PNG " +
        '(format "png", via the zenith CLI\'s resvg path) and writes it to `out`. Use this to hand a ' +
        "human a picture of what an auto does, or to attach to a pull request body.",
      inputSchema: {
        auto: autoRefField,
        out: outField,
        format: z.enum(["svg", "png"]).default("svg"),
        alliance: z.enum(["RED", "BLUE"]).optional().describe("Defaults to the auto's own alliance."),
        project: projectField,
      },
    },
    guarded(async ({ auto, out, format, alliance, project }) => {
      const proj = resolveProject(project);
      const autoPath = resolveAutoPath(proj, auto);
      const outPath = resolveOut(proj, out);
      mkdirSync(dirname(outPath), { recursive: true });

      if (format === "png") {
        const args = ["render", relativeToRoot(proj, autoPath), "--png", outPath];
        if (alliance !== undefined) args.push("--alliance", alliance);
        const result = await runZenithCli(args, proj.root);
        if (result.code !== 0) {
          throw new Error(
            `zenith render --png failed (exit ${String(result.code)}): ${result.stderr || result.stdout}`,
          );
        }
        return jsonResult({ written: relativeToRoot(proj, outPath), format, stdout: result.stdout });
      }

      const parsed = loadAuto(readJsonFile(autoPath));
      // One plan, from the auto's own robot/field override when it has one, backs the render, the
      // estimate and the findings overlay together — previously this re-planned a second time
      // inside findingsForAuto, which (for an auto with an override) drew the footprint from one
      // robot and the finding overlays from another (finding 24).
      const { plan: planned, robot, field, findings, seasonWarnings } = loadAutoAndPlan(parsed, proj);
      const estimateResult = tryOrNull(() => estimate(planned, robot));
      const ledgerRows = tryOrEmpty(() => ledger(planned, field, resolveSeason(field).rules));
      const svg = render(planned, estimateResult, findings, ledgerRows, { alliance });
      writeFileSync(outPath, svg, "utf8");
      return jsonResult({ written: relativeToRoot(proj, outPath), format, seasonWarnings });
    }),
  );

  server.registerTool(
    "zenith.diff",
    {
      title: "Structurally diff two autos",
      description:
        "Compares two auto files step by step and returns the added/removed/changed/moved steps, " +
        "for a review view or for an agent checking what an edit actually changed.",
      inputSchema: { a: autoRefField, b: autoRefField, project: projectField },
    },
    guarded(({ a, b, project }) => {
      const proj = resolveProject(project);
      const autoA = loadAuto(readJsonFile(resolveAutoPath(proj, a)));
      const autoB = loadAuto(readJsonFile(resolveAutoPath(proj, b)));
      return jsonResult(diff(autoA, autoB));
    }),
  );

  server.registerTool(
    "zenith.sim",
    {
      title: "Run the robot repo's simulator on an auto",
      description:
        "Runs zenith.json's sim command for this auto (via `zenith sim --json`) and returns the " +
        "resulting trace summary: per-step estimate vs. actual. Requires the robot repo's build " +
        "tooling (e.g. Gradle) to be available where the MCP server runs.",
      inputSchema: { auto: autoRefField, project: projectField },
    },
    guarded(async ({ auto, project }) => {
      const proj = resolveProject(project);
      const result = await runZenithCli(["sim", relativeToRoot(proj, resolveAutoPath(proj, auto)), "--json"], proj.root);
      if (result.code !== 0) {
        throw new Error(`zenith sim failed (exit ${String(result.code)}): ${result.stderr || result.stdout}`);
      }
      try {
        return jsonResult(JSON.parse(result.stdout) as unknown);
      } catch {
        return jsonResult({ stdout: result.stdout, stderr: result.stderr });
      }
    }),
  );
}

function tryOrNull<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}

function tryOrEmpty<T>(fn: () => T[]): T[] {
  try {
    return fn();
  } catch {
    return [];
  }
}
