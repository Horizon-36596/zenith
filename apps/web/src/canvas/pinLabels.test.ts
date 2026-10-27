/**
 * Waypoint pin names (issue #235): drawn in the waypoint colour and a style of their own, so
 * 'scoreSouth' no longer reads as a step name; a name whose box would overlap another pin's name is
 * dropped, the selected pin always keeps its name and otherwise the first by name wins; and the hit
 * boxes projectPins gives follow the same culling, so a hit area is where a name is drawn.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadField } from "@horizon36596/zenith-core";
import type { Waypoints } from "@horizon36596/zenith-schema";
import { describe, expect, it } from "vitest";
import { projectPins } from "./liveLayer";
import { drawStatic, pinLabelBoxes } from "./staticLayer";
import { fallbackTheme } from "./theme";
import { orientationFor, worldToScreen, zoomAbout, fitView, type View } from "./view";

const read = (relative: string): unknown =>
  JSON.parse(readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8")) as unknown;

const field = loadField(read("../../../../examples/starter/autos/field/biobuzz.field.json"));
const starter = read("../../../../examples/starter/autos/waypoints.json") as Waypoints;
// The starter once had gardenPickup an inch from gardenSweepEnd (issue #211 dropped it as unused);
// it is put back here, where it was, as the pair of pins whose names would overlap.
const example = {
  ...starter,
  waypoints: { ...starter.waypoints, gardenPickup: { xIn: -61, yIn: -62, headingRad: -1.5708, provenance: "PLACEHOLDER: test" } },
} as unknown as Waypoints;

const WIDTH_PX = 1440;
const HEIGHT_PX = 900;
const theme = fallbackTheme();
const fitted = fitView({ minXIn: -72, minYIn: -72, maxXIn: 72, maxYIn: 72 }, WIDTH_PX, HEIGHT_PX, 24, orientationFor("bottom"));

/** The view zoomed in to `pxPerIn`, about the screen point where inch (xIn, yIn) sits. */
function zoomedTo(pxPerIn: number, xIn: number, yIn: number): View {
  const anchor = worldToScreen(fitted, { xIn, yIn });
  return zoomAbout(fitted, anchor, pxPerIn / fitted.pxPerIn);
}

const pose = (xIn: number, yIn: number) => ({ xIn, yIn, headingRad: 0, provenance: "PLACEHOLDER" });
const two = (): Waypoints =>
  ({ formatVersion: 1, waypoints: { zebra: pose(0, 0), apple: pose(0.5, 0) } }) as unknown as Waypoints;

const overlap = (a: { x0Px: number; y0Px: number; x1Px: number; y1Px: number }, b: typeof a): boolean =>
  a.x0Px < b.x1Px && b.x0Px < a.x1Px && a.y0Px < b.y1Px && b.y0Px < a.y1Px;

describe("which pin names are drawn", () => {
  const view = zoomedTo(12, 0, 0);

  it("draws one of two overlapping names, the first by name", () => {
    const boxes = pinLabelBoxes(two(), view, undefined);
    expect([...boxes.keys()]).toEqual(["apple"]);
  });

  it("keeps the selected pin's name, and drops the other", () => {
    const boxes = pinLabelBoxes(two(), view, "zebra");
    expect([...boxes.keys()]).toEqual(["zebra"]);
  });

  it("draws both when they do not overlap", () => {
    const apart = { formatVersion: 1, waypoints: { zebra: pose(0, 0), apple: pose(20, 0) } } as unknown as Waypoints;
    expect([...pinLabelBoxes(apart, view, undefined).keys()].sort()).toEqual(["apple", "zebra"]);
  });

  it("draws no names below the label zoom, selected or not", () => {
    expect(pinLabelBoxes(two(), fitted, "zebra").size).toBe(0);
  });

  it("gives the same answer whatever order the file lists the pins in", () => {
    const reversed = { formatVersion: 1, waypoints: { apple: pose(0.5, 0), zebra: pose(0, 0) } } as unknown as Waypoints;
    expect([...pinLabelBoxes(reversed, view, undefined).keys()]).toEqual(["apple"]);
  });
});

describe("the example at 8.8 px per inch", () => {
  const view = zoomedTo(8.8, -61, -62);
  const labelled = projectPins(example, view, undefined).filter((pin) => pin.label !== null && pin.label !== undefined);

  it("draws gardenPickup and gardenSweepEnd without overlap, and no two names overlap anywhere", () => {
    const names = labelled.map((pin) => pin.name);
    expect(names.filter((name) => name === "gardenPickup" || name === "gardenSweepEnd")).toHaveLength(1);
    for (const [index, a] of labelled.entries()) {
      for (const b of labelled.slice(index + 1)) {
        expect(overlap(a.label!, b.label!), `${a.name} and ${b.name}`).toBe(false);
      }
    }
  });

  it("gives the hit boxes of exactly the names the static layer draws", () => {
    const boxes = pinLabelBoxes(example, view, "gardenSweepEnd");
    const pins = projectPins(example, view, "gardenSweepEnd").filter((pin) => pin.label !== null && pin.label !== undefined);
    expect(pins.map((pin) => pin.name).sort()).toEqual([...boxes.keys()].sort());
    expect(pins.map((pin) => pin.name)).toContain("gardenSweepEnd");
    expect(pins.map((pin) => pin.name)).not.toContain("gardenPickup");
  });
});

/** A 2D context that records each fillText with the fill colour and font in force. */
function recordingContext(): { ctx: CanvasRenderingContext2D; texts: { text: string; fill: string; font: string }[] } {
  const texts: { text: string; fill: string; font: string }[] = [];
  const state: Record<string, unknown> = { fillStyle: "", strokeStyle: "", font: "" };
  const ctx = new Proxy(state, {
    get(target, key: string) {
      if (key in target) return target[key];
      if (key === "fillText") {
        return (text: string) => {
          texts.push({ text, fill: String(target["fillStyle"]), font: String(target["font"]) });
        };
      }
      return () => undefined;
    },
    set(target, key: string, value: unknown) {
      target[key] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, texts };
}

describe("how a pin name is drawn", () => {
  it("uses the waypoint colour and a font that is not the step labels' 10 px mono", () => {
    const { ctx, texts } = recordingContext();
    const view = zoomedTo(12, 0, 0);
    drawStatic(ctx, { field, waypoints: two(), robotHeightIn: 14, view, theme, widthPx: WIDTH_PX, heightPx: HEIGHT_PX });
    const names = texts.filter((entry) => entry.text === "apple");
    expect(names).toHaveLength(1);
    expect(names[0]?.fill).toBe(theme.fieldWaypoint);
    expect(names[0]?.font).not.toBe(`10px ${theme.fontMono}`);
    expect(names[0]?.font).toMatch(/^(italic )?(600|bold)/);
  });

  it("draws the selected pin's name when it would have been dropped", () => {
    const { ctx, texts } = recordingContext();
    const view = zoomedTo(12, 0, 0);
    drawStatic(ctx, { field, waypoints: two(), robotHeightIn: 14, view, theme, widthPx: WIDTH_PX, heightPx: HEIGHT_PX, selectedWaypoint: "zebra" });
    expect(texts.map((entry) => entry.text).filter((text) => text === "zebra" || text === "apple")).toEqual(["zebra"]);
  });
});

// Issue #236: a hidden pin is not drawn, takes no name's room and is out of the hit scene, except
// the selected one, which the live layer still draws, faint and dashed, and which can be dragged.
describe("hidden pins", () => {
  const view = zoomedTo(12, 0, 0);
  const hidden = new Set(["apple"]);

  it("are not drawn and give their name's room to the next pin", () => {
    const { ctx, texts } = recordingContext();
    drawStatic(ctx, { field, waypoints: two(), robotHeightIn: 14, view, theme, widthPx: WIDTH_PX, heightPx: HEIGHT_PX, hiddenWaypoints: hidden });
    expect(texts.map((entry) => entry.text).filter((text) => text === "zebra" || text === "apple")).toEqual(["zebra"]);
    expect([...pinLabelBoxes(two(), view, undefined, hidden).keys()]).toEqual(["zebra"]);
  });

  it("are left out of the pins the pointer can reach, but for the selected one", () => {
    expect(projectPins(two(), view, undefined, hidden).map((pin) => pin.name)).toEqual(["zebra"]);
    expect(projectPins(two(), view, "apple", hidden).map((pin) => pin.name).sort()).toEqual(["apple", "zebra"]);
    expect(projectPins(two(), view, undefined, new Set(["apple", "zebra"]))).toEqual([]);
  });
});
