/**
 * The palette finds an action by its label, its group or one of its keywords (QA-02), and every
 * action carries keywords, so a search in other words still lands.
 */
import { describe, expect, it } from "vitest";
import { ACTIONS } from "../app/actions";
import { matchesQuery } from "./match";

const found = (needle: string): string[] =>
  ACTIONS.filter((action) => matchesQuery({ label: action.label, group: action.group, keywords: action.keywords }, needle)).map(
    (action) => action.id,
  );

describe("the palette's search", () => {
  it("finds both tours from tour, help, tutorial and guide", () => {
    for (const word of ["tour", "Tutorial", "guide", "help"]) {
      expect(found(word), word).toEqual(expect.arrayContaining(["help.tour", "help.fullTour"]));
    }
  });

  it("finds an action by a word that is not in its label", () => {
    expect(found("copy")).toContain("edit.duplicate");
    expect(found("ruler")).toContain("tool.measure");
    expect(found("pr")).toContain("run.propose");
  });

  it("gives every action at least one keyword", () => {
    for (const action of ACTIONS) {
      expect(action.keywords?.length ?? 0, action.id).toBeGreaterThan(0);
    }
  });
});
