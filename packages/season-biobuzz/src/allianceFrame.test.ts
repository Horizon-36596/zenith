import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  check,
  estimate,
  loadAuto,
  loadField,
  loadRobot,
  loadWaypoints,
  mirrorAuto,
  mirrorForField,
  mirrorVec,
  plan,
  resolve,
  type Finding,
  type MirrorMode,
  type Vec2,
} from "@horizon36596/zenith-core";
import type { Auto, Field } from "@horizon36596/zenith-schema";
import { describe, expect, it } from "vitest";
import { biobuzzRules } from "./rules.js";

/**
 * The checks read a file's poses in the frame of the file's own `alliance`, the frame the robot
 * drives it in (site/docs/file-format.md). For a RED file F and the BLUE file B = mirrorAuto(F) that
 * zenith saves for it, B checked as BLUE has to raise the same findings as F checked as RED, with
 * every place on the field mirrored and every field id swapped for its counterpart on the other
 * alliance. A rule that still read B's poses as RED's, such as a start rule that looked for RED's
 * hive and RED's loading zone, shows up here as a finding one of the two has and the other has not.
 */
const examples = fileURLToPath(new URL("../../../examples/starter/", import.meta.url));
const present = existsSync(`${examples}zenith.json`);
const read = (relative: string): unknown => JSON.parse(readFileSync(`${examples}${relative}`, "utf8"));

const round = (value: number): number => Math.round(value * 1e4) / 1e4 + 0;
const point = (p: Vec2): string => `(${String(round(p.xIn))}, ${String(round(p.yIn))})`;

/**
 * Every field id beside the one its place mirrors onto, found by geometry rather than by name, so the
 * comparison does not lean on the `mirrorId` hook it would otherwise be testing.
 */
function counterparts(field: Field, mode: MirrorMode): Map<string, string> {
  const pairs = new Map<string, string>();
  const boxes = [...(field.obstacles ?? []), ...(field.zones ?? [])].flatMap((box) =>
    "minXIn" in box && typeof box.minXIn === "number" ? [box as unknown as { id: string; minXIn: number; maxXIn: number; minYIn: number; maxYIn: number }] : [],
  );
  const centre = (box: (typeof boxes)[number]): Vec2 => ({ xIn: (box.minXIn + box.maxXIn) / 2, yIn: (box.minYIn + box.maxYIn) / 2 });
  for (const box of boxes) {
    const there = mirrorVec(centre(box), mode);
    const match = boxes.find((other) => Math.hypot(centre(other).xIn - there.xIn, centre(other).yIn - there.yIn) < 1e-6);
    if (match !== undefined) pairs.set(box.id, match.id);
  }
  // Longest first, so `hiveRedPivotBar` is swapped before `hiveRed` could match inside it.
  return new Map([...pairs].sort(([a], [b]) => b.length - a.length));
}

function swapIds(text: string, pairs: Map<string, string>): string {
  // Swap through placeholders, so a pair is not swapped back by its own counterpart.
  let out = text;
  const keys = [...pairs.keys()];
  keys.forEach((id, index) => {
    out = out.split(id).join(`\u0000${String(index)}\u0000`);
  });
  keys.forEach((id, index) => {
    out = out.split(`\u0000${String(index)}\u0000`).join(pairs.get(id) ?? id);
  });
  return out.split("RED").join("\u0001").split("BLUE").join("RED").split("\u0001").join("BLUE");
}

/** One line per finding, with its places written out, so two lists compare as text. */
function describeFinding(finding: Finding, mirror: (p: Vec2) => Vec2, ids: (text: string) => string): string {
  const geometry = finding.geometry;
  return [
    finding.severity,
    finding.code,
    finding.stepId,
    finding.t === undefined ? "" : String(round(finding.t)),
    ids(finding.message),
    geometry?.pointIn === undefined ? "" : point(mirror(geometry.pointIn)),
    (geometry?.polygonIn ?? []).map((corner) => point(mirror(corner))).join(" "),
    ids(geometry?.obstacleId ?? ""),
    ids(geometry?.zoneId ?? ""),
    (finding.fixes ?? []).map((fix) => fix.kind).join(","),
  ].join(" | ");
}

describe.skipIf(!present)("checks read a file in its own alliance's frame", () => {
  const robot = loadRobot(read("autos/robot.json"));
  const field = loadField(read("autos/field/biobuzz.field.json"));
  const waypoints = loadWaypoints(read("autos/waypoints.json"));
  const mode = mirrorForField(field);
  const pairs = counterparts(field, mode);

  // PROVENANCE is left out: it is about where a number came from, not where it is on the field, and
  // `mirrorAuto` writes a waypoint reference out as bare numbers, which PROVENANCE then reports.
  const findingsOf = (auto: Auto): Finding[] => {
    const planned = plan(resolve(auto, waypoints), robot, field);
    return check(planned, estimate(planned, robot), robot, field, biobuzzRules).filter(
      (finding) => finding.code !== "PROVENANCE",
    );
  };

  const compare = (red: Auto): void => {
    const blue = mirrorAuto(red, mode, biobuzzRules.mirrorId, waypoints);
    expect(blue.alliance).toBe("BLUE");
    const fromRed = findingsOf(red)
      .map((finding) => describeFinding(finding, (p) => mirrorVec(p, mode), (text) => swapIds(text, pairs)))
      .sort();
    const fromBlue = findingsOf(blue)
      .map((finding) => describeFinding(finding, (p) => p, (text) => text))
      .sort();
    expect(fromBlue).toEqual(fromRed);
  };

  const autos = present ? readdirSync(`${examples}autos`).filter((file) => file.endsWith(".auto.json")).sort() : [];
  for (const file of autos) {
    it(`gives B as BLUE the findings of F as RED, mirrored, for ${file}`, () => {
      const red = loadAuto(read(`autos/${file}`));
      expect(red.alliance).toBe("RED");
      compare(red);
    });
  }

  const startingAt = (xIn: number, yIn: number, headingRad: number): Auto =>
    loadAuto({
      $schema: "https://libraries.horizon36596.org/zenith/schema/v1/auto.json",
      formatVersion: 3,
      name: "start-probe",
      alliance: "RED",
      start: { pose: { xIn, yIn, headingRad } },
      steps: [{ id: "hold", kind: "wait", seconds: 1 }],
    });

  it("passes B's start where F's start is legal: BLUE's own half, against BLUE's wall", () => {
    const red = startingAt(-40, -63, 1.5708);
    expect(findingsOf(red).filter((finding) => finding.code === "START_ILLEGAL")).toEqual([]);
    const blue = mirrorAuto(red, mode, biobuzzRules.mirrorId, waypoints);
    expect(findingsOf(blue).filter((finding) => finding.code === "START_ILLEGAL")).toEqual([]);
  });

  for (const [what, xIn, yIn, headingRad] of [
    ["in the other half", 40, -63, 1.5708],
    ["in its own loading zone", -66, 36, 0],
    ["touching a flower", -63, -24, 0],
    ["away from every wall", -40, -20, 1.5708],
  ] as const) {
    it(`fails B's start where F's start is ${what}, with the same message mirrored`, () => {
      compare(startingAt(xIn, yIn, headingRad));
    });
  }
});
