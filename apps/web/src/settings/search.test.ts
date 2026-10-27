/**
 * The Settings search (issue #430), as pure logic: what the index holds, which rows a query finds,
 * in what order, and which parts of a label to highlight. The window draws the result.
 */
import { describe, expect, it } from "vitest";
import { SETTINGS } from "./registry";
import { SECTIONS, type SettingsSection } from "./sections";
import { NOT_SEARCHABLE, highlightParts, matchRows, resultCount, searchRows, tokensOf, type SearchRow } from "./search";

const ALL: readonly SettingsSection[] = SECTIONS.map((section) => section.id);

const row = (over: Partial<SearchRow> & Pick<SearchRow, "key" | "label">): SearchRow => ({
  section: "general",
  group: "Group",
  description: "",
  keywords: [],
  values: [],
  target: over.key,
  ...over,
});

const labelsOf = (query: string, rows: readonly SearchRow[], sections: readonly SettingsSection[] = ALL): string[] =>
  matchRows(rows, query, sections).flatMap((group) => group.rows.map((one) => one.label));

describe("tokensOf", () => {
  it("splits on whitespace, lower-cases, and drops the empty pieces", () => {
    expect(tokensOf("  Grid   FIELD ")).toEqual(["grid", "field"]);
    expect(tokensOf("   ")).toEqual([]);
    expect(tokensOf("")).toEqual([]);
  });
});

describe("matchRows", () => {
  const rows = [
    row({ key: "a", label: "Snap", description: "Points stop at the grid." }),
    row({ key: "b", label: "Grid", description: "Lines on the field." }),
    row({ key: "c", label: "Heading for new paths", values: ["Tangent", "Linear", "Constant"], keywords: ["turn"] }),
    row({ key: "d", label: "Theme", section: "editor", values: ["Dark", "Light"] }),
  ];

  it("finds nothing for a blank query, so the window shows its sections as usual", () => {
    expect(matchRows(rows, "", ALL)).toEqual([]);
    expect(matchRows(rows, "   ", ALL)).toEqual([]);
  });

  it("matches a label, a description, a keyword and a value name, in any case", () => {
    expect(labelsOf("SNAP", rows)).toEqual(["Snap"]);
    expect(labelsOf("lines on", rows)).toEqual(["Grid"]);
    expect(labelsOf("turn", rows)).toEqual(["Heading for new paths"]);
    expect(labelsOf("tangent", rows)).toEqual(["Heading for new paths"]);
    expect(labelsOf("dark", rows)).toEqual(["Theme"]);
  });

  it("needs every word, in any order", () => {
    expect(labelsOf("grid field", rows)).toEqual(["Grid"]);
    expect(labelsOf("field grid", rows)).toEqual(["Grid"]);
    expect(labelsOf("grid banana", rows)).toEqual([]);
  });

  it("puts a label match before a description match", () => {
    expect(labelsOf("grid", rows)).toEqual(["Grid", "Snap"]);
  });

  it("puts a match at the start of a word before one inside it", () => {
    const found = labelsOf("ang", [row({ key: "x", label: "Danger" }), row({ key: "y", label: "Angle" })]);
    expect(found).toEqual(["Angle", "Danger"]);
  });

  it("finds one letter only where a word begins, so it does not match nearly every row", () => {
    const some = [
      row({ key: "m", label: "Margin", description: "Between things." }),
      row({ key: "n", label: "Snap", description: "Points stop at the grid." }),
      row({ key: "o", label: "Theme", keywords: ["mode"] }),
    ];
    expect(labelsOf("m", some)).toEqual(["Margin", "Theme"]);
  });

  // #498, W1-14 (UX review, G3): sections go best first, and a section the query names leads.
  it("lists the section a query names, then the best-matching section, before description matches", () => {
    const mixed = [
      row({ key: "t1", label: "Snap button", section: "editor", description: "Shows the button, its key and its menu items." }),
      row({ key: "t2", label: "Measure button", section: "editor", description: "Shows the button, its key and its menu items." }),
      row({ key: "k1", label: "Save", section: "keyboard", description: "The key for Save." }),
      row({ key: "g1", label: "Key points on the grid", section: "general" }),
    ];
    expect(matchRows(mixed, "key", ALL).map((group) => group.section)).toEqual(["keyboard", "general", "editor"]);
    // A query that names no section orders by the best row, then by the list's order.
    expect(matchRows(mixed, "button", ALL).map((group) => group.section)).toEqual(["editor"]);
  });

  it("keeps the registry order between rows that match equally", () => {
    const same = [row({ key: "p", label: "Alpha one" }), row({ key: "q", label: "Alpha two" })];
    expect(labelsOf("alpha", same)).toEqual(["Alpha one", "Alpha two"]);
  });

  it("groups the rows by section, the best match first and ties in the order the sections list", () => {
    // Theme starts with "th"; General has "th" only inside descriptions.
    expect(matchRows(rows, "th", ALL).map((group) => group.section)).toEqual(["editor", "general"]);
    const tie = [row({ key: "e", label: "Thing", section: "editor" }), row({ key: "g", label: "Thing", section: "general" })];
    expect(matchRows(tie, "thing", ALL).map((group) => group.section)).toEqual(["general", "editor"]);
  });

  it("leaves out a section the person does not see", () => {
    expect(labelsOf("dark", rows, ["general"])).toEqual([]);
  });

  it("treats punctuation as plain text", () => {
    expect(() => matchRows(rows, "(.*[", ALL)).not.toThrow();
    expect(labelsOf("(.*[", rows)).toEqual([]);
  });

  it("counts every row it found", () => {
    expect(resultCount(matchRows(rows, "th", ALL))).toBe(labelsOf("th", rows).length);
    expect(resultCount([])).toBe(0);
  });
});

describe("highlightParts", () => {
  const joined = (text: string, query: string): string =>
    highlightParts(text, query)
      .map((part) => part.text)
      .join("");

  it("marks each place a word of the query appears and keeps the text whole", () => {
    expect(highlightParts("Heading for new paths", "head new")).toEqual([
      { text: "Head", match: true },
      { text: "ing for ", match: false },
      { text: "new", match: true },
      { text: " paths", match: false },
    ]);
    expect(joined("Heading for new paths", "head new")).toBe("Heading for new paths");
  });

  it("merges words that overlap or touch into one mark", () => {
    expect(highlightParts("Snapshot", "snap shot")).toEqual([{ text: "Snapshot", match: true }]);
    expect(highlightParts("Grid", "gr ri")).toEqual([
      { text: "Gri", match: true },
      { text: "d", match: false },
    ]);
  });

  it("is one plain part when nothing matches or the query is blank", () => {
    expect(highlightParts("Grid", "zzz")).toEqual([{ text: "Grid", match: false }]);
    expect(highlightParts("Grid", "  ")).toEqual([{ text: "Grid", match: false }]);
    expect(highlightParts("", "grid")).toEqual([]);
  });

  it("marks one letter only where a word begins", () => {
    expect(highlightParts("Heading for new paths", "n")).toEqual([
      { text: "Heading for ", match: false },
      { text: "n", match: true },
      { text: "ew paths", match: false },
    ]);
  });

  it("matches without regard to case but shows the text as written", () => {
    expect(highlightParts("Safety margin", "MARGIN")).toEqual([
      { text: "Safety ", match: false },
      { text: "margin", match: true },
    ]);
  });
});

describe("the index", () => {
  const rows = searchRows(false);

  it("has unique keys, a label on every row, and a section the window has", () => {
    expect(new Set(rows.map((one) => one.key)).size).toBe(rows.length);
    for (const one of rows) {
      expect(one.label.trim(), one.key).not.toBe("");
      expect(ALL, one.key).toContain(one.section);
      expect(one.target.trim(), one.key).not.toBe("");
    }
  });

  it("lists every registered setting that Settings draws a row for, and none it does not", () => {
    const keys = new Set(rows.map((one) => one.key));
    for (const entry of SETTINGS) {
      const listed =
        entry.awaiting === undefined && entry.unlisted === undefined && !NOT_SEARCHABLE.has(entry.id) && entry.desktopOnly !== true;
      expect(keys.has(entry.id), `${entry.id} is ${listed ? "" : "not "}searchable`).toBe(listed);
    }
  });

  // The 0.1.2 UX sweep (W1-3): Full sim speed does nothing in a browser, so only the desktop app lists it.
  it("lists a desktop-only setting such as Full sim speed in the desktop app and not in a browser", () => {
    expect(rows.some((one) => one.key === "sim.speed")).toBe(false);
    expect(searchRows(true).some((one) => one.key === "sim.speed")).toBe(true);
  });

  it("takes a row's group, label and description from the registry, and its choices as value names", () => {
    const heading = rows.find((one) => one.key === "editing.defaultHeading");
    expect(heading?.section).toBe("editor");
    expect(heading?.group).toBe("Editing");
    expect(heading?.values).toEqual(["Tangent", "Linear", "Constant"]);
    expect(labelsOf("tangent", rows)).toContain("Heading for new paths");
  });

  it("has rows in every section a person can open, so no section is a dead end", () => {
    for (const section of ALL) expect(rows.some((one) => one.section === section), section).toBe(true);
  });

  it("finds the rows people asked for by name", () => {
    expect(labelsOf("theme", rows)).toContain("Theme");
    expect(labelsOf("display name", rows)).toContain("Display name");
    expect(labelsOf("track width", rows)).toContain("Track width");
    expect(labelsOf("shortcut", rows).length).toBeGreaterThan(0);
  });
});
