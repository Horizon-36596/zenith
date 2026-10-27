import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  applyProposalToAuto,
  canonicalize,
  loadAuto,
  loadField,
  loadLink,
  loadRobot,
  loadWaypoints,
  newProposal,
  setPose,
  setSpeed,
} from "@horizon36596/zenith-core";
import { parseProjection, type ProposalChange } from "@horizon36596/zenith-schema";
import { describe, expect, it } from "vitest";
import { closeOwnerReview, getOwnerReview, liveApplied, openOwnerReview, recordApply, type OwnerReviewState } from "./ownerStore";
import { acceptAllValid, buildOwnerReview, pinnedInputFor, PROPOSE_LEVEL, toggleAccepted } from "./review";

/**
 * The owner's side of M-C6 (spec 13 sections 14 and 16): a proposal made
 * against the example propose share opens against the starter's own collect-and-score, each change
 * says what it does in the owner's names, conflicts and misfits can only be rejected, and accepting
 * every valid change gives exactly the file the same edits by hand give.
 */

const starter = fileURLToPath(new URL("../../../../examples/starter/", import.meta.url));
const read = (relative: string): unknown => JSON.parse(readFileSync(`${starter}${relative}`, "utf8"));
/** The example propose share, which `proposeFixture.test.ts` keeps in step with the starter. */
const PROPOSE_FIXTURE = `${starter}partners/starter-collect-and-score.propose.projection.json`;
const link = loadLink(read("zenith.json"));
const FILES = {
  robot: loadRobot(read(link.robot)),
  field: loadField(read(link.field)),
  waypoints: loadWaypoints(read(link.waypoints ?? "autos/waypoints.json")),
};
const SHARE = parseProjection(JSON.parse(readFileSync(PROPOSE_FIXTURE, "utf8")));
const SHARE_REF = { shareId: "starter-collect-and-score", revision: 1 };
const AUTO = loadAuto(read("autos/collect-and-score.auto.json"));
const PINNED = pinnedInputFor(AUTO, FILES);

const CHANGES: ProposalChange[] = [
  { op: "movePose", stepId: "s3", segmentIndex: 0, point: "to", pose: { xIn: -24, yIn: 44 }, comment: "Stop a little short of the flower so we can pass." },
  { op: "setSpeedFraction", stepId: "s4", speedFraction: 0.25 },
  { op: "insertWait", afterStepId: "s2", seconds: 0.5, comment: "Give us half a second to clear the hive." },
];
const PROPOSAL = newProposal(SHARE, SHARE_REF, CHANGES);

const review = (options: { accepted?: Set<number>; current?: typeof AUTO; applied?: Set<number>; share?: "live" | "revoked" | "expired" } = {}) =>
  buildOwnerReview({
    current: options.current ?? AUTO,
    pinned: PINNED,
    files: FILES,
    proposal: PROPOSAL,
    accepted: options.accepted ?? new Set(),
    applied: options.applied ?? new Set(),
    ...(options.share === undefined ? {} : { share: options.share }),
  });

describe("the owner's review of a proposal", () => {
  it("lists each change in the owner's own names, with the proposer's comment, and nothing accepted yet", () => {
    const opened = review();
    expect(opened.refusals).toEqual([]);
    expect(opened.rows.map((row) => row.validity)).toEqual(["valid", "valid", "valid"]);
    expect(opened.rows[0]?.stepId).toBe("toOtherSide");
    expect(opened.rows[0]?.summary).toContain('"toOtherSide"');
    expect(opened.rows[0]?.comment).toBe("Stop a little short of the flower so we can pass.");
    expect(opened.rows[2]?.deltaS).toBe(0.5);
    expect(opened.toApply).toEqual([]);
    expect(canonicalize("auto", opened.proposed)).toBe(canonicalize("auto", AUTO));
  });

  it("gives, with every valid change accepted, the same canonical file as the same edits by hand", () => {
    const accepted = acceptAllValid(review());
    const chosen = review({ accepted });
    expect(chosen.toApply).toEqual([0, 1, 2]);
    const byHand = setSpeed(
      setPose(AUTO, "toOtherSide", { segmentIndex: 0, pointKind: "to" }, { xIn: -24, yIn: 44 }),
      "collectFlower",
      0.25,
    );
    const applied = applyProposalToAuto(AUTO, PINNED, PROPOSE_LEVEL, PROPOSAL, chosen.toApply, { waypoints: FILES.waypoints });
    expect(canonicalize("auto", applied.auto)).toBe(canonicalize("auto", chosen.proposed));
    expect(chosen.proposed.steps.some((step) => step.kind === "wait" && step.seconds === 0.5)).toBe(true);
    const withoutWait = applyProposalToAuto(AUTO, PINNED, PROPOSE_LEVEL, PROPOSAL, [0, 1], { waypoints: FILES.waypoints });
    expect(canonicalize("auto", withoutWait.auto)).toBe(canonicalize("auto", byHand));
    expect(chosen.model.totals.deltaS).not.toBeNull();
  });

  it("applies only what is accepted, and a rejected change stays out", () => {
    const accepted = toggleAccepted(new Set(), review(), 1, true);
    const chosen = review({ accepted });
    expect(chosen.toApply).toEqual([1]);
    expect(chosen.rows.map((row) => row.accepted)).toEqual([false, true, false]);
  });

  it("makes a change to a step that has changed since the share a conflict, which can only be rejected", () => {
    const edited = setSpeed(AUTO, "collectFlower", 0.4);
    const conflicted = review({ current: edited, accepted: new Set([0, 1, 2]) });
    const row = conflicted.rows[1];
    expect(row?.validity).toBe("conflict");
    expect(row?.reason).toMatch(/changed since the share, so it can only be rejected\.$/);
    expect(conflicted.validIndexes).toEqual([0, 2]);
    expect(toggleAccepted(new Set(), conflicted, 1, true).has(1)).toBe(false);
  });

  it("refuses the whole proposal, with a sentence, against a revoked or expired share", () => {
    for (const share of ["revoked", "expired"] as const) {
      const refused = review({ share, accepted: new Set([0]) });
      expect(refused.refusals[0]?.code).toBe("PROPOSAL_SHARE");
      expect(refused.refusals[0]?.message).toMatch(/^This share has (been revoked|expired)/);
      expect(refused.validIndexes).toEqual([]);
      expect(refused.rows.every((row) => row.validity === "refused")).toBe(true);
    }
  });

  it("refuses a proposal made against a different structure as stale", () => {
    const other = buildOwnerReview({
      current: loadAuto(read("autos/first-auto.auto.json")),
      pinned: pinnedInputFor(loadAuto(read("autos/first-auto.auto.json")), FILES),
      files: FILES,
      proposal: PROPOSAL,
      accepted: new Set(),
      applied: new Set(),
    });
    expect(other.refusals.map((finding) => finding.code)).toContain("PROPOSAL_STALE");
  });

  it("shows applied changes as applied until an undo takes the auto back", () => {
    const before = canonicalize("auto", AUTO);
    const applies = [{ indexes: [0, 1], beforeCanonical: before }];
    expect([...liveApplied({ applies }, "something else")]).toEqual([0, 1]);
    expect([...liveApplied({ applies }, before)]).toEqual([]);
    const after = applyProposalToAuto(AUTO, PINNED, PROPOSE_LEVEL, PROPOSAL, [0, 1], { waypoints: FILES.waypoints }).auto;
    const shown = review({ current: after, applied: new Set([0, 1]) });
    expect(shown.rows.map((row) => row.applied)).toEqual([true, true, false]);
    expect(shown.validIndexes).toEqual([2]);
  });

  it("forgets an undone Apply when the next Apply starts from the same auto (issue #408)", () => {
    // Apply change 0 (A to B), Undo (back to A), then Apply change 1 (A to C): change 0 is not in C.
    openOwnerReview({ applies: [], accepted: new Set([0]), rejected: new Set() } as unknown as OwnerReviewState);
    try {
      recordApply({ indexes: [0], beforeCanonical: "A" });
      expect([...liveApplied(getOwnerReview() ?? { applies: [] }, "A")]).toEqual([]);
      recordApply({ indexes: [1], beforeCanonical: "A" });
      expect([...liveApplied(getOwnerReview() ?? { applies: [] }, "C")]).toEqual([1]);
      // An Apply from a later auto keeps the earlier one, which is still in it.
      recordApply({ indexes: [2], beforeCanonical: "C" });
      expect([...liveApplied(getOwnerReview() ?? { applies: [] }, "D")]).toEqual([1, 2]);
    } finally {
      closeOwnerReview();
    }
  });
});
