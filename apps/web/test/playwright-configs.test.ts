import type { PlaywrightTestConfig } from "@playwright/test";
import { describe, expect, it } from "vitest";
import main from "../playwright.config";
import pages from "../playwright.pages.config";
import qa from "../e2e/qa/playwright.qa.config";
import { VIEWPORT } from "../e2e/viewports";

/**
 * A project's `use` replaces the config's top-level `use` key by key, and a device spread such as
 * `...devices["Desktop Chrome"]` brings its own viewport, user agent and scale factor. A top-level
 * key that a project also sets is therefore dead: the suite ran at 1280x720 for weeks while the
 * config and a test title said 1440x900. Each key has to be set in one place, or agree in both.
 *
 * Every config also runs at the one default size in e2e/viewports.ts, so a spec behaves the same
 * whichever config runs it.
 */
const CONFIGS: [string, PlaywrightTestConfig][] = [
  ["playwright.config.ts", main],
  ["playwright.pages.config.ts", pages],
  ["e2e/qa/playwright.qa.config.ts", qa],
];

describe("the Playwright configs", () => {
  for (const [file, config] of CONFIGS) {
    it(`${file}: no project silently overrides a top-level use option`, () => {
      const top = (config.use ?? {}) as Record<string, unknown>;
      const overridden = (config.projects ?? []).flatMap((project) => {
        const own = (project.use ?? {}) as Record<string, unknown>;
        return Object.keys(top)
          .filter((key) => key in own && JSON.stringify(own[key]) !== JSON.stringify(top[key]))
          .map((key) => `${project.name ?? "(unnamed)"}: ${key}`);
      });
      expect(overridden).toEqual([]);
    });

    it(`${file}: every project runs at the shared default viewport`, () => {
      const viewports = (config.projects ?? []).map((project) => project.use?.viewport ?? config.use?.viewport);
      expect(viewports.length).toBeGreaterThan(0);
      for (const viewport of viewports) expect(viewport).toEqual(VIEWPORT);
    });
  }
});
