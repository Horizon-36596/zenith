/**
 * Everything the proposer's editor shows, computed from the share, the changes so far and the
 * proposer's own files (spec 13 section 14):
 *
 * - the proposal file itself (`newProposal`), and the reason when the changes are not one yet;
 * - the preview structure and the findings, from core's `applyProposalToStructure`, which are
 *   exactly the findings `validateProposal` gives and the owner's app will give;
 * - the synthetic auto and robot for the canvas (`synthetic.ts`), for the share as it is (drawn
 *   ghosted) and for the proposal;
 * - the proposed version as a timed partner robot (`timing.ts`), and the predicted alliance
 *   findings of the proposer's own robot against it.
 *
 * Pure: no DOM, no clock, no store. The store memoises it on the identity of its inputs.
 */
import {
  allianceRobotFromProjection,
  applyProposalToStructure,
  checkAlliance,
  describeChange,
  mirrorAllianceRobot,
  newProposal,
  simulate,
  type AllianceRobot,
  type ClaimPlace,
  type Finding,
  type MirrorIds,
  type MirrorMode,
  type Naming,
  type ProposalFinding,
  type Trace,
} from "@horizon36596/zenith-core";
import type {
  Field,
  Projection,
  ProjectionStructure,
  Proposal,
  ProposalChange,
  Robot,
  ShareRef,
} from "@horizon36596/zenith-schema";
import { derive, type Derived } from "../state/derived";
import { proposedEnvelopes, type DraftContext } from "./draft";
import { linkedStarts, structureToAuto, syntheticRobot } from "./synthetic";
import { previewPartnerRobot, type PreviewRobot } from "./timing";

/** The proposer's names for things: the opaque ones, which are the only ones it has. */
export const PROPOSER_NAMING: Naming = { step: (id) => id, stepId: (id) => id, token: (token) => token };

export interface ProposerInputs {
  projection: Projection;
  shareRef: ShareRef;
  changes: readonly ProposalChange[];
  /** The proposer's own robot file, whose drive limits time the partner's routine. */
  template: Robot;
  field: Field;
  /** How the partner is named in the alliance findings. */
  label: string;
}

/** One change as the change list shows it. */
export interface ChangeRow {
  index: number;
  change: ProposalChange;
  /** Core's one sentence for it, in the share's opaque names. */
  summary: string;
  /** Why it does not fit the share, when it does not. */
  finding: ProposalFinding | null;
}

export interface ProposerModel {
  proposal: Proposal | null;
  /** Why the changes are not a proposal file yet, when they are not. */
  proposalError: string | null;
  base: ProjectionStructure;
  preview: ProjectionStructure;
  context: DraftContext;
  /** Every finding about the proposal: empty means the owner's app will take it. */
  findings: ProposalFinding[];
  rows: ChangeRow[];
  robot: Robot;
  /** The share as it is, for the ghost. */
  baseDerived: Derived;
  /** The proposal, for the canvas. */
  derived: Derived;
  baseTrace: Trace | null;
  partner: PreviewRobot;
  /** The partner as it shared its auto: what the alliance view showed before any change. */
  sharedRobot: AllianceRobot;
}

interface SharedEntry {
  robot: Robot;
  derived: Derived;
  linked: Set<string>;
  trace: Trace | null;
  /** The shared trajectory as an alliance robot, by the label it is named with. */
  sharedRobot: Map<string, AllianceRobot>;
}

const baseCache = new WeakMap<Projection, WeakMap<Robot, SharedEntry>>();

function rememberShared(cache: Map<string, AllianceRobot>, projection: Projection, label: string): AllianceRobot {
  const robot = allianceRobotFromProjection(projection, label);
  cache.set(label, robot);
  return robot;
}

function simulateSafely(derived: Derived): Trace | null {
  const planned = derived.plan;
  if (planned === null) return null;
  try {
    return simulate(planned, planned.robot, planned.field);
  } catch {
    return null;
  }
}

/** The share as it is, drawn and simulated once per projection and robot template. */
function baseOf(projection: Projection, template: Robot, field: Field) {
  let byTemplate = baseCache.get(projection);
  if (byTemplate === undefined) {
    byTemplate = new WeakMap();
    baseCache.set(projection, byTemplate);
  }
  const hit = byTemplate.get(template);
  if (hit !== undefined && hit.derived.plan?.field === field) return hit;
  const structure = projection.structure ?? { steps: [] };
  const robot = syntheticRobot(template, projection);
  const linked = linkedStarts(structure, projection.startPose);
  const auto = structureToAuto(structure, projection, { linked });
  const derived = derive(auto, robot, field, undefined);
  const entry: SharedEntry = { robot, derived, linked, trace: simulateSafely(derived), sharedRobot: new Map() };
  byTemplate.set(template, entry);
  return entry;
}

/** The proposer's model for these inputs. */
export function buildProposerModel(inputs: ProposerInputs): ProposerModel {
  const { projection, shareRef, changes, template, field, label } = inputs;
  const base = projection.structure ?? { steps: [] };
  const shared = baseOf(projection, template, field);

  let proposal: Proposal | null = null;
  let proposalError: string | null = null;
  try {
    proposal = newProposal(projection, shareRef, changes);
  } catch (error) {
    proposalError = error instanceof Error ? error.message : String(error);
  }

  const previewed =
    proposal === null
      ? { structure: base, findings: [] as ProposalFinding[], addedIds: new Map<number, string>() }
      : applyProposalToStructure(projection, proposal);
  const context: DraftContext = { base, addedIds: previewed.addedIds };
  const envelopes = proposedEnvelopes(changes);
  const auto = structureToAuto(previewed.structure, projection, { linked: shared.linked, base, envelopes });
  const derived = derive(auto, shared.robot, field, undefined);
  const trace = changes.length === 0 ? shared.trace : simulateSafely(derived);

  const partner = previewPartnerRobot({
    projection,
    basePlan: shared.derived.plan,
    proposedPlan: derived.plan,
    changed: changes.length > 0,
    label,
    proposedEnvelopes: envelopes,
    ...(shared.trace === null ? {} : { baseTrace: shared.trace }),
    ...(trace === null ? {} : { proposedTrace: trace }),
  });

  const byIndex = new Map<number, ProposalFinding>();
  for (const finding of previewed.findings) {
    if (finding.changeIndex !== undefined && !byIndex.has(finding.changeIndex)) byIndex.set(finding.changeIndex, finding);
  }
  const rows: ChangeRow[] = changes.map((change, index) => ({
    index,
    change,
    summary: describeChange(change, PROPOSER_NAMING),
    finding: byIndex.get(index) ?? null,
  }));

  return {
    proposal,
    proposalError,
    base,
    preview: previewed.structure,
    context,
    findings: previewed.findings,
    rows,
    robot: shared.robot,
    baseDerived: shared.derived,
    derived,
    baseTrace: shared.trace,
    partner,
    sharedRobot: shared.sharedRobot.get(label) ?? rememberShared(shared.sharedRobot, projection, label),
  };
}

/** How the proposer's own robot and the partner are put on one alliance for the checks. */
export interface PreviewFrame {
  /** The proposer's own alliance. */
  ownAlliance: "RED" | "BLUE";
  mirror: MirrorMode;
  /** The season's `mirrorId` hook, to rename a mirrored partner's claimed elements. */
  mirrorId?: MirrorIds;
  /** The season's `claimPlace` hook, bound to the field, so an element conflict compares places. */
  claimPlace?: ClaimPlace;
}

/**
 * The preview frame for the proposer's own alliance, with the field's mirror and the season's hooks
 * from the alliance view's frame for their open plan (`allianceFrameFor`), so the preview and the
 * alliance view compare the same claims. Without a plan nothing is mirrored and no hook applies.
 */
export function previewFrameFor(
  ownAlliance: "RED" | "BLUE",
  frame: Pick<PreviewFrame, "mirror" | "mirrorId" | "claimPlace"> | null,
): PreviewFrame {
  if (frame === null) return { ownAlliance, mirror: "none" };
  return {
    ownAlliance,
    mirror: frame.mirror,
    ...(frame.mirrorId === undefined ? {} : { mirrorId: frame.mirrorId }),
    ...(frame.claimPlace === undefined ? {} : { claimPlace: frame.claimPlace }),
  };
}

/** The partner's robot on the proposer's alliance, mirrored when the share was written for the other. */
export function alignPartner(robot: AllianceRobot, frame: PreviewFrame): AllianceRobot {
  if (robot.alliance === undefined || robot.alliance === frame.ownAlliance) return robot;
  return mirrorAllianceRobot(robot, frame.mirror, frame.mirrorId);
}

/**
 * The predicted alliance findings of the proposer's own robot against the proposed partner, with
 * the same offsets and season hooks the alliance view uses. They are predictions and never block
 * anything.
 */
export function previewAllianceFindings(
  own: AllianceRobot,
  partner: AllianceRobot,
  frame: PreviewFrame,
  offsets: { ownS: number; partnerS: number },
): Finding[] {
  return checkAlliance({ ...own, alliance: frame.ownAlliance }, [alignPartner(partner, frame)], {
    ownStartOffsetS: offsets.ownS,
    partnerStartOffsetsS: [offsets.partnerS],
    ...(frame.claimPlace === undefined ? {} : { claimPlace: frame.claimPlace }),
  });
}
