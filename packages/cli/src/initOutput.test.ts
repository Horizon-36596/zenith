/**
 * What `zenith init` and `zenith new` write, byte for byte. The skeletons they write moved from the
 * CLI into core in issue #159, so the editor's Set up writes the same files; these snapshots were
 * recorded before the move, so a change to what the CLI writes shows up here.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runInit } from "./commands/init.js";
import { runNew } from "./commands/new.js";

let dir = "";
let root = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "zenith-init-output-"));
  // A fixed folder name, because init names the robot after the folder.
  root = join(dir, "team-robot");
  mkdirSync(root);
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

const written = (path: string): string => readFileSync(join(root, path), "utf8");

describe("zenith init output", () => {
  it("writes the same zenith.json, robot.json and waypoints.json as before the skeletons moved into core", () => {
    expect(runInit({ cwd: root })).toBe(0);
    expect(written("zenith.json")).toMatchSnapshot("zenith.json");
    expect(written("autos/robot.json")).toMatchSnapshot("robot.json");
    expect(written("autos/waypoints.json")).toMatchSnapshot("waypoints.json");
  });

  it("writes the command library and the robot class it is given, and nothing else changes", () => {
    expect(runInit({ cwd: root, commandLibrary: "ivy", robotClass: "org.firstinspires.ftc.teamcode.robot.TeamRobot" })).toBe(0);
    expect(written("zenith.json")).toMatchSnapshot("zenith.json with a library and a robot class");
  });

  it("zenith new writes the same RED and BLUE skeleton autos as before", () => {
    expect(runInit({ cwd: root })).toBe(0);
    expect(runNew("demo", { cwd: root })).toBe(0);
    expect(runNew("demo-blue", { cwd: root, alliance: "BLUE" })).toBe(0);
    expect(written("autos/demo.auto.json")).toMatchSnapshot("demo.auto.json");
    expect(written("autos/demo-blue.auto.json")).toMatchSnapshot("demo-blue.auto.json");
  });
});
