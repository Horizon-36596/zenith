/**
 * The editor's side of "Follow the latest version" (spec 13 section 8.3):
 * when an auto is published to the team library, every share of it that follows the latest version
 * gets a projection rebuilt on this computer from what was just published, and moves to that
 * revision.
 *
 * The account's publish calls `onAutoPublished` once the revision is written (`account/wiring.ts`).
 * The library's own `PublishInput` takes a single `followProjection`; this hook builds one per
 * followed share instead, because two followed shares of one auto may differ in level,
 * coarseness or whether they name their commands, and each must keep its own. It builds from the published revision's own files, not
 * from the editor, so what a followed share shows is exactly that revision.
 */
import { getState, setStatus } from "../state/store";
import { revisionProjector } from "./revisionProjection";
import { getCloud, publishFollowedShares } from "./store";
import type { RevisionFiles } from "./types";

/** A revision the team library has just taken: its auto, id, number and files. */
export interface PublishedRevision {
  autoId: string;
  revisionId: string;
  n: number;
  files: RevisionFiles;
}

/**
 * Call after a revision is published: moves each follow-latest share of its auto to it, with a
 * fresh projection. Resolves to how many shares moved, or null when nobody is signed in with a
 * team, the revision cannot be projected here (the status line says why), or the request failed.
 */
export async function onAutoPublished(revision: PublishedRevision): Promise<number | null> {
  if (!getCloud().session.signedIn) return null;
  const project = getState().project;
  const projector = revisionProjector(
    revision.files,
    project === null ? null : { robot: project.robot, field: project.field, waypoints: project.waypoints },
    revision.n,
  );
  if (!projector.ok) {
    const follows = getCloud().shares.some(
      (share) => share.autoId === revision.autoId && share.mode === "follow" && share.revokedAt === null,
    );
    if (follows) setStatus("error", `The shares that follow the latest version were not updated. ${projector.reason}`);
    return null;
  }
  const moved = await publishFollowedShares(revision.autoId, revision.revisionId, projector.build);
  return moved;
}
