/**
 * Issue #191: `checkOnly` runs the checks for an auto that is not open, and `newErrors` counts only
 * what a change adds, so an error that was there before is not blamed on the change.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadAuto, loadField, loadRobot, loadWaypoints, type Finding } from "@horizon36596/zenith-core";
import { describe, expect, it } from "vitest";
import { checkOnly, errorCountOf, newErrors } from "./checkOnly";

const examples = fileURLToPath(new URL("../../../../examples/starter/autos/", import.meta.url));
const read = (relative: string): unknown => JSON.parse(readFileSync(`${examples}${relative}`, "utf8"));

const finding = (stepId: string, severity: Finding["severity"] = "error", code: Finding["code"] = "PERIMETER"): Finding => ({
  severity,
  stepId,
  code,
  message: "A message that names a number, 2.07 in.",
});

describe("newErrors", () => {
  it("counts the errors after that were not there before, by check and step", () => {
    expect(newErrors([], [finding("a"), finding("b")])).toBe(2);
    expect(newErrors([finding("a")], [finding("a"), finding("b")])).toBe(1);
    expect(newErrors([finding("a")], [{ ...finding("a"), message: "Now 3.5 in." }])).toBe(0);
  });

  it("counts the same error twice in one step twice, and ignores anything but errors", () => {
    expect(newErrors([finding("a")], [finding("a"), finding("a")])).toBe(1);
    expect(newErrors([], [finding("a", "warning"), finding("b", "info")])).toBe(0);
    expect(errorCountOf([finding("a"), finding("b", "warning")])).toBe(1);
  });
});

describe("checkOnly", () => {
  const robot = loadRobot(read("robot.json"));
  const field = loadField(read("field/biobuzz.field.json"));
  const waypoints = loadWaypoints(read("waypoints.json"));
  const auto = loadAuto(read("cycle-and-park.auto.json"));

  it("checks an auto against the waypoints it is given", () => {
    const here = checkOnly(auto, robot, field, waypoints);
    const moved = checkOnly(auto, robot, field, {
      ...waypoints,
      waypoints: { ...waypoints.waypoints, gardenSweepStart: { xIn: -54, yIn: -58, headingRad: 3.1416 } },
    });
    if (!here.ok || !moved.ok) throw new Error("the checks did not run");
    expect(errorCountOf(here.value)).toBe(0);
    expect(newErrors(here.value, moved.value)).toBeGreaterThan(0);
  });

  it("says why when the auto cannot be resolved", () => {
    const result = checkOnly(auto, robot, field, { ...waypoints, waypoints: {} });
    // A waypoint the file lacks is a finding or a refusal, never a throw.
    expect(result.ok ? errorCountOf(result.value) > 0 : result.reason.length > 0).toBe(true);
  });
});
