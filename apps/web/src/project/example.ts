/**
 * `examples/starter`, bundled into the app with Vite's `?raw` imports so "Load example" works with
 * no folder picked and no network. It is read only: Save on the example downloads the canonical
 * file rather than writing into the repository the app was built from.
 *
 * The autos are every `*.auto.json` in the example's `autos/` folder, found by Vite's glob import,
 * so a new example auto appears in the picker without a code change.
 */
import { loadField, loadLink, loadRobot, loadWaypoints } from "@horizon36596/zenith-core";
import fieldText from "../../../../examples/starter/autos/field/biobuzz.field.json?raw";
import robotText from "../../../../examples/starter/autos/robot.json?raw";
import waypointsText from "../../../../examples/starter/autos/waypoints.json?raw";
import linkText from "../../../../examples/starter/zenith.json?raw";
import type { Project } from "./types";

export const EXAMPLE_NAME = "examples/starter";

const AUTO_TEXTS: Record<string, string> = Object.fromEntries(
  Object.entries(
    import.meta.glob<string>("../../../../examples/starter/autos/*.auto.json", {
      eager: true,
      query: "?raw",
      import: "default",
    }),
  )
    .map(([path, text]): [string, string] => [path.slice(path.lastIndexOf("/") + 1), text])
    .sort(([a], [b]) => a.localeCompare(b)),
);

/** The bundled project. Parsing happens here so a malformed example fails loudly at load. */
export function loadExampleProject(): Project {
  return {
    source: { kind: "example" },
    name: EXAMPLE_NAME,
    link: loadLink(JSON.parse(linkText)),
    robot: loadRobot(JSON.parse(robotText)),
    field: loadField(JSON.parse(fieldText)),
    waypoints: loadWaypoints(JSON.parse(waypointsText)),
    autoFiles: Object.keys(AUTO_TEXTS),
    autoTexts: { ...AUTO_TEXTS },
  };
}
