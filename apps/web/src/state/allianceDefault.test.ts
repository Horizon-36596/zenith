/**
 * Finding 21/22 (web part): the alliance toggle's default view is the auto's own `alliance`, not a
 * fixed "always start on RED". `field.frame.canonicalAlliance` decides whether the canvas mirrors
 * (`apps/web/src/canvas/FieldCanvas.tsx`), and the toggle it reads from should start already showing
 * the alliance the file was written for, rather than starting on RED and needing a click for every
 * BLUE auto.
 */
import { canonicalize, loadAuto } from "@horizon36596/zenith-core";
import { SCHEMA_ID } from "@horizon36596/zenith-schema";
import { describe, expect, it } from "vitest";
import { getState, openAuto, toggleAlliance } from "./store";

const fixture = (alliance: "RED" | "BLUE") =>
  loadAuto({
    $schema: SCHEMA_ID.auto,
    formatVersion: 1,
    name: `${alliance.toLowerCase()}-fixture`,
    title: `${alliance} fixture`,
    alliance,
    start: { pose: { xIn: 0, yIn: 0, headingRad: 0 } },
    steps: [{ id: "wait", kind: "wait", seconds: 1 }],
  });

describe("opening an auto sets the alliance toggle to the auto's own alliance", () => {
  it("defaults to BLUE for a BLUE auto", () => {
    const auto = fixture("BLUE");
    openAuto("blue-fixture.auto.json", auto, canonicalize("auto", auto));
    expect(getState().alliance).toBe("BLUE");
  });

  it("defaults to RED for a RED auto", () => {
    const auto = fixture("RED");
    openAuto("red-fixture.auto.json", auto, canonicalize("auto", auto));
    expect(getState().alliance).toBe("RED");
  });

  it("follows a later auto that is opened over an earlier one", () => {
    const red = fixture("RED");
    openAuto("red-fixture.auto.json", red, canonicalize("auto", red));
    expect(getState().alliance).toBe("RED");

    const blue = fixture("BLUE");
    openAuto("blue-fixture.auto.json", blue, canonicalize("auto", blue));
    expect(getState().alliance).toBe("BLUE");
  });

  it("still leaves the toggle for the person to flip afterwards", () => {
    const auto = fixture("RED");
    openAuto("red-fixture.auto.json", auto, canonicalize("auto", auto));
    toggleAlliance();
    expect(getState().alliance).toBe("BLUE");
  });
});
