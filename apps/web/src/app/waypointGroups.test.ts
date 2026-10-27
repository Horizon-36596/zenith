/**
 * Issue #217: the Inspector's Waypoints list leads with the waypoints the open auto follows, puts
 * the rest under "Other waypoints", and marks one that no auto in the project follows.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { State } from "../state/store";
import { groupWaypoints, unusedByAnyAuto, waypointsUsedElsewhere } from "./waypointGroups";

const STARTER = new URL("../../../../examples/starter/autos/", import.meta.url);
const read = (file: string): string => readFileSync(new URL(file, STARTER), "utf8");

/** A project of starter autos, `open` among them, as far as the other-autos reader looks. */
function stateWith(open: string, texts: Record<string, string>): State {
  return {
    fileName: open,
    backend: null,
    project: { name: "starter", autoFiles: Object.keys(texts), autoTexts: texts, link: { autosDir: "autos" } },
  } as unknown as State;
}

describe("the Waypoints list's groups", () => {
  it("puts the open auto's waypoints first and every other one after, each in the file's order", () => {
    const names = ["start", "scoreSouth", "park", "gardenSweepStart", "parkLoadingZone"];
    expect(groupWaypoints(names, new Set(["gardenSweepStart", "start"]))).toEqual({
      here: ["start", "gardenSweepStart"],
      others: ["scoreSouth", "park", "parkLoadingZone"],
    });
    expect(groupWaypoints(names, new Set())).toEqual({ here: [], others: names });
  });

  it("calls a waypoint unused only when neither the open auto nor any other one follows it", () => {
    const here = new Set(["start"]);
    expect(unusedByAnyAuto("park", here, new Set(["scoreSouth"]))).toBe(true);
    expect(unusedByAnyAuto("park", here, new Set(["park"]))).toBe(false);
    expect(unusedByAnyAuto("start", here, new Set())).toBe(false);
    // Until the other autos are read, nothing is called unused.
    expect(unusedByAnyAuto("park", here, null)).toBe(false);
  });

  it("reads which waypoints the other autos follow, leaving the open one out", async () => {
    const used = await waypointsUsedElsewhere(
      stateWith("collect-and-score.auto.json", {
        "collect-and-score.auto.json": read("collect-and-score.auto.json"),
        "first-auto.auto.json": read("first-auto.auto.json"),
      }),
    );
    expect(used === null ? null : [...used].sort()).toEqual(["park", "scoreSouth", "start"]);
  });

  it("gives no answer when another auto cannot be read", async () => {
    const used = await waypointsUsedElsewhere(
      stateWith("first-auto.auto.json", { "first-auto.auto.json": read("first-auto.auto.json"), "broken.auto.json": "{" }),
    );
    expect(used).toBeNull();
  });
});
