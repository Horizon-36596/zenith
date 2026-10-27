/**
 * The first-run tour in host mode (site/docs/host-protocol.md), which is how most people first
 * open Zenith: a host such as DSIM opens `?host=dsim` in a popup and sends the project. A first
 * visit gets the core tour once the project is open; a returning visitor does not. Each test starts
 * from an empty browser profile.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { turnOnFeatures } from "./features";

const STARTER = fileURLToPath(new URL("../../../examples/starter/", import.meta.url));
const FAKE_HOST = fileURLToPath(new URL("./fixtures/fake-host.html", import.meta.url));
const read = (path: string): string => readFileSync(join(STARTER, path), "utf8");

const openMessage = {
  type: "open",
  protocol: "zenith-host/1",
  project: {
    name: "starter",
    robot: JSON.parse(read("autos/robot.json")) as unknown,
    field: read("autos/field/biobuzz.field.json"),
    waypoints: read("autos/waypoints.json"),
    autos: { "collect-and-score": read("autos/collect-and-score.auto.json") },
  },
  open: "collect-and-score",
};

/** Opens Zenith from the fake host in host mode and sends it the starter project. */
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
  await expect(zenith.getByTestId("host-gate")).toHaveAttribute("data-phase", "waiting");
  await page.evaluate((data) => {
    (window as unknown as { sendToZenith: (message: unknown) => void }).sendToZenith(data);
  }, openMessage);
  await expect(zenith.getByTestId("step-row-driveOut")).toBeVisible();
  return zenith;
}

test("a first visit from a host gets the tour, about the host's auto, and only once", async ({ page }) => {
  const zenith = await openFromHost(page);
  await expect(zenith.getByTestId("tour-card")).toBeVisible();
  await expect(zenith.getByTestId("tour-card")).toHaveAttribute("data-stop", "field");
  await expect(zenith.getByTestId("tour-card")).toContainText("DSIM");
  // A host's first visit goes straight to the tour: the preset card is for the plain address only.
  await expect(zenith.getByTestId("preset-card")).toHaveCount(0);

  // Dismissing it is remembered, so the next session from the host opens straight to the editor.
  await zenith.getByTestId("tour-skip").click();
  await expect(zenith.getByTestId("tour-card")).toHaveCount(0);
  await zenith.close();

  const again = await openFromHost(page);
  await expect(again.getByTestId("step-row-driveOut")).toBeVisible();
  await expect(again.getByTestId("tour-card")).toHaveCount(0);
});

test("a returning visitor from a host does not get the tour", async ({ page, context }) => {
  await context.addInitScript(() => {
    if (window.localStorage.getItem("zenith.ui") === null) {
      window.localStorage.setItem("zenith.ui", JSON.stringify({ tour: { seen: true, coreDone: true, fullDone: false } }));
    }
  });
  await turnOnFeatures(context);
  const zenith = await openFromHost(page);
  await expect(zenith.getByTestId("step-row-driveOut")).toBeVisible();
  await expect(zenith.getByTestId("tour-card")).toHaveCount(0);
});

test("the tour's save stop points at Save to DSIM on the host bar", async ({ page }) => {
  const zenith = await openFromHost(page);
  await expect(zenith.getByTestId("tour-card")).toHaveAttribute("data-stop", "field");
  for (let step = 0; step < 6; step += 1) await zenith.getByTestId("tour-next").click();
  await expect(zenith.getByTestId("tour-card")).toHaveAttribute("data-stop", "run");
  await expect(zenith.getByTestId("tour-card")).toContainText("Save to DSIM sends the auto back to DSIM.");

  // The spotlight ring sits round the button the card names, once it has moved there.
  const ringHoldsSave = async (): Promise<boolean> => {
    const ring = await zenith.getByTestId("tour-ring").boundingBox();
    const save = await zenith.getByTestId("host-run.save").boundingBox();
    if (ring === null || save === null) return false;
    return (
      ring.x <= save.x &&
      ring.y <= save.y &&
      ring.x + ring.width >= save.x + save.width &&
      ring.y + ring.height >= save.y + save.height
    );
  };
  await expect.poll(ringHoldsSave).toBe(true);
});
