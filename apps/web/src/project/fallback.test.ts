/**
 * Picking files without a folder picker: a set that is not yet a project says every file it still
 * needs, not only the first one (sweep item A18).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { missingProjectFiles, projectFromFiles, projectFromZipEntries } from "./fallback";

describe("missingProjectFiles", () => {
  it("is null when zenith.json, robot.json and a field are all there", () => {
    expect(missingProjectFiles(true, true, true)).toBeNull();
  });

  it("names all three files when only an auto was picked", () => {
    expect(missingProjectFiles(false, false, false)).toBe(
      "A project needs zenith.json, robot.json and the season's *.field.json, picked together with the autos. Pick zenith.json, robot.json and the season's *.field.json too.",
    );
  });

  it("names only the file that is missing", () => {
    expect(missingProjectFiles(true, false, true)).toMatch(/Pick robot\.json too\.$/);
  });
});

describe("projectFromFiles", () => {
  it("refuses a lone auto file and says zenith.json, robot.json and a field are needed (issue #103)", async () => {
    const auto = new File(["{}"], "first-auto.auto.json");
    await expect(projectFromFiles([auto])).rejects.toThrow(/zenith\.json, robot\.json and the season's field file/);
  });

  it("names only the missing files when an auto comes with part of its project", async () => {
    const auto = new File(["{}"], "first-auto.auto.json");
    const robot = new File(["{}"], "robot.json");
    await expect(projectFromFiles([auto, robot])).rejects.toThrow(/Pick zenith\.json and the season's \*\.field\.json too\./);
  });
});

/** Issue #380 finding 2: a zip is read at the paths zenith.json names, not by file name alone. */
describe("projectFromZipEntries", () => {
  const STARTER = "../../../../examples/starter/";
  const read = (path: string): string =>
    readFileSync(fileURLToPath(new URL(`${STARTER}${path}`, import.meta.url)), "utf8").replace(/\r\n/g, "\n");
  const robotText = read("autos/robot.json");
  const fieldText = read("autos/field/biobuzz.field.json");
  const autoText = read("autos/first-auto.auto.json");
  const linkOf = (changes: Record<string, unknown>): string =>
    JSON.stringify({ ...(JSON.parse(read("zenith.json")) as Record<string, unknown>), ...changes });
  const backupRobot = JSON.stringify({ ...(JSON.parse(robotText) as Record<string, unknown>), name: "Backup robot" });

  it("reads the robot zenith.json names, not a backup robot.json elsewhere in a whole-repository zip", async () => {
    const entries = new Map([
      ["repo/zenith.json", linkOf({ waypoints: undefined })],
      ["repo/autos/robot.json", robotText],
      ["repo/autos/field/biobuzz.field.json", fieldText],
      ["repo/autos/first-auto.auto.json", autoText],
      ["repo/backup/robot.json", backupRobot],
      ["repo/backup/old.auto.json", autoText],
    ]);
    const project = await projectFromZipEntries(entries);
    expect(project.robot.name).toBe(JSON.parse(robotText).name);
    expect(project.autoFiles).toEqual(["first-auto.auto.json"]);
  });

  it("loads a robot file that is not called robot.json", async () => {
    const entries = new Map([
      ["zenith.json", linkOf({ robot: "config/my-bot.json", waypoints: undefined })],
      ["config/my-bot.json", robotText],
      ["autos/field/biobuzz.field.json", fieldText],
    ]);
    const project = await projectFromZipEntries(entries);
    expect(project.robot.name).toBe(JSON.parse(robotText).name);
  });

  it("says which named file the zip lacks", async () => {
    const entries = new Map([
      ["zenith.json", linkOf({ waypoints: undefined })],
      ["elsewhere/robot.json", robotText],
      ["autos/field/biobuzz.field.json", fieldText],
    ]);
    await expect(projectFromZipEntries(entries)).rejects.toThrow(/names autos\/robot\.json, which is not in the zip/);
  });

  it("refuses two files of one name in a zip without zenith.json", async () => {
    const entries = new Map([
      ["a/first-auto.auto.json", autoText],
      ["b/first-auto.auto.json", autoText],
    ]);
    await expect(projectFromZipEntries(entries)).rejects.toThrow(/more than one first-auto\.auto\.json/);
  });
});
