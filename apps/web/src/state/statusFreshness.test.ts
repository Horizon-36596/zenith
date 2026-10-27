/**
 * Issue #411: the status line describes the latest action. A message an earlier action set goes at
 * the next commit unless that action sets its own. Undo and redo answer in one voice (UI_GUIDE
 * 9.15): "Undid: " or "Redid: " and the first sentence of the edit's own line, or "Undid the last
 * change." for an edit that wrote none; an undo entry that carries its own message still shows it.
 * A refused edit's error goes by itself after 8 s or at the next edit, and a failed save's error
 * stays until it is dismissed.
 *
 * Each action in a test is followed by `settle()`, the microtask that ends the action, as the end of
 * a key press or click does in the app: a message set during an action belongs to that action.
 */
import { canonicalize, loadAuto } from "@horizon36596/zenith-core";
import { SCHEMA_ID } from "@horizon36596/zenith-schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deleteSelection, tryEdit, writeTimeout } from "../app/edits";
import { waitForTime } from "../app/waitEdits";
import { ALL_FEATURES, setFeatures } from "./features";
import {
  REFUSED_EDIT_STATUS_MS,
  clearStaleStatus,
  commit,
  firstSentence,
  getState,
  openAuto,
  redo,
  selectStep,
  setStatus,
  undo,
} from "./store";

const fixture = () =>
  loadAuto({
    $schema: SCHEMA_ID.auto,
    formatVersion: 1,
    name: "status-fixture",
    title: "Status fixture",
    alliance: "RED",
    start: { pose: { xIn: 0, yIn: 0, headingRad: 0 } },
    steps: [
      {
        id: "leg1",
        kind: "path",
        segments: [{ kind: "line", from: "current", to: { xIn: 0, yIn: 24, headingRad: 0 } }],
        heading: { mode: "tangent" },
      },
      { id: "full", kind: "wait", until: "hopperFull", timeoutS: 1 },
      { id: "sit", kind: "wait", seconds: 0.25 },
    ],
  });

const openedAuto = () => {
  const auto = getState().auto;
  if (auto === null) throw new Error("The fixture is open.");
  return auto;
};

/** Ends the action: the microtask after it, which is when the app's own key press or click ends. */
const settle = (): Promise<void> => Promise.resolve();

beforeEach(() => {
  setFeatures(ALL_FEATURES);
  openAuto("status-fixture.auto.json", fixture(), canonicalize("auto", fixture()));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("a status line follows the latest action (issue #411)", () => {
  it("after Delete then Ctrl Z, the line no longer says Deleted", async () => {
    selectStep("sit");
    deleteSelection();
    expect(getState().status?.message).toMatch(/^Deleted sit/);
    await settle();
    undo();
    expect(getState().status?.message).toMatch(/^Undid: Deleted sit/);
  });

  it("undo and redo of Wait for: A time say Undid and Redid with the edit's first sentence", async () => {
    waitForTime("full");
    const said = getState().status?.message ?? "";
    expect(said).toMatch(/now waits 1.00 s/);
    await settle();
    undo();
    expect(getState().status).toMatchObject({ kind: "ok", message: `Undid: ${firstSentence(said)}` });
    expect(getState().status?.message).not.toMatch(/puts the condition back/);
    await settle();
    redo();
    expect(getState().status).toMatchObject({ kind: "ok", message: `Redid: ${firstSentence(said)}` });
    await settle();
    undo();
    expect(getState().status?.message).toBe(`Undid: ${firstSentence(said)}`);
  });

  it("an edit that writes its line after it commits is named by it", async () => {
    commit({ ...openedAuto(), title: "Renamed" });
    setStatus("ok", "Renamed the auto. Press Ctrl Z to undo.");
    await settle();
    undo();
    expect(getState().status?.message).toBe("Undid: Renamed the auto.");
  });

  it("an edit that wrote no line undoes as the last change", async () => {
    setStatus("ok", "Opened robot-repo.");
    await settle();
    writeTimeout("leg1", 4);
    await settle();
    undo();
    expect(getState().status?.message).toBe("Undid the last change.");
    await settle();
    redo();
    expect(getState().status?.message).toBe("Redid the last change.");
  });

  it("an error the edit wrote does not name it", async () => {
    commit({ ...openedAuto(), title: "Renamed" });
    setStatus("error", "That cannot be done.", undefined, { expireMs: REFUSED_EDIT_STATUS_MS });
    await settle();
    undo();
    expect(getState().status?.message).toBe("Undid the last change.");
  });

  it("an old line goes when a dialog or a sheet opens, but not one this action wrote", async () => {
    setStatus("ok", "Downloaded new-auto.red.png.");
    clearStaleStatus();
    expect(getState().status?.message).toBe("Downloaded new-auto.red.png.");
    await settle();
    clearStaleStatus();
    expect(getState().status).toBeNull();
  });

  it("the next edit clears a message an earlier action set, and an edit that sets its own keeps it", async () => {
    setStatus("ok", "Opened robot-repo.");
    await settle();
    writeTimeout("leg1", 4);
    expect(getState().status).toBeNull();
    await settle();
    waitForTime("full");
    expect(getState().status?.message).toMatch(/now waits/);
  });

  it("a refused edit's error goes after 8 s", async () => {
    vi.useFakeTimers();
    tryEdit(() => {
      throw new Error("That cannot be done.");
    });
    expect(getState().status).toMatchObject({ kind: "error", message: "That cannot be done." });
    await settle();
    vi.advanceTimersByTime(REFUSED_EDIT_STATUS_MS - 100);
    expect(getState().status?.kind).toBe("error");
    vi.advanceTimersByTime(200);
    expect(getState().status).toBeNull();
  });

  it("a refused edit's error goes at the next edit", async () => {
    tryEdit(() => {
      throw new Error("That cannot be done.");
    });
    await settle();
    writeTimeout("leg1", 4);
    expect(getState().status).toBeNull();
  });

  it("a failed save's error stays until it is dismissed, past 8 s and past the next edit", async () => {
    vi.useFakeTimers();
    setStatus("error", "Could not save first-auto.auto.json.");
    await settle();
    vi.advanceTimersByTime(REFUSED_EDIT_STATUS_MS * 2);
    expect(getState().status).toMatchObject({ kind: "error", message: "Could not save first-auto.auto.json." });
    writeTimeout("leg1", 4);
    expect(getState().status).toMatchObject({ kind: "error", message: "Could not save first-auto.auto.json." });
    await settle();
    undo();
    expect(getState().status).toMatchObject({ kind: "error", message: "Could not save first-auto.auto.json." });
  });

  it("firstSentence keeps decimals and stops at the first full stop", () => {
    expect(firstSentence("full now waits 1.00 s instead of until hopperFull. Ctrl Z puts it back.")).toBe(
      "full now waits 1.00 s instead of until hopperFull.",
    );
    expect(firstSentence("No full stop")).toBe("No full stop");
  });
});
