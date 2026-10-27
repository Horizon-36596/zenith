/**
 * "Request more time" through the cloud (spec 13 section 8.4), on top of `packages/cloud`'s
 * `CloudBackend`: a team a share was made to asks the team that made it for more time, before or
 * after the share ends, and that team grants it (which extends the share in the same write) or
 * declines it from its Sharing page.
 *
 * Nothing in a request is typed by a person. FIRST's Youth Protection Program rules out private
 * messages between users (spec 13 section 12.2), so a request carries only a reason picked from a
 * fixed list, and the end the team would like, and both teams' members see it.
 *
 * What it translates, as the sharing adapter does for shares:
 *
 * - **Teams.** The cloud stores team ids; the UI says "Team 12345". Each id is looked up once.
 * - **Instants.** ISO 8601 strings here, `Date`s in the cloud.
 * - **The outbox.** While the device is online a write returns once the server has it, so a refusal
 *   by the rules is reported where it was asked for. Offline it returns at once, marked `queued`,
 *   and the Outbox lists it until it is sent (section 6).
 *
 * Only types come from the cloud package's main entry, which carries the Firebase SDK; the list of
 * reasons comes from its Firebase-free `sharing` entry.
 */
import type {
  CloudBackend,
  EndedShare,
  Queued,
  TimeRequest as StoredTimeRequest,
  TimeRequestReason,
  TimeRequestStatus,
} from "@horizon36596/zenith-cloud";
import { TIME_REQUEST_REASONS } from "@horizon36596/zenith-cloud/sharing";
import { sharingErrorSentence } from "./cloudSharingApi";
import { isRulesRefusal, ownSentence } from "./errorSentence";
import { cloudErrorCode } from "../account/keys/errors";
import { teamWords, type CloudWriteOptions, type Sent } from "./proposalsApi";
import { expiryInstant } from "./shareModel";
import { teamReader, type TeamLookup } from "./teams";

export type { TimeRequestReason, TimeRequestStatus };

/** The reasons a team may give, in the order the form lists them. */
export const TIME_REQUEST_REASON_IDS: readonly TimeRequestReason[] = TIME_REQUEST_REASONS;

/** Each reason as the asking team picks it and as the sharing team reads it. */
export const TIME_REQUEST_REASON_WORDS: Record<TimeRequestReason, string> = {
  "next-event": "We need it through our next event.",
  "still-testing": "We are still testing our auto against it.",
  "still-planning": "We are still planning our alliance autos with it.",
};

/** A status in words, for its chip. */
export const TIME_REQUEST_STATUS_WORDS: Record<TimeRequestStatus, string> = {
  open: "Waiting",
  granted: "Granted",
  declined: "Declined",
};

/** One request for more time, as the Sharing page and the Partners panel show it. */
export interface CloudTimeRequest {
  shareId: string;
  /** The asking team's cloud id. */
  teamId: string;
  /** The asking team in words: "Team 12345". */
  team: string;
  ownerTeamId: string;
  /** The sharing team in words. */
  ownerTeam: string;
  status: TimeRequestStatus;
  reason: TimeRequestReason | null;
  /** The end the asking team would like, or null when it named none. */
  wantedUntil: string | null;
  requestedAt: string;
  decidedAt: string | null;
  /** The share's new end, when it was granted. */
  grantedUntil: string | null;
}

/** A share made to this team that it can no longer open: ended, revoked, or its team deleted. */
export interface EndedReceivedShare {
  shareId: string;
  fromTeamId: string;
  /** The sharing team in words. */
  fromTeam: string;
  receivedAt: string;
}

export interface AskForTimeRequest {
  shareId: string;
  /** The asking team: the signed-in team. */
  teamId: string;
  reason?: TimeRequestReason;
  wantedUntil?: string;
}

export type TimeDecision = { status: "granted"; expiresAt: string } | { status: "declined" };

export interface TimeRequestsApi {
  ask(request: AskForTimeRequest): Promise<Sent<CloudTimeRequest>>;
  /** "received": requests on the team's own shares; "sent": the team's own. Newest first. */
  list(teamId: string, direction: "received" | "sent"): Promise<CloudTimeRequest[]>;
  decide(shareId: string, teamId: string, decision: TimeDecision): Promise<Sent<void>>;
  /** The shares made to the team that it can no longer open, newest first. */
  ended(teamId: string): Promise<EndedReceivedShare[]>;
}

/**
 * Why a request call failed, as one sentence. The client's own checks say exactly what is wrong
 * and are kept; a refusal by the cloud's rules says only that it was refused, so it is told in
 * the terms of what the rules allow for requests for more time.
 */
export function timeRequestErrorSentence(error: unknown): string {
  if (cloudErrorCode(error) === "permission-denied") {
    if (!isRulesRefusal(error)) return ownSentence(error) ?? sharingErrorSentence(error);
    return "The cloud refused that. A team can ask for more time on a share made to it until the share is revoked, and only the sharing team's owners and admins, or whoever made the share, can answer.";
  }
  return sharingErrorSentence(error);
}

async function guard<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw new Error(timeRequestErrorSentence(error), { cause: error });
  }
}

const iso = (at: Date | undefined): string | null => (at === undefined ? null : at.toISOString());

export function createCloudTimeRequestsApi(backend: CloudBackend, options: CloudWriteOptions = {}): TimeRequestsApi {
  const teams = teamReader(backend);
  const team = (teamId: string): Promise<TeamLookup> => teams.read(teamId);

  async function settle<T>(queued: Queued<T>): Promise<Sent<T>> {
    // Online only when the backend and the page both say so: either one offline means the write waits.
    const online = backend.isOnline() && (options.online?.() ?? true);
    if (online) await queued.sent;
    return { value: queued.value, queued: !online };
  }

  async function toRequest(stored: StoredTimeRequest): Promise<CloudTimeRequest> {
    return {
      shareId: stored.shareId,
      teamId: stored.teamId,
      team: teamWords(await team(stored.teamId)),
      ownerTeamId: stored.ownerTeamId,
      ownerTeam: teamWords(await team(stored.ownerTeamId)),
      status: stored.status,
      reason: stored.reason ?? null,
      wantedUntil: iso(stored.wantedUntil),
      requestedAt: stored.requestedAt.toISOString(),
      decidedAt: iso(stored.decidedAt),
      grantedUntil: iso(stored.grantedUntil),
    };
  }

  async function toEnded(ended: EndedShare): Promise<EndedReceivedShare> {
    return {
      shareId: ended.shareId,
      fromTeamId: ended.ownerTeamId,
      fromTeam: teamWords(await team(ended.ownerTeamId)),
      receivedAt: ended.receivedAt.toISOString(),
    };
  }

  return {
    ask: (request) =>
      guard(async () => {
        const sent = await settle(
          await backend.requestMoreTime({
            shareId: request.shareId,
            teamId: request.teamId,
            ...(request.reason === undefined ? {} : { reason: request.reason }),
            ...(request.wantedUntil === undefined ? {} : { wantedUntil: new Date(request.wantedUntil) }),
          }),
        );
        return { value: await toRequest(sent.value), queued: sent.queued };
      }),

    list: (teamId, direction) =>
      guard(async () => Promise.all((await backend.listTimeRequests(teamId, direction)).map((stored) => toRequest(stored)))),

    decide: (shareId, teamId, decision) =>
      guard(async () =>
        settle(
          await backend.decideTimeRequest(
            shareId,
            teamId,
            decision.status === "granted" ? { status: "granted", expiresAt: new Date(decision.expiresAt) } : { status: "declined" },
          ),
        ),
      ),

    ended: (teamId) => guard(async () => Promise.all((await backend.listEndedShares(teamId)).map((ended) => toEnded(ended)))),
  };
}

// ------------------------------------------------------------------------ the pure part

/** The team's latest request on a share, or null. A team has at most one per share. */
export function requestFor(requests: readonly CloudTimeRequest[], shareId: string, teamId?: string): CloudTimeRequest | null {
  return requests.find((request) => request.shareId === shareId && (teamId === undefined || request.teamId === teamId)) ?? null;
}

/** The requests on one share, open ones first, then newest first. */
export function requestsOfShare(requests: readonly CloudTimeRequest[], shareId: string): CloudTimeRequest[] {
  return requests
    .filter((request) => request.shareId === shareId)
    .sort(
      (a, b) =>
        Number(b.status === "open") - Number(a.status === "open") || b.requestedAt.localeCompare(a.requestedAt),
    );
}

/**
 * What "1 more day", "7 more days" and "30 more days" mean for a request or a grant: counted from
 * the share's end, or from now when it has ended or its end is not known (an ended share's end is
 * not readable by the team it was made to).
 */
export function moreDays(endsAt: string | null, days: 1 | 7 | 30, nowMs: number): string {
  const endMs = endsAt === null ? Number.NaN : Date.parse(endsAt);
  const from = Number.isFinite(endMs) ? Math.max(endMs, nowMs) : nowMs;
  return new Date(from + days * 86_400_000).toISOString();
}

/**
 * How long, in a request or a grant. Every choice is calendar time (owner ruling 2026-09-27): more
 * days, or a date and optionally a time. `asked` is the end the asking team would like, which the
 * grant offers first; `none` is a request that leaves the length to the sharing team.
 */
export type EndPick =
  | { kind: "days"; days: 1 | 7 | 30 }
  | { kind: "date"; date: string; time?: string }
  | { kind: "asked" }
  | { kind: "none" };

/**
 * The instant a pick ends at, as an ISO string: null for `none`, and for a date that is not a date
 * or an `asked` with nothing asked. `endsAt` is the share's end when it is known.
 */
export function pickInstant(pick: EndPick, endsAt: string | null, askedFor: string | null, nowMs: number): string | null {
  switch (pick.kind) {
    case "days":
      return moreDays(endsAt, pick.days, nowMs);
    case "date":
      return expiryInstant(pick, nowMs);
    case "asked":
      return askedFor;
    case "none":
      return null;
  }
}

/**
 * Why a pick cannot be sent, or null. A request's end must be after now; a grant's must be after
 * the share's end as well, since giving more time never shortens a share.
 */
export function pickProblem(pick: EndPick, at: string | null, endsAt: string | null, nowMs: number, purpose: "ask" | "grant"): string | null {
  if (pick.kind === "none") return purpose === "grant" ? "Pick how much more time to give." : null;
  if (at === null) return pick.kind === "date" ? "Pick the date it should end." : "Pick how much more time.";
  const atMs = Date.parse(at);
  if (atMs <= nowMs) return "That end has already passed. Pick a later one.";
  const endMs = endsAt === null ? Number.NaN : Date.parse(endsAt);
  if (purpose === "grant" && Number.isFinite(endMs) && atMs <= endMs) {
    return "That is not later than the share ends now. Pick a later end.";
  }
  return null;
}

/** An ISO instant as the date and time inputs hold it, on this computer's clock. */
export function localDateTime(at: string): { date: string; time: string } {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    date: `${String(d.getFullYear())}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
  };
}
