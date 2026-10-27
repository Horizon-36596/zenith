# Zenith for Windows (`@horizon36596/zenith-desktop`)

Horizon (FTC 36596). The Zenith planner as a Windows app. It is the same editor as the web build,
plus the things a browser cannot do, each behind a button or a menu item:

- **Open a robot repository in place.** File > Open robot repo… picks the folder; Zenith reads and
  saves the autos there and reloads an auto when it changes on disk. File > Open Recent lists the last
  eight, and File > Open project… (Ctrl+O) is the editor's own Open project dialog. The bundled
  example is read only: closing with edits in it offers Save a copy…, which asks where to save and
  closes only once the copy is written.
- **Run the high-fidelity sim** (Robot > Run high-fidelity sim, Ctrl+F5). Runs `sim.command` from the
  repository's `zenith.json` in the repository, streams its output, can be cancelled, and when it
  finishes loads the trace so the simulated path is drawn over the plan. If Java is missing, or the
  build fails for a common reason, the panel says what to do in plain words. A Gradle wrapper command
  gets Gradle's `--rerun`, so running an unchanged auto again runs the test again instead of
  reporting it up to date.
- **Deploy autos** (Robot > Deploy autos, Ctrl+Shift+D). Shows which files would be written into
  `deploy.dir` and which are unchanged, then writes them when you confirm. It does not build or
  install anything on the robot.
- **Commit, push and open a pull request** (Robot > Commit, push and open PR, Ctrl+Shift+G). Commits
  the open auto and its rendered picture on a work branch `auto/<name>/<your login>` (Commit is off
  while the auto is the same as in the last commit), pushes that
  branch, and opens or updates the pull request with the body Zenith writes. It never commits to or
  pushes the base branch and never force-pushes. The GitHub token comes from the GitHub CLI
  (`gh auth token`) when it is installed and signed in; otherwise the panel asks for a personal access
  token once and keeps it encrypted with Windows' own data protection.
- **Sign in to GitHub mode with the GitHub CLI.** When `gh` is installed and signed in, the GitHub
  sign-in dialog offers Sign in with the GitHub CLI: the main process runs
  `gh auth token --hostname github.com` and hands the token to the page through one named call, and
  the page keeps it in memory until sign-out or until Zenith closes. Pasting a token still works.
- **Open a clone in GitHub mode.** When the open folder is a git clone whose `origin` is on github.com,
  the Open project dialog offers that repository in GitHub mode with the owner, the name and the base
  branch filled in.
- **Opened by `zenith open`.** `zenith open [dir] [--auto <name>]` and the MCP tool `zenith.app.open`
  start the app with `--zenith-open=<folder>` (and `--zenith-auto=<name>`), or hand the folder to the
  running app through its single-instance lock. The app registers no URL scheme, so only a program on
  this computer can ask it to open a folder, and the folder must hold a `zenith.json`.

## Run it from the repository

```powershell
pnpm install
pnpm exec tsc -b
pnpm --filter @horizon36596/zenith-desktop dev
```

`dev` starts the web editor's Vite dev server and opens the app on it, so edits to `apps/web` reload
in place. Edits to `apps/desktop/src` need `dev` restarted.

To run the built app instead:

```powershell
pnpm --filter @horizon36596/zenith-web build; pnpm --filter @horizon36596/zenith-desktop build; pnpm --filter @horizon36596/zenith-desktop start
```

## Build the installer

```powershell
pnpm --filter @horizon36596/zenith-desktop dist
```

This writes `apps/desktop/release/Zenith-Setup-0.1.2.exe` (an installer that asks where to install)
and `apps/desktop/release/Zenith-Portable-0.1.2.exe` (runs without installing). Neither is
code-signed, so Windows SmartScreen shows a warning the first time; choose More info > Run anyway.

The app icon is the Zenith mark: `resources/icon.ico` (16 to 256 px) is what electron-builder puts
on the exe and the shortcuts, `resources/icon.png` is the 512 px render and `resources/icon.svg` is a
copy of the mark. All three are generated from the one master, `brand/zenith-mark.svg`, by
`node scripts/brand-icons.mjs`; change the master and re-run it, never edit an icon by hand.

## Tests

```powershell
pnpm exec vitest run --project desktop
pnpm --filter @horizon36596/zenith-desktop build; pnpm --filter @horizon36596/zenith-desktop test:e2e
```

- The vitest suite covers the bridge handlers without Electron: path confinement, the sim's argv and
  cancellation with a fake child process, the git argv and the refusal to touch the base branch, the
  deploy preview, the encrypted token, the zenith:// scheme and the menu, the Content-Security-Policy
  with and without a cloud and the development run's sign-in window allowlist (`src/main/cloud.ts`),
  and signing in through the system browser (`src/main/nativeSignIn.ts`: PKCE, the state check, the
  one-shot loopback server, both code flows and GitHub's device flow against a fake `fetch` and clock).
- The Playwright suite (`e2e/`) starts the built app through `_electron.launch`, loads the example and
  checks the canvas, then opens a copy of `examples/starter` in place, saves and previews a deploy.
  `e2e/sim.spec.ts` runs a real high-fidelity sim and is skipped unless `ZENITH_SIM_REPO` names a robot
  repository: `$env:ZENITH_SIM_REPO = 'C:\path\to\robot-repo'; pnpm --filter @horizon36596/zenith-desktop test:e2e`.
- `e2e/github-cli.spec.ts` signs in with a fake `gh` (`e2e/fixtures/fake-gh.cjs`, named by
  `ZENITH_TEST_GH`, which the app honours only under `ZENITH_HEADLESS=1`) and opens a project with
  `--zenith-open`, both at launch and through a second launch.
- Tests run windowless: they set `ZENITH_HEADLESS=1`, under which the app never shows its window,
  never takes focus and never pops up a menu, and screenshots come from `webContents.capturePage()`.
  Set it for any script that starts the app while someone is using the computer.

## How it is put together

- `src/main/` is the main process. `index.ts` makes the window; `ipc.ts` registers one handler per
  bridge method, each refusing calls from anything but the app's own page; the rest are the handlers'
  logic, kept free of Electron so vitest can run them.
- `src/preload/index.ts` exposes `window.zenithDesktop`, typed by
  `apps/web/src/project/desktopBridge.ts`. There is no generic "invoke": each method is one channel.
- The page is locked down: context isolation, the sandbox, no Node, a strict Content-Security-Policy,
  no navigation away, links open in the system browser, and every permission request refused.
- The page is served from `zenith://app/`, not `file://`: the web build uses absolute asset paths, and
  `file://` would let the page read any local file.
- File access is confined to a folder you picked in the folder dialog or the recent list: a path that
  is absolute, climbs out with `..`, or reaches outside through a link or junction is refused.
