/**
 * Row hints (issue #237, UI_GUIDE section 9.4): a row's hint is always its control's
 * `aria-describedby`, in the Inspector's field rows and in Settings rows alike, so a screen reader
 * hears the words a long hover or Shift F1 shows. The repository has no DOM in its unit tests, so
 * this renders to markup and follows the id the control points at.
 */
import { createElement as h, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FieldRow } from "./fields";
import { Tooltip } from "./Tooltip";
import { Row } from "../settings/parts";

const HINT = "How long the plan expects this step to take.";

/** The text of every element the first `tag` in `html` names in its `aria-describedby`. */
function describedBy(html: string, tag: string): string[] {
  const open = new RegExp(`<${tag}\\b[^>]*>`).exec(html)?.[0];
  expect(open, `no <${tag}> in ${html}`).toBeDefined();
  const ids = /aria-describedby="([^"]*)"/.exec(open ?? "")?.[1]?.split(/\s+/) ?? [];
  return ids.map((id) => {
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`id="${escaped}"[^>]*>([^<]*)<`).exec(html)?.[1] ?? `(no element with id ${id})`;
  });
}

const render = (element: ReactElement): string => renderToStaticMarkup(element);

describe("a field row with a hint", () => {
  it("gives its input an aria-describedby that points at text equal to the hint", () => {
    const html = render(h(FieldRow, { label: "Estimated", htmlFor: "estimate", hint: HINT, children: h("input", { id: "estimate" }) }));
    expect(describedBy(html, "input")).toContain(HINT);
  });

  it("does the same for an input inside a tooltip, next to the tooltip's own description", () => {
    const input = h(Tooltip, { label: "Timeout", hint: "Drag sideways to change it.", children: h("input", { id: "timeout" }) });
    const html = render(h(FieldRow, { label: "Timeout", htmlFor: "timeout", hint: HINT, children: input }));
    expect(describedBy(html, "input")).toContain(HINT);
  });

  it("keeps a description the control already had", () => {
    const children = [h("input", { key: "input", id: "speed", "aria-describedby": "unit" }), h("span", { key: "unit", id: "unit" }, "in/s")];
    const html = render(h(FieldRow, { label: "Speed", htmlFor: "speed", hint: HINT, children }));
    expect(describedBy(html, "input")).toEqual(["in/s", HINT]);
  });

  it("keeps the description a control inside a tooltip already had, next to the hint", () => {
    const input = h(Tooltip, { key: "input", label: "Speed", children: h("input", { id: "speed", "aria-describedby": "unit" }) });
    const children = [input, h("span", { key: "unit", id: "unit" }, "in/s")];
    const html = render(h(FieldRow, { label: "Speed", htmlFor: "speed", hint: HINT, children }));
    // The tooltip's own description of a text field follows the two.
    expect(describedBy(html, "input").slice(0, 2)).toEqual(["in/s", HINT]);
  });

  it("describes a read-only value that is focusable, as the Inspector's Estimated readout is", () => {
    const readout = h("span", { tabIndex: 0 }, "1.20");
    const html = render(h(FieldRow, { label: "Estimated", hint: HINT, children: readout }));
    expect(describedBy(html, "span")).toEqual([HINT]);
  });

  it("leaves a plain, unfocusable span alone", () => {
    const html = render(h(FieldRow, { label: "Estimated", hint: HINT, children: h("span", { className: "plain" }, "1.20") }));
    expect(/<span class="plain"[^>]*>/.exec(html)?.[0]).not.toContain("aria-describedby");
  });

  it("adds nothing to a row without a hint", () => {
    const html = render(h(FieldRow, { label: "Estimated", htmlFor: "estimate", children: h("input", { id: "estimate" }) }));
    expect(html).not.toContain("aria-describedby");
  });
});

describe("a Settings row with a hint", () => {
  it("gives its control an aria-describedby that points at text equal to the hint", () => {
    const html = render(h(Row, { label: "Theme", hint: HINT, children: h("button", { type: "button" }, "Dark") }));
    expect(describedBy(html, "button")).toContain(HINT);
  });
});
