/**
 * The Grid setting (owner ruling D11): the static layer's floor, its 24 in tile seams and its finer
 * lines at 12 in or 6 in. The 12 in choice drew exactly what the field drew before the setting existed;
 * since issue #428 the seams inside the wall carry the tiles' interlocking tabs, so the full sequence
 * of canvas calls is compared with the one `main` made before that (`staticLayer.main.golden.json`,
 * captured from `main` at c1c3fb47) where it still applies: the whole drawing zoomed out until a tab is
 * under 2 px, and everything but the seams at a fitted zoom.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadField } from "@horizon36596/zenith-core";
import { ftcTileSeam } from "@horizon36596/zenith-season-biobuzz";
import { describe, expect, it } from "vitest";
import { drawStatic, gridLineSpacingsIn, pictureOverlay, type StaticLayerInput } from "./staticLayer";
import { fallbackTheme } from "./theme";
import { fitView, orientationFor, type View } from "./view";
import type { FieldGrid } from "../state/prefs";

const here = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));
const read = (relative: string): unknown => JSON.parse(readFileSync(here(relative), "utf8")) as unknown;

const field = loadField(read("../../../../examples/starter/autos/field/biobuzz.field.json"));
const theme = fallbackTheme();
const bounds = { minXIn: -72, minYIn: -72, maxXIn: 72, maxYIn: 72 };
const viewAt = (widthPx: number, heightPx: number): View => fitView(bounds, widthPx, heightPx, 24, orientationFor("bottom"));

interface Recorded {
  /** Every call, one string each, with the ink in force on a stroke or a fill. */
  calls: string[];
  /** Each stroked straight line, with its colour. */
  lines: { colour: string; from: [number, number]; to: [number, number] }[];
  /** Each stroked path of more than one segment, with its corners (an `arcTo`'s corner too) and its arcs. */
  paths: { colour: string; points: [number, number][]; arcs: number }[];
  /** Each fill, with its colour. */
  fills: string[];
}

/** A 2D context that records every call, so two drawings can be compared exactly. */
function recordingContext(): { ctx: CanvasRenderingContext2D; recorded: Recorded } {
  const recorded: Recorded = { calls: [], lines: [], paths: [], fills: [] };
  const state: Record<string, unknown> = { strokeStyle: "", fillStyle: "", globalAlpha: 1, lineWidth: 1 };
  let path: [number, number][] = [];
  let arcs = 0;
  const num = (value: unknown): string => (typeof value === "number" ? value.toFixed(4) : String(value));
  const ctx = new Proxy(state, {
    get(target, key: string) {
      if (key in target) return target[key];
      return (...args: unknown[]) => {
        if (key === "beginPath") {
          path = [];
          arcs = 0;
        }
        if (key === "moveTo" || key === "lineTo" || key === "arcTo") path.push([Number(args[0]), Number(args[1])]);
        if (key === "arcTo") arcs += 1;
        const ink =
          key === "stroke" ? String(target["strokeStyle"]) : key === "fill" || key === "fillRect" ? String(target["fillStyle"]) : "";
        if (key === "stroke" && path.length === 2) {
          recorded.lines.push({ colour: ink, from: path[0] as [number, number], to: path[1] as [number, number] });
        }
        if (key === "stroke" && path.length > 2) recorded.paths.push({ colour: ink, points: [...path], arcs });
        if (key === "fill") recorded.fills.push(ink);
        recorded.calls.push(
          `${key}(${args.map(num).join(",")})${ink === "" ? "" : `[${ink}]`}${key === "stroke" ? `w${num(target["lineWidth"])}` : ""}`,
        );
        return undefined;
      };
    },
    set(target, key: string, value: unknown) {
      target[key] = value;
      if (key === "strokeStyle" || key === "fillStyle" || key === "lineWidth") recorded.calls.push(`${key}=${String(value)}`);
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, recorded };
}

function drawn(
  fieldGrid: FieldGrid | undefined,
  view: View = viewAt(1440, 900),
  mode?: "outlines",
  size: { widthPx: number; heightPx: number } = { widthPx: 1440, heightPx: 900 },
): Recorded {
  const { ctx, recorded } = recordingContext();
  const input: StaticLayerInput = {
    field,
    waypoints: null,
    robotHeightIn: 18,
    view,
    theme,
    ...size,
    ...(fieldGrid === undefined ? {} : { fieldGrid }),
    ...(mode === undefined ? {} : { mode }),
  };
  drawStatic(ctx, input);
  return recorded;
}

const digest = (calls: readonly string[]): string => createHash("sha256").update(calls.join("\n")).digest("hex");

const linesIn = (recorded: Recorded, colour: string): number => recorded.lines.filter((line) => line.colour === colour).length;

/** The calls with the seams taken out: from setting the seams' ink up to the next ink set. */
function withoutSeams(calls: readonly string[]): string[] {
  const kept: string[] = [];
  let seams = false;
  for (const call of calls) {
    if (call.startsWith("strokeStyle=")) seams = call === `strokeStyle=${theme.gridMajor}`;
    if (!seams) kept.push(call);
  }
  return kept;
}

interface Golden {
  far: { widthPx: number; heightPx: number; count: number; sha256: string };
  fittedWithoutSeams: { widthPx: number; heightPx: number; count: number; sha256: string };
}
const golden = read("./staticLayer.main.golden.json") as Golden;

/** The tabbed seams' paths, in the seams' ink. */
const seamPaths = (recorded: Recorded): Recorded["paths"] => recorded.paths.filter((path) => path.colour === theme.gridMajor);

describe("the Grid setting, spec 15 section 10", () => {
  it("zoomed out until a tab is under 2 px, draws the 12 in choice exactly as main drew the field", () => {
    const { widthPx, heightPx } = golden.far;
    const view = viewAt(widthPx, heightPx);
    expect(view.pxPerIn * ftcTileSeam.depthIn * (24 / ftcTileSeam.edgeIn)).toBeLessThan(2);
    const calls = drawn("12", view, undefined, { widthPx, heightPx }).calls;
    expect({ count: calls.length, sha256: digest(calls) }).toEqual({ count: golden.far.count, sha256: golden.far.sha256 });
  });

  it("at a fitted zoom, draws everything but the seams exactly as main drew the field", () => {
    const { widthPx, heightPx } = golden.fittedWithoutSeams;
    const calls = withoutSeams(drawn("12", viewAt(widthPx, heightPx), undefined, { widthPx, heightPx }).calls);
    expect({ count: calls.length, sha256: digest(calls) }).toEqual({
      count: golden.fittedWithoutSeams.count,
      sha256: golden.fittedWithoutSeams.sha256,
    });
  });

  it("draws one more kind of line at 12 in and 6 in than Tiles, and no grid at Off", () => {
    const tiles = drawn("tiles");
    const twelve = drawn("12");
    const six = drawn("6");
    const off = drawn("off");
    expect(linesIn(tiles, theme.gridMinor)).toBe(0);
    expect(linesIn(tiles, theme.gridMajor)).toBeGreaterThan(0);
    expect(linesIn(twelve, theme.gridMinor)).toBeGreaterThan(0);
    expect(linesIn(six, theme.gridMinor)).toBeGreaterThan(linesIn(twelve, theme.gridMinor));
    // Tiles, 12 in and 6 in share the same seams and axis.
    expect(linesIn(twelve, theme.gridMajor)).toBe(linesIn(tiles, theme.gridMajor));
    expect(linesIn(six, theme.gridMajor)).toBe(linesIn(tiles, theme.gridMajor));
    expect(seamPaths(twelve)).toEqual(seamPaths(tiles));
    expect(seamPaths(six)).toEqual(seamPaths(tiles));
    expect(linesIn(twelve, theme.gridAxis)).toBe(linesIn(tiles, theme.gridAxis));
    expect(linesIn(tiles, theme.gridAxis)).toBeGreaterThan(0);
    expect(linesIn(off, theme.gridMinor) + linesIn(off, theme.gridMajor) + linesIn(off, theme.gridAxis)).toBe(0);
    expect(seamPaths(off)).toEqual([]);
  });

  it("is Tiles when the input names no grid, the default every preset has", () => {
    expect(drawn(undefined).calls).toEqual(drawn("tiles").calls);
  });

  it("draws the floor in every choice", () => {
    for (const choice of ["off", "tiles", "12", "6"] as const) {
      expect(drawn(choice).fills, choice).toContain(theme.fieldFloor);
    }
  });

  it("counts the lines of a 144 in field", () => {
    const twelve = drawn("12");
    // The seams on the wall, at -72 and 72 each way, stay straight; the 5 inside it each way are tabbed.
    expect(linesIn(twelve, theme.gridMajor)).toBe(4);
    expect(seamPaths(twelve)).toHaveLength(10);
    // Lines every 12 in skip the seams and the axis: -60, -36, -12, 12, 36, 60, each way.
    expect(linesIn(twelve, theme.gridMinor)).toBe(12);
    // Every 6 in skips only the seams and the axis: 18 positions each way.
    expect(linesIn(drawn("6"), theme.gridMinor)).toBe(36);
    // Zoomed far out the seams are main's straight ones, which skip the axis: -72, -48, -24, 24, 48, 72.
    const far = drawn("12", viewAt(480, 300), undefined, { widthPx: 480, heightPx: 300 });
    expect(linesIn(far, theme.gridMajor)).toBe(12);
    expect(seamPaths(far)).toEqual([]);
  });

  it("draws every seam inside the wall with the tiles' tabs at a fitted zoom (issue #428)", () => {
    const view = viewAt(1440, 900);
    const recorded = drawn("tiles", view);
    const scale = 24 / ftcTileSeam.edgeIn;
    const tabPx = Math.round((ftcTileSeam.depthIn / 2) * scale * view.pxPerIn);
    expect(tabPx).toBeGreaterThanOrEqual(1);
    const seams = seamPaths(recorded);
    const at = (inches: number, origin: number): number => Math.round(origin + inches * view.pxPerIn) + 0.5;
    const vertical = seams.filter((path) => path.points.every(([x]) => Math.abs(x - (path.points[0]?.[0] ?? 0)) <= tabPx + 0.01));
    const horizontal = seams.filter((path) => !vertical.includes(path));
    expect(vertical).toHaveLength(5);
    expect(horizontal).toHaveLength(5);
    const crossings = [-48, -24, 0, 24, 48];
    expect(vertical.map((path) => path.points[0]?.[0])).toEqual(crossings.map((xIn) => at(xIn, view.originXPx)));
    expect(horizontal.map((path) => path.points[0]?.[1])).toEqual(crossings.map((yIn) => at(-yIn, view.originYPx)));
    for (const path of seams) {
      const isVertical = vertical.includes(path);
      const across = path.points.map(([x, y]) => (isVertical ? x - (path.points[0]?.[0] ?? 0) : y - (path.points[0]?.[1] ?? 0)));
      const along = path.points.map(([x, y]) => (isVertical ? y : x));
      // Wall to wall, through 6 tiles: each tile's edge has 42 corners, 36 of them rounded.
      expect(path.points).toHaveLength(6 * 41 + 1);
      expect(path.arcs).toBe(6 * 36);
      expect(Math.min(...along)).toBeCloseTo(isVertical ? view.originYPx - 72 * view.pxPerIn : view.originXPx - 72 * view.pxPerIn, 6);
      expect(Math.max(...along)).toBeCloseTo(isVertical ? view.originYPx + 72 * view.pxPerIn : view.originXPx + 72 * view.pxPerIn, 6);
      // Every corner is on the seam's line or a tab's depth either side of it, on whole pixels.
      expect(new Set(across.map((offset) => Math.round(offset * 1000) / 1000))).toEqual(new Set([0, tabPx, -tabPx]));
    }
  });

  it("draws the seams straight once a tab would be under 2 px, and tabbed from there in", () => {
    const pxPerTabIn = ftcTileSeam.depthIn * (24 / ftcTileSeam.edgeIn);
    const base = viewAt(1440, 900);
    const atZoom = (pxPerIn: number): Recorded => drawn("tiles", { ...base, pxPerIn });
    expect(seamPaths(atZoom(1.99 / pxPerTabIn))).toEqual([]);
    expect(linesIn(atZoom(1.99 / pxPerTabIn), theme.gridMajor)).toBe(12);
    expect(seamPaths(atZoom(2.01 / pxPerTabIn))).toHaveLength(10);
    // Zoomed right in, the rounded corners are drawn at the CAD's radius.
    expect(seamPaths(atZoom(40)).every((path) => path.arcs === 6 * 36)).toBe(true);
    expect(atZoom(40).calls.filter((call) => call.startsWith("arcTo(")).every((call) => call.endsWith(`,${(ftcTileSeam.filletRadiusIn * (24 / ftcTileSeam.edgeIn) * 40).toFixed(4)})`))).toBe(true);
  });

  it("drops the finer lines when a spacing is under 2.5 px, for 12 in and for 6 in", () => {
    // 0.28 px per inch: 12 in is 3.3 px and kept, 6 in is 1.7 px and dropped.
    const far: View = { ...viewAt(40, 40), pxPerIn: 0.28 };
    expect(far.pxPerIn * 12).toBeGreaterThanOrEqual(2.5);
    expect(far.pxPerIn * 6).toBeLessThan(2.5);
    const at = (grid: FieldGrid): Recorded => drawn(grid, far, undefined, { widthPx: 40, heightPx: 40 });
    expect(linesIn(at("12"), theme.gridMinor)).toBeGreaterThan(0);
    expect(linesIn(at("6"), theme.gridMinor)).toBe(0);
    expect(linesIn(at("6"), theme.gridMajor)).toBeGreaterThan(0);
  });

  it("draws no grid over a field picture, whatever the choice", () => {
    const view = viewAt(1440, 900);
    const baseline = drawn("off", view, "outlines").calls;
    for (const choice of ["off", "tiles", "12", "6"] as const) {
      const outlines = drawn(choice, view, "outlines");
      expect(linesIn(outlines, theme.gridMinor) + linesIn(outlines, theme.gridMajor), choice).toBe(0);
      expect(outlines.calls, choice).toEqual(baseline);
    }
  });

  it("paints a field picture through the outlines mode, so the Grid choice never reaches it", () => {
    expect(pictureOverlay("image+outlines")).toEqual({ staticMode: "outlines", drawsOutlines: true });
    expect(pictureOverlay("image")).toEqual({ staticMode: undefined, drawsOutlines: false });
    // What FieldCanvas draws for the picture with outlines is drawStatic in that mode, for every choice.
    const mode = pictureOverlay("image+outlines").staticMode;
    for (const choice of ["off", "tiles", "12", "6"] as const) {
      const painted = drawn(choice, viewAt(1440, 900), mode);
      expect(linesIn(painted, theme.gridMinor) + linesIn(painted, theme.gridMajor), choice).toBe(0);
    }
  });

  it("names the spacings each choice draws", () => {
    expect(gridLineSpacingsIn("off")).toBeNull();
    expect(gridLineSpacingsIn("tiles")).toEqual({ seamIn: 24, lineIn: null });
    expect(gridLineSpacingsIn("12")).toEqual({ seamIn: 24, lineIn: 12 });
    expect(gridLineSpacingsIn("6")).toEqual({ seamIn: 24, lineIn: 6 });
  });
});
