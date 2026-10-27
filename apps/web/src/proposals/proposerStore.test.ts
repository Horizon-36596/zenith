import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseProjection, type ProposalChange } from "@horizon36596/zenith-schema";
import { afterEach, describe, expect, it } from "vitest";
import {
  beginDrag,
  defaultShareId,
  endDrag,
  endProposerSession,
  getProposerSession,
  redoChange,
  setChanges,
  startProposerSession,
  undoChange,
} from "./proposerStore";

/**
 * The proposer's own history: a drag is one undo step however many frames it records, an edit
 * outside a drag is one step each, and undo and redo walk the proposal's changes only.
 */

const starter = fileURLToPath(new URL("../../../../examples/starter/", import.meta.url));
const SHARE = parseProjection(JSON.parse(readFileSync(`${starter}partners/starter-collect-and-score.propose.projection.json`, "utf8")));

const move = (xIn: number): ProposalChange => ({ op: "movePose", stepId: "s1", segmentIndex: 0, point: "to", pose: { xIn, yIn: -36 } });

function start(): void {
  startProposerSession({
    partnerId: "partner1",
    label: "Starter collect and score",
    fileName: "partners/starter-collect-and-score.propose.projection.json",
    projection: SHARE,
    shareRef: { shareId: defaultShareId("partners/starter-collect-and-score.propose.projection.json"), revision: 1 },
  });
}

afterEach(() => {
  endProposerSession();
});

describe("the proposer's session", () => {
  it("names the share after the file it came from until the proposer says otherwise", () => {
    start();
    expect(getProposerSession()?.shareRef).toEqual({ shareId: "starter-collect-and-score", revision: 1 });
    expect(defaultShareId("..//")).toBe("share");
  });

  it("makes a drag one undo step, and undo and redo walk the changes", () => {
    start();
    beginDrag();
    for (const xIn of [-13, -14, -15]) setChanges([move(xIn)]);
    endDrag();
    setChanges([move(-15), { op: "setSpeedFraction", stepId: "s3", speedFraction: 0.5 }]);
    expect(getProposerSession()?.undo).toHaveLength(2);
    undoChange();
    expect(getProposerSession()?.changes).toEqual([move(-15)]);
    undoChange();
    expect(getProposerSession()?.changes).toEqual([]);
    redoChange();
    expect(getProposerSession()?.changes).toEqual([move(-15)]);
  });

  it("records nothing for an edit that changes nothing", () => {
    start();
    setChanges([]);
    beginDrag();
    endDrag();
    expect(getProposerSession()?.undo).toEqual([]);
  });
});
