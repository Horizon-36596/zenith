/**
 * Decision D12, "select first": with Protect measured waypoints on, a pin labelled MEASURED or
 * CALIBRATED FROM ROBOT does not move on its first press, and typing and an accepted proposal say what
 * they relabel. These are the pure rules; the callers of `moveWaypoint` run through them in
 * `waypointEdits.test.ts`.
 */
import type { Waypoint, Waypoints } from "@horizon36596/zenith-schema";
import { describe, expect, it } from "vitest";
import { measuredNotice, moveVerdict, protectedLabel, protectedPinNames, selectFirstLine, type MoveOrigin } from "./pinProtection";

const pin = (provenance: string | undefined): Waypoint => ({ xIn: 1, yIn: 2, headingRad: 0, ...(provenance === undefined ? {} : { provenance }) });

describe("which pins are protected", () => {
  it("are the ones whose label starts with MEASURED or CALIBRATED FROM ROBOT, with a note or none", () => {
    expect(protectedLabel(pin("MEASURED"))).toBe("MEASURED");
    expect(protectedLabel(pin("MEASURED: tape, 2026-09-30"))).toBe("MEASURED");
    expect(protectedLabel(pin("MEASURED 2026-01-15 ForwardVelocityTuner"))).toBe("MEASURED");
    expect(protectedLabel(pin("CALIBRATED FROM ROBOT: 3 runs"))).toBe("CALIBRATED FROM ROBOT");
  });

  it("are not the ones with any other label, or none", () => {
    for (const label of ["PLACEHOLDER: starter example", "SET BY HAND", "SET FROM EDITOR", "CALIBRATED FROM SIM", "NEEDS MEASUREMENT", "APPROX", "MEASUREDISH", undefined]) {
      expect(protectedLabel(pin(label)), String(label)).toBeNull();
    }
    expect(protectedLabel(undefined)).toBeNull();
  });

  it("are listed by name for the field, and nobody is protected with the setting off", () => {
    const waypoints = {
      waypoints: { a: pin("MEASURED"), b: pin("PLACEHOLDER"), c: pin("CALIBRATED FROM ROBOT"), d: pin(undefined) },
    } as unknown as Waypoints;
    expect([...protectedPinNames(waypoints, true)].sort()).toEqual(["a", "c"]);
    expect(protectedPinNames(waypoints, false).size).toBe(0);
    expect(protectedPinNames(undefined, true).size).toBe(0);
  });
});

describe("what each caller of moveWaypoint is allowed", () => {
  const verdict = (origin: MoveOrigin, label: string | undefined, selected: boolean, protect = true) =>
    moveVerdict({ origin, waypoint: pin(label), selected, protect }).kind;

  it("holds back a first press and a key on a measured pin that is not selected, and lets the second press-drag and keys on a selected one move it", () => {
    expect(verdict("drag", "MEASURED", false)).toBe("selectFirst");
    expect(verdict("key", "MEASURED", false)).toBe("selectFirst");
    expect(verdict("drag", "MEASURED", true)).toBe("move");
    expect(verdict("key", "MEASURED", true)).toBe("move");
    expect(verdict("drag", "CALIBRATED FROM ROBOT", false)).toBe("selectFirst");
  });

  it("always lets a typed number and an accepted proposal through, because each is deliberate and says what it relabels", () => {
    for (const origin of ["typed", "proposal"] as const) {
      expect(verdict(origin, "MEASURED", false), origin).toBe("move");
      expect(verdict(origin, "MEASURED", true), origin).toBe("move");
    }
  });

  it("moves every other pin at once, whoever calls", () => {
    for (const origin of ["drag", "key", "typed", "proposal"] as const) {
      expect(verdict(origin, "PLACEHOLDER", false), origin).toBe("move");
      expect(verdict(origin, undefined, false), origin).toBe("move");
    }
  });

  it("does nothing different from main with the setting off", () => {
    for (const origin of ["drag", "key", "typed", "proposal"] as const) {
      expect(verdict(origin, "MEASURED", false, false), origin).toBe("move");
    }
  });
});

describe("the lines that say it", () => {
  it("names the label and the way on when a first press only selected", () => {
    expect(selectFirstLine("park", "MEASURED")).toBe("Waypoint park is MEASURED, so the first press only selected it. Press and drag it again to move it.");
    expect(selectFirstLine("park", "CALIBRATED FROM ROBOT")).toContain("is CALIBRATED FROM ROBOT");
  });

  it("is the owner's sentence before a typed number or an accepted proposal is committed", () => {
    expect(measuredNotice("MEASURED", "you change a number here")).toBe("This changes MEASURED to SET FROM EDITOR if you change a number here.");
    expect(measuredNotice("MEASURED", "you accept it")).toBe("This changes MEASURED to SET FROM EDITOR if you accept it.");
    expect(measuredNotice("CALIBRATED FROM ROBOT", "you accept it")).toContain("This changes CALIBRATED FROM ROBOT to SET FROM EDITOR");
  });
});
