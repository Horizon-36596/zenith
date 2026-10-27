/**
 * The verification UI's state (M-C7), as pure functions: the badge, the evidence rows, the history
 * sentences, the dispute view with its 14-day appeal window, and the reviewer's queue, which lists
 * appeals on the reviewer's own decisions too (owner ruling 2026-10-01), with the plain notes beside a
 * decision.
 */
import { describe, expect, it } from "vitest";
import type { Claim, Dispute, ReviewQueue, VerificationRequest } from "@horizon36596/zenith-cloud";
import {
  appealWindowWords,
  badgeFor,
  claimCode,
  decisionProblem,
  disputeView,
  emptyRow,
  filledRows,
  historyRows,
  queueItems,
  reviewerNotes,
  MEMBER_NOTE,
  OWN_DECISION_NOTE,
  queueTeamIds,
  requestProblem,
  requestSentence,
  rowProblems,
  toInput,
  isAdminHash,
} from "./model";
import { fakeVerificationDocs, FAKE, withoutClashes } from "./fakeVerification";

const DAY = 86_400_000;
const NOW = new Date("2026-10-10T12:00:00Z");
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);
const names = new Map([
  ["A", "Horizon"],
  ["B", "Demo team"],
]);

function claim(over: Partial<Claim> = {}): Claim {
  return {
    teamNumber: 36596,
    teamId: "A",
    status: "unverified",
    claimedAt: ago(20),
    historyCount: 1,
    history: [{ kind: "claim", teamId: "A", by: "u1", at: ago(20) }],
    disputeId: null,
    requestId: null,
    ...over,
  };
}

function dispute(over: Partial<Dispute> = {}): Dispute {
  return {
    id: "d1",
    teamNumber: 36596,
    holderTeamId: "A",
    challengerTeamId: "B",
    openedBy: "u2",
    createdAt: ago(5),
    status: "open",
    evidence: [],
    decision: null,
    appeal: null,
    appealDecision: null,
    ...over,
  };
}

describe("the status badge", () => {
  it("says unverified for a held, unchecked number and for a team with none", () => {
    expect(badgeFor("A", { number: 36596 }, claim(), []).status).toBe("unverified");
    expect(badgeFor("B", { number: null }, null, []).meaning).toContain("no FTC number");
  });

  it("says verified only when the team holds the number and an admin verified it", () => {
    expect(badgeFor("A", { number: 36596 }, claim({ status: "verified" }), []).status).toBe("verified");
    expect(badgeFor("B", { number: 36596 }, claim({ status: "verified" }), []).status).toBe("unverified");
  });

  it("makes both teams of a contested claim contested", () => {
    const contested = claim({ status: "contested", disputeId: "d1" });
    expect(badgeFor("A", { number: 36596 }, contested, [dispute()]).status).toBe("contested");
    expect(badgeFor("B", { number: null }, contested, [dispute()]).status).toBe("contested");
  });

  it("keeps a verified holder verified while a review of it is open", () => {
    const verified = claim({ status: "verified", disputeId: "d1" });
    expect(badgeFor("A", { number: 36596 }, verified, [dispute()]).status).toBe("verified");
    expect(badgeFor("B", { number: null }, verified, [dispute()]).meaning).toContain("review of 36596");
  });
});

describe("evidence rows", () => {
  it("ignores empty rows, and needs at least one filled one", () => {
    expect(requestProblem([emptyRow()], 6)).toBe("Add at least one piece of evidence for the reviewer.");
    expect(filledRows([emptyRow(), { kind: "statement", summary: "Ours.", url: "" }])).toHaveLength(1);
  });

  it("asks a photo or event for an https address, and never for a statement", () => {
    expect(rowProblems([{ kind: "photo", summary: "Robot.", url: "" }])[0]).toContain("https address of the photo");
    expect(rowProblems([{ kind: "event", summary: "Listed.", url: "" }])[0]).toContain("event result");
    expect(rowProblems([{ kind: "photo", summary: "Robot.", url: "http://example.org/a.jpg" }])[0]).toContain("https://");
    expect(rowProblems([{ kind: "statement", summary: "Ours.", url: "" }])[0]).toBeNull();
    expect(requestProblem([{ kind: "photo", summary: "Robot.", url: "https://example.org/a.jpg" }], 6)).toBeNull();
  });

  it("refuses more rows than a request carries", () => {
    const row = { kind: "statement" as const, summary: "Ours.", url: "" };
    expect(requestProblem(Array.from({ length: 7 }, () => row), 6)).toContain("at most 6");
  });

  it("sends a statement without an empty link", () => {
    expect(toInput({ kind: "statement", summary: "Ours.", url: " " })).toEqual({ kind: "statement", summary: "Ours." });
  });
});

describe("the claim code", () => {
  it("is the same for the team and the reviewer, from the team id and number", () => {
    expect(claimCode("fakeTeamHorizonAAAAAAA", 36596)).toBe("Z-36596-FAKE");
    expect(claimCode("a_-b", 1)).toBe("Z-1-AB00");
  });
});

describe("the claim's history", () => {
  it("reads as one sentence per step, with the reviewer's reason", () => {
    const rows = historyRows(
      claim({
        history: [
          { kind: "claim", teamId: "A", by: "u1", at: ago(20) },
          { kind: "contest", teamId: "B", by: "u2", at: ago(5), disputeId: "d1" },
          { kind: "decision", teamId: "A", by: "r1", at: ago(3), disputeId: "d1", note: "Listed at an event." },
          { kind: "appeal", teamId: "B", by: "u2", at: ago(2), disputeId: "d1", note: "Our banner." },
          { kind: "appeal-decision", teamId: "A", by: "r2", at: ago(1), disputeId: "d1", note: "The photo is clear." },
        ],
      }),
      names,
    );
    expect(rows.map((r) => r.sentence)).toEqual([
      "Horizon claimed 36596.",
      "Demo team claimed 36596 too, which opened a review.",
      'A Horizon admin gave 36596 to Horizon. "Listed at an event."',
      'Demo team appealed the decision. "Our banner."',
      'A second Horizon admin decided the appeal: 36596 stays with Horizon. This is final. "The photo is clear."',
    ]);
    expect(rows[0]?.day).toBe("2026-09-20");
  });

  it("is empty without a claim", () => {
    expect(historyRows(null, names)).toEqual([]);
  });
});

describe("requests", () => {
  const request = (decision: VerificationRequest["decision"]): VerificationRequest => ({
    id: "r1", teamNumber: 36596, teamId: "A", requestedBy: "u1", createdAt: ago(2), status: decision === null ? "open" : "decided", evidence: [], decision,
  });

  it("say where they stand, with the reviewer's reason", () => {
    expect(requestSentence(request(null))).toContain("Waiting");
    expect(requestSentence(request({ verdict: "verified", reason: "The photo shows the code.", by: "r1", at: ago(1) }))).toBe("Verified: The photo shows the code.");
    expect(requestSentence(request({ verdict: "declined", reason: "The photo has no code.", by: "r1", at: ago(1) }))).toContain("ask again");
  });
});

describe("the dispute view", () => {
  const decided = (daysAgo: number) =>
    dispute({ status: "decided", decision: { winner: "A", reason: "Listed at an event.", by: "r1", at: ago(daysAgo) } });

  it("shows both teams' evidence side by side", () => {
    const view = disputeView(
      dispute({
        evidence: [
          { team: "B", kind: "statement", summary: "Ours.", by: "u2", at: ago(4) },
          { team: "A", kind: "photo", summary: "Robot.", url: "https://example.org/a.jpg", by: "u1", at: ago(3) },
        ],
      }),
      "A",
      names,
      NOW,
    );
    expect(view.sides.map((s) => [s.name, s.role, s.evidence.length, s.mine])).toEqual([
      ["Horizon", "holder", 1, true],
      ["Demo team", "challenger", 1, false],
    ]);
    expect(view.takesEvidence).toBe(true);
    expect(view.whyNoAppeal).toBe("The review has not been decided yet.");
  });

  it("lets only the team that lost appeal, and only within 14 days", () => {
    expect(disputeView(decided(2), "B", names, NOW).whyNoAppeal).toBeNull();
    expect(disputeView(decided(2), "A", names, NOW).whyNoAppeal).toContain("nothing to appeal");
    expect(disputeView(decided(15), "B", names, NOW).whyNoAppeal).toContain("14 days");
    expect(disputeView(decided(2), "B", names, NOW).decision).toBe("Horizon gets 36596: Listed at an event.");
    expect(disputeView(decided(2), "B", names, NOW).takesEvidence).toBe(false);
  });

  it("takes one appeal only", () => {
    const appealed = dispute({
      status: "appealed",
      decision: { winner: "A", reason: "Listed.", by: "r1", at: ago(3) },
      appeal: { team: "B", by: "u2", reason: "Our banner.", at: ago(2) },
    });
    expect(disputeView(appealed, "B", names, NOW).whyNoAppeal).toContain("already been appealed");
    expect(disputeView(appealed, "B", names, NOW).appeal).toBe("Demo team appealed: Our banner.");
  });

  it("counts down the appeal window in whole days", () => {
    expect(appealWindowWords(new Date(NOW.getTime() + 12 * DAY), NOW)).toBe("12 days left to appeal.");
    expect(appealWindowWords(new Date(NOW.getTime() + DAY / 2), NOW)).toBe("Less than a day left to appeal.");
    expect(appealWindowWords(ago(1), NOW)).toBe("The window to appeal has closed.");
  });
});

describe("the reviewer's queue", () => {
  const queue: ReviewQueue = {
    requests: [
      { id: "r2", teamNumber: 2, teamId: "A", requestedBy: "u1", createdAt: ago(1), status: "open", evidence: [], decision: null },
      { id: "r1", teamNumber: 1, teamId: "A", requestedBy: "u1", createdAt: ago(3), status: "open", evidence: [], decision: null },
    ],
    disputes: [dispute({ id: "d-open" })],
    appeals: [
      dispute({ id: "mine", status: "appealed", decision: { winner: "A", reason: "x.", by: "me", at: ago(3) }, appeal: { team: "B", by: "u2", reason: "y", at: ago(2) } }),
      dispute({ id: "theirs", status: "appealed", decision: { winner: "A", reason: "x.", by: "other", at: ago(3) }, appeal: { team: "B", by: "u2", reason: "y", at: ago(2) } }),
    ],
  };

  it("puts appeals first, then disputes, then requests, each oldest first", () => {
    expect(queueItems(queue, names).map((i) => `${i.kind}:${i.id}`)).toEqual([
      "appeal:mine",
      "appeal:theirs",
      "dispute:d-open",
      "request:r1",
      "request:r2",
    ]);
  });

  it("lists appeals on the reviewer's own decisions too", () => {
    expect(queueItems(queue, names).filter((i) => i.kind === "appeal").map((i) => i.id)).toEqual(["mine", "theirs"]);
  });

  it("notes, without refusing, a decision about the reviewer's own team or own first decision", () => {
    expect(reviewerNotes(["A"], new Set(), null, "me")).toEqual([]);
    expect(reviewerNotes(["A", "B"], new Set(["B"]), null, "me")).toEqual([MEMBER_NOTE]);
    expect(reviewerNotes(["A", "B"], new Set(), "me", "me")).toEqual([OWN_DECISION_NOTE]);
    expect(reviewerNotes(["A", "B"], new Set(["A"]), "me", "me")).toEqual([MEMBER_NOTE, OWN_DECISION_NOTE]);
    expect(reviewerNotes(["A"], new Set(), "other", "me")).toEqual([]);
    expect(MEMBER_NOTE).toBe("You are a member of this team. Your decision is recorded with your name.");
  });

  it("names every team it mentions once", () => {
    expect(queueTeamIds(queue).sort()).toEqual(["A", "B"]);
  });

  it("needs an outcome and a one-sentence reason before a decision", () => {
    expect(decisionProblem(null, "Fine.")).toBe("Choose the outcome first.");
    expect(decisionProblem("verified", "")).toContain("one sentence");
    expect(decisionProblem("verified", "No full stop")).toContain("full stop");
    expect(decisionProblem("verified", "First sentence. Second sentence.")).toContain("not several");
    expect(decisionProblem("verified", "Robot photo with the claim code, and the team is listed at an event.")).toBeNull();
  });
});

describe("the route and the fake", () => {
  it("opens the review page at #/admin only", () => {
    expect(isAdminHash("#/admin")).toBe(true);
    expect(isAdminHash("#/admin/")).toBe(true);
    expect(isAdminHash("#/administrator")).toBe(false);
    expect(isAdminHash("#/review/a/b/1")).toBe(false);
  });

  it("seeds one of each item, with one reviewer who made the appealed decision", () => {
    const docs = fakeVerificationDocs(NOW.getTime());
    expect(docs[`verifications/${FAKE.request}`]?.status).toBe("open");
    expect(docs[`disputes/${FAKE.dispute}`]?.status).toBe("open");
    expect((docs[`disputes/${FAKE.appealed}`]?.decision as { by: string }).by).toBe(FAKE.reviewer);
    expect(Object.keys(docs).filter((path) => path.startsWith("admins/"))).toEqual([`admins/${FAKE.reviewer}`]);
  });

  it("names no real team: one reviewer name, and no team on Horizon's 36596", () => {
    const docs = fakeVerificationDocs(NOW.getTime());
    const text = JSON.stringify(docs);
    expect(text).not.toContain("36596");
    expect(text).not.toContain('"Horizon"');
    expect(docs[`users/${FAKE.reviewer}`]?.displayName).toBe(docs[`admins/${FAKE.reviewer}`]?.name);
  });

  it("adds nothing on a number the fake already holds, and everything when none clash", () => {
    const docs = fakeVerificationDocs(NOW.getTime());
    expect(withoutClashes(docs, () => false)).toEqual(docs);
    const kept = withoutClashes(docs, (path) => path === "claims/33333");
    const paths = Object.keys(kept);
    expect(paths.filter((path) => path.startsWith("claims/33333"))).toEqual([]);
    expect(paths.filter((path) => path.includes(FAKE.demoFive))).toEqual([]);
    expect(kept[`verifications/${FAKE.request}`]).toBeUndefined();
    // The other demonstration teams, their claims and the reviewer stay.
    expect(kept[`teams/${FAKE.demoOne}`]).toBeDefined();
    expect(kept[`disputes/${FAKE.dispute}`]).toBeDefined();
    expect(kept[`admins/${FAKE.reviewer}`]).toBeDefined();
  });
});

describe("the fake cloud, under the real rules", () => {
  it("lists one of each item for the demo reviewer, and every one can be decided", async () => {
    const { createFakeVerification } = await import("./fakeVerification");
    const backend = createFakeVerification(Date.now());
    const queue = await backend.listReviewQueue();
    expect(queueItems(queue, names).map((i) => i.kind)).toEqual(["appeal", "dispute", "request"]);
    await (await backend.decideVerification(FAKE.request, { verdict: "verified", reason: "The photo shows the claim code on the robot." })).sent;
    await (await backend.decideDispute(FAKE.dispute, { winner: FAKE.demoTwo, reason: "The registration shows Demo team two." })).sent;
    await (await backend.decideAppeal(FAKE.appealed, { winner: FAKE.demoFour, reason: "The banner photo carries the number." })).sent;
    expect(await backend.listReviewQueue()).toEqual({ requests: [], disputes: [], appeals: [] });
    expect((await backend.getClaim(33333))?.status).toBe("verified");
  });
});
