/**
 * The desktop project backend: local mode over the Zenith desktop app's bridge instead of the File
 * System Access API (site/docs/editor.md). The folder comes from the native picker,
 * reads and writes go through the main process (which confines every path to the folder the user
 * picked), and Save writes the canonical file in place.
 *
 * The web build picks this backend by itself when `window.zenithDesktop` exists; in a browser
 * `desktopBridge()` is null and nothing here runs.
 */
import { canonicalize, loadAuto, loadField, loadLink, loadRobot, loadWaypoints } from "@horizon36596/zenith-core";
import type { Auto, Robot, Waypoints } from "@horizon36596/zenith-schema";
import type { ProjectBackend, SaveResult } from "./backend";
import type { CommandLibrary } from "./commandLibrary";
import { DESKTOP_API_VERSION, type DesktopProjectRef, type ZenithDesktopBridge } from "./desktopBridge";
import { loadProjectJson, parseProjectJson } from "./fileErrors";
import { olderFormatOf } from "./formatVersion";
import { ProjectError } from "./local";
import type { LoadedAuto, Project } from "./types";

declare global {
  interface Window {
    zenithDesktop?: ZenithDesktopBridge;
  }
}

/** The bridge when this build runs inside the desktop app, and null in a browser. */
export function desktopBridge(): ZenithDesktopBridge | null {
  if (typeof window === "undefined") return null;
  const bridge = window.zenithDesktop;
  if (bridge === undefined || bridge.apiVersion !== DESKTOP_API_VERSION) return null;
  return bridge;
}

export const isDesktop = (): boolean => desktopBridge() !== null;

/**
 * Whether this desktop app can be told the menu's keys (`setMenuKeys`). An older one cannot, so its
 * menu keeps the default keys and Settings, Keyboard shows them read-only.
 */
export const canSetMenuKeys = (): boolean => typeof desktopBridge()?.setMenuKeys === "function";

const parse = parseProjectJson;

/** Reads `zenith.json` and everything it names through the bridge, the way `loadProjectFromDirectory` does. */
export async function loadDesktopProject(bridge: ZenithDesktopBridge, ref: DesktopProjectRef): Promise<Project> {
  const read = async (path: string) => parse(path, await bridge.project.read(ref.root, path));
  const link = loadProjectJson("link", "zenith.json", await read("zenith.json"), loadLink);
  const robot = loadProjectJson("robot", link.robot, await read(link.robot), loadRobot);
  const field = loadProjectJson("field", link.field, await read(link.field), loadField);
  const waypoints =
    link.waypoints === undefined ? undefined : loadProjectJson("waypoints", link.waypoints, await read(link.waypoints), loadWaypoints);
  return {
    source: { kind: "desktop", root: ref.root },
    name: ref.name,
    link,
    robot,
    field,
    waypoints,
    autoFiles: await bridge.project.listAutos(ref.root),
    autoTexts: {},
  };
}

export class DesktopBackend implements ProjectBackend {
  /** Local mode in the 06 sense: the files are on this computer and Save writes them in place. */
  readonly kind = "local";
  /** The web build's Propose is GitHub mode's; the desktop app opens pull requests from its own git panel. */
  readonly canPropose = false;
  private project: Project | null = null;
  /** Present only when the desktop build can set the command library; an older one cannot. */
  readonly setCommandLibrary?: (library: CommandLibrary) => Promise<string>;
  /** Present only when the desktop build can write robot.json; an older one cannot. */
  readonly writeRobot?: (robot: Robot) => Promise<string>;
  /** Present only when the desktop build can write waypoints.json; an older one cannot (issue #134). */
  readonly writeWaypoints?: (waypoints: Waypoints) => Promise<string>;
  /** Present only when the desktop build can list a project's presets; an older one cannot (spec 15 section 6.5). */
  readonly listPresetFiles?: () => Promise<string[]>;
  /** Present only when the desktop build can add a preset to a project; an older one cannot. */
  readonly writePresetFile?: (fileName: string, text: string) => Promise<void>;

  constructor(
    private readonly bridge: ZenithDesktopBridge,
    readonly ref: DesktopProjectRef,
  ) {
    const set = bridge.project.setCommandLibrary;
    if (set !== undefined) {
      this.setCommandLibrary = (library: CommandLibrary) => set(ref.root, library);
    }
    // The robot crosses as an object; the main process validates it and picks the file (main/project.ts).
    const writeRobot = bridge.project.writeRobot;
    if (writeRobot !== undefined) {
      this.writeRobot = (robot: Robot) => writeRobot(ref.root, robot);
    }
    // So do the waypoints: an object across the bridge, and main writes only the file zenith.json names.
    const writeWaypoints = bridge.project.writeWaypoints;
    if (writeWaypoints !== undefined) {
      this.writeWaypoints = (waypoints: Waypoints) => writeWaypoints(ref.root, waypoints);
    }
    // Preset files cross as a bare name and text; main checks both and writes only in the presets folder.
    const listPresets = bridge.project.listPresets;
    if (listPresets !== undefined) {
      this.listPresetFiles = () => listPresets(ref.root);
    }
    const writePreset = bridge.project.writePreset;
    if (writePreset !== undefined) {
      this.writePresetFile = (fileName: string, text: string) => writePreset(ref.root, fileName, text);
    }
  }

  get root(): string {
    return this.ref.root;
  }

  /**
   * Hands this backend a project already read from the same folder, so its next `open` returns it
   * at once instead of reading again. A reload after a change on disk reads first, checks nothing
   * changed meanwhile, then opens what it read (issue #394). The folder is already watched.
   */
  withProject(project: Project): this {
    this.preread = project;
    return this;
  }

  private preread: Project | null = null;

  async open(): Promise<Project> {
    const preread = this.preread;
    if (preread !== null) {
      this.preread = null;
      this.project = preread;
      return preread;
    }
    const project = await loadDesktopProject(this.bridge, this.ref);
    this.project = project;
    await this.bridge.project.watch(this.ref.root);
    return project;
  }

  async listAutos(): Promise<string[]> {
    const files = await this.bridge.project.listAutos(this.ref.root);
    if (this.project !== null) this.project.autoFiles = files;
    return files;
  }

  async readAuto(name: string): Promise<LoadedAuto> {
    const path = `${this.opened().link.autosDir}/${name}`;
    const json: unknown = parse(path, await this.bridge.project.read(this.ref.root, path));
    const auto: Auto = loadProjectJson("auto", path, json, loadAuto);
    return { fileName: name, auto, canonical: canonicalize("auto", auto), ...olderFormatOf(json) };
  }

  /**
   * Whether the auto file is in the folder now (issue #380). The desktop app's own check reads only
   * `zenith.json` and the autos folder, so a robot that does not load cannot refuse it; an older
   * build's `listAutos` is the fallback. Either way case is ignored, as Windows and macOS disks
   * ignore it, and a failure to look throws rather than answering "not there", so a file that is
   * there is never written over.
   */
  async hasAuto(name: string): Promise<boolean> {
    const path = `${this.opened().link.autosDir}/${name}`;
    try {
      const check = this.bridge.project.hasAuto;
      if (check !== undefined) return await check(this.ref.root, name);
      const wanted = name.toLowerCase();
      return (await this.bridge.project.listAutos(this.ref.root)).some((file) => file.toLowerCase() === wanted);
    } catch (error) {
      throw new ProjectError(`Could not tell whether ${path} is in this folder: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async save(name: string, text: string): Promise<SaveResult> {
    this.opened();
    await this.bridge.project.writeAuto(this.ref.root, name, text);
    return { text };
  }

  async readText(path: string): Promise<string> {
    return this.bridge.project.read(this.ref.root, path);
  }

  private opened(): Project {
    if (this.project === null) throw new ProjectError("This project has not been opened yet.");
    return this.project;
  }
}
