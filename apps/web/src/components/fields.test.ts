/**
 * The number fields' display rules (issue #410): an angle shows wrapped into (-180, 180] with one
 * decimal, the wrap is display only so no plan changes, and an empty value is no text at all.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { degToRad, loadField, loadRobot, plan, radToDeg, resolve, wrapAngle } from "@horizon36596/zenith-core";
import { parseAuto, type Heading } from "@horizon36596/zenith-schema";
import { describe, expect, it } from "vitest";
import { fieldText, wrapDegrees } from "./fields";

const examples = fileURLToPath(new URL("../../../../examples/starter/autos/", import.meta.url));
const read = (relative: string): unknown => JSON.parse(readFileSync(`${examples}${relative}`, "utf8"));
const robot = loadRobot(read("robot.json"));
const field = loadField(read("field/biobuzz.field.json"));

describe("an angle field's display", () => {
  it("shows a constant heading stored as -pi as 180.0", () => {
    expect(fieldText(radToDeg(-Math.PI), 1, true)).toBe("180.0");
    expect(fieldText(radToDeg(Math.PI), 1, true)).toBe("180.0");
  });

  it("wraps into (-180, 180] and keeps one decimal", () => {
    expect(fieldText(270, 1, true)).toBe("-90.0");
    expect(fieldText(-270, 1, true)).toBe("90.0");
    expect(fieldText(540, 1, true)).toBe("180.0");
    expect(fieldText(90, 1, true)).toBe("90.0");
    // Just inside -180 rounds to it, and -180.0 would read as a different heading from 180.0.
    expect(fieldText(-179.96, 1, true)).toBe("180.0");
    expect(wrapDegrees(-180)).toBe(180);
    expect(wrapDegrees(180)).toBe(180);
    expect(wrapDegrees(-0)).toBe(0);
  });

  it("agrees with core's wrapAngle everywhere", () => {
    for (let deg = -725; deg <= 725; deg += 25) {
      expect(wrapDegrees(deg)).toBeCloseTo(radToDeg(wrapAngle(degToRad(deg))), 6);
    }
  });

  it("never reads a tiny negative angle as -0.0", () => {
    expect(fieldText(-0.01, 1, true)).toBe("0.0");
    expect(fieldText(-0.01, 2, false)).toBe("-0.01");
  });

  it("leaves a number that is not an angle as it is, and an empty value as no text", () => {
    expect(fieldText(270, 2, false)).toBe("270.00");
    expect(fieldText(null, 1, true)).toBe("");
  });
});

describe("the display wrap changes no plan", () => {
  const planned = (heading: Heading) => {
    const auto = parseAuto({
      formatVersion: 1,
      name: "sweep",
      alliance: "RED",
      start: { pose: { xIn: -40, yIn: -20, headingRad: 0 } },
      steps: [
        {
          id: "sweep",
          kind: "path",
          segments: [{ kind: "line", from: "current", to: { xIn: 20, yIn: 30 } }],
          heading,
        },
      ],
    });
    return plan(resolve(auto, { formatVersion: 1, waypoints: {} }), robot, field, { memoize: false }).steps[0];
  };

  it("gives a linear heading the same samples whether it is stored as -pi or as the 180 the field shows", () => {
    // 270 degrees typed into To is stored as 270 degrees and shown as -90.0: the plan is the same
    // as for the stored value written the way the field displays it.
    const stored = planned({ mode: "linear", fromRad: -Math.PI, toRad: degToRad(270) });
    const shown = planned({ mode: "linear", fromRad: wrapAngle(-Math.PI), toRad: wrapAngle(degToRad(270)) });
    expect(stored?.samples.length).toBeGreaterThan(2);
    expect(shown?.samples.length).toBe(stored?.samples.length);
    stored?.samples.forEach((sample, index) => {
      const other = shown?.samples[index];
      expect(Math.cos(sample.pose.headingRad)).toBeCloseTo(Math.cos(other?.pose.headingRad ?? NaN), 9);
      expect(Math.sin(sample.pose.headingRad)).toBeCloseTo(Math.sin(other?.pose.headingRad ?? NaN), 9);
    });
  });
});
