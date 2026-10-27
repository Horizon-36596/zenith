/**
 * Issue #496: a folder that has autos but no zenith.json is set up where it is. Set up finds the
 * autos, robot, field and waypoints, writes zenith.json pointing at them, and writes a robot or a
 * field only where the folder has none, so nothing it holds is moved or written over.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { canonicalize, loadField, loadLink, skeletonRobot } from "@horizon36596/zenith-core";
import { describe, expect, it } from "vitest";
import { existingLine, findExistingProject, inPlaceFileSet, inPlacePaths } from "./setupFiles";

const field = loadField(
  JSON.parse(readFileSync(fileURLToPath(new URL("../../../../packages/season-biobuzz/field/biobuzz.field.json", import.meta.url)), "utf8")),
);
const choices = { commandLibrary: null, robotClass: null, robot: skeletonRobot("team-repo", "the editor's Set up"), field };

describe("findExistingProject", () => {
  it("finds the autos and the files beside them", () => {
    const existing = findExistingProject([
      "autos/a.auto.json",
      "autos/b.auto.json",
      "autos/robot.json",
      "autos/waypoints.json",
      "autos/field/biobuzz.field.json",
      "TeamCode/src/main/assets/autos/a.auto.json",
      "TeamCode/src/main/assets/autos/b.auto.json",
      "TeamCode/src/main/assets/autos/c.auto.json",
    ]);
    // The deploy copy under TeamCode has more, but it is a copy: the team's own autos win.
    expect(existing).toEqual({
      autosDir: "autos",
      autos: ["a.auto.json", "b.auto.json"],
      robot: "autos/robot.json",
      field: "autos/field/biobuzz.field.json",
      waypoints: "autos/waypoints.json",
    });
  });

  it("takes the folder with the most autos, and the robot and field nearest to it", () => {
    const existing = findExistingProject([
      "plans/old.auto.json",
      "zenith-autos/a.auto.json",
      "zenith-autos/b.auto.json",
      "robot.json",
      "fields/decode.field.json",
    ]);
    expect(existing).toMatchObject({ autosDir: "zenith-autos", robot: "robot.json", field: "fields/decode.field.json", waypoints: null });
  });

  it("says there is no project when there are no autos in a folder", () => {
    expect(findExistingProject(["autos/robot.json", "build.gradle"])).toBeNull();
    expect(findExistingProject(["loose.auto.json"])).toBeNull();
  });
});

describe("inPlaceFileSet", () => {
  it("writes only zenith.json, pointing at the files where they are", () => {
    const existing = {
      autosDir: "zenith-autos",
      autos: ["a.auto.json"],
      robot: "zenith-autos/robot.json",
      field: "zenith-autos/field/biobuzz.field.json",
      waypoints: null,
    };
    expect(inPlacePaths(existing)).toEqual(["zenith.json"]);
    const files = inPlaceFileSet(existing, { ...choices, commandLibrary: "ivy", robotClass: "org.firstinspires.ftc.teamcode.robot.TeamRobot" });
    expect(files.map((file) => file.path)).toEqual(["zenith.json"]);
    const link = loadLink(JSON.parse(files[0]?.text ?? ""));
    expect(link).toMatchObject({ autosDir: "zenith-autos", robot: "zenith-autos/robot.json", field: "zenith-autos/field/biobuzz.field.json" });
    expect(link.waypoints).toBeUndefined();
    expect(link.sim).toBeUndefined();
    expect(link.deploy).toMatchObject({ commandLibrary: "ivy", robotClass: "org.firstinspires.ftc.teamcode.robot.TeamRobot" });
    expect(link.codegen).toBeDefined();
  });

  it("writes a robot and the season's field beside the autos only when the folder has none", () => {
    const existing = { autosDir: "autos", autos: ["a.auto.json"], robot: null, field: null, waypoints: "autos/waypoints.json" };
    expect(inPlacePaths(existing)).toEqual(["zenith.json", "autos/robot.json", "autos/field/biobuzz.field.json"]);
    const files = inPlaceFileSet(existing, choices);
    expect(files.map((file) => file.path)).toEqual(inPlacePaths(existing));
    expect(files[2]?.text).toBe(canonicalize("field", field));
    expect(loadLink(JSON.parse(files[0]?.text ?? "")).waypoints).toBe("autos/waypoints.json");
  });

  it("refuses a robot class that is not a class name", () => {
    const existing = { autosDir: "autos", autos: ["a.auto.json"], robot: "autos/robot.json", field: "autos/f.field.json", waypoints: null };
    expect(() => inPlaceFileSet(existing, { ...choices, robotClass: "Team Robot" })).toThrow(/Nothing was written/);
  });

  it("says how many autos and where", () => {
    expect(existingLine("robot-repo", { autosDir: "autos", autos: ["a.auto.json", "b.auto.json"], robot: null, field: null, waypoints: null })).toBe(
      "robot-repo has 2 autos in autos but no zenith.json.",
    );
  });
});
