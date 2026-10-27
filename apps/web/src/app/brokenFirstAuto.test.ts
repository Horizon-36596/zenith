/**
 * A project whose first auto does not load (the 0.1.2 UX sweep, W3-3): the next auto that loads opens
 * instead, and the status line names the broken file. A host's own pick never falls through to
 * another auto, and an open that begins while the fallback is read wins without being talked over.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadField, loadLink, loadRobot, loadWaypoints } from "@horizon36596/zenith-core";
import { LocalBackend } from "../project/backend";
import type { LoadedAuto, Project } from "../project/types";
import { clearStatus, closeProject, getState } from "../state/store";
import { adoptBackend, openAutoNamed } from "./projectActions";
import { answerUnsaved } from "./unsaved";

const read = (path: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../../examples/starter/${path}`, import.meta.url)), "utf8");

const BROKEN = "a-broken.auto.json";
const BROKEN_LINE = `${BROKEN} is not valid JSON (line 1, column 3). Fix it, or restore it from git.`;

/** The starter's robot and field, with a broken auto that sorts first and two good ones after it. */
function project(): Project {
  const autoTexts: Record<string, string> = {
    [BROKEN]: "{ oops",
    "collect-and-score.auto.json": read("autos/collect-and-score.auto.json"),
    "first-auto.auto.json": read("autos/first-auto.auto.json"),
  };
  return {
    source: { kind: "files" },
    name: "Picked files",
    link: loadLink(JSON.parse(read("zenith.json"))),
    robot: loadRobot(JSON.parse(read("autos/robot.json"))),
    field: loadField(JSON.parse(read("autos/field/biobuzz.field.json"))),
    waypoints: loadWaypoints(JSON.parse(read("autos/waypoints.json"))),
    autoFiles: Object.keys(autoTexts).sort((a, b) => a.localeCompare(b)),
    autoTexts,
  };
}

const turns = async (count: number): Promise<void> => {
  for (let turn = 0; turn < count; turn += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

beforeEach(() => {
  answerUnsaved("cancel");
  closeProject();
  clearStatus();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a project whose first auto does not load", () => {
  it("opens the next auto that loads, and names the broken file", async () => {
    expect(await adoptBackend(LocalBackend.of(project()))).toBe(false);
    expect(getState().fileName).toBe("collect-and-score.auto.json");
    expect(getState().status?.message).toBe(`${BROKEN_LINE} Opened collect-and-score.auto.json instead.`);
  });

  it("opens nothing else when a host asked for that auto, so Save never sends back one it did not ask for", async () => {
    expect(await adoptBackend(LocalBackend.of(project()), BROKEN, "Another project will close it.", true)).toBe(false);
    expect(getState().fileName).toBeNull();
    expect(getState().status?.message).toBe(BROKEN_LINE);
  });

  it("still opens a host's pick that loads", async () => {
    expect(await adoptBackend(LocalBackend.of(project()), "first-auto.auto.json", "Another project will close it.", true)).toBe(true);
    expect(getState().fileName).toBe("first-auto.auto.json");
  });

  it("lets an open that began while the fallback was read win, without saying the fallback opened", async () => {
    const backend = LocalBackend.of(project());
    const readAuto = backend.readAuto.bind(backend);
    let release: (() => void) | null = null;
    vi.spyOn(backend, "readAuto").mockImplementation((name: string) =>
      name !== "collect-and-score.auto.json" || release !== null
        ? readAuto(name)
        : new Promise<LoadedAuto>((resolve, reject) => {
            release = () => {
              readAuto(name).then(resolve, reject);
            };
          }),
    );
    const adopting = adoptBackend(backend);
    for (let turn = 0; turn < 50 && release === null; turn += 1) await turns(1);
    await openAutoNamed("first-auto.auto.json");
    expect(getState().fileName).toBe("first-auto.auto.json");
    (release as unknown as () => void)();
    expect(await adopting).toBe(false);
    await turns(10);
    expect(getState().fileName).toBe("first-auto.auto.json");
    expect(getState().status?.message ?? "").not.toContain("instead");
  });
});
