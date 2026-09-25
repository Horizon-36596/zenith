/**
 * QA 15, the visual pass (site/docs/editor.md, UI_GUIDE): every screen and state at 1440x900
 * and 1280x720, screenshotted, and audited for text cut off by its box, text boxes that overlap,
 * text under 4.5:1 contrast (3:1 for large text), and any leftover v1 teal. The audit writes what it
 * finds next to the screenshots as JSON, so a failure names the element.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { LAYOUT_SIZES as SIZES } from "../viewports";
import { SHOTS_DIR, fixture, loadExample, openProjectWith, shot, skipTour, waitForFonts } from "./helpers";

export interface Audit {
  truncated: string[];
  overlaps: string[];
  lowContrast: string[];
  teal: string[];
}

/**
 * Runs in the page. Colours are resolved through a 1x1 canvas, so oklch, color-mix and the rest all
 * come back as sRGB bytes. The effective background is the first opaque ancestor background,
 * composited over the page's; text over a gradient or image is skipped and checked in the screenshot.
 */
const AUDIT = `(() => {
  const probe = document.createElement("canvas"); probe.width = probe.height = 1;
  const ctx = probe.getContext("2d", { willReadFrequently: true });
  const rgba = (c) => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = "#000"; ctx.fillStyle = c; ctx.fillRect(0, 0, 1, 1); const d = ctx.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2], d[3] / 255]; };
  const lum = ([r, g, b]) => { const ch = (v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }; return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b); };
  const over = (top, under) => [0, 1, 2].map((i) => top[i] * top[3] + under[i] * (1 - top[3])).concat([1]);
  const bgOf = (el) => {
    const stack = [];
    for (let at = el; at; at = at.parentElement) { const st = getComputedStyle(at); if (st.backgroundImage !== "none") return null; const c = rgba(st.backgroundColor); if (c[3] > 0) { stack.push(c); if (c[3] >= 0.99) break; } }
    let colour = [255, 255, 255, 1];
    const base = rgba(getComputedStyle(document.body).backgroundColor); if (base[3] > 0) colour = base;
    for (const c of stack.reverse()) colour = over(c, colour);
    return colour;
  };
  const name = (el) => (el.getAttribute("data-testid") ?? el.closest("[data-testid]")?.getAttribute("data-testid") ?? el.tagName.toLowerCase()) + ' "' + (el.textContent ?? "").trim().slice(0, 40) + '"';
  const visible = (el) => { const r = el.getBoundingClientRect(); if (r.width < 1 || r.height < 1) return false; const s = getComputedStyle(el); if (s.visibility === "hidden" || Number(s.opacity) === 0) return false; if (el.closest('[aria-hidden="true"]')) return false; return r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth; };
  const leaves = [...document.querySelectorAll("body *")].filter((el) => !(el instanceof SVGElement) && el.tagName !== "CANVAS" && [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim() !== "") && visible(el));
  const truncated = [], overlaps = [], lowContrast = [], teal = [];
  for (const el of leaves) {
    const s = getComputedStyle(el);
    const clips = s.textOverflow === "ellipsis" || s.overflow === "hidden" || s.overflowX === "hidden";
    // A cut-off line is allowed where hovering it shows the whole text (the insert menu's help).
    const tipped = el.closest("[data-testid^=insert-kind-]") !== null;
    if (clips && !tipped && el.scrollWidth > el.clientWidth + 1) truncated.push(name(el) + " " + el.scrollWidth + ">" + el.clientWidth);
    // A gradient or picture behind the text cannot be read as one colour; those are checked by eye.
    const fg = rgba(s.color); const bg = bgOf(el); if (bg === null) continue; const mixed = over(fg, bg);
    const l1 = lum(mixed), l2 = lum(bg); const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    const size = parseFloat(s.fontSize); const bold = Number(s.fontWeight) >= 700;
    const need = size >= 24 || (bold && size >= 18.66) ? 3 : 4.5;
    const disabled = el.closest("[disabled], [aria-disabled=true]") !== null;
    if (ratio < need && !disabled) lowContrast.push(name(el) + " " + ratio.toFixed(2) + ":1 at " + size + "px, " + s.color);
  }
  // Pairwise overlap of text boxes that are not nested, using the text's own line boxes clipped
  // by every scrolling or clipping ancestor, and only within one layer: a menu, popover or dialog
  // drawn over the page is layering, not an overlap.
  const clipOf = (el, r) => {
    let box = { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    for (let at = el.parentElement; at; at = at.parentElement) {
      const st = getComputedStyle(at);
      if (st.overflow === "visible" && st.overflowX === "visible" && st.overflowY === "visible") continue;
      const c = at.getBoundingClientRect();
      box = { left: Math.max(box.left, c.left), top: Math.max(box.top, c.top), right: Math.min(box.right, c.right), bottom: Math.min(box.bottom, c.bottom) };
    }
    return box;
  };
  const layerOf = (el) => {
    for (let at = el; at; at = at.parentElement) {
      if (at.tagName === "DIALOG" || at.hasAttribute("popover") || ["menu", "listbox", "tooltip", "dialog"].includes(at.getAttribute("role") ?? "")) return at;
      const st = getComputedStyle(at);
      if (st.position === "fixed" || (st.position === "absolute" && st.zIndex !== "auto")) return at;
    }
    return document.body;
  };
  const boxes = leaves.map((el) => { const range = document.createRange(); range.selectNodeContents(el); return { el, r: clipOf(el, range.getBoundingClientRect()), layer: layerOf(el) }; }).filter((b) => b.r.right - b.r.left > 0 && b.r.bottom - b.r.top > 0);
  for (let i = 0; i < boxes.length; i += 1) for (let j = i + 1; j < boxes.length; j += 1) {
    const a = boxes[i], b = boxes[j];
    if (a.layer !== b.layer) continue;
    if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
    const w = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left); const h = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
    if (w > 2 && h > 2) overlaps.push(name(a.el) + " x " + name(b.el));
  }
  // v1 teal: hue 160 to 195 degrees, saturated, anywhere in colour, background or border.
  const hue = ([r, g, b]) => { const mx = Math.max(r, g, b), mn = Math.min(r, g, b); if (mx === mn) return { h: 0, s: 0 }; const d = mx - mn; let h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; h *= 60; if (h < 0) h += 360; const l = (mx + mn) / 510; const s = d / 255 / (1 - Math.abs(2 * l - 1)); return { h, s }; };
  for (const el of document.querySelectorAll("body *")) {
    if (!visible(el)) continue;
    const s = getComputedStyle(el);
    for (const prop of ["color", "backgroundColor", "borderTopColor", "outlineColor"]) {
      if (prop !== "color" && prop !== "backgroundColor" && s[prop.replace("Color", "Width")] === "0px") continue;
      const c = rgba(s[prop]); if (c[3] < 0.2) continue;
      const { h, s: sat } = hue(c);
      if (h >= 160 && h <= 195 && sat > 0.35) teal.push(name(el) + " " + prop + " " + s[prop]);
    }
  }
  return { truncated, overlaps, lowContrast, teal };
})()`;

async function audit(page: Page, label: string): Promise<Audit> {
  await waitForFonts(page);
  await page.waitForTimeout(250);
  await shot(page, `15-${label}`);
  const found = (await page.evaluate(AUDIT)) as Audit;
  writeFileSync(join(SHOTS_DIR, `15-${label}.audit.json`), JSON.stringify(found, null, 2));
  return found;
}

type Screen = [string, (page: Page) => Promise<void>];

const SCREENS: Screen[] = [
  ["welcome", async (page) => {
    await page.goto("/");
  }],
  ["editor", async (page) => {
    await loadExample(page);
  }],
  ["path-selected", async (page) => {
    await loadExample(page);
    await page.getByTestId("step-row-toGarden").getByRole("button").first().click();
  }],
  ["command-selected", async (page) => {
    await loadExample(page);
    await page.getByTestId("step-row-scorePreload").getByRole("button").first().click();
  }],
  ["group-selected", async (page) => {
    await loadExample(page);
    // returnToScore is a deadline group with a sequence in it.
    await page.getByTestId("step-row-returnToScore").getByRole("button").first().click();
  }],
  ["insert-menu", async (page) => {
    await loadExample(page);
    await page.getByTestId("step-row-driveOut").getByRole("button").first().click();
    await page.evaluate(`import("/src/state/ui.ts").then((u) => u.openInsertMenu("kinds"))`);
  }],
  ["palette", async (page) => {
    await loadExample(page);
    await page.keyboard.press("Control+k");
  }],
  ["shortcuts", async (page) => {
    await loadExample(page);
    await page.keyboard.press("F1");
  }],
  ["open-dialog", async (page) => {
    await loadExample(page);
    await page.keyboard.press("Control+o");
  }],
  ["simulate-dialog", async (page) => {
    await loadExample(page);
    await page.keyboard.press("F5");
  }],
  ["light-theme", async (page) => {
    await loadExample(page);
    await page.evaluate(`import("/src/state/store.ts").then((m) => m.setPrefs({ theme: "light" }))`);
    await page.getByTestId("step-row-driveOut").getByRole("button").first().click();
  }],
  ["curves-fixture", async (page) => {
    await openProjectWith(page, { "qa-curves.auto.json": fixture("qa-curves.auto.json") });
  }],
];

for (const size of SIZES) {
  test.describe(`at ${String(size.width)}x${String(size.height)}`, () => {
    test.use({ viewport: size });

    for (const [label, open] of SCREENS) {
      test(`${label}: no teal, no overlapping text, contrast at least 4.5:1`, async ({ page }) => {
        await skipTour(page);
        await open(page);
        const found = await audit(page, `${label}-${String(size.width)}`);
        expect(found.teal, "leftover v1 teal").toEqual([]);
        expect(found.overlaps, "text boxes that overlap").toEqual([]);
        expect(found.lowContrast, "text under the contrast floor").toEqual([]);
        expect(found.truncated, "text cut off by its box").toEqual([]);
      });
    }

    test("the core tour's first stop: contrast and no teal on the coach mark", async ({ page }) => {
      await page.goto("/");
      await expect(page.getByTestId("tour-card")).toBeVisible();
      const found = await audit(page, `tour-${String(size.width)}`);
      expect(found.teal).toEqual([]);
      expect(found.lowContrast).toEqual([]);
    });
  });
}

test.describe("the shortcut sheet", () => {
  test.beforeEach(async ({ page }) => {
    await skipTour(page);
    await loadExample(page);
    await page.keyboard.press("F1");
    await expect(page.getByTestId("shortcuts-overlay")).toBeVisible();
    await waitForFonts(page);
  });

  test("lists each key once, with one meaning", async ({ page }) => {
    // The On the field table reuses C, S and Esc for a selected curve point, which is a different
    // context; the keyboard tables above it should not repeat a key.
    const keys = await page.getByTestId("shortcuts-overlay").locator("section:not([data-testid=shortcuts-canvas]) dt kbd").allTextContents();
    const counts = new Map<string, number>();
    for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
    const twice = [...counts.entries()].filter(([, n]) => n > 1).map(([key]) => key);
    expect(twice).toEqual([]);
  });

  for (const size of SIZES) {
    test.describe(`at ${String(size.width)}x${String(size.height)}`, () => {
      test.use({ viewport: size });

      test("fits the window without scrolling", async ({ page }) => {
        const fits = await page.getByTestId("shortcuts-overlay").evaluate((dialog) => {
          const scrollers = [dialog, ...dialog.querySelectorAll<HTMLElement>("*")].filter((el) => el.scrollHeight > el.clientHeight + 1 && getComputedStyle(el).overflowY !== "visible");
          return scrollers.length === 0;
        });
        expect(fits).toBe(true);
      });
    });
  }
});
