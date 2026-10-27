import { describe, expect, it } from "vitest";
import { sheetAtWidth, sheetHolding, type Holder } from "./panelSheetModel";

/** A stand-in panel that holds the nodes it was given. */
const panel = (...held: object[]): Holder => ({ contains: (other) => other !== null && held.includes(other) });

describe("sheetHolding (UI_GUIDE layout rule 9)", () => {
  const inSteps = {} as Node;
  const inInspector = {} as Node;
  const onField = {} as Node;
  const panels = { steps: panel(inSteps), inspector: panel(inInspector) };

  it("opens the sheet that holds the element at a width where that panel is a sheet", () => {
    const phone = { steps: true, inspector: true };
    expect(sheetHolding(inSteps, panels, phone)).toBe("steps");
    expect(sheetHolding(inInspector, panels, phone)).toBe("inspector");
  });

  it("closes the sheets for an element on the field or the problems", () => {
    expect(sheetHolding(onField, panels, { steps: true, inspector: true })).toBeNull();
  });

  it("leaves a panel that is in the row alone", () => {
    // From 640 px up the steps column is in the row: a stop on it needs no sheet over the field.
    expect(sheetHolding(inSteps, panels, { steps: false, inspector: true })).toBeNull();
    expect(sheetHolding(inInspector, panels, { steps: false, inspector: true })).toBe("inspector");
  });

  it("changes nothing when the element is not drawn", () => {
    expect(sheetHolding(null, panels, { steps: true, inspector: true })).toBeUndefined();
  });
});

describe("sheetAtWidth (UI_GUIDE layout rule 9)", () => {
  it("closes the steps sheet when the window widens past 640 px", () => {
    // Between 640 and 819 px only the Inspector is a sheet: the steps segment is not drawn.
    expect(sheetAtWidth("steps", { steps: false, inspector: true })).toBeNull();
  });

  it("closes the Inspector sheet at desktop width", () => {
    expect(sheetAtWidth("inspector", { steps: false, inspector: false })).toBeNull();
  });

  it("keeps a sheet the width still offers", () => {
    expect(sheetAtWidth("steps", { steps: true, inspector: true })).toBe("steps");
    expect(sheetAtWidth("inspector", { steps: false, inspector: true })).toBe("inspector");
    expect(sheetAtWidth(null, { steps: true, inspector: true })).toBeNull();
  });
});
