/**
 * A proposal file that cannot be read is worded like every other bad file (UI_GUIDE section 9.19):
 * it names the file, says what is wrong in plain words and what to do.
 */
import { describe, expect, it } from "vitest";
import { getState } from "../state/store";
import { MAX_PROPOSAL_BYTES, openProposalFile } from "./ownerActions";

const file = (name: string, text: string, size = text.length) => ({ name, size, text: () => Promise.resolve(text) });

describe("opening a proposal file", () => {
  it("says an empty, cut off or too large file is so", async () => {
    await openProposalFile(file("empty.proposal.json", ""));
    expect(getState().status?.message).toBe("empty.proposal.json is empty. Ask your partner to send the proposal again.");
    await openProposalFile(file("cut.proposal.json", '{"changes": ['));
    expect(getState().status?.message).toBe("cut.proposal.json is cut off: the JSON in it stops part way. Ask your partner to send the proposal again.");
    await openProposalFile(file("big.proposal.json", "", MAX_PROPOSAL_BYTES + 500_000));
    expect(getState().status?.message).toBe(
      "big.proposal.json is 1.5 MB, larger than the 1.0 MB a proposal may be, so it was not read. Check that this is the file you meant.",
    );
  });

  it("says a file that could not be read since it was picked", async () => {
    await openProposalFile({ name: "gone.proposal.json", size: 10, text: () => Promise.reject(new Error("NotFoundError")) });
    expect(getState().status?.message).toBe("gone.proposal.json could not be read. Ask your partner to send the proposal again.");
  });
});
