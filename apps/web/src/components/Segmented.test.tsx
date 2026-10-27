/**
 * The one segmented switch (UI_GUIDE 9.16): a named group of `aria-pressed` buttons whose test ids
 * the e2e specs read, an unavailable option that stays focusable and says why, and no second copy of
 * the control anywhere in the app.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Segmented, segmentHint, type SegmentOption } from "./Segmented";

const OPTIONS: ReadonlyArray<SegmentOption<"on" | "off">> = [
  { value: "on", label: "On", does: "Turns it on." },
  { value: "off", label: "Off", does: "Turns it off.", whyDisabled: "Nothing to turn off." },
];

function render(props: Partial<Parameters<typeof Segmented<"on" | "off">>[0]> = {}): string {
  return renderToStaticMarkup(
    createElement(Segmented<"on" | "off">, {
      label: "Power",
      options: OPTIONS,
      value: "on",
      onChange: () => undefined,
      testId: "power",
      ...props,
    }),
  );
}

describe("Segmented", () => {
  it("is a named group of pressed buttons with the test ids the specs read", () => {
    const markup = render();
    expect(markup).toContain('role="group"');
    expect(markup).toContain('aria-label="Power"');
    expect(markup).toContain('data-testid="power"');
    expect(markup).toMatch(/aria-pressed="true"[^>]*data-testid="power-on"/);
    expect(markup).toMatch(/aria-pressed="false"[^>]*data-testid="power-off"/);
  });

  it("presses nothing when the value is null", () => {
    expect(render({ value: null })).not.toContain('aria-pressed="true"');
  });

  it("keeps an unavailable option focusable, aria-disabled rather than disabled", () => {
    const markup = render();
    expect(markup).toMatch(/aria-disabled="true"[^>]*data-testid="power-off"/);
    expect(markup).not.toMatch(/\sdisabled=""/);
  });

  it("says what an option does, or why it cannot be chosen now", () => {
    expect(segmentHint(OPTIONS[0]!)).toBe("Turns it on.");
    expect(segmentHint(OPTIONS[1]!)).toBe("Unavailable: Nothing to turn off.");
  });

  it("carries a short word's longer name and the group's data attributes", () => {
    const markup = render({
      options: [{ value: "on", label: "On", ariaLabel: "Power on", does: "Turns it on." }],
      groupData: { "data-level": "on" },
      size: "small",
    });
    expect(markup).toContain('aria-label="Power on"');
    expect(markup).toContain('data-level="on"');
    expect(markup).toContain('data-size="small"');
  });
});

describe("one segmented switch", () => {
  const src = fileURLToPath(new URL("..", import.meta.url));
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return files(path);
      return /\.tsx$/.test(name) && !/\.test\.tsx$/.test(name) ? [path] : [];
    });

  it("is defined only in components/Segmented.tsx", () => {
    const defining = files(src).filter((path) => /export function (Segmented|Choice)\b/.test(readFileSync(path, "utf8")));
    expect(defining.map((path) => path.replace(/\\/g, "/").replace(/^.*\/src\//, ""))).toEqual(["components/Segmented.tsx"]);
  }, 20_000);
});
