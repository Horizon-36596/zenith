/**
 * What the Problems list shows (issue #413): the time budget's info note is not listed or counted, a
 * clean starter auto lists nothing while `check()` still returns the note, and every fix button says
 * a verb and a noun with no obstacle name in it.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadAuto, loadField, loadRobot, loadWaypoints, type Finding, type Fix } from "@horizon36596/zenith-core";
import { derive } from "../state/derived";
import {
  ROUTE_AROUND_ABOVE,
  fixHint,
  fixLabel,
  fixStatusLine,
  listedInProblems,
  noFixReason,
  offeredFixes,
  problemsListed,
  routeAroundShownAbove,
} from "./findingRows";

const examples = fileURLToPath(new URL("../../../../examples/starter/autos/", import.meta.url));
const read = (relative: string): unknown => JSON.parse(readFileSync(`${examples}${relative}`, "utf8"));
const robot = loadRobot(read("robot.json"));
const field = loadField(read("field/biobuzz.field.json"));
const waypoints = loadWaypoints(read("waypoints.json"));

const finding = (code: Finding["code"], severity: Finding["severity"]): Finding => ({ code, severity, stepId: "total", message: "m" });

describe("the Problems list", () => {
  it("leaves out the time budget's info note and keeps its warning and error", () => {
    expect(listedInProblems(finding("TIME_BUDGET", "info"))).toBe(false);
    expect(listedInProblems(finding("TIME_BUDGET", "warning"))).toBe(true);
    expect(listedInProblems(finding("TIME_BUDGET", "error"))).toBe(true);
    expect(listedInProblems(finding("PROVENANCE", "info"))).toBe(true);
  });

  it("lists nothing for the clean starter, though check() still returns the note", () => {
    const auto = loadAuto(read("collect-and-score.auto.json"));
    const findings = derive(auto, robot, field, waypoints).findings;
    expect(findings.some((each) => each.code === "TIME_BUDGET" && each.severity === "info")).toBe(true);
    expect(problemsListed(findings)).toEqual([]);
  });
});

describe("fix labels", () => {
  const fixes: Fix[] = [
    {
      kind: "pushBack",
      stepId: "a",
      label: "Push the end clear of the foot of flower1 on the north wall (flower1Foot)",
      params: { xIn: 1, yIn: 2, clearOf: "the foot of flower1 on the north wall (flower1Foot)" },
    },
    { kind: "pushBack", stepId: "a", label: "Push the end back from the wall", params: { xIn: 1, yIn: 2 } },
    { kind: "optimizeRoute", stepId: "a", label: "Route around the foot of flower1 on the north wall", params: { obstacleId: "flower1Foot" } },
    { kind: "optimizeRoute", stepId: "a", label: "Find a faster heading", params: { mode: "headingOnly" } },
    { kind: "raiseTimeout", stepId: "a", label: "Raise the timeout to 2.50 s", params: { timeoutS: 2.5 } },
    { kind: "moveToLegalApproach", stepId: "a", label: "Move the end of driveOut to the legal approach band", params: { xIn: 0, yIn: 0 } },
    { kind: "joinSegments", stepId: "a", label: "Join path 2 to path 1", params: { segmentIndex: 1 } },
  ];

  it("say a verb and a noun", () => {
    expect(fixes.map(fixLabel)).toEqual([
      "Push end clear",
      "Push end back",
      "Route around",
      "Find faster heading",
      "Raise timeout",
      "Move to approach",
      "Join paths",
    ]);
    for (const fix of fixes) expect(fixLabel(fix).split(" ").length).toBeLessThanOrEqual(3);
  });

  it("never name the obstacle, on the button or in its tooltip", () => {
    for (const fix of fixes.slice(0, 3)) {
      expect(fixLabel(fix)).not.toMatch(/flower1|wall/);
      expect(fixHint(fix) ?? "").not.toMatch(/flower1/);
    }
  });

  it("keep core's numbers in the tooltip", () => {
    expect(fixHint(fixes[4] as Fix)).toBe("Raise the timeout to 2.50 s.");
  });

  it("say that Set timeout leaves the number to the person", () => {
    const fix: Fix = { kind: "focusTimeout", stepId: "a", label: "Set a timeout", params: {} };
    expect(fixLabel(fix)).toBe("Set timeout");
    expect(fixHint(fix)).toBe("Type how long the robot may wait in Give up after.");
  });
});

describe("the status line after a fix (0.1.2 UX sweep W2-22)", () => {
  const undo = "press Ctrl Z to undo";
  const line = (fix: Fix): string | null => fixStatusLine(fix, undo);

  it("says what each fix that writes changed, and how to undo it in the person's own key", () => {
    expect(line({ kind: "pushBack", stepId: "path3", label: "Push the end back from the wall", params: { xIn: 1, yIn: 2 } })).toBe(
      "Moved the end of path3 back from the wall. Press Ctrl Z to undo.",
    );
    // Read from the params, not the label: the label is core's wording and may change.
    expect(line({ kind: "pushBack", stepId: "path3", label: "x", params: { xIn: 1, yIn: 2, clearOf: "the foot of flower1 on the north wall (flower1Foot)" } })).toBe(
      "Moved the end of path3 clear of the foot of flower1 on the north wall (flower1Foot). Press Ctrl Z to undo.",
    );
    expect(line({ kind: "moveToLegalApproach", stepId: "path2", label: "x", params: { xIn: 0, yIn: 0, aim: "fixed" } })).toBe(
      "Moved the end of path2 to a legal spot to launch from, turned so the same side faces the target. Press Ctrl Z to undo.",
    );
    expect(line({ kind: "moveToLegalApproach", stepId: "path2", label: "the turret", params: { xIn: 0, yIn: 0, aim: "turret" } })).toBe(
      "Moved the end of path2 to a legal spot to launch from, turned so the target is in the turret's range. Press Ctrl Z to undo.",
    );
    expect(
      line({ kind: "moveToLegalApproach", stepId: "path2", label: "x", params: { xIn: 0, yIn: 0, addsWarning: "This path is driven sideways." } }),
    ).toBe(
      "Moved the end of path2 to a legal spot to launch from, turned so the same side faces the target. No spot nearby was free of new warnings, so this adds one: This path is driven sideways. Press Ctrl Z to undo.",
    );
    expect(line({ kind: "makeTangent", stepId: "path2", label: "x", params: {} })).toBe("path2 points its nose along the path now. Press Ctrl Z to undo.");
    expect(fixStatusLine({ kind: "linearHeading", stepId: "leg", label: "x", params: { fromRad: 0, toRad: 1 } }, "use Undo")).toBe(
      "leg turns while it drives now. Use Undo.",
    );
  });

  it("says nothing for a fix that writes nothing: Set timeout and Route around", () => {
    expect(line({ kind: "focusTimeout", stepId: "w", label: "x", params: {} })).toBeNull();
    expect(line({ kind: "optimizeRoute", stepId: "w", label: "x", params: {} })).toBeNull();
  });
});

describe("a row that offers no fix because its path ends inside the hive frame (0.1.2 UX sweep W2-7)", () => {
  const routeAround: Fix = { kind: "optimizeRoute", stepId: "toHive", label: "Route around the west base bar of the hive frame", params: { obstacleId: "hiveWest" } };
  const structure = (tRange: [number, number]): Finding => ({
    code: "STRUCTURE",
    severity: "error",
    stepId: "toHive",
    message: "m",
    geometry: { obstacleId: "hiveWest", tRange },
    fixes: [routeAround],
  });

  it("says why there is no fix and what to do first", () => {
    const ends = structure([0.8, 1]);
    expect(offeredFixes(ends)).toEqual([]);
    expect(noFixReason(ends, offeredFixes(ends), true)).toBe(
      "This path ends inside the west base bar of the hive frame: move its end out first, then Route around can help.",
    );
    const starts = structure([0, 0.2]);
    expect(noFixReason(starts, offeredFixes(starts), true)).toBe(
      "This path starts inside the west base bar of the hive frame: move its start out first, then Route around can help.",
    );
  });

  it("says nothing when the row offers a fix, Route around is switched off, or the end is clear", () => {
    const clear = structure([0.3, 0.6]);
    expect(noFixReason(clear, offeredFixes(clear), true)).toBeNull();
    const ends = structure([0.8, 1]);
    expect(noFixReason(ends, offeredFixes(ends), false)).toBeNull();
    expect(noFixReason(ends, [routeAround], true)).toBeNull();
  });

  it("says a PERIMETER path ends outside the field, not inside the wall", () => {
    const wall: Fix = { kind: "optimizeRoute", stepId: "toWall", label: "Route around the field wall", params: {} };
    const perimeter = (t: number): Finding => ({ code: "PERIMETER", severity: "error", stepId: "toWall", message: "m", t, fixes: [wall] });
    expect(noFixReason(perimeter(1), offeredFixes(perimeter(1)), true)).toBe(
      "This path ends outside the field: move its end in first, then Route around can help.",
    );
    expect(noFixReason(perimeter(0), offeredFixes(perimeter(0)), true)).toBe(
      "This path starts outside the field: move its start in first, then Route around can help.",
    );
  });

  it("says why a CLEARANCE row at a path's own end offers no Route around", () => {
    const clearance = (t: number, stepId = "toHive"): Finding => ({
      code: "CLEARANCE",
      severity: "warning",
      stepId,
      message: "m",
      t,
      geometry: { obstacleId: "hiveWest", gapIn: 0.1 },
    });
    const about = { pathSteps: new Set(["toHive"]), obstacleName: (id: string) => (id === "hiveWest" ? "the west base bar of the hive frame" : id) };
    expect(noFixReason(clearance(1), [], true, new Set(), about)).toBe(
      "The end of this path is 0.10 in from the west base bar of the hive frame: move the end, Route around keeps both ends.",
    );
    expect(noFixReason(clearance(0), [], true, new Set(), about)).toBe(
      "The start of this path is 0.10 in from the west base bar of the hive frame: move the start, Route around keeps both ends.",
    );
    // Not at an end, not a path (a wait standing there), or Route around switched off: nothing to say.
    expect(noFixReason(clearance(0.5), [], true, new Set(), about)).toBeNull();
    expect(noFixReason(clearance(1, "wait1"), [], true, new Set(), about)).toBeNull();
    expect(noFixReason(clearance(1), [], false, new Set(), about)).toBeNull();
  });

  it("says another end is inside something when a different finding left Route around off", () => {
    const clear = structure([0.3, 0.6]);
    expect(noFixReason(clear, offeredFixes(clear, new Set(["toHive"])), true, new Set(["toHive"]))).toBe(
      "This path starts or ends inside something: move that end out first, then Route around can help.",
    );
  });
});

describe("one Route around per step among its STRUCTURE rows (0.1.2 UX sweep K20)", () => {
  // The starter's toOtherSide with its first two curve controls moved under the hive, into the
  // frame's west base bar and two of its legs: one finding each, all on the one step.
  const starter = loadAuto(read("collect-and-score.auto.json"));
  const clipped = loadAuto({
    ...starter,
    steps: starter.steps.map((step) =>
      step.id === "toOtherSide" && step.kind === "path"
        ? {
            ...step,
            segments: step.segments.map((segment, at) =>
              at === 0 && segment.kind === "bezier"
                ? { ...segment, control: segment.control.map((control, index) => (index < 2 ? { ...control, xIn: -9 } : control)) }
                : segment,
            ),
          }
        : step,
    ),
  });
  const structures = derive(clipped, robot, field, waypoints).findings.filter(
    (each) => each.code === "STRUCTURE" && each.stepId === "toOtherSide",
  );

  it("keeps Route around on the first row only, and the others say it covers them", () => {
    expect(structures.length).toBeGreaterThanOrEqual(3);
    // Core still offers it on every one of them.
    for (const each of structures) expect(each.fixes?.some((fix) => fix.kind === "optimizeRoute")).toBe(true);
    const above = routeAroundShownAbove(structures);
    expect(above.has(structures[0] as Finding)).toBe(false);
    expect(above.size).toBe(structures.length - 1);
    const offered = structures.map((each) => offeredFixes(each, undefined, above.has(each)).filter((fix) => fix.kind === "optimizeRoute").length);
    expect(offered).toEqual([1, ...structures.slice(1).map(() => 0)]);
    for (const each of structures.slice(1)) {
      const shown = offeredFixes(each, undefined, true);
      if (shown.length === 0) expect(noFixReason(each, shown, true, undefined, { routeAroundAbove: true })).toBe(ROUTE_AROUND_ABOVE);
    }
  });

  it("counts each step on its own, and leaves rows of other codes alone", () => {
    const fix = (stepId: string): Fix => ({ kind: "optimizeRoute", stepId, label: "Route around x", params: {} });
    const row = (code: Finding["code"], stepId: string): Finding => ({
      code,
      severity: "error",
      stepId,
      message: "m",
      geometry: { tRange: [0.3, 0.6] },
      fixes: [fix(stepId)],
    });
    const rows = [row("STRUCTURE", "a"), row("PERIMETER", "a"), row("STRUCTURE", "b"), row("STRUCTURE", "a")];
    expect([...routeAroundShownAbove(rows)]).toEqual([rows[3]]);
  });
});
