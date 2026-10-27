import { writeFileSync } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  canonicalize,
  check,
  diffProposal,
  estimate,
  loadAuto,
  plan,
  readProposal,
  resolve,
  validateProposal,
  type ProjectShareInput,
} from "@horizon36596/zenith-core";
import { resolveSeason } from "@horizon36596/zenith-seasons";
import { parseProjection } from "@horizon36596/zenith-schema";
import { z } from "zod";
import { errorCount, helpFor, loadAutoAndPlan, warningCount } from "../findings.js";
import { confinePath, readJsonFile, relativeToRoot, resolveAutoPath, resolveProject } from "../project.js";
import { guarded, jsonResult } from "../result.js";
import { autoRefField, projectField } from "../schemas.js";

const shareField = z
  .enum(["live", "revoked", "expired"])
  .optional()
  .describe("The state of the share the proposal was made against, which only the cloud library knows. Default live.");

const fileField = (what: string) =>
  z.string().min(1).describe(`The ${what} file: a path relative to the project root, or absolute (inside it).`);

/**
 * `zenith.proposal.validate` and `zenith.proposal.apply`: the two sides of a proposed change to a
 * shared auto (spec 13 section 14), returning what `zenith proposal
 * validate --json` and `zenith proposal apply --json` print. Apply never writes unless `write` is
 * true, and then only the accepted changes and only when none of them is a conflict or invalid.
 */
export function registerProposalTools(server: McpServer): void {
  server.registerTool(
    "zenith.proposal.validate",
    {
      title: "Check a proposal against a shared projection",
      description:
        "Checks a proposal file (kind \"proposal\") against the propose-level projection file it was made " +
        "from, the proposer's check before sending. Returns `ok` (true when it can be sent) and findings, " +
        "each a sentence saying why: PROPOSAL_SHARE (a view, revoked or expired share), PROPOSAL_STALE " +
        "(made against a different structure; the message names both hashes), PROPOSAL_TOKEN (a command " +
        "or condition token the share did not hold, or one copied rather than moved), PROPOSAL_CHANGE " +
        "(a change its step cannot take, such as removing a command), or SCHEMA (not a proposal at all). " +
        "A proposal names steps by the projection's opaque ids (s1, s2, ...) and can never name, add or " +
        "change a command.",
      inputSchema: {
        proposal: fileField("proposal"),
        projection: fileField("projection"),
        share: shareField,
        project: projectField,
      },
    },
    guarded(({ proposal, projection, share, project }) => {
      const proj = resolveProject(project);
      const proposalPath = confinePath(proj.root, proposal);
      const projectionPath = confinePath(proj.root, projection);
      const proposalJson = readJsonFile(proposalPath);
      let parsed;
      try {
        parsed = parseProjection(readJsonFile(projectionPath));
      } catch (error) {
        throw new Error(`${projection} is not a projection: ${error instanceof Error ? error.message : String(error)}`);
      }
      const findings = validateProposal(proposalJson, parsed, { share: share ?? "live" });
      return jsonResult({
        proposal: relativeToRoot(proj, proposalPath),
        projection: relativeToRoot(proj, projectionPath),
        share: share ?? "live",
        ok: findings.length === 0,
        changes: readProposal(proposalJson).proposal?.changes.length ?? 0,
        findings,
        errors: errorCount(findings),
        help: helpFor(findings),
      });
    }),
  );

  server.registerTool(
    "zenith.proposal.apply",
    {
      title: "Review a proposal against your own auto",
      description:
        "The owner's review of a proposal made against a share of one of this project's autos. Maps the " +
        "proposal's opaque step ids and tokens back through the pinned revision (`base`, or the auto itself " +
        "when it has not changed since the share), and returns every change with its status (applied, " +
        "notAccepted, conflict, invalid or refused), a one-sentence summary and the proposer's comment; the " +
        "proposal findings (a change to a step that has changed since the share is PROPOSAL_CONFLICT and can " +
        "only be rejected); the step-level diff between the auto and the auto with the accepted changes; and " +
        "the validate findings of that result. Nothing is written unless `write` is true, which needs " +
        "`accept` and is refused while an accepted change is a conflict or invalid. Change numbers count " +
        "from 1, as the summaries and sentences name them.",
      inputSchema: {
        auto: autoRefField,
        proposal: fileField("proposal"),
        base: autoRefField
          .optional()
          .describe("The auto as it was at the revision the share is pinned to, when it differs from `auto` now."),
        accept: z
          .union([z.literal("all"), z.array(z.number().int().min(1)).max(200)])
          .optional()
          .describe("The changes to accept: \"all\", or change numbers from 1. Default all for a review; required with write."),
        share: shareField,
        write: z.boolean().optional().describe("Write the auto with the accepted changes in canonical form. Default false."),
        project: projectField,
      },
    },
    guarded(({ auto, proposal, base, accept, share, write, project }) => {
      if (write === true && accept === undefined) {
        throw new Error("write needs accept, naming the changes to accept (\"all\", or change numbers from 1).");
      }
      const proj = resolveProject(project);
      const autoPath = resolveAutoPath(proj, auto);
      const current = loadAuto(readJsonFile(autoPath));
      const loaded = loadAutoAndPlan(current, proj);
      const basePath = base === undefined ? autoPath : resolveAutoPath(proj, base);
      const pinnedAuto = base === undefined ? current : loadAuto(readJsonFile(basePath));
      const pinnedLoaded = base === undefined ? loaded : loadAutoAndPlan(pinnedAuto, proj);

      const proposalPath = confinePath(proj.root, proposal);
      const proposalJson = readJsonFile(proposalPath);
      const count = readProposal(proposalJson).proposal?.changes.length ?? 0;
      const accepted = accept === undefined || accept === "all" ? Array.from({ length: count }, (_, index) => index) : [...new Set(accept)].map((number) => number - 1);

      // Only the structure is compared, and it needs no trace, so none is run for the pinned revision.
      const pinned: ProjectShareInput = {
        plan: pinnedLoaded.plan,
        trace: { poses: [], steps: [], simTimeS: 0 },
        robot: pinnedLoaded.robot,
        field: pinnedLoaded.field,
      };
      const review = diffProposal(current, pinned, { level: "propose" }, proposalJson, {
        share: share ?? "live",
        waypoints: proj.waypoints,
        currentPlan: loaded.plan,
        accepted,
      });
      const errors = errorCount(review.findings);
      const proposedPlan = plan(resolve(review.proposed, proj.waypoints, loaded.robot), loaded.robot, loaded.field);
      const validation = check(proposedPlan, estimate(proposedPlan, loaded.robot), loaded.robot, loaded.field, resolveSeason(loaded.field).rules);

      // With no change accepted there is nothing to make, so the file is left exactly as it is.
      let written: string | null = null;
      if (write === true && errors === 0 && accepted.length > 0) {
        writeFileSync(confinePath(proj.root, autoPath), canonicalize("auto", review.proposed), "utf8");
        written = relativeToRoot(proj, autoPath);
      }
      return jsonResult({
        auto: relativeToRoot(proj, autoPath),
        base: relativeToRoot(proj, basePath),
        proposal: relativeToRoot(proj, proposalPath),
        accepted: accepted.map((index) => index + 1),
        changes: review.changes,
        findings: review.findings,
        errors,
        warnings: warningCount(review.findings),
        diff: review.diff,
        validation: { findings: validation, errors: errorCount(validation), warnings: warningCount(validation) },
        written,
        ...(write === true && written === null
          ? {
              notWritten:
                accepted.length === 0
                  ? "Nothing was written, because no change was accepted."
                  : "Nothing was written, because an accepted change is a conflict or invalid; accept only the changes marked applied.",
            }
          : {}),
        proposed: review.proposed,
        help: helpFor([...review.findings, ...validation]),
      });
    }),
  );
}
