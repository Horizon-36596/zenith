/**
 * What the Optimize card says when a run stops before it finds a route, and how it lists repeated
 * findings (issue #434). A clear path or a blocked original that the safety stop cut short said
 * "Stopped early: no faster route yet." and its Apply said there was no route at all, though Search
 * longer could still find one; three identical findings a route cleared were said three times.
 */
import { describe, expect, it } from "vitest";
import type { Finding, OptimizeResult } from "@horizon36596/zenith-core";
import { allStepLine, applyBlockedReason, CLEAR_PATH_NONE_LINE, clearsLine, findingKinds, NOTHING_YET_REASON, resultLine, resultTone, stoppedLine, STOPPED_LINE } from "./OptimizeCard";
import type { ClearPathDraft } from "./clearPath";
import type { OptimizeCardState } from "./state";

/** A result with no route, as a stop before the search found one gives. */
const empty = (status: OptimizeResult["status"], blocked = false): OptimizeResult =>
  ({
    stepId: "toOtherSide",
    status,
    pick: null,
    alternatives: [],
    step: null,
    evaluations: 120,
    budget: 250,
    scorer: "sim",
    marginIn: 1,
    closest: null,
    changes: [],
    notes: [],
    originalBlocked: blocked ? { label: "the west base bar of the hive frame", phrase: "goes through the west base bar of the hive frame" } : null,
  }) as unknown as OptimizeResult;

const cardWith = (result: OptimizeResult, extra: Partial<OptimizeCardState> = {}): OptimizeCardState => ({
  stepId: result.stepId,
  mode: "routeAndHeading",
  action: null,
  phase: "result",
  marginIn: 1,
  robotMarginIn: 1,
  progress: null,
  result,
  paused: true,
  stopReason: "safety",
  continued: false,
  stale: false,
  message: null,
  draft: null,
  choice: 0,
  all: null,
  ...extra,
});

const draft = { chainId: null, stepId: "path8" } as unknown as ClearPathDraft;

const structure = (id: string): Finding => ({ code: "STRUCTURE", severity: "error", stepId: "toOtherSide", message: `The robot hits ${id}.` }) as Finding;

describe("a run that stopped before it found a route", () => {
  it("says it found no faster route yet on a plain step, no clear route round a blocked one, and no clear path to a spot", () => {
    expect(resultLine(cardWith(empty("stoppedEarly")), empty("stoppedEarly"))).toBe("Searched for 5 s: no faster route yet.");
    expect(resultLine(cardWith(empty("stoppedEarly", true)), empty("stoppedEarly", true))).toBe("Searched for 5 s: no clear route yet.");
    expect(resultLine(cardWith(empty("stoppedEarly"), { draft }), empty("stoppedEarly"))).toBe("Searched for 5 s: no clear path yet.");
  });

  it("says the 5 s time box searched, the ordinary end of a run, and keeps Stopped early for the person's Stop (0.1.2 UX review)", () => {
    expect(stoppedLine(cardWith(empty("stoppedEarly")))).toBe("Searched for 5 s: the best route so far.");
    expect(stoppedLine(cardWith(empty("stoppedEarly"), { continued: true }))).toBe("Searched 5 s more: the best route so far.");
    expect(stoppedLine(cardWith(empty("stoppedEarly"), { stopReason: "stop" }))).toBe(STOPPED_LINE);
    expect(resultLine(cardWith(empty("stoppedEarly"), { stopReason: "stop" }), empty("stoppedEarly"))).toBe("Stopped early: no faster route yet.");
  });

  it("says Apply is off because nothing is found yet, with Search longer, not that there is no route", () => {
    expect(applyBlockedReason(cardWith(empty("stoppedEarly")))).toBe(NOTHING_YET_REASON);
    expect(applyBlockedReason(cardWith(empty("stoppedEarly"), { draft }))).toBe(NOTHING_YET_REASON);
    // A run that ended on its own with nothing keeps its own reasons.
    expect(applyBlockedReason(cardWith(empty("noBetter"), { paused: false, stopReason: null }))).toBe("There is no faster route to apply.");
    expect(applyBlockedReason(cardWith(empty("infeasible"), { paused: false, stopReason: null, draft }))).toBe(
      "There is no clear path to this spot. Right-click somewhere clear of the structures.",
    );
  });

  it("says a clear path with no route round the structures found none, never core's sentence about an original it does not have", () => {
    const none = { ...empty("infeasible", true), changes: ["The original goes through the west base bar of the hive frame, and no clear route was found between the step's two ends."] } as OptimizeResult;
    expect(resultLine(cardWith(none, { draft, paused: false, stopReason: null }), none)).toBe(CLEAR_PATH_NONE_LINE);
    expect(resultLine(cardWith(none, { paused: false, stopReason: null }), none)).toBe(none.changes[0]);
  });

  it("is listed in Optimize every path as searched for 5 s, or stopped early after Stop, not as no route found", () => {
    expect(allStepLine({ stepId: "driveOut", result: empty("stoppedEarly"), message: null, accepted: false, stopReason: "safety" })).toBe(
      "driveOut: searched for 5 s, no faster route yet",
    );
    expect(allStepLine({ stepId: "driveOut", result: empty("stoppedEarly"), message: null, accepted: false, stopReason: "stop" })).toBe(
      "driveOut: stopped early, no faster route yet",
    );
    expect(allStepLine({ stepId: "driveOut", result: empty("noBetter"), message: null, accepted: false })).toBe("driveOut: No faster route found");
  });
});

describe("findings the card lists", () => {
  it("says each kind once with its count, in the order each first appears", () => {
    const findings = [structure("the west bar"), structure("the east bar"), structure("a leg")];
    expect(clearsLine(findings)).toBe("Clears 3 errors (hits a field element).");
    const warning: Finding = { code: "STRAFE_FRACTION", severity: "warning", stepId: "toOtherSide", message: "Sideways." } as Finding;
    const kinds = findingKinds([warning, ...findings, warning]);
    expect(kinds.map((kind) => kind.severity)).toEqual(["warning", "error"]);
    expect(kinds[0]?.phrase).toMatch(/^2 warnings: /);
    expect(kinds[1]?.phrase).toMatch(/^3 errors: /);
    expect(findingKinds([warning])[0]?.phrase).toMatch(/^a warning: /);
  });
});

describe("the clears line (0.1.2 UX review)", () => {
  it("is one sentence grouped by severity, counting a kind only when its severity has more than one", () => {
    const centre: Finding = { code: "OPPONENT_SIDE", severity: "error", stepId: "toOtherSide", message: "Over the line." } as Finding;
    const sideways: Finding = { code: "STRAFE_FRACTION", severity: "warning", stepId: "toOtherSide", message: "Sideways." } as Finding;
    const findings = [structure("a"), structure("b"), structure("c"), centre, sideways];
    expect(clearsLine(findings)).toBe("Clears 4 errors (hits a field element 3 times, crosses the centre line) and a warning (driving sideways).");
    expect(clearsLine([sideways])).toBe("Clears a warning (driving sideways).");
  });
});

describe("the headline's tone (0.1.2 UX review)", () => {
  const routeOf = (beforeS: number, afterS: number) => ({
    step: { id: "toOtherSide", kind: "path", segments: [] },
    label: null,
    t0: { before: { windowEndS: beforeS, ownS: beforeS }, after: { windowEndS: afterS, ownS: afterS } },
    t1: { before: { windowEndS: beforeS, ownS: beforeS }, after: { windowEndS: afterS, ownS: afterS } },
    gainS: null,
    closest: null,
    movedMarkers: [],
    findingsAdded: [],
    findingsRemoved: [],
    changes: [],
    note: null,
  });
  const withPick = (beforeS: number, afterS: number): OptimizeResult => ({ ...empty("improved"), pick: routeOf(beforeS, afterS) }) as unknown as OptimizeResult;
  const done = { paused: false, stopReason: null };

  it("is ok for a faster route, neutral for nothing better and blocked when no route can be clear", () => {
    expect(resultTone(cardWith(withPick(3, 2.3), done), withPick(3, 2.3))).toBe("ok");
    expect(resultTone(cardWith(withPick(3, 3), done), withPick(3, 3))).toBe("neutral");
    expect(resultTone(cardWith(empty("noBetter"), done), empty("noBetter"))).toBe("neutral");
    expect(resultTone(cardWith(empty("stoppedEarly")), empty("stoppedEarly"))).toBe("neutral");
    const inside = { ...empty("infeasible"), closest: { step: null, kind: "keepOut", id: "x", shortfallIn: 1 } } as unknown as OptimizeResult;
    expect(resultTone(cardWith(inside, done), inside)).toBe("blocked");
    expect(resultTone(cardWith(empty("infeasible", true), done), empty("infeasible", true))).toBe("blocked");
    expect(resultTone(cardWith(empty("infeasible"), { ...done, draft }), empty("infeasible"))).toBe("blocked");
    expect(resultTone(cardWith(empty("noBetter"), { ...done, draft }), empty("noBetter"))).toBe("ok");
  });
});
