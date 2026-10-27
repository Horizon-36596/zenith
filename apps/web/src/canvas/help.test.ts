/**
 * The field's tool hint line (issue #412): every tool that adds or measures says what it does and
 * that Esc leaves it, with or without a selected step, and Select and the pan hand show none.
 */
import { describe, expect, it } from "vitest";
import { toolHintLine } from "./help";
import type { Tool } from "./types";

const LINES: ReadonlyArray<{ tool: Tool; none: string | null; anchored: string | null }> = [
  {
    tool: "addPath",
    none: "Add path: click the field to add a path at the end. Esc to finish",
    anchored: "Add path: click the field to add a path after driveOut. Esc to finish",
  },
  {
    tool: "addCommand",
    none: "Add command: click the field to add a command. Esc to finish",
    anchored: "Add command: click the field to add a command. Esc to finish",
  },
  { tool: "marker", none: "Marker: click a path to drop a marker. Esc to finish", anchored: "Marker: click a path to drop a marker. Esc to finish" },
  {
    tool: "heading",
    none: "Heading: drag a heading arrow of the selected path. Esc to finish",
    anchored: "Heading: drag a heading arrow of the selected path. Esc to finish",
  },
  { tool: "measure", none: "Measure: drag between two points. Esc to finish", anchored: "Measure: drag between two points. Esc to finish" },
  { tool: "select", none: null, anchored: null },
  { tool: "pan", none: null, anchored: null },
];

describe("the tool hint line", () => {
  it.each(LINES)("reads as written for $tool, with and without a selected step", ({ tool, none, anchored }) => {
    expect(toolHintLine(tool, null)).toBe(none);
    expect(toolHintLine(tool, "driveOut")).toBe(anchored);
  });

  it("ends every line it shows with how to leave the tool", () => {
    for (const { tool } of LINES) {
      for (const anchor of [null, "driveOut"]) {
        const line = toolHintLine(tool, anchor);
        if (line !== null) expect(line).toMatch(/\. Esc to finish$/);
      }
    }
  });
});
