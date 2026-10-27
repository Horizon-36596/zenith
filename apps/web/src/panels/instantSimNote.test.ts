/**
 * The timeline's note on why the instant sim's total is under the estimate (W2-18 of the 0.1.2
 * sweep): a branch side not taken, a group that ended first, a wait that ended at once, a run that
 * stopped.
 */
import { describe, expect, it } from "vitest";
import { parseAuto, SCHEMA_ID } from "@horizon36596/zenith-schema";
import type { SimStepRecord } from "@horizon36596/zenith-core";
import { indexSteps } from "../lib/stepOps";
import { instantSimNote } from "./instantSimNote";

const auto = parseAuto({
  $schema: SCHEMA_ID.auto,
  formatVersion: 3,
  name: "note-fixture",
  alliance: "RED",
  start: { pose: { xIn: 0, yIn: 0, headingRad: 0 } },
  steps: [
    { id: "pause", kind: "wait", seconds: 0.5 },
    {
      id: "collect",
      kind: "parallel",
      mode: "race",
      steps: [
        { id: "untilFull", kind: "wait", until: "hopperFull" },
        {
          id: "chores",
          kind: "sequence",
          steps: [
            { id: "first", kind: "wait", seconds: 1 },
            { id: "second", kind: "wait", seconds: 1 },
          ],
        },
      ],
    },
    {
      id: "check",
      kind: "branch",
      condition: "holdingPiece",
      then: [
        { id: "yes", kind: "wait", seconds: 1 },
        { id: "yesToo", kind: "wait", seconds: 1 },
        { id: "yesThree", kind: "wait", seconds: 1 },
      ],
      else: [{ id: "no", kind: "wait", seconds: 0.5 }],
    },
  ],
});
const entries = indexSteps(auto);
/**
 * The estimate's seconds: the then side is 3 s and the else side 0.5 s, so the estimate counts then,
 * and untilFull, with a time limit, gets 2 s.
 */
const ESTIMATE = new Map<string, number | null>([
  ["untilFull", 2],
  ["yes", 1],
  ["yesToo", 1],
  ["yesThree", 1],
  ["no", 0.5],
]);

const record = (id: string, parentId: string | null, startS: number, endS: number, extra: Partial<SimStepRecord> = {}): SimStepRecord => ({
  id,
  parentId,
  kind: "wait",
  startS,
  endS,
  interrupted: false,
  timedOut: false,
  conditionFired: false,
  unknown: false,
  ...extra,
});

const ALL_RAN: SimStepRecord[] = [
  record("pause", null, 0, 0.5),
  record("collect", null, 0.5, 2.5),
  record("untilFull", "collect", 0.5, 2.5, { conditionFired: true }),
  record("chores", "collect", 0.5, 2.5),
  record("first", "chores", 0.5, 1.5),
  record("second", "chores", 1.5, 2.5),
  record("check", null, 2.5, 5.5),
  record("yes", "check", 2.5, 3.5),
  record("yesToo", "check", 3.5, 4.5),
  record("yesThree", "check", 4.5, 5.5),
];

describe("the instant sim note", () => {
  it("is null when every step ran on the side the estimate counts", () => {
    // The then side ran, the longer one the estimate counts; that the else side did not is no news.
    expect(instantSimNote({ steps: ALL_RAN, completed: true, tickS: 0.01 }, entries, ESTIMATE)).toBeNull();
  });

  it("says which side of a branch ran and how many steps that left out", () => {
    const steps = [...ALL_RAN.filter((row) => row.parentId !== "check"), record("no", "check", 2.5, 3)];
    expect(instantSimNote({ steps, completed: true, tickS: 0.01 }, entries, ESTIMATE)).toBe(
      "The instant sim took the else side of check, so 3 steps did not run.",
    );
  });

  it("says when a group ended before steps in it started, and when a wait ended at once", () => {
    const steps = [
      record("pause", null, 0, 0.5),
      record("collect", null, 0.5, 0.51),
      record("untilFull", "collect", 0.5, 0.51, { conditionFired: true }),
      record("chores", "collect", 0.5, 0.51, { interrupted: true }),
      record("first", "chores", 0.5, 0.51, { interrupted: true }),
      record("check", null, 0.51, 1.01),
      record("no", "check", 0.51, 1.01),
    ];
    expect(instantSimNote({ steps, completed: true, tickS: 0.01 }, entries, ESTIMATE)).toBe(
      "The instant sim took the else side of check, so 3 steps did not run. chores ended before 1 step in it started. untilFull's condition already held, so it ended at once.",
    );
  });

  it("says when the run stopped before the routine ended", () => {
    const steps = ALL_RAN.slice(0, 4);
    expect(instantSimNote({ steps, completed: false, tickS: 0.01 }, entries, ESTIMATE)).toContain(
      "The instant sim stopped at 2.50 s, before the routine ended.",
    );
  });
});

describe("the plain difference (0.1.2 UX review)", () => {
  const trace = { steps: ALL_RAN, completed: true, tickS: 0.01 };

  it("says the instant sim drives within the robot's limits, and by how much, when nothing else explains the totals", () => {
    expect(instantSimNote(trace, entries, ESTIMATE, { instantS: 25.06, idealS: 24.76 })).toBe(
      "The instant sim drives the plan within the robot's limits: 0.30 s longer.",
    );
    expect(instantSimNote(trace, entries, ESTIMATE, { instantS: 24.5, idealS: 24.76 })).toBe(
      "The instant sim drives the plan within the robot's limits: 0.26 s shorter.",
    );
  });

  it("says nothing under 0.05 s, and leaves the other reasons to speak when there are any", () => {
    expect(instantSimNote(trace, entries, ESTIMATE, { instantS: 24.8, idealS: 24.76 })).toBeNull();
    expect(instantSimNote(trace, entries, ESTIMATE, { instantS: null, idealS: 24.76 })).toBeNull();
    const stopped = { steps: ALL_RAN.slice(0, 4), completed: false, tickS: 0.01 };
    expect(instantSimNote(stopped, entries, ESTIMATE, { instantS: 2.5, idealS: 24.76 })).not.toContain("within the robot's limits");
  });
});
