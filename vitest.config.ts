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
  "@horizon36596/zenith-import": src("import"),
  // The cloud package's firebase-free entries, which the web app imports; listed before the bare name.
  "@horizon36596/zenith-cloud/memory": fileURLToPath(new URL("./packages/cloud/src/memory/index.ts", import.meta.url)),
  "@horizon36596/zenith-cloud/verification": fileURLToPath(new URL("./packages/cloud/src/verification.ts", import.meta.url)),
  "@horizon36596/zenith-cloud/sharing": fileURLToPath(new URL("./packages/cloud/src/sharing.ts", import.meta.url)),
  "@horizon36596/zenith-cloud/bugReports": fileURLToPath(new URL("./packages/cloud/src/bugReports.ts", import.meta.url)),
  "@horizon36596/zenith-cloud/crypto": fileURLToPath(new URL("./packages/cloud/src/crypto/index.ts", import.meta.url)),
  "@horizon36596/zenith-cloud": src("cloud"),
};

const project = (name: string, dir: string, testTimeout?: number) => ({
  resolve: { alias },
  test: {
    name,
    root: fileURLToPath(new URL(".", import.meta.url)),
    include: [`${dir}/src/**/*.test.ts`, `${dir}/test/**/*.test.ts`],
    environment: "node" as const,
    ...(testTimeout === undefined ? {} : { testTimeout }),
  },
});

export default defineConfig({
  test: {
    projects: [
      project("schema", "packages/schema"),
      project("core", "packages/core"),
      project("season-biobuzz", "packages/season-biobuzz"),
      project("seasons", "packages/seasons"),
      project("import", "packages/import"),
      project("cli", "packages/cli"),
      project("mcp", "packages/mcp"),
      // The canvas modules under apps/web/src/canvas are deliberately DOM-free arithmetic, so they
      // run in the same node environment as the packages and need no browser harness.
      project("web", "apps/web"),
      project("github", "packages/github"),
      // The cloud client. Its permission suite runs against the in-memory rules here; the same suite
      // runs against the Firestore emulator when FIRESTORE_EMULATOR_HOST is set (pnpm test:rules)
      // and skips, saying so, when it is not.
      // Its multi-device tests make real P-256 keys and signatures for every device and team they
      // drive, which takes 2 to 4 seconds each on an idle machine, so the 5-second default fails them
      // whenever the runner is busy. 30 seconds still catches a hang.
      project("cloud", "packages/cloud", 30_000),
      // The desktop app's main-process handlers (path confinement, sim argv and cancellation, git argv,
      // never-write-base) run in node with fakes for Electron, child processes and git.
      project("desktop", "apps/desktop"),
      // The repository's own Node scripts that have vitest tests (scripts/*.test.ts), with fakes for
      // git, gh and every process they would start. The scripts' node:test files (*.test.mjs) are
      // not vitest files and are left to node --test.
      {
        test: {
          name: "scripts",
          root: fileURLToPath(new URL(".", import.meta.url)),
          include: ["scripts/**/*.test.ts"],
          environment: "node" as const,
        },
      },
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
