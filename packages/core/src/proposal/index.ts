/**
 * Proposals (spec 13 section 14, M-C6): the changes a team proposes to an
 * auto another team shared with it at the propose level. The proposer validates and previews them
 * against the projection it holds; the owner maps them back to the real auto from the pinned
 * revision, sees which conflict with changes made since, and makes the ones it accepts through the
 * edit primitives. Pure, like the rest of core.
 */
export * from "./types.js";
export { structureHashOf, type Naming } from "./structure.js";
export { describeChange } from "./describe.js";
export { newProposal, ProposalError, readProposal, structureHash, validateProposal, type ValidateProposalOptions } from "./validate.js";
export { applyProposalToStructure } from "./preview.js";
export { applyProposalToAuto, diffProposal, type ApplyProposalOptions, type ApplyProposalResult, type ProposalDiff } from "./apply.js";
