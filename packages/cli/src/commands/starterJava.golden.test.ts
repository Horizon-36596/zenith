import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandLibrary } from "../commandLibrary.js";
import { runCodegen } from "./codegen.js";
import { runDeploy } from "./deploy.js";

/**
 * examples/starter/generated/ holds what `zenith codegen` and `zenith deploy` write for the starter's
 * `cycle-and-park` auto, once for each command library, so a reader can see Zenith's Java output
 * without running anything. This runs both commands on a copy of the starter project and fails if
 * the checked-in files have drifted from what they write now.
 *
 * Set `ZENITH_UPDATE_GOLDEN=1` to write the files instead of comparing against them. The robot build
 * compiles and runs the two generated classes (the conformance suite in robot/auto-runtime), so an
 * update is checked there too.
 */
const starter = fileURLToPath(new URL("../../../../examples/starter/", import.meta.url));
const AUTO = "cycle-and-park";
const PACKAGE_PATH = "TeamCode/src/main/java/org/firstinspires/ftc/teamcode/zenith";

/** Each file the commands write, by the name it is checked in under. */
const OUTPUTS: ReadonlyArray<readonly [string, string]> = [
  ["CycleAndParkGenerated.java", `${PACKAGE_PATH}/CycleAndParkGenerated.java`],
  ["CycleAndParkAuto.java", `${PACKAGE_PATH}/generated/CycleAndParkAuto.java`],
];

let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "zenith-starter-java-"));
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

/** Copies the starter, sets `deploy.commandLibrary`, and runs codegen and deploy on the copy. */
function generate(library: CommandLibrary): Map<string, string> {
  cpSync(join(starter, "zenith.json"), join(root, "zenith.json"));
  cpSync(join(starter, "autos"), join(root, "autos"), { recursive: true });
  const linkPath = join(root, "zenith.json");
  const link = JSON.parse(readFileSync(linkPath, "utf8")) as { deploy: Record<string, unknown> };
  link.deploy = { ...link.deploy, commandLibrary: library };
  writeFileSync(linkPath, JSON.stringify(link, null, 2));

  expect(runCodegen(AUTO, { cwd: root })).toBe(0);
  expect(runDeploy({ cwd: root })).toBe(0);
  return new Map(OUTPUTS.map(([name, written]) => [name, readFileSync(join(root, written), "utf8")]));
}

describe("examples/starter/generated", () => {
  for (const library of ["solverslib", "ivy"] as const) {
    it(`matches what zenith codegen and zenith deploy write for ${library}`, () => {
      const dir = join(starter, "generated", library);
      for (const [name, java] of generate(library)) {
        const checkedIn = join(dir, name);
        if (process.env["ZENITH_UPDATE_GOLDEN"] === "1") {
          mkdirSync(dir, { recursive: true });
          writeFileSync(checkedIn, java);
          continue;
        }
        expect(
          existsSync(checkedIn),
          `examples/starter/generated/${library}/${name} is missing; regenerate with ZENITH_UPDATE_GOLDEN=1`,
        ).toBe(true);
        expect(
          readFileSync(checkedIn, "utf8").replace(/\r\n/g, "\n"),
          `examples/starter/generated/${library}/${name} is stale; regenerate with ZENITH_UPDATE_GOLDEN=1`,
        ).toBe(java);
      }
    });
  }
});
