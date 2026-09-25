import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BridgeError, RootRegistry, assertAutoFileName, confineRelative } from "../src/main/confine.js";
import { ProjectWatcher, listAutos, loadDesktopProject, readProjectFile, writeAuto } from "../src/main/project.js";
import { exampleProject, patchLink } from "./support.js";

let root = "";
let cleanup: () => void = () => undefined;

beforeEach(() => {
  ({ root, cleanup } = exampleProject());
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("confineRelative", () => {
  it("accepts a path inside the project", () => {
    expect(confineRelative(root, "autos/robot.json")).toBe(join(root, "autos", "robot.json"));
  });

  it.each([
    ["a parent segment", "../outside.json"],
    ["a parent segment in the middle", "autos/../../outside.json"],
    ["a backslash parent segment", "autos\\..\\..\\outside.json"],
    ["a Windows absolute path", "C:\\Windows\\win.ini"],
    ["a drive-relative path", "C:outside.json"],
    ["a POSIX absolute path", "/etc/passwd"],
    ["a UNC path", "\\\\server\\share\\x.json"],
    ["a NUL byte", "autos/robot.json\0.txt"],
    ["an empty path", ""],
  ])("refuses %s", (_label, path) => {
    expect(() => confineRelative(root, path)).toThrow(BridgeError);
  });

  it("refuses a non-string path from the renderer", () => {
    expect(() => confineRelative(root, 42)).toThrow(BridgeError);
    expect(() => confineRelative(root, { path: "autos" })).toThrow(BridgeError);
  });

  it("refuses a path that leaves the project through a link", () => {
    const outside = mkdtempSync(join(tmpdir(), "zenith-outside-"));
    try {
      // A junction on Windows needs no privilege; elsewhere a directory symlink does the same job.
      symlinkSync(outside, join(root, "escape"), process.platform === "win32" ? "junction" : "dir");
      expect(() => confineRelative(root, "escape/stolen.json")).toThrow(/through a link/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("assertAutoFileName", () => {
  it("accepts a bare auto file name", () => {
    expect(assertAutoFileName("first-auto.auto.json")).toBe("first-auto.auto.json");
  });

  it.each(["../first-auto.auto.json", "autos/first-auto.auto.json", "first-auto.json", ".auto.json", "a b.auto.json", "x;rm.auto.json"])(
    "refuses %s",
    (name) => {
      expect(() => assertAutoFileName(name)).toThrow(BridgeError);
    },
  );
});

describe("RootRegistry", () => {
  it("refuses a root the user never picked", () => {
    const roots = new RootRegistry();
    roots.grant(root);
    expect(roots.assert(root)).toBe(root);
    expect(() => roots.assert(join(root, ".."))).toThrow(/folder picker/);
    expect(() => roots.assert(undefined)).toThrow(BridgeError);
  });

  it.runIf(process.platform === "win32")("compares roots the way Windows does, ignoring case", () => {
    const roots = new RootRegistry();
    roots.grant(root);
    expect(roots.assert(root.toUpperCase())).toBe(root);
  });
});

describe("the project handlers", () => {
  it("lists the autos and reads files inside the project", () => {
    // Every auto in the folder, sorted, and nothing that is not one (robot.json, waypoints.json).
    const onDisk = readdirSync(join(root, "autos")).filter((name) => name.endsWith(".auto.json")).sort();
    expect(listAutos(root)).toEqual(onDisk);
    expect(onDisk).toEqual(expect.arrayContaining(["collect-and-score.auto.json", "first-auto.auto.json"]));
    expect(JSON.parse(readProjectFile(root, "zenith.json"))).toHaveProperty("autosDir", "autos");
    expect(() => readProjectFile(root, "../zenith.json")).toThrow(BridgeError);
  });

  it("writes an auto in place and only as JSON", () => {
    const text = `${readFileSync(join(root, "autos", "first-auto.auto.json"), "utf8").trimEnd()}\n`;
    expect(writeAuto(root, "first-auto.auto.json", text)).toBe("autos/first-auto.auto.json");
    expect(readFileSync(join(root, "autos", "first-auto.auto.json"), "utf8")).toBe(text);
    expect(() => writeAuto(root, "first-auto.auto.json", "not json")).toThrow(/not valid JSON/);
    expect(() => writeAuto(root, "../first-auto.auto.json", text)).toThrow(BridgeError);
    expect(() => writeAuto(root, "first-auto.auto.json", 12)).toThrow(BridgeError);
  });

  it("refuses a folder with no zenith.json", () => {
    const empty = mkdtempSync(join(tmpdir(), "zenith-empty-"));
    try {
      expect(() => listAutos(empty)).toThrow(/no zenith.json/);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("refuses a zenith.json whose autos directory escapes the project", () => {
    patchLink(root, (link) => {
      link["autosDir"] = "../elsewhere";
    });
    expect(() => listAutos(root)).toThrow(/outside the project root/);
  });
});

describe("ProjectWatcher", () => {
  function harness() {
    vi.useFakeTimers();
    let listener: (eventType: string, filename: string | null) => void = () => undefined;
    const files = new Map<string, string | null>();
    const changes: string[] = [];
    const fakeWatcher = { close: vi.fn(), on: vi.fn() };
    const watcher = new ProjectWatcher((change) => changes.push(change.path), {
      watchImpl: (_root, onEvent) => {
        listener = onEvent;
        return fakeWatcher as never;
      },
      readImpl: (full) => files.get(full.split("\\").join("/")) ?? null,
      debounceMs: 100,
    });
    watcher.watch(root, loadDesktopProject(root));
    const edit = (rel: string, text: string | null) => {
      files.set(join(root, rel).split("\\").join("/"), text);
      listener("change", rel.split("/").join(process.platform === "win32" ? "\\" : "/"));
    };
    return { watcher, edit, changes };
  }

  it("reports an external edit once, after the writes settle", () => {
    const { edit, changes } = harness();
    edit("autos/first-auto.auto.json", "{ \"a\": 1 }");
    edit("autos/first-auto.auto.json", "{ \"a\": 2 }");
    vi.advanceTimersByTime(99);
    expect(changes).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(changes).toEqual(["autos/first-auto.auto.json"]);
  });

  it("stays quiet about Zenith's own write", () => {
    const { watcher, edit, changes } = harness();
    watcher.note(root, "autos/first-auto.auto.json", "{ \"mine\": true }");
    edit("autos/first-auto.auto.json", "{ \"mine\": true }");
    vi.advanceTimersByTime(200);
    expect(changes).toEqual([]);
  });

  it("ignores files the editor does not read", () => {
    const { edit, changes } = harness();
    edit("TeamCode/build/sim/first-auto.trace.json", "{}");
    edit("autos/.renders/first-auto.svg", "<svg/>");
    edit("autos/robot.json", "{ \"changed\": true }");
    vi.advanceTimersByTime(200);
    expect(changes).toEqual(["autos/robot.json"]);
  });
});
