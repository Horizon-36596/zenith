import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  parseProjection,
  SCHEMA_ID,
  type Auto,
  type Envelope,
  type Field,
  type Projection,
  type ProposalChange,
  type Robot,
  type Waypoints,
} from "@horizon36596/zenith-schema";
import { describe, expect, it } from "vitest";
import { allianceRobotFromProjection, checkAlliance, ownAllianceRobot } from "./alliance.js";
import { canonicalize } from "./canonicalize.js";
import { addStep, moveStep, removeStep, setEnvelope, setHeadingMode, setMarkerAt, setPose, setSpeed, setTimeout, setWait } from "./edit/index.js";
import { sha256Hex, stableJson } from "./hash.js";
import { runLedger } from "./ledger.js";
import { loadAuto, loadField, loadLink, loadRobot, loadWaypoints } from "./load.js";
import { plan } from "./plan.js";
import { projectShare, type ProjectShareInput } from "./projection.js";
import {
  applyProposalToAuto,
  applyProposalToStructure,
  diffProposal,
  newProposal,
  structureHash,
  validateProposal,
  type ProposalFinding,
} from "./proposal/index.js";
import { resolve } from "./resolve.js";
import { simulate } from "./sim/simulate.js";

/**
 * The proposal contract (spec 13 sections 14 and 16, M-C6):
 *
 * - a proposal against a view share, a revoked or expired share, a stale structure, or one that
 *   holds a token the share did not hold, is refused with a sentence saying why;
 * - accepting every change gives the same canonical file as making those edits by hand with the
 *   edit primitives, and accepting a subset applies only those;
 * - a change to a step that has changed since the share is a conflict, and can only be rejected.
 *
 * Everything runs on `examples/starter` (never the private robot example,
 * `scripts/check-example-deps.mjs`). `collect-and-score` has a marker, an end condition and a
 * wait on a condition, so tokens can be moved as well as refused.
 */

const root = fileURLToPath(new URL("../../../examples/starter/", import.meta.url));
const read = (relative: string): unknown => JSON.parse(readFileSync(`${root}${relative}`, "utf8"));

interface Files {
  robot: Robot;
  field: Field;
  waypoints: Waypoints;
}

function files(): Files {
  const link = loadLink(read("zenith.json"));
  return {
    robot: loadRobot(read(link.robot)),
    field: loadField(read(link.field)),
    waypoints: loadWaypoints(read(link.waypoints ?? "autos/waypoints.json")),
  };
}

const FILES = files();
const exampleAuto = (name: string): Auto => loadAuto(read(`autos/${name}.auto.json`));

/** Plans and simulates an auto the way the sharer's device does before it builds a projection. */
function inputsFor(auto: Auto, waypoints: Waypoints = FILES.waypoints): ProjectShareInput {
  const planned = plan(resolve(auto, waypoints, FILES.robot), FILES.robot, FILES.field, { memoize: false });
  const ledger = runLedger(planned, FILES.field);
  const trace = simulate(planned, FILES.robot, FILES.field, { ledger });
  return { plan: planned, trace, robot: FILES.robot, field: FILES.field, ledger };
}

const PROPOSE = { level: "propose" } as const;
const SHARE_REF = { shareId: "Xq4hT0share", revision: 7 };

/** The pinned revision of collect-and-score, its propose projection, and a proposal builder. */
function shared(name = "collect-and-score") {
  const auto = exampleAuto(name);
  const input = inputsFor(auto);
  const projection = projectShare(input, PROPOSE);
  const propose = (changes: ProposalChange[]) => newProposal(projection, SHARE_REF, changes);
  return { auto, input, projection, propose };
}

const TRIANGLE: Envelope = {
  polygon: [
    { xIn: -24, yIn: -48 },
    { xIn: 0, yIn: -48 },
    { xIn: 0, yIn: -24 },
  ],
  maxDurationS: 2,
  provenance: "SET FROM EDITOR: proposed by the partner team",
};

const errors = (findings: readonly ProposalFinding[]): ProposalFinding[] => findings.filter((finding) => finding.severity === "error");
const codes = (findings: readonly ProposalFinding[]): string[] => findings.map((finding) => finding.code);

/** A refusal is one or more full sentences: a capital letter first, a full stop last. */
function expectSentence(message: string): void {
  expect(message).toMatch(/^[A-Z]/);
  expect(message.trim().endsWith(".")).toBe(true);
}

// ------------------------------------------------------------------------------------------------
// The step ids in collect-and-score's propose projection (s1 to s17, in step order):
//   s1 driveOut (path)        s2 shootPreloads (command, cmd1)  s3 toOtherSide (path, bezier)
//   s4 collectFlower (path, marker cmd2, end condition cond1)   s5 waitForFull (wait until cond2)
//   s6 stopIntake (command, cmd3)   s7 toScoreNorth (path, bezier)   s8 scoreFlowerPollen (command)
//   s9 toGarden (path, bezier)   s10 sweepGarden (path, marker cmd5, end condition cond3)
//   s11 stopGardenIntake (command)   s12 returnToScore (parallel deadline s13)   s13 driveBack (path)
//   s14 clearThenSpinUp (sequence)   s15 clearGarden (wait)   s16 readyLauncher (command)
//   s17 scoreGardenPollen (command)
// ------------------------------------------------------------------------------------------------

const PARK_SEGMENT = {
  kind: "line" as const,
  from: { xIn: -12, yIn: -36, headingRad: 1.5708 },
  to: { xIn: -36, yIn: -36, headingRad: 3.1416 },
};

/** One change of nearly every kind, each against a different step, as a partner might send them. */
function everyKindOfChange(): ProposalChange[] {
  return [
    { op: "movePose", stepId: "s3", segmentIndex: 0, point: { controlIndex: 1 }, pose: { xIn: -58, yIn: -22 }, comment: "Swing wider." },
    { op: "setHeading", stepId: "s1", heading: { mode: "constant", headingRad: 1.5708 } },
    { op: "setSpeedFraction", stepId: "s3", speedFraction: 0.6 },
    { op: "setTimeout", stepId: "s2", timeoutS: 3 },
    { op: "insertWait", afterStepId: "s2", seconds: 0.5, comment: "Let us cross first." },
    { op: "setWait", stepId: "s15", seconds: 0.25 },
    { op: "moveMarker", stepId: "s4", markerIndex: 0, at: { t: 0.1 } },
    { op: "reorder", stepId: "s16", newIndex: 0 },
    { op: "setEnvelope", stepId: "s6", envelope: TRIANGLE },
    { op: "removeStep", stepId: "s5" },
    { op: "addPath", afterStepId: "s17", segments: [PARK_SEGMENT], heading: { mode: "tangent" }, endCondition: { token: "cond2" } },
    { op: "insertWait", atStart: true, seconds: 0.2 },
    { op: "movePose", stepId: "s1", segmentIndex: 0, point: "to", pose: { xIn: -12, yIn: -38, headingRad: 1.5708 } },
  ];
}

/** The same edits, made by hand with the edit primitives on the real step ids. */
function everyKindOfChangeByHand(auto: Auto, only?: readonly number[]): Auto {
  const edits: ((current: Auto) => Auto)[] = [
    (a) => setPose(a, "toOtherSide", { segmentIndex: 0, pointKind: "control", controlIndex: 1 }, { xIn: -58, yIn: -22 }),
    (a) => setHeadingMode(a, "driveOut", { mode: "constant", headingRad: 1.5708 }),
    (a) => setSpeed(a, "toOtherSide", 0.6),
    (a) => setTimeout(a, "shootPreloads", 3),
    (a) => addStep(a, { kind: "wait", seconds: 0.5 }, "shootPreloads"),
    (a) => setWait(a, "clearGarden", { seconds: 0.25 }),
    (a) => setMarkerAt(a, "collectFlower", 0, { t: 0.1 }),
    (a) => moveStep(a, "readyLauncher", { into: "clearThenSpinUp", index: 0 }),
    (a) => setEnvelope(a, "stopIntake", TRIANGLE),
    (a) => removeStep(a, "waitForFull"),
    (a) =>
      addStep(
        a,
        { kind: "path", segments: [PARK_SEGMENT], heading: { mode: "tangent" }, endCondition: { condition: "hopperFull" } },
        "scoreGardenPollen",
      ),
    (a) => {
      const appended = addStep(a, { kind: "wait", seconds: 0.2 });
      const added = appended.steps[appended.steps.length - 1];
      return moveStep(appended, added?.id ?? "", 0);
    },
    (a) => setPose(a, "driveOut", { segmentIndex: 0, pointKind: "to" }, { xIn: -12, yIn: -38, headingRad: 1.5708 }),
  ];
  return edits.reduce((current, edit, index) => (only === undefined || only.includes(index) ? edit(current) : current), auto);
}

const all = (changes: readonly unknown[]): number[] => changes.map((_, index) => index);

describe("proposals: refusals (M-C6 contract)", () => {
  it("refuses a proposal against a view share, with a sentence saying why", () => {
    const { input, propose } = shared();
    const view = projectShare(input, { level: "view" });
    const findings = validateProposal(propose([{ op: "setSpeedFraction", stepId: "s3", speedFraction: 0.5 }]), view);
    expect(codes(errors(findings))).toEqual(["PROPOSAL_SHARE"]);
    expect(findings[0]?.message).toMatch(/view only/);
    expectSentence(findings[0]?.message ?? "");
  });

  it("refuses a proposal against a revoked or an expired share", () => {
    const { projection, propose } = shared();
    const proposal = propose([{ op: "setSpeedFraction", stepId: "s3", speedFraction: 0.5 }]);
    expect(validateProposal(proposal, projection, { share: "live" })).toEqual([]);
    for (const status of ["revoked", "expired"] as const) {
      const findings = validateProposal(proposal, projection, { share: status });
      expect(codes(findings)).toEqual(["PROPOSAL_SHARE"]);
      expect(findings[0]?.message).toContain(status);
      expectSentence(findings[0]?.message ?? "");
    }
  });

  it("refuses a proposal made against a different structure, naming both hashes", () => {
    const { projection, propose } = shared();
    const other = projectShare(inputsFor(exampleAuto("all-step-kinds")), PROPOSE);
    const stale = { ...propose([{ op: "removeStep", stepId: "s3" }]), baseStructureHash: structureHash(other) };
    const findings = validateProposal(stale, projection);
    expect(codes(findings)).toEqual(["PROPOSAL_STALE"]);
    expect(findings[0]?.message).toContain(structureHash(other));
    expect(findings[0]?.message).toContain(structureHash(projection));
    expectSentence(findings[0]?.message ?? "");
  });

  it("refuses a proposal that holds a token the share did not hold", () => {
    const { projection, propose } = shared();
    const findings = validateProposal(
      propose([
        { op: "removeStep", stepId: "s4" },
        { op: "addPath", afterStepId: "s3", segments: [PARK_SEGMENT], heading: { mode: "tangent" }, markers: [{ at: { t: 0 }, token: "cmd9" }] },
      ]),
      projection,
    );
    expect(codes(errors(findings))).toEqual(["PROPOSAL_TOKEN"]);
    expect(findings[0]?.changeIndex).toBe(1);
    expect(findings[0]?.message).toMatch(/cmd9.*did not hold/);
    expectSentence(findings[0]?.message ?? "");
  });

  it("refuses a proposal that copies a token rather than moving it", () => {
    const { projection, propose } = shared();
    const copy = propose([
      { op: "addPath", afterStepId: "s17", segments: [PARK_SEGMENT], heading: { mode: "tangent" }, markers: [{ at: { t: 0 }, token: "cmd2" }] },
    ]);
    const findings = validateProposal(copy, projection);
    expect(codes(errors(findings))).toEqual(["PROPOSAL_TOKEN"]);
    expect(findings[0]?.message).toMatch(/cmd2/);
    expectSentence(findings[0]?.message ?? "");

    // Removing the path that held it first makes it a move, which is allowed.
    const move = propose([{ op: "removeStep", stepId: "s4" }, ...copy.changes]);
    expect(validateProposal(move, projection)).toEqual([]);
  });

  it("refuses removing a command, a group or a deadline, and a change the step cannot take", () => {
    const { projection, propose } = shared();
    const cases: [ProposalChange, RegExp][] = [
      [{ op: "removeStep", stepId: "s2" }, /command step.*only remove path and wait/],
      [{ op: "removeStep", stepId: "s14" }, /sequence step.*only remove path and wait/],
      [{ op: "removeStep", stepId: "s13" }, /deadline/],
      [{ op: "setSpeedFraction", stepId: "s2", speedFraction: 0.5 }, /command step.*not a path/],
      [{ op: "movePose", stepId: "s1", segmentIndex: 0, point: { controlIndex: 0 }, pose: { xIn: 0, yIn: 0 } }, /line.*no control points/],
      [{ op: "moveMarker", stepId: "s1", markerIndex: 0, at: { t: 0.5 } }, /no marker at index 0/],
      [{ op: "reorder", stepId: "s16", newIndex: 2 }, /only 2 steps/],
      [{ op: "setHeading", stepId: "s40", heading: { mode: "tangent" } }, /no step s40/],
    ];
    for (const [change, pattern] of cases) {
      const findings = validateProposal(propose([change]), projection);
      expect(codes(findings), JSON.stringify(change)).toEqual(["PROPOSAL_CHANGE"]);
      expect(findings[0]?.message, JSON.stringify(change)).toMatch(pattern);
      expectSentence(findings[0]?.message ?? "");
    }
  });

  it("refuses a change that names a step an earlier change adds, which the owner could not find (issue #408)", () => {
    const { auto, input, projection, propose } = shared();
    const proposal = propose([
      { op: "insertWait", atStart: true, seconds: 0.5 },
      { op: "setWait", stepId: "s18", seconds: 1 },
      { op: "insertWait", afterStepId: "s18", seconds: 0.25 },
    ]);
    const findings = validateProposal(proposal, projection);
    expect(findings.map((finding) => finding.changeIndex)).toEqual([1, 2]);
    for (const finding of findings) {
      expect(finding.message).toMatch(/names s18, a step an earlier change in this proposal adds/);
      expectSentence(finding.message);
    }
    // The owner's side agrees: the insertion is made, the two that name it are not.
    const applied = applyProposalToAuto(auto, input, PROPOSE, proposal, [0, 1, 2], { waypoints: FILES.waypoints });
    expect(applied.changes.map((change) => change.status)).toEqual(["applied", "invalid", "invalid"]);
  });

  it("refuses removing the last step of the auto, which the owner could never apply (issue #408)", () => {
    const base = exampleAuto("collect-and-score");
    const first = base.steps[0];
    if (first === undefined) throw new Error("no steps");
    const auto = loadAuto({ ...base, steps: [first] });
    const projection = projectShare(inputsFor(auto), PROPOSE);
    const findings = validateProposal(newProposal(projection, SHARE_REF, [{ op: "removeStep", stepId: "s1" }]), projection);
    expect(codes(findings)).toEqual(["PROPOSAL_CHANGE"]);
    expect(findings[0]?.message).toMatch(/only step left in the auto/);
    expectSentence(findings[0]?.message ?? "");
  });

  it("refuses a file that is not a proposal, such as one that tries to change a command's arguments", () => {
    const { projection, propose } = shared();
    const smuggled = { ...propose([]), changes: [{ op: "setCommandArgs", stepId: "s2", args: { count: 9 } }] };
    const findings = validateProposal(smuggled, projection);
    expect(codes(findings)).toEqual(["SCHEMA"]);
    expectSentence(findings[0]?.message ?? "");
  });

  it("is refused on the owner's side too, and then changes nothing", () => {
    const { auto, input, propose } = shared();
    const proposal = propose(everyKindOfChange());
    const text = canonicalize("auto", auto);
    const viewOnly = applyProposalToAuto(auto, input, { level: "view" }, proposal, all(proposal.changes));
    expect(codes(errors(viewOnly.findings))).toEqual(["PROPOSAL_SHARE"]);
    expect(canonicalize("auto", viewOnly.auto)).toBe(text);
    expect(viewOnly.changes.every((change) => change.status === "refused")).toBe(true);

    const revoked = applyProposalToAuto(auto, input, PROPOSE, proposal, all(proposal.changes), { share: "revoked", waypoints: FILES.waypoints });
    expect(codes(errors(revoked.findings))).toEqual(["PROPOSAL_SHARE"]);
    expect(canonicalize("auto", revoked.auto)).toBe(text);

    const edited = setSpeed(auto, "driveOut", 0.9);
    const stale = applyProposalToAuto(auto, inputsFor(edited), PROPOSE, proposal, all(proposal.changes), { waypoints: FILES.waypoints });
    expect(codes(errors(stale.findings))).toEqual(["PROPOSAL_STALE"]);
    expect(canonicalize("auto", stale.auto)).toBe(text);
  });
});

describe("proposals: accepting changes (M-C6 contract)", () => {
  it("validates a proposal of every kind of change with no findings", () => {
    const { projection, propose } = shared();
    expect(validateProposal(propose(everyKindOfChange()), projection)).toEqual([]);
  });

  it("gives, when every change is accepted, the same canonical file as making the edits by hand", () => {
    const { auto, input, propose } = shared();
    const proposal = propose(everyKindOfChange());
    const result = applyProposalToAuto(auto, input, PROPOSE, proposal, all(proposal.changes), { waypoints: FILES.waypoints });
    expect(result.findings).toEqual([]);
    expect(result.changes.map((change) => change.status)).toEqual(proposal.changes.map(() => "applied"));
    expect(canonicalize("auto", result.auto)).toBe(canonicalize("auto", everyKindOfChangeByHand(auto)));
    expect(canonicalize("auto", result.auto)).not.toBe(canonicalize("auto", auto));
  });

  it("writes a proposal in canonical form that reads back to the same proposal", () => {
    const { projection, propose } = shared();
    const proposal = propose(everyKindOfChange());
    const text = canonicalize("proposal", proposal);
    const reread = JSON.parse(text) as unknown;
    expect(canonicalize("proposal", reread)).toBe(text);
    expect(validateProposal(reread, projection)).toEqual([]);
    expect(text.indexOf('"$schema"')).toBeLessThan(text.indexOf('"changes"'));
  });

  it("applies only the accepted changes when a subset is accepted", () => {
    const { auto, input, propose } = shared();
    const proposal = propose(everyKindOfChange());
    const accepted = [1, 3, 4, 7, 11];
    const result = applyProposalToAuto(auto, input, PROPOSE, proposal, accepted, { waypoints: FILES.waypoints });
    expect(result.findings).toEqual([]);
    expect(result.changes.map((change) => change.status)).toEqual(
      proposal.changes.map((_, index) => (accepted.includes(index) ? "applied" : "notAccepted")),
    );
    expect(canonicalize("auto", result.auto)).toBe(canonicalize("auto", everyKindOfChangeByHand(auto, accepted)));
  });

  it("accepting nothing leaves the auto exactly as it was", () => {
    const { auto, input, propose } = shared();
    const result = applyProposalToAuto(auto, input, PROPOSE, propose(everyKindOfChange()), [], { waypoints: FILES.waypoints });
    expect(canonicalize("auto", result.auto)).toBe(canonicalize("auto", auto));
  });

  it("moves a token from a removed path onto a new one, as the owner would by hand", () => {
    const { auto, input, propose } = shared();
    const proposal = propose([
      { op: "removeStep", stepId: "s4" },
      {
        op: "addPath",
        afterStepId: "s3",
        segments: [{ kind: "line", from: { xIn: -24, yIn: 46, headingRad: 1.5708 }, to: { xIn: -24, yIn: 56, headingRad: 1.5708 } }],
        heading: { mode: "constant", headingRad: 1.5708 },
        speedFraction: 0.25,
        markers: [{ at: { t: 0.2 }, token: "cmd2" }],
        endCondition: { token: "cond1" },
      },
    ]);
    const result = applyProposalToAuto(auto, input, PROPOSE, proposal, [0, 1], { waypoints: FILES.waypoints });
    expect(result.findings).toEqual([]);
    const byHand = addStep(
      removeStep(auto, "collectFlower"),
      {
        kind: "path",
        segments: [{ kind: "line", from: { xIn: -24, yIn: 46, headingRad: 1.5708 }, to: { xIn: -24, yIn: 56, headingRad: 1.5708 } }],
        heading: { mode: "constant", headingRad: 1.5708 },
        speedFraction: 0.25,
        markers: [{ at: { t: 0.2 }, command: { name: "intakeOn" } }],
        endCondition: { condition: "hopperFull" },
      },
      "toOtherSide",
    );
    expect(canonicalize("auto", result.auto)).toBe(canonicalize("auto", byHand));
  });

  it("will not place a moved token when only the change that places it is accepted", () => {
    const { auto, input, propose } = shared();
    const proposal = propose([
      { op: "removeStep", stepId: "s4" },
      { op: "addPath", afterStepId: "s17", segments: [PARK_SEGMENT], heading: { mode: "tangent" }, markers: [{ at: { t: 0 }, token: "cmd2" }] },
    ]);
    const result = applyProposalToAuto(auto, input, PROPOSE, proposal, [1], { waypoints: FILES.waypoints });
    expect(codes(errors(result.findings))).toEqual(["PROPOSAL_TOKEN"]);
    expect(result.changes[1]?.status).toBe("invalid");
    expect(canonicalize("auto", result.auto)).toBe(canonicalize("auto", auto));
  });

  it("finds the right step when an insertion shifts the positional ids of steps without one", () => {
    const bare = loadAuto({
      $schema: SCHEMA_ID.auto,
      formatVersion: 3,
      name: "no-ids",
      alliance: "RED",
      start: { pose: { xIn: -12, yIn: -63, headingRad: 1.5708 } },
      steps: [
        { kind: "path", segments: [{ kind: "line", from: "current", to: { xIn: -12, yIn: -40 } }], heading: { mode: "tangent" } },
        { kind: "wait", seconds: 1 },
        { kind: "path", segments: [{ kind: "line", from: "current", to: { xIn: -30, yIn: -40 } }], heading: { mode: "tangent" } },
      ],
    });
    const input = inputsFor(bare);
    const proposal = newProposal(projectShare(input, PROPOSE), SHARE_REF, [
      { op: "insertWait", atStart: true, seconds: 0.5 },
      { op: "setSpeedFraction", stepId: "s3", speedFraction: 0.5 },
      { op: "setWait", stepId: "s2", seconds: 2 },
    ]);
    const result = applyProposalToAuto(bare, input, PROPOSE, proposal, [0, 1, 2]);
    expect(result.findings).toEqual([]);
    // By hand, after the insertion the old step3 is step4 and the old step2 is step3.
    const appended = addStep(bare, { kind: "wait", seconds: 0.5 });
    const byHand = setWait(setSpeed(moveStep(appended, "wait", 0), "step4", 0.5), "step3", { seconds: 2 });
    expect(canonicalize("auto", result.auto)).toBe(canonicalize("auto", byHand));
  });

  it("reorders a command step without duplicating it", () => {
    const { auto, input, propose } = shared();
    const proposal = propose([{ op: "reorder", stepId: "s17", newIndex: 0 }]);
    const result = applyProposalToAuto(auto, input, PROPOSE, proposal, [0], { waypoints: FILES.waypoints });
    expect(result.findings).toEqual([]);
    expect(result.auto.steps.map((step) => step.id)).toEqual(moveStep(auto, "scoreGardenPollen", 0).steps.map((step) => step.id));
    expect(result.auto.steps.filter((step) => step.id === "scoreGardenPollen")).toHaveLength(1);
  });
});

describe("proposals: conflicts (M-C6 contract)", () => {
  it("makes a change to a step changed since the share a conflict that can only be rejected", () => {
    const { auto, input, propose } = shared();
    const proposal = propose([
      { op: "setSpeedFraction", stepId: "s3", speedFraction: 0.6 },
      { op: "setHeading", stepId: "s1", heading: { mode: "constant", headingRad: 1.5708 } },
    ]);
    // The owner slowed toOtherSide down after sharing the auto.
    const current = setSpeed(auto, "toOtherSide", 0.5);

    const acceptedAll = applyProposalToAuto(current, input, PROPOSE, proposal, [0, 1], { waypoints: FILES.waypoints });
    expect(acceptedAll.changes.map((change) => change.status)).toEqual(["conflict", "applied"]);
    const conflict = errors(acceptedAll.findings);
    expect(codes(conflict)).toEqual(["PROPOSAL_CONFLICT"]);
    expect(conflict[0]?.stepId).toBe("toOtherSide");
    expect(conflict[0]?.message).toMatch(/changed since.*only be rejected/);
    expectSentence(conflict[0]?.message ?? "");
    // The conflicting change was not applied; the other one was.
    expect(canonicalize("auto", acceptedAll.auto)).toBe(
      canonicalize("auto", setHeadingMode(current, "driveOut", { mode: "constant", headingRad: 1.5708 })),
    );

    // Rejecting it is clean: the conflict is still reported, but not as an error.
    const rejected = applyProposalToAuto(current, input, PROPOSE, proposal, [1], { waypoints: FILES.waypoints });
    expect(errors(rejected.findings)).toEqual([]);
    expect(codes(rejected.findings)).toEqual(["PROPOSAL_CONFLICT"]);
    expect(rejected.changes[0]?.status).toBe("conflict");
    expect(canonicalize("auto", rejected.auto)).toBe(canonicalize("auto", acceptedAll.auto));
  });

  it("sees a step as changed when a waypoint it uses has moved, though its own text has not", () => {
    const { auto, input, propose } = shared();
    const moved: Waypoints = {
      ...FILES.waypoints,
      waypoints: { ...FILES.waypoints.waypoints, flowerNorthApproach: { xIn: -22, yIn: 46, headingRad: 1.5708 } },
    };
    const proposal = propose([{ op: "setSpeedFraction", stepId: "s3", speedFraction: 0.6 }]);
    const result = applyProposalToAuto(auto, input, PROPOSE, proposal, [0], { waypoints: moved });
    expect(result.changes[0]?.status).toBe("conflict");
    expect(codes(errors(result.findings))).toEqual(["PROPOSAL_CONFLICT"]);
  });

  it("makes a change to a step that is gone a conflict, and reorders among changed siblings too", () => {
    const { auto, input, propose } = shared();
    const current = removeStep(auto, "clearGarden");
    const proposal = propose([
      { op: "setWait", stepId: "s15", seconds: 1 },
      { op: "reorder", stepId: "s16", newIndex: 0 },
    ]);
    const result = applyProposalToAuto(current, input, PROPOSE, proposal, [0, 1], { waypoints: FILES.waypoints });
    expect(result.changes.map((change) => change.status)).toEqual(["conflict", "conflict"]);
    expect(result.findings[0]?.message).toMatch(/no longer in the auto/);
    expect(canonicalize("auto", result.auto)).toBe(canonicalize("auto", current));
  });
});

describe("proposals: the proposer's preview and the review diff", () => {
  it("applies the proposal to the projection's structure, with new steps numbered after the share's", () => {
    const { projection, propose } = shared();
    const changes = everyKindOfChange();
    const { structure, findings, addedIds } = applyProposalToStructure(projection, propose(changes));
    expect(findings).toEqual([]);
    // Every step a change added is named by the index of the change that added it.
    const adding = changes.flatMap((change, index) => (change.op === "insertWait" || change.op === "addPath" ? [index] : []));
    expect([...addedIds.keys()].sort((a, b) => a - b)).toEqual(adding);
    const ids: string[] = [];
    const walk = (steps: readonly { id: string; steps?: unknown; then?: unknown; else?: unknown }[]): void => {
      for (const step of steps) {
        ids.push(step.id);
        for (const key of ["steps", "then", "else"] as const) {
          const children = step[key];
          if (Array.isArray(children)) walk(children as never);
        }
      }
    };
    walk(structure.steps);
    expect(ids).not.toContain("s5");
    expect(ids.slice(0, 4)).toEqual(["s20", "s1", "s2", "s18"]);
    expect(ids).toContain("s19");
    for (const id of addedIds.values()) expect(ids).toContain(id);
    // The share's own structure is untouched.
    expect(projection.structure?.steps.map((step) => step.id)).toContain("s5");
  });

  it("previews a stale or refused proposal as the share's structure, with the reason", () => {
    const { input, propose } = shared();
    const view = projectShare(input, { level: "view" });
    const { structure, findings } = applyProposalToStructure(view, propose(everyKindOfChange()));
    expect(structure.steps).toEqual([]);
    expect(codes(findings)).toEqual(["PROPOSAL_SHARE"]);
  });

  it("diffs the current auto against the proposed one for review mode, step by step", () => {
    const { auto, input, propose } = shared();
    const proposal = propose(everyKindOfChange());
    const review = diffProposal(auto, input, PROPOSE, proposal, { waypoints: FILES.waypoints });
    expect(review.base).toBe(auto);
    expect(canonicalize("auto", review.proposed)).toBe(canonicalize("auto", everyKindOfChangeByHand(auto)));
    const changed = new Map(review.diff.changes.map((change) => [`${change.kind} ${change.stepId}`, change]));
    expect(changed.has("changed toOtherSide")).toBe(true);
    expect(changed.has("removed waitForFull")).toBe(true);
    expect(changed.has("added path")).toBe(true);
    expect(review.changes[0]).toMatchObject({ index: 0, number: 1, op: "movePose", stepId: "toOtherSide", status: "applied", comment: "Swing wider." });
    expect(review.changes[0]?.summary).toMatch(/^Move control point 2 of path 1 of "toOtherSide"/);
  });
});

describe("structureHash", () => {
  it("is a SHA-256 of the structure's stable form, the same after a round trip through the file", () => {
    const { projection } = shared();
    const hash = structureHash(projection);
    expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    const reread = parseProjection(JSON.parse(canonicalize("projection", projection)) as unknown);
    expect(structureHash(reread)).toBe(hash);
    expect(structureHash(projectShare(inputsFor(exampleAuto("collect-and-score")), PROPOSE))).toBe(hash);
    expect(hash).toBe(`sha256:${createHash("sha256").update(stableJson(projection.structure)).digest("hex")}`);
  });

  it("changes when any pose in the structure moves, and not with the timed layer", () => {
    const { projection } = shared();
    const hash = structureHash(projection);
    const coarse = projectShare(inputsFor(exampleAuto("collect-and-score")), { level: "propose", coarsen: true });
    expect(structureHash(coarse)).toBe(hash);
    const moved: Projection = JSON.parse(JSON.stringify(projection)) as Projection;
    const first = moved.structure?.steps[0];
    if (first?.kind !== "path") throw new Error("the first step is a path");
    first.segments[0] = { ...first.segments[0], to: { xIn: -12, yIn: -36.5, headingRad: 1.5708 } } as (typeof first.segments)[0];
    expect(structureHash(moved)).not.toBe(hash);
  });
});

describe("sha256Hex and stableJson", () => {
  it("matches the standard SHA-256 on the test vectors and on text that needs every UTF-8 length", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    for (const text of ["a".repeat(55), "a".repeat(56), "a".repeat(64), "a".repeat(1000), "é ☃ 𝄞 z", '{"xIn":-12.5}']) {
      expect(sha256Hex(text), text.slice(0, 12)).toBe(createHash("sha256").update(text, "utf8").digest("hex"));
    }
  });

  it("writes keys in order and -0 as 0, so equal data gives equal text", () => {
    expect(stableJson({ b: 1, a: [1, { d: -0, c: "x" }] })).toBe('{"a":[1,{"c":"x","d":0}],"b":1}');
    expect(stableJson({ a: undefined, b: null })).toBe('{"b":null}');
    expect(() => stableJson({ a: Number.NaN })).toThrow();
  });
});

describe("proposals: alliance findings change nothing (M-C4 contract)", () => {
  // "No alliance finding changes the result of zenith validate, deploy or propose." The proposer
  // loads the owner's propose projection as a partner beside its own auto, and the two collide; the
  // proposal's validation, the owner's apply and the review diff are the same, byte for byte, as
  // they were before the alliance check ran, and none of them carries an alliance code.
  it("validates, applies and diffs a proposal the same whether or not a colliding partner was checked", () => {
    const { auto, input, projection, propose } = shared();
    const proposal = propose([
      { op: "insertWait", atStart: true, seconds: 1, comment: "Let us clear the wall first." },
      { op: "setSpeedFraction", stepId: "s3", speedFraction: 0.6 },
    ]);
    const all = proposal.changes.map((_, index) => index);
    const results = () => {
      const applied = applyProposalToAuto(auto, input, PROPOSE, proposal, all, { waypoints: FILES.waypoints });
      return {
        validation: JSON.stringify(validateProposal(proposal, projection)),
        applied: canonicalize("auto", applied.auto),
        appliedReport: JSON.stringify({ findings: applied.findings, changes: applied.changes }),
        diff: JSON.stringify(diffProposal(auto, input, PROPOSE, proposal, { waypoints: FILES.waypoints })),
      };
    };
    const before = results();

    // The proposer's own auto starts on the same tile as the shared one, so the check finds errors.
    const ownPlan = plan(resolve(exampleAuto("first-auto"), FILES.waypoints, FILES.robot), FILES.robot, FILES.field);
    const own = ownAllianceRobot(ownPlan, FILES.field);
    const partner = allianceRobotFromProjection(parseProjection(JSON.parse(canonicalize("projection", projection))), "Team Partner");
    const findings = checkAlliance(own, [partner]);
    expect(findings.map((finding) => finding.code)).toContain("ALLIANCE_COLLISION");
    expect(findings.some((finding) => finding.severity === "error")).toBe(true);

    const after = results();
    expect(after).toEqual(before);
    for (const text of Object.values(after)) expect(text).not.toContain("ALLIANCE_");
    // And the proposal is still one the owner can take whole.
    expect(JSON.parse(after.validation)).toEqual([]);
  });
});
