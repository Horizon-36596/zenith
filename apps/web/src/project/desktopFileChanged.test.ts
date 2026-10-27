/**
 * An external change to the open auto reloads it (issue #380 finding 1). The read is a round trip
 * to the main process, so the reload must not replace an auto the person edited, or swap back one
 * they navigated away from, while it was in flight. With unsaved edits it asks, Keep mine or Reload
 * from disk, and a change to a project file keeps edits made while the project was read (#394).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { canonicalize, loadAuto } from "@horizon36596/zenith-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commit, getState, isDirty, openAuto, openProject } from "../state/store";
import { DesktopBackend } from "./desktop";
import { answerQuestion, getQuestion, onFileChanged, setAdoptForTests } from "./desktopActions";
import { DESKTOP_API_VERSION, type ZenithDesktopBridge } from "./desktopBridge";

const read = (path: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../../examples/starter/${path}`, import.meta.url)), "utf8");

const ROOT = "C:/repo";
const FIRST = "first-auto.auto.json";
const OTHER = "cycle-and-park.auto.json";
const firstText = read(`autos/${FIRST}`);
const diskText = JSON.stringify({ ...(JSON.parse(firstText) as Record<string, unknown>), title: "Changed on disk" });

const files: Record<string, string> = {
  "zenith.json": read("zenith.json"),
  "autos/robot.json": read("autos/robot.json"),
  "autos/field/biobuzz.field.json": read("autos/field/biobuzz.field.json"),
  "autos/waypoints.json": read("autos/waypoints.json"),
};

/**
 * A bridge over the starter's files whose read of `held` (the open auto unless a test says otherwise)
 * waits until `release` is called.
 */
function deferredBridge(held = `autos/${FIRST}`) {
  let release: (text: string) => void = () => undefined;
  const bridge = {
    apiVersion: DESKTOP_API_VERSION,
    project: {
      read: (_root: string, path: string) => {
        if (path === held) {
          return new Promise<string>((resolve) => {
            release = resolve;
          });
        }
        const text = files[path];
        return text === undefined ? Promise.reject(new Error(`Could not read ${path}.`)) : Promise.resolve(text);
      },
      listAutos: () => Promise.resolve([OTHER, FIRST]),
      watch: () => Promise.resolve(),
    },
  } as unknown as ZenithDesktopBridge;
  return { bridge, release: (text: string) => release(text) };
}

async function openDesktop(bridge: ZenithDesktopBridge): Promise<DesktopBackend> {
  vi.stubGlobal("window", { zenithDesktop: bridge });
  const backend = new DesktopBackend(bridge, { root: ROOT, name: "repo" });
  openProject(await backend.open(), backend);
  const auto = loadAuto(JSON.parse(firstText));
  openAuto(FIRST, auto, canonicalize("auto", auto));
  return backend;
}

/** Lets the pending read reach the bridge before the test acts. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("onFileChanged", () => {
  let fake: ReturnType<typeof deferredBridge>;
  beforeEach(async () => {
    fake = deferredBridge();
    await openDesktop(fake.bridge);
  });
  afterEach(() => {
    answerQuestion(false);
    vi.unstubAllGlobals();
  });

  it("reloads the open auto when nothing happened during the read", async () => {
    const pending = onFileChanged({ root: ROOT, path: `autos/${FIRST}` });
    await settle();
    fake.release(diskText);
    await pending;
    expect(getState().auto?.title).toBe("Changed on disk");
    expect(isDirty()).toBe(false);
  });

  /** Edits the open auto while its changed file is being read, then lets the read finish. */
  async function editDuringRead(): Promise<{ pending: Promise<void> }> {
    const pending = onFileChanged({ root: ROOT, path: `autos/${FIRST}` });
    await settle();
    const auto = getState().auto;
    if (auto === null) throw new Error("no auto open");
    commit({ ...auto, title: "Edited here" });
    fake.release(diskText);
    await settle();
    return { pending };
  }

  it("asks, and Keep mine keeps edits made while the changed file was being read", async () => {
    const { pending } = await editDuringRead();
    expect(getQuestion()).toMatchObject({ testId: "desktop-file-conflict", cancel: "Keep mine", confirm: "Reload from disk" });
    answerQuestion(false);
    await pending;
    expect(getQuestion()).toBeNull();
    expect(getState().auto?.title).toBe("Edited here");
    expect(getState().undo.length).toBe(1);
    expect(getState().status?.message).toBe(`Kept your edits to ${FIRST}.`);
  });

  it("asks, and Reload from disk drops the edits for the file on disk", async () => {
    const { pending } = await editDuringRead();
    answerQuestion(true);
    await settle();
    // The answer reads the file again, which this bridge holds as well.
    fake.release(diskText);
    await pending;
    expect(getState().auto?.title).toBe("Changed on disk");
    expect(isDirty()).toBe(false);
    expect(getState().status?.message).toBe(`Reloaded ${FIRST} from disk. Your edits were dropped.`);
  });

  it("does not swap back to the changed auto when another was opened during the read", async () => {
    const pending = onFileChanged({ root: ROOT, path: `autos/${FIRST}` });
    await settle();
    const other = loadAuto(JSON.parse(read(`autos/${OTHER}`)));
    openAuto(OTHER, other, canonicalize("auto", other));
    fake.release(diskText);
    await pending;
    expect(getState().fileName).toBe(OTHER);
    expect(getState().auto).toBe(other);
  });
});

describe("onFileChanged for a project file (#394)", () => {
  afterEach(() => {
    setAdoptForTests(null);
    vi.unstubAllGlobals();
  });

  /** Opens the starter over a bridge that holds every read of robot.json, the first one released. */
  async function openHoldingRobot() {
    const fake = deferredBridge("autos/robot.json");
    const backend = new DesktopBackend(fake.bridge, { root: ROOT, name: "repo" });
    vi.stubGlobal("window", { zenithDesktop: fake.bridge });
    const opening = backend.open();
    await settle();
    fake.release(files["autos/robot.json"] ?? "");
    openProject(await opening, backend);
    const auto = loadAuto(JSON.parse(firstText));
    openAuto(FIRST, auto, canonicalize("auto", auto));
    return { fake, auto };
  }

  it("keeps edits made while the project was being read, and does not reopen it", async () => {
    const { fake, auto } = await openHoldingRobot();
    const adopt = vi.fn(() => Promise.resolve(true));
    setAdoptForTests(adopt);

    const pending = onFileChanged({ root: ROOT, path: "autos/robot.json" });
    await settle();
    commit({ ...auto, title: "Edited here" });
    fake.release(files["autos/robot.json"] ?? "");
    await pending;
    expect(adopt).not.toHaveBeenCalled();
    expect(getState().auto?.title).toBe("Edited here");
    expect(getState().status?.message).toMatch(/autos\/robot\.json changed on disk while you have unsaved edits here/);
  });

  it("reopens the project from the read it made, without reading again", async () => {
    const { fake } = await openHoldingRobot();
    let opened: unknown = null;
    const adopt = vi.fn(async (next: { open: () => Promise<unknown> }) => {
      // Handed over already read: this open must not wait on the held read.
      opened = await next.open();
      return true;
    });
    setAdoptForTests(adopt as never);

    const pending = onFileChanged({ root: ROOT, path: "autos/robot.json" });
    await settle();
    fake.release(files["autos/robot.json"] ?? "");
    await pending;
    expect(adopt).toHaveBeenCalledTimes(1);
    expect(opened).not.toBeNull();
    expect(getState().status?.message).toBe("Reloaded repo: autos/robot.json changed on disk.");
  });
});
