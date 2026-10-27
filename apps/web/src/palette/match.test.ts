/**
 * The palette finds an action by its label, its group or one of its keywords (QA-02), and every
 * action carries keywords, so a search in other words still lands.
 */
import { describe, expect, it } from "vitest";
import { ACTIONS } from "../app/actions";
import { firstActive, matchesQuery, matchTier, stepActive, SUMMARY_ONLY_TIER, type MatchTier } from "./match";

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

  it("finds Documentation, and nothing else, from docs and the words people use for it (issue #225)", () => {
    expect(found("docs")).toEqual(["help.docs"]);
    for (const word of ["documentation", "manual", "reference", "wiki", "how to", "guide"]) {
      expect(found(word), word).toContain("help.docs");
    }
  });

  it("finds an action by a word that is not in its label", () => {
    expect(found("copy")).toContain("edit.duplicate");
    expect(found("ruler")).toContain("tool.measure");
    expect(found("pr")).toContain("run.propose");
  });

  it("finds Make curve from curve, bezier and bend, and Make straight line from straight (issue #143)", () => {
    for (const word of ["curve", "Bezier", "bend"]) {
      expect(found(word), word).toContain("edit.makeCurve");
    }
    expect(found("straight")).toContain("edit.makeLine");
  });

  it("finds Add path from chain and pathchain, the step kind's name (issue #184)", () => {
    for (const word of ["chain", "PathChain"]) {
      expect(found(word), word).toContain("tool.addPath");
    }
  });

  it("gives every action at least one keyword", () => {
    for (const action of ACTIONS) {
      expect(action.keywords?.length ?? 0, action.id).toBeGreaterThan(0);
    }
  });
});

describe("how well a result matches", () => {
  const tier = (label: string, needle: string, extra: { group?: string; keywords?: string[]; summary?: string } = {}) =>
    matchTier({ label, group: extra.group ?? "Edit", keywords: extra.keywords, summary: extra.summary }, needle);

  it("ranks the whole label, its start, a word in it, then anywhere in it", () => {
    expect(tier("Select", "select")).toBe(0);
    expect(tier("Select", "sel")).toBe(1);
    expect(tier("Add path", "path")).toBe(2);
    expect(tier("Duplicate step", "plic")).toBe(3);
  });

  it("puts a group or keyword match after the label's, and a summary-only match last", () => {
    expect(tier("Duplicate step", "copy", { keywords: ["copy"] })).toBe(4);
    expect(tier("Insert spinUp", "start", { group: "Commands", summary: "Spins up. starts sooner" })).toBe(SUMMARY_ONLY_TIER);
    expect(tier("Insert spinUp", "banana", { summary: "starts sooner" })).toBeNull();
  });

  it("orders a label match before a summary-only match, so typing start does not make Insert spinUp first", () => {
    const rows = [
      { label: "Insert spinUp", group: "Commands", summary: "starts sooner" },
      { label: "start · -13.0, -63.0 in", group: "Waypoints" },
      { label: "Play from the selected step", group: "Run", keywords: ["start"] },
    ];
    const ordered = rows
      .map((row) => ({ row, tier: matchTier(row, "start") }))
      .filter((entry): entry is { row: (typeof rows)[number]; tier: MatchTier } => entry.tier !== null)
      .sort((a, b) => a.tier - b.tier)
      .map((entry) => entry.row.label);
    expect(ordered[0]).toBe("start · -13.0, -63.0 in");
    expect(ordered.at(-1)).toBe("Insert spinUp");
  });

  it("never makes a summary-only match the first active row, and skips a row that cannot run", () => {
    expect(firstActive([{ tier: SUMMARY_ONLY_TIER }])).toBe(-1);
    // The first row stays the active one when it cannot run, so Enter says why instead of running a
    // row further down (UX review, S18).
    expect(firstActive([{ tier: 1, disabled: true }, { tier: 3 }, { tier: SUMMARY_ONLY_TIER }])).toBe(0);
    expect(firstActive([{ tier: SUMMARY_ONLY_TIER }, { tier: 3, disabled: true }])).toBe(1);
    const rows: Array<{ tier: MatchTier; disabled?: boolean }> = [{ tier: 0 }, { tier: 1, disabled: true }, { tier: 2 }];
    expect(stepActive(rows, 0, 1)).toBe(2);
    expect(stepActive(rows, 2, -1)).toBe(0);
    expect(stepActive(rows, 2, 1)).toBe(2);
  });
});
