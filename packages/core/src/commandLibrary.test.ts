import { parseLink, SCHEMA_ID } from "@horizon36596/zenith-schema";
import { describe, expect, it } from "vitest";
import { canonicalize } from "./canonicalize.js";

/**
 * `zenith.json` `deploy.commandLibrary`: `"solverslib"` or `"ivy"`. It may be absent when the file is
 * loaded; the commands that write Java refuse until it is set (packages/cli/src/commandLibrary.ts).
 */
const link = (deploy: Record<string, unknown>): Record<string, unknown> => ({
  $schema: SCHEMA_ID.link,
  formatVersion: 1,
  autosDir: "autos",
  robot: "autos/robot.json",
  field: "autos/field.json",
  deploy: { kind: "androidAssets", dir: "TeamCode/src/main/assets/autos", ...deploy },
});

describe("deploy.commandLibrary", () => {
  it("accepts solverslib and ivy", () => {
    expect(parseLink(link({ commandLibrary: "solverslib" })).deploy?.commandLibrary).toBe("solverslib");
    expect(parseLink(link({ commandLibrary: "ivy" })).deploy?.commandLibrary).toBe("ivy");
  });

  it("refuses any other value", () => {
    expect(() => parseLink(link({ commandLibrary: "ftclib" }))).toThrow(/commandLibrary/);
    expect(() => parseLink(link({ commandLibrary: "Ivy" }))).toThrow(/commandLibrary/);
  });

  it("may be absent when loading, so a zenith.json written before it existed still opens and keeps its bytes", () => {
    const before = link({ robotClass: "org.example.MyRobot" });
    expect(parseLink(before).deploy?.commandLibrary).toBeUndefined();
    expect(canonicalize("link", before)).not.toContain("commandLibrary");
  });

  it("is written between dir and robotClass", () => {
    const text = canonicalize("link", link({ robotClass: "org.example.MyRobot", commandLibrary: "ivy" }));
    const dir = text.indexOf('"dir"');
    const library = text.indexOf('"commandLibrary"');
    const robotClass = text.indexOf('"robotClass"');
    expect(dir).toBeLessThan(library);
    expect(library).toBeLessThan(robotClass);
  });
});
