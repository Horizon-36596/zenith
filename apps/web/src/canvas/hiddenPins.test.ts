/**
 * Issues #211 and #217: by default the field draws only the waypoints the open auto follows
 * (Waypoint pins on This auto's, issue #236's show mode). Another waypoint is not drawn and cannot be
 * grabbed, unless it is selected (from the Inspector's Waypoints list), and then it takes the press
 * until it is deselected.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { waypointsUsed } from "@horizon36596/zenith-core";
import type { Auto, Waypoints } from "@horizon36596/zenith-schema";
import { describe, expect, it } from "vitest";
import { DEFAULT_PREFS } from "../state/prefs";
import { hiddenWaypointNames } from "../state/waypointPins";
import { projectPins } from "./liveLayer";
import { drawWaypoints, type StaticLayerInput } from "./staticLayer";
import { fallbackTheme } from "./theme";
import { orientationFor, type View } from "./view";

const read = (relative: string): unknown =>
  JSON.parse(readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8")) as unknown;

const waypoints = read("../../../../examples/starter/autos/waypoints.json") as Waypoints;
const firstAuto = read("../../../../examples/starter/autos/first-auto.auto.json") as Auto;
const followed = new Set(waypointsUsed(firstAuto));
const names = Object.keys(waypoints.waypoints);

const view = (pxPerIn: number): View => ({ pxPerIn, originXPx: 400, originYPx: 400, orientation: orientationFor("bottom") });

/** The pins hidden with the default show mode and no pin shown or hidden on its own. */
const hiddenByDefault = (): Set<string> =>
  hiddenWaypointNames({ waypoints, auto: firstAuto, mode: DEFAULT_PREFS.waypointPins, overrides: {}, projectKey: null });

/** How many pin rings drawWaypoints painted. */
function rings(hiddenWaypoints: ReadonlySet<string> | undefined): number {
  let count = 0;
  const ctx = new Proxy(
    {},
    {
      get(_target, key) {
        if (key === "arc") return () => (count += 1);
        if (key === "measureText") return () => ({ width: 10 });
        return () => undefined;
      },
      set: () => true,
    },
  );
  const input = {
    waypoints,
    ...(hiddenWaypoints === undefined ? {} : { hiddenWaypoints }),
    view: view(10),
    theme: fallbackTheme(),
  } as StaticLayerInput;
  drawWaypoints(ctx as unknown as CanvasRenderingContext2D, input);
  return count;
}

describe("waypoint pins the open auto does not follow", () => {
  it("are hidden by default, and the followed ones are not", () => {
    expect(followed.size).toBeGreaterThan(0);
    expect(followed.size).toBeLessThan(names.length);
    expect([...hiddenByDefault()].sort()).toEqual(names.filter((name) => !followed.has(name)).sort());
  });

  it("are not drawn; every pin is drawn when nothing is hidden", () => {
    expect(rings(hiddenByDefault())).toBe(followed.size);
    expect(rings(undefined)).toBe(names.length);
  });

  it("cannot be grabbed until selected, and then take the press", () => {
    const hidden = hiddenByDefault();
    const other = names.find((name) => !followed.has(name));
    if (other === undefined) throw new Error("every starter waypoint is followed");
    expect(projectPins(waypoints, view(10), undefined, hidden).map((pin) => pin.name).sort()).toEqual([...followed].sort());
    const selected = projectPins(waypoints, view(10), other, hidden);
    expect(selected.find((pin) => pin.name === other)).toMatchObject({ selected: true });
    expect(selected).toHaveLength(followed.size + 1);
  });
});
