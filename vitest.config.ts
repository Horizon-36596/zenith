import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = (pkg: string) => fileURLToPath(new URL(`./packages/${pkg}/src/index.ts`, import.meta.url));

// Tests run against TypeScript sources, not `dist`, so `pnpm test` needs no build step.
const alias = {
  // The CLI's library entry, which apps/desktop imports; listed before any bare "@horizon36596/zenith-cli".
  "@horizon36596/zenith-cli/lib": fileURLToPath(new URL("./packages/cli/src/lib.ts", import.meta.url)),
  "@horizon36596/zenith-schema": src("schema"),
  "@horizon36596/zenith-core": src("core"),
  "@horizon36596/zenith-season-biobuzz": src("season-biobuzz"),
  "@horizon36596/zenith-seasons": src("seasons"),
  "@horizon36596/zenith-github": src("github"),
};

const project = (name: string, dir: string) => ({
  resolve: { alias },
  test: {
    name,
    root: fileURLToPath(new URL(".", import.meta.url)),
    include: [`${dir}/src/**/*.test.ts`, `${dir}/test/**/*.test.ts`],
    environment: "node" as const,
  },
});

export default defineConfig({
  test: {
    projects: [
      project("schema", "packages/schema"),
      project("core", "packages/core"),
      project("season-biobuzz", "packages/season-biobuzz"),
      project("seasons", "packages/seasons"),
      project("cli", "packages/cli"),
      project("mcp", "packages/mcp"),
      // The canvas modules under apps/web/src/canvas are deliberately DOM-free arithmetic, so they
      // run in the same node environment as the packages and need no browser harness.
      project("web", "apps/web"),
      project("github", "packages/github"),
      // The desktop app's main-process handlers (path confinement, sim argv and cancellation, git argv,
      // never-write-base) run in node with fakes for Electron, child processes and git.
      project("desktop", "apps/desktop"),
      // hosting/ (the Vercel gate) has no src/ or test/ subdirectory: its tests sit directly
      // under hosting/ next to the root middleware.ts and api/ it exercises.
      {
        test: {
          name: "hosting",
          root: fileURLToPath(new URL(".", import.meta.url)),
          include: ["hosting/**/*.test.ts"],
          environment: "node" as const,
        },
      },
    ],
  },
});
