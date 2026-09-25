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
import type { Auto } from "@horizon36596/zenith-schema";
import type { ProjectBackend, SaveResult } from "./backend";
import { DESKTOP_API_VERSION, type DesktopProjectRef, type ZenithDesktopBridge } from "./desktopBridge";
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

const parse = (path: string, text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new ProjectError(`${path} is not valid JSON: ${(error as Error).message}`);
  }
};

/** Reads `zenith.json` and everything it names through the bridge, the way `loadProjectFromDirectory` does. */
export async function loadDesktopProject(bridge: ZenithDesktopBridge, ref: DesktopProjectRef): Promise<Project> {
  const read = async (path: string) => parse(path, await bridge.project.read(ref.root, path));
  const link = loadLink(await read("zenith.json"));
  const robot = loadRobot(await read(link.robot));
  const field = loadField(await read(link.field));
  const waypoints = link.waypoints === undefined ? undefined : loadWaypoints(await read(link.waypoints));
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

  constructor(
    private readonly bridge: ZenithDesktopBridge,
    readonly ref: DesktopProjectRef,
  ) {}

  get root(): string {
    return this.ref.root;
  }

  async open(): Promise<Project> {
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
    const auto: Auto = loadAuto(parse(path, await this.bridge.project.read(this.ref.root, path)));
    return { fileName: name, auto, canonical: canonicalize("auto", auto) };
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
