/**
 * The path for a browser with no File System Access API (Firefox, Safari): the user picks the
 * files with a plain `<input type="file">`, or a zip of them, and Save downloads the canonical text
 * instead of writing in place (site/docs/github.md).
 *
 * The zip reader is deliberately small: stored and deflated entries only, through the browser's own
 * DecompressionStream, so no dependency is added for it.
 */
import { loadField, loadLink, loadRobot, loadWaypoints } from "@horizon36596/zenith-core";
import { ProjectError } from "./local";
import type { Project } from "./types";

/** Saves text as a download, which is how a read-only project writes a file. */
export function downloadText(fileName: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
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

const baseName = (path: string): string => {
  const parts = path.split("/");
  return parts[parts.length - 1] ?? path;
};

/**
 * Builds a project from a set of files the user picked. Which file is which is decided by name:
 * `zenith.json`, `robot.json`, `waypoints.json`, `*.field.json` and `*.auto.json`.
 */
export async function projectFromFiles(files: readonly File[]): Promise<Project> {
  const texts = new Map<string, string>();
  for (const file of files) texts.set(baseName(file.name), await file.text());

  const linkText = texts.get("zenith.json");
  const robotText = texts.get("robot.json");
  const fieldName = [...texts.keys()].find((name) => name.endsWith(".field.json"));
  if (linkText === undefined) throw new ProjectError("Pick the repository's zenith.json too.");
  if (robotText === undefined) throw new ProjectError("Pick robot.json too.");
  if (fieldName === undefined) throw new ProjectError("Pick the season's *.field.json too.");

  const waypointsText = texts.get("waypoints.json");
  const autoTexts: Record<string, string> = {};
  for (const [name, text] of texts) {
    if (name.endsWith(".auto.json")) autoTexts[name] = text;
  }

  return {
    source: { kind: "files" },
    name: "Picked files",
    link: loadLink(JSON.parse(linkText)),
    robot: loadRobot(JSON.parse(robotText)),
    field: loadField(JSON.parse(texts.get(fieldName) as string)),
    waypoints: waypointsText === undefined ? undefined : loadWaypoints(JSON.parse(waypointsText)),
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
  const files: File[] = [];
  for (const [path, text] of entries) {
    files.push(new File([text], baseName(path), { type: "application/json" }));
  }
  const project = await projectFromFiles(files);
  return { ...project, name: file.name };
}
