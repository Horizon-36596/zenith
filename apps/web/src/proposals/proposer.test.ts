import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  allianceRobotFromProjection,
  loadField,
  loadLink,
  loadRobot,
  validateProposal,
  type AllianceRobot,
  type Finding,
  type Plan,
  type Pose,
} from "@horizon36596/zenith-core";
import { parseProjection, type Projection, type ProposalChange } from "@horizon36596/zenith-schema";
import { describe, expect, it } from "vitest";
import {
  recordEnvelope,
  recordHeading,
  recordInsertWait,
  recordMarker,
  recordMovePose,
  recordRemove,
  recordReorder,
  recordSpeed,
  recordTimeout,
  recordWaitSeconds,
  setComment,
  type DraftContext,
} from "./draft";
import { allianceFrameFor } from "../alliance/useAlliance";
import { buildProposerModel, previewAllianceFindings, previewFrameFor, type ProposerModel } from "./proposerModel";
import { linkedStarts, structureToAuto, syntheticRobot } from "./synthetic";
import { driveScale, spansOf, warpClock } from "./timing";

/**
 * The proposer's side of M-C6 (spec 13 section 14), as pure helpers: the
 * edits on the partner's structure accumulate as proposal changes that core accepts, the preview is
 * drawn from a synthetic auto, and the proposed version is timed as a partner robot the alliance
 * checks compare, so the proposer can see a predicted collision go away before sending.
 *
 * The share is the starter's own collect-and-score at the propose level (`proposeFixture.test.ts`);
 * the proposer's own robot is the starter's view partner, which starts one tile west, scores and
 * parks, and collides with it on driveOut (`s1` in the share).
 */

const starter = fileURLToPath(new URL("../../../../examples/starter/", import.meta.url));
const read = (relative: string): unknown => JSON.parse(readFileSync(`${starter}${relative}`, "utf8"));
/** The example propose share, which `proposeFixture.test.ts` keeps in step with the starter. */
const PROPOSE_FIXTURE = `${starter}partners/starter-collect-and-score.propose.projection.json`;
const link = loadLink(read("zenith.json"));
const ROBOT = loadRobot(read(link.robot));
const FIELD = loadField(read(link.field));
const SHARE: Projection = parseProjection(JSON.parse(readFileSync(PROPOSE_FIXTURE, "utf8")));
const OWN = allianceRobotFromProjection(parseProjection(read("partners/starter-partner.projection.json")), "your robot");
const SHARE_REF = { shareId: "starter-collect-and-score", revision: 1 };

const model = (changes: readonly ProposalChange[]): ProposerModel =>
  buildProposerModel({ projection: SHARE, shareRef: SHARE_REF, changes, template: ROBOT, field: FIELD, label: "Starter collect and score" });

const context = (changes: readonly ProposalChange[]): DraftContext => model(changes).context;

const collisions = (findings: readonly Finding[]): Finding[] => findings.filter((finding) => finding.code === "ALLIANCE_COLLISION");
const frame = { ownAlliance: "RED" as const, mirror: "pointSymmetry" as const };

describe("the synthetic auto drawn from a share", () => {
  it("plans with the opaque ids as step ids and the tokens as command names", () => {
    const shared = model([]);
    expect(shared.derived.plan).not.toBeNull();
    const ids = shared.derived.plan?.steps.map((step) => step.id);
    expect(ids).toEqual(["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8", "s9", "s10", "s11", "s12", "s17"]);
    const robot = syntheticRobot(ROBOT, SHARE);
    expect(robot.commands.map((command) => command.name).sort()).toEqual(["cmd1", "cmd2", "cmd3", "cmd4", "cmd5", "cmd6", "cmd7", "cmd8"]);
    expect(robot.commands.find((command) => command.name === "cmd1")?.estimateS).toBe("2.5");
    expect(JSON.stringify(robot)).not.toContain("intakeOn");
    expect(shared.findings).toEqual([]);
    expect(shared.proposal?.changes).toEqual([]);
  });

  it("writes a start that follows on from the step before as current, so moving one end moves the next start", () => {
    const structure = SHARE.structure ?? { steps: [] };
    const linked = linkedStarts(structure, SHARE.startPose);
    expect(linked.has("s1:0")).toBe(true);
    expect(linked.has("s3:0")).toBe(true);
    expect(linked.has("s13:0")).toBe(true);
    const auto = structureToAuto(structure, SHARE, { linked });
    const first = auto.steps[2];
    expect(first?.kind === "path" ? first.segments[0]?.from : null).toBe("current");
  });
});

describe("the synthetic auto of a proposal", () => {
  it("draws a start the proposal moved as that pose, and a proposed envelope on its step", () => {
    const envelope = {
      polygon: [
        { xIn: -70, yIn: -70 },
        { xIn: -50, yIn: -70 },
        { xIn: -50, yIn: -50 },
      ],
      maxDurationS: 1,
      provenance: "SET FROM EDITOR: proposed by a partner team",
    };
    let changes = recordMovePose([], context([]), "s4", { segmentIndex: 0, pointKind: "from" }, { xIn: -58, yIn: -44 });
    changes = recordEnvelope(changes, context(changes), "s6", envelope);
    const built = model(changes);
    const steps = built.derived.plan?.auto.steps ?? [];
    const sweep = steps.find((step) => step.id === "s4");
    expect(sweep?.kind === "path" ? sweep.segments[0]?.from : null).toEqual({ xIn: -58, yIn: -44, headingRad: 1.5708 });
    const stop = steps.find((step) => step.id === "s6");
    expect(stop !== undefined && "envelope" in stop ? stop.envelope : null).toEqual(envelope);
    expect(built.findings).toEqual([]);
  });
});

describe("edits on the partner's structure accumulate as changes", () => {
  it("makes a drag one movePose however many frames it has, and none once the point is back", () => {
    let changes: ProposalChange[] = [];
    for (const xIn of [-14, -15, -16, -17]) {
      changes = recordMovePose(changes, context(changes), "s1", { segmentIndex: 0, pointKind: "to" }, { xIn, yIn: -36, headingRad: 1.5708 });
    }
    expect(changes).toEqual([{ op: "movePose", stepId: "s1", segmentIndex: 0, point: "to", pose: { xIn: -17, yIn: -36 } }]);
    changes = recordMovePose(changes, context(changes), "s1", { segmentIndex: 0, pointKind: "to" }, { xIn: -13, yIn: -36, headingRad: 1.5708 });
    expect(changes).toEqual([]);
  });

  it("keeps the comment when the change it is on is replaced", () => {
    let changes = recordSpeed([], context([]), "s3", 0.6);
    changes = setComment(changes, 0, "Slower through\nthe turn so we clear you.");
    changes = recordSpeed(changes, context(changes), "s3", 0.5);
    expect(changes).toEqual([{ op: "setSpeedFraction", stepId: "s3", speedFraction: 0.5, comment: "Slower through the turn so we clear you." }]);
  });

  it("gives every kind of edit the change core expects, and core takes them all", () => {
    let changes: ProposalChange[] = [];
    const step = (edit: (current: ProposalChange[], ctx: DraftContext) => ProposalChange[]) => {
      changes = edit(changes, context(changes));
    };
    step((c, x) => recordMovePose(c, x, "s3", { segmentIndex: 0, pointKind: "control", controlIndex: 1 }, { xIn: -58, yIn: -22 }));
    step((c, x) => recordHeading(c, x, "s1", { mode: "constant", headingRad: 1.5708 }));
    step((c, x) => recordTimeout(c, x, "s2", 3));
    step((c, x) => recordInsertWait(c, x, "s2", 0.5));
    step((c, x) => recordWaitSeconds(c, x, "s15", 0.8));
    step((c, x) => recordMarker(c, x, "s4", 0, { t: 0.2 }));
    step((c, x) =>
      recordEnvelope(c, x, "s6", {
        polygon: [
          { xIn: -70, yIn: -70 },
          { xIn: -50, yIn: -70 },
          { xIn: -50, yIn: -50 },
        ],
        maxDurationS: 1,
        provenance: "SET FROM EDITOR: proposed by a partner team",
      }),
    );
    step((c, x) => recordReorder(c, x, "s17", 12, 11));
    expect(changes.map((change) => change.op)).toEqual([
      "movePose",
      "setHeading",
      "setTimeout",
      "insertWait",
      "setWait",
      "moveMarker",
      "setEnvelope",
      "reorder",
    ]);
    const built = model(changes);
    expect(built.proposalError).toBeNull();
    expect(built.findings).toEqual([]);
    expect(validateProposal(built.proposal, SHARE)).toEqual([]);
  });

  it("edits a wait the proposal added through its insertWait, and removes it by deleting that change", () => {
    let changes = recordInsertWait([], context([]), "s2", 0.5);
    const added = model(changes).context.addedIds.get(0);
    expect(added).toBe("s18");
    changes = recordWaitSeconds(changes, context(changes), "s18", 1.2);
    expect(changes).toEqual([{ op: "insertWait", afterStepId: "s2", seconds: 1.2 }]);
    changes = recordRemove(changes, context(changes), "s18");
    expect(changes).toEqual([]);
  });

  it("removes one of the share's own steps with removeStep, dropping the edits it made to it", () => {
    let changes = recordSpeed([], context([]), "s4", 0.4);
    changes = recordRemove(changes, context(changes), "s4");
    expect(changes).toEqual([{ op: "removeStep", stepId: "s4" }]);
  });

  it("never names a step the proposal added, since the owner cannot map one back", () => {
    const changes = recordInsertWait([], context([]), "s2", 0.5);
    expect(recordInsertWait(changes, context(changes), "s18", 1)).toEqual(changes);
    expect(recordReorder(changes, context(changes), "s18", 2, 0)).toEqual(changes);
  });

  it("lets core refuse what it refuses, with a sentence the change list can show", () => {
    const changes = recordRemove([], context([]), "s13");
    const built = model(changes);
    expect(built.rows[0]?.finding?.code).toBe("PROPOSAL_CHANGE");
    expect(built.rows[0]?.finding?.message).toMatch(/deadline/);
  });
});

describe("the timed preview robot", () => {
  it("uses the partner's own shared trajectory while nothing has changed", () => {
    const shared = model([]);
    expect(shared.partner.shared).toBe(true);
    expect(shared.partner.robot.totalS).toBe(SHARE.totalS);
  });

  it("times the share itself on the partner's own shared total, and a wait adds its seconds", () => {
    const moved = model(recordInsertWait([], context([]), null, 2));
    expect(moved.partner.shared).toBe(false);
    expect(moved.partner.robot.totalS).toBeCloseTo(SHARE.totalS + 2, 0);
    expect(moved.partner.robot.poses[0]).toEqual(expect.objectContaining({ xIn: -13, yIn: -63 }));
  });

  it("stretches only the driving steps", () => {
    const spans = [
      { startS: 0, endS: 2, drives: true },
      { startS: 2, endS: 5, drives: false },
      { startS: 5, endS: 6, drives: true },
    ];
    expect(driveScale(spans, 6, 9)).toBeCloseTo(2);
    const warp = warpClock(spans, 2);
    expect(warp(1)).toBeCloseTo(2);
    expect(warp(3)).toBeCloseTo(5);
    expect(warp(6)).toBeCloseTo(9);
  });

  it("stretches the paths inside a group, not the waits beside them (issue #408)", () => {
    // A sequence of a 1 s path and a wait; the partner's own run of it takes 11 s.
    const plan = {
      steps: [{ id: "s1", kind: "sequence", children: [{ id: "s2", kind: "path" }, { id: "s3", kind: "wait" }] }],
    } as unknown as Plan;
    const run = (waitS: number) => ({
      steps: [
        { id: "s1", startS: 0, endS: 1 + waitS, interrupted: false },
        { id: "s2", startS: 0, endS: 1, interrupted: false },
        { id: "s3", startS: 1, endS: 1 + waitS, interrupted: false },
      ],
    });
    const base = spansOf(plan, run(9));
    expect(base).toEqual([{ startS: 0, endS: 1, drives: true }]);
    const scale = driveScale(base, 10, 11);
    expect(scale).toBeCloseTo(2);
    // The proposal makes the wait 18 s: the path takes its 2 s and the wait its own 18 s.
    expect(warpClock(spansOf(plan, run(18)), scale)(19)).toBeCloseTo(20);
  });

  it("does not mirror a partner from the other alliance on a field with no mirror (issue #408)", () => {
    // The same run written for BLUE, on a field whose autos need no mirror, is exactly where we are.
    const twin = { ...OWN, alliance: "BLUE" as const, label: "Twin" };
    const findings = previewAllianceFindings(OWN, twin, { ownAlliance: "RED", mirror: "none" }, { ownS: 0, partnerS: 0 });
    expect(collisions(findings).length).toBeGreaterThan(0);
  });

  it("shows the predicted collision go away when the proposal holds the partner back", () => {
    const shared = model([]);
    const before = previewAllianceFindings(OWN, shared.partner.robot, frame, { ownS: 0, partnerS: 0 });
    expect(collisions(before).length).toBeGreaterThan(0);
    const waited = model(recordInsertWait([], context([]), null, 6));
    const after = previewAllianceFindings(OWN, waited.partner.robot, frame, { ownS: 0, partnerS: 0 });
    expect(collisions(after)).toEqual([]);
  });
});

describe("the preview's season hooks (issue #482)", () => {
  // The BIOBUZZ field, with the frame the alliance view binds for a RED auto on it: the field's
  // point mirror, the season's mirrorId and its claimPlace on this field.
  const biobuzz = loadField(JSON.parse(readFileSync(fileURLToPath(new URL("../../../../packages/season-biobuzz/field/biobuzz.field.json", import.meta.url)), "utf8")) as unknown);
  const hooked = previewFrameFor("RED", allianceFrameFor({ field: biobuzz, auto: { alliance: "RED" } } as unknown as Plan));
  const bare = { ownAlliance: "RED" as const, mirror: "pointSymmetry" as const };
  const offsets = { ownS: 0, partnerS: 0 };
  const scorer = (label: string, alliance: "RED" | "BLUE", pose: Pose, elementId: string, atS: number): AllianceRobot => ({
    label,
    alliance,
    startPose: pose,
    boundingBox: { lengthIn: 18, widthIn: 18, centreOffsetIn: { xIn: 0, yIn: 0 } },
    poses: [pose],
    phases: [{ startS: 0, endS: atS + 0.2, label: "score", stepId: "score" }],
    claims: [{ elementId, action: "score", atS, stepId: "score" }],
    envelopes: [],
    totalS: atS + 0.2,
  });
  const conflicts = (findings: readonly Finding[]): Finding[] => findings.filter((finding) => finding.code === "ALLIANCE_ELEMENT_CONFLICT");
  // Our robot scores into RED's up cell from the south quarter at 0.8 s, which tips the hive.
  const own = scorer("your robot", "RED", { xIn: -20, yIn: -40, headingRad: 0 }, "hiveRedUpCell", 0.8);

  it("binds the season's mirrorId and claimPlace from the plan's field", () => {
    expect(hooked.mirror).toBe("pointSymmetry");
    expect(hooked.mirrorId?.("hiveBlueUpCell")).toBe("hiveRedUpCell");
    expect(hooked.claimPlace?.("hiveRedUpCell", { xIn: -13.5, yIn: 45, headingRad: 0 })).not.toBeNull();
  });

  it("gives no element conflict when the partner scores into the other cell of the tipped hive", () => {
    // The partner scores into the up cell from the north quarter at 4.4 s: by then that is the
    // other physical cell. Compared by id alone, the two claims would be one element.
    const partner = scorer("Partner", "RED", { xIn: -13.5, yIn: 45, headingRad: 0 }, "hiveRedUpCell", 4.4);
    expect(conflicts(previewAllianceFindings(own, partner, hooked, offsets))).toEqual([]);
    expect(conflicts(previewAllianceFindings(own, partner, bare, offsets))).toHaveLength(1);
  });

  it("renames a mirrored partner's claims, so scoring into the same cell from the other alliance's file conflicts", () => {
    // Written for BLUE at the point mirror of our pose, the partner lands on our south quarter.
    const partner = scorer("Partner", "BLUE", { xIn: 20, yIn: 40, headingRad: Math.PI }, "hiveBlueUpCell", 4.4);
    expect(conflicts(previewAllianceFindings(own, partner, hooked, offsets))).toHaveLength(1);
    expect(conflicts(previewAllianceFindings(own, partner, bare, offsets))).toEqual([]);
  });
});
