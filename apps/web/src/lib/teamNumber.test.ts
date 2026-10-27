/**
 * Issue #502: one reading of a typed team number for the Teams sheet, the Share sheet and the admin
 * page, with one sentence for every number it refuses.
 */
import { describe, expect, it } from "vitest";
import { readTeamNumber, TEAM_NUMBER_RANGE } from "./teamNumber";

describe("readTeamNumber", () => {
  it("reads a whole number from 1 to 999999, with or without a #", () => {
    expect(readTeamNumber("36596")).toEqual({ ok: true, teamNumber: 36596 });
    expect(readTeamNumber(" #1 ")).toEqual({ ok: true, teamNumber: 1 });
    expect(readTeamNumber("999999")).toEqual({ ok: true, teamNumber: 999999 });
  });

  it("refuses letters, zero, a decimal and eleven digits with the same sentence", () => {
    for (const text of ["abc", "12a", "0", "1.5", "-3", "1000000", "99999999999"]) {
      expect(readTeamNumber(text)).toEqual({ ok: false, why: `"${text}" is not a team number. ${TEAM_NUMBER_RANGE}` });
    }
    expect(TEAM_NUMBER_RANGE).toBe("Use a whole number from 1 to 999999.");
  });

  it("asks for a number when there is none", () => {
    expect(readTeamNumber("  ")).toEqual({ ok: false, why: "Type a team number." });
  });
});
