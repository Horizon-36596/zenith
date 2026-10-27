/**
 * Save the full project (issue #103): the files are the example's own, byte for byte in canonical
 * form, at the paths zenith.json names, and they open again with Open files, as loose files and as
 * the zip a browser without a folder picker downloads. An auto opened on its own says exactly which
 * files it is missing.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadField, loadLink, loadRobot, loadWaypoints } from "@horizon36596/zenith-core";
import { unzipText, projectFromFiles } from "./fallback";
import {
  fullProjectFolderProblem,
  LoneAutoError,
  loneAutoLines,
  newProjectLink,
  onlyAutos,
  projectFileSet,
  projectPath,
  projectZipName,
  type ProjectParts,
} from "./projectFiles";
import { zipStored } from "../library/zip";

const STARTER = "../../../../examples/starter/";
const read = (path: string): string =>
  readFileSync(fileURLToPath(new URL(`${STARTER}${path}`, import.meta.url)), "utf8").replace(/\r\n/g, "\n");

const AUTOS = ["all-step-kinds.auto.json", "collect-and-score.auto.json", "cycle-and-park.auto.json", "first-auto.auto.json"];

function exampleParts(): ProjectParts {
  return {
    link: loadLink(JSON.parse(read("zenith.json"))),
    robot: loadRobot(JSON.parse(read("autos/robot.json"))),
    field: loadField(JSON.parse(read("autos/field/biobuzz.field.json"))),
    waypoints: loadWaypoints(JSON.parse(read("autos/waypoints.json"))),
    autos: Object.fromEntries(AUTOS.map((name) => [name, read(`autos/${name}`)])),
  };
}

const filesOf = (entries: ReadonlyArray<{ path: string; text: string }>): File[] =>
  entries.map((entry) => new File([entry.text], entry.path.split("/").pop() as string));

describe("projectFileSet", () => {
  it("writes the example's own files, canonical and at the paths zenith.json names", () => {
    const files = projectFileSet(exampleParts());
    expect(files.map((file) => file.path)).toEqual([
      "zenith.json",
      "autos/robot.json",
      "autos/field/biobuzz.field.json",
      "autos/waypoints.json",
      ...AUTOS.map((name) => `autos/${name}`),
    ]);
    for (const file of files) expect(file.text, file.path).toBe(read(file.path));
  });

  it("keeps zenith.json's sim command, deploy and codegen as the example has them", () => {
    const link = JSON.parse(projectFileSet(exampleParts())[0]?.text ?? "{}") as Record<string, unknown>;
    expect(link["sim"]).toEqual(JSON.parse(read("zenith.json")).sim);
    expect(link["deploy"]).toEqual(JSON.parse(read("zenith.json")).deploy);
  });

  it("writes an edited auto in canonical form in place of the example's", () => {
    const parts = exampleParts();
    const edited = JSON.parse(read("autos/first-auto.auto.json")) as Record<string, unknown>;
    edited["title"] = "Edited";
    const files = projectFileSet({ ...parts, autos: { ...parts.autos, "first-auto.auto.json": JSON.stringify(edited) } });
    const first = files.find((file) => file.path === "autos/first-auto.auto.json");
    expect(JSON.parse(first?.text ?? "{}").title).toBe("Edited");
    expect(first?.text.endsWith("\n")).toBe(true);
  });

  it("opens again with Open files, as loose files", async () => {
    const project = await projectFromFiles(filesOf(projectFileSet(exampleParts())));
    expect(project.link.field).toBe("autos/field/biobuzz.field.json");
    expect(project.autoFiles).toEqual(AUTOS);
  });

  it("opens again with Open files from the zip a browser without a folder picker downloads", async () => {
    const files = projectFileSet(exampleParts());
    const bytes = zipStored(files);
    const unzipped = await unzipText(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
    expect([...unzipped.keys()]).toEqual(files.map((file) => file.path));
    for (const file of files) expect(unzipped.get(file.path)).toBe(file.text);
    const project = await projectFromFiles(filesOf([...unzipped].map(([path, text]) => ({ path, text }))));
    expect(project.autoFiles).toEqual(AUTOS);
  });

  it("leaves waypoints.json out when zenith.json names none", () => {
    const parts = exampleParts();
    const { waypoints: _drop, ...link } = parts.link;
    const files = projectFileSet({ ...parts, link: loadLink(link) });
    expect(files.map((file) => file.path)).not.toContain("autos/waypoints.json");
  });

  it("refuses a zenith.json path that leaves the project", () => {
    const parts = exampleParts();
    expect(() => projectFileSet({ ...parts, link: { ...parts.link, robot: "../robot.json" } })).toThrow(/not a path inside the project/);
    expect(() => projectFileSet({ ...parts, link: { ...parts.link, robot: "C:/robot.json" } })).toThrow(/not a path inside the project/);
    expect(() => projectFileSet({ ...parts, link: { ...parts.link, autosDir: "/autos" } })).toThrow(/not a path inside the project/);
  });

  it("refuses two files at one path", () => {
    const parts = exampleParts();
    expect(() => projectFileSet({ ...parts, link: { ...parts.link, field: "autos/robot.json" } })).toThrow(/for two files/);
  });

  it("refuses an auto name that is not a bare file name, and an auto that does not load", () => {
    const parts = exampleParts();
    expect(() => projectFileSet({ ...parts, autos: { "../x.auto.json": "{}" } })).toThrow(/not an auto file name/);
    expect(() => projectFileSet({ ...parts, autos: { "broken.auto.json": "{" } })).toThrow(/broken\.auto\.json does not load/);
  });
});

describe("projectPath and projectZipName", () => {
  it("tidies a path inside the project", () => {
    expect(projectPath("./autos/")).toBe("autos");
    expect(projectPath("autos\\field\\x.field.json")).toBe("autos/field/x.field.json");
  });

  it("names the zip after the project", () => {
    expect(projectZipName("examples/starter")).toBe("zenith-starter.zip");
    expect(projectZipName("Picked files")).toBe("zenith-picked-files.zip");
    expect(projectZipName("My Team.zip")).toBe("zenith-my-team.zip");
    expect(projectZipName("")).toBe("zenith-project.zip");
    expect(projectZipName("zenith-starter.zip")).toBe("zenith-starter.zip");
  });
});

describe("an auto opened on its own", () => {
  it("names the files it is missing and what to do", () => {
    expect(loneAutoLines(["first-auto.auto.json"])).toEqual([
      "first-auto.auto.json is only an auto.",
      "To open it, Zenith also needs the project it belongs to: zenith.json, robot.json and the season's field file (*.field.json).",
      "Open the project folder it belongs to, or open it with the example robot and field.",
    ]);
    expect(loneAutoLines(["b.auto.json", "a.auto.json"])[0]).toBe("These 2 files are only autos.");
    expect(loneAutoLines(["b.auto.json", "a.auto.json"])[2]).toBe(
      "Open the project folder they belong to, or open them with the example robot and field.",
    );
  });

  it("is only autos, and nothing else is", () => {
    expect(onlyAutos(["a.auto.json"])).toBe(true);
    expect(onlyAutos(["a.auto.json", "robot.json"])).toBe(false);
    expect(onlyAutos([])).toBe(false);
  });

  it("Open files with a lone auto throws the error that carries it, for the example offer", async () => {
    const text = read("autos/first-auto.auto.json");
    const error = await projectFromFiles([new File([text], "first-auto.auto.json")]).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(LoneAutoError);
    expect((error as LoneAutoError).autoTexts).toEqual({ "first-auto.auto.json": text });
    expect((error as LoneAutoError).message).toMatch(/^first-auto\.auto\.json is only an auto\./);
  });
});

/**
 * Issue #159 (N35): Save the full project makes a new project for trying Zenith out, so its
 * zenith.json names none of the example's robot repository (its sim test, robot class and command
 * library), and it goes only into an empty folder, never into a team's robot repository.
 */
describe("Save the full project's zenith.json and folder", () => {
  it("drops sim, deploy.robotClass and deploy.commandLibrary, and keeps the rest", () => {
    const example = loadLink(JSON.parse(read("zenith.json")));
    const link = newProjectLink(example);
    expect(link.sim).toBeUndefined();
    expect(link.deploy?.robotClass).toBeUndefined();
    expect(link.deploy?.commandLibrary).toBeUndefined();
    expect(link.deploy).toEqual({ kind: example.deploy?.kind, dir: example.deploy?.dir });
    expect(link.codegen).toEqual(example.codegen);
    expect({ ...link, deploy: undefined }).toEqual({ ...example, sim: undefined, deploy: undefined });
    // The example's own link is not changed.
    expect(example.sim).toBeDefined();
  });

  it("allows an empty folder, and one with only hidden entries such as .git", () => {
    expect(fullProjectFolderProblem("new-robot", [])).toBeNull();
    expect(fullProjectFolderProblem("new-robot", [".git", ".DS_Store"])).toBeNull();
  });

  it("refuses a project, a robot repository, and any other folder with something in it", () => {
    expect(fullProjectFolderProblem("robot-repo", ["zenith.json", "autos"])).toBe(
      "robot-repo already has a zenith.json, so nothing was written. Pick an empty folder, or use Save just this auto to add the auto to that project.",
    );
    const repository =
      "robot-repo is a robot repository, so nothing was written: Save the full project needs a new, empty folder. To use Zenith in robot-repo, open it with Open project, and Zenith offers to set it up there.";
    expect(fullProjectFolderProblem("robot-repo", [".git", "TeamCode", "FtcRobotController"])).toBe(repository);
    expect(fullProjectFolderProblem("robot-repo", ["build.gradle"])).toBe(repository);
    expect(fullProjectFolderProblem("stuff", ["notes.txt"])).toBe(
      "stuff is not empty, so nothing was written: Save the full project needs a new, empty folder.",
    );
  });
});
