import {
  formatIssue,
  proposalSchema,
  SCHEMA_ID,
  type Projection,
  type ProjectionStructure,
  type Proposal,
  type ProposalChange,
  type ShareRef,
} from "@horizon36596/zenith-schema";
import { OPAQUE_NAMING, previewChanges, structureHashOf, tokenFindings, type Naming, type Preview } from "./structure.js";
import type { ProposalFinding, ShareStatus } from "./types.js";

/**
 * `validateProposal`: whether a proposal can be sent to, or taken by, the team that owns a shared
 * auto, under the limits of spec 13 section 14. Every refusal is a
 * finding whose message is a sentence saying why, so the proposer's app, the CLI and an agent all
 * say the same thing.
 */

export interface ValidateProposalOptions {
  /** The state of the share, which the caller knows and no file does. Live when not given. */
  share?: ShareStatus;
  /** The share the proposal must name, when the caller knows it. */
  shareRef?: ShareRef;
}

/** The structure hash of a projection (see `structureHashOf`). */
export function structureHash(projection: Projection): string {
  return structureHashOf(projection.structure);
}

/** Thrown by `newProposal` when the changes it is given are not a proposal. */
export class ProposalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProposalError";
  }
}

/**
 * A proposal file for these changes against this projection, with the projection's structure hash
 * as its base, checked against the proposal schema. It does not check that the changes fit the
 * share; `validateProposal` does.
 */
export function newProposal(projection: Projection, shareRef: ShareRef, changes: readonly ProposalChange[]): Proposal {
  const candidate = {
    $schema: SCHEMA_ID.proposal,
    formatVersion: 1,
    kind: "proposal",
    shareRef: { shareId: shareRef.shareId, revision: shareRef.revision },
    baseStructureHash: structureHash(projection),
    changes: [...changes],
  };
  const parsed = proposalSchema.safeParse(candidate);
  if (!parsed.success) throw new ProposalError(`These changes are not a proposal:\n  ${parsed.error.issues.map(formatIssue).join("\n  ")}`);
  return parsed.data;
}

const WHOLE = "(proposal)";

/** Reads a proposal strictly, or says in one sentence why the file is refused. */
export function readProposal(json: unknown): { proposal: Proposal; findings: [] } | { proposal: null; findings: ProposalFinding[] } {
  const parsed = proposalSchema.safeParse(json);
  if (parsed.success) return { proposal: parsed.data, findings: [] };
  const issues = parsed.error.issues.slice(0, 5).map(formatIssue);
  const more = parsed.error.issues.length > 5 ? ` and ${String(parsed.error.issues.length - 5)} more` : "";
  return {
    proposal: null,
    findings: [
      {
        severity: "error",
        stepId: WHOLE,
        code: "SCHEMA",
        message: `This file is not a proposal Zenith can read, so it is refused: ${issues.join("; ")}${more}.`,
      },
    ],
  };
}

/**
 * The reasons a whole proposal is refused before any change is looked at: the share is not live,
 * it is view only, the proposal names another share, or it was made against another structure.
 */
export function refusalsOf(
  proposal: Proposal,
  level: "view" | "propose",
  structure: ProjectionStructure | undefined,
  options: ValidateProposalOptions,
): ProposalFinding[] {
  const refuse = (code: ProposalFinding["code"], message: string): ProposalFinding => ({ severity: "error", stepId: WHOLE, code, message });
  const findings: ProposalFinding[] = [];
  if (options.share === "revoked") findings.push(refuse("PROPOSAL_SHARE", "This share has been revoked, so it takes no proposals."));
  if (options.share === "expired") {
    findings.push(refuse("PROPOSAL_SHARE", "This share has expired, so it takes no proposals; ask the team that shared it for more time."));
  }
  if (level !== "propose" || structure === undefined) {
    findings.push(refuse("PROPOSAL_SHARE", "This share is view only, so it takes no proposals; only a propose-level share to a specific team does."));
    return findings;
  }
  const expected = options.shareRef;
  if (expected !== undefined && (expected.shareId !== proposal.shareRef.shareId || expected.revision !== proposal.shareRef.revision)) {
    findings.push(
      refuse(
        "PROPOSAL_STALE",
        `This proposal was made for share ${proposal.shareRef.shareId} at revision ${String(proposal.shareRef.revision)}, not share ${expected.shareId} at revision ${String(expected.revision)}.`,
      ),
    );
  }
  const actual = structureHashOf(structure);
  if (proposal.baseStructureHash !== actual) {
    findings.push(
      refuse(
        "PROPOSAL_STALE",
        `This proposal was made against the structure ${proposal.baseStructureHash}, but the share's structure is ${actual}, so the shared auto has changed since; make the proposal again against the share as it is now.`,
      ),
    );
  }
  return findings;
}

/** The findings of each change against the share's structure, and the structure they leave. */
export function checkChanges(
  structure: ProjectionStructure,
  proposal: Proposal,
  indexes: readonly number[],
  naming: Naming,
): { preview: Preview; findings: ProposalFinding[] } {
  const preview = previewChanges(structure, proposal.changes, indexes, naming);
  const findings = [...preview.failures.values(), ...tokenFindings(structure, proposal.changes, indexes, preview, naming)];
  findings.sort((a, b) => (a.changeIndex ?? -1) - (b.changeIndex ?? -1));
  return { preview, findings };
}

/**
 * Every reason this proposal cannot be sent against this projection, as findings; none means it
 * can. A file that is not a proposal, a view projection, a share said to be revoked or expired, or
 * a structure hash that does not match refuses the whole proposal, and then its changes are not
 * looked at. Otherwise each change is checked in order against the structure the changes before it
 * leave: its step must be there and of a kind that takes it (only path and wait steps can be
 * removed, and never a group's deadline), and every token it places must be one the share held
 * and must end up held once. Pure.
 */
export function validateProposal(proposal: unknown, projection: Projection, options: ValidateProposalOptions = {}): ProposalFinding[] {
  const read = readProposal(proposal);
  if (read.proposal === null) return read.findings;
  const refusals = refusalsOf(read.proposal, projection.level, projection.structure, options);
  if (refusals.length > 0 || projection.structure === undefined) return refusals;
  return checkChanges(projection.structure, read.proposal, read.proposal.changes.map((_, index) => index), OPAQUE_NAMING).findings;
}
