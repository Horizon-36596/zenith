import type { Auto, Heading, Segment } from "@horizon36596/zenith-schema";
import { describe, expect, it } from "vitest";
import { canonicalize } from "./canonicalize.js";
import { setRoute } from "./edit/path.js";
import { testAuto } from "./edit/testing.js";
import { applyFix, applyFixes } from "./fix.js";
import type { Fix } from "./types.js";

const segments: Segment[] = [
  { kind: "line", from: "current", to: { xIn: 0, yIn: 10 } },
  { kind: "bezier", from: "current", control: [{ xIn: 4, yIn: 20 }], to: { xIn: 0, yIn: 24, headingRad: 0 } },
];
const heading: Heading = { mode: "linear", fromRad: 0, toRad: 0 };

const replaceRoute = (stepId: string): Fix => ({
  kind: "replaceRoute",
  stepId,
  label: "Use the faster route",
  params: { segments, heading },
});

describe("replaceRoute", () => {
  it("equals setRoute, byte for byte", () => {
    const auto = testAuto();
    expect(canonicalize("auto", applyFix(auto, replaceRoute("leg1")))).toBe(
      canonicalize("auto", setRoute(auto, "leg1", segments, heading)),
    );
  });

  it("changes only the route, so the step's other fields stay", () => {
    const step = applyFix(testAuto(), replaceRoute("leg1")).steps[0];
    expect(step?.kind === "path" && step.segments).toEqual(segments);
    expect(step?.kind === "path" && step.heading).toEqual(heading);
    expect(step).toMatchObject({ speedFraction: 0.8, timeoutS: 3, markers: [{ at: { t: 0.5 } }] });
  });

  it("reaches a path inside a parallel group through its effective id", () => {
    const auto = testAuto();
    const inner: Fix = {
      kind: "replaceRoute",
      stepId: "drive",
      label: "Use the faster route",
      params: { segments: [{ kind: "line", from: "current", to: { xIn: 12, yIn: 24, headingRad: 0 } }], heading },
    };
    expect(canonicalize("auto", applyFix(auto, inner))).toBe(
      canonicalize("auto", setRoute(auto, "drive", inner.params.segments, heading)),
    );
  });

  it("leaves the auto as it was when the step is gone, is not a path, or the ends moved", () => {
    const auto = testAuto();
    const bytes = canonicalize("auto", auto);
    expect(canonicalize("auto", applyFix(auto, replaceRoute("nowhere")))).toBe(bytes);
    expect(canonicalize("auto", applyFix(auto, replaceRoute("shoot")))).toBe(bytes);
    const moved: Fix = {
      kind: "replaceRoute",
      stepId: "leg1",
      label: "x",
      params: { segments: [{ kind: "line", from: "current", to: { xIn: 5, yIn: 5 } }], heading },
    };
    expect(canonicalize("auto", applyFix(auto, moved))).toBe(bytes);
  });

  it("does not mutate the auto it is given", () => {
    const auto = testAuto();
    const before = canonicalize("auto", auto);
    applyFix(auto, replaceRoute("leg1"));
    expect(canonicalize("auto", auto)).toBe(before);
  });
});

describe("optimizeRoute", () => {
  it("returns the same object, as focusTimeout does", () => {
    const auto: Auto = testAuto();
    const fix: Fix = { kind: "optimizeRoute", stepId: "leg1", label: "Route around the hive", params: { obstacleId: "hive" } };
    expect(applyFix(auto, fix)).toBe(auto);
    expect(applyFix(auto, { ...fix, params: {} })).toBe(auto);
    expect(applyFixes(auto, [fix, { ...fix, params: {} }])).toBe(auto);
  });
});
