/**
 * Set up Zenith in a folder with no zenith.json, in the desktop app (issue #159). The renderer is
 * untrusted (confine.ts), so main builds zenith.json itself from a command library, which must be one
 * of the two, and a robot class, which must be a Java class name; it never takes zenith.json text.
 * The robot must load with the schema, the field is the bundled season's, and nothing is ever
 * written over a file that is already there.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalize, loadField, loadLink, loadRobot, skeletonRobot } from "@horizon36596/zenith-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SETUP_PATHS } from "../../web/src/project/setupFiles.js";
import { existingProjectIn, pickedFolder, setupRequestFiles, setupScan, writeSetup } from "../src/main/setupProject.js";

const SEASON_FIELD = fileURLToPath(new URL("../../../packages/season-biobuzz/field/biobuzz.field.json", import.meta.url));
const TEAM_ROBOT_PATH = "TeamCode/src/main/java/org/firstinspires/ftc/teamcode/robot/TeamRobot.java";
const TEAM_ROBOT =
  "package org.firstinspires.ftc.teamcode.robot;\n\npublic class TeamRobot implements ZenithRobot {\n" +
  '    void wire() { NamedCommands.register("intakeOn", (args, ctx) -> null); }\n}\n';

let root: string;
beforeEach(() => {
  root = join(mkdtempSync(join(tmpdir(), "zenith-setup-")), "team-repo");
  mkdirSync(join(root, "TeamCode/src/main/java/org/firstinspires/ftc/teamcode/robot"), { recursive: true });
  writeFileSync(join(root, "build.gradle"), "// FTC SDK\n", "utf8");
  writeFileSync(join(root, TEAM_ROBOT_PATH), TEAM_ROBOT, "utf8");
});
afterEach(() => {
  rmSync(join(root, ".."), { recursive: true, force: true });
});

const robot = () => JSON.parse(JSON.stringify(skeletonRobot("team-repo", "the editor's Set up"))) as unknown;
const request = (patch: Record<string, unknown> = {}) => ({ commandLibrary: null, robotClass: null, robot: robot(), ...patch });

describe("Open folder on a folder with no zenith.json", () => {
  it("grants the folder for Set up and says it needs it, without putting it on the recent list", () => {
    const deps = { remember: vi.fn(), grant: vi.fn() };
    expect(pickedFolder(root, deps)).toEqual({ root, name: "team-repo", needsSetup: true });
    expect(deps.grant).toHaveBeenCalledWith(root);
    expect(deps.remember).not.toHaveBeenCalled();
  });

  it("opens a folder that has zenith.json as before", () => {
    writeFileSync(join(root, "zenith.json"), "{}\n", "utf8");
    const ref = { root, name: "team-repo" };
    const deps = { remember: vi.fn(() => ref), grant: vi.fn() };
    expect(pickedFolder(root, deps)).toBe(ref);
    expect(deps.grant).not.toHaveBeenCalled();
  });
});

describe("setupScan", () => {
  it("reads TeamCode's Java, relative to the root, and lists Set up's files already there", () => {
    writeFileSync(join(root, "TeamCode/notes.txt"), "not code\n", "utf8");
    const scan = setupScan(root);
    expect(scan.teamCode).toBe(true);
    expect(scan.sources).toEqual([{ path: TEAM_ROBOT_PATH, text: TEAM_ROBOT }]);
    expect(scan.taken).toEqual([]);
    mkdirSync(join(root, "autos"));
    writeFileSync(join(root, "autos/robot.json"), "{}\n", "utf8");
    expect(setupScan(root).taken).toEqual(["autos/robot.json"]);
  });

  it("says when there is no TeamCode, and reads nothing", () => {
    rmSync(join(root, "TeamCode"), { recursive: true });
    expect(setupScan(root)).toEqual({ teamCode: false, sources: [], taken: [], existing: null });
  });
});

describe("setupRequestFiles", () => {
  it("builds zenith.json itself, with no sim block and a codegen section only with a robot class", () => {
    const plain = loadLink(JSON.parse(setupRequestFiles(request())[0]?.text ?? ""));
    expect(plain.sim).toBeUndefined();
    expect(plain.codegen).toBeUndefined();
    expect(plain.deploy?.commandLibrary).toBeUndefined();
    const full = loadLink(
      JSON.parse(setupRequestFiles(request({ commandLibrary: "ivy", robotClass: "org.firstinspires.ftc.teamcode.robot.TeamRobot" }))[0]?.text ?? ""),
    );
    expect(full.deploy).toMatchObject({ commandLibrary: "ivy", robotClass: "org.firstinspires.ftc.teamcode.robot.TeamRobot" });
    expect(full.codegen).toBeDefined();
    expect(full.sim).toBeUndefined();
  });

  it("takes nothing else from the renderer for zenith.json, whatever it sends", () => {
    const sneaky = request({ sim: { command: "calc.exe" }, link: '{"sim":{"command":"calc.exe"}}', "zenith.json": "{}" });
    const files = setupRequestFiles(sneaky);
    expect(files.map((file) => file.path)).toEqual([...SETUP_PATHS]);
    expect(files.map((file) => file.text).join("")).not.toContain("calc.exe");
  });

  it("refuses a library that is not one of the two, and a robot class that is not a class name", () => {
    expect(() => setupRequestFiles(request({ commandLibrary: "ftclib" }))).toThrow(/SolversLib or Ivy/);
    expect(() => setupRequestFiles(request({ commandLibrary: 3 }))).toThrow(/SolversLib or Ivy/);
    expect(() => setupRequestFiles(request({ robotClass: "a.B; Runtime.exec" }))).toThrow(/fully qualified Java class name/);
    expect(() => setupRequestFiles(request({ robotClass: 12 }))).toThrow(/fully qualified Java class name/);
    expect(() => setupRequestFiles("not a request")).toThrow("Zenith could not set this folder up. Open the folder again to retry.");
  });

  it("refuses a robot that does not load", () => {
    expect(() => setupRequestFiles(request({ robot: { name: "x" } }))).toThrow(/robot is not valid/);
  });

  it("writes the robot it was sent, in canonical form, and the bundled season's field", () => {
    const files = Object.fromEntries(setupRequestFiles(request()).map((file) => [file.path, file.text]));
    expect(files["autos/robot.json"]).toBe(canonicalize("robot", loadRobot(robot())));
    expect(files["autos/field/biobuzz.field.json"]).toBe(canonicalize("field", loadField(JSON.parse(readFileSync(SEASON_FIELD, "utf8")))));
  });
});

describe("writeSetup", () => {
  it("writes the five files into the folder and leaves everything else as it was", () => {
    expect(writeSetup(root, setupRequestFiles(request()))).toEqual([...SETUP_PATHS]);
    for (const path of SETUP_PATHS) expect(existsSync(join(root, path)), path).toBe(true);
    expect(readFileSync(join(root, TEAM_ROBOT_PATH), "utf8")).toBe(TEAM_ROBOT);
  });

  it("never writes over a file already there, and then writes nothing at all", () => {
    mkdirSync(join(root, "autos"));
    writeFileSync(join(root, "autos/waypoints.json"), "ours\n", "utf8");
    expect(() => writeSetup(root, setupRequestFiles(request()))).toThrow(
      "team-repo already has autos/waypoints.json, so nothing was written. Move it out of the way, then set up again.",
    );
    expect(existsSync(join(root, "zenith.json"))).toBe(false);
    expect(readFileSync(join(root, "autos/waypoints.json"), "utf8")).toBe("ours\n");
  });

  it("refuses a folder that has a zenith.json", () => {
    writeFileSync(join(root, "zenith.json"), "{}\n", "utf8");
    expect(() => writeSetup(root, setupRequestFiles(request()))).toThrow(/already has a zenith.json, so nothing was written/);
  });
});

describe("Set up on a folder that has autos already (issue #496)", () => {
  const putAutos = (): void => {
    mkdirSync(join(root, "zenith-autos/field"), { recursive: true });
    writeFileSync(join(root, "zenith-autos/first.auto.json"), "{}\n", "utf8");
    writeFileSync(join(root, "zenith-autos/robot.json"), "{}\n", "utf8");
    writeFileSync(join(root, "zenith-autos/field/biobuzz.field.json"), "{}\n", "utf8");
    // Build output is never searched.
    mkdirSync(join(root, "TeamCode/build/autos"), { recursive: true });
    writeFileSync(join(root, "TeamCode/build/autos/a.auto.json"), "{}\n", "utf8");
    writeFileSync(join(root, "TeamCode/build/autos/b.auto.json"), "{}\n", "utf8");
  };

  it("finds the autos and says which files Set up would write", () => {
    putAutos();
    expect(existingProjectIn(root)).toEqual({
      autosDir: "zenith-autos",
      autos: ["first.auto.json"],
      robot: "zenith-autos/robot.json",
      field: "zenith-autos/field/biobuzz.field.json",
      waypoints: null,
    });
    expect(setupScan(root)).toMatchObject({ taken: [], existing: { autosDir: "zenith-autos" } });
  });

  it("writes only zenith.json, which main builds from the autos it found itself", () => {
    putAutos();
    const files = setupRequestFiles(request({ inPlace: true, autosDir: "../../elsewhere" }), root);
    expect(files.map((file) => file.path)).toEqual(["zenith.json"]);
    const link = loadLink(JSON.parse(files[0]?.text ?? ""));
    expect(link).toMatchObject({ autosDir: "zenith-autos", robot: "zenith-autos/robot.json", field: "zenith-autos/field/biobuzz.field.json" });
    expect(link.sim).toBeUndefined();
    expect(writeSetup(root, files)).toEqual(["zenith.json"]);
    expect(readFileSync(join(root, "zenith-autos/robot.json"), "utf8")).toBe("{}\n");
  });

  it("refuses in place when there are no autos to point at", () => {
    expect(() => setupRequestFiles(request({ inPlace: true }), root)).toThrow(/no autos in this folder/);
    expect(() => setupRequestFiles(request({ inPlace: true }))).toThrow(/no autos in this folder/);
  });
});
