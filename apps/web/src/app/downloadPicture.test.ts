import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { canonicalize, loadAuto, loadField, loadRobot, loadWaypoints } from "@horizon36596/zenith-core";
import { describe, expect, it, vi } from "vitest";
import type { ProjectBackend } from "../project/backend";
import { saveFileAs } from "../project/fallback";
import type { Project } from "../project/types";
import { derive } from "../state/derived";
import { getState, openAuto, openProject } from "../state/store";
import { ACTIONS } from "./actions";
import { buildPictureSvg, downloadPicture, pictureFileName, svgPixelSize } from "./downloadPicture";

vi.mock("../project/fallback", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../project/fallback")>()),
  saveFileAs: vi.fn(async (name: string) => ({ name, how: "downloaded" as const })),
}));

/**
 * "Download picture" gives the editor the picture `zenith render` already writes: core's own SVG
 * from the derived results, with no field photograph, and a PNG made from it at twice the size.
 */
const repo = fileURLToPath(new URL("../../../../", import.meta.url));
const read = (path: string): unknown => JSON.parse(readFileSync(`${repo}examples/starter/${path}`, "utf8")) as unknown;
const robot = loadRobot(read("autos/robot.json"));
const field = loadField(read("autos/field/biobuzz.field.json"));
const waypoints = loadWaypoints(read("autos/waypoints.json"));
const auto = loadAuto(read("autos/collect-and-score.auto.json"));

describe("pictureFileName", () => {
  it("names the file after the auto, the alliance viewed and the format", () => {
    expect(pictureFileName("collect-and-score", "RED", "png")).toBe("collect-and-score.red.png");
    expect(pictureFileName("collect-and-score", "BLUE", "svg")).toBe("collect-and-score.blue.svg");
  });
});

describe("buildPictureSvg", () => {
  const derived = derive(auto, robot, field, waypoints);

  it("draws the auto's title and no field photograph", () => {
    const built = buildPictureSvg(derived, { alliance: "RED", showLedger: false, waypoints });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.svg.startsWith("<svg")).toBe(true);
    expect(built.svg).toContain(auto.title ?? auto.name);
    expect(built.svg).not.toContain("<image");
  });

  it("follows the alliance being viewed", () => {
    const red = buildPictureSvg(derived, { alliance: "RED", showLedger: false, waypoints });
    const blue = buildPictureSvg(derived, { alliance: "BLUE", showLedger: false, waypoints });
    expect(red.ok && blue.ok).toBe(true);
    if (!red.ok || !blue.ok) return;
    expect(red.svg).not.toBe(blue.svg);
  });

  it("is wider with the ledger shown", () => {
    const without = buildPictureSvg(derived, { alliance: "RED", showLedger: false, waypoints });
    const withLedger = buildPictureSvg(derived, { alliance: "RED", showLedger: true, waypoints });
    if (!without.ok || !withLedger.ok) throw new Error("no picture");
    expect(svgPixelSize(withLedger.svg)?.width ?? 0).toBeGreaterThanOrEqual(svgPixelSize(without.svg)?.width ?? 0);
  });

  it("leaves out the pins the field hides (issue #236)", () => {
    const every = buildPictureSvg(derived, { alliance: "RED", showLedger: false, waypoints });
    const some = buildPictureSvg(derived, { alliance: "RED", showLedger: false, waypoints, hiddenWaypoints: ["park"] });
    if (!every.ok || !some.ok) throw new Error("no picture");
    expect(every.svg).toContain(">park</text>");
    expect(some.svg).not.toContain(">park</text>");
    expect(some.svg).toContain(">scoreSouth</text>");
  });

  it("says why there is no picture when there is no plan", () => {
    const built = buildPictureSvg({ plan: null, estimate: null, findings: [], ledger: [] }, { alliance: "RED", showLedger: false });
    expect(built.ok).toBe(false);
  });
});

describe("svgPixelSize", () => {
  it("reads the root element's width and height", () => {
    expect(svgPixelSize('<svg xmlns="http://www.w3.org/2000/svg" width="760" height="520.5" viewBox="0 0 760 520.5"><rect width="9" height="9"/></svg>')).toEqual({ width: 760, height: 520.5 });
  });

  it("is null when the root declares no size", () => {
    expect(svgPixelSize('<svg viewBox="0 0 1 1"><rect width="9" height="9"/></svg>')).toBeNull();
  });
});

describe("downloadPicture", () => {
  it("downloads the SVG as an SVG, not as JSON", async () => {
    const project: Project = {
      source: { kind: "example" },
      name: "picture-fixture",
      link: { autosDir: "autos", robot: "robot.json", field: "field.json", waypoints: "waypoints.json" } as Project["link"],
      robot,
      field,
      waypoints,
      autoFiles: [],
      autoTexts: {},
    };
    openProject(project, {} as ProjectBackend);
    openAuto("collect-and-score.auto.json", auto, canonicalize("auto", auto));
    await downloadPicture("svg");
    expect(getState().status?.kind).toBe("ok");
    expect(vi.mocked(saveFileAs)).toHaveBeenCalledWith("collect-and-score.red.svg", expect.stringMatching(/^<svg/), "image/svg+xml");
  });
});

describe("the actions", () => {
  it("offers both formats in the project group, with the words people search for", () => {
    for (const [id, format] of [
      ["project.downloadPicture", "png"],
      ["project.downloadPictureSvg", "svg"],
    ] as const) {
      const action = ACTIONS.find((candidate) => candidate.id === id);
      expect(action?.group, id).toBe("project");
      expect(action?.label.toLowerCase(), id).toContain(format);
      expect(action?.keywords, id).toEqual(expect.arrayContaining(["png", "svg", "picture", "image", "export", "print"]));
      const noAuto = { auto: null, project: null, review: null } as unknown as Parameters<NonNullable<NonNullable<typeof action>["whyDisabled"]>>[0];
      expect(action?.whyDisabled?.(noAuto), id).toBe("Open an auto first.");
    }
  });

  it("sits right after Save a copy", () => {
    const ids = ACTIONS.map((action) => action.id);
    const at = ids.indexOf("project.saveCopy");
    expect(ids.slice(at + 1, at + 3)).toEqual(["project.downloadPicture", "project.downloadPictureSvg"]);
  });
});
