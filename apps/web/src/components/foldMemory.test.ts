/**
 * Remembered folds (issue #239, UI_GUIDE section 9.3). A Section with a `foldId` takes its open state
 * from `prefs.inspectorFolds`, falls back to its default, and writes the memory only when the person
 * clicks its header. A forced open, the tour's reveal or a selected point, opens it for now and
 * leaves the memory alone.
 */
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";
import { getState, setPrefs } from "../state/store";
import { TOUR_REVEAL_EVENT } from "../tour/signals";
import { Section } from "./fields";
import { foldShown, rememberFold, revealListener, stillHeld } from "./foldMemory";

beforeEach(() => {
  setPrefs({ inspectorFolds: {} });
});

describe("a section's open state", () => {
  it("is its default until the person folds or opens it", () => {
    expect(foldShown({ remembered: undefined, defaultOpen: true })).toBe(true);
    expect(foldShown({ remembered: undefined, defaultOpen: false })).toBe(false);
    expect(foldShown({ remembered: false, defaultOpen: true })).toBe(false);
    expect(foldShown({ remembered: true, defaultOpen: false })).toBe(true);
  });

  it("is remembered by its kind-level id when the person toggles it", () => {
    rememberFold("path.heading", false);
    expect(getState().prefs.inspectorFolds).toEqual({ "path.heading": false });
    rememberFold("step.more", true);
    expect(getState().prefs.inspectorFolds).toEqual({ "path.heading": false, "step.more": true });
  });
});

describe("a forced open", () => {
  // The tour's reveal runs in an effect, which a static render does not run, so a rendered Section
  // under a real reveal event is checked in e2e/inspector-folds.spec.ts. Here: the listener's answer
  // for each event, and a rendered Section held open by forceOpen.
  it("the reveal listener says shown only for its own anchor, and not shown for any other or none", () => {
    rememberFold("path.heading", false);
    const before = getState().prefs.inspectorFolds;
    const calls: boolean[] = [];
    const onReveal = revealListener("section.heading", (shown) => {
      calls.push(shown);
    });
    onReveal(new CustomEvent<string>(TOUR_REVEAL_EVENT, { detail: "section.heading" }));
    onReveal(new CustomEvent<string>(TOUR_REVEAL_EVENT, { detail: "section.markers" }));
    onReveal(new CustomEvent<string>(TOUR_REVEAL_EVENT, { detail: "section.heading" }));
    onReveal(new CustomEvent<null>(TOUR_REVEAL_EVENT, { detail: null }));
    onReveal(new CustomEvent<string>("some-other-event", { detail: "section.heading" }));
    expect(calls).toEqual([true, false, true, false]);
    expect(getState().prefs.inspectorFolds).toBe(before);
  });

  it("a Section held open by forceOpen shows its body over a folded memory and leaves the memory alone", () => {
    rememberFold("path.segment", false);
    const before = getState().prefs.inspectorFolds;
    const html = renderToStaticMarkup(
      h(Section, {
        title: "Path 1",
        foldId: "path.segment",
        forceOpen: true,
        children: h("p", { "data-testid": "the-body" }, "body"),
      }),
    );
    expect(html).toContain("the-body");
    expect(html).toContain('aria-expanded="true"');
    expect(getState().prefs.inspectorFolds).toBe(before);
    expect(getState().prefs.inspectorFolds).toEqual({ "path.segment": false });
  });
});

describe("a hold a header click let go of", () => {
  // PR #270 review: folding a path over one selected point must not keep the next point in that
  // path hidden. The click releases only the holder it folded over.
  it("stays released for the same holder and holds again for a new one", () => {
    expect(stillHeld("to", undefined)).toBe(true);
    expect(stillHeld("to", "to")).toBe(false);
    expect(stillHeld("from", "to")).toBe(true);
    expect(stillHeld("control-1", "control-0")).toBe(true);
  });

  it("holds nothing when nothing is selected", () => {
    expect(stillHeld(undefined, undefined)).toBe(false);
    expect(stillHeld(undefined, "to")).toBe(false);
  });
});

describe("the section header", () => {
  const render = () =>
    renderToStaticMarkup(
      h(Section, {
        title: "More",
        foldId: "step.more",
        defaultOpen: false,
        summary: "Timeout, notes",
        actions: h("button", { type: "button", "data-testid": "the-action" }, "x"),
        help: "section.step",
        children: h("p", { "data-testid": "the-body" }, "body"),
      }),
    );

  it("shows the summary while folded, and its one action last, at the header's right edge after the ?", () => {
    // Issue #431: the ? is revealed on hover, so the action keeps the right edge whether it shows or not.
    const html = render();
    expect(html).toContain("Timeout, notes");
    expect(html).not.toContain("the-body");
    const action = html.indexOf("the-action");
    const help = html.indexOf("What is");
    expect(help).toBeGreaterThan(-1);
    expect(action).toBeGreaterThan(help);
  });

  it("counts what a list holds, and shows a dot while folded with something set or to look at", () => {
    const folded = (marked: "set" | "warn") =>
      renderToStaticMarkup(h(Section, { title: "Notes", foldId: "step.notes", defaultOpen: false, count: 2, marked, children: "body" }));
    const set = folded("set");
    expect(set).toContain('data-testid="section-count"');
    expect(set).toMatch(/Notes<\/span> <span[^>]*data-testid="section-count"[^>]*>2</);
    expect(set).toContain('data-tone="set"');
    expect(set).toContain('aria-label="Something is set inside"');
    expect(folded("warn")).toContain('data-tone="warn"');
    // Open, the rows show it themselves, so the dot goes.
    rememberFold("step.notes", true);
    expect(folded("set")).not.toContain("section-dot");
  });

  it("draws no second ? under a selection header that has it, and keeps the tour anchor", () => {
    // The start, a marker and a selected waypoint: the header has the one `?` (issue #431).
    const html = renderToStaticMarkup(
      h(Section, { title: "Marker", foldId: "marker", help: "section.marker", helpInHeader: true, children: "body" }),
    );
    expect(html).not.toContain("What is");
    expect(html).not.toContain('data-testid="help-section.marker"');
    expect(html).toContain('data-tour="section.marker"');
    const shown = renderToStaticMarkup(h(Section, { title: "Marker", foldId: "marker", help: "section.marker", children: "body" }));
    expect(shown).toContain('data-testid="help-section.marker"');
  });

  it("drops the summary and shows the body once the memory says open", () => {
    rememberFold("step.more", true);
    const html = render();
    expect(html).not.toContain("Timeout, notes");
    expect(html).toContain("the-body");
  });
});
