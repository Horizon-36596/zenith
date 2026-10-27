/**
 * Save a copy of an auto that cannot be saved in place: the bundled example, or files opened on
 * their own (sweep D4). In a browser their Save is a download, but a download cannot hold the
 * window's close: the close was approved before any Save As dialog could be answered, and the
 * edits could be lost. So the desktop app asks for the file itself, through the native Save As
 * dialog, and resolves only once the copy is written, or with null when the person cancelled.
 *
 * Kept free of Electron so the decisions can be tested without a window: index.ts and ipc.ts pass in
 * the dialog and the write.
 */
import { basename, join } from "node:path";
import { BridgeError } from "./confine.js";

/** An auto is a few kilobytes; anything near this is not one, and is refused rather than written. */
export const COPY_LIMIT_BYTES = 8 * 1024 * 1024;

export interface SaveCopyDeps {
  /** Shows the Save As dialog at `defaultPath`; the chosen path, or null when it was cancelled. */
  ask: (defaultPath: string) => Promise<string | null>;
  write: (path: string, text: string) => void;
  /** The folder the dialog starts in: the person's Documents. */
  folder: string;
}

/**
 * The name the dialog suggests: the auto's own file name with any folder part dropped, so a page
 * cannot aim the dialog somewhere else, and `untitled.auto.json` when nothing usable is left.
 */
export function suggestedCopyName(name: unknown): string {
  const text = typeof name === "string" ? name : "";
  const bare = basename(text.replace(/\\/g, "/")).replace(/[<>:"|?*\u0000-\u001f]/g, "").trim();
  if (bare === "" || bare === "." || bare === "..") return "untitled.auto.json";
  return bare.endsWith(".json") ? bare : `${bare}.auto.json`;
}

/** Asks where to save, writes the text there, and resolves with the file's name, or null on cancel. */
export async function saveCopy(deps: SaveCopyDeps, name: unknown, text: unknown): Promise<string | null> {
  if (typeof text !== "string") throw new BridgeError("There was nothing to save.");
  if (Buffer.byteLength(text, "utf8") > COPY_LIMIT_BYTES) {
    throw new BridgeError("That is too large to be an auto, so it was not saved.");
  }
  const picked = await deps.ask(join(deps.folder, suggestedCopyName(name)));
  if (picked === null || picked === "") return null;
  try {
    deps.write(picked, text);
  } catch (error) {
    const reason = error instanceof Error && error.message !== "" ? ` ${error.message}` : "";
    throw new BridgeError(`The copy could not be written to ${basename(picked)}.${reason}`);
  }
  return basename(picked);
}

/** The files the page may save through `saveFile`, by extension: what the Save As dialog offers. */
export const SAVE_FILE_KINDS: Record<string, { name: string; extensions: string[] }> = {
  json: { name: "Zenith auto", extensions: ["json"] },
  png: { name: "PNG picture", extensions: ["png"] },
  svg: { name: "SVG picture", extensions: ["svg"] },
};

export interface SaveFileDeps {
  /** Shows the Save As dialog at `defaultPath` with one filter; the chosen path, or null when cancelled. */
  ask: (defaultPath: string, filter: { name: string; extensions: string[] }) => Promise<string | null>;
  write: (path: string, data: string | Uint8Array) => void;
  /** The folder the dialog starts in: the person's Documents. */
  folder: string;
}

/**
 * Saves a file the page made (a copy of the auto, or a picture of it), through the native Save As
 * dialog, and resolves with the saved file's name, or null when the person cancelled. Only the kinds
 * in `SAVE_FILE_KINDS` are saved, under a bare name the page cannot aim elsewhere.
 */
export async function saveFile(deps: SaveFileDeps, name: unknown, data: unknown): Promise<string | null> {
  const text = typeof data === "string";
  if (!text && !(data instanceof Uint8Array)) throw new BridgeError("There was nothing to save.");
  const size = text ? Buffer.byteLength(data, "utf8") : data.byteLength;
  if (size > COPY_LIMIT_BYTES) throw new BridgeError("That file is too large, so it was not saved.");
  const raw = typeof name === "string" ? name : "";
  const bare = basename(raw.replace(/\\/g, "/")).replace(/[<>:"|?*\u0000-\u001f]/g, "").trim();
  const extension = /\.([a-z]+)$/i.exec(bare)?.[1]?.toLowerCase() ?? "";
  // Own keys only: `x.constructor` must not find the object's inherited `constructor`.
  const kind = Object.hasOwn(SAVE_FILE_KINDS, extension) ? SAVE_FILE_KINDS[extension] : undefined;
  if (kind === undefined || bare.startsWith(".")) throw new BridgeError("Zenith saves only autos and pictures of them here.");
  const picked = await deps.ask(join(deps.folder, bare), kind);
  if (picked === null || picked === "") return null;
  try {
    deps.write(picked, data);
  } catch (error) {
    const reason = error instanceof Error && error.message !== "" ? ` ${error.message}` : "";
    throw new BridgeError(`${basename(picked)} could not be written.${reason}`);
  }
  return basename(picked);
}
