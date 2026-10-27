import { describe, expect, it } from "vitest";
import { PROVENANCE_LABELS, provenanceLabel, provenanceTier } from "./provenance.js";

describe("provenanceTier", () => {
  it("finding 41: ranks only the CLAUDE.md rule-4 vocabulary", () => {
    // GUESSED is not a label anywhere in the vocabulary, so it earns no tier of its own and falls
    // to the unverified default like any other unlabelled string.
    expect(PROVENANCE_LABELS as readonly string[]).not.toContain("GUESSED");
    expect(provenanceTier("GUESSED")).toBe("unverified");
    expect(provenanceTier("MEASURED 2026-01-01")).toBe("measured");
    expect(provenanceTier("SPEC (G407)")).toBe("measured");
    expect(provenanceTier("PLACEHOLDER: robot still in CAD")).toBe("unverified");
  });

  it("finding 41: SET FROM is a prefix match for a hand-written source", () => {
    expect(provenanceTier("SET FROM TeamCode/.../RobotConfig.java")).toBe("derived");
    expect(provenanceTier("SET FROM SIM 2026-09-21")).toBe("derived");
    // The weaker claim still wins when a label carries two.
    expect(provenanceTier("SET FROM RobotConfig.java; PLACEHOLDER in that file")).toBe("unverified");
  });

  it("issue #377: a label counts only as whole words, and a negated MEASURED is unverified", () => {
    expect(provenanceTier("UNMEASURED")).toBe("unverified");
    expect(provenanceTier("NOT MEASURED yet")).toBe("unverified");
    expect(provenanceTier("not yet measured")).toBe("unverified");
    expect(provenanceTier("SPECIFICATION unknown")).toBe("unverified");
    expect(provenanceTier("RESET BY HANDLER")).toBe("unverified");
    expect(provenanceTier("MEASURED")).toBe("measured");
    expect(provenanceTier("measured with calipers")).toBe("measured");
  });
});

describe("provenanceLabel", () => {
  it("gives the vocabulary label without its reason, for a message with room for the label only", () => {
    expect(provenanceLabel("PLACEHOLDER: starter example, measure your own robot")).toBe("PLACEHOLDER");
    expect(provenanceLabel("MEASURED 2026-01-01 with a tape")).toBe("MEASURED");
    expect(provenanceLabel("CALIBRATED FROM SIM 2026-10-01 (12 steps)")).toBe("CALIBRATED FROM SIM");
    expect(provenanceLabel("NEEDS MEASUREMENT")).toBe("NEEDS MEASUREMENT");
    expect(provenanceLabel("copied from the CAD; APPROX")).toBe("APPROX");
    expect(provenanceLabel(undefined)).toBe("NEEDS MEASUREMENT");
    expect(provenanceLabel("our notebook: page 4")).toBe("our notebook");
  });

  it("reads a label only as whole words, never inside an ordinary word", () => {
    expect(provenanceLabel("estimated from the specification sheet")).toBe("estimated from the specification sheet");
    expect(provenanceLabel("approximately 18 in: from the CAD")).toBe("approximately 18 in");
    expect(provenanceLabel("SPECIFICATION sheet, page 4")).toBe("SPECIFICATION sheet, page 4");
    expect(provenanceLabel("from the spec sheet")).toBe("SPEC");
    expect(provenanceLabel("SPEC: the rulebook")).toBe("SPEC");
  });

  it("never returns an empty label for a provenance that starts with a colon", () => {
    expect(provenanceLabel(": page 4 of our notebook")).toBe(": page 4 of our notebook");
    expect(provenanceLabel(": measured by hand")).toBe("MEASURED");
  });
});
