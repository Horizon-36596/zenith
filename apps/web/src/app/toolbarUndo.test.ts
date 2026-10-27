import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseProjection } from "@horizon36596/zenith-schema";
import { afterEach, describe, expect, it } from "vitest";
import { defaultShareId, endProposerSession, setChanges, startProposerSession } from "../proposals/proposerStore";
import { getState } from "../state/store";
import { ACTIONS, TOOLBAR_GROUPS, actionById, isEnabled, tooltipHint } from "./actions";

/**
 * The toolbar's Undo and Redo (issue #189): a group of their own just after the tools, enabled from
 * the editor's history, and from the proposal's own history while a proposal is open.
 */

const starter = fileURLToPath(new URL("../../../../examples/starter/", import.meta.url));
const SHARE = parseProjection(JSON.parse(readFileSync(`${starter}partners/starter-collect-and-score.propose.projection.json`, "utf8")));

afterEach(() => {
  endProposerSession();
});

describe("the toolbar's undo group", () => {
  it("follows the tools and Optimize's own group, and the run group keeps its anchor by name", () => {
    expect(TOOLBAR_GROUPS[0]?.[0]).toBe("tool.select");
    // Optimize is a group of its own after the tools, not with Undo and Redo (issue #412).
    expect(TOOLBAR_GROUPS[1]).toEqual(["path.optimize"]);
    expect(TOOLBAR_GROUPS[2]).toEqual(["edit.undo", "edit.redo"]);
    expect(TOOLBAR_GROUPS[3]).toContain("run.validate");
    expect(ACTIONS.some((action) => action.id === "edit.undo")).toBe(true);
  });

  it("is disabled with a reason when there is nothing to undo", () => {
    const undo = actionById("edit.undo");
    if (undo === undefined) throw new Error("no undo action");
    const state = getState();
    expect(isEnabled(undo, state)).toBe(state.undo.length > 0);
    if (state.undo.length === 0) expect(tooltipHint(undo, state)).toBe("Unavailable: There is nothing to undo.");
  });

  it("follows the proposal's history while a proposal is open, not the auto's", () => {
    const undo = actionById("edit.undo");
    const redo = actionById("edit.redo");
    if (undo === undefined || redo === undefined) throw new Error("no undo or redo action");
    startProposerSession({
      partnerId: "partner1",
      label: "Starter collect and score",
      fileName: "partners/starter-collect-and-score.propose.projection.json",
      projection: SHARE,
      shareRef: { shareId: defaultShareId("partners/starter-collect-and-score.propose.projection.json"), revision: 1 },
    });
    // The auto underneath has history, the proposal has none: Undo is off, with the proposal's reason.
    const state = { ...getState(), undo: [{}] as never };
    expect(isEnabled(undo, state)).toBe(false);
    expect(tooltipHint(undo, state)).toContain("in this proposal");
    setChanges([{ op: "setSpeedFraction", stepId: "s3", speedFraction: 0.5 }]);
    expect(isEnabled(undo, state)).toBe(true);
    expect(isEnabled(redo, state)).toBe(false);
    undo.run();
    expect(isEnabled(undo, state)).toBe(false);
    expect(isEnabled(redo, state)).toBe(true);
  });
});
