/**
 * What the owner's controls do (spec 13 section 14): open a proposal, from a file or from the
 * cloud, against the pinned revision, accept and reject changes, and Apply the accepted ones
 * through the editor's normal edit path, one undo step per Apply.
 *
 * **The pinned revision.** A share is pinned to the team library revision it was made from, and the
 * owner's app rebuilds the opaque id and token maps from that revision. A proposal received through
 * the cloud names its revision, and is read against it, fetched from the team library
 * (`cloudReview.ts`). A proposal file carries only the revision's number, so it is read against the
 * auto as it is open now, and the review says so. When the share was made from this same auto and
 * nothing has changed since, that is exactly the pinned revision; when something has, the structure
 * hash does not match and core refuses the proposal as stale, which is the honest answer.
 *
 * **The cloud's record.** For a proposal from the cloud, the first Apply also marks it accepted
 * there, and "Reject proposal" marks it rejected, so the team that sent it sees what became of it.
 */
import { applyProposalToAuto, canonicalize, readProposal, type ShareStatus } from "@horizon36596/zenith-core";
import type { Auto, ShareRef } from "@horizon36596/zenith-schema";
import { decideCloudProposal } from "../cloud/proposalsStore";
import { tryEdit } from "../app/edits";
import { tooLargeFileMessage, unreadableJsonMessage } from "../project/fileErrors";
import { getState, setPlaying, setSelection, setStatus } from "../state/store";
import { endProposerSession } from "./proposerStore";
import {
  closeOwnerReview,
  getOwnerReview,
  liveApplied,
  openOwnerReview,
  recordApply,
  setCloudReview,
  setDecisions,
  type CloudReviewRef,
  type OwnerReviewState,
} from "./ownerStore";
import {
  acceptAllValid,
  buildOwnerReview,
  pinnedInputFor,
  PROPOSE_LEVEL,
  toggleAccepted,
  type OwnerReview,
  type ReviewFiles,
} from "./review";

/** The largest proposal file read, in bytes: 200 changes of the largest kind fit well inside it. */
export const MAX_PROPOSAL_BYTES = 1_000_000;

/** Why "Open proposal…" cannot run, or null when it can. */
export function openProposalBlockedReason(state: Pick<ReturnType<typeof getState>, "auto" | "project" | "review">): string | null {
  if (state.project === null || state.auto === null) return "Open the auto the proposal is for first: it is reviewed against that auto.";
  if (state.review !== null) return "Leave the pull request review first.";
  return null;
}

/** Where a proposal came from, when it came from a share on the Sharing page. */
export interface ProposalShareContext {
  shareRef: ShareRef;
  share: ShareStatus;
  /**
   * The team library revision the share was made from, with its robot and field: what a proposal
   * from the cloud is read against. Without it the proposal is read against the open auto.
   */
  pinned?: { auto: Auto; files: ReviewFiles };
  /** The cloud proposal it is, for Accept and Reject to record. */
  cloud?: Omit<CloudReviewRef, "deciding">;
}

/** Opens the file picker for a proposal. */
export function pickProposalFile(context?: ProposalShareContext): void {
  const blocked = openProposalBlockedReason(getState());
  if (blocked !== null) {
    setStatus("error", blocked);
    return;
  }
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".json,application/json";
  input.hidden = true;
  input.dataset["testid"] = "proposal-file-input";
  input.addEventListener("change", () => {
    const file = input.files?.[0];
    input.remove();
    if (file !== undefined) void openProposalFile(file, context);
  });
  input.addEventListener("cancel", () => {
    input.remove();
  });
  document.body.append(input);
  input.click();
}

/** Reads a proposal file and opens the review, or says on the status line why it cannot. */
export async function openProposalFile(file: { name: string; size: number; text(): Promise<string> }, context?: ProposalShareContext): Promise<void> {
  if (file.size > MAX_PROPOSAL_BYTES) {
    setStatus("error", tooLargeFileMessage(file.name, file.size, MAX_PROPOSAL_BYTES, "a proposal", "Check that this is the file you meant."));
    return;
  }
  const again = "Ask your partner to send the proposal again.";
  let text: string;
  try {
    text = await file.text();
  } catch {
    // Removed, moved or locked since it was picked.
    setStatus("error", `${file.name} could not be read. ${again}`);
    return;
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    setStatus("error", unreadableJsonMessage(file.name, text, error, again));
    return;
  }
  openProposal(file.name, json, context);
}

/** Opens a proposal already read, against the auto as it is open now. */
export function openProposal(fileName: string, json: unknown, context?: ProposalShareContext): void {
  const state = getState();
  const blocked = openProposalBlockedReason(state);
  const project = state.project;
  const auto = state.auto;
  if (blocked !== null || project === null || auto === null) {
    setStatus("error", blocked ?? "Open an auto first.");
    return;
  }
  const read = readProposal(json);
  if (read.proposal === null) {
    setStatus("error", read.findings[0]?.message ?? `${fileName} is not a proposal.`);
    return;
  }
  const robot = state.autoRobot ?? project.robot;
  const field = state.autoField ?? project.field;
  const against = context?.pinned ?? { auto, files: { robot, field, waypoints: project.waypoints } };
  let pinned;
  try {
    pinned = pinnedInputFor(against.auto, against.files);
  } catch (error) {
    const which = context?.pinned === undefined ? "The auto" : `Revision ${String(context.shareRef.revision)}`;
    setStatus("error", `${which} cannot be planned, so the proposal cannot be read against it: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  endProposerSession();
  setPlaying(false);
  setSelection({});
  openOwnerReview({
    fileName,
    proposal: read.proposal,
    pinned,
    pinnedAuto: against.auto,
    pinnedSource: context?.pinned === undefined ? "current" : "revision",
    ...(context === undefined ? {} : { shareRef: context.shareRef, share: context.share }),
    ...(context?.cloud === undefined ? {} : { cloud: { ...context.cloud, deciding: false } }),
    accepted: new Set(),
    rejected: new Set(),
    applies: [],
    focus: null,
  });
  setStatus("info", `Reviewing ${fileName}. Nothing changes in your auto until you accept changes and apply them.`);
}

/** The review for the current choices, or null when none is open. */
export function currentOwnerReview(): OwnerReview | null {
  const state = getOwnerReview();
  const editor = getState();
  if (state === null || editor.auto === null || editor.project === null) return null;
  return reviewFor(state, editor);
}

let memo: { key: unknown[]; review: OwnerReview } | null = null;

/** The review, memoised on what it reads. */
export function reviewFor(
  state: NonNullable<ReturnType<typeof getOwnerReview>>,
  editor: Pick<ReturnType<typeof getState>, "auto" | "project" | "autoRobot" | "autoField">,
): OwnerReview | null {
  const auto = editor.auto;
  const project = editor.project;
  if (auto === null || project === null) return null;
  const robot = editor.autoRobot ?? project.robot;
  const field = editor.autoField ?? project.field;
  const key: unknown[] = [state, auto, robot, field, project.waypoints];
  if (memo !== null && memo.key.every((value, index) => value === key[index])) return memo.review;
  const applied = liveApplied(state, canonicalize("auto", auto));
  const review = buildOwnerReview({
    current: auto,
    pinned: state.pinned,
    files: { robot, field, waypoints: project.waypoints },
    proposal: state.proposal,
    accepted: state.accepted,
    applied,
    ...(state.share === undefined ? {} : { share: state.share }),
    ...(state.shareRef === undefined ? {} : { shareRef: state.shareRef }),
  });
  memo = { key, review };
  return review;
}

/** Accepts or rejects one change. A change that cannot be taken can be rejected, never accepted. */
export function acceptChange(index: number, accept: boolean): void {
  const state = getOwnerReview();
  const review = currentOwnerReview();
  if (state === null || review === null) return;
  const accepted = toggleAccepted(state.accepted, review, index, accept);
  const rejected = new Set(state.rejected);
  if (!accept) rejected.add(index);
  else if (accepted.has(index)) rejected.delete(index);
  setDecisions(accepted, rejected);
}

export function acceptEveryValidChange(): void {
  const state = getOwnerReview();
  const review = currentOwnerReview();
  if (state === null || review === null) return;
  const accepted = acceptAllValid(review);
  setDecisions(accepted, new Set([...state.rejected].filter((index) => !accepted.has(index))));
}

/** Rejects every change not applied yet. */
export function rejectEveryChange(): void {
  const review = currentOwnerReview();
  if (review === null) return;
  setDecisions(new Set(), new Set(review.rows.filter((row) => !row.applied).map((row) => row.index)));
}

/**
 * Makes the accepted changes in the auto, through the normal edit path, as one undo step. The
 * auto is not saved: that is the owner's own Save, as for any edit.
 */
export function applyAccepted(): void {
  const state = getOwnerReview();
  const editor = getState();
  const review = currentOwnerReview();
  if (state === null || review === null || editor.auto === null || editor.project === null) return;
  const blocked = applyBlockedReason(state);
  if (blocked !== null) {
    setStatus("error", blocked);
    return;
  }
  const indexes = review.toApply;
  if (indexes.length === 0) {
    setStatus("error", "Accept at least one change first. A change that conflicts or does not fit can only be rejected.");
    return;
  }
  const before = editor.auto;
  const result = applyProposalToAuto(before, state.pinned, PROPOSE_LEVEL, state.proposal, indexes, {
    waypoints: editor.project.waypoints,
    ...(state.share === undefined ? {} : { share: state.share }),
    ...(state.shareRef === undefined ? {} : { shareRef: state.shareRef }),
  });
  const made = result.changes.filter((change) => change.status === "applied").map((change) => change.index);
  if (made.length === 0) {
    setStatus("error", result.findings[0]?.message ?? "None of the accepted changes could be made.");
    return;
  }
  const beforeCanonical = canonicalize("auto", before);
  tryEdit(() => result.auto);
  if (getState().auto === before) return;
  recordApply({ indexes: made, beforeCanonical });
  const skipped = indexes.length - made.length;
  const applied = `Applied ${String(made.length)} ${made.length === 1 ? "change" : "changes"} as one edit${skipped > 0 ? `; ${String(skipped)} could not be made` : ""}. Undo takes ${made.length === 1 ? "it" : "them"} out; Save writes the file.`;
  if (state.cloud?.status === "rejected") {
    setStatus("ok", `${applied} You rejected the proposal from ${state.cloud.fromTeam} already, so they still see it rejected.`);
    return;
  }
  setStatus("ok", applied);
  if (state.cloud?.status === "open") void decideCloud("accepted", applied);
}

/**
 * Why Apply cannot run yet, or null when it can. While a decision on a cloud proposal is on its way,
 * an Apply could not mark it accepted, and a rejection on its way would leave the sender seeing it
 * rejected though its changes are in the auto.
 */
export function applyBlockedReason(state: Pick<OwnerReviewState, "cloud">): string | null {
  if (state.cloud?.deciding === true) return "Wait for the cloud to record your decision on this proposal first.";
  return null;
}

/**
 * Records the owner's decision on a cloud proposal, so the team that sent it sees it. `before` is a
 * sentence the status line already says, which the outcome is added to.
 */
async function decideCloud(decision: "accepted" | "rejected", before?: string): Promise<void> {
  const cloud = getOwnerReview()?.cloud;
  if (cloud === undefined || cloud.status !== "open" || cloud.deciding) return;
  const { proposalId } = cloud;
  setCloudReview(proposalId, { deciding: true });
  const lead = before === undefined ? "" : `${before} `;
  try {
    const sent = await decideCloudProposal(cloud.proposalId, decision);
    setCloudReview(proposalId, { status: decision, deciding: false });
    const tell = decision === "accepted" ? `Marked the proposal from ${cloud.fromTeam} accepted` : `Rejected the proposal from ${cloud.fromTeam}`;
    // A decision still in the Outbox has not reached the other team: the line informs, it does not say done.
    setStatus(
      sent.queued ? "info" : "ok",
      `${lead}${tell}${sent.queued ? "; this computer is offline, so that waits in the Outbox until the connection comes back." : ", and they can see it."}`,
    );
  } catch (error) {
    setCloudReview(proposalId, { deciding: false });
    setStatus("error", `${lead}The cloud did not record the decision: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** "Reject proposal": marks a cloud proposal rejected. Nothing in the auto changes. */
export function rejectCloudProposal(): Promise<void> {
  return decideCloud("rejected");
}

/** Leaves the review. Applied changes stay in the auto, unsaved, like any edit. */
export function leaveOwnerReview(): void {
  closeOwnerReview();
}
