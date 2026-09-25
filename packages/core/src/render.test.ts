import { parseAuto, parseField, SCHEMA_ID, type Auto, type Field } from "@horizon36596/zenith-schema";
import { describe, expect, it } from "vitest";
import { check } from "./check.js";
import { estimate } from "./estimate.js";
import { plan } from "./plan.js";
import { mirrorForField, shouldMirror } from "./mirror.js";
import { render } from "./render.js";
import { resolve } from "./resolve.js";
import { TOKENS } from "./tokens.js";
import { testField, testRobot, testWaypoints } from "./testing/fixtures.js";

const auto: Auto = parseAuto({
  $schema: SCHEMA_ID.auto,
  formatVersion: 1,
  name: "render-fixture",
  title: "Render fixture",
  alliance: "RED",
  start: { pose: { xIn: -40, yIn: -60, headingRad: 0 } },
  steps: [
    {
      id: "acrossTheHive",
      kind: "path",
      segments: [{ kind: "line", from: "current", to: { xIn: 10, yIn: -60 } }],
      heading: { mode: "tangent" },
      markers: [{ at: { t: 0.5 }, command: { name: "setIntake", args: { side: "BOTH", state: "FORWARD" } } }],
    },
    { id: "volley", kind: "command", name: "shootAll", args: { count: 2 } },
  ],
});

const planned = plan(resolve(auto, testWaypoints), testRobot, testField);
const timing = estimate(planned, testRobot);
const findings = check(planned, timing, testRobot, testField);

describe("render", () => {
  it("writes one SVG document with the field, the path, the ghosts and the markers", () => {
    const svg = render(planned, timing, findings, []);
    expect(svg.startsWith("<svg xmlns=")).toBe(true);
    expect(svg.trimEnd().endsWith("</svg>")).toBe(true);
    for (const group of ["field", "paths", "ghosts", "markers", "findings", "header"]) {
      expect(svg, group).toContain(`id="${group}"`);
    }
    expect(svg).toContain("setIntake");
    expect(svg).toContain(TOKENS.bgCanvas);
    expect(svg).toContain(TOKENS.pathEstimated);
  });

  it("flips the y axis, because the audience is at the bottom and +y runs away from them", () => {
    const svg = render(planned, timing, findings, []);
    const path = /<polyline id="path-acrossTheHive" points="([^"]+)"/.exec(svg);
    const points = (path?.[1] ?? "").split(" ").map((pair) => pair.split(",").map(Number));
    const first = points[0] as number[];
    const last = points[points.length - 1] as number[];
    // The leg runs from x -40 to x +10 at a constant y, so the drawing moves right and not down.
    expect(last[0] as number).toBeGreaterThan(first[0] as number);
    expect(last[1]).toBeCloseTo(first[1] as number, 6);
    // y = -60 in is near the bottom of a 144 in field drawn 144 in tall.
    expect(first[1] as number).toBeGreaterThan(0.75 * 720);
  });

  it("mirrors the routine for the other alliance and leaves the field where it is", () => {
    const red = render(planned, timing, findings, []);
    const blue = render(planned, timing, findings, [], { alliance: "BLUE" });
    expect(blue).not.toBe(red);
    expect(blue).toContain("BLUE");
    const redPath = /<polyline id="path-acrossTheHive" points="([^"]+)"/.exec(red)?.[1] ?? "";
    const bluePath = /<polyline id="path-acrossTheHive" points="([^"]+)"/.exec(blue)?.[1] ?? "";
    expect(bluePath).not.toBe(redPath);
    // The field's own grid is drawn the same either way: point symmetry leaves a square field alone.
    const gridOf = (svg: string): number => svg.split("<line").length;
    expect(gridOf(blue)).toBe(gridOf(red));
  });

  it("ghosts a base plan underneath when one is given", () => {
    const withBase = render(planned, timing, findings, [], { base: planned });
    expect(withBase).toContain('id="base"');
    expect(withBase).toContain("stroke-dasharray=\"4 4\"");
  });

  it("draws the ledger as a side table only when asked", () => {
    const rows = [{ stepId: "end", label: "robot", detail: "4 pollen" }];
    expect(render(planned, timing, findings, rows)).not.toContain('id="ledger"');
    const withLedger = render(planned, timing, findings, rows, { showLedger: true });
    expect(withLedger).toContain('id="ledger"');
    expect(withLedger).toContain("4 pollen");
  });

  it("places the ghosts by time when there is an estimate and by distance when there is not", () => {
    const timed = render(planned, timing, findings, []);
    const untimed = render(planned, null, findings, []);
    const ghosts = (svg: string): number => svg.split("<polygon").length - 1;
    expect(ghosts(timed)).toBeGreaterThan(0);
    expect(ghosts(untimed)).toBeGreaterThan(0);
    expect(ghosts(timed)).not.toBe(ghosts(untimed));
  });

  it("is deterministic and free of anything a rasteriser cannot read", () => {
    const once = render(planned, timing, findings, [], { showLedger: true });
    expect(render(planned, timing, findings, [], { showLedger: true })).toBe(once);
    expect(once).not.toContain("var(--");
    expect(once).not.toContain("oklch(");
    expect(once).not.toContain("NaN");
    expect(once).not.toContain("undefined");
  });
});

describe("which baseline the render mirrors off", () => {
  /** The same routine and the same canonical coordinates, declared for the other alliance. */
  const blueAuto: Auto = parseAuto({
    ...(JSON.parse(JSON.stringify(auto)) as Record<string, unknown>),
    alliance: "BLUE",
  });
  const bluePlan = plan(resolve(blueAuto, testWaypoints), testRobot, testField);
  const pathOf = (svg: string): string =>
    /<polyline id="path-acrossTheHive" points="([^"]+)"/.exec(svg)?.[1] ?? "";

  it("finding 21: mirrors off the field's canonical alliance, not the routine's", () => {
    // testField is canonically RED. A BLUE routine's poses are still canonical, so viewed as RED
    // they are drawn exactly where a RED routine's are, and viewed as BLUE they are mirrored.
    const asRed = render(bluePlan, null, [], [], { alliance: "RED" });
    const asBlue = render(bluePlan, null, [], [], { alliance: "BLUE" });
    expect(pathOf(asRed)).toBe(pathOf(render(planned, null, [], [], { alliance: "RED" })));
    expect(pathOf(asBlue)).not.toBe(pathOf(asRed));
  });

  it("finding 21: with no alliance asked for, a BLUE routine draws mirrored", () => {
    expect(pathOf(render(bluePlan, null, [], []))).toBe(
      pathOf(render(bluePlan, null, [], [], { alliance: "BLUE" })),
    );
  });

  it("finding 22: obeys the field's own mirror mode", () => {
    const mirrorX = parseField({
      ...(JSON.parse(JSON.stringify(testField)) as Record<string, unknown>),
      frame: { ...testField.frame, mirror: "mirrorX" },
    });
    const none = parseField({
      ...(JSON.parse(JSON.stringify(testField)) as Record<string, unknown>),
      frame: { ...testField.frame, mirror: "none" },
    });
    const drawnWith = (field: Field): string =>
      pathOf(
        render(plan(resolve(auto, testWaypoints), testRobot, field), null, [], [], {
          alliance: "BLUE",
        }),
      );
    expect(drawnWith(mirrorX)).not.toBe(drawnWith(testField));
    // A field that declares no symmetry is never mirrored, whoever is looking at it.
    expect(drawnWith(none)).toBe(pathOf(render(planned, null, [], [], { alliance: "RED" })));
  });

  it("finding 21: shouldMirror is the rule both front ends ask", () => {
    expect(shouldMirror(auto, testField, "RED")).toBe(false);
    expect(shouldMirror(auto, testField, "BLUE")).toBe(true);
    expect(shouldMirror(blueAuto, testField, "RED")).toBe(false);
    expect(shouldMirror(blueAuto, testField)).toBe(true);
    expect(mirrorForField(testField)).toBe("pointSymmetry");
  });
});
