/**
 * Leave on a proposal with changes not saved or sent asks the unsaved-changes question first, as
 * every other loss of unsaved work does (UI_GUIDE 9.14); with nothing to lose it leaves at once.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseProjection, type ProposalChange } from "@horizon36596/zenith-schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UnsavedChoice } from "../app/unsaved";
import type { UnsavedPrompt } from "../state/store";

const asked: UnsavedPrompt[] = [];
let answer: UnsavedChoice = "cancel";
vi.mock("../app/unsaved", () => ({
  askUnsaved: (prompt: UnsavedPrompt) => {
    asked.push(prompt);
    return Promise.resolve(answer);
  },
}));

const { askLeaveProposal } = await import("./proposerActions");
const { endProposerSession, getProposerSession, setChanges, startProposerSession } = await import("./proposerStore");

const starter = fileURLToPath(new URL("../../../../examples/starter/", import.meta.url));
const SHARE = parseProjection(JSON.parse(readFileSync(`${starter}partners/starter-collect-and-score.propose.projection.json`, "utf8")));
const move: ProposalChange = { op: "movePose", stepId: "s1", segmentIndex: 0, point: "to", pose: { xIn: -14, yIn: -36 } };

function start(): void {
  startProposerSession({
    partnerId: "partner1",
    label: "Starter collect and score",
    fileName: "partners/starter-collect-and-score.propose.projection.json",
    projection: SHARE,
    shareRef: { shareId: "starter-collect-and-score", revision: 1 },
  });
}

afterEach(() => {
  asked.length = 0;
  endProposerSession();
});

describe("Leave on a proposal", () => {
  it("leaves at once when there are no changes", async () => {
    start();
    await askLeaveProposal();
    expect(asked).toHaveLength(0);
    expect(getProposerSession()).toBeNull();
  });

  it("asks first with unsent changes, and Cancel stays", async () => {
    start();
    setChanges([move]);
    answer = "cancel";
    await askLeaveProposal();
    expect(asked).toHaveLength(1);
    expect(asked[0]?.lead).toBe("The proposal to Starter collect and score has 1 change that is not saved or sent.");
    expect(asked[0]?.saveLabel).toBe("Save proposal…");
    expect(getProposerSession()?.changes).toEqual([move]);
  });

  it("leaves on Discard changes", async () => {
    start();
    setChanges([move]);
    answer = "discard";
    await askLeaveProposal();
    expect(getProposerSession()).toBeNull();
  });
});
