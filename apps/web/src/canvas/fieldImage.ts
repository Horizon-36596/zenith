/**
 * The field image layer (site/docs/editor.md, site/docs/file-format.md `image`).
 *
 * `field.image` maps a box of the picture's pixels onto the field perimeter: `pxBoundsIn` is that box
 * in image pixels (x right, y down from the top-left corner), or `"fullBleed"` for the whole image,
 * and `rotationDeg` turns the picture clockwise, as it is viewed, before the box is laid on the
 * field. "As it is viewed" means the Zenith frame drawn with the audience at the bottom: +X to the
 * audience's right and +Y away from them, so an unrotated image's top edge is the far (+Y) wall and
 * its right edge is the +X wall.
 *
 * The mapping from image pixels to field inches is affine, and so is `view.ts`'s field-to-screen
 * transform, so the canvas composes the two into one `setTransform` and lets `drawImage` do the
 * rest. Everything here is arithmetic, unit-tested without a canvas.
 */
import type { Box2, Vec2 } from "@horizon36596/zenith-core";
import type { Field } from "@horizon36596/zenith-schema";

export type Rotation = 0 | 90 | 180 | 270;

/** One named look of the same picture (`field.image.variants`), such as dark, black or light. */
export interface FieldImageVariant {
  name: string;
  src: string;
}

/** The parts of `field.image` the canvas reads, validated loosely so a bad file never throws. */
export interface FieldImageSpec {
  src: string;
  credit: string | null;
  pxBounds: "fullBleed" | { left: number; top: number; right: number; bottom: number };
  rotationDeg: Rotation;
  /** Every named look, in file order; empty when the file names none. */
  variants: FieldImageVariant[];
}

const isRotation = (value: unknown): value is Rotation =>
  value === 0 || value === 90 || value === 180 || value === 270;

export function readFieldImage(field: Field): FieldImageSpec | null {
  const image = (field as { image?: unknown }).image;
  if (typeof image !== "object" || image === null) return null;
  const record = image as Record<string, unknown>;
  const src = record["src"];
  if (typeof src !== "string" || src === "") return null;
  const credit = typeof record["credit"] === "string" ? record["credit"] : null;
  const rotation = record["rotationDeg"] ?? 0;
  const raw = record["pxBoundsIn"];
  let pxBounds: FieldImageSpec["pxBounds"] = "fullBleed";
  if (typeof raw === "object" && raw !== null) {
    const box = raw as Record<string, unknown>;
    const left = box["left"];
    const top = box["top"];
    const right = box["right"];
    const bottom = box["bottom"];
    if (
      typeof left !== "number" ||
      typeof top !== "number" ||
      typeof right !== "number" ||
      typeof bottom !== "number" ||
      !(right > left) ||
      !(bottom > top)
    ) {
      return null;
    }
    pxBounds = { left, top, right, bottom };
  } else if (raw !== "fullBleed" && raw !== undefined) {
    return null;
  }
  const variants: FieldImageVariant[] = [];
  if (Array.isArray(record["variants"])) {
    for (const entry of record["variants"] as unknown[]) {
      if (typeof entry !== "object" || entry === null) continue;
      const variant = entry as Record<string, unknown>;
      const name = variant["name"];
      const variantSrc = variant["src"];
      if (typeof name === "string" && name !== "" && typeof variantSrc === "string" && variantSrc !== "") {
        variants.push({ name, src: variantSrc });
      }
    }
  }
  return { src, credit, pxBounds, rotationDeg: isRotation(rotation) ? rotation : 0, variants };
}

/**
 * The source the canvas draws: the named variant when there is one by that name, else `src`
 * (site/docs/file-format.md: `src` is the picture drawn when nothing else is chosen).
 */
export function chooseImageSource(spec: FieldImageSpec, variant: string | null | undefined): string {
  if (variant === null || variant === undefined) return spec.src;
  return spec.variants.find((candidate) => candidate.name === variant)?.src ?? spec.src;
}

/**
 * A `field.image` source as a URL the browser can load. `app:<path>` is an asset the app ships,
 * resolved against the app's public root (`baseUrl`, Vite's `BASE_URL`). Any other value is a path
 * relative to the field file, which only the shell can resolve; it is returned unchanged, and the
 * shell passes the resolved URL as `fieldImageSrc`.
 */
export function resolveImageUrl(src: string, baseUrl = "/"): string {
  if (!src.startsWith("app:")) return src;
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return `${base}${src.slice("app:".length).replace(/^\/+/, "")}`;
}

/** The pixel box of the perimeter inside an image of the given natural size. */
export function pixelBox(
  spec: FieldImageSpec,
  widthPx: number,
  heightPx: number,
): { left: number; top: number; right: number; bottom: number } {
  return spec.pxBounds === "fullBleed" ? { left: 0, top: 0, right: widthPx, bottom: heightPx } : spec.pxBounds;
}

/**
 * Where the pixel box's top-left, top-right and bottom-left corners land on the field, for a
 * clockwise turn of the picture. Turning clockwise by 90 puts the picture's top edge on the +X wall.
 */
export function cornersOnField(bounds: Box2, rotationDeg: Rotation): { tl: Vec2; tr: Vec2; bl: Vec2 } {
  const nw = { xIn: bounds.minXIn, yIn: bounds.maxYIn };
  const ne = { xIn: bounds.maxXIn, yIn: bounds.maxYIn };
  const se = { xIn: bounds.maxXIn, yIn: bounds.minYIn };
  const sw = { xIn: bounds.minXIn, yIn: bounds.minYIn };
  switch (rotationDeg) {
    case 0:
      return { tl: nw, tr: ne, bl: sw };
    case 90:
      return { tl: ne, tr: se, bl: nw };
    case 180:
      return { tl: se, tr: sw, bl: ne };
    case 270:
      return { tl: sw, tr: nw, bl: se };
  }
}

/** A 2D affine map, in the order `CanvasRenderingContext2D.setTransform(a, b, c, d, e, f)` takes. */
export interface Affine {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

export const applyAffine = (m: Affine, x: number, y: number): { x: number; y: number } => ({
  x: m.a * x + m.c * y + m.e,
  y: m.b * x + m.d * y + m.f,
});

/**
 * The affine map that takes an axis-aligned source box (by its top-left, top-right and bottom-left
 * corners) onto three destination points. Source x runs left to right and y top to bottom.
 */
export function affineFromBox(
  box: { left: number; top: number; right: number; bottom: number },
  tl: { x: number; y: number },
  tr: { x: number; y: number },
  bl: { x: number; y: number },
): Affine {
  const width = box.right - box.left;
  const height = box.bottom - box.top;
  const a = (tr.x - tl.x) / width;
  const b = (tr.y - tl.y) / width;
  const c = (bl.x - tl.x) / height;
  const d = (bl.y - tl.y) / height;
  return { a, b, c, d, e: tl.x - a * box.left - c * box.top, f: tl.y - b * box.left - d * box.top };
}

/** Image pixels straight to screen pixels, given the field-to-screen projection. */
export function imageToScreen(
  spec: FieldImageSpec,
  naturalWidthPx: number,
  naturalHeightPx: number,
  bounds: Box2,
  toScreen: (point: Vec2) => { xPx: number; yPx: number },
): Affine {
  const corners = cornersOnField(bounds, spec.rotationDeg);
  const at = (point: Vec2): { x: number; y: number } => {
    const screen = toScreen(point);
    return { x: screen.xPx, y: screen.yPx };
  };
  return affineFromBox(pixelBox(spec, naturalWidthPx, naturalHeightPx), at(corners.tl), at(corners.tr), at(corners.bl));
}

/**
 * The credit line drawn in the canvas corner while the picture is showing, always in the one form
 * "Field image: <who>", whether the file says "Team Juice 16236", "Field image by Team Juice 16236"
 * or "Field image: Team Juice 16236".
 */
export function creditLine(spec: FieldImageSpec | null): string | null {
  if (spec === null || spec.credit === null) return null;
  const who = spec.credit.trim().replace(/^field image\s*(?:by|:)?\s*/i, "");
  return who === "" ? null : `Field image: ${who}`;
}
