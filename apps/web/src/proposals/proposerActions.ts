/**
 * What the proposer's controls do (spec 13 section 14). Every edit goes through a pure helper in
 * `draft.ts` against the current model's context and lands in the proposer's own store; none of
 * them reads or writes the editor's document.
 */
import type { Envelope, Projection, ProjectionHeading, ProjectionMarkerAt, ProposalChange, ShareRef } from "@horizon36596/zenith-schema";
import { shareProposeBlockedReason, type PartnerShare } from "../cloud/partnerShare";
import { getCloud } from "../cloud/store";
import { askUnsaved } from "../app/unsaved";
import { getState, setPlaying, setSelection, setStatus, type State } from "../state/store";
import {
  recordEnvelope,
  recordHeading,
  recordInsertWait,
  recordMarker,
  recordMovePose,
  recordRemove,
  recordReorder,
  recordSpeed,
  recordTimeout,
  recordWaitSeconds,
  removeChange,
  setComment,
  type DraftPoint,
} from "./draft";
import { buildProposerModel, type ProposerModel } from "./proposerModel";
import {
  defaultShareId,
  endProposerSession,
  getProposerSession,
  setChanges,
  startProposerSession,
  type ProposerSession,
} from "./proposerStore";
import { downloadSink, proposalFileName, sendSinkFor, type ProposalSink, type SendChoice } from "./sink";
import { leaveWords, suggestingWords } from "./proposerWords";

/**
 * The changes last saved as a file or sent to the share. Every edit makes a new list
 * (`setChanges`), so leaving with this same list drops nothing that was not already handed over.
 */
let handedOver: readonly ProposalChange[] | null = null;

/** Why "Suggest changes" cannot start for this partner, or null when it can. */
export function suggestBlockedReason(
  partner: Pick<ProposalPartner, "projection" | "share">,
  state: Pick<State, "project" | "auto">,
  viewerTeamId: string | null = null,
): string | null {
  if (partner.projection.level !== "propose" || partner.projection.structure === undefined) {
    return "This share is view only. Only a propose-level share to your team takes proposals.";
  }
  if (partner.share !== undefined) {
    const blocked = shareProposeBlockedReason(partner.share, viewerTeamId);
    if (blocked !== null) return blocked;
  }
  if (state.project === null || state.auto === null) {
    return "Open your own auto first: the proposal is timed with your robot's drive limits and checked against your auto.";
  }
  return null;
}

/** The partner a proposal is made to, as the alliance view loaded it. */
export interface ProposalPartner {
  id: string;
  label: string;
  fileName: string;
  projection: Projection;
  /** The received cloud share it came from; absent for a partner loaded from a file. */
  share?: PartnerShare;
}

/**
 * The revision a proposal to a partner loaded from a file names at first. A projection file records
 * no share or revision, so a file partner's reference is a local one only: the share id is the
 * file name's stem, and the revision is this until the proposer types the one the sharing team
 * gave them (the Share section of the partner inspector). The owner's app checks the structure
 * hash, which refuses a proposal made against a different version whatever this number says.
 */
export const LOCAL_REF_REVISION = 1;

/** What a partner's proposal names: its cloud share and revision, or a local reference for a file. */
export type PartnerRef = { kind: "cloud"; shareRef: ShareRef } | { kind: "local"; shareRef: ShareRef };

export function partnerRefOf(partner: Pick<ProposalPartner, "fileName" | "share">): PartnerRef {
  if (partner.share !== undefined) {
    return { kind: "cloud", shareRef: { shareId: partner.share.shareId, revision: partner.share.revision } };
  }
  return { kind: "local", shareRef: { shareId: defaultShareId(partner.fileName), revision: LOCAL_REF_REVISION } };
}

/** Opens the proposer's editor on a partner's propose-level share. */
export function suggestChanges(partner: ProposalPartner): void {
  const state = getState();
  const blocked = suggestBlockedReason(partner, state, getCloud().session.teamId);
  if (blocked !== null) {
    setStatus("error", blocked);
    return;
  }
  // The editor's own playback and selection stay as they were, untouched, for when the session ends.
  setPlaying(false);
  setSelection({});
  startProposerSession({
    partnerId: partner.id,
    label: partner.label,
    fileName: partner.fileName,
    projection: partner.projection,
    shareRef: partnerRefOf(partner).shareRef,
    ...(partner.share === undefined ? {} : { share: partner.share }),
  });
  handedOver = null;
  setStatus("info", suggestingWords(partner.label, partner.share !== undefined));
}

/**
 * Leave: with changes not saved or sent, asks first with the unsaved-changes question (Cancel,
 * Discard changes, Save proposal…), the one every other loss of unsaved work asks (UI_GUIDE 9.14).
 * Save leaves only once the file is saved; a refused save stays, and its error says why.
 */
export async function askLeaveProposal(): Promise<void> {
  const session = getProposerSession();
  if (session === null) return;
  if (session.changes.length > 0 && session.changes !== handedOver) {
    const count = session.changes.length;
    const choice = await askUnsaved({
      fileName: `The proposal to ${session.label}`,
      lead: `The proposal to ${session.label} has ${count === 1 ? "1 change" : `${String(count)} changes`} that ${count === 1 ? "is" : "are"} not saved or sent.`,
      next: "Leaving drops them.",
      saveLabel: "Save proposal…",
    });
    if (choice === "cancel") return;
    if (choice === "save") {
      await saveProposal();
      if (getProposerSession()?.changes !== handedOver) return;
    }
  }
  leaveProposal();
}

/** Leaves the proposer's editor. */
export function leaveProposal(): void {
  const session = getProposerSession();
  endProposerSession();
  const words = session === null ? null : leaveWords(session.label, session.changes.length, session.changes === handedOver);
  handedOver = null;
  if (words !== null) setStatus("info", words);
}

// ---------------------------------------------------------------------------------------------
// The model, memoised on what it reads.
// ---------------------------------------------------------------------------------------------

let memo: { key: unknown[]; model: ProposerModel } | null = null;

/** The proposer's model for a session and the editor's files, or null without a project. */
export function proposerModelFor(session: ProposerSession, state: Pick<State, "autoRobot" | "autoField" | "project">): ProposerModel | null {
  const template = state.autoRobot ?? state.project?.robot ?? null;
  const field = state.autoField ?? state.project?.field ?? null;
  if (template === null || field === null) return null;
  const key: unknown[] = [session.projection, session.changes, session.shareRef, template, field, session.label];
  if (memo !== null && memo.key.length === key.length && memo.key.every((value, index) => value === key[index])) return memo.model;
  const model = buildProposerModel({
    projection: session.projection,
    shareRef: session.shareRef,
    changes: session.changes,
    template,
    field,
    label: session.label,
  });
  memo = { key, model };
  return model;
}

/** The current session and its model, for an edit. */
function current(): { session: ProposerSession; model: ProposerModel } | null {
  const session = getProposerSession();
  if (session === null) return null;
  const model = proposerModelFor(session, getState());
  return model === null ? null : { session, model };
}

// ---------------------------------------------------------------------------------------------
// Edits, each one pure helper.
// ---------------------------------------------------------------------------------------------

export function proposeMovePose(stepId: string, target: DraftPoint, pose: { xIn: number; yIn: number; headingRad?: number }): void {
  const at = current();
  if (at === null) return;
  setChanges(recordMovePose(at.session.changes, at.model.context, stepId, target, pose));
}

export function proposeMovePoses(moves: ReadonlyArray<{ stepId: string; target: DraftPoint; pose: { xIn: number; yIn: number; headingRad?: number } }>): void {
  const at = current();
  if (at === null) return;
  let changes = at.session.changes;
  for (const move of moves) changes = recordMovePose(changes, at.model.context, move.stepId, move.target, move.pose);
  setChanges(changes);
}

export function proposeHeading(stepId: string, heading: ProjectionHeading): void {
  const at = current();
  if (at === null) return;
  setChanges(recordHeading(at.session.changes, at.model.context, stepId, heading));
}

export function proposeSpeed(stepId: string, speedFraction: number): void {
  const at = current();
  if (at === null) return;
  setChanges(recordSpeed(at.session.changes, at.model.context, stepId, speedFraction));
}

export function proposeTimeout(stepId: string, timeoutS: number | null): void {
  const at = current();
  if (at === null) return;
  setChanges(recordTimeout(at.session.changes, at.model.context, stepId, timeoutS));
}

export function proposeWaitSeconds(stepId: string, seconds: number): void {
  const at = current();
  if (at === null) return;
  setChanges(recordWaitSeconds(at.session.changes, at.model.context, stepId, seconds));
}

export function proposeMarker(stepId: string, markerIndex: number, markerAt: ProjectionMarkerAt): void {
  const at = current();
  if (at === null) return;
  setChanges(recordMarker(at.session.changes, at.model.context, stepId, markerIndex, markerAt));
}

export function proposeEnvelope(stepId: string, envelope: Envelope | null): void {
  const at = current();
  if (at === null) return;
  setChanges(recordEnvelope(at.session.changes, at.model.context, stepId, envelope));
}

/** A new 1 s wait after a step, or at the start with null. */
export function proposeInsertWait(afterStepId: string | null, seconds = 1): void {
  const at = current();
  if (at === null) return;
  setChanges(recordInsertWait(at.session.changes, at.model.context, afterStepId, seconds));
}

export function proposeRemove(stepId: string): void {
  const at = current();
  if (at === null) return;
  setChanges(recordRemove(at.session.changes, at.model.context, stepId));
}

export function proposeReorder(stepId: string, fromIndex: number, newIndex: number): void {
  const at = current();
  if (at === null) return;
  setChanges(recordReorder(at.session.changes, at.model.context, stepId, fromIndex, newIndex));
}

export function proposeComment(index: number, text: string): void {
  const at = current();
  if (at === null) return;
  setChanges(setComment(at.session.changes, index, text));
}

export function dropChange(index: number): void {
  const at = current();
  if (at === null) return;
  setChanges(removeChange(at.session.changes, index));
}

// ---------------------------------------------------------------------------------------------
// Saving and sending.
// ---------------------------------------------------------------------------------------------

/** Why the proposal cannot be saved or sent yet, or null when it can. */
export function saveBlockedReason(model: ProposerModel | null, session: ProposerSession | null): string | null {
  if (session === null || model === null) return "Open a project first.";
  if (session.changes.length === 0) return "Make a change first: drag a point, or change a step in the inspector.";
  if (model.proposal === null) return model.proposalError ?? "These changes are not a proposal yet.";
  if (model.findings.length > 0) return "The share would refuse some of these changes. Fix or remove them first: each says why.";
  return null;
}

/** True while a proposal is being handed over, so a second press does not send it twice. */
let handingOver = false;

async function handOver(sink: ProposalSink): Promise<void> {
  if (handingOver) return;
  const at = current();
  const blocked = saveBlockedReason(at?.model ?? null, at?.session ?? null);
  if (at === null || at.model.proposal === null || blocked !== null) {
    setStatus("error", blocked ?? "There is no proposal to save.");
    return;
  }
  handingOver = true;
  try {
    const sent = await sink.send(at.model.proposal, proposalFileName(at.model.proposal));
    handedOver = at.session.changes;
    // A proposal still in the Outbox has not reached the share: the line informs, it does not say done.
    setStatus(sent.waiting ? "info" : "ok", sent.sentence);
  } catch (error) {
    setStatus("error", error instanceof Error ? error.message : String(error));
  } finally {
    handingOver = false;
  }
}

/** "Save proposal…": downloads the canonical proposal file. */
export const saveProposal = (): Promise<void> => handOver(downloadSink);

/** Where "Send to the share" goes for the current session, or why it cannot. */
export function sendChoiceFor(session: Pick<ProposerSession, "share"> | null): SendChoice {
  return sendSinkFor(session?.share, getCloud().session);
}

/** "Send to the share": sends the proposal through the cloud to the share the partner came from. */
export function sendProposal(): Promise<void> {
  const choice = sendChoiceFor(getProposerSession());
  if (!choice.ok) {
    setStatus("error", choice.why);
    return Promise.resolve();
  }
  return handOver(choice.sink);
}
