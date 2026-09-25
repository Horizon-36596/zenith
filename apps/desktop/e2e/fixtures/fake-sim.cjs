// A stand-in for a robot repository's headless sim, for the desktop smoke test. It prints a few lines
// the way Gradle would, then writes the fixture trace (the instant sim's run of the starter's
// all-step-kinds auto), renamed for the auto it was given, where zenith.json's sim.trace says. No
// Java, no Gradle, no network.
const { mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

const auto = process.argv[2];
if (typeof auto !== "string" || !/^[A-Za-z0-9._-]+$/.test(auto)) {
  console.error("fake-sim: expected an auto name");
  process.exit(2);
}
console.log("> Task :TeamCode:testDebugUnitTest");
console.log(`fake-sim: running ${auto}`);
const dir = join(process.cwd(), "TeamCode", "build", "sim");
mkdirSync(dir, { recursive: true });
// Written, not copied: a copy keeps the fixture's old modification time, and the app rightly refuses a
// trace older than the run as a previous run's.
const trace = JSON.parse(readFileSync(join(__dirname, "fake-sim-trace.json"), "utf8"));
trace.auto = auto;
writeFileSync(join(dir, `${auto}.trace.json`), JSON.stringify(trace) + "\n");
console.log("BUILD SUCCESSFUL in 1s");
