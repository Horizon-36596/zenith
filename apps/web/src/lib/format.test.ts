/**
 * Counts in the app's sentences say "1 auto" and "2 autos", never "1 autos": the status line after
 * Download project, the canvas's spoken summary, the sim's output button and the diverged chip all
 * build their counts with `countOf`.
 */
import { describe, expect, it } from "vitest";
import { poseLine } from "../app/waypointCheck";
import { formatHeading } from "../panels/PointHeadingRow";
import { RENAME_FIELD_MIN_CH, countOf, degrees, renameFieldCh } from "./format";

describe("countOf", () => {
  it("uses the singular for exactly one and the plural otherwise", () => {
    expect(countOf(1, "auto")).toBe("1 auto");
    expect(countOf(0, "auto")).toBe("0 autos");
    expect(countOf(2, "auto")).toBe("2 autos");
  });

  it("takes an irregular plural, or a verb that agrees with the count", () => {
    expect(countOf(1, "revision was", "revisions were")).toBe("1 revision was");
    expect(countOf(3, "revision was", "revisions were")).toBe("3 revisions were");
  });
});

describe("renameFieldCh", () => {
  it("leaves room to type even for a one-letter or empty name", () => {
    expect(renameFieldCh("")).toBe(RENAME_FIELD_MIN_CH);
    expect(renameFieldCh("a")).toBe(RENAME_FIELD_MIN_CH);
    expect(RENAME_FIELD_MIN_CH).toBeGreaterThanOrEqual(8);
  });

  it("is never narrower than the name plus the caret", () => {
    const name = "scorePreloadAndPark";
    expect(renameFieldCh(name)).toBe(name.length + 2);
    expect(renameFieldCh(name)).toBeGreaterThan(name.length);
  });
});

describe("degrees", () => {
  it("wraps to (-180, 180] after rounding, so a heading just past -180 reads 180.0 (issue #498)", () => {
    // The example's waypoints write a heading of pi as 3.1416, a hair past 180 degrees.
    expect(degrees(3.1416)).toBe("180.0");
    expect(degrees(-Math.PI)).toBe("180.0");
    expect(degrees(Math.PI)).toBe("180.0");
    expect(degrees(-3.14159)).toBe("180.0");
    expect(degrees(-3.1)).toBe("-177.6");
    expect(degrees(1.5708)).toBe("90.0");
  });

  it("never reads -0.0", () => {
    expect(degrees(-0.0001)).toBe("0.0");
    expect(degrees(2 * Math.PI)).toBe("0.0");
  });

  it("reads as the Inspector's heading does, with the degree sign tight against the number", () => {
    for (let rad = -7; rad <= 7; rad += 0.0137) expect(`${degrees(rad)}°`).toBe(formatHeading(rad));
    for (const rad of [3.1416, -3.1416, Math.PI, -Math.PI, 0, -1e-9]) expect(`${degrees(rad)}°`).toBe(formatHeading(rad));
  });

  it("is what the waypoint check dialog prints", () => {
    expect(poseLine({ xIn: 12, yIn: -60, headingRad: 3.1416 })).toBe("x 12.00 in, y -60.00 in, 180.0°");
  });
});
