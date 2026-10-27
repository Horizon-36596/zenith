/**
 * What a Pedro Pathing Visualizer `.pp` file may hold, as the visualizer at commit `d0d538e` defines
 * it (`src/types.ts`, `src/utils/project.ts`, `src/utils/normalize.ts`; ADR 0008 section 1). These
 * lists are how the importer tells a field it knows from one it does not, so every key a file carries
 * is either read, deliberately left out with a warning, or listed as unknown.
 *
 * Written from the visualizer's behaviour; no visualizer code is copied (it is Apache-2.0).
 */
import type { ImportIssue } from "../errors.js";

/** The project version the visualizer at that commit writes (`PROJECT_VERSION`). */
export const PEDRO_PROJECT_VERSION = "1.5.0";

export const TOP_LEVEL_KEYS = [
  "version",
  "timestamp",
  "startPoint",
  "lines",
  "shapes",
  "sequence",
  "fieldPoints",
  "settings",
  "activePaths",
] as const;

/**
 * Top-level keys older visualizers wrote that 1.5.0 reads no more. `pathChains` held the path chains
 * of versions 1.2.1 and 1.3.0 (a public team file and an export from the visualizer at `12574b9`
 * both carry it); the current visualizer drops it, and so does the import, with a warning.
 */
export const LEGACY_TOP_LEVEL_KEYS = ["pathChains"] as const;

/** The heading fields old files kept on a point before headings moved onto the path. */
export const LEGACY_POINT_HEADING_KEYS = ["heading", "startDeg", "endDeg", "degrees", "reverse", "piecewiseHeading"] as const;

export const START_POINT_KEYS = ["x", "y", "name", "locked", "headingDeg", ...LEGACY_POINT_HEADING_KEYS] as const;

export const END_POINT_KEYS = ["x", "y", "name", "locked", ...LEGACY_POINT_HEADING_KEYS] as const;

export const POINT_KEYS = ["x", "y", "locked", "name"] as const;

export const PATH_KEYS = [
  "id",
  "color",
  "name",
  "locked",
  "kind",
  "waitBefore",
  "waitAfter",
  "waitBeforeMs",
  "waitAfterMs",
  "waitBeforeName",
  "waitAfterName",
  "heading",
  "endPoint",
  "controlPoints",
  "throughPoints",
  "segments",
] as const;

export const HEADING_KEYS: Record<string, readonly string[]> = {
  linear: ["type", "startDeg", "endDeg"],
  constant: ["type", "degrees"],
  tangential: ["type", "reverse"],
  piecewise: ["type", "piecewiseHeading"],
};

/**
 * Every key any heading type has. The visualizer's heading picker changes `type` in place and keeps
 * the fields of the type it had before, so a real export holds, for example,
 * `{ type: "constant", reverse: true, degrees: 45 }` after a tangential heading was made constant.
 * The visualizer reads only the fields of the current type; so does the import, silently.
 */
export const ANY_HEADING_KEYS: readonly string[] = [...new Set(Object.values(HEADING_KEYS).flat())];

/**
 * A piecewise heading's keys. `scope` is from versions 1.2.1 to 1.3.0, where `"chain"` spread the
 * heading over a whole path chain; the current visualizer ignores it.
 */
export const PIECEWISE_HEADING_KEYS = ["segments", "scope"] as const;

export const PIECEWISE_SEGMENT_KEYS = [
  "startProgress",
  "endProgress",
  "interpolationType",
  "reversed",
  "continueFromPrevious",
  "parameters",
] as const;

export const PIECEWISE_PARAMETER_KEYS = ["startDeg", "endDeg", "degrees", "point"] as const;

export const SEQUENCE_KEYS: Record<string, readonly string[]> = {
  path: ["kind", "lineId"],
  wait: ["kind", "id", "name", "durationMs", "locked"],
};

/** The motion estimates the visualizer's settings dialog calls "UI Settings Only". */
export const MOTION_SETTING_KEYS = [
  "xVelocity",
  "yVelocity",
  "aVelocity",
  "kFriction",
  "maxVelocity",
  "maxAcceleration",
  "maxDeceleration",
] as const;

export const SETTINGS_KEYS = [
  ...MOTION_SETTING_KEYS,
  "rWidth",
  "rHeight",
  "safetyMargin",
  "fieldMap",
  "customFieldImage",
  "robotImage",
  "showGhostPaths",
  "showOnionLayers",
  "onionLayerSpacing",
  "onionColor",
  "onionNextPointOnly",
  "showHeadingArrow",
  "showCurrentTValue",
  "leftPanelWidth",
  "rightPanelWidth",
  "headingArrowLength",
  "headingArrowColor",
  "headingArrowThickness",
  "pathOpacity",
  "leftPanelMinWidth",
  "rightPanelMinWidth",
  "penToolMaxPaths",
  "curveThroughMaxPoints",
  "experimentalFeatures",
  // Display settings of versions before 1.4.0, which the current visualizer no longer has.
  "theme",
  "penToolAccuracy",
] as const;

/** The field image the frame conversion was checked against (ADR 0008 section 2). */
export const VERIFIED_FIELD_MAP = "biobuzz.webp";

/**
 * Whether `stored` is a newer project version than `current`, comparing dot-separated integers left
 * to right the way the visualizer's own `newerVersionWarning` does.
 */
export function isNewerVersion(stored: string, current: string = PEDRO_PROJECT_VERSION): boolean {
  const parse = (value: string): number[] => value.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const a = parse(stored);
  const b = parse(current);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left > right) return true;
    if (left < right) return false;
  }
  return false;
}

/**
 * The most entries any list in a `.pp` file may hold: `lines`, a group's `segments`, a path's
 * `controlPoints`, `sequence`, `shapes` and every other list. SET BY HAND to match the cap on every
 * list in `path.json` (itself the projection's cap on steps), so an imported file is held to the
 * same limits whichever format it arrives in (spec 13 section 13: a hostile file must not crash
 * the app). Real projects are far inside it.
 */
export const MAX_PEDRO_LIST_LENGTH = 200;

/**
 * The longest string a `.pp` file may hold: a path's name, id or colour, a heading type, a version.
 * SET BY HAND to match `path.json`'s cap on strings, for the same reason as the list cap.
 */
export const MAX_PEDRO_STRING_LENGTH = 200;

/**
 * The deepest a `.pp` file may nest objects and lists. SET BY HAND: groups nested as deep as the
 * reader allows (eight), with a piecewise heading's parameters and point at the bottom, come to
 * about 25 levels; 64 leaves room for that and stops a file built only to exhaust the stack.
 */
export const MAX_PEDRO_NESTING_DEPTH = 64;

/**
 * The strings that may be longer than `MAX_PEDRO_STRING_LENGTH`: the two images a visualizer
 * project can embed as base64 data URLs (`settings.customFieldImage`, `settings.robotImage`). The
 * importer never reads them, and the caller's cap on the file's size bounds them.
 */
export const PEDRO_LONG_STRING_PATHS: readonly string[] = ["settings.customFieldImage", "settings.robotImage"];

/** The most size problems reported for one file; a hostile file could otherwise have millions. */
const MAX_SIZE_ISSUES = 20;

/**
 * Every list, string and nesting level in a parsed `.pp` document that is over its cap, named by
 * its JSON path, at most twenty. Empty for any file the visualizer writes. The importer runs this
 * before it reads anything, so a file over a cap is refused whole rather than read in part.
 */
export function pedroSizeIssues(doc: unknown): ImportIssue[] {
  const issues: ImportIssue[] = [];
  const visit = (value: unknown, path: string, depth: number): void => {
    if (issues.length >= MAX_SIZE_ISSUES) return;
    if (depth > MAX_PEDRO_NESTING_DEPTH) {
      issues.push({ path, message: `nests deeper than ${String(MAX_PEDRO_NESTING_DEPTH)} levels, which no Pedro Visualizer project does.` });
      return;
    }
    if (typeof value === "string") {
      if (value.length > MAX_PEDRO_STRING_LENGTH && !PEDRO_LONG_STRING_PATHS.includes(path)) {
        issues.push({ path, message: `is ${String(value.length)} characters long; a string in a .pp file may be at most ${String(MAX_PEDRO_STRING_LENGTH)}.` });
      }
      return;
    }
    if (Array.isArray(value)) {
      if (value.length > MAX_PEDRO_LIST_LENGTH) {
        issues.push({ path, message: `has ${String(value.length)} entries; a list in a .pp file may have at most ${String(MAX_PEDRO_LIST_LENGTH)}.` });
        return;
      }
      value.forEach((item, i) => visit(item, `${path}[${String(i)}]`, depth + 1));
      return;
    }
    if (typeof value === "object" && value !== null) {
      const entries = Object.entries(value as Record<string, unknown>);
      if (entries.length > MAX_PEDRO_LIST_LENGTH) {
        issues.push({ path, message: `has ${String(entries.length)} keys; an object in a .pp file may have at most ${String(MAX_PEDRO_LIST_LENGTH)}.` });
        return;
      }
      for (const [key, item] of entries) {
        if (key.length > MAX_PEDRO_STRING_LENGTH) {
          issues.push({ path, message: `has a key ${String(key.length)} characters long; a key in a .pp file may be at most ${String(MAX_PEDRO_STRING_LENGTH)}.` });
          continue;
        }
        visit(item, path === "" ? key : `${path}.${key}`, depth + 1);
      }
    }
  };
  visit(doc, "", 0);
  return issues;
}
