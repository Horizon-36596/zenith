# Zenith

A PathPlanner-style autonomous planner for FTC that humans and agents share. Horizon (FTC 36596).

This file is for coding agents working on Zenith itself. People start with `CONTRIBUTING.md`; both
say the same thing about the rules. The user documentation is `site/` (published at
<https://libraries.horizon36596.org/zenith/>); `site/docs/file-format.md` is the file-format
reference and `site/docs/checks-and-findings.md` lists every check.

## Rules

1. `packages/core` and `packages/schema` are pure: no DOM, no clock, no randomness, no Node APIs.
   `pnpm test` greps for `Math.random`, `Date.now`, `performance.now`, `window`, `document` and
   `process.` in those packages and fails on any hit. Code that needs one of those belongs in another
   package, which passes the value in.
2. Canonical form is a contract. A change that alters it, or the meaning of any field, bumps that file
   kind's `formatVersion` and ships a migration with a fixture (the old file and the migrated result).
   Files written by an older version keep loading.
3. Units in files are inches, radians and seconds, and every numeric key names its unit (`xIn`,
   `headingRad`, `estimateS`). Degrees appear only in the UI.
4. Never invent a number. Every constant in `robot.json` and `field.json` carries a provenance label:
   MEASURED, SET BY HAND, SPEC, NEEDS MEASUREMENT, CARRIED OVER, PLACEHOLDER, APPROX, SET FROM SIM,
   SET FROM EDITOR, CALIBRATED FROM SIM or CALIBRATED FROM ROBOT. A value you do not know is
   PLACEHOLDER, and says so.
5. Write the test first. A behaviour change comes with the test that shows it.
6. Do not assume a fact about Pedro Pathing, SolversLib or the FTC SDK. Check it against the library's
   source or documentation, and say in the code comment or the pull request where it came from.
7. Commits are conventional and small, with no attribution lines or co-author trailers. Code, comments
   and commit messages are plain full sentences.
8. Stack: pnpm workspaces, Node 22, TypeScript 5 strict, Vite, React 18, Canvas 2D, vitest,
   Playwright. Raise an issue before adding another framework.
9. The robot runtime is the Gradle library under `robot/`, one published module (`:auto-runtime`),
   installed by teams from JitPack. Publishing a second module would change its coordinate.
10. The web app is served from `/` in the desktop app and from `/zenith/app/` on the public site. Reach
    every file in `apps/web/public/` through `import.meta.env.BASE_URL`, never from `/`.

## Commands

```
pnpm install
pnpm build                          # first: the MCP stdio tests load the built dist
pnpm test                           # all packages, includes the purity grep
pnpm --filter ./apps/web dev
pnpm zenith -- validate examples/starter/autos/first-auto.auto.json
pnpm --filter ./apps/web test:e2e
pnpm --filter ./apps/web test:e2e:pages   # the web build under /zenith/app/
node scripts/build-pages.mjs        # the docs site, the web app and the schemas, as Pages serves them
.\robot\gradlew.bat -p robot build  # the robot runtime (JDK 17 and the Android SDK)
```

Run the desktop app's end-to-end tests with `ZENITH_HEADLESS=1`, so no window appears:

```
pnpm --filter ./apps/desktop test:e2e
```
