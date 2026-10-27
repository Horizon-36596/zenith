/**
 * "Download picture": the open auto as a PNG or an SVG, the same picture `zenith render` writes
 * (title, total time, paths, markers and time-spaced footprints), for a printout, a notebook or a
 * message to a partner. The SVG is core's own `render` through `safeRender`, from the editor's
 * derived results, with no field photograph; the PNG is that SVG drawn at twice its size on an
 * offscreen canvas.
 *
 * The building is DOM-free so it is tested in node; only the PNG and the download itself touch the
 * browser.
 */
import type { Waypoints } from "@horizon36596/zenith-schema";
import { saveFileAs } from "../project/fallback";
import { safeRender } from "../lib/coreSafe";
import { currentDerived, getState, hiddenWaypoints, setStatus, type State } from "../state/store";
import type { Derived } from "../state/derived";

export type PictureKind = "png" | "svg";

/** How many times wider and taller than the SVG the PNG is drawn. */
export const PNG_SCALE = 2;

/** The file name a picture is downloaded as: `<auto name>.<alliance>.<png or svg>`. */
export const pictureFileName = (autoName: string, alliance: "RED" | "BLUE", kind: PictureKind): string =>
  `${autoName}.${alliance.toLowerCase()}.${kind}`;

export interface PictureOptions {
  /** The alliance being viewed; the picture mirrors the auto when it is not the one the file is in. */
  alliance: "RED" | "BLUE";
  showLedger: boolean;
  waypoints?: Waypoints | undefined;
  /** The pins the field hides (issue #236), which the picture leaves out too. */
  hiddenWaypoints?: readonly string[];
}

/** The SVG for the derived results, or the reason there is none. */
export function buildPictureSvg(
  derived: Pick<Derived, "plan" | "estimate" | "findings" | "ledger">,
  options: PictureOptions,
): { ok: true; svg: string } | { ok: false; reason: string } {
  if (derived.plan === null) return { ok: false, reason: "This auto has no plan yet, so there is nothing to draw." };
  const attempt = safeRender(derived.plan, derived.estimate, derived.findings, derived.ledger, {
    alliance: options.alliance,
    showLedger: options.showLedger,
    ...(options.waypoints === undefined ? {} : { waypoints: options.waypoints }),
    ...(options.hiddenWaypoints === undefined || options.hiddenWaypoints.length === 0 ? {} : { hiddenWaypoints: options.hiddenWaypoints }),
  });
  return attempt.ok ? { ok: true, svg: attempt.value } : { ok: false, reason: attempt.reason };
}

/** The width and height the SVG's root element declares, or null when it declares neither. */
export function svgPixelSize(svg: string): { width: number; height: number } | null {
  const root = /<svg\b[^>]*>/.exec(svg)?.[0];
  if (root === undefined) return null;
  const width = Number(/\swidth="([\d.]+)"/.exec(root)?.[1]);
  const height = Number(/\sheight="([\d.]+)"/.exec(root)?.[1]);
  return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0 ? { width, height } : null;
}

/** Why no picture can be downloaded right now, or null when one can. */
export function pictureBlockedReason(state: State): string | null {
  if (state.auto === null) return "Open an auto first.";
  if (currentDerived().plan === null) return "This auto cannot be planned yet, so there is nothing to draw. Fix its errors first.";
  return null;
}

/** Draws the SVG on an offscreen canvas at `scale` times its size and encodes it as a PNG. */
export async function svgToPng(svg: string, scale: number = PNG_SCALE): Promise<Blob> {
  const size = svgPixelSize(svg);
  if (size === null) throw new Error("The picture has no size, so it cannot be made into a PNG.");
  const image = new Image();
  const loaded = new Promise<void>((resolve, reject) => {
    image.onload = () => {
      resolve();
    };
    image.onerror = () => {
      reject(new Error("The browser could not draw the picture."));
    };
  });
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await loaded;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(size.width * scale);
  canvas.height = Math.round(size.height * scale);
  const context = canvas.getContext("2d");
  if (context === null) throw new Error("The browser gave no canvas to draw the picture on.");
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob === null) reject(new Error("The browser could not encode the PNG."));
      else resolve(blob);
    }, "image/png");
  });
}

/** Downloads the open auto's picture, and says on the status line what it wrote or why it could not. */
export async function downloadPicture(kind: PictureKind): Promise<void> {
  const state = getState();
  const blocked = pictureBlockedReason(state);
  if (blocked !== null || state.auto === null) {
    setStatus("error", blocked ?? "Open an auto first.");
    return;
  }
  const built = buildPictureSvg(currentDerived(), {
    alliance: state.alliance,
    showLedger: state.prefs.features.ledger,
    waypoints: state.project?.waypoints,
    // The picture shows the pins the field shows (issue #236).
    hiddenWaypoints: [...hiddenWaypoints(state)],
  });
  if (!built.ok) {
    setStatus("error", built.reason);
    return;
  }
  const fileName = pictureFileName(state.auto.name, state.alliance, kind);
  try {
    // The SVG goes as its text, so it names its own type; a string would otherwise download as JSON.
    const saved =
      kind === "svg" ? await saveFileAs(fileName, built.svg, "image/svg+xml") : await saveFileAs(fileName, await svgToPng(built.svg));
    if (saved === null) setStatus("info", "Save cancelled. No picture was saved.");
    else setStatus("ok", `${saved.how === "saved" ? "Saved" : "Downloaded"} ${saved.name}, a picture of the auto.`);
  } catch (error) {
    setStatus("error", `${fileName} was not made: ${error instanceof Error ? error.message : String(error)}`);
  }
}
