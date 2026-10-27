import { describe, expect, it } from "vitest";
import { PROVENANCE_LABELS } from "@horizon36596/zenith-core";
import {
  SHORT_PROVENANCE_MAX,
  provenanceAfterTyping,
  shortChipTipLabel,
  shortProvenanceLabel,
  typedNumberWarning,
} from "./provenance";

describe("shortProvenanceLabel", () => {
  it("gives every tier of the biobuzz vocabulary a short label of at most 12 characters", () => {
    for (const label of PROVENANCE_LABELS) {
      const short = shortProvenanceLabel(label);
      expect(short.length, `${label} -> ${short}`).toBeGreaterThan(0);
      expect(short.length, `${label} -> ${short}`).toBeLessThanOrEqual(SHORT_PROVENANCE_MAX);
    }
    expect(SHORT_PROVENANCE_MAX).toBe(12);
  });

  it("uses the words the Inspector design names", () => {
    expect(shortProvenanceLabel("NEEDS MEASUREMENT")).toBe("Needs meas.");
    expect(shortProvenanceLabel("PLACEHOLDER")).toBe("Placeholder");
    expect(shortProvenanceLabel("APPROX")).toBe("Approx");
    expect(shortProvenanceLabel("SET BY HAND")).toBe("Set by hand");
    expect(shortProvenanceLabel("MEASURED")).toBe("Measured");
    expect(shortProvenanceLabel("SET FROM EDITOR")).toBe("From editor");
  });

  it("keeps the label when a note follows it, and ignores the case of the file's string", () => {
    expect(shortProvenanceLabel("SET FROM EDITOR: dragged on the field")).toBe("From editor");
    expect(shortProvenanceLabel("placeholder: starter example")).toBe("Placeholder");
    expect(shortProvenanceLabel("MEASURED 2026-01-15 ForwardVelocityTuner")).toBe("Measured");
  });

  it("cuts a string with no vocabulary label to 12 characters with an ellipsis", () => {
    expect(shortProvenanceLabel("Taken from the manual")).toBe("Taken from …");
    expect(shortProvenanceLabel("Short")).toBe("Short");
    expect(shortProvenanceLabel("Taken from the manual").length).toBeLessThanOrEqual(SHORT_PROVENANCE_MAX);
  });
});

describe("provenanceAfterTyping", () => {
  // Owner ruling 2026-10-10 (issue #273), measured-typed (b): a typed number on a value read off the
  // real robot or field is the editor's now, so the label says so and the person is warned.
  it("relabels MEASURED and CALIBRATED FROM ROBOT to SET FROM EDITOR and names the label it replaced", () => {
    expect(provenanceAfterTyping("MEASURED")).toEqual({ provenance: "SET FROM EDITOR", replaced: "MEASURED" });
    expect(provenanceAfterTyping("CALIBRATED FROM ROBOT")).toEqual({ provenance: "SET FROM EDITOR", replaced: "CALIBRATED FROM ROBOT" });
  });

  it("finds the label before a note, in any case, as the chip menu does", () => {
    expect(provenanceAfterTyping("MEASURED: tape, 2026-09-30").replaced).toBe("MEASURED");
    expect(provenanceAfterTyping("measured 2026-01-15 ForwardVelocityTuner").replaced).toBe("MEASURED");
    expect(provenanceAfterTyping("CALIBRATED FROM ROBOT: 12 runs").provenance).toBe("SET FROM EDITOR");
  });

  it("keeps every other label, and gives a value with none the editor's", () => {
    for (const kept of [
      "PLACEHOLDER: starter example",
      "SET BY HAND",
      "SPEC (R102)",
      "APPROX",
      "NEEDS MEASUREMENT",
      "CARRIED OVER",
      "SET FROM SIM",
      "CALIBRATED FROM SIM",
      "SET FROM EDITOR: dragged",
    ]) {
      expect(provenanceAfterTyping(kept), kept).toEqual({ provenance: kept, replaced: null });
    }
    expect(provenanceAfterTyping(undefined)).toEqual({ provenance: "SET FROM EDITOR", replaced: null });
  });

  it("does not take a hand-written string that only mentions MEASURED for a measured one", () => {
    expect(provenanceAfterTyping("SET FROM TeamCode/Measured.java")).toEqual({
      provenance: "SET FROM TeamCode/Measured.java",
      replaced: null,
    });
  });
});

describe("typedNumberWarning", () => {
  it("says what changes to what, for what, and how to get it back", () => {
    expect(typedNumberWarning("MEASURED", "waypoint park")).toBe(
      "This changes MEASURED to SET FROM EDITOR on waypoint park. Click its label to choose MEASURED again, or press Ctrl+Z.",
    );
    expect(typedNumberWarning("CALIBRATED FROM ROBOT", "the start")).toContain(
      "This changes CALIBRATED FROM ROBOT to SET FROM EDITOR on the start.",
    );
  });
});

describe("shortChipTipLabel", () => {
  it("names the full label and its note", () => {
    expect(shortChipTipLabel("SET FROM EDITOR: dragged", "Set from editor")).toBe("Set from editor: dragged");
    expect(shortChipTipLabel("CALIBRATED FROM ROBOT", "Calibrated from robot")).toBe("Calibrated from robot");
  });

  it("shows a string with no vocabulary label once, not twice", () => {
    expect(shortChipTipLabel("Taken from the manual", "Taken from the manual")).toBe("Taken from the manual");
    expect(shortChipTipLabel("  From the scout: page 3 ", "From the scout")).toBe("From the scout: page 3");
  });
});
