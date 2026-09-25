/**
 * The Zenith palette, as literal sRGB.
 *
 * `apps/web/UI_GUIDE.md` and `apps/web/src/styles/tokens.css` define these in OKLCH as CSS custom
 * properties, which is right for the app. An SVG from `render()` is also rasterised (the CLI's
 * `--png`, a pull request's committed picture), and a rasteriser has no custom properties and no
 * OKLCH, so the same colours are written out here as hex, one constant per token, with the token's
 * name and its OKLCH value beside it. If a token changes in `tokens.css`, change it here too: these
 * are two spellings of one palette, not two palettes.
 *
 * The hex values are the sRGB conversion of the OKLCH in `tokens.css`. Where `tokens.css` prints a
 * hex in a comment, it says itself that it is an approximation for reference; the conversion below
 * is the accurate one, so the two differ by a shade or two on the saturated hues.
 */
export const TOKENS = {
  /** `--bg-canvas` oklch(0.130 0.005 255): the field well, darker so geometry reads first. */
  bgCanvas: "#060709",
  /** `--bg-panel` oklch(0.205 0.007 255): the side table's body. */
  bgPanel: "#15171a",
  /** `--bg-raised` oklch(0.255 0.008 255): the side table's header. */
  bgRaised: "#202327",

  /** `--border-subtle` oklch(0.275 0.007 255). */
  borderSubtle: "#25282b",
  /** `--border-default` oklch(0.340 0.008 255): the field perimeter. */
  borderDefault: "#35383c",

  /** `--text-hi` oklch(0.950 0.004 255). */
  textHi: "#edeff1",
  /** `--text-mid` oklch(0.780 0.006 255). */
  textMid: "#b5b8bb",
  /** `--text-lo` oklch(0.650 0.008 255). */
  textLo: "#8c8f94",

  /** `--accent` oklch(0.760 0.115 192): Horizon teal. */
  accent: "#3fc8c4",

  /** `--sev-error` oklch(0.700 0.175 25). */
  sevError: "#f86b65",
  /** `--sev-warn` oklch(0.790 0.135 72). */
  sevWarn: "#f0ab4d",
  /** `--sev-info` oklch(0.740 0.045 240). */
  sevInfo: "#92afc5",
  /** `--ok` oklch(0.760 0.135 150). */
  ok: "#6cc982",

  /** `--path-estimated` oklch(0.740 0.035 240): the plan as drawn. */
  pathEstimated: "#98aebf",
  /** `--path-actual` oklch(0.740 0.135 150): a recorded trace laid over the plan. */
  pathActual: "#65c27c",

  /** `--grid-minor` oklch(0.300 0.006 255): every 12 in. */
  gridMinor: "#2c2e31",
  /** `--grid-major` oklch(0.400 0.007 255): every 24 in, one tile. */
  gridMajor: "#45484b",
  /** `--grid-axis` oklch(0.520 0.020 255): x = 0 and y = 0. */
  gridAxis: "#616a75",

  /** `--field-obstacle` oklch(0.500 0.012 250). */
  fieldObstacle: "#5e646a",
  /** `--field-obstacle-fill` oklch(0.285 0.010 250): opaque, because you cannot drive here. */
  fieldObstacleFill: "#262b2f",
  /** `--field-zone` oklch(0.790 0.135 72): shares the warning hue by design. */
  fieldZone: "#f0ab4d",
  /** `--field-element` oklch(0.720 0.110 350): game elements and containers. */
  fieldElement: "#d887ae",
  /** `--field-target` oklch(0.800 0.115 88): the scoring reticle. */
  fieldTarget: "#ddb961",
  /** `--field-waypoint` oklch(0.700 0.030 255): a named pose's pin. */
  fieldWaypoint: "#92a0b1",

  /** `--marker-pin` oklch(0.860 0.100 192): an authored event on a path. */
  markerPin: "#7be6e2",
  /** `--handle-heading` oklch(0.860 0.090 88): warm, because orientation is warm. */
  handleHeading: "#eace8c",
  /** `--alliance-red` oklch(0.630 0.205 26). */
  allianceRed: "#eb4441",
  /** `--alliance-blue` oklch(0.630 0.175 258). */
  allianceBlue: "#3d87f0",
} as const;

/** Alpha values the guide states as a percentage, as SVG opacity numbers. */
export const ALPHA = {
  /** `--field-zone-fill`: 10 % under a 4 4 dashed stroke. */
  zoneFill: 0.1,
  /** `--field-element-fill`: 18 %. */
  elementFill: 0.18,
  /** `--ghost-footprint`: the robot outline stamped every half second. */
  ghostFootprint: 0.16,
  /** `--path-ghost`: the mirrored or base-version preview, dashed 4 4. */
  pathGhost: 0.28,
  /** `--highlight-find`: the segment a finding points at, widened underneath the path. */
  findingHighlight: 0.35,
} as const;

/** The font stacks of `UI_GUIDE.md` section 2, written out for a document with no stylesheet. */
export const FONTS = {
  ui: "IBM Plex Sans, Segoe UI, Noto Sans, sans-serif",
  mono: "IBM Plex Mono, ui-monospace, Consolas, monospace",
} as const;

/** The colour a finding is drawn in, by severity. */
export const severityColour = (severity: "error" | "warning" | "info"): string =>
  severity === "error" ? TOKENS.sevError : severity === "warning" ? TOKENS.sevWarn : TOKENS.sevInfo;
