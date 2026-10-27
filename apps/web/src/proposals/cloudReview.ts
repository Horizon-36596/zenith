/**
 * Opening a proposal received through the cloud (spec 13 section 14), from the Sharing page: the
 * proposal is read against the team library revision it was made against, fetched from the
 * library, so core maps its opaque step ids and command tokens back through that revision
 * (`projectionStepIdMap`, inside `diffProposal`), exactly as the sharer's device built them. The
 * review itself is the one a proposal file opens (`ProposalReviewView`).
 */
import { loadAuto, loadField, loadRobot, loadWaypoints } from "@horizon36596/zenith-core";
import type { Auto } from "@horizon36596/zenith-schema";
import type { CloudProposal } from "../cloud/proposalsApi";
import { shareStatusOf } from "../cloud/proposalsModel";
import { ownRevisionFiles } from "../cloud/proposalsStore";
import { closeSharingSheet, cloudNow } from "../cloud/store";
import type { RevisionFiles, Share } from "../cloud/types";
import { getState, setStatus } from "../state/store";
import { openProposal } from "./ownerActions";
import { getOwnerReview } from "./ownerStore";
import type { ReviewFiles } from "./review";

const say = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * A library revision as a review reads it: the auto, and the robot, field and waypoints published
 * with it, or the open project's for a revision published without them. Pure.
 */
export function pinnedFromRevision(
  files: RevisionFiles,
  fallback: ReviewFiles | null,
  revisionN: number,
): { ok: true; auto: Auto; files: ReviewFiles } | { ok: false; reason: string } {
  const which = `Revision ${String(revisionN)}`;
  try {
    const robot = files.robot !== undefined ? loadRobot(JSON.parse(files.robot)) : fallback?.robot;
    const field = files.field !== undefined ? loadField(JSON.parse(files.field)) : fallback?.field;
    if (robot === undefined || field === undefined) {
      return {
        ok: false,
        reason: `${which} was published without robot.json and a field, so the proposal cannot be read against it here. Open the robot's project first.`,
      };
    }
    const waypoints = files.waypoints !== undefined ? loadWaypoints(JSON.parse(files.waypoints)) : fallback?.waypoints;
    return { ok: true, auto: loadAuto(JSON.parse(files.content)), files: { robot, field, waypoints } };
  } catch (error) {
    return { ok: false, reason: `${which} could not be read: ${say(error)}` };
  }
}

/**
 * Opens a received cloud proposal for review and closes the Sharing page, or says on the status line
 * why it cannot.
 */
export async function openCloudProposal(proposal: CloudProposal, share: Share): Promise<void> {
  let json: unknown;
  try {
    json = JSON.parse(proposal.text);
  } catch {
    setStatus("error", `The proposal from ${proposal.fromTeam} is not JSON, so it cannot be reviewed.`);
    return;
  }
  let files: RevisionFiles | null;
  try {
    files = await ownRevisionFiles(share.autoId, proposal.baseRevisionId);
  } catch (error) {
    setStatus("error", say(error));
    return;
  }
  if (files === null) {
    setStatus("error", `Revision ${String(proposal.revision)} is no longer in the team library, so the proposal cannot be read against it.`);
    return;
  }
  const editor = getState();
  const project = editor.project;
  const fallback =
    project === null
      ? null
      : { robot: editor.autoRobot ?? project.robot, field: editor.autoField ?? project.field, waypoints: project.waypoints };
  const pinned = pinnedFromRevision(files, fallback, proposal.revision);
  if (!pinned.ok) {
    setStatus("error", pinned.reason);
    return;
  }
  openProposal(`Proposal from ${proposal.fromTeam}`, json, {
    shareRef: { shareId: share.id, revision: proposal.revision },
    share: shareStatusOf(share, cloudNow()),
    pinned: { auto: pinned.auto, files: pinned.files },
    cloud: { proposalId: proposal.id, fromTeam: proposal.fromTeam, status: proposal.status },
  });
  // The review takes the whole editor, so the Sharing page it was opened from closes, as the team
  // library does when it opens a review. When the review could not open, the page stays and the
  // status line says why.
  if (getOwnerReview() !== null) closeSharingSheet();
}
