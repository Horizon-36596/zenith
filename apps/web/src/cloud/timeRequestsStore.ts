/**
 * The requests for more time (spec 13 section 8.4) the signed-in team received on its shares and
 * sent on shares made to it, and the shares made to it that it can no longer open. A small
 * observable store beside the sharing and proposals stores; the account session hands it the
 * adapter over its own `CloudBackend` whenever the sharing session changes (`account/wiring.ts`),
 * and until then every request says to sign in.
 */
import { useSyncExternalStore } from "react";
import type { Sent } from "./proposalsApi";
import { cloudNow, refreshReceived, refreshSharing, type CloudSession } from "./store";
import type { AskForTimeRequest, CloudTimeRequest, EndedReceivedShare, TimeDecision, TimeRequestsApi } from "./timeRequestsApi";

export interface TimeRequestsState {
  /** The team the lists are for, or null when signed out. */
  teamId: string | null;
  /** Requests on the team's own shares, newest first. */
  received: CloudTimeRequest[];
  /** The team's own requests on shares made to it, newest first. */
  sent: CloudTimeRequest[];
  /** Shares made to the team that it can no longer open, newest first. */
  ended: EndedReceivedShare[];
  /** The last read's failure, as a sentence, until the next one. */
  error: string | null;
}

const SIGN_IN = "Sign in with your team to ask for more time, or to answer a request.";

/** Reads closer together than this reuse the last answer, so rows that mount together read once. */
const FRESH_MS = 3_000;

let api: TimeRequestsApi | null = null;
let state: TimeRequestsState = { teamId: null, received: [], sent: [], ended: [], error: null };
let lastRead = Number.NEGATIVE_INFINITY;
let reading: Promise<void> | null = null;
const listeners = new Set<() => void>();

function set(patch: Partial<TimeRequestsState>): void {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

export const getTimeRequests = (): TimeRequestsState => state;

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const useTimeRequests = (): TimeRequestsState => useSyncExternalStore(subscribe, getTimeRequests, getTimeRequests);

const say = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Replaces the adapter and the session; clears the lists and reads them again when signed in. */
export function setTimeRequestsApi(next: TimeRequestsApi | null, session: CloudSession): void {
  api = next;
  const teamId = session.signedIn ? session.teamId : null;
  lastRead = Number.NEGATIVE_INFINITY;
  set({ teamId, received: [], sent: [], ended: [], error: null });
  if (teamId !== null) void refreshTimeRequests();
}

/** Reads every list again. */
export async function refreshTimeRequests(): Promise<void> {
  const teamId = state.teamId;
  if (api === null || teamId === null) return;
  const current = api;
  const work = (async () => {
    try {
      const [received, sent, ended] = await Promise.all([
        current.list(teamId, "received"),
        current.list(teamId, "sent"),
        current.ended(teamId),
      ]);
      if (state.teamId === teamId) set({ received, sent, ended, error: null });
    } catch (error) {
      if (state.teamId === teamId) set({ error: say(error) });
    }
  })();
  reading = work;
  lastRead = cloudNow();
  await work;
  if (reading === work) reading = null;
}

/** Reads the lists unless they were read a moment ago or are being read now. */
export async function refreshTimeRequestsIfStale(): Promise<void> {
  if (reading !== null) return reading;
  if (cloudNow() - lastRead < FRESH_MS) return;
  return refreshTimeRequests();
}

function need(): { api: TimeRequestsApi; teamId: string } {
  if (api === null || state.teamId === null) throw new Error(SIGN_IN);
  return { api, teamId: state.teamId };
}

/** Asks the team that made a share for more time, for the signed-in team. Throws a sentence when refused. */
export async function askForMoreTime(request: Omit<AskForTimeRequest, "teamId">): Promise<Sent<CloudTimeRequest>> {
  const { api: current, teamId } = need();
  const sent = await current.ask({ ...request, teamId });
  await refreshTimeRequests();
  return sent;
}

/**
 * Grants or declines a request on one of the team's shares. A grant extends the share, so the
 * Sharing page's lists are read again too. Throws a sentence when refused.
 */
export async function decideTimeRequest(shareId: string, teamId: string, decision: TimeDecision): Promise<Sent<void>> {
  const { api: current } = need();
  const sent = await current.decide(shareId, teamId, decision);
  await Promise.all([refreshTimeRequests(), refreshSharing(), refreshReceived()]);
  return sent;
}
