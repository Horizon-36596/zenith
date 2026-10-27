/**
 * The heading of a new path is a per-person setting (owner ruling D6): Settings, Editor, "Heading for
 * new paths" offers Tangent, Linear and Constant, Linear until chosen. A path added afterwards starts
 * with that mode, and the Inspector shows it. The choice is stored in zenith.ui, never in the auto, and
 * survives a reload.
 */
import { expect, test, type Page } from "@playwright/test";
import { editor, loadExample, selectStep, skipTour, waitForFonts } from "./qa/helpers";

type Mode = "tangent" | "linear" | "constant";

test.beforeEach(async ({ page }) => {
  await skipTour(page);
  await loadExample(page);
  await waitForFonts(page);
});

async function chooseInSettings(page: Page, mode: Mode): Promise<void> {
  await page.getByTestId("toolbar-settings").click();
  await page.getByTestId("settings-nav-editor").click();
  await page.getByTestId("settings-default-heading-choice").selectOption(mode);
  await expect(page.getByTestId("settings-default-heading-choice")).toHaveValue(mode);
  await page.getByTestId("settings-close").click();
  await expect(page.getByTestId("settings")).toHaveCount(0);
}

/**
 * Inserts a path after toGarden and returns its id; it is selected, so the Inspector shows it. A
 * default insert keeps the first short leg that brings no new error (issue #498), and only after
 * toGarden does the leg straight ahead clear the hive frame. Every other leg holds the arrival
 * heading, which is never Tangent, so the setting shows only on a leg with room ahead.
 */
async function insertPath(page: Page): Promise<string> {
  await selectStep(page, "toGarden");
  await page.getByTestId("insert-step").click();
  await page.getByTestId("insert-kind-path").click();
  const id = await editor<string | undefined>(page, "s.selection.stepId");
  if (id === undefined) throw new Error("the new path was not selected");
  await expect(page.getByTestId(`step-row-${id}`)).toBeVisible();
  return id;
}

test("a new path is Linear until the person chooses, and Settings shows it", async ({ page }) => {
  await page.getByTestId("toolbar-settings").click();
  await page.getByTestId("settings-nav-editor").click();
  const dropdown = page.getByTestId("settings-default-heading-choice");
  await expect(dropdown).toHaveValue("linear");
  await expect(dropdown.locator("option")).toHaveText(["Tangent", "Linear", "Constant"]);
  await page.getByTestId("settings-close").click();

  await insertPath(page);
  await expect(page.getByTestId("inspector-heading-mode")).toHaveAttribute("data-value", "linear");
});

for (const mode of ["tangent", "linear", "constant"] as const) {
  test(`with the setting at ${mode}, the next path added shows ${mode} in the Inspector`, async ({ page }) => {
    await chooseInSettings(page, mode);
    const id = await insertPath(page);
    await expect(page.getByTestId("inspector-heading-mode")).toHaveAttribute("data-value", mode);
    expect(await editor<string | undefined>(page, `s.auto.steps.find((x) => x.id === "${id}").heading.mode`)).toBe(mode);
  });
}

test("a path made earlier keeps its mode when the setting changes", async ({ page }) => {
  const id = await insertPath(page);
  await chooseInSettings(page, "constant");
  await selectStep(page, id);
  await expect(page.getByTestId("inspector-heading-mode")).toHaveAttribute("data-value", "linear");
  await selectStep(page, "driveOut");
  await expect(page.getByTestId("inspector-heading-mode")).toHaveAttribute("data-value", "tangent");
});

test("the choice is stored in zenith.ui, not in the auto, and survives a reload", async ({ page }) => {
  await chooseInSettings(page, "tangent");
  expect(await page.evaluate(() => (JSON.parse(window.localStorage.getItem("zenith.ui") ?? "{}") as { defaultHeading?: string }).defaultHeading)).toBe("tangent");
  await page.reload();
  await page.getByTestId("canvas-load-example").click();
  await expect(page.getByTestId("step-row-driveOut")).toBeVisible();
  await insertPath(page);
  await expect(page.getByTestId("inspector-heading-mode")).toHaveAttribute("data-value", "tangent");
});

test("Start a new path with the previous path's end heading is on, ends a Linear path where it starts, and can be turned off (#435)", async ({ page }) => {
  await page.getByTestId("toolbar-settings").click();
  await page.getByTestId("settings-nav-editor").click();
  await expect(page.getByTestId("settings-new-path-keeps-heading-choice-on")).toHaveAttribute("aria-pressed", "true");
  await page.getByTestId("settings-close").click();

  const id = await insertPath(page);
  const kept = await editor<{ mode: string; fromRad: number; toRad: number }>(page, `s.auto.steps.find((x) => x.id === "${id}").heading`);
  expect(kept.mode).toBe("linear");
  expect(kept.toRad).toBeCloseTo(kept.fromRad, 9);

  await page.getByTestId("toolbar-settings").click();
  await page.getByTestId("settings-nav-editor").click();
  await page.getByTestId("settings-new-path-keeps-heading-choice-off").click();
  const stored = await page.evaluate(() => JSON.parse(window.localStorage.getItem("zenith.ui") ?? "{}") as Record<string, unknown>);
  expect(stored["newPathKeepsHeading"]).toBe(false);
  await page.getByTestId("settings-close").click();
});

/**
 * A path made facing a nearby wall has no room ahead, so it drives toward the field centre and holds
 * the heading it arrives with (issue #445). It held it as Constant whatever the setting said; with
 * the defaults it is Linear from that heading to itself, and Constant only for the Constant setting.
 */
test.describe("a path made facing a wall", () => {
  /** driveOut ends 3 in from the north wall, facing it, so the next path has no room ahead. */
  async function facingTheWall(page: Page): Promise<void> {
    await editor(
      page,
      `(() => { const a = structuredClone(s.auto); const st = a.steps.find((x) => x.id === "driveOut"); st.segments[0].to = { xIn: -13, yIn: 62, provenance: "SET BY HAND: e2e" }; m.commit(a); })()`,
    );
    await selectStep(page, "driveOut");
  }

  /** Every path step's heading by id, nested ones included. */
  const headings = (page: Page): Promise<Record<string, unknown>> =>
    editor<Record<string, unknown>>(
      page,
      `(() => { const out = {}; const walk = (steps) => { for (const st of steps ?? []) { if (st.kind === "path") out[st.id] = st.heading; walk(st.steps); walk(st.then); walk(st.else); } }; walk(s.auto.steps); return out; })()`,
    );

  /** The heading of the one path the flow added. */
  async function added(page: Page, flow: () => Promise<void>): Promise<unknown> {
    const before = Object.keys(await headings(page));
    await flow();
    const after = await headings(page);
    const fresh = Object.keys(after).filter((id) => !before.includes(id));
    expect(fresh).toHaveLength(1);
    return after[fresh[0] as string];
  }

  const flows: Array<[string, (page: Page) => Promise<void>]> = [
    [
      "Insert",
      async (page) => {
        await page.getByTestId("insert-step").click();
        await page.getByTestId("insert-kind-path").click();
      },
    ],
    [
      "the palette's Insert a path",
      async (page) => {
        await page.keyboard.press("Control+k");
        await page.getByTestId("palette-input").fill("Insert a path");
        await page.getByTestId("palette-item-insert.path").click();
      },
    ],
    [
      "a new sequence",
      async (page) => {
        await page.getByTestId("insert-step").click();
        await page.getByTestId("insert-kind-sequence").click();
      },
    ],
    [
      "a new parallel group",
      async (page) => {
        await page.getByTestId("insert-step").click();
        await page.getByTestId("insert-kind-parallel").click();
        await page.getByTestId("insert-parallel-add").click();
      },
    ],
  ];

  for (const [name, flow] of flows) {
    test(`${name} gives Linear from the arrival heading to itself with the default settings`, async ({ page }) => {
      await facingTheWall(page);
      const heading = (await added(page, () => flow(page))) as { mode: string; fromRad: number; toRad: number };
      expect(heading.mode).toBe("linear");
      expect(heading.toRad).toBeCloseTo(heading.fromRad, 9);
      expect(heading.fromRad).toBeCloseTo(Math.PI / 2, 6);
    });
  }

  test("Insert shows Linear in the Inspector, and Constant only after the setting is Constant", async ({ page }) => {
    await facingTheWall(page);
    await page.getByTestId("insert-step").click();
    await page.getByTestId("insert-kind-path").click();
    await expect(page.getByTestId("inspector-heading-mode")).toHaveAttribute("data-value", "linear");

    await chooseInSettings(page, "constant");
    await selectStep(page, "driveOut");
    const heading = (await added(page, async () => {
      await page.getByTestId("insert-step").click();
      await page.getByTestId("insert-kind-path").click();
    })) as { mode: string };
    expect(heading.mode).toBe("constant");
    await expect(page.getByTestId("inspector-heading-mode")).toHaveAttribute("data-value", "constant");
  });
});
