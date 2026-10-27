/**
 * The Settings window's logic (issue #97): which sections a person sees and which one opens, the
 * remembered section, and the Code section's reading and writing of the open project's command
 * library, which lives in `zenith.json` and nowhere else.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadLink, loadRobot } from "@horizon36596/zenith-core";
import type { Project, ProjectSource } from "../project/types";
import { linkTextWithCommandLibrary } from "../project/commandLibrary";
import { codeSettingsOf, whyLinkIsReadOnly } from "./codeSettings";
import { SECTIONS, closeHint, parseSection, resolveSection, signInMethodOf, visibleSections, type SectionContext } from "./sections";

const starter = (path: string): unknown =>
  JSON.parse(readFileSync(new URL(`../../../../examples/starter/${path}`, import.meta.url), "utf8"));

const NO_ONE: SectionContext = { cloud: false, signedIn: false, admin: false, fake: false, dev: false, commands: false };

function project(source: ProjectSource, link: unknown = starter("zenith.json")): Project {
  return {
    source,
    name: "robot-repo",
    link: loadLink(link),
    robot: loadRobot(starter("autos/robot.json")),
    field: {} as Project["field"],
    autoFiles: [],
    autoTexts: {},
  };
}

const folder: ProjectSource = { kind: "directory", handle: {} as FileSystemDirectoryHandle };

describe("the sections a person sees", () => {
  it("are Presets, General, Robot, Editor and Keyboard with the cloud off, since nothing else exists there", () => {
    expect(visibleSections(NO_ONE)).toEqual(["presets", "general", "robot", "editor", "keyboard"]);
  });

  it("add Commands only while the Commands switch is on", () => {
    expect(visibleSections({ ...NO_ONE, commands: true })).toEqual(["presets", "general", "robot", "commands", "editor", "keyboard"]);
  });

  it("add Account when the cloud is on, so a signed-out person can sign in from it", () => {
    expect(visibleSections({ ...NO_ONE, cloud: true })).toEqual(["account", "presets", "general", "robot", "editor", "keyboard"]);
  });

  it("add Teams and Privacy and data once signed in, Admin for a Horizon admin, Developer only for testing", () => {
    const member = { ...NO_ONE, cloud: true, signedIn: true };
    expect(visibleSections(member)).toEqual(["account", "presets", "general", "robot", "editor", "keyboard", "teams", "data"]);
    expect(visibleSections({ ...member, admin: true })).toContain("admin");
    expect(visibleSections({ ...member, fake: true })).toContain("developer");
    expect(visibleSections({ ...member, dev: true })).toContain("developer");
    // Signed out, nothing needs testing tools or admin rights yet.
    expect(visibleSections({ ...NO_ONE, cloud: true, admin: true, fake: true, dev: true })).toEqual(["account", "presets", "general", "robot", "editor", "keyboard"]);
  });

  it("keep the order the list shows them in", () => {
    const all = visibleSections({ cloud: true, signedIn: true, admin: true, fake: true, dev: true, commands: true });
    expect(all).toEqual(SECTIONS.map((section) => section.id));
  });
});

describe("the section that opens", () => {
  it("is the one asked for when the person can see it", () => {
    expect(resolveSection("editor", ["account", "general", "editor", "keyboard"])).toBe("editor");
  });

  it("is the first section when the one asked for is hidden or unknown", () => {
    expect(resolveSection("teams", ["general", "editor", "keyboard"])).toBe("general");
    expect(resolveSection("commands", ["general", "robot", "editor", "keyboard"])).toBe("general");
    expect(resolveSection(null, ["account", "general"])).toBe("account");
  });

  it("is remembered only as a real section id", () => {
    expect(parseSection("general")).toBe("general");
    expect(parseSection("presets")).toBe("presets");
    // Code became General (issue #101), so a remembered Code opens General.
    expect(parseSection("code")).toBe("general");
    expect(parseSection("billing")).toBeNull();
    expect(parseSection(3)).toBeNull();
  });
});

describe("the command library in Robot", () => {
  it("reads the command library from zenith.json and the pathing system from robot.json", () => {
    const code = codeSettingsOf(project(folder), true);
    expect(code.library).toBe("solverslib");
    expect(code.follower).toBe("Pedro Pathing");
    expect(code.whyCannotChange).toBeNull();
    expect(code.projectName).toBe("robot-repo");
  });

  it("never picks a library for a project that names none", () => {
    const link = starter("zenith.json") as { deploy: Record<string, unknown> };
    delete link.deploy["commandLibrary"];
    expect(codeSettingsOf(project(folder, link), true).library).toBeNull();
  });

  it("says why the library cannot be changed, for every source that cannot write zenith.json", () => {
    expect(whyLinkIsReadOnly({ kind: "example" })).toMatch(/read only/);
    expect(whyLinkIsReadOnly({ kind: "files" })).toMatch(/one at a time/);
    expect(whyLinkIsReadOnly({ kind: "github", owner: "o", repo: "r", base: "main", branch: "main", login: "l" })).toMatch(/GitHub/);
    expect(whyLinkIsReadOnly({ kind: "host", hostId: "dsim" })).toMatch(/app that opened/);
    expect(whyLinkIsReadOnly(folder)).toBeNull();
    expect(whyLinkIsReadOnly({ kind: "desktop", root: "C:/robot" })).toBeNull();
    // A desktop build too old to write zenith.json says so.
    expect(codeSettingsOf(project({ kind: "desktop", root: "C:/robot" }), false).whyCannotChange).toMatch(/desktop app/);
  });

  it("cannot set a library in a zenith.json with no deploy section, which writes no Java", () => {
    const link = starter("zenith.json") as Record<string, unknown>;
    delete link["deploy"];
    const code = codeSettingsOf(project(folder, link), true);
    expect(code.library).toBeNull();
    expect(code.whyCannotChange).toMatch(/no deploy section/);
    expect(() => linkTextWithCommandLibrary(JSON.stringify(link), "ivy")).toThrow(/deploy/);
  });

  it("changes only commandLibrary in the file as it is, and writes canonical zenith.json that loads again", () => {
    const onDisk = readFileSync(new URL("../../../../examples/starter/zenith.json", import.meta.url), "utf8").replace(/\r\n/g, "\n");
    const text = linkTextWithCommandLibrary(onDisk, "ivy");
    expect(text.endsWith("\n")).toBe(true);
    // One line differs, and sim.command, which the desktop app runs, is the same to the byte.
    const before = onDisk.split("\n");
    const after = text.split("\n");
    expect(after.length).toBe(before.length);
    expect(after.filter((line, index) => line !== before[index])).toEqual([`    "commandLibrary": "ivy",`]);
    expect((JSON.parse(text) as { sim: { command: string } }).sim.command).toBe((JSON.parse(onDisk) as { sim: { command: string } }).sim.command);
    expect(loadLink(JSON.parse(text)).deploy?.commandLibrary).toBe("ivy");
    // The starter's own zenith.json is canonical, so setting the library it already names changes no byte.
    expect(linkTextWithCommandLibrary(onDisk, "solverslib")).toBe(onDisk);
  });

  it("keeps keys the schema does not name, and refuses any library but the two", () => {
    const link = { ...(starter("zenith.json") as Record<string, unknown>), teamNote: "kept" };
    expect(JSON.parse(linkTextWithCommandLibrary(JSON.stringify(link), "ivy"))).toMatchObject({ teamNote: "kept" });
    expect(() => linkTextWithCommandLibrary(JSON.stringify(link), "roadrunner" as "ivy")).toThrow(/SolversLib or Ivy/);
  });
});

describe("the Account section", () => {
  it("names the sign-in method the way the sign-in panel does", () => {
    expect(signInMethodOf(["github.com"])).toBe("GitHub");
    expect(signInMethodOf(["google.com", "emailLink"])).toBe("Google, Email link");
    expect(signInMethodOf([])).toBe("Unknown");
  });
});

describe("the close button's hint (issue #313)", () => {
  it("says everything is saved only while Robot holds no unsaved change", () => {
    expect(closeHint(null)).toBe("Close Settings. Everything here is already saved.");
    const unsaved = closeHint("autos/robot.json");
    expect(unsaved).not.toContain("already saved");
    expect(unsaved).toContain("unsaved changes to autos/robot.json");
    // Closing asks (issue #414), so the hint says that rather than that the draft quietly stays.
    expect(unsaved).toContain("asks whether to save");
  });
});
