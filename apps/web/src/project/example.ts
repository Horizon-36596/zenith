/**
 * `examples/starter`, bundled into the app with Vite's `?raw` imports so "Load example" works with
 * no folder picked and no network. It is read only: Save on the example never writes into the
 * repository the app was built from; it asks whether to save the full project or just the auto
 * somewhere of the person's choosing (`app/saveReadOnly.ts`).
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

/** The name the toolbar shows for autos opened on the example's robot and field. */
export const ON_EXAMPLE_NAME = "Example robot and field";

/**
 * Autos opened on their own, laid on the example's robot, field and waypoints (issue #103). Like
 * picked files it is read only, and it holds only these autos, not the example's own.
 */
export function exampleProjectWith(autoTexts: Readonly<Record<string, string>>): Project {
  return {
    ...loadExampleProject(),
    source: { kind: "files" },
    name: ON_EXAMPLE_NAME,
    autoFiles: Object.keys(autoTexts).sort((a, b) => a.localeCompare(b)),
    autoTexts: { ...autoTexts },
  };
}

/**
 * True when the project's `zenith.json` is the bundled example's: the example itself, or autos
 * opened on its robot and field (`exampleProjectWith`). Only then does Save the full project leave
 * out its sim command, robot class and command library, which name the example's made-up robot
 * repository (issue #159). Files opened on their own carry the team's own `zenith.json`, which the
 * full project keeps as it is.
 */
export function hasExampleLink(project: Pick<Project, "source" | "name">): boolean {
  return project.source.kind === "example" || (project.source.kind === "files" && project.name === ON_EXAMPLE_NAME);
}
