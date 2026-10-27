import type { RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { afterAll, beforeAll, describe, it, vi } from "vitest";
import { EMULATOR_HOST, SKIP_MESSAGE, emulatorHarness, startEmulatorEnvironment } from "./emulatorHarness.js";
import { definePermissionSuite } from "./permissions.suite.js";

let env: RulesTestEnvironment | undefined;

// Each case makes several round trips to the emulator, which is far slower than memory.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

if (EMULATOR_HOST === undefined) {
  describe("permissions (Firestore emulator)", () => {
    it.skip(SKIP_MESSAGE, () => undefined);
  });
  console.warn(SKIP_MESSAGE);
} else {
  beforeAll(async () => {
    env = await startEmulatorEnvironment("demo-zenith-permissions");
  });
  afterAll(async () => {
    await env?.cleanup();
  });
  definePermissionSuite("Firestore emulator, cloud/firestore.rules", () =>
    emulatorHarness(() => {
      if (env === undefined) throw new Error("The emulator environment did not start.");
      return env;
    }),
  );
}
