/**
 * A Section shows the optional glyph before its title (issue #235): the waypoint sections carry the
 * flag, and a section without one is unchanged.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Flag } from "lucide-react";
import { describe, expect, it } from "vitest";
import { Section } from "./fields";

describe("Section icon", () => {
  it("draws the glyph inside the heading button, before the title", () => {
    const markup = renderToStaticMarkup(
      createElement(Section, { title: "Waypoints (3)", icon: createElement(Flag, { size: 12, "aria-hidden": true }), children: "body" }),
    );
    const button = /<button[^>]*>([\s\S]*?)<\/button>/.exec(markup)?.[1] ?? "";
    expect(button).toContain("lucide-flag");
    expect(button.indexOf("lucide-flag")).toBeLessThan(button.indexOf("Waypoints (3)"));
  });

  it("draws no glyph when none is given, only the chevron", () => {
    const markup = renderToStaticMarkup(createElement(Section, { title: "Plain", children: "body" }));
    expect(markup).not.toContain("lucide-flag");
    expect(markup).toContain("Plain");
  });
});

/**
 * Issue #410: a section's `?` is quiet at rest and shown on a header hover or while it holds focus.
 * It is made transparent, never hidden, so it stays in the tab order; the region title's `?` is the
 * Panel's own and is not wrapped.
 */
describe("Section help", () => {
  const css = readFileSync(fileURLToPath(new URL("./fields.module.css", import.meta.url)), "utf8");
  const rule = (selector: string): string => {
    const start = css.indexOf(selector);
    return start < 0 ? "" : (css.slice(start, css.indexOf("}", start)) ?? "");
  };

  it("wraps the ? in a quiet holder, in the header row and after the title", () => {
    const markup = renderToStaticMarkup(createElement(Section, { title: "Heading", help: "section.heading", children: "body" }));
    const holder = markup.indexOf("sectionHelp");
    expect(holder).toBeGreaterThan(markup.indexOf("Heading"));
    expect(markup.slice(holder)).toContain("<button");
  });

  it("is transparent at rest, not hidden, so it stays in the tab order", () => {
    const resting = rule(".sectionHelp {");
    expect(resting).toContain("opacity: 0");
    expect(resting).not.toMatch(/display:\s*none|visibility:\s*hidden/);
  });

  it("shows on a header hover, and on focus anywhere in the header row, which is keyboard focus on the ?", () => {
    expect(css).toMatch(/\.sectionHeadRow:hover \.sectionHelp/);
    expect(css).toMatch(/\.sectionHeadRow:focus-within \.sectionHelp/);
    expect(rule(".sectionHeadRow:hover .sectionHelp")).toContain("opacity: 1");
  });
});
