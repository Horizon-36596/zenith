/**
 * The verification UI's fake cloud: an in-memory backend from `packages/cloud` (the same rules as
 * the real database), seeded with one of each thing a reviewer works on, so the review page and the
 * team's Verification section can be looked at and tested with `?cloud=fake` and no Firebase.
 *
 * PLACEHOLDER: every name, number, address and sentence below is made-up demonstration data that
 * never leaves the tab. Every team is a "Demo team" placeholder on a number chosen to look like an
 * example, and none is Horizon's 36596: a tester who made their own 36596 Horizon first would
 * otherwise find a second one. `withoutClashes` also leaves out any demonstration team whose number
 * a team in the fake already holds.
 */
import type { CloudBackend } from "@horizon36596/zenith-cloud";
import { MemoryBackend, MemoryDatabase } from "@horizon36596/zenith-cloud/memory";

/** 22-character ids, the shape the rules require of client-made ids. */
export const FAKE = {
  demoFive: "fakeTeamDemoFiveAAAAAA",
  demoOne: "fakeTeamDemoOneBBBBBBB",
  demoTwo: "fakeTeamDemoTwoCCCCCCC",
  demoThree: "fakeTeamDemoThreeDDDDD",
  demoFour: "fakeTeamDemoFourEEEEEE",
  request: "fakeRequestHorizonXXXX",
  dispute: "fakeDisputeOpenXXXXXXX",
  appealed: "fakeDisputeAppealedXXX",
  /**
   * The signed-in user and the fake's only Horizon admin. It made the appealed dispute's first
   * decision and decides the appeal too: one admin decides everything alone (owner ruling 2026-10-01).
   */
  reviewer: "fake-reviewer",
  demoOwner: "fake-demo-owner",
} as const;

const DAY_MS = 86_400_000;

/** Every fake document, seeded without the rules the way the Firebase console would write them. */
export function fakeVerificationDocs(nowMs: number): Record<string, Record<string, unknown>> {
  const ago = (days: number) => new Date(nowMs - days * DAY_MS);
  const member = (teamId: string, uid: string) => ({ uid, teamId, role: "owner", displayName: uid, joinedAt: ago(30) });
  const entry = (kind: string, teamId: string, by: string, days: number, extra: Record<string, unknown> = {}) => ({
    kind, teamId, otherTeamId: null, by, at: ago(days), ...extra,
  });
  /** A claim as the database holds it: the public claim, and one document per history step. */
  const claim = (teamNumber: number, doc: Record<string, unknown>, steps: Record<string, unknown>[]) => {
    const docs: Record<string, Record<string, unknown>> = { [`claims/${String(teamNumber)}`]: { ...doc, historyCount: steps.length } };
    steps.forEach((step, index) => {
      docs[`claims/${String(teamNumber)}/history/${String(index)}`] = step;
    });
    return docs;
  };
  const appealedReason = "The event result lists Demo team three with this number.";
  return {
    [`admins/${FAKE.reviewer}`]: { name: "Demonstration reviewer" },
    [`users/${FAKE.reviewer}`]: { displayName: "Demonstration reviewer", createdAt: ago(30) },
    [`users/${FAKE.demoOwner}`]: { displayName: "Demo owner", createdAt: ago(30) },
    [`betaTesters/${FAKE.demoOwner}`]: { name: "Demo owner" },
    [`teams/${FAKE.demoFive}`]: { number: 33333, name: "Demo team five", status: "unverified", createdBy: FAKE.demoOwner, createdAt: ago(20) },
    [`teams/${FAKE.demoFive}/members/${FAKE.demoOwner}`]: member(FAKE.demoFive, FAKE.demoOwner),
    [`teams/${FAKE.demoOne}`]: { number: 11111, name: "Demo team one", status: "contested", createdBy: FAKE.demoOwner, createdAt: ago(20) },
    [`teams/${FAKE.demoOne}/members/${FAKE.demoOwner}`]: member(FAKE.demoOne, FAKE.demoOwner),
    [`teams/${FAKE.demoTwo}`]: { number: null, name: "Demo team two", status: "unverified", createdBy: FAKE.demoOwner, createdAt: ago(20) },
    [`teams/${FAKE.demoTwo}/members/${FAKE.demoOwner}`]: member(FAKE.demoTwo, FAKE.demoOwner),
    [`teams/${FAKE.demoThree}`]: { number: 22222, name: "Demo team three", status: "verified", createdBy: FAKE.demoOwner, createdAt: ago(20) },
    [`teams/${FAKE.demoThree}/members/${FAKE.demoOwner}`]: member(FAKE.demoThree, FAKE.demoOwner),
    [`teams/${FAKE.demoFour}`]: { number: null, name: "Demo team four", status: "unverified", createdBy: FAKE.demoOwner, createdAt: ago(20) },
    [`teams/${FAKE.demoFour}/members/${FAKE.demoOwner}`]: member(FAKE.demoFour, FAKE.demoOwner),
    ...claim(
      33333,
      { teamId: FAKE.demoFive, status: "unverified", claimedAt: ago(20), disputeId: null, requestId: FAKE.request },
      [entry("claim", FAKE.demoFive, FAKE.demoOwner, 20), entry("request", FAKE.demoFive, FAKE.demoOwner, 2, { requestId: FAKE.request })],
    ),
    [`verifications/${FAKE.request}`]: {
      teamNumber: 33333, teamId: FAKE.demoFive, requestedBy: FAKE.demoOwner, createdAt: ago(2), status: "open", decision: null,
      evidence: [
        { kind: "photo", summary: "The robot with the claim code Z-33333-FAKE on a card.", url: "https://example.org/zenith-demo/robot.jpg", by: FAKE.demoOwner, at: ago(2) },
        { kind: "statement", summary: "Demo team five has competed as 33333 since its first season.", by: FAKE.demoOwner, at: ago(2) },
      ],
    },
    ...claim(
      11111,
      { teamId: FAKE.demoOne, status: "contested", claimedAt: ago(20), disputeId: FAKE.dispute, requestId: null },
      [
        entry("claim", FAKE.demoOne, FAKE.demoOwner, 20),
        entry("contest", FAKE.demoTwo, FAKE.demoOwner, 3, { disputeId: FAKE.dispute, otherTeamId: FAKE.demoOne }),
      ],
    ),
    [`disputes/${FAKE.dispute}`]: {
      teamNumber: 11111, holderTeamId: FAKE.demoOne, challengerTeamId: FAKE.demoTwo, openedBy: FAKE.demoOwner, createdAt: ago(3),
      status: "open", decision: null, appeal: null, appealDecision: null,
      evidence: [
        { team: FAKE.demoOne, kind: "event", summary: "Listed with this number at a league meet.", url: "https://example.org/zenith-demo/results", by: FAKE.demoOwner, at: ago(3) },
        { team: FAKE.demoTwo, kind: "statement", summary: "We registered this number with FIRST this season.", by: FAKE.demoOwner, at: ago(2) },
      ],
    },
    ...claim(
      22222,
      { teamId: FAKE.demoThree, status: "verified", claimedAt: ago(20), disputeId: null, requestId: null },
      [
        entry("claim", FAKE.demoFour, FAKE.demoOwner, 20),
        entry("contest", FAKE.demoThree, FAKE.demoOwner, 9, { disputeId: FAKE.appealed, otherTeamId: FAKE.demoFour }),
        entry("decision", FAKE.demoThree, FAKE.reviewer, 5, { disputeId: FAKE.appealed, note: appealedReason, otherTeamId: FAKE.demoFour }),
        entry("appeal", FAKE.demoFour, FAKE.demoOwner, 4, {
          disputeId: FAKE.appealed, note: "Our banner photo shows the number.", otherTeamId: FAKE.demoThree,
        }),
      ],
    ),
    [`disputes/${FAKE.appealed}`]: {
      teamNumber: 22222, holderTeamId: FAKE.demoFour, challengerTeamId: FAKE.demoThree, openedBy: FAKE.demoOwner, createdAt: ago(9),
      status: "appealed", appealDecision: null,
      decision: { winner: FAKE.demoThree, reason: appealedReason, by: FAKE.reviewer, at: ago(5) },
      appeal: { team: FAKE.demoFour, by: FAKE.demoOwner, reason: "Our banner photo shows the number.", at: ago(4) },
      evidence: [
        { team: FAKE.demoFour, kind: "photo", summary: "Team banner with the number.", url: "https://example.org/zenith-demo/banner.jpg", by: FAKE.demoOwner, at: ago(4) },
      ],
    },
  };
}

/**
 * The demonstration documents that can go into a fake cloud that already holds documents: a
 * demonstration claim on a number the fake already holds is left out, and so is every document
 * that names its team or that number, so the demonstration never adds a second team on a tester's
 * number or a step to a tester's claim history. `exists` says whether the fake holds a path.
 */
export function withoutClashes(
  docs: Record<string, Record<string, unknown>>,
  exists: (path: string) => boolean,
): Record<string, Record<string, unknown>> {
  const numbers = new Set<string>();
  const teamIds = new Set<string>();
  for (const [path, data] of Object.entries(docs)) {
    const match = /^claims\/(\d+)$/.exec(path);
    if (match === null || !exists(path)) continue;
    numbers.add(match[1] as string);
    if (typeof data["teamId"] === "string") teamIds.add(data["teamId"]);
  }
  if (numbers.size === 0) return docs;
  const names = (path: string, data: Record<string, unknown>): boolean => {
    const text = `${path}\n${JSON.stringify(data)}`;
    for (const id of teamIds) if (text.includes(id)) return true;
    for (const number of numbers) {
      if (path === `claims/${number}` || path.startsWith(`claims/${number}/`)) return true;
      if (data["teamNumber"] === Number(number) || data["number"] === Number(number)) return true;
    }
    return false;
  };
  return Object.fromEntries(Object.entries(docs).filter(([path, data]) => !names(path, data)));
}

/** A fake cloud signed in as the demo reviewer. */
export function createFakeVerification(nowMs: number = Date.now()): CloudBackend {
  const database = new MemoryDatabase();
  for (const [path, data] of Object.entries(fakeVerificationDocs(nowMs))) database.seed(path, data);
  const backend = new MemoryBackend({ database });
  backend.signInAs(FAKE.reviewer);
  return backend;
}
