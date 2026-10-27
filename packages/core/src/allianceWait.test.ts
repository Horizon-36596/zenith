import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Auto, Step } from "@horizon36596/zenith-schema";
import { describe, expect, it } from "vitest";
import {
  alliancePoseAt,
  checkAlliance,
  ownAllianceRobot,
  smallestClearingOffset,
  type AllianceRobot,
} from "./alliance.js";
import { allianceFixes, insertStartWait, insertWaitBefore, smallestClearingWait, waitTargetStepId } from "./allianceWait.js";
import { EditError } from "./edit/errors.js";
import { findStep } from "./edit/tree.js";
import type { Pose } from "./geometry/vec.js";
import { loadAuto, loadField, loadLink, loadRobot, loadWaypoints } from "./load.js";
import { plan } from "./plan.js";
import { resolve } from "./resolve.js";
import type { Finding } from "./types.js";

/**
 * The "wait before this step" fix of spec 13 section 9: the smallest wait,
 * on the 0.1 s grid, inserted before the step the user's robot runs as a collision begins, that
 * leaves no predicted ALLIANCE_COLLISION. Checked against the starter example autos.
 */

const starter = fileURLToPath(new URL("../../../examples/starter/", import.meta.url));
const read = (relative: string): unknown => JSON.parse(readFileSync(`${starter}${relative}`, "utf8"));

function starterFiles(name: string) {
  const link = loadLink(read("zenith.json"));
  const robot = loadRobot(read(link.robot));
  const field = loadField(read(link.field));
  const waypoints = loadWaypoints(read(link.waypoints ?? "autos/waypoints.json"));
  const auto = loadAuto(read(`autos/${name}.auto.json`));
  const planFor = (edited: Auto) => plan(resolve(edited, waypoints, robot), robot, field);
  return { auto, robot, field, waypoints, planFor, planned: planFor(auto) };
}

function line(from: Pose, to: Pose, durationS: number): Pose[] {
  const ticks = Math.round(durationS * 10);
  const poses: Pose[] = [];
  for (let tick = 0; tick <= ticks; tick += 1) {
    const u = ticks === 0 ? 0 : tick / ticks;
    poses.push({ xIn: from.xIn + (to.xIn - from.xIn) * u, yIn: from.yIn + (to.yIn - from.yIn) * u, headingRad: from.headingRad });
  }
  return poses;
}

/**
 * A partner with our robot's box that waits 30 in west of where our robot is at `crossingS`,
 * reaches that spot at 50 in/s exactly then, and carries on north out of the way.
 */
function partnerCrossing(own: AllianceRobot, crossingS: number): AllianceRobot {
  const at = alliancePoseAt(own, crossingS);
  const from = { xIn: at.xIn - 30, yIn: at.yIn, headingRad: 0 };
  const turn = { xIn: at.xIn, yIn: at.yIn, headingRad: 0 };
  const poses = [
    ...line(from, from, crossingS - 0.6),
    ...line(from, turn, 0.6).slice(1),
    ...line(turn, { xIn: at.xIn, yIn: at.yIn + 60, headingRad: 0 }, 1.2).slice(1),
  ];
  return {
    label: "Team Partner",
    alliance: "RED",
    startPose: poses[0] as Pose,
    boundingBox: own.boundingBox,
    poses,
    phases: [{ startS: 0, endS: (poses.length - 1) / 10, label: "drive" }],
    claims: [],
    envelopes: [],
    totalS: (poses.length - 1) / 10,
  };
}

/**
 * A partner with our robot's box that drives north across the spot where our robot is at
 * `crossingS`, reaching it at 50 in/s exactly then, after waiting 30 in south of it.
 */
function partnerNorth(own: AllianceRobot, crossingS: number): AllianceRobot {
  const at = alliancePoseAt(own, crossingS);
  const from = { xIn: at.xIn, yIn: at.yIn - 30, headingRad: Math.PI / 2 };
  const poses = [
    ...line(from, from, crossingS - 0.6),
    ...line(from, { xIn: at.xIn, yIn: at.yIn + 60, headingRad: Math.PI / 2 }, 1.8).slice(1),
  ];
  return { ...partnerCrossing(own, crossingS), startPose: poses[0] as Pose, poses, totalS: (poses.length - 1) / 10 };
}

const collisions = (findings: readonly Finding[]): Finding[] =>
  findings.filter((finding) => finding.code === "ALLIANCE_COLLISION");

const ids = (steps: readonly Step[]): (string | undefined)[] => steps.map((step) => step.id);

describe("waitTargetStepId", () => {
  const { auto } = starterFiles("all-step-kinds");

  it("keeps a step in a list that runs in order, and lifts a parallel member to its group", () => {
    expect(waitTargetStepId(auto, "scorePreload")).toBe("scorePreload");
    expect(waitTargetStepId(auto, "driveToGarden")).toBe("toGarden");
    expect(waitTargetStepId(auto, "driveBack")).toBe("returnToScore");
    expect(waitTargetStepId(auto, "clearGarden")).toBe("clearGarden");
    expect(waitTargetStepId(auto, "stopIntake")).toBe("stopIntake");
    expect(waitTargetStepId(auto, "(alliance)")).toBeNull();
  });
});

describe("insertWaitBefore", () => {
  const { auto } = starterFiles("all-step-kinds");

  it("puts the wait straight before the step, in the list that holds it", () => {
    const first = insertWaitBefore(auto, "driveOut", 0.5);
    expect(first.waitId).toBe("wait");
    expect(ids(first.auto.steps).slice(0, 3)).toEqual(["wait", "driveOut", "scorePreload"]);
    expect(first.auto.steps[0]).toEqual({ id: "wait", kind: "wait", seconds: 0.5 });

    const middle = insertWaitBefore(auto, "scorePreload", 1.2);
    expect(ids(middle.auto.steps).slice(0, 3)).toEqual(["driveOut", "wait", "scorePreload"]);

    const inSequence = insertWaitBefore(auto, "clearGarden", 0.3);
    const sequence = findStep(inSequence.auto.steps, "step", "clearThenSpinUp");
    expect(sequence?.kind === "sequence" ? ids(sequence.steps) : null).toEqual(["wait", "clearGarden", "readyLauncher"]);

    const inElse = insertWaitBefore(auto, "giveUp", 0.3);
    const branch = findStep(inElse.auto.steps, "step", "checkPollen");
    expect(branch?.kind === "branch" ? ids(branch.else ?? []) : null).toEqual(["wait", "giveUp", "parkEmpty"]);
    expect(branch?.kind === "branch" ? ids(branch.then) : null).toEqual(["stopIntake", "returnToScore", "scoreCollected"]);
  });

  it("names a second wait wait-2, leaves the input alone, and refuses a step that is not there", () => {
    const before = JSON.stringify(auto);
    const once = insertWaitBefore(auto, "driveOut", 0.5).auto;
    expect(insertWaitBefore(once, "scorePreload", 0.5).waitId).toBe("wait-2");
    expect(JSON.stringify(auto)).toBe(before);
    expect(() => insertWaitBefore(auto, "nope", 1)).toThrow(EditError);
  });
});

describe("smallestClearingWait on the starter first-auto", () => {
  // first-auto parks by driving west from its scoring pose between 3.6 s and 5.3 s; this partner
  // drives north across the park path at 5.2 s, far enough west of the scoring pose to pass a robot
  // still waiting there.
  it("clears a collision in the park step with the smallest wait before park", () => {
    const { planned, field, waypoints, planFor } = starterFiles("first-auto");
    const own = ownAllianceRobot(planned, field);
    const partner = partnerNorth(own, 5.2);
    const found = collisions(checkAlliance(own, [partner]));
    expect(found).toHaveLength(1);
    const collision = found[0] as Finding;
    expect(collision.stepId).toBe("park");

    const fix = smallestClearingWait({ plan: planned, waypoints }, [partner], collision);
    expect(fix).not.toBeNull();
    const { stepId, seconds } = fix as { stepId: string; seconds: number };
    expect(stepId).toBe("park");
    expect(seconds).toBeGreaterThan(0);
    expect(seconds).toBeLessThanOrEqual(10);
    expect(Math.round(seconds * 10)).toBeCloseTo(seconds * 10, 9);

    // The wait it names clears every collision once it is really in the auto...
    const withWait = planFor(insertWaitBefore(planned.auto, stepId, seconds).auto);
    expect(collisions(checkAlliance(ownAllianceRobot(withWait, field), [partner]))).toHaveLength(0);
    // ...and every shorter wait on the grid leaves one.
    for (let tick = 1; tick < Math.round(seconds * 10); tick += 1) {
      const shorter = planFor(insertWaitBefore(planned.auto, stepId, tick / 10).auto);
      expect(collisions(checkAlliance(ownAllianceRobot(shorter, field), [partner])), `${String(tick / 10)} s`).not.toHaveLength(0);
    }
  });

  it("agrees with the start offset for a collision in the first step", () => {
    const { planned, field, waypoints } = starterFiles("first-auto");
    const own = ownAllianceRobot(planned, field);
    const partner = partnerCrossing(own, 1);
    const collision = collisions(checkAlliance(own, [partner]))[0] as Finding;
    expect(collision.stepId).toBe("driveOut");
    const fix = smallestClearingWait({ plan: planned, waypoints }, [partner], collision);
    expect(fix?.stepId).toBe("driveOut");
    expect(fix?.seconds).toBe(smallestClearingOffset(own, [partner])?.offsetS);
  });

  it("offers nothing for a finding no wait can clear, or one that names no step", () => {
    const { planned, field, waypoints } = starterFiles("first-auto");
    const own = ownAllianceRobot(planned, field);
    const partner = partnerNorth(own, 5.2);
    const collision = collisions(checkAlliance(own, [partner]))[0] as Finding;
    const input = { plan: planned, waypoints };
    expect(smallestClearingWait(input, [partner], { ...collision, code: "ALLIANCE_START_OVERLAP" })).toBeNull();
    expect(smallestClearingWait(input, [partner], { ...collision, code: "ALLIANCE_ELEMENT_CONFLICT" })).toBeNull();
    expect(smallestClearingWait(input, [partner], { ...collision, stepId: "(alliance)" })).toBeNull();
  });
});

describe("smallestClearingWait for a near miss and an envelope", () => {
  // first-auto parks by driving west from its scoring pose, about (-12, -36), to about (-40, -36),
  // between 3.6 s and 5.3 s.
  const ofCode = (findings: readonly Finding[], code: string): Finding[] =>
    findings.filter((finding) => finding.code === code);
  const still = (own: AllianceRobot, at: Pose, extra: Partial<AllianceRobot>): AllianceRobot => ({
    label: "Team Partner",
    alliance: "RED",
    startPose: at,
    boundingBox: own.boundingBox,
    poses: [at],
    phases: [],
    claims: [],
    envelopes: [],
    totalS: 0,
    ...extra,
  });

  it("clears an envelope at the end of the park path with the smallest wait before park", () => {
    const { planned, field, waypoints, planFor } = starterFiles("first-auto");
    const own = ownAllianceRobot(planned, field);
    // A 12 in square just west of where our robot parks, reserved until 5.5 s by a partner far away.
    const polygon = [
      { xIn: -58, yIn: -48 },
      { xIn: -46, yIn: -48 },
      { xIn: -46, yIn: -36 },
      { xIn: -58, yIn: -36 },
    ];
    const partner = still(own, { xIn: 0, yIn: 40, headingRad: 0 }, { envelopes: [{ startS: 0, endS: 5.5, polygon }] });
    const entries = ofCode(checkAlliance(own, [partner]), "ALLIANCE_ENVELOPE");
    expect(entries).toHaveLength(1);
    const entry = entries[0] as Finding;
    expect(entry.stepId).toBe("park");

    const fix = smallestClearingWait({ plan: planned, waypoints }, [partner], entry);
    expect(fix?.stepId).toBe("park");
    const seconds = fix?.seconds ?? 0;
    expect(seconds).toBeGreaterThan(0);
    const findingsWith = (waitS: number): Finding[] =>
      checkAlliance(ownAllianceRobot(planFor(insertWaitBefore(planned.auto, "park", waitS).auto), field), [partner]);
    expect(ofCode(findingsWith(seconds), "ALLIANCE_ENVELOPE")).toHaveLength(0);
    expect(ofCode(findingsWith(seconds), "ALLIANCE_COLLISION")).toHaveLength(0);
    for (let tick = 1; tick < Math.round(seconds * 10); tick += 1) {
      expect(ofCode(findingsWith(tick / 10), "ALLIANCE_ENVELOPE"), `${String(tick / 10)} s`).not.toHaveLength(0);
    }
  });

  it("clears a near miss with the smallest wait that leaves neither a near miss nor a collision", () => {
    const { planned, field, waypoints, planFor } = starterFiles("first-auto");
    const own = ownAllianceRobot(planned, field);
    // A partner north-west of the park pose, close enough to pass within the near-miss margin as
    // our robot arrives, that drives north out of the way at 5.0 s.
    const from = { xIn: -44, yIn: -10, headingRad: 0 };
    const poses = [...line(from, from, 5), ...line(from, { xIn: -44, yIn: 50, headingRad: 0 }, 1.2).slice(1)];
    const partner = still(own, from, { poses, totalS: (poses.length - 1) / 10 });
    const before = checkAlliance(own, [partner]);
    expect(ofCode(before, "ALLIANCE_COLLISION")).toHaveLength(0);
    const near = ofCode(before, "ALLIANCE_NEAR_MISS");
    expect(near).toHaveLength(1);
    expect((near[0] as Finding).stepId).toBe("park");

    const fix = smallestClearingWait({ plan: planned, waypoints }, [partner], near[0] as Finding);
    expect(fix?.stepId).toBe("park");
    const seconds = fix?.seconds ?? 0;
    expect(seconds).toBeGreaterThan(0);
    const findingsWith = (waitS: number): Finding[] =>
      checkAlliance(ownAllianceRobot(planFor(insertWaitBefore(planned.auto, "park", waitS).auto), field), [partner]);
    const after = findingsWith(seconds);
    expect(ofCode(after, "ALLIANCE_NEAR_MISS")).toHaveLength(0);
    expect(ofCode(after, "ALLIANCE_COLLISION")).toHaveLength(0);
    for (let tick = 1; tick < Math.round(seconds * 10); tick += 1) {
      const shorter = findingsWith(tick / 10);
      expect(ofCode(shorter, "ALLIANCE_NEAR_MISS").length + ofCode(shorter, "ALLIANCE_COLLISION").length, `${String(tick / 10)} s`).toBeGreaterThan(0);
    }
  });
});

describe("insertStartWait: the start offset as a real wait", () => {
  it("puts a wait of the offset's length in front of the first step and leaves the input alone", () => {
    const { auto } = starterFiles("all-step-kinds");
    const before = JSON.stringify(auto);
    const { auto: edited, waitId } = insertStartWait(auto, 0.5);
    expect(waitId).toBe("wait");
    expect(edited.steps[0]).toEqual({ id: "wait", kind: "wait", seconds: 0.5 });
    expect(ids(edited.steps).slice(1)).toEqual(ids(auto.steps));
    expect(JSON.stringify(auto)).toBe(before);
    expect(insertStartWait(edited, 0.2).waitId).toBe("wait-2");
  });

  it("refuses an offset that is zero, negative or not a number", () => {
    const { auto } = starterFiles("first-auto");
    expect(() => insertStartWait(auto, 0)).toThrow(RangeError);
    expect(() => insertStartWait(auto, -0.5)).toThrow(RangeError);
    expect(() => insertStartWait(auto, Number.NaN)).toThrow(RangeError);
  });

  it("moves the robot as the start offset did, so the alliance findings stay the same", () => {
    const { planned, field, planFor } = starterFiles("first-auto");
    const own = ownAllianceRobot(planned, field);
    const partner = partnerCrossing(own, 1);
    const offsetS = 0.4;
    const waited = ownAllianceRobot(planFor(insertStartWait(planned.auto, offsetS).auto), field);
    // The instant sim spends one 10 ms loop handing over from the wait to the first path, so the
    // two agree to within that loop: a hundredth of a second, and less than an inch of travel.
    expect(Math.abs(waited.totalS - (own.totalS + offsetS))).toBeLessThanOrEqual(0.011);
    for (let tick = 0; tick <= Math.round(waited.totalS * 10); tick += 1) {
      const withOffset = alliancePoseAt(own, tick / 10, offsetS);
      const withWait = alliancePoseAt(waited, tick / 10, 0);
      const apartIn = Math.hypot(withWait.xIn - withOffset.xIn, withWait.yIn - withOffset.yIn);
      expect(apartIn, `at ${String(tick / 10)} s`).toBeLessThan(1);
    }
    expect(alliancePoseAt(waited, 0)).toEqual(alliancePoseAt(own, 0, offsetS));
    const summary = (findings: readonly Finding[]) => findings.map((finding) => [finding.code, finding.timeS]);
    expect(summary(checkAlliance(waited, [partner]))).toEqual(
      summary(checkAlliance(own, [partner], { ownStartOffsetS: offsetS })),
    );
  });
});

describe("allianceFixes: every fix the alliance view offers, for the CLI and the MCP server", () => {
  it("gives each clearable code its start offset and each clearable finding its wait, from the same searches", () => {
    const { planned, field, waypoints } = starterFiles("first-auto");
    const own = ownAllianceRobot(planned, field);
    const polygon = [
      { xIn: -58, yIn: -48 },
      { xIn: -46, yIn: -48 },
      { xIn: -46, yIn: -36 },
      { xIn: -58, yIn: -36 },
    ];
    const crossing = partnerNorth(own, 5.2);
    const reserving: AllianceRobot = {
      ...crossing,
      startPose: { xIn: 0, yIn: 40, headingRad: 0 },
      poses: [{ xIn: 0, yIn: 40, headingRad: 0 }],
      phases: [],
      envelopes: [{ startS: 0, endS: 5.5, polygon }],
      totalS: 0,
    };
    const partners = [crossing, reserving];
    const findings = checkAlliance(own, partners);
    const codes = findings.map((finding) => finding.code);
    expect(codes).toContain("ALLIANCE_COLLISION");
    expect(codes).toContain("ALLIANCE_ENVELOPE");
    // An element conflict or start overlap would have no entry; add one by hand to check.
    const withConflict: Finding[] = [...findings, { ...(findings[0] as Finding), code: "ALLIANCE_ELEMENT_CONFLICT", severity: "warning" }];

    const input = { plan: planned, waypoints };
    const fixes = allianceFixes(input, own, partners, withConflict);
    expect(Object.keys(fixes.clearingOffsets).sort()).toEqual([...new Set(codes)].sort());
    expect(fixes.clearingOffsets.ALLIANCE_COLLISION).toEqual(smallestClearingOffset(own, partners, {}, "ALLIANCE_COLLISION"));
    expect(fixes.clearingOffsets.ALLIANCE_ENVELOPE).toEqual(smallestClearingOffset(own, partners, {}, "ALLIANCE_ENVELOPE"));
    expect(fixes.clearingWaits.map((entry) => entry.findingIndex)).toEqual(findings.map((_, index) => index));
    for (const entry of fixes.clearingWaits) {
      const finding = withConflict[entry.findingIndex] as Finding;
      expect(entry.code).toBe(finding.code);
      expect(entry.wait).toEqual(smallestClearingWait(input, partners, finding));
    }
    expect(fixes.clearingWaits.some((entry) => entry.wait !== null)).toBe(true);
  }, 20000);

  it("offers nothing for findings no fix applies to", () => {
    const { planned, field, waypoints } = starterFiles("first-auto");
    const own = ownAllianceRobot(planned, field);
    expect(allianceFixes({ plan: planned, waypoints }, own, [], [])).toEqual({ clearingOffsets: {}, clearingWaits: [] });
  });
});
