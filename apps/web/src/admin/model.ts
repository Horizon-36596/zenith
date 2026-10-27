/**
 * The verification UI's state, as pure functions of what the cloud returns (docs: spec 13 section
 * 4.4, M-C7). Nothing here touches the DOM, the clock or the network, so every sentence the team or a
 * reviewer reads is tested in `model.test.ts`.
 *
 * Owner ruling 2026-09-27: verification is review by a Horizon admin only. A team asks with evidence
 * (a photo, an event result or a statement), a reviewer decides with one sentence, a second claim on a
 * verified number is refused, one on an unverified number makes both claims contested, and the team
 * that loses a dispute may appeal once within 14 days.
 *
 * Owner ruling 2026-10-01: no Horizon-admin action needs two people. One Horizon admin may decide
 * every item alone, an appeal of their own decision and a team they are a member of included; the
 * claim's history and the admin log record who decided.
 */
import type {
  Claim,
  ClaimHistoryEntry,
  Dispute,
  DisputeEvidence,
  EvidenceInput,
  EvidenceKind,
  ReviewQueue,
  Team,
  VerificationRequest,
} from "@horizon36596/zenith-cloud";
import {
  appealClosesAt,
  appealProblem,
  evidenceProblem,
  oneSentenceProblem,
} from "@horizon36596/zenith-cloud/verification";

// ------------------------------------------------------------------------ the badge

/** The three statuses a team number can have (spec 13 section 4.4). */
export type BadgeStatus = "unverified" | "verified" | "contested";

export interface Badge {
  status: BadgeStatus;
  /** The word on the badge. */
  label: string;
  /** The tooltip: what the status means for this team. */
  meaning: string;
}

const LIVE_DISPUTE = new Set<Dispute["status"]>(["open", "appealed"]);

/** A dispute a reviewer has yet to decide: open, or appealed. */
export function isLive(dispute: Pick<Dispute, "status">): boolean {
  return LIVE_DISPUTE.has(dispute.status);
}

/**
 * The team's badge. `claim` is the claim on the team's number or, for a team with no number that is
 * contesting one, on the number it contests. A contested claim makes both of its teams contested (the
 * claim record names only the holder, so the challenger is found through its live dispute); a claim
 * the team holds and a Horizon admin verified makes it verified; anything else is unverified.
 */
export function badgeFor(teamId: string, team: Pick<Team, "number"> | null, claim: Claim | null, disputes: Dispute[]): Badge {
  const live = disputes.find((d) => isLive(d) && (d.holderTeamId === teamId || d.challengerTeamId === teamId));
  if (live !== undefined && claim !== null && claim.teamNumber === live.teamNumber && claim.status === "contested") {
    return {
      status: "contested",
      label: "Contested",
      meaning: `Two teams claim ${String(live.teamNumber)}. Both keep working while a Horizon admin reviews the evidence.`,
    };
  }
  const number = team?.number ?? null;
  if (number !== null && claim !== null && claim.teamNumber === number && claim.teamId === teamId && claim.status === "verified") {
    return { status: "verified", label: "Verified", meaning: `A Horizon admin checked that this team is FTC ${String(number)}.` };
  }
  if (number === null) {
    return {
      status: "unverified",
      label: "Unverified",
      meaning:
        live === undefined
          ? "This team has no FTC number yet. Claim one to have it verified."
          : `This team has no number while its review of ${String(live.teamNumber)} is open.`,
    };
  }
  return {
    status: "unverified",
    label: "Unverified",
    meaning: `Nobody has checked yet that this team is FTC ${String(number)}.`,
  };
}

// ------------------------------------------------------------------------ the claim code

/**
 * The code a team writes on a card in its photo, so a reviewer knows the photo was taken for this
 * claim (spec 13 section 4.4). It comes from the team's id, so the team and the reviewer compute the
 * same code without storing it. The id is not a secret: the claim on a number names the team that
 * holds it to anyone signed in, so anyone could work out the code. That is fine, because the code
 * does not prove who a team is. It shows only that a photo was taken for this claim, which an older
 * photo cannot show; the reviewer still checks that the robot and banner in it are the team's.
 */
export function claimCode(teamId: string, teamNumber: number): string {
  const letters = teamId.replace(/[^A-Za-z0-9]/g, "").slice(0, 4).toUpperCase().padEnd(4, "0");
  return `Z-${String(teamNumber)}-${letters}`;
}

// ------------------------------------------------------------------------ evidence rows

/** One evidence row in the Request verification form, as typed. */
export interface EvidenceRow {
  kind: EvidenceKind;
  summary: string;
  url: string;
}

export const EVIDENCE_KIND_WORDS: Record<EvidenceKind, { label: string; does: string; placeholder: string }> = {
  photo: {
    label: "Photo",
    does: "A photo of your robot or team banner with the claim code on a card. Paste the address where you host it.",
    placeholder: "Robot and banner with the claim code on a card",
  },
  event: {
    label: "Event",
    does: "An event result that lists your team, which the reviewer checks against FIRST's public results.",
    placeholder: "Listed at the league meet as 36596",
  },
  statement: {
    label: "Statement",
    does: "A short statement from your team, for anything a photo or result cannot show.",
    placeholder: "What the reviewer should know",
  },
};

export const emptyRow = (kind: EvidenceKind = "photo"): EvidenceRow => ({ kind, summary: "", url: "" });

/** What the rows would send, without the empty ones the team never filled in. */
export function filledRows(rows: EvidenceRow[]): EvidenceRow[] {
  return rows.filter((row) => row.summary.trim() !== "" || row.url.trim() !== "");
}

export function toInput(row: EvidenceRow): EvidenceInput {
  const url = row.url.trim();
  return url === "" ? { kind: row.kind, summary: row.summary } : { kind: row.kind, summary: row.summary, url };
}

/** Each row's problem, or null, in row order. */
export function rowProblems(rows: EvidenceRow[]): (string | null)[] {
  return rows.map((row) => (row.summary.trim() === "" && row.url.trim() === "" ? null : evidenceProblem(toInput(row))));
}

/** Why the request cannot be sent yet, or null. */
export function requestProblem(rows: EvidenceRow[], maxRows: number): string | null {
  const filled = filledRows(rows);
  if (filled.length === 0) return "Add at least one piece of evidence for the reviewer.";
  if (filled.length > maxRows) return `A request carries at most ${String(maxRows)} pieces of evidence.`;
  const problem = rowProblems(rows).find((p) => p !== null);
  return problem ?? null;
}

// ------------------------------------------------------------------------ history

/** Names for team ids, where the page knows them. */
export type TeamNames = ReadonlyMap<string, string>;

function nameOf(names: TeamNames, teamId: string): string {
  return names.get(teamId) ?? "another team";
}

/** A date as the history shows it: `2026-10-02`, in UTC so every reader sees the same day. */
export function dayWords(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** One line of the claim's history as a sentence. */
export function historySentence(entry: ClaimHistoryEntry, teamNumber: number, names: TeamNames): string {
  const team = nameOf(names, entry.teamId);
  const n = String(teamNumber);
  const reason = entry.note === undefined ? "" : ` "${entry.note}"`;
  switch (entry.kind) {
    case "claim":
      return `${team} claimed ${n}.`;
    case "request":
      return `${team} asked for ${n} to be verified.`;
    case "verify":
      return `A Horizon admin verified ${n} for ${team}.${reason}`;
    case "decline":
      return `A Horizon admin declined to verify ${n} yet.${reason}`;
    case "contest":
      return `${team} claimed ${n} too, which opened a review.`;
    case "decision":
      return `A Horizon admin gave ${n} to ${team}.${reason}`;
    case "appeal":
      return `${team} appealed the decision.${reason}`;
    case "appeal-decision":
      return `A second Horizon admin decided the appeal: ${n} stays with ${team}. This is final.${reason}`;
    case "release":
      return `${team} gave up ${n}.`;
  }
}

export interface HistoryRow {
  key: string;
  day: string;
  sentence: string;
}

/** The claim's history, oldest first. */
export function historyRows(claim: Claim | null, names: TeamNames): HistoryRow[] {
  if (claim === null) return [];
  return claim.history.map((entry, index) => ({
    key: `${String(index)}-${entry.kind}`,
    day: dayWords(entry.at),
    sentence: historySentence(entry, claim.teamNumber, names),
  }));
}

// ------------------------------------------------------------------------ requests

/** A request's state as the team reads it. */
export function requestSentence(request: VerificationRequest): string {
  if (request.decision === null) return "Waiting for a Horizon admin to review your evidence.";
  if (request.decision.verdict === "verified") return `Verified: ${request.decision.reason}`;
  return `Declined for now: ${request.decision.reason} You can ask again with more evidence.`;
}

// ------------------------------------------------------------------------ disputes

export interface DisputeSide {
  teamId: string;
  name: string;
  role: "holder" | "challenger";
  evidence: DisputeEvidence[];
  /** True when this side is the team looking at the page. */
  mine: boolean;
}

export interface DisputeView {
  id: string;
  teamNumber: number;
  /** One sentence on where the review stands. */
  state: string;
  sides: [DisputeSide, DisputeSide];
  /** The first decision's sentence, or null. */
  decision: string | null;
  /** The team the first decision gave the number to, or null before it. */
  firstWinner: string | null;
  /** The appeal's sentence, or null. */
  appeal: string | null;
  /** The appeal decision's sentence, or null. */
  appealDecision: string | null;
  /** Null when the viewing team may appeal now; otherwise why not. */
  whyNoAppeal: string | null;
  /** The last moment an appeal is accepted, or null before a decision. */
  appealClosesAt: Date | null;
  /** Whether evidence may still be added. */
  takesEvidence: boolean;
}

function stateWords(dispute: Dispute): string {
  switch (dispute.status) {
    case "open":
      return "Waiting for a Horizon admin to decide. Both teams keep working, labelled contested.";
    case "decided":
      return "Decided. The team that did not get the number may appeal once, within 14 days.";
    case "appealed":
      return "Appealed. A Horizon admin will decide, and that decision is final.";
    case "final":
      return "Final. The appeal has been decided.";
  }
}

/** A dispute as the team `viewer` sees it: both sides' evidence, the decisions, and the appeal. */
export function disputeView(dispute: Dispute, viewer: string, names: TeamNames, now: Date): DisputeView {
  const side = (teamId: string, role: DisputeSide["role"]): DisputeSide => ({
    teamId,
    name: nameOf(names, teamId),
    role,
    evidence: dispute.evidence.filter((e) => e.team === teamId),
    mine: teamId === viewer,
  });
  const decided = (winner: string, reason: string) => `${nameOf(names, winner)} gets ${String(dispute.teamNumber)}: ${reason}`;
  return {
    id: dispute.id,
    teamNumber: dispute.teamNumber,
    state: stateWords(dispute),
    sides: [side(dispute.holderTeamId, "holder"), side(dispute.challengerTeamId, "challenger")],
    decision: dispute.decision === null ? null : decided(dispute.decision.winner, dispute.decision.reason),
    firstWinner: dispute.decision?.winner ?? null,
    appeal: dispute.appeal === null ? null : `${nameOf(names, dispute.appeal.team)} appealed: ${dispute.appeal.reason}`,
    appealDecision: dispute.appealDecision === null ? null : decided(dispute.appealDecision.winner, dispute.appealDecision.reason),
    whyNoAppeal: appealProblem(dispute, viewer, now),
    appealClosesAt: appealClosesAt(dispute),
    takesEvidence: isLive(dispute),
  };
}

/** The appeal button's tooltip second line: when the window closes. */
export function appealWindowWords(closesAt: Date | null, now: Date): string {
  if (closesAt === null) return "";
  const days = Math.ceil((closesAt.getTime() - now.getTime()) / 86_400_000);
  if (days <= 0) return "The window to appeal has closed.";
  return days === 1 ? "Less than a day left to appeal." : `${String(days)} days left to appeal.`;
}

// ------------------------------------------------------------------------ the reviewer's queue

export type QueueKind = "request" | "dispute" | "appeal";

export interface QueueItem {
  kind: QueueKind;
  id: string;
  teamNumber: number;
  /** The teams involved: one for a request, two for a dispute. */
  teamIds: string[];
  /** When it started waiting. */
  since: Date;
  /** One line for the queue row. */
  title: string;
}

/**
 * The queue as a reviewer works it: appeals first (they have a deadline for the teams), then
 * disputes, then requests, each oldest first. Every appeal is listed, those the reviewer decided the
 * first time included: one Horizon admin may decide an appeal alone.
 */
export function queueItems(queue: ReviewQueue, names: TeamNames): QueueItem[] {
  const appeals: QueueItem[] = queue.appeals.map((d) => ({
      kind: "appeal",
      id: d.id,
      teamNumber: d.teamNumber,
      teamIds: [d.holderTeamId, d.challengerTeamId],
      since: d.appeal?.at ?? d.createdAt,
      title: `Appeal on ${String(d.teamNumber)}: ${nameOf(names, d.holderTeamId)} and ${nameOf(names, d.challengerTeamId)}`,
    }));
  const disputes: QueueItem[] = queue.disputes.map((d) => ({
    kind: "dispute",
    id: d.id,
    teamNumber: d.teamNumber,
    teamIds: [d.holderTeamId, d.challengerTeamId],
    since: d.createdAt,
    title: `Dispute on ${String(d.teamNumber)}: ${nameOf(names, d.holderTeamId)} and ${nameOf(names, d.challengerTeamId)}`,
  }));
  const requests: QueueItem[] = queue.requests.map((r) => ({
    kind: "request",
    id: r.id,
    teamNumber: r.teamNumber,
    teamIds: [r.teamId],
    since: r.createdAt,
    title: `Verify ${String(r.teamNumber)} for ${nameOf(names, r.teamId)}`,
  }));
  const oldest = (a: QueueItem, b: QueueItem) => a.since.getTime() - b.since.getTime();
  return [...appeals.sort(oldest), ...disputes.sort(oldest), ...requests.sort(oldest)];
}

/** The note for a reviewer who is a member of a team the item is about. */
export const MEMBER_NOTE = "You are a member of this team. Your decision is recorded with your name.";

/** The note for a reviewer deciding the appeal of their own first decision. */
export const OWN_DECISION_NOTE = "You made the first decision. Your appeal decision is recorded with your name too.";

/**
 * What the reviewer reads before deciding, in order: nothing stops them, since one Horizon admin may
 * decide every item alone, but the record will show who decided and the note says so plainly.
 * `myTeamIds` are the teams the reviewer is a member of, of any role; `firstDecisionBy` is who made
 * the first decision of an appealed dispute, or null.
 */
export function reviewerNotes(
  teamIds: readonly string[],
  myTeamIds: ReadonlySet<string>,
  firstDecisionBy: string | null,
  me: string,
): string[] {
  const notes: string[] = [];
  if (teamIds.some((id) => myTeamIds.has(id))) notes.push(MEMBER_NOTE);
  if (firstDecisionBy !== null && firstDecisionBy === me) notes.push(OWN_DECISION_NOTE);
  return notes;
}

/** Why a reviewer's decision cannot be sent yet, or null. */
export function decisionProblem(choice: string | null, reason: string): string | null {
  if (choice === null) return "Choose the outcome first.";
  return oneSentenceProblem(reason);
}

/** Every team id the queue mentions, so the page can fetch their names once. */
export function queueTeamIds(queue: ReviewQueue): string[] {
  const ids = new Set<string>();
  for (const r of queue.requests) ids.add(r.teamId);
  for (const d of [...queue.disputes, ...queue.appeals]) {
    ids.add(d.holderTeamId);
    ids.add(d.challengerTeamId);
  }
  return [...ids];
}

// ------------------------------------------------------------------------ the route

/** Whether `hash` is the review page's route, `#/admin`. */
export function isAdminHash(hash: string): boolean {
  return /^#\/admin\/?$/.test(hash.trim());
}
