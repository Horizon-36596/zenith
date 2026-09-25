/**
 * The review view model: the changed steps a reviewer is shown, and what each change did to the
 * estimate (site/docs/github.md, review links). Two versions of the bundled
 * example, diffed and estimated against the real robot and field files — no network and no browser.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadAuto, loadField, loadRobot, loadWaypoints, removeStep, setPose } from "@horizon36596/zenith-core";
import type { Auto, Field, Robot, Waypoints } from "@horizon36596/zenith-schema";
import { buildReviewModel } from "./reviewModel";

const read = (path: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../../examples/starter/${path}`, import.meta.url)), "utf8");

const robot: Robot = loadRobot(JSON.parse(read("autos/robot.json")));
const field: Field = loadField(JSON.parse(read("autos/field/biobuzz.field.json")));
const waypoints: Waypoints = loadWaypoints(JSON.parse(read("autos/waypoints.json")));
// first-auto ends its first leg on the scoreSouth waypoint. A reviewer is told how far a pose moved
// only between two explicit poses, so the base carries that end inline, where the editor puts it
// once the point has been dragged.
const base: Auto = setPose(
  loadAuto(JSON.parse(read("autos/first-auto.auto.json"))),
  "driveOut",
  { segmentIndex: 0, pointKind: "to" },
  { xIn: -12, yIn: -36, headingRad: 1.5708, provenance: "SET FROM EDITOR: test" },
);

const model = (head: Auto) => buildReviewModel({ base, head, robot, field, waypoints });

/** The first leg's endpoint, moved a foot back towards the start, as a drag in the editor would. */
const movedEndpoint = (): Auto =>
  setPose(
    base,
    "driveOut",
    { segmentIndex: 0, pointKind: "to" },
    { xIn: -12, yIn: -48, headingRad: 1.5708, provenance: "SET FROM EDITOR: test" },
  );

describe("buildReviewModel", () => {
  it("says nothing changed when nothing did, and still totals both sides", () => {
    const result = model(base);

    expect(result.identical).toBe(true);
    expect(result.rows).toEqual([]);
    expect(result.totals.baseS).not.toBeNull();
    expect(result.totals.headS).toBe(result.totals.baseS);
    expect(result.totals.deltaS).toBe(0);
  });

  it("reports a moved endpoint as one changed step, with how far it moved", () => {
    const result = model(movedEndpoint());

    expect(result.identical).toBe(false);
    const row = result.rows.find((candidate) => candidate.stepId === "driveOut");
    expect(row?.kind).toBe("changed");
    expect(row?.movedIn).toBeCloseTo(12, 1);
    expect(row?.fields).toContain("segments");
  });

  it("carries the estimate delta of a changed step, not just that it changed", () => {
    const result = model(movedEndpoint());
    const row = result.rows.find((candidate) => candidate.stepId === "driveOut");

    expect(row?.baseS).not.toBeNull();
    expect(row?.headS).not.toBeNull();
    // A shorter first leg: the head takes less time than the base, and the row says by how much.
    expect(row?.headS as number).toBeLessThan(row?.baseS as number);
    expect(row?.deltaS).toBeCloseTo((row?.headS as number) - (row?.baseS as number), 6);
    // The total is the whole routine's, not this step's: moving one endpoint shortens this leg and
    // lengthens the next, so the two numbers are allowed to disagree in sign.
    expect(result.totals.deltaS).toBeCloseTo(
      (result.totals.headS as number) - (result.totals.baseS as number),
      6,
    );
  });

  it("gives a removed step its own row, whose delta is the time it gave back", () => {
    const result = model(removeStep(base, "park"));
    const row = result.rows.find((candidate) => candidate.stepId === "park");

    expect(row?.kind).toBe("removed");
    expect(row?.headS).toBeNull();
    expect(row?.baseS).not.toBeNull();
    expect(row?.deltaS).toBeCloseTo(-(row?.baseS as number), 6);
  });

  it("treats a pull request that adds the file as every step being new", () => {
    const result = buildReviewModel({ base: null, head: base, robot, field, waypoints });

    expect(result.basePlan).toBeNull();
    expect(result.totals.baseS).toBeNull();
    expect(result.totals.deltaS).toBeNull();
    expect(result.rows).toHaveLength(base.steps.length);
    expect(result.rows.every((row) => row.kind === "added")).toBe(true);
    expect(result.rows[0]?.deltaS).toBe(result.rows[0]?.headS);
  });

  it("keeps the base's plan so the canvas can ghost it, and the head's findings", () => {
    const result = model(movedEndpoint());

    expect(result.basePlan?.steps.length).toBeGreaterThan(0);
    // The findings shown are the head's: the base's are history, not something to accept.
    const headOnly = buildReviewModel({
      base: movedEndpoint(),
      head: movedEndpoint(),
      robot,
      field,
      waypoints,
    });
    expect(result.findings.map((finding) => finding.code)).toEqual(
      headOnly.findings.map((finding) => finding.code),
    );
  });
});
