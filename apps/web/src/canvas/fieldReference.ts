/**
 * The dev-only field alignment check. With `?fieldRef=1` in the address of the Vite dev server, the
 * canvas lays the internal reference picture of the field over the drawn field's fills at 50 % and
 * draws the field's edges again on top, so any offset between the two shows as a doubled line.
 * `?fieldRef=0.3` sets another opacity; `?fieldRef=light` or `?fieldRef=black` picks another look.
 *
 * Only `FieldCanvas` calls this, and only inside `import.meta.env.DEV`, so a production build drops
 * the whole module. The pictures come from the dev server's `/__field-ref/` route
 * (`vite.config.ts`); where it has none, the overlay draws nothing.
 */
import { fieldBounds } from "@horizon36596/zenith-core";
import { imageToScreen, type FieldImageSpec } from "./fieldImage.js";
import { drawStatic, type StaticLayerInput } from "./staticLayer.js";
import { worldToScreen } from "./view.js";

/** How each season's reference pictures sit on the field, as `field.image` would say it. */
const PLACEMENT: Readonly<Record<string, Omit<FieldImageSpec, "src">>> = {
  biobuzz: { credit: null, pxBounds: "fullBleed", rotationDeg: 90, variants: [] },
};

interface Request {
  opacity: number;
  look: string;
}

/** What the address asks for, or null when it does not ask for the overlay. */
export function readRequest(search: string): Request | null {
  const value = new URLSearchParams(search).get("fieldRef");
  if (value === null || value === "" || value === "0") return null;
  const number = Number(value);
  if (Number.isFinite(number)) return { opacity: number > 0 && number < 1 ? number : 0.5, look: "dark" };
  return { opacity: 0.5, look: /^[a-z]+$/.test(value) ? value : "dark" };
}

const images = new Map<string, HTMLImageElement>();
let onReady: (() => void) | null = null;

/** Repaint the static layer when a reference picture finishes loading. Returns the unsubscribe. */
export function watchFieldReference(repaint: () => void): () => void {
  onReady = repaint;
  return () => {
    if (onReady === repaint) onReady = null;
  };
}

function pictureFor(season: string, look: string): HTMLImageElement | null {
  const src = `/__field-ref/${season}/${season}-${look}.webp`;
  const cached = images.get(src);
  if (cached !== undefined) return cached.complete && cached.naturalWidth > 0 ? cached : null;
  const image = new Image();
  image.onload = () => onReady?.();
  image.src = src;
  images.set(src, image);
  return null;
}

/** Draw the reference picture and the field's edges over a static layer `drawStatic` just painted. */
export function drawFieldReference(ctx: CanvasRenderingContext2D, input: StaticLayerInput): void {
  const request = readRequest(window.location.search);
  if (request === null || input.mode === "outlines") return;
  const placement = PLACEMENT[input.field.season];
  if (placement === undefined) return;
  const image = pictureFor(input.field.season, request.look);
  if (image === null) return;
  const spec: FieldImageSpec = { ...placement, src: image.src };
  const m = imageToScreen(spec, image.naturalWidth, image.naturalHeight, fieldBounds(input.field), (world) =>
    worldToScreen(input.view, world),
  );
  ctx.save();
  ctx.globalAlpha = request.opacity;
  ctx.transform(m.a, m.b, m.c, m.d, m.e, m.f);
  ctx.drawImage(image, 0, 0);
  ctx.restore();
  drawStatic(ctx, { ...input, mode: "outlines" });
}
