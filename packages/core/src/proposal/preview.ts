import type { Projection, ProjectionStructure } from "@horizon36596/zenith-schema";
import { OPAQUE_NAMING } from "./structure.js";
import type { ProposalFinding } from "./types.js";
import { checkChanges, readProposal, refusalsOf, type ValidateProposalOptions } from "./validate.js";

/**
 * `applyProposalToStructure`: the proposer's preview. The proposing team only has the projection,
 * so this applies the proposal to a copy of the projection's structure, which is what its alliance
 * view and its editor draw before the proposal is sent.
 *
 * A proposal that is refused as a whole (see `validateProposal`) previews as the share's own
 * structure, or an empty one for a view projection, with the findings that say why. Otherwise
 * every change that fits is made, in order, and every one that does not is left out with its
 * finding, so the proposer sees both the result and what is wrong. New steps are numbered after the
 * share's highest id. The projection is never changed. Pure.
 *
 * `addedIds` names the preview id each step a change added was given, keyed by the change's index,
 * so an editor can tell a step the proposal added from one the share holds.
 */
export function applyProposalToStructure(
  projection: Projection,
  proposal: unknown,
  options: ValidateProposalOptions = {},
): { structure: ProjectionStructure; findings: ProposalFinding[]; addedIds: Map<number, string> } {
  const unchanged = (): ProjectionStructure => JSON.parse(JSON.stringify(projection.structure ?? { steps: [] })) as ProjectionStructure;
  const read = readProposal(proposal);
  if (read.proposal === null) return { structure: unchanged(), findings: read.findings, addedIds: new Map() };
  const refusals = refusalsOf(read.proposal, projection.level, projection.structure, options);
  if (refusals.length > 0 || projection.structure === undefined) return { structure: unchanged(), findings: refusals, addedIds: new Map() };
  const { preview, findings } = checkChanges(
    projection.structure,
    read.proposal,
    read.proposal.changes.map((_, index) => index),
    OPAQUE_NAMING,
  );
  return { structure: preview.structure, findings, addedIds: new Map(preview.addedIds) };
}
