import { describe, expect, it } from "vitest";
import { leaveWords, suggestingWords } from "./proposerWords";

describe("the proposer's status lines", () => {
  it("names sending only when the partner came from a cloud share", () => {
    expect(suggestingWords("Collect and score", true)).toBe(
      "Suggesting changes to Collect and score. Your own auto is not touched; nothing is sent until you save or send the proposal.",
    );
    expect(suggestingWords("Starter partner", false)).toBe(
      "Suggesting changes to Starter partner. Your own auto is not touched; nothing leaves this computer until you save the proposal as a file.",
    );
  });

  it("says nothing on leaving when there were no changes or they were already saved or sent", () => {
    expect(leaveWords("Collect and score", 0, false)).toBeNull();
    expect(leaveWords("Collect and score", 2, true)).toBeNull();
  });

  it("counts the changes that were dropped, in the singular for one", () => {
    expect(leaveWords("Collect and score", 1, false)).toBe(
      "Left the proposal to Collect and score; its 1 change was not saved or sent, so it was dropped.",
    );
    expect(leaveWords("Collect and score", 3, false)).toBe(
      "Left the proposal to Collect and score; its 3 changes were not saved or sent, so they were dropped.",
    );
  });
});
