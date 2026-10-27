/** The Ledger's end rows say what each holder holds as the row text (sweep item A14). */
import { describe, expect, it } from "vitest";
import { ledgerRowText } from "./ledgerRowText";

describe("ledgerRowText", () => {
  it("puts what an end row's holder holds after its name", () => {
    expect(ledgerRowText({ stepId: "end", label: "robot", detail: "empty", holds: {} })).toBe("robot: empty");
    expect(ledgerRowText({ stepId: "end", label: "garden", detail: "3 pieces" })).toBe("garden: 3 pieces");
  });

  it("leaves a step row, and an end row with nothing to add, as they are", () => {
    expect(ledgerRowText({ stepId: "grab", label: "grab: collected 1 from flowerA", detail: "robot 1" })).toBe(
      "grab: collected 1 from flowerA",
    );
    expect(ledgerRowText({ stepId: "end", label: "robot" })).toBe("robot");
    // A step its author called "end" keeps its step row's text.
    expect(ledgerRowText({ stepId: "end", label: "end: launched 2", detail: "hive up" })).toBe("end: launched 2");
  });
});
