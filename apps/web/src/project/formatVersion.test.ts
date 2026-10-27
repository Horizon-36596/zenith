/**
 * Opening an auto written in an older format says that saving writes the new one (sweep item A20):
 * the file on disk changes format on the next save, and an older Zenith cannot open that format.
 */
import { describe, expect, it } from "vitest";
import { FORMAT_VERSIONS } from "@horizon36596/zenith-schema";
import { olderFormatLine, olderFormatOf, outdatedOpenLine } from "./formatVersion";

describe("outdatedOpenLine", () => {
  const outdated = "DSIM needs an update before it can read autos from this Zenith, so Save to DSIM and Simulate in DSIM are off.";

  it("leads with the out-of-date sentence, then says the host cannot open what Save writes for an older-format auto", () => {
    const line = outdatedOpenLine(outdated, "DSIM", { fileName: "old.auto.json", fromFormatVersion: 3 });
    expect(line.startsWith(outdated)).toBe(true);
    expect(line).toContain("old.auto.json was written in auto format 3");
    expect(line).toContain(`saving writes format ${String(FORMAT_VERSIONS.auto)}, which this DSIM cannot open until it is updated.`);
  });

  it("is the out-of-date sentence alone for a current auto, or when no auto is open", () => {
    expect(outdatedOpenLine(outdated, "DSIM", { fileName: "new.auto.json" })).toBe(outdated);
    expect(outdatedOpenLine(outdated, "DSIM", null)).toBe(outdated);
  });
});

describe("olderFormatOf", () => {
  it("names the version of a file older than the one Save writes", () => {
    expect(olderFormatOf({ formatVersion: 1 })).toEqual({ fromFormatVersion: 1 });
    expect(olderFormatOf({ formatVersion: FORMAT_VERSIONS.auto - 1 })).toEqual({
      fromFormatVersion: FORMAT_VERSIONS.auto - 1,
    });
  });

  it("says nothing for a current file, a newer one or one it cannot read", () => {
    expect(olderFormatOf({ formatVersion: FORMAT_VERSIONS.auto })).toEqual({});
    expect(olderFormatOf({ formatVersion: FORMAT_VERSIONS.auto + 1 })).toEqual({});
    expect(olderFormatOf({ formatVersion: "2" })).toEqual({});
    expect(olderFormatOf({ formatVersion: 0 })).toEqual({});
    expect(olderFormatOf({ formatVersion: 1.5 })).toEqual({});
    expect(olderFormatOf(null)).toEqual({});
    expect(olderFormatOf([1])).toEqual({});
  });
});

describe("olderFormatLine", () => {
  it("names the file, the old format and the one saving writes", () => {
    const line = olderFormatLine("old.auto.json", 2);
    expect(line).toContain("Opened old.auto.json");
    expect(line).toContain("auto format 2");
    expect(line).toContain(`Saving writes it in format ${String(FORMAT_VERSIONS.auto)}`);
    expect(line).toMatch(/older versions of Zenith cannot open\.$/);
  });

  it("says nothing more in host mode when the host is new enough", () => {
    expect(olderFormatLine("old.auto.json", 3, { name: "DSIM", outdated: null })).toBe(olderFormatLine("old.auto.json", 3));
    expect(olderFormatLine("old.auto.json", 3, null)).toBe(olderFormatLine("old.auto.json", 3));
  });

  it("says the host cannot open the saved format when it is too old for this Zenith (sweep W4-6)", () => {
    const line = olderFormatLine("old.auto.json", 3, { name: "DSIM", outdated: "DSIM needs an update." });
    expect(line).toContain(`Saving writes it in format ${String(FORMAT_VERSIONS.auto)}`);
    expect(line).toContain(`This DSIM cannot open format ${String(FORMAT_VERSIONS.auto)} until it is updated, so Save to DSIM is off.`);
    expect(line).toMatch(/Save a copy keeps your work\.$/);
  });
});
