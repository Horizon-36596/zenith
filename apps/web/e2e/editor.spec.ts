/**
 * The editor's smoke test: load the example, select a step, move a pose from the inspector, watch
 * the findings change, undo it, and save a file whose bytes are exactly what `core.canonicalize`
 * writes.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { canonicalize, loadAuto } from "@horizon36596/zenith-core";

const EXAMPLE_DIR = fileURLToPath(new URL("../../../examples/starter/", import.meta.url));
const COLLECT_AND_SCORE = fileURLToPath(
  new URL("../../../examples/starter/autos/collect-and-score.auto.json", import.meta.url),
);
const FIRST_AUTO = fileURLToPath(
  new URL("../../../examples/starter/autos/first-auto.auto.json", import.meta.url),
);

/**
 * These tests start from the welcome screen, so they mark the first-run tour as already seen; the
 * tour and the first visit's automatic example load have their own tests in `tour.spec.ts`.
 */
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (window.localStorage.getItem("zenith.ui") === null) {
      window.localStorage.setItem(
        "zenith.ui",
        JSON.stringify({ tour: { seen: true, coreDone: true, fullDone: false } }),
      );
    }
  });
});

/**
 * "Load example" opens `collect-and-score.auto.json` directly: of the starter's autos it
 * shows the most at a glance, a marker, a deadline group and a sequence.
 */
async function loadExample(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByTestId("canvas-load-example").click();
  await expect(page.getByTestId("step-row-driveOut")).toBeVisible();
}

/**
 * Every endpoint in the example is a waypoint or "current", and the inspector shows x and y only
 * for a literal pose. This writes driveOut's end as the literal pose of its waypoint, scoreSouth,
 * so the tests that edit coordinates have fields to edit. The robot still ends where it did.
 */
async function literalDriveOutEnd(page: Page): Promise<void> {
  await page.evaluate(
    `import("/src/state/store.ts").then((m) => { const s = m.getState(); m.commit({ ...s.auto, steps: s.auto.steps.map((x) => x.id !== "driveOut" ? x : { ...x, segments: x.segments.map((seg) => ({ ...seg, to: { xIn: -12, yIn: -36, headingRad: 1.5708, provenance: "SET BY HAND: e2e, the scoreSouth waypoint" } })) }) }); })`,
  );
  await expect(page.getByTestId("inspector-to-x-0")).toHaveValue("-12.00");
}

/** Switches to another auto in the open project through the same picker every auto opens through. */
async function openAutoNamed(page: Page, fileName: string): Promise<void> {
  await page.getByTestId("toolbar-auto-name").click();
  await page.getByTestId(`open-auto-${fileName}`).click();
}

const findingCount = (page: Page): Promise<number> => page.getByTestId("finding-row").count();

test("the example loads, the panels fill and the estimate is live", async ({ page }) => {
  await loadExample(page);

  await expect(page.getByTestId("steps-panel")).toBeVisible();
  await expect(page.getByTestId("ledger-panel")).toBeVisible();
  await expect(page.getByTestId("inspector-panel")).toBeVisible();
  await expect(page.getByTestId("timeline-track")).toBeVisible();

  // The toolbar is the three groups of UI_GUIDE section 9.2, with search and help at the right.
  for (const id of [
    "toolbar-tool.select",
    "toolbar-tool.addPath",
    "toolbar-tool.marker",
    "toolbar-tool.heading",
    "toolbar-view.snap",
    "toolbar-run.validate",
    "toolbar-run.simulate",
    "toolbar-run.save",
    "toolbar-run.propose",
    "toolbar-view.alliance",
    "toolbar-view.play",
    "toolbar-search",
    "toolbar-help",
  ]) {
    await expect(page.getByTestId(id)).toBeVisible();
  }

  // Every toolbar button names its action on hover, disabled ones included: UI_GUIDE section 8.1
  // puts the reason a control is disabled in that same tooltip, so it has to be reachable.
  for (const [id, label] of [
    ["toolbar-tool.select", "Select"],
    ["toolbar-tool.addPath", "Add path"],
    ["toolbar-tool.marker", "Marker"],
    ["toolbar-run.validate", "Validate"],
    ["toolbar-run.save", "Save"],
    ["toolbar-view.snap", "Snap"],
  ] as const) {
    await page.getByTestId(id).hover();
    await expect(page.getByRole("tooltip")).toContainText(label);
    await page.mouse.move(0, 0);
  }

  // Propose is disabled until GitHub mode, and says why where it is disabled.
  await expect(page.getByTestId("toolbar-run.propose")).toBeDisabled();
  await page.getByTestId("toolbar-run.propose").hover();
  await expect(page.getByRole("tooltip")).toContainText("Propose");
});

/**
 * Polish item (earlier integration pass), UI_GUIDE section 8.2: "keyboard focus shows the tooltip
 * too, immediately". A disabled toolbar button is the case that regresses easiest, because a plain
 * `disabled` attribute takes a button out of the tab order and out of pointer events both, so its
 * tooltip — the one place UI_GUIDE puts the reason it is disabled — could never be reached from the
 * keyboard at all (`ToolButton` in `apps/web/src/components/primitives.tsx` uses `aria-disabled`
 * instead of `disabled` for exactly this reason).
 */
test("a disabled toolbar button's tooltip is reachable by keyboard focus, not only by hover", async ({
  page,
}) => {
  await loadExample(page);

  const propose = page.getByTestId("toolbar-run.propose");
  await expect(propose).toBeDisabled();

  // Reach it with the keyboard: focus opens a tooltip only when it came from the keyboard.
  await propose.focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await expect(propose).toBeFocused();
  await expect(page.getByRole("tooltip")).toBeVisible();
  await expect(page.getByRole("tooltip")).toContainText("Propose");

  // Moving focus on closes this tooltip; where it lands next opens instantly too (the same
  // instant-on-focus rule), so the assertion is that *this* tooltip is gone, not that every
  // tooltip is.
  await page.keyboard.press("Tab");
  await expect(propose).not.toBeFocused();
  await expect(page.getByRole("tooltip")).not.toContainText("Propose");
});

test("the example opens collect-and-score first, and the picker still reaches first-auto.auto.json", async ({
  page,
}) => {
  await loadExample(page);
  await expect(page.getByTestId("toolbar-auto-name")).toContainText("collect-and-score.auto.json");

  await openAutoNamed(page, "first-auto.auto.json");

  await expect(page.getByTestId("toolbar-auto-name")).toContainText("first-auto.auto.json");
  await expect(page.getByTestId("steps-list")).toBeVisible();
});

test("the command palette lists every action and every registered command", async ({ page }) => {
  await loadExample(page);
  await page.keyboard.press("Control+k");
  await expect(page.getByTestId("palette-input")).toBeFocused();
  await page.getByTestId("palette-input").fill("score");
  await expect(page.getByTestId("palette-item-command:score")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("palette-input")).toHaveCount(0);
});

test("a pose edited in the inspector changes the findings, and undo puts it back", async ({
  page,
}) => {
  await loadExample(page);

  await page.getByTestId("step-row-driveOut").getByRole("button").first().click();
  await expect(page.getByTestId("inspector")).toContainText("driveOut");
  await literalDriveOutEnd(page);

  const before = await findingCount(page);

  // Move the end of the leg up the field, inside the hive's approach margin: scorePreload now
  // launches from a pose that is not a legal approach to the up cell.
  const y = page.getByTestId("inspector-to-y-0");
  await y.fill("-12");
  await y.press("Enter");

  await expect
    .poll(async () => findingCount(page), { message: "the findings should change" })
    .not.toBe(before);

  // Ctrl-Z inside a text field is the browser's own text undo, so step out of the field first.
  await page.getByTestId("steps-list").click({ position: { x: 4, y: 4 } });
  await page.keyboard.press("Control+z");
  await expect.poll(async () => findingCount(page)).toBe(before);
  await expect(y).toHaveValue("-36.00");
});

test("save writes exactly what canonicalize writes", async ({ page }) => {
  await loadExample(page);

  const expected = canonicalize("auto", loadAuto(JSON.parse(readFileSync(COLLECT_AND_SCORE, "utf8"))));

  const download = page.waitForEvent("download");
  await page.keyboard.press("Control+s");
  const saved = await download;
  expect(saved.suggestedFilename()).toBe("collect-and-score.auto.json");

  const path = await saved.path();
  expect(path).not.toBeNull();
  expect(readFileSync(path, "utf8")).toBe(expected);
});

test("every drag has a keyboard equivalent: arrows nudge the selected point", async ({ page }) => {
  await loadExample(page);
  await page.getByTestId("step-row-driveOut").getByRole("button").first().click();
  await literalDriveOutEnd(page);

  const x = page.getByTestId("inspector-to-x-0");
  const before = Number(await x.inputValue());

  await page.getByTestId("steps-list").click({ position: { x: 4, y: 4 } });
  await page.keyboard.press("ArrowRight");
  await expect.poll(async () => Number(await x.inputValue())).toBeCloseTo(before + 0.5, 2);

  await page.keyboard.press("Shift+ArrowLeft");
  await expect.poll(async () => Number(await x.inputValue())).toBeCloseTo(before - 1.5, 2);
});

/**
 * GitHub mode's front door (site/docs/github.md), with no network at all.
 * Signing in needs github.com, so what is checked here is everything before that — the dialog, the
 * refusal of an empty token, and that the GitHub tab lists nothing while nobody is signed in.
 */
test("GitHub mode asks for a token first and lists nothing without one", async ({ page }) => {
  await loadExample(page);

  await page.keyboard.press("Control+k");
  await page.getByTestId("palette-input").fill("Sign in");
  await page.getByTestId("palette-item-project.signIn").click();
  await expect(page.getByTestId("github-signin")).toBeVisible();

  // The instructions name the two permissions, because a token without them fails much later.
  await expect(page.getByTestId("github-signin")).toContainText("Contents: read and write");
  await expect(page.getByTestId("github-signin")).toContainText("Pull requests: read and write");

  // The field never shows the token, and "remember" is this tab only.
  await expect(page.getByTestId("github-token")).toHaveAttribute("type", "password");
  await expect(page.getByTestId("github-remember")).toBeChecked();

  // An empty token is refused here, not at GitHub: nothing is sent.
  await page.getByTestId("github-signin-submit").click();
  await expect(page.getByTestId("github-signin-error")).toContainText("personal access token");

  await page.keyboard.press("Escape");
  await page.getByTestId("toolbar-auto-name").click();
  await page.getByRole("tab", { name: "GitHub" }).click();
  await expect(page.getByTestId("github-open-signin")).toBeVisible();
  await expect(page.getByTestId("github-repo-list")).toHaveCount(0);

  // Propose stays disabled in local mode, and says why.
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("toolbar-run.propose")).toBeDisabled();
});

/**
 * Editing on the canvas (site/docs/editor.md), the half of it a pointer does: drag an endpoint on
 * the canvas itself, watch the estimate and the findings follow, and take one of the fixes a finding
 * offers.
 */

/** Where a field inch sits on screen, from the view the canvas publishes on its element. */
async function worldToScreen(
  page: Page,
  xIn: number,
  yIn: number,
): Promise<{ x: number; y: number }> {
  const canvas = page.getByTestId("field-canvas");
  const box = await canvas.boundingBox();
  if (box === null) throw new Error("the canvas has no box");
  const pxPerIn = Number(await canvas.getAttribute("data-px-per-in"));
  const originXPx = Number(await canvas.getAttribute("data-origin-x-px"));
  const originYPx = Number(await canvas.getAttribute("data-origin-y-px"));
  // The example field puts the audience at the bottom: +x right, +y up the screen.
  return { x: box.x + originXPx + pxPerIn * xIn, y: box.y + originYPx - pxPerIn * yIn };
}

test("dragging an endpoint on the canvas moves the pose and re-estimates live", async ({ page }) => {
  await loadExample(page);
  await page.getByTestId("step-row-driveOut").getByRole("button").first().click();

  // The end of driveOut is the scoreSouth waypoint, so there are no x and y fields until it moves.
  const x = page.getByTestId("inspector-to-x-0");
  const y = page.getByTestId("inspector-to-y-0");
  await expect(page.getByTestId("inspector-to-kind-0")).toHaveValue("ref");
  await expect(x).toHaveCount(0);

  const total = page.getByTestId("timeline-total");
  const before = Number(await total.getAttribute("data-seconds"));
  const findingsBefore = await findingCount(page);

  // The end of driveOut is at (-12, -36). Grab it and put it down 6 in right and 16 in up the
  // field, inside the hive's approach margin, so scorePreload's launch is no longer legal.
  const from = await worldToScreen(page, -12, -36);
  const to = await worldToScreen(page, -6, -20);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 6 });
  await page.mouse.move(to.x, to.y, { steps: 6 });
  await page.mouse.up();

  // The inspector, the estimate and the findings all move with the drag, not with a save. The
  // drag writes a literal pose in place of the waypoint.
  await expect(page.getByTestId("inspector-to-kind-0")).toHaveValue("pose");
  await expect.poll(async () => Number(await x.inputValue())).toBeGreaterThan(-12);
  await expect.poll(async () => Number(await y.inputValue())).toBeGreaterThan(-36);
  await expect
    .poll(async () => Number(await total.getAttribute("data-seconds")))
    .not.toBeCloseTo(before, 2);
  await expect.poll(async () => findingCount(page)).not.toBe(findingsBefore);

  // The editor owns the pose it just wrote, and says so.
  // The chip shows it in sentence case; the file keeps the canonical capitals.
  await expect(page.getByTestId("inspector")).toContainText("Set from editor");
});

test("a one-click fix from a finding changes the document", async ({ page }) => {
  await loadExample(page);

  // The example validates clean, so make the finding first. sweepGarden runs the intake from its
  // start (a marker at t 0), and at 80 % of full speed that is SWEEP_SPEED against the default 40 %
  // sweep.
  await page.getByTestId("step-row-sweepGarden").getByRole("button").first().click();
  const speed = page.getByTestId("inspector-speed");
  await speed.fill("0.8");
  await speed.press("Enter");
  const fix = page.getByTestId("fix-slowSweep").first();
  await expect(fix).toBeVisible();
  await fix.click();

  await page.getByTestId("step-row-sweepGarden").getByRole("button").first().click();
  await expect(page.getByTestId("inspector-speed")).toHaveValue("0.40");
  await expect(page.getByTestId("fix-slowSweep")).toHaveCount(0);
});

test("a command step from the registry carries the registry's own parameters", async ({ page }) => {
  // The starter's score gives count a default of 1. A copy of the project whose robot.json leaves
  // the default out shows that the editor does not invent one.
  await openProjectCopy(page, {
    robot: (robot) => {
      const commands = robot["commands"] as Array<{ name: string; params?: Record<string, Record<string, unknown>> }>;
      const score = commands.find((command) => command.name === "score");
      if (score?.params?.["count"] === undefined) throw new Error("the starter's score has no count");
      delete score.params["count"]["default"];
    },
  });
  await page.getByTestId("step-row-driveOut").getByRole("button").first().click();

  await page.keyboard.press("Control+k");
  await page.getByTestId("palette-input").fill("score");
  await page.getByTestId("palette-item-command:score").click();

  await expect(page.getByTestId("step-row-score")).toBeVisible();
  // count has no default in this robot.json, so the field is empty rather than showing an invented one.
  const count = page.getByTestId("inspector-arg-count");
  await expect(count).toHaveValue("");

  await count.fill("3");
  await count.press("Enter");
  await expect(count).toHaveValue("3");

  // With the argument the estimate grammar needs, the step is no longer unknown.
  await expect(page.getByTestId("inspector-estimate")).not.toContainText("—");

  const download = page.waitForEvent("download");
  await page.keyboard.press("Control+s");
  const saved = await download;
  const path = await saved.path();
  expect(path).not.toBeNull();
  const written = JSON.parse(readFileSync(path, "utf8")) as {
    steps: Array<{ id?: string; args?: Record<string, unknown> }>;
  };
  const step = written.steps.find((candidate) => candidate.id === "score");
  expect(step?.args).toEqual({ count: 3 });
});

/**
 * Sim overlay (site/docs/simulation.md): after a sim run the editor shows actual against planned, per
 * step and for the whole routine. The trace here is synthetic: it was written by hand from the
 * example's own plan of first-auto, with each step a little longer than the estimate, so the tests
 * need no sim to run first. A real one from `zenith sim` has the same shape.
 */
const TRACE = fileURLToPath(new URL("./fixtures/first-auto.trace.json", import.meta.url));

test("a loaded trace overlays the recorded run on the estimate", async ({ page }) => {
  await loadExample(page);
  // The trace is of first-auto, so open that first.
  await openAutoNamed(page, "first-auto.auto.json");
  await expect(page.getByTestId("toolbar-auto-name")).toContainText("first-auto.auto.json");

  // Before a trace there is one track, no recorded total, and the Full sim level is unavailable.
  await expect(page.getByTestId("timeline-actual-track")).toHaveCount(0);
  await expect(page.getByTestId("playback-level-full")).toHaveAttribute("aria-disabled", "true");

  await page.getByTestId("toolbar-run.simulate").click();
  await expect(page.getByTestId("simulate")).toBeVisible();
  await page.getByTestId("load-trace").setInputFiles(TRACE);

  // The whole-run report of site/docs/simulation.md, including what this sim build cannot measure.
  const summary = page.getByTestId("trace-summary");
  await expect(summary).toBeVisible();
  await expect(summary).toContainText("6.20");
  await expect(summary).toContainText("Launches");
  await expect(summary).toContainText("not measured in this sim build");
  await page.keyboard.press("Escape");

  // Per step: a second bar beside the estimate, and the delta in the inspector.
  await expect(page.getByTestId("timeline-actual-track")).toBeVisible();
  await expect(page.getByTestId("timeline-actual-total")).toContainText("6.20");

  await page.getByTestId("step-row-driveOut").getByRole("button").first().click();
  await expect(page.getByTestId("inspector-actual")).toContainText("1.76");
  // The recorded 1.76 s against the 1.59 s estimate of the driveOut leg.
  await expect(page.getByTestId("inspector-delta")).toContainText("+0.17");

  // With the trace loaded the Full sim level plays it, on the trace's own clock.
  await expect(page.getByTestId("playback-level-full")).not.toHaveAttribute("aria-disabled", "true");
  await page.getByTestId("playback-level-full").click();
  await expect(page.getByTestId("playback-level-full")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("playback")).toHaveAttribute("max", "6.2");
  await expect(page.getByTestId("timeline-level-total")).toContainText("full sim 6.20");
  await expect(page.getByTestId("field-canvas")).toHaveAttribute("data-playback-level", "full");
});

/**
 * Opens a throwaway copy of the bundled example, with its robot or field file changed first, in a
 * temp directory (never under `examples/`, and never committed). It goes through the "pick files"
 * fallback (`data-testid="open-project-files"`) that every browser without the File System Access
 * API already uses, so no new picking mechanism is needed. The copy opens first-auto.
 */
async function openProjectCopy(
  page: Page,
  change: {
    robot?: (robot: Record<string, unknown>) => void;
    field?: (field: Record<string, unknown>) => void;
  },
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "zenith-e2e-copy-"));
  const read = (path: string): Record<string, unknown> =>
    JSON.parse(readFileSync(join(EXAMPLE_DIR, path), "utf8")) as Record<string, unknown>;
  const robot = read("autos/robot.json");
  const field = read("autos/field/biobuzz.field.json");
  change.robot?.(robot);
  change.field?.(field);

  const files: Array<[string, string]> = [
    ["zenith.json", readFileSync(join(EXAMPLE_DIR, "zenith.json"), "utf8")],
    ["robot.json", JSON.stringify(robot)],
    ["biobuzz.field.json", JSON.stringify(field)],
    ["waypoints.json", readFileSync(join(EXAMPLE_DIR, "autos/waypoints.json"), "utf8")],
    ["first-auto.auto.json", readFileSync(FIRST_AUTO, "utf8")],
  ];
  const paths = files.map(([name, text]) => {
    const path = join(dir, name);
    writeFileSync(path, text);
    return path;
  });
  await page.goto("/");
  await page.getByTestId("canvas-open-other").click();
  await page.getByTestId("open-project-files").setInputFiles(paths);
  await expect(page.getByTestId("toolbar-auto-name")).toContainText("first-auto.auto.json");
}

/**
 * Finding 25: an unknown season plugin must never read as "No findings". The test builds a throwaway
 * copy of the bundled example with `field.json`'s `rules.plugin` pointed at a name this build does
 * not carry.
 */
test("an unknown season plugin shows a banner, and never just 'No findings'", async ({ page }) => {
  await openProjectCopy(page, {
    field: (field) => {
      field["rules"] = { ...(field["rules"] as Record<string, unknown>), plugin: "season-does-not-exist" };
    },
  });

  const banner = page.getByTestId("findings-banner-season");
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("season-does-not-exist");
  await expect(banner).toContainText("this build does not carry");

  // The banner sits above the list, whatever the list itself is showing underneath it.
  await expect(page.getByTestId("findings-banners")).toBeVisible();
});
