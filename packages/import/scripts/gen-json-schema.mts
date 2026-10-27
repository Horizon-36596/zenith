// Writes packages/import/json/trajectory.json and json/path.json from the zod schemas. The output is
// checked into git, and the drift tests (importTrajectory.test.ts, importPath.test.ts) fail when a
// checked-in file differs from its schema.
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { interchangeJsonSchemaTexts } from "../src/jsonschema.ts";

const outDir = fileURLToPath(new URL("../json/", import.meta.url));
mkdirSync(outDir, { recursive: true });
for (const [name, text] of Object.entries(interchangeJsonSchemaTexts())) {
  writeFileSync(`${outDir}${name}`, text, "utf8");
  console.log(`wrote json/${name}`);
}
