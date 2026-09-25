import { describe, expect, it } from "vitest";
import { PROVENANCE_LABELS, provenanceTier } from "./provenance.js";

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
});
