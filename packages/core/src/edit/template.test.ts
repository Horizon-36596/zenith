import { describe, expect, it } from "vitest";
import { canonicalize } from "../canonicalize.js";
import { newAutoFromTemplate } from "./template.js";
import { canonicalRoundTrip } from "./testing.js";

describe("newAutoFromTemplate", () => {
  it("builds a valid, minimal auto", () => {
    const auto = newAutoFromTemplate("close", {
      alliance: "BLUE",
      start: { pose: { xIn: 12, yIn: -60, headingRad: 1.5708 }, holds: { pollen: 4 } },
      robotPath: "autos/robot.json",
      fieldPath: "autos/field/biobuzz.field.json",
    });
    expect(auto.name).toBe("close");
    expect(auto.alliance).toBe("BLUE");
    expect(auto.robot).toBe("autos/robot.json");
    expect(auto.field).toBe("autos/field/biobuzz.field.json");
    expect(auto.steps).toHaveLength(1);
    canonicalRoundTrip(auto);
  });

  it("works with a waypoint-ref start and no robot/field override", () => {
    const auto = newAutoFromTemplate("open", {
      alliance: "RED",
      start: { pose: { ref: "start" } },
    });
    expect(auto.robot).toBeUndefined();
    expect(auto.field).toBeUndefined();
    expect(canonicalize("auto", auto)).toContain('"ref": "start"');
    canonicalRoundTrip(auto);
  });
});
