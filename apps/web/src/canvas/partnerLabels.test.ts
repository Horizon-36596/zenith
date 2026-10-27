/**
 * Partner names on the field: each goes over its box, so it never covers the editor's own robot
 * label under that robot, and two partners side by side stack their names instead of printing one
 * over the other (the 2026-09-29 UX sweep saw "Starter partnpartnIdealpose").
 */
import { describe, expect, it } from "vitest";
import { placeLabel, type LabelRect } from "./partnerLayer";

describe("placeLabel", () => {
  it("puts a name above its box", () => {
    const rect = placeLabel({ topPx: 200, bottomPx: 260, midXPx: 100 }, 60, []);
    expect(rect.yPx + rect.heightPx).toBeLessThanOrEqual(200);
    expect(rect.xPx).toBe(70);
  });

  it("stacks a second name that would overlap the first one", () => {
    const placed: LabelRect[] = [];
    placed.push(placeLabel({ topPx: 200, bottomPx: 260, midXPx: 100 }, 80, placed));
    const second = placeLabel({ topPx: 205, bottomPx: 265, midXPx: 120 }, 80, placed);
    const first = placed[0] as LabelRect;
    expect(second.yPx + second.heightPx).toBeLessThanOrEqual(first.yPx);
  });

  it("goes under the box when there is no room above it", () => {
    const rect = placeLabel({ topPx: 6, bottomPx: 60, midXPx: 100 }, 60, []);
    expect(rect.yPx).toBeGreaterThanOrEqual(60);
  });
});
