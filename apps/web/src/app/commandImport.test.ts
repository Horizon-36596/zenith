import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadRobot } from "@horizon36596/zenith-core";
import type { Auto, Robot } from "@horizon36596/zenith-schema";
import type { Project } from "../project/types";
import { getState } from "../state/store";
import { ACTIONS } from "./actions";
import {
  defaultScanDir,
  importCommandsBlockedReason,
  normalizeDir,
  planCommandImport,
  sourcesFromGitHub,
  sourcesFromPickedFiles,
  type RepositoryReader,
} from "./commandImport";

/** Import commands from Java: the part of the dialog that runs once the sources are in hand. */
const repo = fileURLToPath(new URL("../../../../", import.meta.url));
const read = (path: string): string => readFileSync(`${repo}${path}`, "utf8");
const starterRobot = () => loadRobot(JSON.parse(read("examples/starter/autos/robot.json")));
const myRobot = read("packages/import/fixtures/java/readme/MyRobot.java");
const withWiggle = myRobot.replace(
  'NamedCommands.registerCondition("holdingPiece", intake::hasPiece);',
  'NamedCommands.registerCondition("holdingPiece", intake::hasPiece);\n        NamedCommands.register("wiggle", (args, ctx) -> wiggle(NamedCommands.argDouble(args, "wiggle", "seconds", 0.5)));',
);

describe("planCommandImport", () => {
  it("previews the additions to robot.json as a diff, and changes nothing a person wrote", () => {
    const plan = planCommandImport(starterRobot(), [{ path: "TeamCode/src/main/java/MyRobot.java", text: withWiggle }]);
    expect(plan.merge.changes.map((change) => change.name)).toEqual(["wiggle"]);
    const added = plan.hunks.filter((line) => line !== null && line.op === "+").map((line) => line?.text.trim());
    expect(added).toContain('"name": "wiggle",');
    expect(added).toContain('"estimateS": "unknown",');
    expect(plan.hunks.some((line) => line !== null && line.op === "-" && !line.text.trim().startsWith("}"))).toBe(false);
    // What the CLI would call errors are shown too, for the person to settle.
    expect(plan.merge.findings.filter((finding) => finding.severity === "error").map((finding) => finding.name)).toEqual([
      "intakeOff",
      "spinUp",
      "hopperFull",
      "hopperEmpty",
    ]);
  });

  it("has an empty diff when robot.json already has everything", () => {
    const plan = planCommandImport(starterRobot(), [{ path: "MyRobot.java", text: myRobot }]);
    expect(plan.hunks).toEqual([]);
    expect(plan.after).toBe(plan.before);
  });
});

describe("the sources", () => {
  it("reads picked files, dropping the project folder's own name and skipping tests and non-sources", async () => {
    const file = (path: string, text: string): File => {
      const made = new File([text], path.split("/").pop() ?? path);
      Object.defineProperty(made, "webkitRelativePath", { value: path });
      return made;
    };
    const sources = await sourcesFromPickedFiles(
      [
        file("robot-repo/TeamCode/src/main/java/MyRobot.java", myRobot),
        file("robot-repo/TeamCode/src/test/java/FakeRobot.java", myRobot),
        file("robot-repo/TeamCode/build/Gen.java", myRobot),
        file("robot-repo/README.md", "# not code"),
      ],
      "robot-repo",
    );
    expect(sources.map((source) => source.path)).toEqual(["TeamCode/src/main/java/MyRobot.java"]);
  });

  it("walks a GitHub repository through the reader, one directory at a time, skipping what the CLI skips", async () => {
    const tree: Record<string, Array<{ name: string; path: string; type: string }>> = {
      TeamCode: [
        { name: "src", path: "TeamCode/src", type: "dir" },
        { name: "build", path: "TeamCode/build", type: "dir" },
      ],
      "TeamCode/src": [
        { name: "main", path: "TeamCode/src/main", type: "dir" },
        { name: "test", path: "TeamCode/src/test", type: "dir" },
      ],
      "TeamCode/src/main": [
        { name: "MyRobot.java", path: "TeamCode/src/main/MyRobot.java", type: "file" },
        { name: "notes.txt", path: "TeamCode/src/main/notes.txt", type: "file" },
      ],
    };
    const listed: string[] = [];
    const reader: RepositoryReader = {
      listDirectory: (path) => {
        listed.push(path);
        return Promise.resolve(tree[path] ?? []);
      },
      readText: () => Promise.resolve(myRobot),
    };
    const sources = await sourcesFromGitHub(reader, "./TeamCode/");
    expect(sources.map((source) => source.path)).toEqual(["TeamCode/src/main/MyRobot.java"]);
    expect(listed).toEqual(["TeamCode", "TeamCode/src", "TeamCode/src/main"]);
  });

  it("reads an empty folder name as the whole project", () => {
    expect(normalizeDir(" ./ ")).toBe("");
    expect(normalizeDir("TeamCode\\src\\")).toBe("TeamCode/src");
  });
});

describe("the palette action", () => {
  it("is offered once a project is open, and says why not otherwise", () => {
    const action = ACTIONS.find((entry) => entry.id === "project.importCommands");
    expect(action?.label).toBe("Import commands from Java…");
    expect(importCommandsBlockedReason({ project: null, review: null })).toContain("Open a project first");
  });

  it("Insert a command reads the open auto's own robot when it has one (issue #401)", () => {
    const action = ACTIONS.find((entry) => entry.id === "insert.command");
    if (action === undefined || typeof action.enabled !== "function") throw new Error("expected insert.command");
    const withCommands = starterRobot();
    expect(withCommands.commands.length).toBeGreaterThan(0);
    const without = { ...withCommands, commands: [] };
    const base = { ...getState(), auto: {} as Auto, review: null };
    const project = (robot: Robot) => ({ robot }) as unknown as Project;
    // The override has commands and robot.json has none: offered.
    expect(action.enabled({ ...base, project: project(without), autoRobot: withCommands })).toBe(true);
    // The other way round: not offered, since the list it would open is empty.
    expect(action.enabled({ ...base, project: project(withCommands), autoRobot: without })).toBe(false);
    // No override: robot.json decides.
    expect(action.enabled({ ...base, project: project(withCommands), autoRobot: null })).toBe(true);
  });
});

describe("the folder the dialog offers first", () => {
  it("is zenith.json's first javaDir, or TeamCode", () => {
    expect(defaultScanDir({ javaDir: "RobotCode/src/main/java" })).toBe("RobotCode/src/main/java");
    expect(defaultScanDir({ javaDir: ["A", "B"] })).toBe("A");
    expect(defaultScanDir({})).toBe("TeamCode");
    expect(defaultScanDir(undefined)).toBe("TeamCode");
  });
});
