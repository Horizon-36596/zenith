/**
 * One signed-in cloud session for the whole page (spec 13 section 4.1).
 * The account model owns the sign-in and the `CloudBackend`; this hands the same backend to the
 * other parts of the app that talk to the cloud:
 *
 * - the sharing store, as `cloudSharingApi` with the session of the selected team, whenever the
 *   signed-in user, the team, or the user's role in it changes;
 * - the proposals store, with the same session, for proposals sent and received through the cloud;
 * - the requests-for-more-time store, with the same session, for "Request more time" and its answers;
 * - the team-number verification UI (`setVerificationBackend`), so the Teams sheet's Verification
 *   section and the `#/admin` review page read what the account signed in to.
 *
 * With `?cloud=fake` all of them run on the one in-memory backend the account made.
 */
import type { CloudBackend, Revision } from "@horizon36596/zenith-cloud";
import { setVerificationBackend } from "../admin/store";
import { createCloudSharingApi } from "../cloud/cloudSharingApi";
import { createCloudProposalsApi } from "../cloud/proposalsApi";
import { setProposalsApi } from "../cloud/proposalsStore";
import type { PublishedRevision } from "../cloud/followLatest";
import { SIGNED_OUT, refreshSharing, setSharingBackend, settlePendingShare, type CloudSession } from "../cloud/store";
import { createCloudTimeRequestsApi } from "../cloud/timeRequestsApi";
import { setTimeRequestsApi } from "../cloud/timeRequestsStore";
import type { AccountModel, AccountState } from "./model";

/** The sharing session for an account state: signed in only with an active role in a team. */
export function sharingSessionOf(state: AccountState): CloudSession {
  const membership = state.memberships.find((m) => m.teamId === state.teamId);
  if (state.user === null || state.profile === null || membership === undefined || membership.role === "pending") {
    return SIGNED_OUT;
  }
  return {
    signedIn: true,
    teamId: membership.teamId,
    teamNumber: membership.team?.number ?? null,
    teamName: membership.team?.name ?? null,
  };
}

/** Starts handing the account's backend and session on. Returns the clean-up. */
export function wireCloudSession(model: AccountModel, options: { now?: () => number } = {}): () => void {
  const ids = new WeakMap<CloudBackend, number>();
  let nextId = 1;
  let backend: CloudBackend | null = null;
  let key: string | null = null;

  const apply = (): void => {
    const current = model.cloud();
    if (current !== backend) {
      backend = current;
      setVerificationBackend(current);
    }
    if (current === null) return;
    if (!ids.has(current)) ids.set(current, nextId++);
    const state = model.getState();
    const session = sharingSessionOf(state);
    const role = state.memberships.find((m) => m.teamId === session.teamId)?.role ?? null;
    // A device given the team key reads its shares again: until then it could not open them.
    const keyState = state.keys?.teamId === session.teamId ? (state.keys?.status?.state ?? null) : null;
    const nextKey = JSON.stringify([ids.get(current), state.user?.uid ?? null, role, session, keyState]);
    if (nextKey === key) return;
    key = nextKey;
    // A write waits in the Outbox whenever the account says offline, the browser's switch included.
    const writes = { online: () => model.getState().online };
    const sharing = createCloudSharingApi(current, {
      ...options,
      ...writes,
      // A share that waited for the connection says how it went once it is back, on the status
      // line and in the share dialog if it is still open.
      onPendingResult: (result) => {
        settlePendingShare(result);
        void refreshSharing();
      },
    });
    setSharingBackend(sharing, session, options);
    setProposalsApi(createCloudProposalsApi(current, writes), session);
    setTimeRequestsApi(createCloudTimeRequestsApi(current, writes), session);
  };

  apply();
  return model.subscribe(apply);
}

/** A revision the library just took, as the follow-latest hook reads it. */
export function publishedRevisionOf(revision: Revision): PublishedRevision {
  return {
    autoId: revision.autoId,
    revisionId: revision.id,
    n: revision.n,
    files: {
      content: revision.content,
      ...(revision.robot === undefined ? {} : { robot: revision.robot }),
      ...(revision.field === undefined ? {} : { field: revision.field }),
      ...(revision.waypoints === undefined ? {} : { waypoints: revision.waypoints }),
    },
  };
}
