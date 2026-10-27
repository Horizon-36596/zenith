/**
 * Closing the desktop app with unsaved edits (QA-12), and with the read-only example open (sweep
 * D4): there the question's Save is "Save a copy…", which saves through the native Save As dialog,
 * and the window is told it may close only once the copy is on disk. Cancelling that dialog, or a
 * failed write, keeps the window and the edits. Also Commit's "Nothing to commit" (sweep D8), the
 * git panel's buttons and their reasons, and the work a close would cut short.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { canonicalize, loadAuto, loadField, loadRobot } from "@horizon36596/zenith-core";
import type { Auto } from "@horizon36596/zenith-schema";
import { SCHEMA_ID } from "@horizon36596/zenith-schema";
import { beforeEach, describe, expect, it } from "vitest";
import { answerUnsaved } from "../app/unsaved";
import { commit, getState, isDirty, markSaved, openAuto, openProject } from "../state/store";
import type { ProjectBackend, SaveResult } from "./backend";
import { answerCloseRequest, busyWork, commitBlockedReason, gitButtons, savesOnlyACopy, type DesktopPanel } from "./desktopActions";
import type { DesktopGitStatus, ZenithDesktopBridge } from "./desktopBridge";
import type { Project } from "./types";

const examples = fileURLToPath(new URL("../../../../examples/starter/autos/", import.meta.url));
const read = (relative: string): unknown => JSON.parse(readFileSync(`${examples}${relative}`, "utf8"));

const projectOf = (source: Project["source"]): Project => ({
  source,
  name: "close-fixture",
  link: { autosDir: "autos", robot: "robot.json", field: "field.json" } as Project["link"],
  robot: loadRobot(read("robot.json")),
  field: loadField(read("field/biobuzz.field.json")),
  autoFiles: [],
  autoTexts: {},
});

const auto: Auto = loadAuto({
  $schema: SCHEMA_ID.auto,
  formatVersion: 1,
  name: "close-fixture",
  title: "Close fixture",
  alliance: "RED",
  start: { pose: { xIn: 0, yIn: 0, headingRad: 0 } },
  steps: [{ id: "wait", kind: "wait", seconds: 1 }],
});

function backendOf(kind: ProjectBackend["kind"]): ProjectBackend & { writes: number } {
  return {
    kind,
    canPropose: false,
    writes: 0,
    open: () => Promise.reject(new Error("not used")),
    listAutos: () => Promise.resolve([]),
    readAuto: () => Promise.reject(new Error("not used")),
    readText: () => Promise.reject(new Error("not used")),
    save(_name: string, text: string): Promise<SaveResult> {
      this.writes += 1;
      return Promise.resolve({ text });
    },
  };
}

/** A bridge that records the close answer and the copies asked for; `copy` decides what a copy does. */
function fakeBridge(copy: () => Promise<string | null>) {
  const answers: boolean[] = [];
  const copies: { name: string; text: string }[] = [];
  const bridge = {
    saveCopy: (name: string, text: string) => {
      copies.push({ name, text });
      return copy();
    },
    answerClose: (ok: boolean) => {
      answers.push(ok);
      return Promise.resolve();
    },
  } as unknown as ZenithDesktopBridge;
  return { bridge, answers, copies };
}

function openDirty(source: Project["source"], kind: ProjectBackend["kind"] = "local") {
  const store = backendOf(kind);
  openProject(projectOf(source), store);
  openAuto("close-fixture.auto.json", auto, canonicalize("auto", auto));
  commit({ ...auto, title: "Edited" });
  return store;
}

const settle = async (): Promise<void> => {
  for (let tries = 0; tries < 50; tries += 1) await Promise.resolve();
};

async function prompt() {
  for (let tries = 0; tries < 50 && getState().unsavedPrompt === null; tries += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  const shown = getState().unsavedPrompt;
  expect(shown).not.toBeNull();
  return shown;
}

beforeEach(() => {
  answerUnsaved("cancel");
});

describe("closing the desktop app with the read-only example open", () => {
  it("knows which projects can only be saved as a copy", () => {
    const local = backendOf("local");
    expect(savesOnlyACopy({ backend: local, project: projectOf({ kind: "example" }) })).toBe(true);
    expect(savesOnlyACopy({ backend: local, project: projectOf({ kind: "files" }) })).toBe(true);
    expect(savesOnlyACopy({ backend: local, project: projectOf({ kind: "desktop", root: "C:\\robot" }) })).toBe(false);
    expect(savesOnlyACopy({ backend: backendOf("host"), project: projectOf({ kind: "host", hostId: "dsim" }) })).toBe(false);
    expect(savesOnlyACopy({ backend: null, project: null })).toBe(false);
  });

  it("offers Save a copy…, and lets the window close only once the copy is written", async () => {
    const store = openDirty({ kind: "example" });
    let finish: (name: string | null) => void = () => undefined;
    const { bridge, answers, copies } = fakeBridge(() => new Promise((resolve) => (finish = resolve)));

    const closing = answerCloseRequest(bridge);
    const shown = await prompt();
    expect(shown?.saveLabel).toBe("Save a copy…");
    expect(shown?.next).toContain("Closing Zenith now would lose them.");
    expect(shown?.next).toContain("read only");
    answerUnsaved("save");

    // The Save As dialog is still open: nothing has told the window it may close.
    await settle();
    expect(copies).toHaveLength(1);
    expect(copies[0]?.name).toBe("close-fixture.auto.json");
    expect(JSON.parse(copies[0]?.text ?? "{}").title).toBe("Edited");
    expect(answers).toEqual([]);

    finish("close-fixture.auto.json");
    await closing;
    expect(answers).toEqual([true]);
    // The example itself is not written; the copy went to the file the person chose.
    expect(store.writes).toBe(0);
  });

  it("keeps the window and the edits when the Save As dialog is cancelled", async () => {
    openDirty({ kind: "example" });
    const { bridge, answers } = fakeBridge(() => Promise.resolve(null));
    const closing = answerCloseRequest(bridge);
    await prompt();
    answerUnsaved("save");
    await closing;
    expect(answers).toEqual([false]);
    expect(isDirty()).toBe(true);
    expect(getState().status?.message).toContain("stayed open");
  });

  it("keeps the window and says why when the copy cannot be written", async () => {
    openDirty({ kind: "files" });
    const { bridge, answers } = fakeBridge(() => Promise.reject(new Error("The disk is full.")));
    const closing = answerCloseRequest(bridge);
    await prompt();
    answerUnsaved("save");
    await closing;
    expect(answers).toEqual([false]);
    expect(getState().status?.message).toContain("The disk is full.");
  });

  it("asks the plain Save question for a repository, and saves in place", async () => {
    const store = openDirty({ kind: "desktop", root: "C:\\robot" });
    const { bridge, answers, copies } = fakeBridge(() => Promise.resolve("never"));
    const closing = answerCloseRequest(bridge);
    const shown = await prompt();
    expect(shown?.saveLabel).toBeUndefined();
    expect(shown?.next).toBe("Closing Zenith now would lose them.");
    answerUnsaved("save");
    await closing;
    expect(copies).toEqual([]);
    expect(store.writes).toBe(1);
    expect(answers).toEqual([true]);
  });
});

describe("Commit with nothing to commit", () => {
  const status = (changed: string[]): DesktopGitStatus => ({
    isRepo: true,
    branch: "auto/close-fixture/me",
    base: "main",
    onBase: false,
    workBranch: "auto/close-fixture/me",
    changedAutos: changed.map((path) => ({ path, status: " M" })),
    otherChanges: 0,
    hasRemote: true,
    ahead: 0,
  });
  const panel = (changed: string[], readAtSaved: string | null): Extract<DesktopPanel, { kind: "git" }> => ({
    kind: "git",
    fileName: "close-fixture.auto.json",
    status: status(changed),
    github: null,
    busy: null,
    log: [],
    error: null,
    prUrl: null,
    readAtSaved,
    confirmCommit: false,
  });

  it("says so when the open auto is the same as in the last commit", () => {
    openProject(projectOf({ kind: "desktop", root: "C:\\robot" }), backendOf("local"));
    openAuto("close-fixture.auto.json", auto, canonicalize("auto", auto));
    const saved = getState().savedCanonical;
    expect(commitBlockedReason(panel([], saved), getState())).toBe(
      "Nothing to commit: close-fixture.auto.json is the same as in the last commit.",
    );
    // Another auto changing does not make this one committable.
    expect(commitBlockedReason(panel(["autos/other.auto.json"], saved), getState())).not.toBeNull();
    expect(commitBlockedReason(panel(["autos/close-fixture.auto.json"], saved), getState())).toBeNull();
  });

  it("turns Commit back on for unsaved edits, and for a save since the status was read", () => {
    openProject(projectOf({ kind: "desktop", root: "C:\\robot" }), backendOf("local"));
    openAuto("close-fixture.auto.json", auto, canonicalize("auto", auto));
    const readAt = getState().savedCanonical;
    commit({ ...auto, title: "Edited" });
    expect(commitBlockedReason(panel([], readAt), getState())).toBeNull();
    markSaved(canonicalize("auto", getState().auto as Auto));
    expect(isDirty()).toBe(false);
    expect(commitBlockedReason(panel([], readAt), getState())).toBeNull();
  });

  it("gives every disabled git button a reason, and makes the next step the primary", () => {
    openProject(projectOf({ kind: "desktop", root: "C:\\robot" }), backendOf("local"));
    openAuto("close-fixture.auto.json", auto, canonicalize("auto", auto));
    const saved = getState().savedCanonical;
    const signedOut = { source: null, login: null, canStore: true } as const;

    // A changed auto: Commit is next, and the pull request waits for it.
    const changed = gitButtons({ ...panel(["autos/close-fixture.auto.json"], saved), github: signedOut }, getState());
    expect(changed).toMatchObject({ commit: null, primary: "commit", pr: "Commit close-fixture.auto.json first: a pull request holds only commits." });
    expect(changed.push).toBe("auto/close-fixture/me is already pushed: there is nothing new to push.");

    // Committed and not signed in: the pull request says why it is off.
    const committed = gitButtons({ ...panel([], saved), github: signedOut }, getState());
    expect(committed.pr).toBe("Sign in to GitHub to open the pull request.");
    expect(committed.commit).toMatch(/^Nothing to commit/);

    // Committed and signed in: Open pull request is next.
    const ready = gitButtons({ ...panel([], saved), github: { source: "gh", login: "me", canStore: true } }, getState());
    expect(ready).toMatchObject({ pr: null, primary: "pr" });

    // On the base branch nothing can be pushed, and the panel says why.
    const onBase = panel(["autos/close-fixture.auto.json"], saved);
    const base = gitButtons({ ...onBase, status: { ...(onBase.status as DesktopGitStatus), onBase: true, branch: "main" } }, getState());
    expect(base.push).toMatch(/^You are on main, the base branch, which Zenith never pushes\./);
    expect(base.pr).toBe(base.push);
  });
});

describe("busyWork", () => {
  it("names the work a close would cut short, and nothing when idle", () => {
    expect(busyWork({ kind: "none" })).toBeNull();
    expect(busyWork({ kind: "sim", phase: "running" } as DesktopPanel)).toBe("A sim is running. Closing Zenith stops it.");
    expect(busyWork({ kind: "sim", phase: "done" } as DesktopPanel)).toBeNull();
    expect(busyWork({ kind: "deploy", phase: "running", result: null, message: null })).toMatch(/^A deploy is running\./);
  });
});
