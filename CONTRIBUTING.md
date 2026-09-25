# Contributing to Zenith

Thanks for helping. This page covers setup, the checks a change must pass, and the rules the
codebase depends on.

## Setup

You need Node 22 or later and pnpm 10.

```powershell
pnpm install
```

Run the editor while you work:

```powershell
pnpm --filter @horizon36596/zenith-web dev
```

## The gates

Every change must pass the build and the test suite. Build first: the MCP server's tests load the
built output.

```powershell
pnpm install; pnpm build; pnpm test
```

`pnpm test` runs every package's vitest suite and the purity check described below.

The web app and the desktop app also have end-to-end tests, written with Playwright:

```powershell
pnpm --filter @horizon36596/zenith-web test:e2e
```

```powershell
pnpm --filter @horizon36596/zenith-desktop test:e2e
```

Run these when you change anything in `apps/`.

## Commits

- Conventional commits: `feat(core): ...`, `fix(web): ...`, `docs: ...`, `test(cli): ...`.
- Small. One change per commit, so a reviewer can follow it.
- Plain full sentences in the message body, code and comments.
- No attribution lines and no `Co-Authored-By` trailers.

## Rules the code depends on

### `core` and `schema` are pure

`packages/core` and `packages/schema` use no DOM, no clock, no randomness and no Node APIs. That is
what makes the CLI, the editor, the MCP server and a reviewer agree on every number.

`pnpm test` enforces it: it searches those packages for `Math.random`, `Date.now`,
`performance.now`, `window`, `document` and `process.`, and fails on any hit. If you need one of
those, the code belongs in a different package, which then passes the value in.

### Canonical form is a contract

Every Zenith file has one canonical form: key order, number formatting and layout are fixed, so a
`git diff` of an auto reads like a description of the change.

A change that alters canonical form, or the meaning of any field, must:

1. bump that file kind's `formatVersion`,
2. ship a migration from the previous version,
3. add a fixture: a file in the old format and the migrated result, with a test that checks one
   becomes the other.

Files written by an older version must keep loading.

### Units and provenance

- Units in files are inches, radians and seconds, and every numeric key names its unit (`xIn`,
  `headingRad`, `estimateS`). Degrees appear only in the UI.
- Never invent a number. Every constant in `robot.json` and `field.json` carries a provenance
  label: MEASURED, SET BY HAND, SPEC, NEEDS MEASUREMENT, CARRIED OVER, PLACEHOLDER, APPROX, SET FROM
  SIM, SET FROM EDITOR, CALIBRATED FROM SIM or CALIBRATED FROM ROBOT. If you do not know a value, use
  PLACEHOLDER and say so.

## Adding a season plugin

Read the [Seasons](https://libraries.horizon36596.org/zenith/seasons/) page first. It explains the
`SeasonRules` interface and walks through BIOBUZZ.

`packages/season-biobuzz` is the reference implementation. In short:

1. Write the season's `field.json`, with `rules.plugin` set to your plugin's id and a provenance
   label on every number.
2. Create a package that exports a `SeasonRules` object and a `loadSeason(field)` function. Every
   rule reads from the field file; nothing is a constant typed from the game manual.
3. Register it in `packages/seasons/src/index.ts` and add it as a dependency there.
4. Add tests for the kickoff state, launches, collects, the approach rule and each start rule.

If you want a season supported but cannot write the plugin, open a season request issue instead.

## Pull requests

Fill in the pull request template. Say which gates you ran, whether the change touches canonical form
or `formatVersion`, and add a screenshot if the UI changed.

By contributing, you agree that your contribution is licensed under the MIT licence in `LICENSE`.

Everyone taking part is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
