/**
 * A row with `describe={id}` (issue #238): in Labels only ("compact") it draws no brief, in With
 * descriptions ("full") it draws the brief on one line under the label, and in both modes its
 * control's `aria-describedby` holds the brief and the more together. The unit tests have no DOM,
 * so this renders to markup and follows the ids the control points at.
 */
import { createElement as h, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { FieldRow } from "./fields";
import { Row } from "../settings/parts";
import { DESCRIPTIONS } from "../help/descriptions";
import { DEFAULT_PREFS, type Descriptions } from "../state/prefs";
import { setPrefs } from "../state/store";

const ENTRY = DESCRIPTIONS["inspector.estimated"];
const HINT = `${ENTRY.brief}. ${ENTRY.more}`;

const render = (element: ReactElement, mode: Descriptions): string => {
  setPrefs({ descriptions: mode });
  return renderToStaticMarkup(element);
};

/** The text of every element the first `tag` in `html` names in its `aria-describedby`, joined. */
function describedBy(html: string, tag: string): string {
  const open = new RegExp(`<${tag}\\b[^>]*>`).exec(html)?.[0] ?? "";
  const ids = /aria-describedby="([^"]*)"/.exec(open)?.[1]?.split(/\s+/) ?? [];
  return ids
    .map((id) => new RegExp(`id="${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^>]*>([^<]*)<`).exec(html)?.[1] ?? "")
    .join(" ")
    .replace(/&#x27;/g, "'");
}

const briefs = (html: string): string[] =>
  [...html.matchAll(/data-testid="row-brief"[^>]*>([^<]*)</g)].map((match) => match[1] ?? "");

const estimated = () => h(FieldRow, { label: "Estimated", htmlFor: "estimate", describe: "inspector.estimated", children: h("input", { id: "estimate" }) });

afterEach(() => {
  setPrefs({ descriptions: DEFAULT_PREFS.descriptions });
});

describe("a described field row", () => {
  it("draws no brief in Labels only", () => {
    expect(briefs(render(estimated(), "compact"))).toEqual([]);
  });

  it("draws the brief, on one line, in With descriptions", () => {
    const html = render(estimated(), "full");
    expect(briefs(html)).toEqual([ENTRY.brief]);
    const tag = /<[^>]*data-testid="row-brief"[^>]*>/.exec(html)?.[0] ?? "";
    // One line: the class that clips it to a single line with an ellipsis (fields.module.css).
    expect(tag).toMatch(/class="[^"]*brief/);
  });

  it("describes its control by the brief and the more in both modes", () => {
    expect(describedBy(render(estimated(), "compact"), "input")).toBe(HINT);
    expect(describedBy(render(estimated(), "full"), "input")).toBe(HINT);
  });
});

describe("a described Settings row", () => {
  const row = () => h(Row, { label: "Descriptions", describe: "settings.descriptions", children: h("button", { type: "button" }, "Labels only") });

  it("draws its brief only in With descriptions, and is described by the whole hint in both", () => {
    const entry = DESCRIPTIONS["settings.descriptions"];
    expect(briefs(render(row(), "compact"))).toEqual([]);
    expect(briefs(render(row(), "full"))).toEqual([entry.brief]);
    expect(describedBy(render(row(), "compact"), "button")).toBe(`${entry.brief}. ${entry.more}`);
  });
});
