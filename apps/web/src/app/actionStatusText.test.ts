import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearStatus, closeProject, getState } from "../state/store";
import { ACTIONS, tooltipHint } from "./actions";
import { loadExample } from "./projectActions";

/**
 * The shorter action tooltips and status line (issue #247): Save's second line is one short
 * sentence, and loading the example says so in a few words with the reason as its hint.
 */
type Lines = Parameters<typeof tooltipHint>[1];
const save = ACTIONS.find((action) => action.id === "run.save");

/** What Save's tooltip reads for a project from `source`, with an auto open and no review. */
const saveLine = (source: { kind: string }, backend: { kind: string } = { kind: "local" }): string => {
  if (save === undefined) throw new Error("There is no Save action.");
  const state = { auto: {}, review: null, project: { source }, backend } as unknown as Lines;
  return tooltipHint(save, state);
};

describe("Save's tooltip", () => {
  it("says it writes the auto to the robot repository on a project it can write", () => {
    expect(saveLine({ kind: "directory" })).toBe("Writes the auto to the robot repository.");
    expect(saveLine({ kind: "desktop" })).toBe("Writes the auto to the robot repository.");
  });

  it("says Read-only project: asks where to save, and nothing else, on one it cannot", () => {
    expect(saveLine({ kind: "example" })).toBe("Read-only project: asks where to save.");
    expect(saveLine({ kind: "files" })).toBe("Read-only project: asks where to save.");
  });

  it("keeps the plain line on GitHub's read-only base branch, where Save asks for a commit message", () => {
    expect(saveLine({ kind: "example" }, { kind: "github" })).toBe("Writes the auto to the robot repository.");
  });

  it("is one short sentence either way", () => {
    for (const line of [saveLine({ kind: "directory" }), saveLine({ kind: "example" })]) {
      expect(line.length).toBeLessThanOrEqual(60);
      expect(line.match(/\./g)).toHaveLength(1);
    }
  });
});

describe("loading the example", () => {
  beforeEach(() => {
    closeProject();
    clearStatus();
    vi.stubGlobal("window", {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads \"Example loaded, read only.\" with \"Save makes your own copy.\" as its hint", async () => {
    await loadExample();
    expect(getState().status).toMatchObject({
      kind: "info",
      message: "Example loaded, read only.",
      hint: "Save makes your own copy.",
    });
  });
});
