import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DESCRIPTIONS } from "../help/descriptions";
import { PARALLEL_MODES } from "./parallelModes";

/** Issue #246, decision parallel-naming: Insert and the Inspector name the parallel modes alike. */
const source = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8").replace(/\r\n/g, "\n");

const INSERT = source("../panels/InsertMenu.tsx");
const INSPECTOR = source("../panels/Inspector.tsx");

describe("the parallel mode names", () => {
  it("are the Inspector's plain wording", () => {
    expect(PARALLEL_MODES.map((mode) => mode.label)).toEqual([
      "Wait for all of them",
      "Stop when any step ends",
      "Stop when a chosen step ends",
    ]);
  });

  it("are read from one list by both the Insert menu and the Inspector", () => {
    for (const [name, text] of [["InsertMenu.tsx", INSERT], ["Inspector.tsx", INSPECTOR]] as const) {
      expect(text, `${name} reads the shared list`).toMatch(/import \{[^}]*PARALLEL_MODES[^}]*\} from "\.\.\/lib\/parallelModes"/);
    }
  });

  it("are not written out again in either source, nor are Pedro's names used as titles", () => {
    for (const [name, text] of [["InsertMenu.tsx", INSERT], ["Inspector.tsx", INSPECTOR]] as const) {
      for (const label of PARALLEL_MODES.map((mode) => mode.label)) {
        expect(text, `${name} spells out "${label}"`).not.toContain(`"${label}"`);
      }
      expect(text, `${name} titles a mode Race`).not.toMatch(/title: "(All|Race|Deadline)"/);
    }
  });

  it("have a description in the table under the same label, naming the file's word for the mode", () => {
    const entries = [
      ["all", DESCRIPTIONS["insert.parallelAll"]],
      ["race", DESCRIPTIONS["insert.parallelRace"]],
      ["deadline", DESCRIPTIONS["insert.parallelDeadline"]],
    ] as const;
    for (const [mode, entry] of entries) {
      expect(entry.label).toBe(PARALLEL_MODES.find((candidate) => candidate.value === mode)?.label);
      expect(entry.more, `${mode} is named as the file's word`).toMatch(new RegExp(String.raw`\bcall this ${mode}\.$`));
    }
  });
});
