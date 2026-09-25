// Writes packages/schema/json/<kind>.json from the zod schemas. The output is checked into git;
// `pnpm build` regenerates it and `json-schema.test.ts` fails when the checked-in files drift.
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { KINDS } from "../src/ids.ts";
import { jsonSchemaText } from "../src/jsonschema.ts";

const outDir = fileURLToPath(new URL("../json/", import.meta.url));
mkdirSync(outDir, { recursive: true });

for (const kind of KINDS) {
  const file = `${outDir}${kind}.json`;
  writeFileSync(file, jsonSchemaText(kind), "utf8");
  console.log(`wrote json/${kind}.json`);
}
