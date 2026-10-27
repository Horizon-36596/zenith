import { describe, expect, it } from "vitest";
import { allianceLine, otherAlliance } from "./hostAlliance";

describe("allianceLine", () => {
  it("says which alliance to draw for and that the host mirrors it for the other", () => {
    const line = allianceLine("RED", "pointSymmetry", "DSIM");
    expect(line.text).toBe("Draw for RED. DSIM mirrors it when you play BLUE.");
    expect(line.short).toBe("Draw for RED · DSIM mirrors for BLUE");
    expect(line.hint).toBe(
      "This auto is drawn for RED. When you play BLUE, DSIM turns it half a turn around the centre of the field, so put every point where RED's robot goes.",
    );
  });

  it("uses plain words, not the field file's name for the mirror (sweep W4-5)", () => {
    for (const mirror of ["pointSymmetry", "mirrorX", "mirrorY", "none"] as const) {
      const line = allianceLine("RED", mirror, "DSIM");
      expect(`${line.text} ${line.hint}`).not.toMatch(/pointSymmetry|mirrorX|mirrorY|frame/);
    }
  });

  it("follows the file's own alliance, not a fixed one", () => {
    expect(allianceLine("BLUE", "mirrorY", "DSIM").text).toBe("Draw for BLUE. DSIM mirrors it when you play RED.");
    expect(allianceLine("BLUE", "mirrorY", "DSIM").hint).toContain("across the y axis");
    expect(otherAlliance("RED")).toBe("BLUE");
  });

  it("does not promise a mirror the field does not have", () => {
    const line = allianceLine("RED", "none", "DSIM");
    expect(line.text).toBe("Draw for RED.");
    expect(line.short).toBe("Draw for RED");
    expect(line.text).not.toContain("mirrors");
    expect(line.hint).toContain("This field is not mirrored");
  });
});
