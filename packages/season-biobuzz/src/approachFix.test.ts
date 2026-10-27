import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  applyFix,
  check,
  estimate,
  loadAuto,
  loadField,
  loadRobot,
  loadWaypoints,
  plan,
  resolve,
  runLedger,
  type Finding,
  type Fix,
} from "@horizon36596/zenith-core";
import type { Auto } from "@horizon36596/zenith-schema";
import { describe, expect, it } from "vitest";
import { biobuzzRules } from "./rules.js";

/**
 * LEGAL_APPROACH's "Move to approach" on the real BIOBUZZ field (0.1.2 UX sweep W2-2). The season's
 * nearest legal spot to a shot inside the hive frame is on the edge of the approach band, which is
 * inside the frame's west bar and south-west leg; the fix used to move the end there. It now moves
 * the end to a legal spot from which the auto, checked again, is no worse, and turns the robot so the
 * side of it the shot pointed at the up cell still points at it.
 */

const here = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));
const json = (path: string): unknown => JSON.parse(readFileSync(path, "utf8")) as unknown;

const field = loadField(json(here("../field/biobuzz.field.json")));
// The starter robot: a fixed launcher, no turret.
const robot = loadRobot(json(here("../../../examples/starter/autos/robot.json")));
const waypoints = loadWaypoints(json(here("../../../examples/starter/autos/waypoints.json")));

/** first-auto with one path from the start to (`xIn`, `yIn`) and a score where it ends. */
function shotFrom(xIn: number, yIn: number, heading: unknown): Auto {
  const raw = json(here("../../../examples/starter/autos/first-auto.auto.json")) as Record<string, unknown>;
  return loadAuto({
    ...raw,
    steps: [
      { id: "path2", kind: "path", segments: [{ kind: "line", from: "current", to: { xIn, yIn, provenance: "SET BY HAND: test" } }], heading },
      { id: "shoot", kind: "command", name: "score", args: { count: 4 } },
    ],
  });
}

const findingsOf = (auto: Auto): Finding[] => {
  const planned = plan(resolve(auto, waypoints, robot), robot, field);
  return check(planned, estimate(planned, robot), robot, field, biobuzzRules);
};

const on = (findings: readonly Finding[], code: Finding["code"], stepId: string): Finding[] =>
  findings.filter((finding) => finding.code === code && finding.stepId === stepId);

function moveOf(findings: readonly Finding[]): Extract<Fix, { kind: "moveToLegalApproach" }> {
  const fix = on(findings, "LEGAL_APPROACH", "shoot")[0]?.fixes?.find((candidate) => candidate.kind === "moveToLegalApproach");
  if (fix?.kind !== "moveToLegalApproach") throw new Error("expected a moveToLegalApproach fix");
  return fix;
}

/** Where the up cell sits from the robot's body where `shoot` stands: its bearing less the robot's heading, in radians. */
function bodyBearing(auto: Auto): number {
  const planned = plan(resolve(auto, waypoints, robot), robot, field);
  const run = runLedger(planned, field, biobuzzRules);
  const entry = run.entries.find((candidate) => candidate.stepId === "shoot");
  const shot = planned.steps.find((step) => step.id === "shoot")?.startPose;
  const target = entry?.target ?? null;
  const cell = target === null || entry === undefined ? null : biobuzzRules.targetPoint?.(entry.before, target);
  if (shot === undefined || cell == null) throw new Error("no shot or no target");
  const bearing = Math.atan2(cell.yIn - shot.yIn, cell.xIn - shot.xIn);
  return Math.atan2(Math.sin(bearing - shot.headingRad), Math.cos(bearing - shot.headingRad));
}

const apart = (a: number, b: number): number => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));

describe("Move to approach on BIOBUZZ", () => {
  it("moves a shot inside the hive frame to a legal spot clear of the frame, labelled SET FROM EDITOR, the same side toward the up cell", () => {
    const auto = shotFrom(-24, -10, { mode: "tangent" });
    const before = findingsOf(auto);
    expect(on(before, "STRUCTURE", "path2").length).toBeGreaterThan(0);
    const fix = moveOf(before);
    // The season's nearest spot, (-24, -24.58), is inside the frame's west bar: the fix is elsewhere.
    expect(fix.params.xIn === -24 && fix.params.yIn === -24.58).toBe(false);
    const fixed = applyFix(auto, fix);
    const after = findingsOf(fixed);
    expect(on(after, "LEGAL_APPROACH", "shoot")).toEqual([]);
    expect(on(after, "STRUCTURE", "path2")).toEqual([]);
    expect(after.filter((finding) => finding.code === "PROVENANCE")).toEqual([]);
    const errors = (findings: readonly Finding[]): string[] => findings.filter((finding) => finding.severity === "error").map((finding) => `${finding.code}@${finding.stepId}`);
    expect(errors(after).filter((error) => !errors(before).includes(error))).toEqual([]);
    const end = (fixed.steps[0] as { segments: { to: { provenance?: string } }[] }).segments[0]?.to;
    expect(end?.provenance).toBe("SET FROM EDITOR");
    expect(apart(bodyBearing(fixed), bodyBearing(auto))).toBeLessThan(0.05);
  });

  it("keeps the back toward the up cell when the shot launched out of the back", () => {
    // The heading as written turns the robot's back exactly to the up cell.
    const probe = shotFrom(-24, -10, { mode: "constant", headingRad: 0 });
    const backRad = Math.round((0 + bodyBearing(probe) + Math.PI) * 10_000) / 10_000;
    const auto = shotFrom(-24, -10, { mode: "constant", headingRad: backRad });
    expect(apart(bodyBearing(auto), Math.PI)).toBeLessThan(0.01);
    const fixed = applyFix(auto, moveOf(findingsOf(auto)));
    expect(on(findingsOf(fixed), "LEGAL_APPROACH", "shoot")).toEqual([]);
    expect(apart(bodyBearing(fixed), Math.PI)).toBeLessThan(0.05);
  });
});
