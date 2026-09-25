/**
 * The canvas reads its colours from the same custom properties every other component reads
 * (apps/web/src/styles/tokens.css). A literal colour in canvas code would be exactly the bug
 * UI_GUIDE section 1 names, so the tokens are resolved once per theme change and handed to the
 * painters as plain strings.
 *
 * `getComputedStyle` is not cheap enough to call per frame, and the values only move when the
 * theme does, so `observeTheme` watches `data-theme` on the document element and asks for a
 * re-read. Every token has a fallback so the canvas still draws if it is mounted before the
 * stylesheet lands.
 */

export interface CanvasTheme {
  bgCanvas: string;
  bgPanel: string;
  borderDefault: string;
  gridMinor: string;
  gridMajor: string;
  gridAxis: string;
  fieldObstacle: string;
  fieldObstacleFill: string;
  fieldZone: string;
  fieldZoneFill: string;
  fieldElement: string;
  fieldElementFill: string;
  fieldTarget: string;
  fieldWaypoint: string;
  pathEstimated: string;
  pathSelected: string;
  pathHover: string;
  pathActual: string;
  pathGhost: string;
  pathWidthNormalPx: number;
  pathWidthSelectedPx: number;
  pathWidthActualPx: number;
  handleEndpoint: string;
  handleControl: string;
  handleHeading: string;
  markerPin: string;
  ghostFootprint: string;
  highlightFind: string;
  sevError: string;
  sevWarn: string;
  sevInfo: string;
  accent: string;
  accentLine: string;
  textHi: string;
  textMid: string;
  textLo: string;
  allianceRed: string;
  allianceBlue: string;
  fontUi: string;
  fontMono: string;
  /** v2: heading, markers, snap guides and the measure tool (`--canvas-annotation`). */
  canvasAnnotation: string;
  snapGuide: string;
  /** v2: the one robot outline that follows the scrubber or the cursor. */
  robotOutline: string;
  /** v2: the faint fill inside that outline. */
  robotOutlineFill: string;
  bgRaised: string;
  borderStrong: string;
}

/**
 * The v2 dark values from tokens.css, one for one (UI_GUIDE section 4). They only draw before the
 * stylesheet lands or where a token is missing; the resolved tokens always win.
 */
const FALLBACK: CanvasTheme = {
  bgCanvas: "#110414",
  bgPanel: "#1c0a24",
  borderDefault: "#331e3f",
  gridMinor: "#2a1b30",
  gridMajor: "#3c2b44",
  gridAxis: "#594364",
  fieldObstacle: "#83738b",
  fieldObstacleFill: "#2e2034",
  fieldZone: "#eddb49",
  fieldZoneFill: "rgb(237 219 73 / 0.10)",
  fieldElement: "#d489e5",
  fieldElementFill: "rgb(212 137 229 / 0.18)",
  fieldTarget: "#43d5dc",
  fieldWaypoint: "#a08fa8",
  pathEstimated: "#c2b0c8",
  pathSelected: "#faf6fb",
  pathHover: "#f0e8f2",
  pathActual: "#62d286",
  pathGhost: "rgb(194 176 200 / 0.28)",
  pathWidthNormalPx: 2,
  pathWidthSelectedPx: 3,
  pathWidthActualPx: 1.5,
  handleEndpoint: "#faf6fb",
  handleControl: "#c2b7da",
  handleHeading: "#71c9fa",
  markerPin: "#71c9fa",
  ghostFootprint: "rgb(194 176 200 / 0.16)",
  highlightFind: "rgb(251 97 136 / 0.35)",
  sevError: "#fb6188",
  sevWarn: "#eddb49",
  sevInfo: "#9abae4",
  accent: "#f86a43",
  accentLine: "rgb(248 106 67 / 0.45)",
  textHi: "#faf6fb",
  textMid: "#c2b0c8",
  textLo: "#a08fa8",
  allianceRed: "#ee3533",
  allianceBlue: "#3082f6",
  fontUi: '"IBM Plex Sans", "Segoe UI Variable Text", "Segoe UI", sans-serif',
  fontMono: '"JetBrains Mono", "Cascadia Mono", Consolas, monospace',
  canvasAnnotation: "#71c9fa",
  snapGuide: "#71c9fa",
  robotOutline: "#faf6fb",
  robotOutlineFill: "rgb(250 246 251 / 0.08)",
  bgRaised: "#2a1735",
  borderStrong: "#6f5b7c",
};

/**
 * Which custom property each key reads. The field well stays dark in both themes (UI_GUIDE section
 * 4), so the ink the canvas draws on the well itself (the text, the chip and readout surfaces and
 * their borders) reads the fixed `--chrome-*` tokens, which no theme overrides, instead of the
 * theme-swapped `--text-*`, `--bg-raised` and `--border-*`. In the dark theme the two are the same
 * values; in the light theme the swapped ones are white and night, which vanish on the well.
 */
const VARIABLES: Readonly<Record<keyof CanvasTheme, string>> = {
  bgCanvas: "--bg-canvas",
  bgPanel: "--bg-panel",
  borderDefault: "--chrome-border",
  gridMinor: "--grid-minor",
  gridMajor: "--grid-major",
  gridAxis: "--grid-axis",
  fieldObstacle: "--field-obstacle",
  fieldObstacleFill: "--field-obstacle-fill",
  fieldZone: "--field-zone",
  fieldZoneFill: "--field-zone-fill",
  fieldElement: "--field-element",
  fieldElementFill: "--field-element-fill",
  fieldTarget: "--field-target",
  fieldWaypoint: "--field-waypoint",
  pathEstimated: "--path-estimated",
  pathSelected: "--path-selected",
  pathHover: "--path-hover",
  pathActual: "--path-actual",
  pathGhost: "--path-ghost",
  pathWidthNormalPx: "--path-w-normal",
  pathWidthSelectedPx: "--path-w-selected",
  pathWidthActualPx: "--path-w-actual",
  handleEndpoint: "--handle-endpoint",
  handleControl: "--handle-control",
  handleHeading: "--handle-heading",
  markerPin: "--marker-pin",
  ghostFootprint: "--ghost-footprint",
  highlightFind: "--highlight-find",
  sevError: "--sev-error",
  sevWarn: "--sev-warn",
  sevInfo: "--sev-info",
  accent: "--accent",
  accentLine: "--accent-line",
  textHi: "--chrome-text-hi",
  textMid: "--chrome-text-mid",
  textLo: "--chrome-text-lo",
  allianceRed: "--alliance-red",
  allianceBlue: "--alliance-blue",
  fontUi: "--font-ui",
  fontMono: "--font-mono",
  canvasAnnotation: "--canvas-annotation",
  snapGuide: "--snap-guide",
  robotOutline: "--robot-outline",
  robotOutlineFill: "--robot-outline-fill",
  bgRaised: "--chrome-active",
  borderStrong: "--chrome-border-strong",
};

const NUMERIC = new Set<keyof CanvasTheme>([
  "pathWidthNormalPx",
  "pathWidthSelectedPx",
  "pathWidthActualPx",
]);

/** Resolve every canvas token against an element, falling back where one is missing. */
export function readTheme(root: Element): CanvasTheme {
  const style = getComputedStyle(root);
  const theme = { ...FALLBACK } as Record<string, string | number>;
  for (const key of Object.keys(VARIABLES) as Array<keyof CanvasTheme>) {
    const raw = style.getPropertyValue(VARIABLES[key]).trim();
    if (raw === "") continue;
    if (NUMERIC.has(key)) {
      const value = Number.parseFloat(raw);
      if (Number.isFinite(value)) theme[key] = value;
    } else {
      theme[key] = raw;
    }
  }
  return theme as unknown as CanvasTheme;
}

export const fallbackTheme = (): CanvasTheme => ({ ...FALLBACK });

/**
 * The second palette: the ink the live layer draws with over a light field picture (the printable
 * BIOBUZZ "light" style, near-white tiles). The v2 dark-theme inks are near-white and vanish there,
 * so paths, the robot outline, handles and the drag bubble switch to night ink, and the annotations
 * (heading, markers, snap guides, measure) to a darker blue than the sky blue that reads on dark.
 * Severity and alliance colours, fonts and the corner readouts (which sit on the dark well) are not
 * in the set and stay as the resolved tokens give them. The owner ruled on this on 2026-09-22.
 *
 * `bgCanvas` here is the ground behind hollow handles and markers, not the well: the live layer
 * uses it only for that.
 */
export const LIGHT_FIELD_INK: Readonly<Partial<CanvasTheme>> = {
  bgCanvas: "#faf6fb",
  bgRaised: "#faf6fb",
  borderDefault: "#c2b0c8",
  textHi: "#17061d",
  textMid: "#55475c",
  fieldWaypoint: "#55475c",
  pathEstimated: "#2a1735",
  pathHover: "#3c2b44",
  pathSelected: "#17061d",
  pathGhost: "rgb(42 23 53 / 0.35)",
  pathWidthSelectedPx: 4,
  robotOutline: "#17061d",
  robotOutlineFill: "rgb(23 6 29 / 0.08)",
  handleEndpoint: "#17061d",
  handleControl: "#2a1735",
  canvasAnnotation: "#2f5fa8",
  snapGuide: "#2f5fa8",
  handleHeading: "#2f5fa8",
  markerPin: "#2f5fa8",
};

/** The theme the live layer draws with: the resolved tokens, with the light-field ink over them. */
export const liveInk = (theme: CanvasTheme, lightField: boolean): CanvasTheme =>
  lightField ? { ...theme, ...LIGHT_FIELD_INK } : theme;

/** Call `onChange` whenever the theme the tokens resolve under changes. */
export function observeTheme(root: HTMLElement, onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(root, { attributes: true, attributeFilter: ["data-theme", "class", "style"] });
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  media.addEventListener("change", onChange);
  return () => {
    observer.disconnect();
    media.removeEventListener("change", onChange);
  };
}

/** A token colour at a different alpha, without hard-coding a colour. */
export const withAlpha = (colour: string, alpha: number): string =>
  `color-mix(in oklab, ${colour} ${String(Math.round(alpha * 100))}%, transparent)`;
