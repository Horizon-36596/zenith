/**
 * A canvas menu row leads with its item's 16 px icon at stroke 1.75, as every menu's rows do
 * (UI_GUIDE 9.10). Once any row has an icon every row keeps the column, so the labels line up, and
 * a choice shows its check there instead.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { Copy } from "lucide-react";
import { describe, expect, it } from "vitest";
import { menuButton } from "./ContextMenu";
import type { CanvasAction } from "./types";

const item = (extra: Partial<CanvasAction> = {}): CanvasAction => ({
  id: "step.duplicate",
  label: "Duplicate step",
  enabled: true,
  run: () => undefined,
  ...extra,
});

const close = (): void => undefined;

describe("canvas menu row", () => {
  it("draws the item's icon at 16 px and stroke 1.75 in the leading column", () => {
    const markup = renderToStaticMarkup(menuButton(item({ icon: Copy }), close, true));
    expect(markup).toContain('data-testid="canvas-menu-icon"');
    expect(markup).toContain('width="16"');
    expect(markup).toContain('stroke-width="1.75"');
    expect(markup).toContain('data-lead="true"');
  });

  it("keeps an empty leading slot on a row without an icon when the menu has icons", () => {
    const markup = renderToStaticMarkup(menuButton(item(), close, true));
    expect(markup).toContain('data-testid="canvas-menu-icon"');
    expect(markup).not.toContain("<svg");
  });

  it("draws no leading column in a menu where no row has an icon", () => {
    const markup = renderToStaticMarkup(menuButton(item(), close, false));
    expect(markup).not.toContain("canvas-menu-icon");
    expect(markup).not.toContain("data-lead");
  });

  it("shows a choice's check in the leading column, at the same size", () => {
    const markup = renderToStaticMarkup(menuButton(item({ checked: true, icon: Copy }), close, true));
    expect(markup).not.toContain("canvas-menu-icon");
    expect(markup).toContain('role="menuitemradio"');
    expect(markup).toContain('width="16"');
  });
});
