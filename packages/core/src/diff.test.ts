import { parseAuto, SCHEMA_ID, type Auto, type PathStep, type Step } from "@horizon36596/zenith-schema";
import { describe, expect, it } from "vitest";
import { diff, diffToMarkdown, walkSteps } from "./diff.js";
import { collectIds } from "./edit/ids.js";
import { estimate } from "./estimate.js";
import { plan } from "./plan.js";
import { resolve } from "./resolve.js";
import { testField, testRobot, testWaypoints } from "./testing/fixtures.js";

const leg = (id: string, toX: number, toY: number): PathStep => ({
  id,
  kind: "path",
  segments: [{ kind: "line", from: "current", to: { xIn: toX, yIn: toY } }],
  heading: { mode: "tangent" },
});

const auto = (steps: Step[], overrides: Record<string, unknown> = {}): Auto =>
  parseAuto({
    $schema: SCHEMA_ID.auto,
    formatVersion: 1,
    name: "diff-fixture",
    alliance: "RED",
    start: { pose: { xIn: -40, yIn: -60, headingRad: 0 } },
    steps,
    ...overrides,
  });

const base = auto([leg("out", 0, -60), { id: "volley", kind: "command", name: "shootAll", args: { count: 2 } }]);

describe("diff", () => {
  it("says nothing changed when nothing changed", () => {
    const outcome = diff(base, auto([...base.steps]));
    expect(outcome.identical).toBe(true);
    expect(outcome.changes).toEqual([]);
    expect(diffToMarkdown(outcome)).toBe("No structural changes.");
  });

  it("reports an added and a removed step by id", () => {
    const outcome = diff(base, auto([leg("out", 0, -60), leg("park", 20, -20)]));
    expect(outcome.changes.map((change) => [change.stepId, change.kind])).toEqual([
      ["volley", "removed"],
      ["park", "added"],
    ]);
    expect(outcome.changes[0]?.summary).toBe("The command step at position 2 was removed.");
    expect(outcome.changes[1]?.summary).toBe("A path step was added at position 2.");
  });

  it("lists the fields that changed and how far each pose moved", () => {
    const moved = auto([
      { ...leg("out", 6, -57), speedFraction: 0.5 },
      base.steps[1] as Step,
    ]);
    const outcome = diff(base, moved);
    expect(outcome.changes).toHaveLength(1);
    const change = outcome.changes[0];
    expect(change?.kind).toBe("changed");
    expect(change?.fields).toEqual(["segments", "speedFraction"]);
    expect(change?.poseDeltas).toHaveLength(1);
    expect(change?.poseDeltas?.[0]?.where).toBe("segments[0].to");
    expect(change?.poseDeltas?.[0]?.dxIn).toBeCloseTo(6, 9);
    expect(change?.poseDeltas?.[0]?.distanceIn).toBeCloseTo(Math.hypot(6, 3), 9);
    expect(change?.summary).toContain("Its segments and speedFraction changed");
    expect(change?.summary).toContain("one pose moved, the furthest by 6.71 in");
  });

  it("takes the heading the short way round rather than the long one", () => {
    const before = auto([
      { ...leg("out", 0, -60), segments: [{ kind: "line", from: "current", to: { xIn: 0, yIn: -60, headingRad: 3.1 } }] },
    ]);
    const after = auto([
      { ...leg("out", 0, -60), segments: [{ kind: "line", from: "current", to: { xIn: 0, yIn: -60, headingRad: -3.1 } }] },
    ]);
    const delta = diff(before, after).changes[0]?.poseDeltas?.[0];
    expect(delta?.dHeadingRad).toBeCloseTo(2 * Math.PI - 6.2, 9);
  });

  it("notices a step that only moved, and one that moved between lists", () => {
    const reordered = diff(base, auto([base.steps[1] as Step, leg("out", 0, -60)]));
    expect(reordered.changes.map((change) => change.kind)).toEqual(["moved", "moved"]);
    expect(reordered.changes.find((change) => change.stepId === "out")?.summary).toBe(
      "The path step moved from position 1 to position 2.",
    );

    const nested = diff(
      base,
      auto([
        { id: "group", kind: "parallel", mode: "all", steps: [leg("out", 0, -60)] },
        base.steps[1] as Step,
      ]),
    );
    expect(nested.changes.find((change) => change.stepId === "out")?.summary).toBe(
      "The path step moved out of steps and into group.steps.",
    );
    expect(nested.changes.some((change) => change.stepId === "group" && change.kind === "added")).toBe(true);
  });

  it("names the document fields that changed", () => {
    const outcome = diff(base, auto([...base.steps], { alliance: "BLUE", title: "Mirror" }));
    expect(outcome.header).toEqual(["title", "alliance"]);
    expect(outcome.identical).toBe(false);
    expect(diffToMarkdown(outcome)).toContain("Header: title, alliance changed.");
  });

  it("keys steps without ids on their position, exactly as resolve names them", () => {
    const nameless = auto([{ kind: "wait", seconds: 1 }]);
    expect(diff(base, nameless).changes.some((change) => change.stepId === "step1")).toBe(true);
  });

  it("writes markdown with the estimate change per step and in total", () => {
    const longer = auto([leg("out", 40, -60), base.steps[1] as Step]);
    const before = estimate(plan(resolve(base, testWaypoints), testRobot, testField), testRobot);
    const after = estimate(plan(resolve(longer, testWaypoints), testRobot, testField), testRobot);
    const markdown = diffToMarkdown(diff(base, longer), before, after);
    expect(markdown).toContain("`out` changed.");
    expect(markdown).toContain("Estimate ");
    expect(markdown).toMatch(/Total: \d+\.\d\d s to \d+\.\d\d s \(\+\d+\.\d\d s\)\./);
    expect(markdown).toContain("moved 40 in (x +40.00, y +0.00)");
  });
});

describe("walkSteps", () => {
  /** A branch with one unnamed step in each arm, the case where the two names differ. */
  const bothArms = (elseToXIn: number): Auto =>
    parseAuto({
      $schema: SCHEMA_ID.auto,
      formatVersion: 1,
      name: "branch-ids",
      alliance: "RED",
      start: { pose: { xIn: 0, yIn: 0, headingRad: 0 } },
      steps: [
        {
          id: "b",
          kind: "branch",
          condition: "hopperFull",
          then: [{ kind: "command", name: "launcherIdle" }],
          else: [
            {
              kind: "path",
              segments: [{ kind: "line", from: "current", to: { xIn: elseToXIn, yIn: 0 } }],
              heading: { mode: "tangent" },
            },
          ],
        },
      ],
    });

  it("finding 20: names a branch's two arms the way resolve and collectIds do", () => {
    const ids = walkSteps(bothArms(10).steps).map((entry) => entry.id);
    expect(ids).toEqual(["b", "b.1.1", "b.2.1"]);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...collectIds(bothArms(10).steps)].sort()).toEqual([...ids].sort());
  });

  it("finding 20: a change in one arm is anchored to that arm's own step", () => {
    const changes = diff(bothArms(10), bothArms(20)).changes;
    expect(changes.map((change) => change.stepId)).toEqual(["b.2.1"]);
  });
});
