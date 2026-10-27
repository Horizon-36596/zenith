import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AUTO_SWITCH, OPEN_SWITCH, findDesktopApp, planDesktopOpen, type DesktopAppEnv } from "../desktopApp.js";
import { makeProject, simpleAuto, writeAuto } from "../testSupport.js";
import { runOpen } from "./open.js";

let root = "";
let out: string[] = [];
let err: string[] = [];

const APP = "C:\\Team\\Local\\Programs\\Zenith\\Zenith.exe";

/** A Windows computer with the app installed for this user, the installer's default. */
const installed = (extra: (path: string) => boolean = () => false): DesktopAppEnv => ({
  env: { LOCALAPPDATA: "C:\\Team\\Local", ProgramFiles: "C:\\Program Files" },
  platform: "win32",
  exists: (path) => path === APP || existsSync(path) || extra(path),
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "zenith-open-"));
  makeProject(root);
  writeAuto(root, "autos", "demo", simpleAuto("demo"));
  out = [];
  err = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    out.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    err.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe("finding the desktop app", () => {
  it("finds the per-user install, then the machine-wide one", () => {
    expect(findDesktopApp(installed())).toBe(APP);
    const machine = "C:\\Program Files\\Zenith\\Zenith.exe";
    expect(findDesktopApp({ ...installed(), exists: (path) => path === machine })).toBe(machine);
  });

  it("takes ZENITH_DESKTOP first, and says so when it names nothing", () => {
    const named = "D:\\Apps\\Zenith\\Zenith.exe";
    expect(findDesktopApp({ env: { ZENITH_DESKTOP: named }, platform: "linux", exists: (path) => path === named })).toBe(named);
    expect(() => findDesktopApp({ env: { ZENITH_DESKTOP: named }, platform: "win32", exists: () => false })).toThrow(/no file there/);
  });

  it("finds nothing where it is not installed, or off Windows", () => {
    expect(findDesktopApp({ ...installed(), exists: () => false })).toBeNull();
    expect(findDesktopApp({ env: {}, platform: "darwin", exists: () => true })).toBeNull();
  });
});

describe("zenith open", () => {
  it("starts the app with the project folder and the auto, found from a folder inside the project", async () => {
    mkdirSync(join(root, "autos", "notes"), { recursive: true });
    const launch = vi.fn(async () => undefined);
    const code = await runOpen("autos/notes", { cwd: root, auto: "demo", json: true, host: installed(), launch });
    expect(code).toBe(0);
    expect(launch).toHaveBeenCalledWith(APP, [`${OPEN_SWITCH}${root}`, `${AUTO_SWITCH}demo.auto.json`]);
    expect(JSON.parse(out.join(""))).toEqual({ opened: true, root, auto: "demo.auto.json", app: APP });
  });

  it("opens the working directory's project with no arguments, and says so in a sentence", async () => {
    const launch = vi.fn(async () => undefined);
    expect(await runOpen(undefined, { cwd: root, host: installed(), launch })).toBe(0);
    expect(launch).toHaveBeenCalledWith(APP, [`${OPEN_SWITCH}${root}`]);
    expect(out.join("")).toContain(`Opened ${root} in the Zenith desktop app.`);
  });

  it("says plainly when the desktop app is not installed, and starts nothing", async () => {
    const launch = vi.fn(async () => undefined);
    const code = await runOpen(undefined, { cwd: root, host: { ...installed(), exists: existsSync }, launch });
    expect(code).toBe(2);
    expect(launch).not.toHaveBeenCalled();
    expect(err.join("")).toMatch(/desktop app is not installed on this computer/);
    expect(err.join("")).toContain("ZENITH_DESKTOP");
  });

  it("refuses a folder with no project, an auto that is not there, and a name that is not one", async () => {
    const launch = vi.fn(async () => undefined);
    const empty = mkdtempSync(join(tmpdir(), "zenith-open-empty-"));
    try {
      expect(await runOpen(empty, { cwd: root, json: true, host: installed(), launch })).toBe(2);
      expect((JSON.parse(out.join("")) as { opened: boolean; error: string }).error).toMatch(/zenith\.json/);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
    expect(await runOpen(undefined, { cwd: root, auto: "missing", host: installed(), launch })).toBe(2);
    expect(err.join("")).toMatch(/no auto called missing/);
    expect(() => planDesktopOpen({ cwd: root, auto: "../../escape" }, installed())).toThrow(/not an auto name/);
    expect(launch).not.toHaveBeenCalled();
  });
});
