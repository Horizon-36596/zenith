/**
 * Host mode's `ProjectBackend` (site/docs/host-protocol.md): a project another web app handed
 * over in an `open` message, held in memory, whose Save posts the canonical auto back to that app
 * and waits for its answer.
 *
 * The backend never touches `window`. It talks to the host through a `HostChannel`, which
 * `hostSession.ts` implements over `postMessage` with the pinned origin and the timeouts, so the
 * backend and the project it builds are unit-tested with a fake channel (`hostBackend.test.ts`).
 */
import {
  canonicalize,
  loadAuto,
  loadField,
  loadLink,
  loadRobot,
  loadWaypoints,
  mirrorForField,
  mirrorPose,
  newAutoFromTemplate,
  wrapAngle,
} from "@horizon36596/zenith-core";
import { FORMAT_VERSIONS, SCHEMA_ID, type Auto, type Field, type Heading, type Link, type Robot, type Waypoints } from "@horizon36596/zenith-schema";
import type { ProjectBackend, SaveResult } from "./backend";
import type { HostInfo } from "./hostOrigins";
import type { HostOpenMessage, HostStartPose, JsonDocument } from "./hostProtocol";
import { olderFormatOf } from "./formatVersion";
import { findLegalStart } from "./legalStart";
import { ProjectError } from "./local";
import type { LoadedAuto, Project } from "./types";

/** How the backend reaches the host. `hostSession.ts` is the real one. */
export interface HostChannel {
  /** Posts `save` and resolves when the host answers `saved` with `ok: true`; rejects otherwise. */
  save(hostName: string, text: string): Promise<void>;
}

/** The autos folder and the three file paths the synthesized `zenith.json` names. */
export const HOST_AUTOS_DIR = "autos";
export const HOST_ROBOT_PATH = "autos/robot.json";
export const HOST_FIELD_PATH = "autos/field.json";
export const HOST_WAYPOINTS_PATH = "autos/waypoints.json";

const AUTO_SUFFIX = ".auto.json";

/** The file name Zenith uses for a host's auto name: the name itself, with `.auto.json` if it lacks it. */
export const fileNameForHostAuto = (name: string): string =>
  name.endsWith(AUTO_SUFFIX) ? name : `${name}${AUTO_SUFFIX}`;

const parseDocument = (what: string, document: JsonDocument): unknown => {
  if (typeof document !== "string") return document;
  try {
    return JSON.parse(document) as unknown;
  } catch (error) {
    throw new ProjectError(`The ${what} is not valid JSON: ${(error as Error).message}`);
  }
};

/** Loads one of the host's files with a message that says which one failed. */
function loadDocument<T>(what: string, document: JsonDocument, load: (json: unknown) => T): T {
  const json = parseDocument(what, document);
  try {
    return load(json);
  } catch (error) {
    throw new ProjectError(`The ${what} is not a valid Zenith file: ${(error as Error).message}`);
  }
}

/**
 * The `zenith.json` a host project would have if it were a folder, so everything that reads
 * `project.link` (the auto paths, the overrides, the Simulate dialog) works unchanged. It names no
 * sim command, deploy target or codegen directory: in host mode those are the host's business.
 */
export function hostLink(withWaypoints: boolean): Link {
  return loadLink({
    $schema: SCHEMA_ID.link,
    formatVersion: FORMAT_VERSIONS.link,
    autosDir: HOST_AUTOS_DIR,
    robot: HOST_ROBOT_PATH,
    field: HOST_FIELD_PATH,
    ...(withWaypoints ? { waypoints: HOST_WAYPOINTS_PATH } : {}),
  });
}

export interface HostProjectBuild {
  project: Project;
  /** Zenith file name to the name the host used for it, so every message back uses the host's own. */
  hostNames: Map<string, string>;
  /** The file Zenith should open first, when the host named one it sent. */
  preferred: string | undefined;
}

/**
 * Turns an `open` message into a `Project`. The robot, field and waypoints are validated here, so a
 * bad file fails the open with a sentence naming it; the autos are parsed as each one is opened,
 * the same as a folder's.
 */
export function buildHostProject(message: HostOpenMessage, host: HostInfo): HostProjectBuild {
  const { project } = message;
  const robot: Robot = loadDocument("robot", project.robot, loadRobot);
  const field: Field = loadDocument("field", project.field, loadField);
  const waypoints: Waypoints | undefined =
    project.waypoints === undefined ? undefined : loadDocument("waypoints file", project.waypoints, loadWaypoints);

  const hostNames = new Map<string, string>();
  const autoTexts: Record<string, string> = {};
  for (const [name, text] of Object.entries(project.autos)) {
    const fileName = fileNameForHostAuto(name);
    if (hostNames.has(fileName)) {
      throw new ProjectError(`${host.displayName} sent two autos that both become ${fileName}.`);
    }
    hostNames.set(fileName, name);
    autoTexts[fileName] = text;
  }
  const opened = message.open === undefined ? undefined : fileNameForHostAuto(message.open);

  return {
    project: {
      source: { kind: "host", hostId: host.id },
      name: project.hostLabel ?? project.name,
      link: hostLink(waypoints !== undefined),
      robot,
      field,
      waypoints,
      autoFiles: Object.keys(autoTexts).sort((a, b) => a.localeCompare(b)),
      autoTexts,
    },
    hostNames,
    preferred: opened !== undefined && opened in autoTexts ? opened : undefined,
  };
}

/* ---- A new auto ------------------------------------------------------------ */

/** A name not yet used by any auto in the project: `new-auto`, then `new-auto-2`, and so on. */
export function freshAutoName(taken: readonly string[]): string {
  const names = new Set(taken.map((fileName) => fileName.replace(/\.auto\.json$/, "")));
  if (!names.has("new-auto")) return "new-auto";
  let index = 2;
  while (names.has(`new-auto-${String(index)}`)) index += 1;
  return `new-auto-${String(index)}`;
}

/** Four decimals, the canonical form's precision, so a host's start is written as it will be saved. */
const round4 = (value: number): number => Math.round(value * 1e4) / 1e4 || 0;

/**
 * Where a new auto starts. The start the host offered in its `open` (`newAutoStart`) wins: it is the
 * start the person picked there, mirrored onto the field's canonical alliance when the host's robot
 * plays the other one. Then a waypoint called `start`, then the first waypoint whose name says it is
 * a start. With none of those, the first pose touching a wall that the season's own start rule
 * accepts for the field's canonical alliance, the one a new host auto is written for
 * (`legalStart.ts`), so the auto opens with no START_ILLEGAL error. It is found, not measured, and
 * says so. Only when no such pose exists (no start rule, or none passes) does it fall back to the
 * field centre, marked as a placeholder to move.
 */
export function newAutoStart(project: Project, hostStart?: HostStartPose, hostName = "the host"): Auto["start"] {
  const names = Object.keys(project.waypoints?.waypoints ?? {});
  const named = names.includes("start") ? "start" : names.find((name) => /start/i.test(name));
  const holds = project.field.startRules?.holds;
  const alliance = project.field.frame.canonicalAlliance;
  if (hostStart !== undefined) {
    const mode = mirrorForField(project.field);
    const raw = { xIn: hostStart.xIn, yIn: hostStart.yIn, headingRad: wrapAngle(hostStart.headingRad) };
    const mirrored = hostStart.alliance !== alliance && mode !== "none" ? mirrorPose(raw, mode) : raw;
    const pose: Auto["start"]["pose"] = {
      xIn: round4(mirrored.xIn),
      yIn: round4(mirrored.yIn),
      headingRad: round4(wrapAngle(mirrored.headingRad ?? 0)),
      provenance:
        hostStart.alliance === alliance || mode === "none"
          ? `SET BY HAND: the start picked in ${hostName} when this auto was made`
          : `SET BY HAND: the ${hostStart.alliance} start picked in ${hostName} when this auto was made, mirrored for ${alliance}`,
    };
    return holds === undefined ? { pose } : { pose, holds: { ...holds } };
  }
  const legal = named === undefined ? findLegalStart(project.field, project.robot, alliance) : null;
  const pose: Auto["start"]["pose"] =
    named !== undefined
      ? { ref: named }
      : legal !== null
        ? {
            xIn: legal.xIn,
            yIn: legal.yIn,
            headingRad: legal.headingRad,
            provenance: `NEEDS MEASUREMENT: a legal ${alliance} start Zenith found touching the wall at ${legal.wall} from the field's startRules and this robot's footprint; drag it to where the robot really sets up`,
          }
        : {
            xIn: 0,
            yIn: 0,
            headingRad: 0,
            provenance: "PLACEHOLDER: a new auto starts at the field centre; drag the start to where the robot sets up",
          };
  return holds === undefined ? { pose } : { pose, holds: { ...holds } };
}

/** How far the new auto's one path drives straight out from its start. PLACEHOLDER, as in `zenith new`. */
export const NEW_AUTO_FIRST_PATH_IN = 24;

/**
 * The skeleton a new auto starts as (`newPathHeading` is the person's heading for a new path, so the
 * first path gets it rather than core's Tangent, issue #435): core's `newAutoFromTemplate`, the same one `zenith new` and the
 * MCP `newAutoFromTemplate` tool build, on the field's own alliance. Its one path drives
 * `NEW_AUTO_FIRST_PATH_IN` straight out the way the start faces, as `zenith new`'s does, so a
 * start against a wall does not open with a path that swings the robot through that wall.
 */
export function newHostAuto(
  project: Project,
  newPathHeading: (arrivalRad: number, endRad: number) => Heading,
  hostStart?: HostStartPose,
  hostName?: string,
): { fileName: string; auto: Auto } {
  const name = freshAutoName(project.autoFiles);
  const alliance = project.field.frame.canonicalAlliance;
  const start = newAutoStart(project, hostStart, hostName);
  const auto = newAutoFromTemplate(name, { alliance, start });
  const from = startPoseOf(start.pose, project.waypoints);
  const first = auto.steps[0];
  if (first?.kind !== "path" || first.segments.length !== 1 || first.segments[0] === undefined) {
    return { fileName: fileNameForHostAuto(name), auto };
  }
  if (from === null) {
    // A start with no heading faces 0, so the first path takes the person's heading for a new path from there.
    const path = { ...first, heading: newPathHeading(0, 0) };
    return { fileName: fileNameForHostAuto(name), auto: { ...auto, steps: [path, ...auto.steps.slice(1)] } };
  }
  const to = {
    xIn: Math.round((from.xIn + NEW_AUTO_FIRST_PATH_IN * Math.cos(from.headingRad)) * 100) / 100,
    yIn: Math.round((from.yIn + NEW_AUTO_FIRST_PATH_IN * Math.sin(from.headingRad)) * 100) / 100,
    provenance: `PLACEHOLDER: ${String(NEW_AUTO_FIRST_PATH_IN)} in straight out from the start`,
  };
  // The person's heading for a new path (issue #435): the robot leaves facing the way the start faces.
  const path = { ...first, segments: [{ ...first.segments[0], to }], heading: newPathHeading(from.headingRad, from.headingRad) };
  return { fileName: fileNameForHostAuto(name), auto: { ...auto, steps: [path, ...auto.steps.slice(1)] } };
}

/** The start pose as numbers: written out, or the waypoint it names; null when that is not known. */
function startPoseOf(pose: Auto["start"]["pose"], waypoints: Waypoints | undefined): { xIn: number; yIn: number; headingRad: number } | null {
  if ("ref" in pose) {
    const waypoint = waypoints?.waypoints[pose.ref];
    // A waypoint with no heading says nothing about which way is straight out.
    if (waypoint?.headingRad === undefined) return null;
    return { xIn: waypoint.xIn, yIn: waypoint.yIn, headingRad: waypoint.headingRad };
  }
  if (pose.headingRad === undefined) return null;
  return { xIn: pose.xIn, yIn: pose.yIn, headingRad: pose.headingRad };
}

/* ---- The backend ------------------------------------------------------------ */

export class HostBackend implements ProjectBackend {
  readonly kind = "host";
  readonly canPropose = false;
  private opened = false;
  /** Autos made in the editor that the host has not been sent yet. */
  private readonly unsent = new Set<string>();

  constructor(
    private readonly project: Project,
    private readonly hostNames: Map<string, string>,
    private readonly channel: HostChannel,
    private readonly hostDisplayName: string,
  ) {}

  /** The project as it stands now, with any auto made in the editor on its list. */
  current(): Project {
    return this.project;
  }

  async open(): Promise<Project> {
    this.opened = true;
    return this.project;
  }

  async listAutos(): Promise<string[]> {
    return this.project.autoFiles;
  }

  async readAuto(name: string): Promise<LoadedAuto> {
    const text = this.project.autoTexts[name];
    if (text === undefined) throw new ProjectError(`${name} is not one of the autos in this project.`);
    let json: unknown;
    try {
      json = JSON.parse(text) as unknown;
    } catch (error) {
      throw new ProjectError(`${name} is not valid JSON: ${(error as Error).message}`);
    }
    const auto: Auto = loadAuto(json);
    // An auto the host does not have yet opens as unsaved, so Save is still what sends it.
    return {
      fileName: name,
      auto,
      canonical: this.unsent.has(name) ? "" : canonicalize("auto", auto),
      ...olderFormatOf(json),
    };
  }

  /**
   * Posts the canonical text to the host and waits for its `saved`. Only once the host says it
   * kept it does the project's own copy change, so reopening the auto shows what the host has.
   */
  async save(name: string, text: string): Promise<SaveResult> {
    this.requireOpened();
    await this.channel.save(this.hostNameOf(name), text);
    this.remember(name, text);
    return { text, savedMessage: `Saved to ${this.hostDisplayName}.` };
  }

  /**
   * The robot and field the host sent are the only ones there are, so an auto whose own `robot` or
   * `field` names a `robot.json` or a `*.field.json` reads those (finding 23's overrides resolve
   * through here). Any other path is a file the host did not send.
   */
  async readText(path: string): Promise<string> {
    const base = path.slice(path.lastIndexOf("/") + 1);
    if (path === this.project.link.robot || base === "robot.json") return JSON.stringify(this.project.robot);
    if (path === this.project.link.field || base === "field.json" || base.endsWith(".field.json")) {
      return JSON.stringify(this.project.field);
    }
    if (this.project.waypoints !== undefined && (path === this.project.link.waypoints || base === "waypoints.json")) {
      return JSON.stringify(this.project.waypoints);
    }
    throw new ProjectError(`${path} is not a file this project has; the host sent one robot and one field.`);
  }

  /**
   * Adds an auto made in the editor to the project's list, so the picker and the palette show it.
   * It exists only here until Save sends it to the host.
   */
  addAuto(fileName: string, text: string, options: { unsent?: boolean } = {}): void {
    if (options.unsent === true) this.unsent.add(fileName);
    if (!this.project.autoFiles.includes(fileName)) {
      this.project.autoFiles.push(fileName);
      this.project.autoFiles.sort((a, b) => a.localeCompare(b));
    }
    this.project.autoTexts[fileName] = text;
  }

  /** The name the host knows this auto by; for one made in the editor, in the host's own style. */
  hostNameOf(fileName: string): string {
    const known = this.hostNames.get(fileName);
    if (known !== undefined) return known;
    const suffixed = [...this.hostNames.values()].some((name) => name.endsWith(AUTO_SUFFIX));
    return suffixed ? fileName : fileName.replace(/\.auto\.json$/, "");
  }

  /** The file a host's auto name refers to, whether it was sent with `.auto.json` or without. */
  fileNameOf(hostName: string): string {
    for (const [fileName, name] of this.hostNames) if (name === hostName) return fileName;
    return fileNameForHostAuto(hostName);
  }

  /** Whether this auto was made in the editor and has not been saved to the host yet. */
  isUnsent(fileName: string): boolean {
    return this.unsent.has(fileName);
  }

  private remember(fileName: string, text: string): void {
    this.unsent.delete(fileName);
    this.addAuto(fileName, text);
    if (!this.hostNames.has(fileName)) this.hostNames.set(fileName, this.hostNameOf(fileName));
  }

  private requireOpened(): void {
    if (!this.opened) throw new ProjectError("This project has not been opened yet.");
  }
}
