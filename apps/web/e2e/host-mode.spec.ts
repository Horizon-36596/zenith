/**
 * Host mode (site/docs/host-protocol.md): another web app, here a fake host page on an allowed
 * local origin, opens Zenith with `?host=dsim`, hears `ready`, sends the starter example's robot,
 * the BIOBUZZ field and its autos, and gets the saved auto back as canonical JSON. A trace it sends lays the recorded run
 * over the plan. Its screenshots go to test-results/host-mode/, for review.
 */
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { canonicalize, loadAuto } from "@horizon36596/zenith-core";
import { turnOnFeatures } from "./features";
import { openMore } from "./qa/helpers";

const STARTER = fileURLToPath(new URL("../../../examples/starter/", import.meta.url));
const TRACE = fileURLToPath(new URL("./fixtures/first-auto.trace.json", import.meta.url));
const FAKE_HOST = fileURLToPath(new URL("./fixtures/fake-host.html", import.meta.url));
const SHOTS = fileURLToPath(new URL("../test-results/host-mode/", import.meta.url));

const read = (path: string): string => readFileSync(join(STARTER, path), "utf8");

interface Received {
  origin: string;
  data: { type: string; protocol?: string; name?: string; text?: string };
}

/** The tour and the first-run example stay out of the way, in the popup as well as the host. */
async function skipTour(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    if (window.localStorage.getItem("zenith.ui") === null) {
      window.localStorage.setItem(
        "zenith.ui",
        JSON.stringify({ tour: { seen: true, coreDone: true, fullDone: false } }),
      );
    }
  });
  await turnOnFeatures(context);
}

/** Serves the fake host on the dev server's origin and opens Zenith from it in host mode. */
async function openFromHost(page: Page): Promise<Page> {
  await page.route("**/__fake-host.html", (route) =>
    route.fulfill({ contentType: "text/html", body: readFileSync(FAKE_HOST, "utf8") }),
  );
  await page.goto("/__fake-host.html");
  const popup = page.waitForEvent("popup");
  await page.evaluate(() => {
    (window as unknown as { openZenith: (path: string) => void }).openZenith("/?host=dsim");
  });
  const zenith = await popup;
  await zenith.setViewportSize({ width: 1440, height: 900 });
  return zenith;
}

const received = (host: Page): Promise<Received[]> =>
  host.evaluate(() => (window as unknown as { received: Received[] }).received);

const sendToZenith = (host: Page, message: unknown): Promise<void> =>
  host.evaluate((data) => {
    (window as unknown as { sendToZenith: (message: unknown) => void }).sendToZenith(data);
  }, message);

/** Waits for the next message of `type` after the first `after` of them, and returns it. */
async function nextOfType(host: Page, type: string, after = 0): Promise<Received> {
  let found: Received | undefined;
  await expect
    .poll(async () => {
      found = (await received(host)).filter((message) => message.data.type === type)[after];
      return found !== undefined;
    })
    .toBe(true);
  return found as Received;
}

async function shot(page: Page, name: string): Promise<void> {
  mkdirSync(SHOTS, { recursive: true });
  // Two frames, so the canvas has drawn whatever the last step changed.
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true });
}

const openMessage = {
  type: "open",
  protocol: "zenith-host/1",
  project: {
    name: "starter",
    hostLabel: "Starter robot, build 3",
    robot: JSON.parse(read("autos/robot.json")) as unknown,
    field: read("autos/field/biobuzz.field.json"),
    waypoints: read("autos/waypoints.json"),
    autos: {
      "collect-and-score": read("autos/collect-and-score.auto.json"),
      "first-auto": read("autos/first-auto.auto.json"),
    },
  },
  open: "collect-and-score",
  readOnlyRobot: true,
  capabilities: { simulate: true },
};

test.beforeEach(async ({ context }) => {
  await skipTour(context);
});

test("a host opens a project, gets the saved auto back, and lays its trace over the plan", async ({ page }) => {
  const zenith = await openFromHost(page);

  // Zenith says it is ready, to any origin, and waits for the project.
  const ready = await nextOfType(page, "ready");
  expect(ready.data).toEqual({ type: "ready", protocol: "zenith-host/1" });
  await expect(zenith.getByTestId("host-gate")).toHaveAttribute("data-phase", "waiting");

  await sendToZenith(page, openMessage);

  // The editor opens the named auto, says who it is editing for, and hides what makes no sense here.
  await expect(zenith.getByTestId("step-row-toGarden")).toBeVisible();
  await expect(zenith.getByTestId("toolbar-auto-name")).toContainText("collect-and-score.auto.json");
  await expect(zenith.getByTestId("host-subject")).toHaveText("Starter robot, build 3");
  // Which side to draw on: the file is RED's, and the BIOBUZZ field mirrors it for BLUE.
  await expect(zenith.getByTestId("host-alliance")).toHaveText("Draw for RED · DSIM mirrors for BLUE");
  await expect(zenith.getByTestId("host-run.save")).toContainText("Save to DSIM");
  await expect(zenith.getByTestId("host-host.simulate")).toContainText("Simulate in DSIM");
  await expect(zenith.getByTestId("toolbar-run.propose")).toHaveCount(0);
  await expect(zenith.getByTestId("toolbar-run.save")).toHaveCount(0);
  // The Problems panel is there; the starter raises only the time budget's info note, which it does not list (issue #413).
  await expect(zenith.getByTestId("findings-list")).toBeVisible();

  // The robot is the host's and says where to change it.
  await zenith.keyboard.press("Control+k");
  await zenith.keyboard.type("Robot settings");
  await zenith.keyboard.press("Enter");
  await expect(zenith.getByTestId("settings-robot-read-only")).toContainText("Change it in DSIM's robot builder.");
  await zenith.keyboard.press("Escape");

  // Select a path step, so the inspector is populated for the review screenshot.
  await zenith.getByTestId("step-row-toGarden").getByRole("button").first().click();
  await expect(zenith.getByTestId("inspector-panel")).toContainText("toGarden");
  await zenith.mouse.move(0, 0);
  await shot(zenith, "host-mode-editor");

  // Ctrl S saves to the host: canonical auto JSON, under the host's own name, pinned to its origin.
  await zenith.keyboard.press("Control+s");
  const save = await nextOfType(page, "save");
  expect(save.data.name).toBe("collect-and-score");
  const text = save.data.text ?? "";
  expect(canonicalize("auto", loadAuto(JSON.parse(text)))).toBe(text);
  expect(loadAuto(JSON.parse(text)).name).toBe("collect-and-score");
  await sendToZenith(page, { type: "saved", name: "collect-and-score", ok: true });
  await expect(zenith.getByTestId("status")).toContainText("Saved to DSIM.");

  // The trace fixture is a run of first-auto, so switch to it through the host's auto picker.
  await zenith.getByTestId("toolbar-auto-name").click();
  await zenith.getByTestId("open-auto-first-auto.auto.json").click();
  await expect(zenith.getByTestId("toolbar-auto-name")).toContainText("first-auto.auto.json");

  // Simulate in DSIM posts the auto as `run` and waits; the trace that answers it is laid over the plan.
  await expect(zenith.getByTestId("timeline-actual-track")).toHaveCount(0);
  await zenith.getByTestId("host-host.simulate").click();
  const run = await nextOfType(page, "run");
  expect(run.data.name).toBe("first-auto");
  expect(canonicalize("auto", loadAuto(JSON.parse(run.data.text ?? "")))).toBe(run.data.text);
  await expect(zenith.getByTestId("host-host.simulate")).toContainText("Simulating in DSIM");
  await sendToZenith(page, {
    type: "trace",
    auto: "first-auto",
    trace: JSON.parse(readFileSync(TRACE, "utf8")) as unknown,
  });
  await expect(zenith.getByTestId("host-host.simulate")).toContainText("Simulate in DSIM");
  await expect(zenith.getByTestId("status")).toContainText("recorded run of first-auto.auto.json");
  await expect(zenith.getByTestId("timeline-actual-track")).toBeVisible();
  await expect(zenith.getByTestId("timeline-actual-total")).toContainText("6.20");

  // The Simulate dialog offers the host's sim and shows the loaded trace's report.
  await zenith.keyboard.press("F5");
  await expect(zenith.getByTestId("simulate")).toBeVisible();
  await expect(zenith.getByTestId("run-host-sim")).toContainText("Simulate in DSIM");
  await expect(zenith.getByTestId("trace-summary")).toBeVisible();
  await expect(zenith.getByTestId("trace-summary")).toContainText("6.20");
  await zenith.keyboard.press("Escape");
  await zenith.getByTestId("playback-level-full").click();
  await zenith.getByTestId("step-row-driveOut").getByRole("button").first().click();
  await openMore(zenith);
  await expect(zenith.getByTestId("inspector-actual")).toContainText("1.76");
  await zenith.mouse.move(0, 0);
  await shot(zenith, "host-mode-trace");
});

test("a new auto is made in the window and sent to the host on save", async ({ page }) => {
  const zenith = await openFromHost(page);
  await nextOfType(page, "ready");
  await sendToZenith(page, openMessage);
  await expect(zenith.getByTestId("step-row-toGarden")).toBeVisible();

  await zenith.getByTestId("toolbar-auto-name").click();
  await expect(zenith.getByTestId("open-project")).toContainText("Autos from DSIM");
  await expect(zenith.getByTestId("open-auto-first-auto.auto.json")).toBeVisible();
  await shot(zenith, "host-mode-autos");
  await zenith.getByTestId("host-new-auto").click();

  await expect(zenith.getByTestId("toolbar-auto-name")).toContainText("new-auto.auto.json");
  await expect(zenith.getByTestId("step-row-path1")).toBeVisible();
  // It is unsaved until the host has it.
  await expect(zenith.getByTestId("toolbar-auto-name").getByLabel("Unsaved changes")).toBeVisible();

  await zenith.keyboard.press("Control+s");
  const save = await nextOfType(page, "save");
  expect(save.data.name).toBe("new-auto");
  expect(loadAuto(JSON.parse(save.data.text ?? "")).steps[0]?.id).toBe("path1");
  await sendToZenith(page, { type: "saved", name: "new-auto", ok: true });
  await expect(zenith.getByTestId("toolbar-auto-name").getByLabel("Unsaved changes")).toHaveCount(0);

  // A save the host does not answer says it is saving, and Save to is off until the wait is over.
  await zenith.keyboard.press("Control+s");
  await nextOfType(page, "save", 1);
  await expect(zenith.getByTestId("status")).toContainText("Saving new-auto.auto.json to DSIM…");
  await expect(zenith.getByTestId("host-run.save")).toHaveText("Saving to DSIM…");
  await expect(zenith.getByTestId("host-run.save")).toHaveAttribute("aria-disabled", "true");
  await zenith.mouse.move(0, 0);
  await shot(zenith, "host-mode-saving");
  // A second press while it waits sends nothing more.
  await zenith.keyboard.press("Control+s");
  // It fails after five seconds and says so, and Save to is back.
  await expect(zenith.getByTestId("status")).toContainText("DSIM did not answer within 5 s", { timeout: 8_000 });
  await expect(zenith.getByTestId("host-run.save")).toHaveText("Save to DSIM");
  expect((await received(page)).filter((message) => message.data.type === "save")).toHaveLength(2);

  // A refused save stays unsaved and shows the host's reason.
  await zenith.keyboard.press("Control+s");
  await nextOfType(page, "save", 2);
  await sendToZenith(page, { type: "saved", name: "new-auto", ok: false, error: "the robot build is locked" });
  await expect(zenith.getByTestId("status")).toContainText("the robot build is locked");

  // Once the host closes the session, Save is off and the bar says why.
  await sendToZenith(page, { type: "close" });
  await expect(zenith.getByTestId("host-closed")).toContainText("DSIM closed this session");
  await expect(zenith.getByTestId("host-run.save")).toHaveAttribute("aria-disabled", "true");
  await expect(zenith.getByTestId("host-project.saveCopy")).toContainText("Save a copy");
  // The bar says it once; the status line says what is left to do, and the title bar the past.
  await expect(zenith.getByTestId("status")).toContainText("Save to DSIM is off. Save a copy keeps your edits.");
  await expect(zenith.getByTestId("status")).not.toContainText("closed this session");
  await expect(zenith.getByTestId("titlebar-where")).toHaveText("was in DSIM");

  // Closing the window says bye, best effort.
  await zenith.close();
  await nextOfType(page, "bye");
});

test("an open with newAuto starts a new auto whose name none of the host's autos uses", async ({ page }) => {
  const zenith = await openFromHost(page);
  await nextOfType(page, "ready");
  // The host sends the autos it already has, one of them already called new-auto, and asks for a new one.
  // Its build number is accepted, and build 7 is newer than DSIM's minimum, so nothing is said.
  await sendToZenith(page, {
    ...openMessage,
    project: {
      ...openMessage.project,
      autos: { ...openMessage.project.autos, "new-auto": read("autos/first-auto.auto.json") },
    },
    newAuto: true,
    hostBuild: 7,
  });
  await expect(zenith.getByTestId("toolbar-auto-name")).toContainText("new-auto-2.auto.json");
  await expect(zenith.getByTestId("toolbar-auto-name").getByLabel("Unsaved changes")).toBeVisible();
  await expect(zenith.getByTestId("host-outdated")).toHaveCount(0);
  // The host's autos are all still there to switch to.
  await zenith.getByTestId("toolbar-auto-name").click();
  await expect(zenith.getByTestId("open-auto-new-auto.auto.json")).toBeVisible();
  await expect(zenith.getByTestId("open-auto-collect-and-score.auto.json")).toBeVisible();
  await zenith.keyboard.press("Escape");

  await zenith.keyboard.press("Control+s");
  const save = await nextOfType(page, "save");
  expect(save.data.name).toBe("new-auto-2");
});

test("a new auto starts where the host's robot starts when the host sends newAutoStart (sweep W4-7)", async ({ page }) => {
  const zenith = await openFromHost(page);
  await nextOfType(page, "ready");
  // A BLUE robot in the host; the field's own alliance is RED, so the start comes back mirrored.
  await sendToZenith(page, {
    ...openMessage,
    newAuto: true,
    newAutoStart: { alliance: "BLUE", xIn: 34, yIn: 63.17, headingRad: -Math.PI / 2 },
    hostBuild: 2,
  });
  await expect(zenith.getByTestId("toolbar-auto-name")).toContainText("new-auto.auto.json");
  await zenith.keyboard.press("Control+s");
  const save = await nextOfType(page, "save");
  const auto = loadAuto(JSON.parse(save.data.text ?? ""));
  expect(auto.alliance).toBe("RED");
  expect(auto.start.pose).toMatchObject({ xIn: -34, yIn: -63.17, headingRad: 1.5708 });
  expect((auto.start.pose as { provenance?: string }).provenance).toContain("picked in DSIM");
});

test("a DSIM too old to read this Zenith's autos turns Save and Simulate off and says why (sweep W4-1)", async ({ page }) => {
  const zenith = await openFromHost(page);
  await nextOfType(page, "ready");
  // DSIM build 1 vendors Zenith 0.1.1, which refuses the format this Zenith writes.
  await sendToZenith(page, { ...openMessage, hostBuild: 1 });
  // The project still opens; the bar says DSIM needs an update, and so does the status line.
  await expect(zenith.getByTestId("step-row-toGarden")).toBeVisible();
  await expect(zenith.getByTestId("host-outdated")).toContainText("DSIM needs an update");
  await expect(zenith.getByTestId("status")).toContainText(
    "DSIM needs an update before it can read autos from this Zenith, so Save to DSIM and Simulate in DSIM are off. Save a copy keeps your work.",
  );

  // Save to DSIM and Simulate in DSIM are off, each with the reason in its tooltip, and nothing is sent.
  const save = zenith.getByTestId("host-run.save");
  await expect(save).toHaveAttribute("aria-disabled", "true");
  await save.hover();
  await expect(zenith.getByRole("tooltip")).toContainText("DSIM needs an update before it can read autos from this Zenith");
  await zenith.mouse.move(0, 0);
  const simulate = zenith.getByTestId("host-host.simulate");
  await expect(simulate).toHaveAttribute("aria-disabled", "true");
  await simulate.hover();
  await expect(zenith.getByRole("tooltip")).toContainText("DSIM needs an update before it can read autos from this Zenith");
  await zenith.mouse.move(0, 0);
  await zenith.keyboard.press("Control+s");
  // `aria-disabled` keeps the buttons focusable for their tooltips, so a press still reaches them.
  await save.click({ force: true });
  await simulate.click({ force: true });
  expect((await received(page)).filter((message) => message.data.type === "save" || message.data.type === "run")).toEqual([]);
  await shot(zenith, "host-mode-outdated");

  // Save a copy is on the bar and still works.
  const download = zenith.waitForEvent("download");
  await zenith.getByTestId("host-project.saveCopy").click();
  expect((await download).suggestedFilename()).toBe("collect-and-score.auto.json");
});

/** True when an element's text is cut off: wider than its box. */
const clipped = (page: Page, testId: string): Promise<boolean> =>
  page.getByTestId(testId).evaluate((element) => element.scrollWidth > element.clientWidth);

/** Save to DSIM lies wholly inside the window, left of Search, so nothing covers it. */
async function expectSaveInView(zenith: Page, width: number): Promise<void> {
  const save = await zenith.getByTestId("host-run.save").boundingBox();
  const search = await zenith.getByTestId("toolbar-search").boundingBox();
  expect(save, `Save to DSIM at ${String(width)}`).not.toBeNull();
  expect(search).not.toBeNull();
  if (save === null || search === null) return;
  expect(save.x, `Save to DSIM's left edge at ${String(width)}`).toBeGreaterThanOrEqual(0);
  expect(save.x + save.width, `Save to DSIM's right edge at ${String(width)}`).toBeLessThanOrEqual(search.x);
  expect(search.x + search.width).toBeLessThanOrEqual(width);
}

test("the host bar shows the robot and the alliance unclipped, and Save to DSIM at every width (sweep W4-3)", async ({ page }) => {
  const zenith = await openFromHost(page);
  await nextOfType(page, "ready");
  await sendToZenith(page, openMessage);
  await expect(zenith.getByTestId("step-row-toGarden")).toBeVisible();

  for (const width of [1440, 1280]) {
    await zenith.setViewportSize({ width, height: 900 });
    await expect(zenith.getByTestId("host-subject")).toHaveText("Starter robot, build 3");
    await expect(zenith.getByTestId("host-subject")).toBeVisible();
    await expect(zenith.getByTestId("host-alliance")).toBeVisible();
    expect(await clipped(zenith, "host-subject"), `the robot's name at ${String(width)}`).toBe(false);
    expect(await clipped(zenith, "host-alliance"), `the alliance at ${String(width)}`).toBe(false);
    await expect(zenith.getByTestId("host-run.save")).toHaveText("Save to DSIM");
    await expectSaveInView(zenith, width);
    // The tool groups fold into More before the host's line would clip: here they all still fit.
    await expect(zenith.getByTestId("toolbar-view.alliance")).toBeVisible();
    await expect(zenith.getByTestId("toolbar-more")).toHaveCount(0);
    await zenith.mouse.move(0, 0);
    await shot(zenith, `host-bar-${String(width)}`);
  }
  // At 1440, DSIM's popup size, Simulate keeps its words too.
  await zenith.setViewportSize({ width: 1440, height: 900 });
  await expect(zenith.getByTestId("host-host.simulate")).toHaveText("Simulate in DSIM");
  await expect(zenith.getByTestId("host-host.simulate").getByText("Simulate in DSIM")).toBeVisible();

  // At 900 the line gives way, and Save to DSIM is still whole and uncovered.
  await zenith.setViewportSize({ width: 900, height: 700 });
  await expect(zenith.getByTestId("host-run.save")).toBeVisible();
  await expectSaveInView(zenith, 900);
  // The two lines are not drawn here, so Save to DSIM's tooltip says them.
  await expect(zenith.getByTestId("host-subject")).toBeHidden();
  await zenith.getByTestId("host-run.save").hover();
  await expect(zenith.getByRole("tooltip")).toContainText(
    "Editing Starter robot, build 3 for DSIM. Draw for RED. DSIM mirrors it when you play BLUE.",
  );
  await shot(zenith, "host-bar-900-tooltip");
  // A tool group that no longer fits is in More, not cut off.
  await expect(zenith.getByTestId("toolbar-view.alliance").or(zenith.getByTestId("toolbar-more"))).toBeVisible();
  const tools = await zenith.getByTestId("toolbar").evaluate((bar) => bar.scrollWidth - bar.clientWidth);
  expect(tools).toBeLessThanOrEqual(0);
  await zenith.mouse.move(0, 0);
  await shot(zenith, "host-bar-900");
});

test("a DSIM that needs an update still shows Save to DSIM whole at 900 wide", async ({ page }) => {
  const zenith = await openFromHost(page);
  await nextOfType(page, "ready");
  await sendToZenith(page, { ...openMessage, hostBuild: 1 });
  await expect(zenith.getByTestId("host-outdated")).toBeVisible();
  for (const width of [1440, 1280, 900]) {
    await zenith.setViewportSize({ width, height: 900 });
    await expect(zenith.getByTestId("host-project.saveCopy")).toBeVisible();
    await expectSaveInView(zenith, width);
    await zenith.mouse.move(0, 0);
    await shot(zenith, `host-bar-outdated-${String(width)}`);
  }
});

test("a run the host cannot do ends the wait at once with the host's reason (sweep W4-2)", async ({ page }) => {
  const zenith = await openFromHost(page);
  await nextOfType(page, "ready");
  await sendToZenith(page, openMessage);
  await expect(zenith.getByTestId("step-row-toGarden")).toBeVisible();

  await zenith.getByTestId("host-host.simulate").click();
  const run = await nextOfType(page, "run");
  expect(run.data.name).toBe("collect-and-score");
  await expect(zenith.getByTestId("host-host.simulate")).toContainText("Simulating in DSIM");
  await sendToZenith(page, {
    type: "runFailed",
    auto: "collect-and-score",
    reason: "This auto file is formatVersion 4; this build of Zenith knows 3",
  });
  await expect(zenith.getByTestId("status")).toContainText(
    "DSIM could not simulate collect-and-score.auto.json: This auto file is formatVersion 4; this build of Zenith knows 3.",
  );
  // The button is back and can run again.
  await expect(zenith.getByTestId("host-host.simulate")).toContainText("Simulate in DSIM");
  await expect(zenith.getByTestId("host-host.simulate")).not.toHaveAttribute("aria-disabled", "true");
});

test("closing the host's window turns Save off and offers a copy instead", async ({ page }) => {
  const zenith = await openFromHost(page);
  await nextOfType(page, "ready");
  await sendToZenith(page, openMessage);
  await expect(zenith.getByTestId("step-row-toGarden")).toBeVisible();
  await expect(zenith.getByTestId("host-run.save")).not.toHaveAttribute("aria-disabled", "true");

  // The host cannot say it is gone, so Zenith notices within a second or two, without a Save first.
  await page.close();
  await expect(zenith.getByTestId("host-closed")).toContainText("DSIM's window was closed", { timeout: 5_000 });
  await expect(zenith.getByTestId("host-run.save")).toHaveAttribute("aria-disabled", "true");
  await expect(zenith.getByTestId("status")).toContainText("Save to DSIM is off. Save a copy keeps your edits.");
  await expect(zenith.getByTestId("titlebar-where")).toHaveText("was in DSIM");
  await zenith.mouse.move(0, 0);
  await shot(zenith, "host-mode-window-closed");

  // The copy is one click away on the bar.
  const download = zenith.waitForEvent("download");
  await zenith.getByTestId("host-project.saveCopy").click();
  expect((await download).suggestedFilename()).toBe("collect-and-score.auto.json");
});

test("without an opener, host mode says what happened and leads to the start screen", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?host=dsim");
  await expect(page.getByTestId("host-failure")).toHaveText(
    "Zenith was opened for DSIM, but not from a DSIM window, so no project can arrive. Open it again from DSIM. If the browser blocked the pop-up, allow pop-ups for DSIM first.",
  );
  await shot(page, "host-mode-no-project");
  await page.getByTestId("host-continue").click();
  await expect(page.getByTestId("canvas-load-example")).toBeVisible();
});

test("an opener that never sends a project gets the same message after ten seconds", async ({ page }) => {
  const zenith = await openFromHost(page);
  await nextOfType(page, "ready");
  // A message from an origin that is not the opener's, or a malformed one, changes nothing.
  await zenith.evaluate(() => {
    window.postMessage({ type: "open", protocol: "zenith-host/1" }, "*");
  });
  await sendToZenith(page, { type: "open", protocol: "zenith-host/1", project: { name: "x" } });
  await expect(zenith.getByTestId("host-gate")).toHaveAttribute("data-phase", "waiting");
  await shot(zenith, "host-mode-waiting");
  await expect(zenith.getByTestId("host-failure")).toContainText("DSIM did not send a project", { timeout: 15_000 });
});

test("a host on another protocol version is told so at once, not after ten seconds", async ({ page }) => {
  const zenith = await openFromHost(page);
  await nextOfType(page, "ready");
  await sendToZenith(page, { ...openMessage, protocol: "zenith-host/2" });
  await expect(zenith.getByTestId("host-failure")).toHaveText(
    "DSIM sent its project in zenith-host/2, and this version of Zenith reads only zenith-host/1, so the two are out of step. Reload DSIM and open Zenith from it again.",
    { timeout: 3_000 },
  );
  await shot(zenith, "host-mode-other-protocol");
});
