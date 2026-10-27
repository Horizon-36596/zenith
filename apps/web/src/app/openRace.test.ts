/**
 * Issue #401: opening an auto while another open's read is still on its way. In GitHub mode a read is
 * one or two network fetches, so two quick clicks can land in either order. The last open asked for
 * is the one that opens, a read that lands late never replaces the auto opened after it, and a read
 * that lands after the auto on screen was edited does not throw the edit away.
 */
import type { Auto } from "@horizon36596/zenith-schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectBackend } from "../project/backend";
import { resolveAutoOverrides } from "../project/overrides";
import type { LoadedAuto } from "../project/types";
import { clearStatus, closeProject, commit, getState, isDirty } from "../state/store";
import { loadExample, openAutoNamed } from "./projectActions";
import { answerUnsaved } from "./unsaved";

// Passes through to the real one; a test can hold one read of the overrides with `holdOverrides`.
vi.mock("../project/overrides", async (importOriginal) => {
  const real = await importOriginal<typeof import("../project/overrides")>();
  return { ...real, resolveAutoOverrides: vi.fn(real.resolveAutoOverrides) };
});

/** Holds the next read of an auto's robot and field until the returned function lets it land. */
async function holdOverrides(): Promise<() => void> {
  let release = (): void => undefined;
  const real = (await vi.importActual<typeof import("../project/overrides")>("../project/overrides")).resolveAutoOverrides;
  vi.mocked(resolveAutoOverrides).mockImplementationOnce(
    (...args) =>
      new Promise((resolve, reject) => {
        release = () => {
          real(...args).then(resolve, reject);
        };
      }),
  );
  return () => release();
}

/** Holds each read of the open project's backend until the test lets it land. */
function holdReads(backend: ProjectBackend): Map<string, () => void> {
  const waiting = new Map<string, () => void>();
  const read = backend.readAuto.bind(backend);
  vi.spyOn(backend, "readAuto").mockImplementation(
    (name: string) =>
      new Promise<LoadedAuto>((resolve, reject) => {
        waiting.set(name, () => {
          read(name).then(resolve, reject);
        });
      }),
  );
  return waiting;
}

/** Lets the read of `name` land, and gives the open a few turns to act on it. */
async function land(waiting: Map<string, () => void>, name: string): Promise<void> {
  for (let turn = 0; turn < 50 && !waiting.has(name); turn += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  const release = waiting.get(name);
  if (release === undefined) throw new Error(`no read of ${name} is waiting`);
  release();
  for (let turn = 0; turn < 20; turn += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  answerUnsaved("cancel");
  closeProject();
  clearStatus();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const retitled = (title: string): void => {
  commit({ ...(getState().auto as Auto), title });
};

describe("two opens whose reads land out of order (issue #401)", () => {
  it("keeps the auto opened last, and its edits, when the earlier read lands after it", async () => {
    await loadExample();
    const backend = getState().backend;
    if (backend === null) throw new Error("expected the example open");
    const waiting = holdReads(backend);

    const first = openAutoNamed("first-auto.auto.json");
    const second = openAutoNamed("cycle-and-park.auto.json");
    await land(waiting, "cycle-and-park.auto.json");
    expect(getState().fileName).toBe("cycle-and-park.auto.json");
    retitled("Edited while the other read was out");

    await land(waiting, "first-auto.auto.json");
    await Promise.all([first, second]);
    expect(getState().fileName).toBe("cycle-and-park.auto.json");
    expect(getState().auto?.title).toBe("Edited while the other read was out");
    expect(isDirty()).toBe(true);
  });

  it("opens only the auto asked for last when the reads land in order", async () => {
    await loadExample();
    const backend = getState().backend;
    if (backend === null) throw new Error("expected the example open");
    const waiting = holdReads(backend);

    const first = openAutoNamed("first-auto.auto.json");
    const second = openAutoNamed("cycle-and-park.auto.json");
    await land(waiting, "first-auto.auto.json");
    expect(getState().fileName).toBe("collect-and-score.auto.json");
    await land(waiting, "cycle-and-park.auto.json");
    await Promise.all([first, second]);
    expect(getState().fileName).toBe("cycle-and-park.auto.json");
  });

  it("says nothing when it finishes after a later open, which then says it opened", async () => {
    await loadExample();
    const backend = getState().backend;
    if (backend === null) throw new Error("expected the example open");
    const waiting = holdReads(backend);
    const releaseFirst = await holdOverrides();
    const releaseSecond = await holdOverrides();

    const first = openAutoNamed("first-auto.auto.json");
    await land(waiting, "first-auto.auto.json");
    // The first open is still reading its robot and field when the second begins and reads its auto.
    const second = openAutoNamed("cycle-and-park.auto.json");
    await land(waiting, "cycle-and-park.auto.json");
    expect(getState().fileName).toBe("cycle-and-park.auto.json");

    // The first open says nothing: the second has not finished, and its own line is the answer.
    const said = getState().status;
    releaseFirst();
    await first;
    expect(getState().status).toBe(said);
    releaseSecond();
    await second;
    expect(getState().status?.message).toBe("Opened cycle-and-park.auto.json.");
  });

  it("does not replace an auto edited while the read was out, and says so", async () => {
    await loadExample();
    const backend = getState().backend;
    if (backend === null) throw new Error("expected the example open");
    const waiting = holdReads(backend);

    const opening = openAutoNamed("first-auto.auto.json");
    for (let turn = 0; turn < 50 && !waiting.has("first-auto.auto.json"); turn += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    retitled("Edited after the question");
    await land(waiting, "first-auto.auto.json");
    await opening;

    expect(getState().fileName).toBe("collect-and-score.auto.json");
    expect(getState().auto?.title).toBe("Edited after the question");
    expect(getState().status?.message).toBe(
      "Did not open first-auto.auto.json: the auto on screen changed while it was loading. Open it again to replace it.",
    );
  });
});
