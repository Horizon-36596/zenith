/**
 * The ids the Report a bug setup block lists (`recentActions.ts`): every action in the registry notes
 * its id when it runs, whoever calls it, and only the last RECENT_ACTIONS_KEPT are kept.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { actionById, HELP_MENU } from "./actions";
import { clearRecentActions, recentActions, recordAction, RECENT_ACTIONS_KEPT } from "./recentActions";

describe("recent actions", () => {
  beforeEach(() => {
    clearRecentActions();
  });

  it("notes an action's id when the registry runs it", async () => {
    await actionById("help.shortcuts")?.run();
    await actionById("help.reportBug")?.run();
    expect(recentActions()).toEqual(["help.shortcuts", "help.reportBug"]);
  });

  it("keeps only the newest ids", () => {
    for (let index = 0; index < RECENT_ACTIONS_KEPT + 5; index += 1) recordAction(`action.${String(index)}`);
    expect(recentActions()).toHaveLength(RECENT_ACTIONS_KEPT);
    expect(recentActions()[0]).toBe("action.5");
  });

  it("offers Report a bug in the help menu", () => {
    expect(HELP_MENU).toContain("help.reportBug");
    expect(actionById("help.reportBug")?.label).toBe("Report a bug");
  });
});
