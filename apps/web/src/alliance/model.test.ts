import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ALLIANCE_TICK_S, alliancePoseAt, loadField, type AllianceRobot, type Plan, type Pose } from "@horizon36596/zenith-core";
import { SCHEMA_ID, type Projection } from "@horizon36596/zenith-schema";
import { describe, expect, it } from "vitest";
import {
  alignedPartner,
  allianceKey,
  allianceRunS,
  buildPartnerScene,
  computeAlliance,
  findingAllianceS,
  identityOf,
  laneGeometry,
  lastValueMemo,
  MAX_START_OFFSET_S,
  nextColour,
  ownLocalS,
  partnerEndS,
  partnerLabel,
  partnerLane,
  partnerLocalS,
  snapOffset,
  type AllianceFrame,
  type PartnerEntry,
} from "./model";
import { fileSource, readPartnerText } from "./source";
import { allianceFrameFor } from "./useAlliance";

/**
 * The alliance view's pure pieces: names, colours and offsets, the alliance clock, the memo key,
 * the scene the canvas draws and the lanes the timeline draws.
 */

/** A projection that drives straight between two points, one row every 0.1 s: south through the origin at 1.0 s by default. */
function projection(overrides: Partial<Projection> = {}, from: Pose = { xIn: 0, yIn: 60, headingRad: 0 }, to: Pose = { xIn: 0, yIn: -60, headingRad: 0 }, durationS = 2): Projection {
  const ticks = Math.round(durationS / ALLIANCE_TICK_S);
  const poses: [number, number, number][] = [];
  for (let tick = 0; tick <= ticks; tick += 1) {
    const u = tick / ticks;
    poses.push([from.xIn + (to.xIn - from.xIn) * u, from.yIn + (to.yIn - from.yIn) * u, from.headingRad]);
  }
  return {
    $schema: SCHEMA_ID.projection,
    formatVersion: 1,
    kind: "projection",
    level: "view",
    season: "biobuzz",
    alliance: "RED",
    title: "Test partner",
    startPose: { ...from },
    boundingBox: { lengthIn: 18, widthIn: 18, centreOffsetIn: { xIn: 0, yIn: 0 } },
    trajectory: { rateHz: 10, positionQuantumIn: 0.5, headingQuantumRad: 0.0175, poses },
    phases: [{ startS: 0, endS: durationS, label: "drive" }],
    claims: [],
    envelopes: [],
    totalS: durationS,
    ...overrides,
  };
}

function entry(overrides: Partial<PartnerEntry> = {}): PartnerEntry {
  const shared = overrides.projection ?? projection();
  return {
    id: "partner1",
    fileName: "test.projection.json",
    projection: shared,
    label: "Test partner",
    colour: 0,
    visible: true,
    offsetS: 0,
    ...overrides,
  };
}

/** Our robot: east along y = 0 through the origin at 1.0 s, the partner's crossing point. */
function ownRobot(): AllianceRobot {
  const poses: Pose[] = [];
  for (let tick = 0; tick <= 20; tick += 1) poses.push({ xIn: -60 + 6 * tick, yIn: 0, headingRad: 0 });
  return {
    label: "your robot",
    alliance: "RED",
    startPose: poses[0] as Pose,
    boundingBox: { lengthIn: 18, widthIn: 18, centreOffsetIn: { xIn: 0, yIn: 0 } },
    poses,
    phases: [{ startS: 0, endS: 2, label: "drive", stepId: "cross" }],
    claims: [],
    envelopes: [],
    totalS: 2,
  };
}

const RED: AllianceFrame = { alliance: "RED", mirror: "pointSymmetry" };

describe("names, colours and offsets", () => {
  it("names a partner by its title, else by its file without .projection.json", () => {
    expect(partnerLabel({ title: "Team partner" }, "x.json")).toBe("Team partner");
    expect(partnerLabel({}, "shares/near-side.projection.json")).toBe("near-side");
    expect(partnerLabel({ title: "  " }, "C:\\shares\\far.json")).toBe("far");
    expect(partnerLabel({}, ".json")).toBe("Partner");
  });

  it("gives each new partner the first free colour, and cycles once all are taken", () => {
    expect(nextColour([])).toBe(0);
    expect(nextColour([{ colour: 0 }, { colour: 2 }])).toBe(1);
    expect(nextColour([{ colour: 0 }, { colour: 1 }, { colour: 2 }])).toBe(0);
    expect(nextColour([{ colour: 0 }, { colour: 1 }, { colour: 2 }, { colour: 0 }])).toBe(1);
  });

  it("snaps an offset onto the 0.1 s grid between 0 s and 30 s", () => {
    expect(snapOffset(0.74)).toBe(0.7);
    expect(snapOffset(0.75)).toBe(0.8);
    expect(snapOffset(-2)).toBe(0);
    expect(snapOffset(99)).toBe(MAX_START_OFFSET_S);
    expect(snapOffset(Number.NaN)).toBe(0);
  });
});

describe("the alliance clock", () => {
  it("holds each robot at its start while its offset runs", () => {
    expect(ownLocalS(0.3, 0.5)).toBe(0);
    expect(ownLocalS(1.5, 0.5)).toBe(1);
    expect(partnerLocalS(2, 0)).toBe(2);
    expect(partnerLocalS(0.2, 1)).toBe(0);
  });

  it("puts a finding at its own time, which already counts every offset", () => {
    expect(findingAllianceS({ timeS: 4.2 })).toBe(4.2);
    expect(findingAllianceS({})).toBe(0);
  });

  it("runs the scrubber until the last robot has finished, counting visible partners only", () => {
    const long = entry({ projection: projection({ totalS: 6 }), offsetS: 1 });
    expect(partnerEndS(long.projection, long.offsetS)).toBe(7);
    expect(allianceRunS(5, 0.5, [long])).toBe(7);
    expect(allianceRunS(5, 3, [long])).toBe(8);
    expect(allianceRunS(5, 0, [{ ...long, visible: false }])).toBe(5);
    expect(allianceRunS(null, 0, [long])).toBeNull();
    const reserved = projection({ envelopes: [{ startS: 1, endS: 9, polygon: [{ xIn: 0, yIn: 0 }, { xIn: 1, yIn: 0 }, { xIn: 0, yIn: 1 }] }] });
    expect(partnerEndS(reserved, 0)).toBe(9);
  });
});

describe("the memo key", () => {
  const own = ownRobot();
  const base = [entry()];

  it("changes with anything the checks read", () => {
    const key = allianceKey(own, 0, RED, base);
    expect(allianceKey(own, 0, RED, base)).toBe(key);
    expect(allianceKey(ownRobot(), 0, RED, base)).not.toBe(key);
    expect(allianceKey(own, 0.5, RED, base)).not.toBe(key);
    expect(allianceKey(own, 0, { ...RED, alliance: "BLUE" }, base)).not.toBe(key);
    expect(allianceKey(own, 0, RED, [{ ...base[0]!, offsetS: 1 }])).not.toBe(key);
    expect(allianceKey(own, 0, RED, [{ ...base[0]!, visible: false }])).not.toBe(key);
    expect(allianceKey(own, 0, RED, [{ ...base[0]!, projection: projection() }])).not.toBe(key);
    expect(allianceKey(own, 0, RED, [])).not.toBe(key);
  });

  it("does not change with a partner's colour or file name, which the checks never read", () => {
    const key = allianceKey(own, 0, RED, base);
    const recoloured: PartnerEntry = { ...base[0]!, colour: 2, fileName: "other.json" };
    expect(allianceKey(own, 0, RED, [recoloured])).toBe(key);
  });

  it("gives one object one identity", () => {
    const value = {};
    expect(identityOf(value)).toBe(identityOf(value));
    expect(identityOf({})).not.toBe(identityOf(value));
  });

  it("computes once per key", () => {
    const memo = lastValueMemo<number>();
    let calls = 0;
    const compute = (): number => {
      calls += 1;
      return calls;
    };
    expect(memo("a", compute)).toBe(1);
    expect(memo("a", compute)).toBe(1);
    expect(memo("b", compute)).toBe(2);
    expect(memo("a", compute)).toBe(3);
  });
});

describe("computeAlliance", () => {
  it("finds the crossing, names its partner, and proposes the delay that clears it", () => {
    const result = computeAlliance(ownRobot(), [entry()], 0, RED);
    const collisions = result.findings.filter((item) => item.finding.code === "ALLIANCE_COLLISION");
    expect(collisions).toHaveLength(1);
    expect(collisions[0]?.partnerId).toBe("partner1");
    expect(collisions[0]?.finding.message).toMatch(/^Predicted collision with Test partner/);
    expect(result.clearingOffset?.offsetS).toBeGreaterThan(0);
    const delayed = computeAlliance(ownRobot(), [entry()], result.clearingOffset?.offsetS ?? 0, RED);
    expect(delayed.findings.some((item) => item.finding.code === "ALLIANCE_COLLISION")).toBe(false);
    expect(delayed.clearingOffset).toBeUndefined();
  });

  it("proposes a delay for each clearable code that was raised, and none for a code that was not", () => {
    const crossing = computeAlliance(ownRobot(), [entry()], 0, RED);
    expect(crossing.clearingOffsets.ALLIANCE_COLLISION).toEqual(crossing.clearingOffset);
    expect("ALLIANCE_ENVELOPE" in crossing.clearingOffsets).toBe(false);

    // A partner parked out of the way whose envelope, the square |x|, |y| <= 10, is active until
    // 1.5 s: our box is inside it from 0.7 s, so our robot must wait until it first gets there at 1.6 s.
    const square = [
      { xIn: -10, yIn: -10 },
      { xIn: 10, yIn: -10 },
      { xIn: 10, yIn: 10 },
      { xIn: -10, yIn: 10 },
    ];
    const parked = projection(
      { envelopes: [{ startS: 0, endS: 1.5, polygon: square }] },
      { xIn: 50, yIn: 50, headingRad: 0 },
      { xIn: 50, yIn: 50, headingRad: 0 },
      0.1,
    );
    const inside = computeAlliance(ownRobot(), [entry({ projection: parked })], 0, RED);
    expect(inside.findings.map((item) => item.finding.code)).toEqual(["ALLIANCE_ENVELOPE"]);
    expect(inside.clearingOffsets.ALLIANCE_ENVELOPE).toEqual({ offsetS: 0.9 });
    expect(inside.clearingOffset).toBeUndefined();
  });

  it("leaves a hidden partner out of the findings", () => {
    const result = computeAlliance(ownRobot(), [entry({ visible: false })], 0, RED);
    expect(result.partners).toHaveLength(0);
    expect(result.findings).toHaveLength(0);
  });

  it("applies each partner's own offset", () => {
    const late = computeAlliance(ownRobot(), [entry({ offsetS: 3 })], 0, RED);
    expect(late.findings.some((item) => item.finding.code === "ALLIANCE_COLLISION")).toBe(false);
  });

  it("mirrors a partner written for the other alliance onto ours, once", () => {
    const blue = entry({ projection: projection({ alliance: "BLUE" }, { xIn: 0, yIn: -60, headingRad: 0 }, { xIn: 0, yIn: 0, headingRad: 0 }) });
    const aligned = alignedPartner(blue, RED);
    expect(aligned.alliance).toBe("RED");
    expect(aligned.startPose.yIn).toBeCloseTo(60, 9);
    const result = computeAlliance(ownRobot(), [blue], 0, RED);
    expect(result.partners[0]?.mirrored).toBe(true);
    expect(result.partners[0]?.robot.startPose.yIn).toBeCloseTo(60, 9);
    expect(result.findings.some((item) => item.finding.code === "ALLIANCE_COLLISION")).toBe(true);
  });

  it("does not report an element conflict when the partner scores into the other cell of a tipped hive", () => {
    // Our preload scores into RED's up cell from the south quarter at 0.8 s and tips the hive, so
    // the partner scoring into the up cell from the north quarter at 4.4 s scores into the other
    // physical cell. The season's frame resolves each claim to its cell; without it the two share an id.
    const field = loadField(JSON.parse(readFileSync(fileURLToPath(new URL("../../../../packages/season-biobuzz/field/biobuzz.field.json", import.meta.url)), "utf8")) as unknown);
    const frame = allianceFrameFor({ field, auto: { alliance: "RED" } } as unknown as Plan);
    const own: AllianceRobot = {
      ...ownRobot(),
      startPose: { xIn: -20, yIn: -40, headingRad: 0 },
      poses: [{ xIn: -20, yIn: -40, headingRad: 0 }],
      phases: [{ startS: 0, endS: 1, label: "score", stepId: "preload" }],
      claims: [{ elementId: "hiveRedUpCell", action: "score", atS: 0.8, stepId: "preload" }],
      totalS: 1,
    };
    const north = { xIn: -13.5, yIn: 45, headingRad: 0 };
    const partner = entry({
      projection: projection({ claims: [{ elementId: "hiveRedUpCell", action: "score", atS: 4.4 }], totalS: 5 }, north, north, 5),
    });
    const conflicts = (result: ReturnType<typeof computeAlliance>) =>
      result.findings.filter((item) => item.finding.code === "ALLIANCE_ELEMENT_CONFLICT");
    expect(conflicts(computeAlliance(own, [partner], 0, frame))).toEqual([]);
    expect(conflicts(computeAlliance(own, [partner], 0, RED))).toHaveLength(1);
  });
});

describe("buildPartnerScene", () => {
  it("draws each partner's box at the scrubber's time on the alliance clock", () => {
    const partner = entry({ offsetS: 0.5 });
    const { partners } = computeAlliance(ownRobot(), [partner], 0, RED);
    const [waiting] = buildPartnerScene(partners, 0.3);
    expect(waiting?.waiting).toBe(true);
    expect(waiting?.poseIn).toEqual({ xIn: 0, yIn: 60, headingRad: 0 });
    const [moving] = buildPartnerScene(partners, 1.5);
    expect(moving?.waiting).toBe(false);
    expect(moving?.poseIn).toEqual(alliancePoseAt(partners[0]!.robot, 1.5, 0.5));
    expect(moving?.poseIn.yIn).toBeCloseTo(0, 9);
    // The 18 in box, centred on the pose.
    const xs = (moving?.boxIn ?? []).map((corner) => corner.xIn);
    const ys = (moving?.boxIn ?? []).map((corner) => corner.yIn);
    expect(Math.min(...xs)).toBeCloseTo(-9, 9);
    expect(Math.max(...xs)).toBeCloseTo(9, 9);
    expect(Math.min(...ys)).toBeCloseTo(-9, 9);
    expect(Math.max(...ys)).toBeCloseTo(9, 9);
    expect(moving?.trajectoryIn).toHaveLength(21);
    expect(moving?.label).toBe("Test partner");
  });

  it("hatches an envelope only while it is active", () => {
    const polygon = [{ xIn: -10, yIn: -10 }, { xIn: 10, yIn: -10 }, { xIn: 10, yIn: 10 }];
    const reserved = entry({ projection: projection({ envelopes: [{ startS: 1, endS: 1.5, polygon }] }), offsetS: 1 });
    const { partners } = computeAlliance(ownRobot(), [reserved], 0, RED);
    expect(buildPartnerScene(partners, 1.5)[0]?.envelopesIn).toHaveLength(0);
    expect(buildPartnerScene(partners, 2.2)[0]?.envelopesIn).toEqual([polygon]);
    expect(buildPartnerScene(partners, 2.7)[0]?.envelopesIn).toHaveLength(0);
  });
});

describe("the timeline lane", () => {
  it("shifts phases and envelopes by the partner's offset, after a hollow offset block", () => {
    const polygon = [{ xIn: 0, yIn: 0 }, { xIn: 1, yIn: 0 }, { xIn: 0, yIn: 1 }];
    const lane = partnerLane(entry({
      projection: projection({ phases: [{ startS: 0, endS: 2, label: "drive" }, { startS: 2, endS: 3, label: "score" }], envelopes: [{ startS: 1, endS: 2, polygon }] }),
      offsetS: 0.5,
    }));
    expect(lane).toEqual([
      { startS: 0, endS: 0.5, kind: "offset" },
      { startS: 0.5, endS: 2.5, kind: "phase", label: "drive" },
      { startS: 2.5, endS: 3.5, kind: "phase", label: "score" },
      { startS: 1.5, endS: 2.5, kind: "envelope" },
    ]);
    expect(partnerLane(entry())[0]?.kind).toBe("phase");
  });

  it("lists the commands that ran in each phase when the projection names them, and nothing when it does not", () => {
    const phases = [
      { startS: 0, endS: 2, label: "drive" as const },
      { startS: 2, endS: 3, label: "score" as const },
    ];
    const commands = [
      { token: "cmd1", kind: "marker" as const, name: "intakeOn", startS: 0, endS: 2 },
      { token: "cmd2", kind: "command" as const, name: "score", args: { count: 4 }, startS: 2, endS: 3 },
      // A call that takes no time belongs to the phase it starts in.
      { token: "cmd3", kind: "command" as const, name: "intakeOff", startS: 2, endS: 2 },
      // A call whose step did not run has no span and is on no phase.
      { token: "cmd4", kind: "command" as const, name: "spinUp" },
    ];
    const lane = partnerLane(entry({ projection: projection({ phases, commands }), offsetS: 1 }));
    expect(lane.filter((block) => block.kind === "phase").map((block) => block.commands)).toEqual([
      ["intakeOn"],
      ["score (count 4)", "intakeOff"],
    ]);
    const plain = partnerLane(entry({ projection: projection({ phases }) }));
    expect(plain.every((block) => !("commands" in block))).toBe(true);
  });

  it("places a block as a share of the lane, clipped to it", () => {
    expect(laneGeometry({ startS: 1, endS: 3 }, 10)).toEqual({ leftPct: 10, widthPct: 20 });
    expect(laneGeometry({ startS: 8, endS: 14 }, 10)).toEqual({ leftPct: 80, widthPct: 20 });
    expect(laneGeometry({ startS: 1, endS: 2 }, 0)).toEqual({ leftPct: 0, widthPct: 0 });
  });
});

describe("partner sources", () => {
  const good = JSON.stringify(projection());

  it("reads a projection through the schema's validator", () => {
    const load = readPartnerText("a.projection.json", good);
    expect(load.ok).toBe(true);
    if (load.ok) expect(load.projection.title).toBe("Test partner");
  });

  it("refuses a file that is not JSON, not a projection, or has a key the format does not name", () => {
    expect(readPartnerText("a.json", "not json")).toMatchObject({
      ok: false,
      reason: "a.json is not valid JSON. Ask your partner to download it again.",
    });
    const auto = readPartnerText("b.json", JSON.stringify({ ...projection(), kind: "auto" }));
    expect(auto).toMatchObject({
      ok: false,
      reason: "b.json is a damaged share file: Zenith cannot read the value at kind. Ask your partner to download it again.",
    });
    const extra = readPartnerText("c.json", JSON.stringify({ ...projection(), commands: ["intakeOn"] }));
    expect(extra).toMatchObject({
      ok: false,
      reason: "c.json is a damaged share file: Zenith cannot read the value at commands.0. Ask your partner to download it again.",
    });
  });

  it("loads every file it was handed, in order, and says which failed", async () => {
    const file = (name: string, text: string) => ({ name, size: text.length, text: () => Promise.resolve(text) });
    const loads = await fileSource([file("one.projection.json", good), file("two.json", "{}")]).load();
    expect(loads.map((load) => [load.fileName, load.ok])).toEqual([
      ["one.projection.json", true],
      ["two.json", false],
    ]);
    const huge = await fileSource([{ name: "big.json", size: 20_000_000, text: () => Promise.resolve("") }]).load();
    expect(huge[0]).toMatchObject({ ok: false });
    expect(huge[0]).toMatchObject({
      reason: "big.json is 20.0 MB, so it was not read. A share file may be 2.0 MB at most and a trajectory.json 16.0 MB. Check that this is the file you meant.",
    });
    const big = JSON.stringify({ kind: "projection", pad: "x".repeat(3_000_000) });
    const projectionSized = await fileSource([{ name: "big.json", size: big.length, text: () => Promise.resolve(big) }]).load();
    expect(projectionSized[0]).toMatchObject({
      ok: false,
      reason: "big.json is 3.0 MB, larger than the 2.0 MB a share file may be, so it was not read. Check that this is the file you meant.",
    });
  });

  it("bundles an example partner that passes the schema", () => {
    const text = readFileSync(
      fileURLToPath(new URL("../../../../examples/starter/partners/starter-partner.projection.json", import.meta.url)),
      "utf8",
    );
    expect(readPartnerText("starter-partner.projection.json", text).ok).toBe(true);
  });
});
