/**
 * The hives on the field (`hiveLayer.ts`): drawn from the ledger at the playback time, a tip as a
 * swing on that clock that starts where the step that tipped it ends, the load riding the cell down
 * until the bar is level and then leaving the drawing (the floor quarter's count chip shows it, not
 * a drawn piece), and the same frame for the same time.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadAuto, loadField, loadRobot, plan, resolve, simulate } from "@horizon36596/zenith-core";
import { FORMAT_VERSIONS, SCHEMA_ID, type Auto } from "@horizon36596/zenith-schema";
import { describe, expect, it } from "vitest";
import { ledgerFor, previewSimOptions } from "../state/ledgerRun";
import { hiveFrameAt, hiveSummary, hiveTimeline, swingPose, type HiveTimeline } from "./hiveLayer";
import { pieceInk } from "./pieceColours";
import { fallbackTheme } from "./theme";

const read = (relative: string): unknown =>
  JSON.parse(readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8")) as unknown;

const field = loadField(read("../../../../examples/starter/autos/field/biobuzz.field.json"));
const robot = loadRobot(read("../../../../examples/starter/autos/robot.json"));

/** A wait, then the partner scoring 4 pollen into the red up cell, which tips it, then a long wait. */
const tipping: Auto = loadAuto({
  $schema: SCHEMA_ID.auto,
  formatVersion: FORMAT_VERSIONS.auto,
  name: "hive tip",
  alliance: "RED",
  start: { pose: { xIn: -40, yIn: -63, headingRad: 1.5708 }, holds: { pollen: 4 } },
  steps: [
    { id: "settle", kind: "wait", seconds: 1 },
    { id: "partnerScores", kind: "transfer", from: "partner", to: "hiveRedUpCell", expectedCount: 4 },
    { id: "watch", kind: "wait", seconds: 6 },
  ],
});

function timelineOf(auto: Auto): { timeline: HiveTimeline; tipAtS: number } {
  const planned = plan(resolve(auto, undefined, robot), robot, field);
  const view = ledgerFor(planned, field);
  if (view.run === null) throw new Error(view.reason ?? "no ledger");
  const trace = simulate(planned, robot, field, previewSimOptions(planned, field));
  const timeline = hiveTimeline(view.run, trace, field);
  if (timeline === null) throw new Error("no hive timeline");
  const tipAtS = trace.steps.find((step) => step.id === "partnerScores")?.endS ?? Number.NaN;
  return { timeline, tipAtS };
}

const red = (frame: ReturnType<typeof hiveFrameAt>) => frame.hives.find((entry) => entry.hive.id === "hiveRed");

describe("hives on the field", () => {
  const { timeline, tipAtS } = timelineOf(tipping);

  it("shows the kickoff hive before the tip: south up, holding the 3 staged nectar", () => {
    const frame = hiveFrameAt(timeline, 0);
    expect(red(frame)?.upSide).toBe("SOUTH");
    expect(red(frame)?.swing).toBeNull();
    expect(red(frame)?.row).toEqual(["nectarRed", "nectarRed", "nectarRed"]);
    expect(hiveSummary(frame)).toContain("hiveRed:up=SOUTH,cell=3");
  });

  it("swings from the end of the step that tipped it, for the swing time the load sets", () => {
    const tip = timeline.tips.find((event) => event.hiveId === "hiveRed");
    expect(tip?.startS).toBeCloseTo(tipAtS, 9);
    expect(tip?.fromSide).toBe("SOUTH");
    expect(tip?.toSide).toBe("NORTH");
    // 3 nectar and 4 pollen: one over the 3 the table asks for.
    expect(tip?.row).toEqual(["nectarRed", "nectarRed", "nectarRed", "pollen", "pollen", "pollen", "pollen"]);
    const swingS = tip?.swingS ?? Number.NaN;
    expect(swingS).toBeGreaterThan(2);
    expect(swingS).toBeLessThan(4);

    // A quarter through: the load still rides the south cell, which is still more up than down.
    const early = red(hiveFrameAt(timeline, tipAtS + swingS * 0.25));
    expect(early?.swing?.progress).toBeCloseTo(0.25, 6);
    expect(early?.rowSide).toBe("SOUTH");
    expect(early?.row).toHaveLength(7);
    expect(early?.up).toBeGreaterThan(0.5);
    expect(early?.up).toBeLessThan(1);

    // Past level the cell has emptied, and nothing is drawn leaving it.
    const late = hiveFrameAt(timeline, tipAtS + swingS * 0.75);
    expect(red(late)?.row).toEqual([]);
    expect(red(late)?.up).toBeLessThan(0.5);

    // Settled: north up and empty. The 7 are the south quarter's count in the ledger, not drawn here.
    const after = hiveFrameAt(timeline, tipAtS + swingS + 1);
    expect(red(after)?.swing).toBeNull();
    expect(red(after)?.upSide).toBe("NORTH");
    expect(hiveSummary(after)).toBe("hiveRed:up=NORTH,cell=0;hiveBlue:up=NORTH,cell=3");
    const last = timeline.keyframes[timeline.keyframes.length - 1]!;
    const dumped = Object.values(last.state.floor).reduce(
      (sum, area) => sum + Object.values(area.holds).reduce((inArea, count) => inArea + count, 0),
      0,
    );
    expect(dumped).toBe(7);
  });

  it("draws the same frame for the same time, whichever way the playhead got there", () => {
    const at = tipAtS + 0.8;
    const first = hiveSummary(hiveFrameAt(timeline, at));
    hiveFrameAt(timeline, tipAtS + 3);
    hiveFrameAt(timeline, 0);
    expect(hiveSummary(hiveFrameAt(timeline, at))).toBe(first);
  });

  it("draws the hives as the field file stages them when the ledger is switched off", () => {
    const kickoff = hiveTimeline(null, null, field);
    expect(kickoff?.tips).toEqual([]);
    expect(hiveSummary(hiveFrameAt(kickoff!, 12))).toBe("hiveRed:up=SOUTH,cell=3;hiveBlue:up=NORTH,cell=3");
    expect(hiveTimeline(null, null, { ...field, season: "other", rules: { plugin: "other" } })).toBeNull();
  });

  it("colours pollen gold and nectar by alliance, swapping alliances when mirrored", () => {
    const theme = fallbackTheme();
    const nectar = { RED: "nectarRed", BLUE: "nectarBlue" };
    expect(pieceInk(theme, "pollen", nectar)).toBe(theme.fieldPollen);
    expect(theme.fieldPollen).not.toBe(theme.fieldZone);
    expect(pieceInk(theme, "nectarRed", nectar)).toBe(theme.allianceRed);
    expect(pieceInk(theme, "nectarBlue", nectar)).toBe(theme.allianceBlue);
    expect(pieceInk(theme, "nectarRed", nectar, true)).toBe(theme.allianceBlue);
  });

  it("eases the swing the way the bar moves: still at the ends, fastest and furthest out at level", () => {
    expect(swingPose(0)).toEqual({ proj: 1, up: 1 });
    expect(swingPose(1).up).toBeCloseTo(0, 9);
    expect(swingPose(1).proj).toBeCloseTo(1, 9);
    expect(swingPose(0.5).up).toBeCloseTo(0.5, 9);
    expect(swingPose(0.5).proj).toBeCloseTo(1 / Math.cos(Math.PI / 6), 9);
    const step = (from: number): number => swingPose(from).up - swingPose(from + 0.05).up;
    expect(step(0.475)).toBeGreaterThan(step(0));
  });
});
