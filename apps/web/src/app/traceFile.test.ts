/**
 * Load trace in the Simulate dialog (the 0.1.2 UX review, K12): a trace that does not load is said
 * in one sentence that names the file and says to run the sim again, never in the JSON parser's
 * words, and the dialog shows it, so it is not hidden behind the dialog on the status line.
 */
import { afterEach, describe, expect, it } from "vitest";
import { getState, setStatus } from "../state/store";
import { loadTraceFile, traceFailureMessage } from "./projectActions";

const AGAIN = "Run the sim again, then load the trace it writes.";
const file = (name: string, text: string) => ({ name, text: () => Promise.resolve(text) }) as unknown as File;

afterEach(() => {
  setStatus("info", "");
});

describe("loading a trace file", () => {
  it("answers an empty, cut off or broken trace with a sentence for the dialog, and leaves the status line alone", async () => {
    setStatus("info", "Before.");
    expect(await loadTraceFile(file("empty.trace.json", ""))).toBe(`empty.trace.json is empty. ${AGAIN}`);
    expect(await loadTraceFile(file("cut.trace.json", '{"poses": [[0, 1'))).toBe(`cut.trace.json is cut off: the JSON in it stops part way. ${AGAIN}`);
    expect(await loadTraceFile(file("list.trace.json", "[]"))).toBe(`list.trace.json is not a sim trace. ${AGAIN}`);
    expect(await loadTraceFile(file("bad.trace.json", '{"poses": "no"}'))).toBe(`bad.trace.json is a damaged sim trace: poses is not an array. ${AGAIN}`);
    expect(getState().status?.message).toBe("Before.");
  });

  it("words a trace's own problems in Zenith's sentences", () => {
    expect(traceFailureMessage("a.json", "{}", new Error("disk"))).toBe(`a.json could not be read. ${AGAIN}`);
    let error: unknown;
    try {
      JSON.parse("{}x");
    } catch (thrown) {
      error = thrown;
    }
    expect(traceFailureMessage("a.json", "{}x", error)).toBe(`a.json is not valid JSON (line 1, column 3). ${AGAIN}`);
  });

  it("loads a good trace and says so on the status line", async () => {
    expect(await loadTraceFile(file("good.trace.json", '{"auto": "a", "poses": [[0, 0, 0, 0]]}'))).toBeNull();
    expect(getState().status?.message).toBe("Loaded good.trace.json.");
  });
});
