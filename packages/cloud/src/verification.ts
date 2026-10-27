/**
 * The checks the verification flows share (spec 13 section 4.4), pure so the client, the web app and
 * the tests all say the same thing. Each returns a sentence the app can show as it is, or null when
 * the value is fine. The security rules check the same limits (cloud/firestore.rules).
 */
import {
  APPEAL_WINDOW_DAYS,
  EVIDENCE_KINDS,
  MAX_EVIDENCE_TEXT,
  MAX_REASON_TEXT,
  type DisputeDoc,
  type EvidenceInput,
} from "./types.js";

export {
  APPEAL_WINDOW_DAYS,
  EVIDENCE_KINDS,
  MAX_DISPUTE_EVIDENCE,
  MAX_EVIDENCE_TEXT,
  MAX_REASON_TEXT,
  MAX_REQUEST_EVIDENCE,
} from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** An https address with no spaces, the shape the rules accept for evidence links. */
export function isEvidenceUrl(value: string): boolean {
  return /^https:\/\/[^\s]+$/.test(value) && value.length <= MAX_EVIDENCE_TEXT;
}

/**
 * Why `reason` is not one sentence a team can read, or null. A decision's reason is 1 to 300
 * characters on one line, ends with a full stop, question mark or exclamation mark, and has no
 * second sentence inside it.
 */
export function oneSentenceProblem(reason: string): string | null {
  const text = reason.trim();
  if (text.length === 0) return "Write the reason, in one sentence, before deciding.";
  if (text.length > MAX_REASON_TEXT) return `Keep the reason to one sentence of at most ${String(MAX_REASON_TEXT)} characters.`;
  if (/[\r\n]/.test(text)) return "Keep the reason on one line: it is one sentence.";
  if (!/[.!?]$/.test(text)) return "End the reason with a full stop: it is shown to the teams as a sentence.";
  if (/[.!?]\s+[A-Z]/.test(text.slice(0, -1))) return "Write one sentence, not several: the teams see exactly this.";
  return null;
}

/** Why one evidence row cannot be sent, or null. */
export function evidenceProblem(evidence: EvidenceInput): string | null {
  if (!EVIDENCE_KINDS.includes(evidence.kind)) return "Choose photo, event or statement for each piece of evidence.";
  const summary = evidence.summary.trim();
  if (summary.length === 0) return "Say in a few words what each piece of evidence shows.";
  if (summary.length > MAX_EVIDENCE_TEXT) return `Keep each summary to ${String(MAX_EVIDENCE_TEXT)} characters.`;
  const url = evidence.url?.trim() ?? "";
  if (url === "") {
    if (evidence.kind === "photo") return "Paste the https address of the photo; Zenith does not store photos itself.";
    if (evidence.kind === "event") return "Paste the https address of the event result that lists your team.";
    return null;
  }
  if (!isEvidenceUrl(url)) return "An evidence link must start with https:// and have no spaces.";
  return null;
}

/** The evidence as it is stored: trimmed, and without an empty link. */
export function cleanEvidence(evidence: EvidenceInput): EvidenceInput {
  const url = evidence.url?.trim() ?? "";
  const out: EvidenceInput = { kind: evidence.kind, summary: evidence.summary.trim() };
  if (url !== "") out.url = url;
  return out;
}

/** The moment the appeal window closes, or null when the dispute has no decision yet. */
export function appealClosesAt(dispute: Pick<DisputeDoc, "decision">): Date | null {
  if (dispute.decision === null) return null;
  return new Date(dispute.decision.at.getTime() + APPEAL_WINDOW_DAYS * DAY_MS);
}

/**
 * Why `teamId` cannot appeal `dispute` at `now`, or null when it can: only the team that lost, only
 * once, only within 14 days of the decision.
 */
export function appealProblem(dispute: Pick<DisputeDoc, "status" | "decision" | "appeal" | "holderTeamId" | "challengerTeamId">, teamId: string, now: Date): string | null {
  if (teamId !== dispute.holderTeamId && teamId !== dispute.challengerTeamId) return "Only the two teams in a review can appeal it.";
  if (dispute.status === "open") return "The review has not been decided yet.";
  if (dispute.appeal !== null || dispute.status === "appealed" || dispute.status === "final") {
    return "This review has already been appealed once, and the appeal's decision is final.";
  }
  if (dispute.decision === null) return "The review has not been decided yet.";
  if (dispute.decision.winner === teamId) return "Your team was given the number, so there is nothing to appeal.";
  const closes = appealClosesAt(dispute);
  if (closes !== null && now.getTime() >= closes.getTime()) {
    return `The ${String(APPEAL_WINDOW_DAYS)} days to appeal this decision have passed.`;
  }
  return null;
}
