import { describe, expect, it } from "vitest";
import { diffHunks, diffLines, formatDiff } from "./textDiff.js";

describe("diffLines", () => {
  it("marks added and removed lines with their line numbers", () => {
    expect(diffLines("a\nb\nc\n", "a\nx\nc\nd\n")).toEqual([
      { op: " ", text: "a", oldLine: 1, newLine: 1 },
      { op: "-", text: "b", oldLine: 2 },
      { op: "+", text: "x", newLine: 2 },
      { op: " ", text: "c", oldLine: 3, newLine: 3 },
      { op: "+", text: "d", newLine: 4 },
    ]);
  });

  it("is all unchanged for equal texts", () => {
    expect(diffLines("a\nb\n", "a\nb\n").every((line) => line.op === " ")).toBe(true);
    expect(diffHunks(diffLines("a\nb\n", "a\nb\n"))).toEqual([]);
  });
});

describe("formatDiff", () => {
  it("keeps context around each change and elides the rest", () => {
    const before = Array.from({ length: 20 }, (_, i) => `line ${String(i + 1)}`).join("\n");
    const lines = before.split("\n");
    lines[1] = "changed 2";
    lines[17] = "changed 18";
    expect(formatDiff(before, lines.join("\n"), 1).split("\n")).toEqual([
      " line 1",
      "-line 2",
      "+changed 2",
      " line 3",
      "...",
      " line 17",
      "-line 18",
      "+changed 18",
      " line 19",
    ]);
  });
});
