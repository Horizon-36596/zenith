import { parseAuto, SCHEMA_ID, type Auto } from "@horizon36596/zenith-schema";
import { describe, expect, it } from "vitest";
import { check } from "./check.js";
import { estimate } from "./estimate.js";
import { plan } from "./plan.js";
import { prBody } from "./prBody.js";
import { resolve } from "./resolve.js";
import { testField, testRobot, testWaypoints } from "./testing/fixtures.js";

const auto: Auto = parseAuto({
  $schema: SCHEMA_ID.auto,
  formatVersion: 1,
  name: "first-auto",
  description: "Score the preload from the start tile, then drive out and wait to collect.",
  alliance: "RED",
  start: { pose: { xIn: -40, yIn: -60, headingRad: 0 } },
  steps: [
    { id: "scorePreload", kind: "command", name: "shootAll", args: { count: 2 } },
    {
      id: "driveOut",
      kind: "path",
      segments: [{ kind: "line", from: "current", to: { xIn: 0, yIn: -60 } }],
      heading: { mode: "tangent" },
    },
    { id: "hold", kind: "wait", until: "hopperFull" },
  ],
});

const planned = plan(resolve(auto, testWaypoints), testRobot, testField);
const timing = estimate(planned, testRobot);
const findings = check(planned, timing, testRobot, testField);
const rows = [
  { stepId: "end", label: "robot", detail: "4 pollen" },
  { stepId: "end", label: "hiveRed", detail: "up NORTH, 1 tip" },
];

describe("prBody", () => {
  const body = prBody(auto, timing, findings, rows, {
    renderUrl: "https://example.test/render.svg",
    periodS: 30,
  });

  it("opens with the name, the description and the committed render", () => {
    const lines = body.split("\n");
    expect(lines[0]).toBe("## first-auto");
    expect(lines[2]).toBe("Score the preload from the start tile, then drive out and wait to collect.");
    expect(body).toContain("![render](https://example.test/render.svg)");
  });

  it("writes one table row per top-level step, with the estimate and the strafe share", () => {
    expect(body).toContain("| step | estimate (s) | strafe | findings |");
    // The fixture robot has no cadence for shootAll, so the command has no estimate to give.
    expect(body).toContain("| scorePreload | unknown | – |");
    expect(body).toMatch(/\| driveOut \| \d+\.\d \(\d+\.\d–\d+\.\d\) \| \d+ % \|/);
  });

  it("says what a step is waiting for when it has no estimate", () => {
    expect(body).toContain("| hold | unknown (until hopperFull) |");
  });

  it("totals against the autonomous period and counts the findings", () => {
    const total = body.split("\n").find((line) => line.startsWith("| **total**")) ?? "";
    expect(total).toMatch(/\*\*at least \d+\.\d \(\d+\.\d–\d+\.\d\) of 30\*\*/);
    expect(total).toMatch(/\d+ errors?, \d+ warnings?/);
  });

  it("ends with the ledger and whether the simulator was run", () => {
    expect(body).toContain("Ledger at end: robot 4 pollen · hiveRed up NORTH, 1 tip");
    expect(body.trimEnd().endsWith("Sim: not run")).toBe(true);
    const withSim = prBody(auto, timing, findings, rows, { simSummary: "first-auto.trace.json @ abc1234, actual total 18.9 s" });
    expect(withSim.trimEnd().endsWith("Sim: first-auto.trace.json @ abc1234, actual total 18.9 s")).toBe(true);
  });

  it("still writes a body when there is no estimate and no render", () => {
    const bare = prBody(auto, null, [], []);
    expect(bare).toContain("| scorePreload | unknown |");
    expect(bare).toContain("| **total** | **unknown of 30** |");
    expect(bare).not.toContain("![render]");
    expect(bare).not.toContain("Ledger at end:");
    expect(bare).toContain("0 errors, 0 warnings");
  });

  it("is deterministic", () => {
    expect(prBody(auto, timing, findings, rows, { periodS: 30 })).toBe(
      prBody(auto, timing, findings, rows, { periodS: 30 }),
    );
  });
});
