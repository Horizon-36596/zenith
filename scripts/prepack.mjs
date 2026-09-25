#!/usr/bin/env node
// The `prepack` step of every published package: copies the repository's LICENSE and NOTICE into
// the package directory, so each tarball carries them (npm shows neither from the repository root).
// The copies are build output and are ignored by git; the root files are the only ones to edit.
import { copyFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const packageDir = process.cwd();
if (!existsSync(join(packageDir, "package.json")) || packageDir === repoRoot.replace(/[\/]$/, "")) {
  throw new Error("prepack.mjs runs from a package directory, as that package's prepack script.");
}
for (const file of ["LICENSE", "NOTICE"]) {
  copyFileSync(join(repoRoot, file), join(packageDir, file));
}
if (!existsSync(join(packageDir, "dist"))) {
  throw new Error(`${packageDir} has no dist/; run pnpm build before packing.`);
}
