/**
 * A finding code chip's tooltip (0.1.2 UX sweep K22), shared by the Problems list and the Alliance
 * group: titled with the code it explains, then what the code means and how to fix it as two short
 * paragraphs, the second starting "To fix:".
 */
import { describe, expect, it } from "vitest";
import { findingHelp } from "../help/content";
import { codeChipTip } from "./findingRows";

describe("codeChipTip", () => {
  it("titles the tooltip with the help's title and the code on the chip", () => {
    const help = findingHelp("STRUCTURE");
    expect(help).not.toBeNull();
    const tip = codeChipTip("STRUCTURE", help);
    expect(tip.label).toBe(`${help?.title ?? ""} (STRUCTURE)`);
  });

  it("gives what the code means and how to fix it as two paragraphs", () => {
    const tip = codeChipTip("PERIMETER", { title: "Leaves the field", means: "The robot crosses the wall.", fix: "Move the point in." });
    expect(tip).toEqual({ label: "Leaves the field (PERIMETER)", hint: ["The robot crosses the wall.", "To fix: Move the point in."] });
    expect(tip.hint?.join(" ")).not.toContain("How to fix");
  });

  it("words an alliance code the same way", () => {
    const tip = codeChipTip("ALLIANCE_COLLISION", findingHelp("ALLIANCE_COLLISION"));
    expect(tip.label).toMatch(/ \(ALLIANCE_COLLISION\)$/);
    expect(tip.hint).toHaveLength(2);
    expect(tip.hint?.[1]).toMatch(/^To fix: /);
  });

  it("names only the code when the code has no help", () => {
    expect(codeChipTip("NOT_A_CODE", null)).toEqual({ label: "NOT_A_CODE" });
  });
});
