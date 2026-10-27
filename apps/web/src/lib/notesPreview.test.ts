import { describe, expect, it } from "vitest";
import { NOTES_PREVIEW_MAX, notesPreview } from "./notesPreview";

describe("a step's notes preview", () => {
  it("is the first line that is not blank, whole when it fits", () => {
    expect(notesPreview("\n  \nLine one.\nLine two.")).toBe("Line one.");
  });

  it("cuts a long line at a word, with an ellipsis, inside the limit", () => {
    const preview = notesPreview("A straight line north to the scoring spot, facing the hive.");
    expect(preview).toBe("A straight line north to…");
    expect(preview.length).toBeLessThanOrEqual(NOTES_PREVIEW_MAX);
  });

  it("is empty for notes that are only spaces and blank lines", () => {
    expect(notesPreview("   \n  \n\t")).toBe("");
  });

  it("never splits a surrogate pair when it cuts", () => {
    const preview = notesPreview("\u{1F600}".repeat(40), 10);
    expect(preview).toBe(`${"\u{1F600}".repeat(9)}…`);
    expect(preview).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  it("cuts a long word where it must", () => {
    expect(notesPreview("x".repeat(40), 10)).toBe(`${"x".repeat(9)}…`);
  });
});
