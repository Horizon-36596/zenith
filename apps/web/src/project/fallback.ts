/**
 * The path for a browser with no File System Access API (Firefox, Safari): the user picks the
 * files with a plain `<input type="file">`, or a zip of them, and Save downloads the canonical text
 * instead of writing in place (site/docs/github.md).
 *
 * The zip reader is deliberately small: stored and deflated entries only, through the browser's own
 * DecompressionStream, so no dependency is added for it.
 */
import { loadField, loadLink, loadRobot, loadWaypoints } from "@horizon36596/zenith-core";
import { desktopBridge } from "./desktop";
import { loadProjectFile, loadProjectJson, parseProjectJson } from "./fileErrors";
import { ProjectError } from "./local";
import { LoneAutoError, onlyAutos, projectPath } from "./projectFiles";
import type { Project } from "./types";

/** Saves text as a download, which is how a read-only project writes a file. */
export function downloadText(fileName: string, text: string): void {
  downloadBlob(fileName, new Blob([text], { type: "application/json" }));
}

/** Saves a blob as a download through an anchor, which the browser and the desktop app both honour. */
export function downloadBlob(fileName: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = "noopener";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // Revoking immediately cancels the download in some browsers, so let the task queue drain first.
  window.setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 0);
}

/** How `saveFileAs` saved a file: through the desktop app's Save As dialog, or as a download. */
export interface SavedFile {
  name: string;
  how: "saved" | "downloaded";
}

/**
 * Saves a file the person asked for, a copy of the auto or a picture of it. In the desktop app it
 * goes through the native Save As dialog and resolves with the name it was saved under once it is
 * written, or null when the dialog was cancelled: a plain download there opens the desktop app's own
 * dialog, which tells the page nothing, so a cancel would read as a download. In a browser, or a
 * desktop build without the dialog, it downloads, and the browser has the last word.
 */
export async function saveFileAs(fileName: string, data: string | Blob, type = "application/json"): Promise<SavedFile | null> {
  const save = desktopBridge()?.saveFile;
  if (save === undefined) {
    downloadBlob(fileName, typeof data === "string" ? new Blob([data], { type }) : data);
    return { name: fileName, how: "downloaded" };
  }
  const body = typeof data === "string" ? data : new Uint8Array(await data.arrayBuffer());
  const name = await save(fileName, body);
  return name === null ? null : { name, how: "saved" };
}

const baseName = (path: string): string => {
  const parts = path.split("/");
  return parts[parts.length - 1] ?? path;
};

/**
 * What a set of picked files lacks to be a project, or null when it has the three files every project
 * needs. It names every missing file at once, so picking one auto file says that robot.json and a
 * field are needed as well as zenith.json.
 */
export function missingProjectFiles(hasLink: boolean, hasRobot: boolean, hasField: boolean): string | null {
  const missing = [
    hasLink ? null : "zenith.json",
    hasRobot ? null : "robot.json",
    hasField ? null : "the season's *.field.json",
  ].filter((name): name is string => name !== null);
  if (missing.length === 0) return null;
  const list =
    missing.length === 1
      ? (missing[0] as string)
      : `${missing.slice(0, -1).join(", ")} and ${missing[missing.length - 1] as string}`;
  return `A project needs zenith.json, robot.json and the season's *.field.json, picked together with the autos. Pick ${list} too.`;
}

/**
 * Builds a project from a set of files the user picked. Which file is which is decided by name:
 * `zenith.json`, `robot.json`, `waypoints.json`, `*.field.json` and `*.auto.json`.
 */
export async function projectFromFiles(files: readonly File[]): Promise<Project> {
  const texts = new Map<string, string>();
  for (const file of files) texts.set(baseName(file.name), await file.text());
  // An auto on its own gets the message that offers the example's robot and field (issue #103).
  if (onlyAutos([...texts.keys()])) throw new LoneAutoError(Object.fromEntries(texts));

  const linkText = texts.get("zenith.json");
  const robotText = texts.get("robot.json");
  const fieldName = [...texts.keys()].find((name) => name.endsWith(".field.json"));
  if (linkText === undefined || robotText === undefined || fieldName === undefined) {
    throw new ProjectError(
      missingProjectFiles(linkText !== undefined, robotText !== undefined, fieldName !== undefined) ?? "",
    );
  }

  const waypointsText = texts.get("waypoints.json");
  const autoTexts: Record<string, string> = {};
  for (const [name, text] of texts) {
    if (name.endsWith(".auto.json")) autoTexts[name] = text;
  }

  return {
    source: { kind: "files" },
    name: "Picked files",
    link: loadProjectFile("link", "zenith.json", linkText, loadLink),
    robot: loadProjectFile("robot", "robot.json", robotText, loadRobot),
    field: loadProjectFile("field", fieldName, texts.get(fieldName) as string, loadField),
    waypoints: waypointsText === undefined ? undefined : loadProjectFile("waypoints", "waypoints.json", waypointsText, loadWaypoints),
    autoFiles: Object.keys(autoTexts).sort((a, b) => a.localeCompare(b)),
    autoTexts,
  };
}

/* ---- Zip ---------------------------------------------------------------- */

const SIGNATURE_LOCAL = 0x04034b50;

/** Unpacks the stored and deflated entries of a zip into `path -> text`. */
export async function unzipText(buffer: ArrayBuffer): Promise<Map<string, string>> {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const out = new Map<string, string>();
  const decoder = new TextDecoder();
  let at = 0;

  while (at + 30 <= view.byteLength && view.getUint32(at, true) === SIGNATURE_LOCAL) {
    const method = view.getUint16(at + 8, true);
    const flags = view.getUint16(at + 6, true);
    const compressedSize = view.getUint32(at + 18, true);
    const nameLength = view.getUint16(at + 26, true);
    const extraLength = view.getUint16(at + 28, true);
    const nameAt = at + 30;
    const dataAt = nameAt + nameLength + extraLength;
    const name = decoder.decode(bytes.subarray(nameAt, nameAt + nameLength));
    if ((flags & 0x08) !== 0) {
      throw new ProjectError("This zip uses streamed entries, which the editor cannot read.");
    }
    const data = bytes.subarray(dataAt, dataAt + compressedSize);
    if (!name.endsWith("/")) {
      if (method === 0) {
        out.set(name, decoder.decode(data));
      } else if (method === 8) {
        const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
        out.set(name, await new Response(stream).text());
      } else {
        throw new ProjectError(`${name} uses an unsupported compression method.`);
      }
    }
    at = dataAt + compressedSize;
  }

  if (out.size === 0) throw new ProjectError("No files were found in that zip.");
  return out;
}

export async function projectFromZip(file: File): Promise<Project> {
  const entries = await unzipText(await file.arrayBuffer());
  const project = await projectFromZipEntries(entries);
  return { ...project, name: file.name };
}

const depth = (path: string): number => path.split("/").length;

/**
 * Builds a project from a zip's `path -> text` entries. With a `zenith.json` in the zip, the
 * shallowest one is the project root and every file it names is read from its full path under that
 * root, so a backup `robot.json` elsewhere in a whole-repository zip is never picked up and a robot
 * file with another name still loads. A zip without one is matched by file name, as picked files
 * are, and two files of one name are refused rather than one of them kept.
 */
export async function projectFromZipEntries(entries: ReadonlyMap<string, string>): Promise<Project> {
  const links = [...entries.keys()].filter((path) => baseName(path) === "zenith.json");
  if (links.length === 0) {
    const files: File[] = [];
    const seen = new Set<string>();
    for (const [path, text] of entries) {
      const name = baseName(path);
      if (seen.has(name)) throw new ProjectError(`The zip has more than one ${name}, so Zenith cannot tell which to use.`);
      seen.add(name);
      files.push(new File([text], name, { type: "application/json" }));
    }
    return projectFromFiles(files);
  }

  const top = Math.min(...links.map(depth));
  const roots = links.filter((path) => depth(path) === top);
  if (roots.length > 1) {
    throw new ProjectError(`The zip has more than one zenith.json (${roots.join(", ")}), so Zenith cannot tell which project to open.`);
  }
  const linkPath = roots[0] as string;
  const prefix = linkPath.slice(0, linkPath.length - "zenith.json".length);
  const link = loadProjectFile("link", linkPath, entries.get(linkPath) as string, loadLink);
  const named = (path: string): { full: string; json: unknown } => {
    const full = `${prefix}${projectPath(path)}`;
    const text = entries.get(full);
    if (text === undefined) throw new ProjectError(`zenith.json names ${path}, which is not in the zip at ${full}.`);
    return { full, json: parseProjectJson(full, text) };
  };
  const load = <T>(kind: "robot" | "field" | "waypoints", path: string, loader: (json: unknown) => T): T => {
    const { full, json } = named(path);
    return loadProjectJson(kind, full, json, loader);
  };

  const autosDir = `${prefix}${projectPath(link.autosDir)}/`;
  const autoTexts: Record<string, string> = {};
  for (const [path, text] of entries) {
    const name = path.slice(autosDir.length);
    if (path.startsWith(autosDir) && !name.includes("/") && name.endsWith(".auto.json")) autoTexts[name] = text;
  }

  return {
    source: { kind: "files" },
    name: "Picked files",
    link,
    robot: load("robot", link.robot, loadRobot),
    field: load("field", link.field, loadField),
    waypoints: link.waypoints === undefined ? undefined : load("waypoints", link.waypoints, loadWaypoints),
    autoFiles: Object.keys(autoTexts).sort((a, b) => a.localeCompare(b)),
    autoTexts,
  };
}
