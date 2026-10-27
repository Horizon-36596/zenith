/**
 * The desktop menu follows custom keys (issue #288). The page runs here in a browser with a stand-in
 * for the desktop app's bridge, so what the real main process does with the message is the desktop
 * tests' (`apps/desktop/test/app.test.ts`); this checks what the page sends and shows: the keys after
 * load and after every change, the Robot rows as rows a person can change, and, in an older desktop app
 * without the message, the same rows read-only with the update note.
 */
import { expect, test, type Page } from "@playwright/test";
import { skipTour } from "./qa/helpers";

interface MenuKeysMessage {
  keys: Record<string, string | null>;
  hidden: string[];
}

/** A desktop bridge with only what start-up needs, recording each menu keys message it is sent. */
async function standInDesktop(page: Page, takesMenuKeys: boolean): Promise<void> {
  await page.addInitScript((withMenuKeys) => {
    const sent: unknown[] = [];
    (window as unknown as { __menuKeys: unknown[] }).__menuKeys = sent;
    const none = () => () => undefined;
    const bridge: Record<string, unknown> = {
      apiVersion: 3,
      platform: "win32",
      appVersion: () => Promise.resolve("0.0.0"),
      project: { recent: () => Promise.resolve([]), onChange: none },
      sim: { onEvent: none },
      onMenu: none,
      onCloseRequest: none,
      answerClose: () => Promise.resolve(),
      onNavigate: none,
      showMenu: () => Promise.resolve(),
    };
    if (withMenuKeys) {
      bridge["setMenuKeys"] = (message: unknown) => {
        sent.push(JSON.parse(JSON.stringify(message)));
        return Promise.resolve();
      };
    }
    (window as unknown as { zenithDesktop: unknown }).zenithDesktop = bridge;
  }, takesMenuKeys);
}

const sentMessages = (page: Page): Promise<MenuKeysMessage[]> =>
  page.evaluate(() => (window as unknown as { __menuKeys: MenuKeysMessage[] }).__menuKeys);

async function openKeyboard(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByTestId("toolbar-settings").click();
  await page.getByTestId("settings-nav-keyboard").click();
  await expect(page.getByTestId("settings-section-keyboard")).toBeVisible();
}

test("a desktop app that takes menu keys is told the keys after load and after each change, and the Robot rows can be changed", async ({ page }) => {
  await skipTour(page);
  await standInDesktop(page, true);
  await openKeyboard(page);

  // After load: every item on its default, nothing hidden.
  await expect.poll(async () => (await sentMessages(page)).length).toBeGreaterThan(0);
  const first = (await sentMessages(page))[0];
  expect(first?.keys).toMatchObject({ "desktop.sim": "Ctrl F5", "desktop.deploy": "Ctrl Shift D", "desktop.git": "Ctrl Shift G", "run.save": "Ctrl S", "edit.undo": "Ctrl Z" });
  expect(first?.hidden).toEqual([]);

  // The Robot keys are rows with Change, in the Desktop group beside F10, which stays fixed.
  await expect(page.getByTestId("keyboard-group-desktop")).toBeVisible();
  await expect(page.getByTestId("keyboard-desktop-menu")).toContainText("F10");
  await expect(page.getByTestId("keyboard-key-desktop.sim")).toHaveText("Ctrl F5");
  await page.getByTestId("keyboard-change-desktop.sim").click();
  await page.keyboard.press("Control+Shift+F5");
  await expect(page.getByTestId("keyboard-key-desktop.sim")).toHaveText("Ctrl Shift F5");
  await expect(page.getByTestId("keyboard-reset-desktop.sim")).toBeVisible();
  await expect.poll(async () => (await sentMessages(page)).at(-1)?.keys["desktop.sim"]).toBe("Ctrl Shift F5");

  // A key the menu would run while someone types is refused, with the reason.
  await page.getByTestId("keyboard-change-desktop.deploy").click();
  await page.keyboard.press("d");
  await expect(page.getByTestId("keyboard-prompt")).toContainText("Ctrl or Alt");
  await page.keyboard.press("Escape");

  // A page key's chord is settled there and then, and the menu hears of both sides of it.
  await page.getByTestId("keyboard-change-desktop.deploy").click();
  await page.keyboard.press("Control+s");
  await expect(page.getByTestId("keyboard-conflict")).toContainText("Save");
  await page.getByTestId("keyboard-move").click();
  await expect(page.getByTestId("keyboard-key-desktop.deploy")).toHaveText("Ctrl S");
  await expect.poll(async () => (await sentMessages(page)).at(-1)?.keys["desktop.deploy"]).toBe("Ctrl S");
  expect((await sentMessages(page)).at(-1)?.keys["run.save"]).toBeNull();

  // Reset gives Simulate Ctrl F5 back, and the menu is told.
  await page.getByTestId("keyboard-reset-desktop.sim").click();
  await expect(page.getByTestId("keyboard-key-desktop.sim")).toHaveText("Ctrl F5");
  await expect.poll(async () => (await sentMessages(page)).at(-1)?.keys["desktop.sim"]).toBe("Ctrl F5");
});

test("the palette and the shortcut sheet show a Robot key the person changed", async ({ page }) => {
  await skipTour(page);
  await standInDesktop(page, true);
  await openKeyboard(page);
  await page.getByTestId("keyboard-change-desktop.sim").click();
  await page.keyboard.press("Control+Shift+F5");
  await expect(page.getByTestId("keyboard-key-desktop.sim")).toHaveText("Ctrl Shift F5");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("settings")).toHaveCount(0);

  await page.keyboard.press("Control+k");
  await page.getByTestId("palette-input").fill("high-fidelity");
  await expect(page.getByTestId("palette-item-desktop.sim")).toContainText("Ctrl Shift F5");
  await page.keyboard.press("Escape");

  await page.keyboard.press("?");
  await expect(page.getByTestId("shortcuts-desktop")).toContainText("Ctrl Shift F5");
  await expect(page.getByTestId("shortcuts-desktop")).not.toContainText("Ctrl F5");
});

test("a desktop app that predates the menu keys message shows the Robot rows read-only with the update note", async ({ page }) => {
  await skipTour(page);
  await standInDesktop(page, false);
  await openKeyboard(page);

  for (const id of ["desktop.sim", "desktop.deploy", "desktop.git"]) {
    const row = page.getByTestId(`keyboard-desktop-${id}`);
    await expect(row).toContainText("Update the desktop app to change these.");
    await expect(page.getByTestId(`keyboard-change-${id}`)).toHaveCount(0);
    await expect(row.getByRole("img", { name: "Fixed" })).toBeVisible();
  }
  await expect(page.getByTestId("keyboard-key-desktop.sim")).toHaveText("Ctrl F5");
  expect(await sentMessages(page)).toEqual([]);
});
