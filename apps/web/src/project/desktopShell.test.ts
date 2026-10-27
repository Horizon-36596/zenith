/**
 * The desktop shell's smaller promises: Cancel the sim with no sim says so, a deploy of unsaved edits
 * asks first and one that skipped autos is a warning, unsaved edits survive a crash of the page, and
 * Save a copy says "Saved" only once the file is written, and nothing when the dialog is cancelled.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { canonicalize, loadAuto } from "@horizon36596/zenith-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveCopy } from "../app/projectActions";
import { commit, getState, isDirty, openAuto, openProject, setStatus } from "../state/store";
import { DesktopBackend } from "./desktop";
import { announceUpdate, cancelSim, closePanel, confirmDeploy, deployAutos, getPanel } from "./desktopActions";
import { DESKTOP_API_VERSION, type DesktopDeployResult, type DesktopDraft, type ZenithDesktopBridge } from "./desktopBridge";
import { DRAFT_DELAY_MS, draftOf, restoreDraft, startDraftSync, stopDraftSyncForTests } from "./desktopDraft";
import { saveFileAs } from "./fallback";

const read = (path: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../../examples/starter/${path}`, import.meta.url)), "utf8");

const ROOT = "C:/repo";
const FIRST = "first-auto.auto.json";
const OTHER = "cycle-and-park.auto.json";
const files: Record<string, string> = {
  "zenith.json": read("zenith.json"),
  "autos/robot.json": read("autos/robot.json"),
  "autos/field/biobuzz.field.json": read("autos/field/biobuzz.field.json"),
  "autos/waypoints.json": read("autos/waypoints.json"),
  [`autos/${FIRST}`]: read(`autos/${FIRST}`),
  [`autos/${OTHER}`]: read(`autos/${OTHER}`),
};

const deployResult = (errors: number): DesktopDeployResult => ({
  dryRun: false,
  actions: [],
  errors,
  changed: 1,
  deployDir: "TeamCode/src/main/assets/autos",
  commandLibrary: null,
  stubs: false,
});

function fakeBridge(extra: Partial<ZenithDesktopBridge> = {}) {
  const run = vi.fn(async (_root: string, options: { dryRun: boolean }) => ({ ...deployResult(1), dryRun: options.dryRun }));
  const bridge = {
    apiVersion: DESKTOP_API_VERSION,
    project: {
      read: (_root: string, path: string) => {
        const text = files[path];
        return text === undefined ? Promise.reject(new Error(`Could not read ${path}.`)) : Promise.resolve(text);
      },
      listAutos: () => Promise.resolve([OTHER, FIRST]),
      watch: () => Promise.resolve(),
    },
    deploy: { run },
    sim: { cancel: vi.fn(async () => undefined) },
    ...extra,
  } as unknown as ZenithDesktopBridge;
  return { bridge, run };
}

async function openDesktop(bridge: ZenithDesktopBridge, auto = FIRST): Promise<void> {
  vi.stubGlobal("window", { zenithDesktop: bridge });
  const backend = new DesktopBackend(bridge, { root: ROOT, name: "repo" });
  openProject(await backend.open(), backend);
  const loaded = loadAuto(JSON.parse(files[`autos/${auto}`] ?? "{}"));
  openAuto(auto, loaded, canonicalize("auto", loaded));
}

const edit = (title: string): void => {
  const auto = getState().auto;
  if (auto === null) throw new Error("no auto open");
  commit({ ...auto, title });
};

afterEach(() => {
  closePanel();
  stopDraftSyncForTests();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Cancel the sim", () => {
  it("says no sim is running instead of doing nothing", async () => {
    await openDesktop(fakeBridge().bridge);
    await cancelSim();
    expect(getState().status?.message).toBe("No sim is running.");
  });
});

describe("Deploy", () => {
  it("asks before it saves unsaved edits, and writes nothing until then", async () => {
    const { bridge, run } = fakeBridge();
    await openDesktop(bridge);
    edit("Edited here");
    await deployAutos();
    expect(getPanel()).toMatchObject({ kind: "deploy", phase: "confirm" });
    expect(run).not.toHaveBeenCalled();
    expect(isDirty()).toBe(true);
  });

  it("posts a deploy that skipped autos as a warning with the next step, not an error", async () => {
    const { bridge } = fakeBridge();
    await openDesktop(bridge);
    await deployAutos();
    expect(getPanel()).toMatchObject({ kind: "deploy", phase: "preview" });
    await confirmDeploy();
    expect(getState().status).toMatchObject({
      kind: "warn",
      message: "Deployed into TeamCode/src/main/assets/autos, but skipped 1 auto with errors.",
      hint: "Open it and see Problems, then deploy again.",
    });
  });
});

describe("a newer Zenith", () => {
  const updates = { updates: { check: async () => ({ version: "9.9.9", url: "https://example.com" }) } } as Partial<ZenithDesktopBridge>;

  async function announce(): Promise<void> {
    vi.useFakeTimers();
    const { bridge } = fakeBridge(updates);
    await openDesktop(bridge);
    vi.stubGlobal("window", { zenithDesktop: bridge, setTimeout: (run: () => void, ms: number) => setTimeout(run, ms) });
    setStatus("info", "Opened repo.");
    await announceUpdate(bridge);
  }

  it("is announced once the opening line has had its time", async () => {
    await announce();
    await vi.advanceTimersByTimeAsync(6000);
    expect(getState().status?.message).toBe("Zenith 9.9.9 is out.");
  });

  it("does not write over a line that came after it was found", async () => {
    await announce();
    setStatus("error", "Could not save first-auto.auto.json.");
    await vi.advanceTimersByTimeAsync(6000);
    expect(getState().status?.message).toBe("Could not save first-auto.auto.json.");
  });
});

describe("unsaved edits after a crash", () => {
  it("sends the open auto's unsaved text, and nothing once there is none", async () => {
    vi.useFakeTimers();
    const hold = vi.fn(async (_draft: DesktopDraft | null) => undefined);
    const { bridge } = fakeBridge({ drafts: { hold, take: async () => null } } as Partial<ZenithDesktopBridge>);
    await openDesktop(bridge);
    expect(draftOf()).toBeNull();
    startDraftSync(bridge);
    edit("Edited here");
    await vi.advanceTimersByTimeAsync(DRAFT_DELAY_MS);
    const sent = hold.mock.calls.at(-1)?.[0];
    expect(sent).toMatchObject({ root: ROOT, fileName: FIRST });
    expect(sent?.text).toContain("Edited here");
  });

  it("tells main there is no draft at start, so one kept from before a reload goes", async () => {
    const hold = vi.fn(async (_draft: DesktopDraft | null) => undefined);
    const { bridge } = fakeBridge({ drafts: { hold, take: async () => null } } as Partial<ZenithDesktopBridge>);
    await openDesktop(bridge);
    startDraftSync(bridge);
    expect(hold.mock.calls).toEqual([[null]]);
  });

  it("opens the kept edits again as unsaved edits on top of the file on disk", async () => {
    const edited = { ...(JSON.parse(files[`autos/${OTHER}`] ?? "{}") as Record<string, unknown>), title: "Kept through a crash" };
    const draft: DesktopDraft = { root: ROOT, fileName: OTHER, text: JSON.stringify(edited) };
    const { bridge } = fakeBridge({ drafts: { hold: async () => undefined, take: async () => draft } } as Partial<ZenithDesktopBridge>);
    await openDesktop(bridge);
    await restoreDraft(bridge);
    expect(getState().fileName).toBe(OTHER);
    expect(getState().auto?.title).toBe("Kept through a crash");
    expect(isDirty()).toBe(true);
    expect(getState().undo.length).toBe(1);
    expect(getState().status).toMatchObject({ message: `Brought back your unsaved edits to ${OTHER}.`, hint: "Save keeps them." });
  });

  it("says so when the kept edits belong to another project", async () => {
    const draft: DesktopDraft = { root: "D:/other", fileName: FIRST, text: "{}" };
    const { bridge } = fakeBridge({ drafts: { hold: async () => undefined, take: async () => draft } } as Partial<ZenithDesktopBridge>);
    await openDesktop(bridge);
    await restoreDraft(bridge);
    expect(getState().status).toMatchObject({ kind: "error", message: `Zenith could not bring back your unsaved edits to ${FIRST}.` });
  });
});

describe("Save a copy in the desktop app", () => {
  let saveFile: ReturnType<typeof vi.fn>;
  beforeEach(async () => {
    saveFile = vi.fn(async (name: string) => name);
    await openDesktop(fakeBridge({ saveFile } as Partial<ZenithDesktopBridge>).bridge);
  });

  it("goes through the Save As dialog and says Saved once it is written", async () => {
    await saveCopy();
    expect(saveFile).toHaveBeenCalledWith(FIRST, expect.stringContaining('"name"'));
    expect(getState().status).toMatchObject({ kind: "ok", message: `Saved ${FIRST}.` });
  });

  it("claims nothing when the dialog is cancelled", async () => {
    saveFile.mockResolvedValueOnce(null);
    await saveCopy();
    expect(getState().status).toMatchObject({ kind: "info", message: "Save a copy cancelled. Nothing was saved." });
  });

  it("hands a picture over as bytes", async () => {
    const saved = await saveFileAs("first-auto.red.png", new Blob([new Uint8Array([1, 2, 3])]));
    expect(saved).toEqual({ name: "first-auto.red.png", how: "saved" });
    expect(saveFile.mock.calls.at(-1)?.[1]).toEqual(new Uint8Array([1, 2, 3]));
  });
});
