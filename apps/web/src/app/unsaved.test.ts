/**
 * The question before the open auto is replaced (QA-12): no question when there is nothing to
 * lose, and with unsaved edits Cancel keeps them, Discard lets the replacement go ahead, and Save
 * goes ahead only once the save has gone through.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { canonicalize, loadAuto, loadField, loadRobot } from "@horizon36596/zenith-core";
import type { Auto } from "@horizon36596/zenith-schema";
import { SCHEMA_ID } from "@horizon36596/zenith-schema";
import { beforeEach, describe, expect, it } from "vitest";
import type { ProjectBackend, SaveResult } from "../project/backend";
import type { Project } from "../project/types";
import { commit, getState, isDirty, openAuto, openProject } from "../state/store";
import { answerUnsaved, confirmReplace } from "./unsaved";

const examples = fileURLToPath(new URL("../../../../examples/starter/autos/", import.meta.url));
const read = (relative: string): unknown => JSON.parse(readFileSync(`${examples}${relative}`, "utf8"));

const project: Project = {
  source: { kind: "example" },
  name: "unsaved-fixture",
  link: { autosDir: "autos", robot: "robot.json", field: "field.json" } as Project["link"],
  robot: loadRobot(read("robot.json")),
  field: loadField(read("field/biobuzz.field.json")),
  autoFiles: [],
  autoTexts: {},
};

const auto: Auto = loadAuto({
  $schema: SCHEMA_ID.auto,
  formatVersion: 1,
  name: "unsaved-fixture",
  title: "Unsaved fixture",
  alliance: "RED",
  start: { pose: { xIn: 0, yIn: 0, headingRad: 0 } },
  steps: [{ id: "wait", kind: "wait", seconds: 1 }],
});

/** A backend whose save either writes what it is given or fails, and counts the writes. */
function backend(fails: boolean): ProjectBackend & { writes: number } {
  return {
    kind: "local",
    canPropose: false,
    writes: 0,
    open: () => Promise.resolve(project),
    listAutos: () => Promise.resolve([]),
    readAuto: () => Promise.reject(new Error("not used")),
    readText: () => Promise.reject(new Error("not used")),
    save(_name: string, text: string): Promise<SaveResult> {
      if (fails) return Promise.reject(new Error("the disk is full"));
      this.writes += 1;
      return Promise.resolve({ text });
    },
  };
}

function openDirty(fails = false): ProjectBackend & { writes: number } {
  const store = backend(fails);
  openProject(project, store);
  openAuto("unsaved-fixture.auto.json", auto, canonicalize("auto", auto));
  commit({ ...auto, title: "Edited" });
  return store;
}

/** Waits until the question is showing, then answers it. */
async function answer(choice: "save" | "discard" | "cancel"): Promise<void> {
  for (let tries = 0; tries < 50 && getState().unsavedPrompt === null; tries += 1) {
    await Promise.resolve();
  }
  expect(getState().unsavedPrompt?.fileName).toBe("unsaved-fixture.auto.json");
  answerUnsaved(choice);
}

beforeEach(() => {
  answerUnsaved("cancel");
});

describe("replacing the open auto", () => {
  it("goes ahead without a question when nothing is unsaved", async () => {
    openProject(project, backend(false));
    openAuto("unsaved-fixture.auto.json", auto, canonicalize("auto", auto));
    expect(await confirmReplace("Opening the example will close it.")).toBe(true);
    expect(getState().unsavedPrompt).toBeNull();
  });

  it("keeps the edits on Cancel", async () => {
    openDirty();
    const going = confirmReplace("Opening first-auto.auto.json will replace it.");
    await answer("cancel");
    expect(await going).toBe(false);
    expect(isDirty()).toBe(true);
    expect(getState().unsavedPrompt).toBeNull();
  });

  it("goes ahead on Discard, without saving", async () => {
    const store = openDirty();
    const going = confirmReplace("Opening first-auto.auto.json will replace it.");
    await answer("discard");
    expect(await going).toBe(true);
    expect(store.writes).toBe(0);
  });

  it("saves, then goes ahead, on Save", async () => {
    const store = openDirty();
    const going = confirmReplace("Opening first-auto.auto.json will replace it.");
    await answer("save");
    expect(await going).toBe(true);
    expect(store.writes).toBe(1);
    expect(isDirty()).toBe(false);
  });

  it("stays put when the save fails", async () => {
    openDirty(true);
    const going = confirmReplace("Opening first-auto.auto.json will replace it.");
    await answer("save");
    expect(await going).toBe(false);
    expect(isDirty()).toBe(true);
    expect(getState().status?.message).toContain("the disk is full");
  });
});
