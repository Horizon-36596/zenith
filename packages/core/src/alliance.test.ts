import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseProjection, SCHEMA_ID } from "@horizon36596/zenith-schema";
import { describe, expect, it } from "vitest";
import {
  allianceFixCleared,
  alliancePoseAt,
  allianceRobotFromProjection,
  boxIntersectsPolygon,
  checkAlliance,
  FIELD_TILE_IN,
  FIELD_TILES_PER_SIDE,
  fieldTileOf,
  isClearableAllianceCode,
  mirrorAllianceRobot,
  ownAllianceRobot,
  smallestClearingOffset,
  type AllianceProjection,
  type AllianceRobot,
} from "./alliance.js";
import { check } from "./check.js";
import { estimate } from "./estimate.js";
import { loadAuto, loadField, loadLink, loadRobot, loadWaypoints } from "./load.js";
import { plan } from "./plan.js";
import { resolve } from "./resolve.js";
import type { Pose } from "./geometry/vec.js";
import type { Finding } from "./types.js";

/**
 * M-C4's Contract (spec 13 section 16): two autos placed to cross at a
 * known time raise ALLIANCE_COLLISION at that time and not with a 1 s offset, the fix proposes the
 * smallest clearing offset, and no alliance finding changes what `check` says about an auto.
 */

/** Poses every 0.1 s along a straight line, holding one heading. */
function line(from: Pose, to: Pose, durationS: number): Pose[] {
  const ticks = Math.round(durationS * 10);
  const poses: Pose[] = [];
  for (let tick = 0; tick <= ticks; tick += 1) {
    const u = tick / ticks;
    poses.push({
      xIn: from.xIn + (to.xIn - from.xIn) * u,
      yIn: from.yIn + (to.yIn - from.yIn) * u,
      headingRad: from.headingRad,
    });
  }
  return poses;
}

function robot(label: string, poses: Pose[], extra: Partial<AllianceRobot> = {}): AllianceRobot {
  return {
    label,
    alliance: "RED",
    startPose: poses[0] as Pose,
    boundingBox: { lengthIn: 18, widthIn: 18, centreOffsetIn: { xIn: 0, yIn: 0 } },
    poses,
    phases: [{ startS: 0, endS: (poses.length - 1) / 10, label: "drive" }],
    claims: [],
    envelopes: [],
    totalS: (poses.length - 1) / 10,
    ...extra,
  };
}

/**
 * Two 18 in square robots at 60 in/s: ours east along y = 0, the partner south along x = 0, both
 * through the origin at exactly 1.0 s. The grown boxes (2 in each, so closer than 4 in) first meet
 * when the centres are 18 + 2 * sqrt(2) in from the origin on both axes, which is after 0.65 s, so
 * the first tick that collides is 0.7 s. With our start delayed by `o`, the robots can come no
 * closer than (60 o - 36) / sqrt(2) in, so 0.6 s still collides and 0.7 s is the smallest offset
 * that clears.
 */
const crossingOwn = (): AllianceRobot =>
  robot("your robot", line({ xIn: -60, yIn: 0, headingRad: 0 }, { xIn: 60, yIn: 0, headingRad: 0 }, 2), {
    phases: [{ startS: 0, endS: 2, label: "drive", stepId: "cross" }],
  });
const crossingPartner = (): AllianceRobot =>
  robot("Team Partner", line({ xIn: 0, yIn: 60, headingRad: 0 }, { xIn: 0, yIn: -60, headingRad: 0 }, 2));

const codes = (findings: readonly Finding[]): string[] => findings.map((finding) => finding.code);
const ofCode = (findings: readonly Finding[], code: string): Finding[] =>
  findings.filter((finding) => finding.code === code);

describe("checkAlliance: two robots crossing at a known time", () => {
  it("raises ALLIANCE_COLLISION at the first tick the grown boxes meet, naming both phases and the closest approach", () => {
    const findings = checkAlliance(crossingOwn(), [crossingPartner()]);
    const collisions = ofCode(findings, "ALLIANCE_COLLISION");
    expect(collisions).toHaveLength(1);
    const collision = collisions[0] as Finding;
    expect(collision.severity).toBe("error");
    expect(collision.timeS).toBeCloseTo(0.7, 9);
    expect(collision.stepId).toBe("cross");
    expect(collision.message).toMatch(/^Predicted collision with Team Partner at 0\.7 s/);
    expect(collision.message).toContain('in step "cross" (drive)');
    expect(collision.message).toContain("Team Partner is in a drive phase");
    // Both centres sit on the origin at 1.0 s, where the two 18 in boxes overlap completely.
    expect(collision.message).toContain("overlap by up to 18.0 in at 1.0 s");
    expect(collision.geometry?.penetrationIn).toBeCloseTo(18, 6);
  });

  it("raises no collision when our start is delayed by 1 s", () => {
    const findings = checkAlliance(crossingOwn(), [crossingPartner()], { ownStartOffsetS: 1 });
    expect(codes(findings)).not.toContain("ALLIANCE_COLLISION");
    expect(findings).toEqual([]);
  });

  it("raises no collision when the partner's start is delayed by 1 s instead", () => {
    const findings = checkAlliance(crossingOwn(), [crossingPartner()], { partnerStartOffsetsS: [1] });
    expect(codes(findings)).not.toContain("ALLIANCE_COLLISION");
  });

  it("proposes the smallest start offset that clears, in 0.1 s steps", () => {
    expect(smallestClearingOffset(crossingOwn(), [crossingPartner()])).toEqual({ offsetS: 0.7 });
    expect(codes(checkAlliance(crossingOwn(), [crossingPartner()], { ownStartOffsetS: 0.6 }))).toContain(
      "ALLIANCE_COLLISION",
    );
    expect(codes(checkAlliance(crossingOwn(), [crossingPartner()], { ownStartOffsetS: 0.7 }))).not.toContain(
      "ALLIANCE_COLLISION",
    );
  });

  it("proposes 0 s when nothing collides", () => {
    expect(smallestClearingOffset(crossingOwn(), [crossingPartner()], { partnerStartOffsetsS: [1] })).toEqual({
      offsetS: 0,
    });
  });

  it("uses the margins it is given", () => {
    // With no collision margin the boxes must really touch, which first happens after 0.7 s.
    const tight = ofCode(checkAlliance(crossingOwn(), [crossingPartner()], { collisionMarginIn: 0 }), "ALLIANCE_COLLISION");
    expect(tight[0]?.timeS).toBeCloseTo(0.8, 9);
    expect(() => checkAlliance(crossingOwn(), [crossingPartner()], { collisionMarginIn: 8, nearMissMarginIn: 6 })).toThrow(
      RangeError,
    );
    expect(() => checkAlliance(crossingOwn(), [crossingPartner()], { ownStartOffsetS: -1 })).toThrow(RangeError);
  });
});

describe("checkAlliance: near misses", () => {
  it("reports one near miss per close pass, not one per tick", () => {
    // At a 0.7 s offset the robots pass between two ticks at 4.2 in; on the 0.1 s grid the closest
    // is 6.0 in, at 1.3 s and again at 1.4 s: inside 12 in, outside 4 in.
    const findings = checkAlliance(crossingOwn(), [crossingPartner()], { ownStartOffsetS: 0.7 });
    const nearMisses = ofCode(findings, "ALLIANCE_NEAR_MISS");
    expect(nearMisses).toHaveLength(1);
    expect(nearMisses[0]?.severity).toBe("warning");
    expect(nearMisses[0]?.message).toMatch(/^Predicted near miss with Team Partner from \d+\.\d s to \d+\.\d s/);
    expect(nearMisses[0]?.message).toContain("closest approach is 6.0 in at 1.3 s");
  });

  it("reports two near misses for two separate close passes", () => {
    // Our robot drives east past a parked partner 26 in north of its line and back again: each
    // pass comes within 8 in, and the two passes are 2 s apart.
    const out = line({ xIn: -60, yIn: 0, headingRad: 0 }, { xIn: 60, yIn: 0, headingRad: 0 }, 2);
    const back = line({ xIn: 60, yIn: 0, headingRad: 0 }, { xIn: -60, yIn: 0, headingRad: 0 }, 2).slice(1);
    const own = robot("your robot", [...out, ...back]);
    const parked = robot("Team Partner", [{ xIn: 0, yIn: 26, headingRad: 0 }]);
    const nearMisses = ofCode(checkAlliance(own, [parked]), "ALLIANCE_NEAR_MISS");
    expect(nearMisses).toHaveLength(2);
    expect(nearMisses.every((finding) => finding.message.includes("closest approach is 8.0 in"))).toBe(true);
    expect(ofCode(checkAlliance(own, [parked]), "ALLIANCE_COLLISION")).toHaveLength(0);
  });

  it("does not also report a near miss around a collision", () => {
    const findings = checkAlliance(crossingOwn(), [crossingPartner()]);
    expect(ofCode(findings, "ALLIANCE_NEAR_MISS")).toHaveLength(0);
  });
});

describe("checkAlliance: start poses", () => {
  it("raises ALLIANCE_START_OVERLAP when the start boxes overlap, and no offset can clear it", () => {
    const own = robot("your robot", line({ xIn: -60, yIn: 0, headingRad: 0 }, { xIn: -60, yIn: 40, headingRad: 0 }, 1));
    const partner = robot("Team Partner", line({ xIn: -50, yIn: 0, headingRad: 0 }, { xIn: -50, yIn: -40, headingRad: 0 }, 1));
    const findings = checkAlliance(own, [partner]);
    const overlap = ofCode(findings, "ALLIANCE_START_OVERLAP");
    expect(overlap).toHaveLength(1);
    expect(overlap[0]?.severity).toBe("error");
    expect(overlap[0]?.message).toMatch(/^Predicted start overlap with Team Partner: the two start poses overlap by 8\.0 in/);
    // Both robots hold their start poses whatever the offset, so the search never clears this.
    expect(smallestClearingOffset(own, [partner])).toBeNull();
  });

  it("does not raise it for starts that only come close on two tiles", () => {
    // x = -60 is on the tile from -72 to -48 in and x = -40 on the one from -48 to -24 in.
    const own = robot("your robot", [{ xIn: -60, yIn: 0, headingRad: 0 }]);
    const partner = robot("Team Partner", [{ xIn: -40, yIn: 0, headingRad: 0 }]);
    expect(ofCode(checkAlliance(own, [partner]), "ALLIANCE_START_OVERLAP")).toHaveLength(0);
  });

  it("raises it when both start on the same tile, even when the boxes clear each other", () => {
    // Two 6 in robots 12 in apart, both on the tile from x -72 to -48 in and y 0 to 24 in.
    const small = { lengthIn: 6, widthIn: 6, centreOffsetIn: { xIn: 0, yIn: 0 } };
    const own = robot("your robot", [{ xIn: -66, yIn: 12, headingRad: 0 }], { boundingBox: small });
    const partner = robot("Team Partner", [{ xIn: -54, yIn: 12, headingRad: 0 }], { boundingBox: small });
    const overlap = ofCode(checkAlliance(own, [partner]), "ALLIANCE_START_OVERLAP");
    expect(overlap).toHaveLength(1);
    expect(overlap[0]?.severity).toBe("error");
    expect(overlap[0]?.timeS).toBe(0);
    expect(overlap[0]?.message).toBe(
      "Predicted start overlap with Team Partner: both robots start on the same field tile (x -72 to -48 in, y 0 to 24 in), so both cannot be set up where the autos say. A start offset cannot fix this; one of the start poses has to move to another tile.",
    );
    expect(overlap[0]?.geometry?.polygonIn).toEqual([
      { xIn: -72, yIn: 0 },
      { xIn: -48, yIn: 0 },
      { xIn: -48, yIn: 24 },
      { xIn: -72, yIn: 24 },
    ]);
    // The same two robots on neighbouring tiles, still 12 in apart, raise nothing.
    const across = robot("Team Partner", [{ xIn: -42, yIn: 12, headingRad: 0 }], { boundingBox: small });
    const apart = robot("your robot", [{ xIn: -54, yIn: 12, headingRad: 0 }], { boundingBox: small });
    expect(ofCode(checkAlliance(apart, [across]), "ALLIANCE_START_OVERLAP")).toHaveLength(0);
  });

  it("raises one finding, not two, when the boxes overlap on one tile", () => {
    const own = robot("your robot", [{ xIn: -60, yIn: 12, headingRad: 0 }]);
    const partner = robot("Team Partner", [{ xIn: -58, yIn: 12, headingRad: 0 }]);
    const overlap = ofCode(checkAlliance(own, [partner]), "ALLIANCE_START_OVERLAP");
    expect(overlap).toHaveLength(1);
    expect(overlap[0]?.message).toMatch(/the two start poses overlap by/);
  });
});

describe("fieldTileOf", () => {
  it("puts tile edges at multiples of 24 in from -72 in to 72 in", () => {
    expect(fieldTileOf({ xIn: 0, yIn: 0 })).toEqual({ column: 3, row: 3, minXIn: 0, maxXIn: 24, minYIn: 0, maxYIn: 24 });
    expect(fieldTileOf({ xIn: -0.01, yIn: -0.01 })).toMatchObject({ column: 2, row: 2, minXIn: -24, maxXIn: 0 });
    expect(fieldTileOf({ xIn: -72, yIn: -72 })).toMatchObject({ column: 0, row: 0 });
    expect(fieldTileOf({ xIn: 72, yIn: 72 })).toMatchObject({ column: 5, row: 5, maxXIn: 72, maxYIn: 72 });
    expect(fieldTileOf({ xIn: 72.5, yIn: 0 })).toBeNull();
    expect(FIELD_TILE_IN * FIELD_TILES_PER_SIDE).toBe(144);
  });
});

describe("checkAlliance: envelopes", () => {
  // Our robot crosses x = 0 at 1.0 s; its box meets the square |x| <= 10 from 0.7 s to 1.3 s.
  const square = [
    { xIn: -10, yIn: -10 },
    { xIn: 10, yIn: -10 },
    { xIn: 10, yIn: 10 },
    { xIn: -10, yIn: 10 },
  ];
  const partnerWith = (startS: number, endS: number): AllianceRobot =>
    robot("Team Partner", [{ xIn: 50, yIn: 50, headingRad: 0 }], { envelopes: [{ startS, endS, polygon: square }] });

  it("raises ALLIANCE_ENVELOPE once for the time our box is inside an active envelope", () => {
    const findings = ofCode(checkAlliance(crossingOwn(), [partnerWith(0, 5)]), "ALLIANCE_ENVELOPE");
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe("warning");
    expect(findings[0]?.timeS).toBeCloseTo(0.7, 9);
    expect(findings[0]?.message).toMatch(/^Predicted entry into Team Partner's envelope at 0\.7 s/);
    expect(findings[0]?.message).toContain("until 1.3 s");
  });

  it("starts the finding when the envelope starts, if our robot is already inside", () => {
    const findings = ofCode(checkAlliance(crossingOwn(), [partnerWith(0.9, 1.1)]), "ALLIANCE_ENVELOPE");
    expect(findings).toHaveLength(1);
    expect(findings[0]?.timeS).toBeCloseTo(0.9, 9);
  });

  it("raises nothing when our robot passes through outside the envelope's time span", () => {
    expect(ofCode(checkAlliance(crossingOwn(), [partnerWith(0, 0.5)]), "ALLIANCE_ENVELOPE")).toHaveLength(0);
    expect(ofCode(checkAlliance(crossingOwn(), [partnerWith(1.5, 3)]), "ALLIANCE_ENVELOPE")).toHaveLength(0);
  });

  it("moves the envelope with the partner's start offset", () => {
    const findings = ofCode(
      checkAlliance(crossingOwn(), [partnerWith(0, 0.5)], { partnerStartOffsetsS: [0.5] }),
      "ALLIANCE_ENVELOPE",
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.timeS).toBeCloseTo(0.7, 9);
  });

  it("tests an oriented box against a concave polygon", () => {
    const ell = [
      { xIn: 0, yIn: 0 },
      { xIn: 30, yIn: 0 },
      { xIn: 30, yIn: 10 },
      { xIn: 10, yIn: 10 },
      { xIn: 10, yIn: 30 },
      { xIn: 0, yIn: 30 },
    ];
    const box = (xIn: number, yIn: number): { xIn: number; yIn: number }[] => [
      { xIn: xIn - 2, yIn: yIn - 2 },
      { xIn: xIn + 2, yIn: yIn - 2 },
      { xIn: xIn + 2, yIn: yIn + 2 },
      { xIn: xIn - 2, yIn: yIn + 2 },
    ];
    expect(boxIntersectsPolygon(box(20, 20), ell)).toBe(false); // in the notch of the L
    expect(boxIntersectsPolygon(box(5, 5), ell)).toBe(true); // wholly inside
    expect(boxIntersectsPolygon(box(11, 20), ell)).toBe(true); // across an inner edge
    const huge = [
      { xIn: -100, yIn: -100 },
      { xIn: 100, yIn: -100 },
      { xIn: 100, yIn: 100 },
      { xIn: -100, yIn: 100 },
    ];
    expect(boxIntersectsPolygon(huge, ell)).toBe(true); // the polygon wholly inside the box
  });
});

describe("smallestClearingOffset for each code a later start can clear", () => {
  const square = [
    { xIn: -10, yIn: -10 },
    { xIn: 10, yIn: -10 },
    { xIn: 10, yIn: 10 },
    { xIn: -10, yIn: 10 },
  ];

  it("offers the fix for a collision, a near miss and an envelope, and not for the other two codes", () => {
    expect(isClearableAllianceCode("ALLIANCE_COLLISION")).toBe(true);
    expect(isClearableAllianceCode("ALLIANCE_NEAR_MISS")).toBe(true);
    expect(isClearableAllianceCode("ALLIANCE_ENVELOPE")).toBe(true);
    // A start overlap holds through any wait, and an element conflict does not depend on timing.
    expect(isClearableAllianceCode("ALLIANCE_START_OVERLAP")).toBe(false);
    expect(isClearableAllianceCode("ALLIANCE_ELEMENT_CONFLICT")).toBe(false);
    expect(isClearableAllianceCode("KEEPOUT")).toBe(false);
  });

  it("clears a near miss only once the robots neither pass close nor collide", () => {
    const fix = smallestClearingOffset(crossingOwn(), [crossingPartner()], {}, "ALLIANCE_NEAR_MISS");
    expect(fix).not.toBeNull();
    const offsetS = fix?.offsetS ?? 0;
    // A collision clears at 0.7 s, and 0.7 s is still a near miss (the near-miss test above).
    expect(offsetS).toBeGreaterThan(0.7);
    const at = codes(checkAlliance(crossingOwn(), [crossingPartner()], { ownStartOffsetS: offsetS }));
    expect(at).not.toContain("ALLIANCE_NEAR_MISS");
    expect(at).not.toContain("ALLIANCE_COLLISION");
    const shorter = codes(checkAlliance(crossingOwn(), [crossingPartner()], { ownStartOffsetS: offsetS - 0.1 }));
    expect(shorter.some((code) => code === "ALLIANCE_NEAR_MISS" || code === "ALLIANCE_COLLISION")).toBe(true);
  });

  it("waits until the partner's envelope window has closed before our robot gets there", () => {
    // Our box is inside the square from 0.7 s to 1.3 s; the envelope is active until 1.5 s, so
    // our robot must first reach it at 1.6 s, a 0.9 s delay.
    const partner = robot("Team Partner", [{ xIn: 50, yIn: 50, headingRad: 0 }], {
      envelopes: [{ startS: 0, endS: 1.5, polygon: square }],
    });
    expect(smallestClearingOffset(crossingOwn(), [partner], {}, "ALLIANCE_ENVELOPE")).toEqual({ offsetS: 0.9 });
    // The collision fix has nothing to clear here.
    expect(smallestClearingOffset(crossingOwn(), [partner])).toEqual({ offsetS: 0 });
  });

  it("never proposes an offset that trades a warning for a predicted collision", () => {
    const collision: Finding = { severity: "error", stepId: "cross", code: "ALLIANCE_COLLISION", message: "Predicted collision." };
    const nearMiss: Finding = { ...collision, severity: "warning", code: "ALLIANCE_NEAR_MISS" };
    const envelope: Finding = { ...collision, severity: "warning", code: "ALLIANCE_ENVELOPE" };
    expect(allianceFixCleared([collision], "ALLIANCE_ENVELOPE")).toBe(false);
    expect(allianceFixCleared([collision], "ALLIANCE_NEAR_MISS")).toBe(false);
    expect(allianceFixCleared([nearMiss], "ALLIANCE_ENVELOPE")).toBe(true);
    expect(allianceFixCleared([envelope], "ALLIANCE_COLLISION")).toBe(true);
    expect(allianceFixCleared([], "ALLIANCE_COLLISION")).toBe(true);
  });
});

describe("checkAlliance: element conflicts", () => {
  const parked = (label: string, xIn: number, claims: AllianceRobot["claims"]): AllianceRobot =>
    robot(label, [{ xIn, yIn: 0, headingRad: 0 }], { claims, totalS: 20 });

  it("names the robot that gets there first", () => {
    const own = parked("your robot", -60, [{ elementId: "flower0", action: "take", atS: 3, stepId: "grab" }]);
    const partner = parked("Team Partner", 60, [{ elementId: "flower0", action: "take", atS: 2 }]);
    const findings = ofCode(checkAlliance(own, [partner]), "ALLIANCE_ELEMENT_CONFLICT");
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe("warning");
    expect(findings[0]?.stepId).toBe("grab");
    expect(findings[0]?.message).toBe(
      "Predicted element conflict with Team Partner: both autos take from flower0; Team Partner gets there first, at 2.0 s, and your robot at 3.0 s.",
    );
    // A 2 s head start on the partner's side makes our robot first.
    const delayed = ofCode(checkAlliance(own, [partner], { partnerStartOffsetsS: [2] }), "ALLIANCE_ELEMENT_CONFLICT");
    expect(delayed[0]?.message).toContain("your robot gets there first, at 3.0 s, and Team Partner at 4.0 s");
  });

  it("only conflicts on the same element with the same action, once per element", () => {
    const own = parked("your robot", -60, [
      { elementId: "hiveRedUpCell", action: "score", atS: 1 },
      { elementId: "hiveRedUpCell", action: "score", atS: 8 },
      { elementId: "flower0", action: "take", atS: 3 },
    ]);
    const partner = parked("Team Partner", 60, [
      { elementId: "hiveRedUpCell", action: "score", atS: 4 },
      { elementId: "flower0", action: "score", atS: 5 },
    ]);
    const findings = ofCode(checkAlliance(own, [partner]), "ALLIANCE_ELEMENT_CONFLICT");
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("both autos score into hiveRedUpCell; your robot gets there first, at 1.0 s");
  });

  /**
   * A season's `claimPlace` hook, bound to a field: the hive's up cell is the south cell from the
   * floor quarter south of y = 0 and the north cell from the one north of it, and every other id
   * names one place whatever the pose.
   */
  const byQuarter = (elementId: string, pose: Pose): string | null =>
    elementId === "hiveRedUpCell" ? (pose.yIn < 0 ? "the south cell" : "the north cell") : null;

  it("does not conflict when the two robots score into different physical cells behind one up-cell id", () => {
    // The BIOBUZZ case: our preload tips the hive from the south, so the up cell the partner
    // scores into later, from the north, is the other cell.
    const own = robot("your robot", [{ xIn: -20, yIn: -40, headingRad: 0 }], {
      claims: [{ elementId: "hiveRedUpCell", action: "score", atS: 0.8, stepId: "preload" }],
    });
    const partner = robot("Partner team", [{ xIn: -14, yIn: 45, headingRad: 0 }], {
      claims: [{ elementId: "hiveRedUpCell", action: "score", atS: 4.4 }],
    });
    expect(ofCode(checkAlliance(own, [partner], { claimPlace: byQuarter }), "ALLIANCE_ELEMENT_CONFLICT")).toEqual([]);
  });

  it("still conflicts when both robots score into the same physical cell, and names it", () => {
    const own = robot("your robot", [{ xIn: -20, yIn: -40, headingRad: 0 }], {
      claims: [{ elementId: "hiveRedUpCell", action: "score", atS: 0.8, stepId: "preload" }],
    });
    const partner = robot("Partner team", [{ xIn: 20, yIn: -40, headingRad: 0 }], {
      claims: [{ elementId: "hiveRedUpCell", action: "score", atS: 4.4 }],
    });
    const findings = ofCode(checkAlliance(own, [partner], { claimPlace: byQuarter }), "ALLIANCE_ELEMENT_CONFLICT");
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toBe(
      "Predicted element conflict with Partner team: both autos score into hiveRedUpCell (the south cell); your robot gets there first, at 0.8 s, and Partner team at 4.4 s.",
    );
  });

  it("reads the place at the pose the claim was made from, after mirroring and start offsets", () => {
    // The partner drives from the south quarter to the north one and scores at 2 s, from the north.
    const own = robot("your robot", [{ xIn: -20, yIn: -40, headingRad: 0 }], {
      claims: [{ elementId: "hiveRedUpCell", action: "score", atS: 0.5 }],
    });
    const partner = robot("Partner team", line({ xIn: 20, yIn: -40, headingRad: 0 }, { xIn: 20, yIn: 40, headingRad: 0 }, 2), {
      claims: [{ elementId: "hiveRedUpCell", action: "score", atS: 2 }],
    });
    const options = { claimPlace: byQuarter, partnerStartOffsetsS: [1] };
    expect(ofCode(checkAlliance(own, [partner], options), "ALLIANCE_ELEMENT_CONFLICT")).toEqual([]);
    // A claim that says where it was made is read there, not at the pose its step began at.
    const fromSouth = { ...partner, claims: [{ elementId: "hiveRedUpCell", action: "score" as const, atS: 2, poseIn: { xIn: 20, yIn: -40, headingRad: 0 } }] };
    expect(ofCode(checkAlliance(own, [fromSouth], options), "ALLIANCE_ELEMENT_CONFLICT")).toHaveLength(1);
  });

  it("conflicts when either robot's place is unknown, since it may be the same cell", () => {
    const own = robot("your robot", [{ xIn: -20, yIn: -40, headingRad: 0 }], {
      claims: [{ elementId: "hiveRedUpCell", action: "score", atS: 0.8 }],
    });
    const partner = robot("Partner team", [{ xIn: -14, yIn: 45, headingRad: 0 }], {
      claims: [{ elementId: "hiveRedUpCell", action: "score", atS: 4.4 }],
    });
    const unknownForPartner = (elementId: string, pose: Pose): string | null => (pose.yIn > 0 ? null : byQuarter(elementId, pose));
    const findings = ofCode(checkAlliance(own, [partner], { claimPlace: unknownForPartner }), "ALLIANCE_ELEMENT_CONFLICT");
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("both autos score into hiveRedUpCell (the south cell)");
  });
});

describe("checkAlliance: alliances", () => {
  it("mirrors a partner written for the other alliance onto ours, by the field's mirror", () => {
    const red = crossingPartner();
    const blue: AllianceRobot = { ...mirrorAllianceRobot(red, "pointSymmetry"), label: "Team Partner" };
    expect(blue.alliance).toBe("BLUE");
    expect(blue.poses[0]).toEqual({ xIn: -0, yIn: -60, headingRad: Math.PI });
    const fromRed = checkAlliance(crossingOwn(), [red]);
    const fromBlue = checkAlliance(crossingOwn(), [blue]);
    expect(codes(fromBlue)).toEqual(codes(fromRed));
    expect(fromBlue.map((finding) => finding.timeS)).toEqual(fromRed.map((finding) => finding.timeS));
  });

  it("does not mirror a partner on the same alliance", () => {
    // The mirrored partner is written as RED here, so it is taken as it is: it crosses x = 0
    // going north, and our robot at the same time, so it still collides but is not flipped back.
    const flipped: AllianceRobot = { ...mirrorAllianceRobot(crossingPartner(), "pointSymmetry"), alliance: "RED" };
    expect(alliancePoseAt(flipped, 0)).toEqual({ xIn: -0, yIn: -60, headingRad: Math.PI });
    expect(codes(checkAlliance(crossingOwn(), [flipped]))).toContain("ALLIANCE_COLLISION");
  });

  it("moves a partner to our alliance on a field with no mirror without moving a pose, so it is not mirrored again (issue #408)", () => {
    // Both robots sit at x = -60 for a second: the same spot, unless the partner is turned a half turn.
    const still = line({ xIn: -60, yIn: 0, headingRad: 0 }, { xIn: -60, yIn: 0, headingRad: 0 }, 1);
    const own = robot("your robot", still);
    const blue = robot("Team Partner", still, { alliance: "BLUE" });
    const aligned = mirrorAllianceRobot(blue, "none");
    expect(aligned.alliance).toBe("RED");
    expect(aligned.poses).toEqual(blue.poses);
    expect(codes(checkAlliance(own, [aligned]))).toContain("ALLIANCE_COLLISION");
  });

  it("renames a mirrored partner's claimed elements with the season's hook", () => {
    const own = robot("your robot", [{ xIn: -60, yIn: 0, headingRad: 0 }], {
      claims: [{ elementId: "flowerRed0", action: "take", atS: 1 }],
    });
    const partner = robot("Team Partner", [{ xIn: 60, yIn: 0, headingRad: 0 }], {
      alliance: "BLUE",
      claims: [{ elementId: "flowerBlue0", action: "take", atS: 2 }],
    });
    const mirrorId = (id: string): string | null =>
      id.includes("Blue") ? id.replace("Blue", "Red") : id.includes("Red") ? id.replace("Red", "Blue") : null;
    expect(ofCode(checkAlliance(own, [partner]), "ALLIANCE_ELEMENT_CONFLICT")).toHaveLength(0);
    expect(ofCode(checkAlliance(own, [partner], { mirrorId }), "ALLIANCE_ELEMENT_CONFLICT")).toHaveLength(1);
  });
});

describe("checkAlliance: timing", () => {
  it("holds the start pose during an offset and the final pose after the end", () => {
    const own = crossingOwn();
    expect(alliancePoseAt(own, 0.5, 1)).toEqual(own.startPose);
    expect(alliancePoseAt(own, 1.5, 1).xIn).toBeCloseTo(-30, 9);
    expect(alliancePoseAt(own, 99)).toEqual(own.poses[own.poses.length - 1]);
  });

  it("says predicted in every message", () => {
    const own = crossingOwn();
    const partner = robot("Team Partner", crossingPartner().poses, {
      claims: [{ elementId: "flower0", action: "take", atS: 1 }],
      envelopes: [{ startS: 0, endS: 3, polygon: [{ xIn: -5, yIn: -5 }, { xIn: 5, yIn: -5 }, { xIn: 0, yIn: 5 }] }],
    });
    own.claims = [{ elementId: "flower0", action: "take", atS: 1.5 }];
    const findings = [
      ...checkAlliance(own, [partner]),
      ...checkAlliance(own, [partner], { ownStartOffsetS: 0.7 }),
      ...checkAlliance(robot("your robot", [{ xIn: 0, yIn: 0, headingRad: 0 }]), [robot("Team Partner", [{ xIn: 1, yIn: 0, headingRad: 0 }])]),
    ];
    expect(new Set(codes(findings))).toEqual(
      new Set(["ALLIANCE_COLLISION", "ALLIANCE_NEAR_MISS", "ALLIANCE_START_OVERLAP", "ALLIANCE_ELEMENT_CONFLICT", "ALLIANCE_ENVELOPE"]),
    );
    for (const finding of findings) expect(finding.message).toMatch(/^Predicted /);
  });
});

describe("allianceRobotFromProjection reads the schema's Projection", () => {
  const projection = (): AllianceProjection => ({
    $schema: SCHEMA_ID.projection,
    formatVersion: 1,
    kind: "projection",
    level: "view",
    season: "biobuzz-2026",
    alliance: "BLUE",
    title: "Team Partner close",
    startPose: { xIn: 0, yIn: 60, headingRad: 0 },
    boundingBox: { lengthIn: 18, widthIn: 18, centreOffsetIn: { xIn: 0, yIn: 0 } },
    trajectory: {
      rateHz: 10,
      positionQuantumIn: 0.5,
      headingQuantumRad: 0.0175,
      poses: [
        [0, 60, 0],
        [0, 54, 0],
      ],
    },
    phases: [{ startS: 0, endS: 0.1, label: "drive" }],
    claims: [{ elementId: "flower0", action: "take", atS: 0.1 }],
    envelopes: [{ startS: 0, endS: 1, polygon: [{ xIn: 0, yIn: 0 }, { xIn: 1, yIn: 0 }, { xIn: 0, yIn: 1 }] }],
    totalS: 0.1,
  });

  it("reads a projection and turns it into an alliance robot", () => {
    const parsed = parseProjection(JSON.parse(JSON.stringify(projection())));
    expect(parsed).toEqual(projection());
    const partner = allianceRobotFromProjection(parsed);
    expect(partner.label).toBe("Team Partner close");
    expect(partner.alliance).toBe("BLUE");
    expect(partner.poses[1]).toEqual({ xIn: 0, yIn: 54, headingRad: 0 });
    expect(allianceRobotFromProjection(parsed, "partner.json").label).toBe("partner.json");
  });

  it("leaves validation to the schema's one validator, which names the key that is wrong", () => {
    const bad = (mutate: (value: Record<string, unknown>) => void): unknown => {
      const value = JSON.parse(JSON.stringify(projection())) as Record<string, unknown>;
      mutate(value);
      return value;
    };
    expect(() => parseProjection(bad((v) => (v["kind"] = "auto")))).toThrow(/kind/);
    expect(() => parseProjection(bad((v) => (v["alliance"] = "GREEN")))).toThrow(/alliance/);
    expect(() =>
      parseProjection(bad((v) => ((v["trajectory"] as Record<string, unknown>)["poses"] = [[0, 1]]))),
    ).toThrow(/trajectory\.poses\.0/);
    expect(() =>
      parseProjection(bad((v) => ((v["phases"] as Record<string, unknown>[])[0]!["label"] = "dance"))),
    ).toThrow(/phases\.0\.label/);
    expect(() => parseProjection(bad((v) => delete v["totalS"]))).toThrow(/totalS/);
  });
});

// ---------------------------------------------------------------------------------------------
// The example autos.
// ---------------------------------------------------------------------------------------------

const starter = fileURLToPath(new URL("../../../examples/starter/", import.meta.url));
const read = (relative: string): unknown => JSON.parse(readFileSync(`${starter}${relative}`, "utf8"));

function starterPlan(name: string) {
  const link = loadLink(read("zenith.json"));
  const robotFile = loadRobot(read(link.robot));
  const field = loadField(read(link.field));
  const waypoints = loadWaypoints(read(link.waypoints ?? "autos/waypoints.json"));
  return { planned: plan(resolve(loadAuto(read(`autos/${name}.auto.json`)), waypoints), robotFile, field), robotFile, field };
}

/**
 * A partner placed to cross the starter first-auto at a known time. That auto drives north from
 * its start to the scoring pose in its first 1.3 s. The partner, with the same 18 in box, waits
 * 30 in west of where our robot is at `crossingS`, sets off 0.6 s before it, reaches our robot's
 * spot at 50 in/s exactly at `crossingS`, and turns north ahead of it and out of its way.
 */
function partnerCrossing(own: AllianceRobot, crossingS: number): AllianceRobot {
  const at = alliancePoseAt(own, crossingS);
  const from = { xIn: at.xIn - 30, yIn: at.yIn, headingRad: 0 };
  const turn = { xIn: at.xIn, yIn: at.yIn, headingRad: 0 };
  const wait = line(from, from, crossingS - 0.6);
  const east = line(from, turn, 0.6).slice(1);
  const north = line(turn, { xIn: at.xIn, yIn: at.yIn + 60, headingRad: 0 }, 1.2).slice(1);
  return robot("Team Partner", [...wait, ...east, ...north], { boundingBox: own.boundingBox });
}

describe("checkAlliance on the starter example autos", () => {
  it("finds a partner crossing first-auto at a known time, and not with a 1 s offset", () => {
    const { planned, field } = starterPlan("first-auto");
    const own = ownAllianceRobot(planned, field);
    expect(own.phases[0]?.stepId).toBe("driveOut");

    const crossingS = 1;
    const partner = partnerCrossing(own, crossingS);
    expect(alliancePoseAt(partner, crossingS).xIn).toBeCloseTo(alliancePoseAt(own, crossingS).xIn, 6);

    const collisions = ofCode(checkAlliance(own, [partner]), "ALLIANCE_COLLISION");
    expect(collisions).toHaveLength(1);
    const collision = collisions[0] as Finding;
    // The grown boxes meet a little before the centres cross, and the run of ticks covers 1.0 s.
    expect(collision.timeS).toBeGreaterThan(crossingS - 0.5);
    expect(collision.timeS).toBeLessThanOrEqual(crossingS);
    expect(collision.stepId).toBe("driveOut");
    expect(collision.message).toContain('your robot is in step "driveOut" (drive)');

    expect(ofCode(checkAlliance(own, [partner], { ownStartOffsetS: 1 }), "ALLIANCE_COLLISION")).toHaveLength(0);

    const fix = smallestClearingOffset(own, [partner]);
    expect(fix).not.toBeNull();
    const offsetS = (fix as { offsetS: number }).offsetS;
    expect(offsetS).toBeGreaterThan(0);
    expect(offsetS).toBeLessThanOrEqual(1);
    expect(ofCode(checkAlliance(own, [partner], { ownStartOffsetS: offsetS }), "ALLIANCE_COLLISION")).toHaveLength(0);
    expect(
      ofCode(checkAlliance(own, [partner], { ownStartOffsetS: Math.round((offsetS - 0.1) * 10) / 10 }), "ALLIANCE_COLLISION"),
    ).not.toHaveLength(0);
  });

  it("finds that first-auto and collect-and-score share one start, which no start offset clears", () => {
    const first = starterPlan("first-auto");
    const collect = starterPlan("collect-and-score");
    const own = ownAllianceRobot(first.planned, first.field);
    const partner = ownAllianceRobot(collect.planned, collect.field, undefined, "collect-and-score");
    const findings = checkAlliance(own, [partner]);
    expect(codes(findings)).toContain("ALLIANCE_START_OVERLAP");
    expect(ofCode(findings, "ALLIANCE_COLLISION")[0]?.timeS).toBe(0);
    expect(smallestClearingOffset(own, [partner])).toBeNull();
  });
});

describe("alliance findings never feed check()", () => {
  it("check.ts and the checks it runs do not import the alliance module", () => {
    const here = (relative: string): string => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
    for (const file of ["./check.ts", "./checks/heading.ts", "./checks/motion.ts", "./checks/schedule.ts", "./checks/season.ts"]) {
      expect(here(file), file).not.toMatch(/from\s+["'][^"']*alliance/);
    }
  });

  it("gives the same findings for an auto whatever its partners, with no alliance code among them", () => {
    const { planned, robotFile, field } = starterPlan("first-auto");
    const before = check(planned, estimate(planned, robotFile), robotFile, field);
    const own = ownAllianceRobot(planned, field);
    const alliance = checkAlliance(own, [partnerCrossing(own, 1), { ...own, label: "a copy of us" }]);
    expect(alliance.some((finding) => finding.severity === "error")).toBe(true);
    const after = check(planned, estimate(planned, robotFile), robotFile, field);
    expect(after).toEqual(before);
    expect(after.some((finding) => finding.code.startsWith("ALLIANCE_"))).toBe(false);
  });
});
