/**
 * Issue #159 (N35): Open folder on a robot repository with no zenith.json used to stop at "Could not
 * read zenith.json in this folder." Now it offers Set up, which scans TeamCode, writes the five files
 * Zenith needs (never over one already there) and opens the folder as a writable project.
 *
 * The folder is an in-memory stand-in for the File System Access API's directory handle, handed out
 * by a stubbed `window.showDirectoryPicker`, and the desktop app's bridge is a stand-in over a map of
 * paths, so both run in node.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { canonicalize, loadField, loadLink, loadRobot } from "@horizon36596/zenith-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DESKTOP_API_VERSION, type DesktopSetupRequest, type ZenithDesktopBridge } from "../project/desktopBridge";
import { findExistingProject, inPlaceFileSet, SETUP_PATHS, setupFileSet } from "../project/setupFiles";
import { clearOpenProblem, getOpenProblem } from "./openProblem";
import { clearStatus, closeProject, getState } from "../state/store";
import { loadExample, openFolder, save } from "./projectActions";
import { answerSaveChoice, getSaveChoice } from "./saveChoice";
import { cancelSetup, runSetup } from "./setupProject";
import { getSetupView, hideSetup } from "./setupView";

const repo = fileURLToPath(new URL("../../../../", import.meta.url));
const seasonField = readFileSync(`${repo}packages/season-biobuzz/field/biobuzz.field.json`, "utf8").replace(/\r\n/g, "\n");

const TEAM_ROBOT_PATH = "TeamCode/src/main/java/org/firstinspires/ftc/teamcode/robot/TeamRobot.java";
const TEAM_ROBOT = [
  "package org.firstinspires.ftc.teamcode.robot;",
  "",
  "public class TeamRobot implements ZenithRobot {",
  "    @Override public void registerCommands(AutoFromFile opMode) {",
  '        NamedCommands.register("intakeOn", (args, ctx) -> intake.on());',
  '        NamedCommands.register("score", (args, ctx) -> new Score(NamedCommands.argInt(args, "score", "count")));',
  '        NamedCommands.registerCondition("holdingPiece", intake::hasPiece);',
  "    }",
  "}",
  "",
].join("\n");

/** An FTC SDK repository as a team has it, before Zenith: Gradle files and TeamCode, no zenith.json. */
const ftcRepo = (extra: Record<string, string> = {}): Record<string, string> => ({
  "build.gradle": "// The FTC SDK's top-level build file.\n",
  "settings.gradle": "include ':FtcRobotController'\ninclude ':TeamCode'\n",
  "TeamCode/build.gradle": "// TeamCode's build file.\n",
  [TEAM_ROBOT_PATH]: TEAM_ROBOT,
  ...extra,
});

/** Enough of a `FileSystemDirectoryHandle` for `local.ts` and the scan: folders, files, listing. */
class MemoryFolder {
  readonly kind = "directory";
  private readonly files = new Map<string, string>();
  private readonly folders = new Map<string, MemoryFolder>();

  constructor(readonly name: string) {}

  static of(name: string, files: Record<string, string>): MemoryFolder {
    const root = new MemoryFolder(name);
    for (const [path, text] of Object.entries(files)) root.put(path, text);
    return root;
  }

  put(path: string, text: string): void {
    const parts = path.split("/");
    const file = parts.pop() ?? "";
    let folder: MemoryFolder = this;
    for (const part of parts) {
      const next = folder.folders.get(part) ?? new MemoryFolder(part);
      folder.folders.set(part, next);
      folder = next;
    }
    folder.files.set(file, text);
  }

  text(path: string): string | undefined {
    const parts = path.split("/");
    const file = parts.pop() ?? "";
    let folder: MemoryFolder | undefined = this;
    for (const part of parts) folder = folder?.folders.get(part);
    return folder?.files.get(file);
  }

  getDirectoryHandle(name: string, options: { create?: boolean } = {}): Promise<MemoryFolder> {
    const found = this.folders.get(name);
    if (found !== undefined) return Promise.resolve(found);
    if (options.create !== true) return Promise.reject(new DOMException(`${name} is not a folder here`, "NotFoundError"));
    const made = new MemoryFolder(name);
    this.folders.set(name, made);
    return Promise.resolve(made);
  }

  getFileHandle(name: string, options: { create?: boolean } = {}): Promise<unknown> {
    if (!this.files.has(name) && options.create !== true) {
      return Promise.reject(new DOMException(`${name} is not a file here`, "NotFoundError"));
    }
    return Promise.resolve(this.fileHandle(name));
  }

  private fileHandle(name: string) {
    const files = this.files;
    return {
      kind: "file",
      getFile: () => {
        const text = files.get(name) ?? "";
        return Promise.resolve({ size: text.length, text: () => Promise.resolve(text) });
      },
      createWritable: () => {
        let written = "";
        return Promise.resolve({
          write: (text: string) => {
            written += text;
            return Promise.resolve();
          },
          close: () => {
            files.set(name, written);
            return Promise.resolve();
          },
        });
      },
    };
  }

  async *entries(): AsyncGenerator<[string, { kind: string }]> {
    for (const name of this.files.keys()) yield [name, this.fileHandle(name)];
    for (const [name, folder] of this.folders) yield [name, folder];
  }
}

let picked: MemoryFolder | null = null;

beforeEach(() => {
  answerSaveChoice("cancel");
  hideSetup();
  closeProject();
  clearStatus();
  clearOpenProblem();
  picked = null;
  vi.stubGlobal("window", { showDirectoryPicker: () => Promise.resolve(picked) });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Opens `folder` with Open folder, and resolves with the Set up question it asked. */
async function openAndAsk(folder: MemoryFolder) {
  picked = folder;
  await openFolder();
  const prompt = getSetupView().prompt;
  if (prompt === null) throw new Error(`Open folder asked nothing; the status line says ${getState().status?.message ?? "nothing"}.`);
  return prompt;
}

describe("Open folder on a robot repository with no zenith.json (N35)", () => {
  it("offers Set up for the folder, not the status-line error", async () => {
    const prompt = await openAndAsk(MemoryFolder.of("team-repo", ftcRepo()));
    expect(prompt.folder).toBe("team-repo");
    expect(prompt.teamCode).toBe(true);
    expect(prompt.taken).toEqual([]);
    expect(getState().status?.message ?? "").not.toContain("Could not read zenith.json");
    expect(getState().status?.kind).not.toBe("error");
    expect(getState().project).toBeNull();
  });

  it("prefills the robot class and the scanned commands, and leaves the library unchosen with no import", async () => {
    const prompt = await openAndAsk(MemoryFolder.of("team-repo", ftcRepo()));
    expect(prompt.plan.robotClass).toBe("org.firstinspires.ftc.teamcode.robot.TeamRobot");
    expect(prompt.plan.commands).toEqual(["intakeOn", "score"]);
    expect(prompt.plan.conditions).toEqual(["holdingPiece"]);
    expect(prompt.plan.library).toBeNull();
  });

  it("prefills the library from an import that names it", async () => {
    const wiring = "package org.firstinspires.ftc.teamcode.robot;\n\nimport org.horizon36596.zenith.solverslib.NamedCommands;\n";
    const prompt = await openAndAsk(
      MemoryFolder.of("team-repo", ftcRepo({ "TeamCode/src/main/java/org/firstinspires/ftc/teamcode/robot/Wiring.java": wiring })),
    );
    expect(prompt.plan.library).toBe("solverslib");
  });

  it("still offers Set up for a folder with no TeamCode, with nothing to prefill", async () => {
    const prompt = await openAndAsk(MemoryFolder.of("plain", { "notes.txt": "hello\n" }));
    expect(prompt.teamCode).toBe(false);
    expect(prompt.plan).toMatchObject({ robotClass: "", library: null, commands: [] });
  });

  it("still says it could not read a zenith.json that is there", async () => {
    const folder = MemoryFolder.of("broken", { "zenith.json": "{ not json" });
    picked = folder;
    await openFolder();
    expect(getSetupView().prompt).toBeNull();
    expect(getState().status?.kind).toBe("error");
    // The empty canvas says so too, naming the folder (issue #502).
    expect(getOpenProblem()).toEqual({ kind: "folder", name: "broken", message: getState().status?.message });
  });
});

/** The starter project's files, as a team has them after copying its autos across with no zenith.json. */
const starterAutos = (): Record<string, string> => {
  const at = (path: string): string => readFileSync(`${repo}examples/starter/${path}`, "utf8").replace(/\r\n/g, "\n");
  return {
    // The auto names its own robot and field by path, which moved with it.
    "zenith-autos/first-auto.auto.json": at("autos/first-auto.auto.json").replace(/"autos\//g, '"zenith-autos/'),
    "zenith-autos/robot.json": at("autos/robot.json"),
    "zenith-autos/waypoints.json": at("autos/waypoints.json"),
    "zenith-autos/field/biobuzz.field.json": at("autos/field/biobuzz.field.json"),
  };
};

describe("Set up on a folder that has autos and no zenith.json (issue #496)", () => {
  it("offers to write only zenith.json, pointing at the autos where they are", async () => {
    const prompt = await openAndAsk(MemoryFolder.of("team-repo", ftcRepo(starterAutos())));
    expect(prompt.existing).toEqual({
      autosDir: "zenith-autos",
      autos: ["first-auto.auto.json"],
      robot: "zenith-autos/robot.json",
      field: "zenith-autos/field/biobuzz.field.json",
      waypoints: "zenith-autos/waypoints.json",
    });
    expect(prompt.taken).toEqual([]);
  });

  it("writes zenith.json alone, moves and changes nothing, and opens the project on its own auto", async () => {
    const files = ftcRepo(starterAutos());
    const folder = MemoryFolder.of("team-repo", files);
    const prompt = await openAndAsk(folder);
    await runSetup({ robotClass: prompt.plan.robotClass, library: "solverslib" });

    expect(getSetupView().done?.written).toEqual(["zenith.json"]);
    const link = loadLink(JSON.parse(folder.text("zenith.json") ?? ""));
    expect(link).toMatchObject({ autosDir: "zenith-autos", robot: "zenith-autos/robot.json", waypoints: "zenith-autos/waypoints.json" });
    for (const [path, text] of Object.entries(files)) expect(folder.text(path), path).toBe(text);
    for (const path of SETUP_PATHS.filter((path) => path !== "zenith.json")) expect(folder.text(path), path).toBeUndefined();
    expect(getState().project?.name).toBe("team-repo");
    expect(getState().fileName).toBe("first-auto.auto.json");
    expect(getState().status).toMatchObject({
      kind: "ok",
      message: "Wrote zenith.json in team-repo, pointing at the autos in zenith-autos, and opened it. Nothing was moved.",
    });
  });

  it("writes a robot beside the autos only when the folder has none", async () => {
    const autos = starterAutos();
    delete autos["zenith-autos/robot.json"];
    const folder = MemoryFolder.of("team-repo", ftcRepo(autos));
    const prompt = await openAndAsk(folder);
    expect(prompt.existing?.robot).toBeNull();
    await runSetup({ robotClass: prompt.plan.robotClass, library: null });
    expect(getSetupView().done?.written).toEqual(["zenith.json", "zenith-autos/robot.json"]);
    expect(loadRobot(JSON.parse(folder.text("zenith-autos/robot.json") ?? "")).commands.map((command) => command.name)).toEqual(["intakeOn", "score"]);
  });
});

describe("the palette's Set up Zenith on a folder already set up (issue #502)", () => {
  it("says it is set up already, rather than only that it opened", async () => {
    const { setUpFolder } = await import("./projectActions");
    const autos = starterAutos();
    const files: Record<string, string> = { ...autos };
    const existing = findExistingProject(Object.keys(autos));
    if (existing === null) throw new Error("The starter's autos were not found.");
    const link = inPlaceFileSet(existing, {
      commandLibrary: null,
      robotClass: null,
      robot: loadRobot(JSON.parse(autos["zenith-autos/robot.json"] ?? "")),
      field: loadField(JSON.parse(seasonField)),
    });
    files["zenith.json"] = link[0]?.text ?? "";
    picked = MemoryFolder.of("team-repo", files);
    await setUpFolder();
    expect(getSetupView().prompt).toBeNull();
    expect(getState().status?.message).toBe("team-repo is already set up. Opened it.");
  });
});

describe("Set up", () => {
  it("writes the five files, zenith.json with no sim block, and opens the folder writable", async () => {
    const folder = MemoryFolder.of("team-repo", ftcRepo());
    const prompt = await openAndAsk(folder);
    await runSetup({ robotClass: prompt.plan.robotClass, library: null });

    for (const path of SETUP_PATHS) expect(folder.text(path), path).toBeDefined();
    const link = loadLink(JSON.parse(folder.text("zenith.json") ?? ""));
    expect(link.sim).toBeUndefined();
    expect(link.deploy?.robotClass).toBe("org.firstinspires.ftc.teamcode.robot.TeamRobot");
    expect(link.deploy?.commandLibrary).toBeUndefined();
    expect(link.codegen).toBeDefined();
    expect(loadRobot(JSON.parse(folder.text("autos/robot.json") ?? "")).commands.map((command) => command.name)).toEqual(["intakeOn", "score"]);
    expect(folder.text("autos/field/biobuzz.field.json")).toBe(canonicalize("field", loadField(JSON.parse(seasonField))));
    // Nothing that was there changed.
    expect(folder.text(TEAM_ROBOT_PATH)).toBe(TEAM_ROBOT);

    expect(getState().project?.source.kind).toBe("directory");
    expect(getState().project?.name).toBe("team-repo");
    expect(getState().fileName).toBe("first-auto.auto.json");
    expect(getState().status).toMatchObject({ kind: "ok", message: "Set Zenith up in team-repo and opened it. Save writes there." });

    const done = getSetupView().done;
    expect(done?.written).toEqual([...SETUP_PATHS]);
    expect(done?.gradle).toContain("com.github.Horizon-36596:zenith:v");

    // Save writes in place, with no save question.
    const before = folder.text("autos/first-auto.auto.json");
    await save();
    expect(folder.text("autos/first-auto.auto.json")).toBe(before);
    expect(getState().status?.kind).not.toBe("error");
  });

  it("writes no codegen section and no library when neither was given", async () => {
    const folder = MemoryFolder.of("team-repo", ftcRepo());
    await openAndAsk(folder);
    await runSetup({ robotClass: "  ", library: null });
    const link = loadLink(JSON.parse(folder.text("zenith.json") ?? ""));
    expect(link.codegen).toBeUndefined();
    expect(link.deploy?.robotClass).toBeUndefined();
    expect(getSetupView().done?.robotClass).toBeNull();
  });

  it("writes the library chosen", async () => {
    const folder = MemoryFolder.of("team-repo", ftcRepo());
    const prompt = await openAndAsk(folder);
    await runSetup({ robotClass: prompt.plan.robotClass, library: "ivy" });
    expect(loadLink(JSON.parse(folder.text("zenith.json") ?? "")).deploy?.commandLibrary).toBe("ivy");
    expect(getSetupView().done?.gradle).toContain("com.pedropathing.ivy:pedro");
  });

  it("never writes over a file already there, and writes nothing at all", async () => {
    const folder = MemoryFolder.of("team-repo", ftcRepo({ "autos/robot.json": "{}\n" }));
    const prompt = await openAndAsk(folder);
    expect(prompt.taken).toEqual(["autos/robot.json"]);
    await runSetup({ robotClass: prompt.plan.robotClass, library: null });
    expect(getSetupView().prompt?.problem).toBe(
      "team-repo already has autos/robot.json, so nothing was written. Move it out of the way, then set up again.",
    );
    expect(folder.text("zenith.json")).toBeUndefined();
    expect(folder.text("autos/robot.json")).toBe("{}\n");
    expect(getState().project).toBeNull();
  });

  it("refuses a robot class that is not a class name, writing nothing", async () => {
    const folder = MemoryFolder.of("team-repo", ftcRepo());
    await openAndAsk(folder);
    await runSetup({ robotClass: "Team Robot", library: null });
    expect(getSetupView().prompt?.problem).toMatch(/is not a fully qualified Java class name/);
    expect(folder.text("zenith.json")).toBeUndefined();
  });

  it("writes nothing on Cancel", async () => {
    const folder = MemoryFolder.of("team-repo", ftcRepo());
    await openAndAsk(folder);
    cancelSetup();
    expect(getSetupView().prompt).toBeNull();
    expect(folder.text("zenith.json")).toBeUndefined();
    expect(getState().status).toMatchObject({ kind: "info", message: "Nothing was written to team-repo." });
  });
});

const dirOf = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf("/")));

/** The autos folder the stand-in folder's zenith.json names, or null before it has one. */
const dirOfLink = (files: Map<string, string>): string | null => {
  const text = files.get("zenith.json");
  return text === undefined ? null : loadLink(JSON.parse(text)).autosDir;
};

/** A desktop bridge whose picker returns a folder with no zenith.json, and whose main writes as `setup` does. */
function desktopBridge(files: Map<string, string>) {
  const requests: DesktopSetupRequest[] = [];
  const ref = { root: "C:/team-repo", name: "team-repo" };
  const bridge = {
    apiVersion: DESKTOP_API_VERSION,
    project: {
      pick: () => Promise.resolve({ ...ref, needsSetup: !files.has("zenith.json") }),
      reopen: () => Promise.resolve(ref),
      setupScan: () =>
        Promise.resolve({
          teamCode: true,
          sources: [...files].filter(([path]) => path.endsWith(".java")).map(([path, text]) => ({ path, text })),
          taken: SETUP_PATHS.filter((path) => files.has(path)),
          existing: findExistingProject([...files.keys()]),
        }),
      setup: (_root: string, request: DesktopSetupRequest) => {
        requests.push(request);
        const { inPlace, ...asked } = request;
        const choices = { ...asked, robot: loadRobot(request.robot), field: loadField(JSON.parse(seasonField)) };
        const existing = findExistingProject([...files.keys()]);
        const written = inPlace === true && existing !== null ? inPlaceFileSet(existing, choices) : setupFileSet(choices);
        for (const file of written) files.set(file.path, file.text);
        return Promise.resolve({ project: ref, written: written.map((file) => file.path) });
      },
      listAutos: () =>
        Promise.resolve(
          [...files.keys()]
            .filter((path) => path.endsWith(".auto.json") && dirOf(path) === (dirOfLink(files) ?? "autos"))
            .map((path) => path.slice(path.lastIndexOf("/") + 1)),
        ),
      read: (_root: string, path: string) => {
        const text = files.get(path);
        return text === undefined ? Promise.reject(new Error(`Could not read ${path} in this folder.`)) : Promise.resolve(text);
      },
      watch: () => Promise.resolve(),
    },
  } as unknown as ZenithDesktopBridge;
  return { bridge, requests };
}

describe("Set up in the desktop app", () => {
  it("asks main to write the files from a library and a robot class, never a zenith.json, then opens the folder", async () => {
    const files = new Map(Object.entries(ftcRepo()));
    const { bridge, requests } = desktopBridge(files);
    vi.stubGlobal("window", { zenithDesktop: bridge });

    await openFolder();
    const prompt = getSetupView().prompt;
    expect(prompt?.plan.robotClass).toBe("org.firstinspires.ftc.teamcode.robot.TeamRobot");
    expect(prompt?.plan.library).toBeNull();
    await runSetup({ robotClass: prompt?.plan.robotClass ?? "", library: "solverslib" });

    expect(requests).toHaveLength(1);
    expect(Object.keys(requests[0] ?? {}).sort()).toEqual(["commandLibrary", "robot", "robotClass"]);
    expect(requests[0]).toMatchObject({ commandLibrary: "solverslib", robotClass: "org.firstinspires.ftc.teamcode.robot.TeamRobot" });
    expect(loadLink(JSON.parse(files.get("zenith.json") ?? "")).sim).toBeUndefined();
    expect(getState().project?.source.kind).toBe("desktop");
    expect(getState().fileName).toBe("first-auto.auto.json");
    expect(getSetupView().done?.written).toEqual([...SETUP_PATHS]);
  });
});

/** Waits, a turn at a time, for `get` to have something, and resolves with it. */
async function until<T>(get: () => T | null | undefined): Promise<T> {
  for (let tries = 0; tries < 500; tries += 1) {
    const value = get();
    if (value !== null && value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Timed out waiting for the editor.");
}

/** Ctrl S on the example, answered with Save the full project into `folder`. */
async function saveExampleProjectInto(folder: MemoryFolder): Promise<void> {
  await loadExample();
  picked = folder;
  const saving = save();
  await until(getSaveChoice);
  answerSaveChoice("project");
  await saving;
}

describe("Save the full project of the example (N35)", () => {
  it("writes a zenith.json that names no sim command, robot class or command library", async () => {
    const folder = new MemoryFolder("new-robot");
    await saveExampleProjectInto(folder);
    const link = loadLink(JSON.parse(folder.text("zenith.json") ?? ""));
    expect(link.sim).toBeUndefined();
    expect(link.deploy?.robotClass).toBeUndefined();
    expect(link.deploy?.commandLibrary).toBeUndefined();
    expect(link.codegen).toBeDefined();
    expect(getState().project?.name).toBe("new-robot");
    // The example itself still has them, so Simulate on the bundled example is unchanged.
    await loadExample();
    expect(getState().project?.link.sim).toBeDefined();
  });

  it("never copies the example into a robot repository, and says how to set Zenith up there", async () => {
    const folder = MemoryFolder.of("team-repo", ftcRepo());
    await saveExampleProjectInto(folder);
    expect(getState().status).toMatchObject({
      kind: "error",
      message:
        "team-repo is a robot repository, so nothing was written: Save the full project needs a new, empty folder. To use Zenith in team-repo, open it with Open project, and Zenith offers to set it up there.",
    });
    expect(folder.text("zenith.json")).toBeUndefined();
    expect(folder.text("autos/robot.json")).toBeUndefined();
    expect(getState().project?.source.kind).toBe("example");
  });

  it("writes into no folder that is not empty", async () => {
    const folder = MemoryFolder.of("stuff", { "notes.txt": "mine\n" });
    await saveExampleProjectInto(folder);
    expect(getState().status?.message).toBe("stuff is not empty, so nothing was written: Save the full project needs a new, empty folder.");
    expect(folder.text("zenith.json")).toBeUndefined();
  });
});

describe("Set up in the desktop app, on a folder that has autos (issue #496)", () => {
  it("asks main to set the autos up where they are, and main writes only zenith.json", async () => {
    const files = new Map(Object.entries(ftcRepo(starterAutos())));
    const before = new Map(files);
    const { bridge, requests } = desktopBridge(files);
    vi.stubGlobal("window", { zenithDesktop: bridge });

    await openFolder();
    const prompt = getSetupView().prompt;
    expect(prompt?.existing?.autosDir).toBe("zenith-autos");
    await runSetup({ robotClass: prompt?.plan.robotClass ?? "", library: null });

    expect(requests[0]?.inPlace).toBe(true);
    expect(getSetupView().done?.written).toEqual(["zenith.json"]);
    for (const [path, text] of before) expect(files.get(path), path).toBe(text);
    expect(loadLink(JSON.parse(files.get("zenith.json") ?? "")).autosDir).toBe("zenith-autos");
    expect(getState().project?.source.kind).toBe("desktop");
  });
});
