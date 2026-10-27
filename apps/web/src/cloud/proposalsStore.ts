/**
 * The cloud proposals the signed-in team received and sent (spec 13 section 14), for the Sharing
 * page and the Partners panel. A small observable store beside the sharing store; the account
 * session hands it the adapter over its own `CloudBackend` whenever the sharing session changes
 * (`account/wiring.ts`), and until then every request says to sign in.
 */
import { useSyncExternalStore } from "react";
import type { CloudProposal, ProposalsApi, SendProposalRequest, Sent } from "./proposalsApi";
import type { RevisionFiles } from "./types";
import type { CloudSession } from "./store";

export interface ProposalsState {
  /** The team the lists are for, or null when signed out. */
  teamId: string | null;
  /** Proposals made to the team's shares, newest first. */
  received: CloudProposal[];
  /** Proposals the team sent to other teams' shares, newest first. */
  sent: CloudProposal[];
  /** The last request's failure, as a sentence, until the next request. */
  error: string | null;
}

const SIGN_IN = "Sign in with your team to send or review proposals through the cloud.";

let api: ProposalsApi | null = null;
let state: ProposalsState = { teamId: null, received: [], sent: [], error: null };
const listeners = new Set<() => void>();

function set(patch: Partial<ProposalsState>): void {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

export const getProposals = (): ProposalsState => state;

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const useProposals = (): ProposalsState => useSyncExternalStore(subscribe, getProposals, getProposals);

const say = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Replaces the adapter and the session; clears the lists and reads them again when signed in. */
export function setProposalsApi(next: ProposalsApi | null, session: CloudSession): void {
  api = next;
  const teamId = session.signedIn ? session.teamId : null;
  set({ teamId, received: [], sent: [], error: null });
  if (teamId !== null) void refreshProposals();
}

/** Reads both lists again. */
export async function refreshProposals(): Promise<void> {
  const teamId = state.teamId;
  if (api === null || teamId === null) return;
  try {
    const [received, sent] = await Promise.all([api.list(teamId, "received"), api.list(teamId, "sent")]);
    if (state.teamId === teamId) set({ received, sent, error: null });
  } catch (error) {
    if (state.teamId === teamId) set({ error: say(error) });
  }
}

function need(): { api: ProposalsApi; teamId: string } {
  if (api === null || state.teamId === null) throw new Error(SIGN_IN);
  return { api, teamId: state.teamId };
}

/** Sends a proposal to a share, then reads the lists again. Throws a sentence when refused. */
export async function sendCloudProposal(request: Omit<SendProposalRequest, "fromTeamId">): Promise<Sent<CloudProposal>> {
  const { api: current, teamId } = need();
  const sent = await current.send({ ...request, fromTeamId: teamId });
  await refreshProposals();
  return sent;
}

/** Accepts or rejects a received proposal, then reads the lists again. Throws a sentence when refused. */
export async function decideCloudProposal(proposalId: string, decision: "accepted" | "rejected"): Promise<Sent<void>> {
  const { api: current } = need();
  const sent = await current.decide(proposalId, decision);
  await refreshProposals();
  return sent;
}

/** Withdraws an open proposal the signed-in member sent, then reads the lists again. Throws a sentence when refused. */
export async function withdrawCloudProposal(proposalId: string): Promise<Sent<void>> {
  const { api: current } = need();
  const sent = await current.withdraw(proposalId);
  await refreshProposals();
  return sent;
}

/** One revision of the signed-in team's library: what a received proposal is reviewed against. */
export async function ownRevisionFiles(autoId: string, revisionId: string): Promise<RevisionFiles | null> {
  const { api: current, teamId } = need();
  return current.revisionFiles(teamId, autoId, revisionId);
}
