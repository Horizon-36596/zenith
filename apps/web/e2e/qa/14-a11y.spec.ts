/**
 * QA 14, accessibility (UI_GUIDE section 9). axe is not a dependency of this repo and the QA brief
 * says not to add one, so these are hand checks of the same rules: every focusable control shows a
 * visible focus ring; dialogs trap focus, close on Escape and have a name; every control has an
 * accessible name.
 */
import { expect, test, type Page } from "@playwright/test";
import { loadExample, shot, skipTour } from "./helpers";

test.beforeEach(async ({ page }) => {
  await skipTour(page);
  await loadExample(page);
});

/** A rough accessible name: the attributes and text a screen reader would read out. */
const NAME_OF = `(el) => {
  const labelled = el.getAttribute("aria-labelledby");
  if (labelled) return labelled.split(/\\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" ").trim();
  const aria = el.getAttribute("aria-label");
  if (aria) return aria.trim();
  if (el.id) { const label = document.querySelector('label[for="' + el.id + '"]'); if (label) return (label.textContent ?? "").trim(); }
  const wrap = el.closest("label"); if (wrap && wrap !== el) return (wrap.textContent ?? "").trim();
  const text = (el.textContent ?? "").trim(); if (text) return text;
  const img = el.querySelector("img[alt]"); if (img && img.getAttribute("alt")) return img.getAttribute("alt");
  if (el.getAttribute("title")) return el.getAttribute("title").trim();
  if (el.getAttribute("placeholder")) return el.getAttribute("placeholder").trim();
  return "";
}`;

async function unnamedControls(page: Page): Promise<string[]> {
  return page.evaluate(`(() => {
    const nameOf = ${NAME_OF};
    const controls = document.querySelectorAll('button, input:not([type=hidden]), select, textarea, a[href], [role=button], [role=slider], [role=tab], [role=menuitem], [role=checkbox], [role=switch]');
    const out = [];
    for (const el of controls) {
      const box = el.getBoundingClientRect();
      if (box.width === 0 && box.height === 0) continue;
      if (el.closest('[aria-hidden="true"], [inert]')) continue;
      if (nameOf(el) === "") out.push((el.getAttribute("data-testid") ?? el.tagName.toLowerCase()) + " " + el.outerHTML.slice(0, 80));
    }
    return out;
  })()`) as Promise<string[]>;
}

/** Tabs through the page and reports every stop whose focus is not visible. */
async function focusRingMisses(page: Page, stops: number): Promise<{ visited: number; misses: string[] }> {
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
  });
  const misses: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < stops; i += 1) {
    await page.keyboard.press("Tab");
    const info = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (el === null || el === document.body) return null;
      const style = getComputedStyle(el);
      const outline = style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0;
      const shadow = style.boxShadow !== "none" && style.boxShadow !== "";
      const id = el.getAttribute("data-testid") ?? el.getAttribute("aria-label") ?? `${el.tagName} ${(el.textContent ?? "").slice(0, 20)}`;
      return { id, visible: outline || shadow, inDialog: el.closest("dialog") !== null };
    });
    if (info === null) continue;
    if (seen.has(info.id)) continue;
    seen.add(info.id);
    if (!info.visible) misses.push(info.id);
  }
  return { visited: seen.size, misses };
}

test("every control reached with Tab shows a visible focus ring", async ({ page }) => {
  const { visited, misses } = await focusRingMisses(page, 80);
  expect(visited).toBeGreaterThan(20);
  await shot(page, "14-focus");
  expect(misses, "controls with no outline or ring on focus").toEqual([]);
});

test("every visible control has an accessible name", async ({ page }) => {
  expect(await unnamedControls(page)).toEqual([]);
  // The same with a step selected, so the inspector's fields are on screen.
  await page.getByTestId("step-row-driveOut").getByRole("button").first().click();
  expect(await unnamedControls(page)).toEqual([]);
});

test("the field canvas has a role and a name", async ({ page }) => {
  const canvas = page.getByTestId("field-canvas");
  const label = (await canvas.getAttribute("aria-label")) ?? "";
  expect(label.length).toBeGreaterThan(3);
  expect(await canvas.getAttribute("tabindex")).not.toBeNull();
});

for (const [name, open] of [
  ["Open (Ctrl O)", "Control+o"],
  ["Shortcuts (F1)", "F1"],
  ["Simulate (F5)", "F5"],
] as const) {
  test(`the ${name} dialog traps focus, closes on Escape and gives focus back`, async ({ page }) => {
    await page.getByTestId("step-row-driveOut").getByRole("button").first().focus();
    await page.keyboard.press(open);
    const dialog = page.locator("dialog[open]");
    await expect(dialog).toHaveCount(1);
    for (let i = 0; i < 25; i += 1) {
      await page.keyboard.press("Tab");
      const inside = await page.evaluate(() => document.activeElement?.closest("dialog[open]") !== null || document.activeElement === document.body);
      expect(inside, `focus stayed in the dialog after ${String(i + 1)} tabs`).toBe(true);
    }
    await shot(page, `14-dialog-${name.split(" ")[0]?.toLowerCase() ?? "x"}`);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    const back = await page.evaluate(() => document.activeElement?.getAttribute("data-testid") ?? document.activeElement?.tagName ?? "");
    expect(back, "focus went back to a control, not the page body").not.toBe("BODY");
  });
}

test("every modal dialog has an accessible name", async ({ page }) => {
  for (const key of ["Control+o", "F1", "F5"]) {
    await page.keyboard.press(key);
    // A dialog's name comes from aria-labelledby or aria-label, never from its whole text.
    const name = await page.locator("dialog[open]").evaluate((el) => {
      const ids = el.getAttribute("aria-labelledby");
      if (ids !== null) return ids.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" ").trim();
      return (el.getAttribute("aria-label") ?? "").trim();
    });
    expect(name, `${key} dialog name`).not.toBe("");
    await page.keyboard.press("Escape");
  }
});

test("the palette is a named modal that closes on Escape and keeps focus in its input", async ({ page }) => {
  await page.keyboard.press("Control+k");
  const input = page.getByTestId("palette-input");
  await expect(input).toBeFocused();
  const role = await page.evaluate(() => {
    const el = document.activeElement?.closest("[role=dialog], dialog");
    return el === null || el === undefined ? null : { role: el.getAttribute("role") ?? el.tagName, label: el.getAttribute("aria-label") ?? el.getAttribute("aria-labelledby") };
  });
  expect(role, "the palette sits in a dialog").not.toBeNull();
  expect(role?.label ?? "").not.toBe("");
  const inputName = (await input.getAttribute("aria-label")) ?? (await input.getAttribute("placeholder")) ?? "";
  expect(inputName).not.toBe("");
  await page.keyboard.press("Escape");
  await expect(input).toHaveCount(0);
});
