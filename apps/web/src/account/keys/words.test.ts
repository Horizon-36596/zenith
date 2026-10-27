/**
 * The key screens' words: short plain sentences, and all of them in words.ts, so no component has
 * text of its own.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as words from "./words";
import { teamWords } from "./words";

describe("the key screens' words", () => {
  it("names a team by its number and name, or its name alone", () => {
    expect(teamWords({ teamName: "Horizon", teamNumber: 36596 })).toBe("36596 Horizon");
    expect(teamWords({ teamName: "Horizon", teamNumber: null })).toBe("Horizon");
    expect(teamWords({ teamName: "Horizon" })).toBe("Horizon");
  });

  /** Every string the word tables hold, with each sentence-making function given a sample name. */
  function everyString(): string[] {
    const out: string[] = [];
    for (const value of Object.values(words)) {
      if (typeof value !== "object" || value === null) continue;
      for (const entry of Object.values(value as Record<string, unknown>)) {
        if (typeof entry === "string") out.push(entry);
        if (typeof entry === "function") out.push(String((entry as (sample: string) => unknown)("Ada")));
      }
    }
    return out;
  }

  it("keeps every sentence short, and never shouts", () => {
    const strings = everyString();
    expect(strings.length).toBeGreaterThan(60);
    for (const string of strings) {
      for (const sentence of string.split(/(?<=[.:?])\s+/)) {
        expect(sentence.split(/\s+/).length, sentence).toBeLessThanOrEqual(24);
      }
      expect(string, string).not.toMatch(/\b[A-Z]{4,}\b(?<!ZNTH)/);
      expect(string, string).not.toMatch(/!/);
    }
  });

  it("keeps all the words in words.ts: no component has text, a tooltip or a hint of its own", () => {
    const dir = fileURLToPath(new URL(".", import.meta.url));
    const sources = readdirSync(dir).filter((name) => name.endsWith(".tsx"));
    expect(sources.length).toBeGreaterThanOrEqual(9);
    for (const name of sources) {
      const source = readFileSync(join(dir, name), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      // Text right before a closing tag, outside braces, such as <p>Continue</p>.
      expect(source, name).not.toMatch(/>\s*[A-Za-z][^<>{}=;]*<\//);
      // A literal for a prop people read.
      expect(source, name).not.toMatch(/\b(tooltip|hint|label|caption|aria-label)="/);
    }
  });
});
