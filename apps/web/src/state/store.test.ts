/**
 * A canvas drag brackets every edit it produces between `beginTransaction` and `endTransaction`
 * (`apps/web/src/canvas/FieldCanvas.tsx`'s `onPointerDown`/`onPointerUp`), so a drag is one undo
 * entry regardless of how many pointer-move frames it produces or how long it runs — replacing the
 * old 700 ms time-window coalescing in `apps/web/src/app/App.tsx`, which produced a fresh undo entry
 * whenever two edits landed further apart than that window.
 */
import { canonicalize, loadAuto, setPose } from "@horizon36596/zenith-core";
import { SCHEMA_ID } from "@horizon36596/zenith-schema";
import { beforeEach, describe, expect, it } from "vitest";
import { beginTransaction, commit, endTransaction, getState, openAuto, undo } from "./store";

const fixture = () =>
  loadAuto({
    $schema: SCHEMA_ID.auto,
    formatVersion: 1,
    name: "drag-fixture",
    title: "Drag fixture",
    alliance: "RED",
    start: { pose: { xIn: 0, yIn: 0, headingRad: 0 } },
    steps: [
      {
        id: "leg1",
        kind: "path",
        segments: [{ kind: "line", from: "current", to: { xIn: 0, yIn: 24, headingRad: 0 } }],
        heading: { mode: "tangent" },
      },
    ],
  });

beforeEach(() => {
  const auto = fixture();
  openAuto("drag-fixture.auto.json", auto, canonicalize("auto", auto));
});

/** The pose a drag frame at inch `yIn` would write, the way `onDragPose` does in App.tsx. */
const dragTo = (yIn: number) => {
  const current = getState().auto;
  if (current === null) throw new Error("expected an open document");
  commit(
    setPose(
      current,
      "leg1",
      { segmentIndex: 0, pointKind: "to", controlIndex: 0 },
      { xIn: 0, yIn, headingRad: 0 },
    ),
  );
};

describe("drag transactions", () => {
  it("collapses five rapid edits into one undo entry that restores the original document", () => {
    const original = getState().auto;
    const originalCanonical = canonicalize("auto", getState().auto);

    beginTransaction();
    for (const yIn of [25, 26, 27, 28, 29]) dragTo(yIn);
    endTransaction();

    expect(getState().undo).toHaveLength(1);
    const moved = getState().auto?.steps.find((step) => step.id === "leg1");
    expect(moved?.kind === "path" && moved.segments[0]?.to).toEqual({
      xIn: 0,
      yIn: 29,
      headingRad: 0,
    });

    undo();
    expect(getState().undo).toHaveLength(0);
    expect(canonicalize("auto", getState().auto)).toBe(originalCanonical);
    expect(getState().auto).not.toBe(original);
  });

  it("pushes no undo entry at all when the transaction changes nothing", () => {
    beginTransaction();
    endTransaction();
    expect(getState().undo).toHaveLength(0);
  });

  it("still coalesces into one entry when a plain click opens and closes an empty transaction first", () => {
    // onPointerDown/onPointerUp bracket every drag, including one that never moves (a click).
    beginTransaction();
    endTransaction();

    beginTransaction();
    for (const yIn of [25, 26, 27]) dragTo(yIn);
    endTransaction();

    expect(getState().undo).toHaveLength(1);
  });

  it("keeps an ordinary edit outside a transaction as its own undo entry", () => {
    dragTo(30);
    dragTo(31);
    expect(getState().undo).toHaveLength(2);
  });
});
