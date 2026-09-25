import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import type { RenderOptions } from "@horizon36596/zenith-core";
import type { Field } from "@horizon36596/zenith-schema";
import { confinePath, type Project } from "./project.js";

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".webp": "image/webp",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
};

/**
 * The stored size of a PNG or WebP image in pixels, read from its header, or null for any other
 * format or a header this does not recognise. Only a `pxBoundsIn` crop needs it.
 */
export function imageSizePx(bytes: Uint8Array): { widthPx: number; heightPx: number } | null {
  const ascii = (from: number, length: number): string =>
    String.fromCharCode(...bytes.subarray(from, from + length));
  const u16le = (at: number): number => (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8);
  const u24le = (at: number): number => u16le(at) | ((bytes[at + 2] ?? 0) << 16);
  const u32be = (at: number): number =>
    (((bytes[at] ?? 0) << 24) | ((bytes[at + 1] ?? 0) << 16) | ((bytes[at + 2] ?? 0) << 8) | (bytes[at + 3] ?? 0)) >>> 0;

  if (ascii(1, 3) === "PNG" && ascii(12, 4) === "IHDR") {
    return { widthPx: u32be(16), heightPx: u32be(20) };
  }
  if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") {
    const chunk = ascii(12, 4);
    if (chunk === "VP8X") return { widthPx: u24le(24) + 1, heightPx: u24le(27) + 1 };
    if (chunk === "VP8 ") return { widthPx: u16le(26) & 0x3fff, heightPx: u16le(28) & 0x3fff };
    if (chunk === "VP8L") {
      const bits = (bytes[21] ?? 0) | ((bytes[22] ?? 0) << 8) | ((bytes[23] ?? 0) << 16) | ((bytes[24] ?? 0) << 24);
      return { widthPx: (bits & 0x3fff) + 1, heightPx: ((bits >>> 14) & 0x3fff) + 1 };
    }
  }
  return null;
}

/**
 * The picture `field.image` names, read for `core.render`, when it is a file inside the project:
 * `src` relative to the field file. An `app:` image ships with the editor rather than the robot
 * repository, and a missing file is not an error, so both give `undefined` and the render falls
 * back to vector (site/docs/editor.md).
 */
export function fieldImageFor(
  project: Project,
  field: Field,
  fieldPath: string,
): RenderOptions["fieldImage"] | undefined {
  const src = field.image?.src;
  if (src === undefined || src.startsWith("app:")) return undefined;
  let full: string;
  try {
    full = confinePath(project.root, join(dirname(fieldPath), src));
  } catch {
    return undefined;
  }
  const mime = MIME[extname(full).toLowerCase()];
  if (mime === undefined || !existsSync(full)) return undefined;
  const bytes = readFileSync(full);
  const size = imageSizePx(bytes);
  return {
    href: `data:${mime};base64,${bytes.toString("base64")}`,
    ...(size === null ? {} : size),
  };
}
