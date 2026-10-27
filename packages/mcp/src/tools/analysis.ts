import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  diff,
  estimate,
  hasErrors,
  ledger,
  loadAuto,
  render,
  runOptimize,
  type OptimizeOptions,
} from "@horizon36596/zenith-core";
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

/** `zenith.estimate`, `zenith.render`, `zenith.diff`, `zenith.sim`, `zenith.optimize`. */
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

  server.registerTool(
    "zenith.optimize",
    {
      title: "Find a faster route for one path step",
      description:
        "Runs Optimize path on the path step stepId and returns the OptimizeResult. It never writes: " +
        "the file is left as it was. It looks for a faster route between the step's own two ends, which it " +
        "keeps exactly, and changes the geometry and the heading profile together; it keeps clear of the " +
        "structures by marginIn (default: the robot's clearance, 1 in when robot.json gives none), and never " +
        "touches a wall or a keep-out that applies in auto. When zenith.validate finds the step as written going through " +
        "a structure, past the wall, into a keep-out or over the centre line (STRUCTURE, PERIMETER, KEEPOUT or " +
        "OPPONENT_SIDE on it), originalBlocked says what it goes through and " +
        "pick is the fastest clear route found even when it is slower (its gainS is then negative); with no clear " +
        "route the status is infeasible, never noBetter. Any other step is improved or noBetter: a route must be faster " +
        "and come no closer to anything than the step does. status is improved, noBetter, infeasible or " +
        "stoppedEarly. pick (and step, the same route as a full path step) is the route it found, with the " +
        "time before and after under the instant sim (t1) and the estimate (t0), the markers that move on the " +
        "field, and the findings it adds and removes; alternatives are up to two other routes that passed " +
        "the final check, which may be labelled \"Faster in the instant sim, slower in the estimate\" or \"Faster in the estimate, slower in the instant sim\" " +
        "(never the pick); holdStartHeadingIn and holdEndHeadingIn keep the start heading over the first, and the end heading " +
        "over the last, so many inches of the route, and when the step as written does not, originalBreaksHolds says so and pick is " +
        "the fastest route found that does, even a slower one; " +
        "changes and notes are plain sentences to show a person. To apply the pick, pass step.segments and " +
        "step.heading to zenith.edit.setRoute. The search runs its whole budget, a count of evaluations " +
        "and not a time, so the same inputs and options give the same result on one JavaScript engine.",
      inputSchema: {
        auto: autoRefField,
        stepId: z.string().min(1).describe("The id of a path step, at any depth, as shown by zenith.auto.read or a Finding."),
        marginIn: z
          .number()
          .min(0)
          .max(6)
          .optional()
          .describe("The safety margin to structures for this run, in inches (0 to 6). Omit to use the robot's clearance. It is never saved."),
        budget: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("How many candidates the search may score: a count, not a time. Omit for the default, set by the bench."),
        scorer: z
          .enum(["sim", "estimate"])
          .optional()
          .describe('"sim" (the default) scores with the instant sim; "estimate" scores with the estimate.'),
        mode: z
          .enum(["routeAndHeading", "headingOnly", "routeOnly"])
          .optional()
          .describe(
            "routeAndHeading (the default) changes the geometry and the heading together; headingOnly keeps the segments as written; routeOnly keeps the heading as written.",
          ),
        allowSplit: z.boolean().optional().describe("False keeps the route to one path. Default true."),
        allowRanges: z.boolean().optional().describe("False keeps the heading to one mode, never piecewise ranges. Default true."),
        maxPaths: z.number().int().positive().optional().describe("The most paths a route may have. Default 4."),
        holdStartHeadingIn: z
          .number()
          .min(0)
          .optional()
          .describe("Hold the heading the robot starts with over the first this many inches of the route. Default 0, off."),
        holdEndHeadingIn: z
          .number()
          .min(0)
          .optional()
          .describe("Reach the step's end heading this many inches before its end and hold it there. Default 0, off."),
        project: projectField,
      },
      annotations: { readOnlyHint: true },
    },
    guarded(({ auto, stepId, marginIn, budget, scorer, mode, allowSplit, allowRanges, maxPaths, holdStartHeadingIn, holdEndHeadingIn, project }) => {
      const proj = resolveProject(project);
      const parsed = loadAuto(readJsonFile(resolveAutoPath(proj, auto)));
      const { robot, field, findings } = loadAutoAndPlan(parsed, proj);
      // A broken robot or field override, or an invalid auto name, falls back to the project's file
      // with a SCHEMA finding. Searching against the wrong robot would give a route for nothing the
      // robot runs, so it stops here, saying why.
      const schema = findings.find((finding) => finding.code === "SCHEMA" && finding.severity === "error");
      if (schema !== undefined) throw new Error(`zenith.optimize cannot run: ${schema.message}`);
      const options: OptimizeOptions = {
        ...(marginIn === undefined ? {} : { marginIn }),
        ...(budget === undefined ? {} : { budget }),
        ...(scorer === undefined ? {} : { scorer }),
        ...(mode === undefined ? {} : { mode }),
        ...(allowSplit === undefined ? {} : { allowSplit }),
        ...(allowRanges === undefined ? {} : { allowRanges }),
        ...(maxPaths === undefined ? {} : { maxPaths }),
        ...(holdStartHeadingIn === undefined || holdStartHeadingIn === 0 ? {} : { holdStartHeadingIn }),
        ...(holdEndHeadingIn === undefined || holdEndHeadingIn === 0 ? {} : { holdEndHeadingIn }),
      };
      const result = runOptimize(
        { auto: parsed, robot, field, waypoints: proj.waypoints, season: resolveSeason(field).rules, stepId },
        options,
      );
      return jsonResult(result);
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
