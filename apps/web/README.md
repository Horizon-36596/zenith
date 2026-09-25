# @horizon36596/zenith-web

The Zenith editor: the field canvas, the step list, the inspector and the two ways a project is
opened. `UI_GUIDE.md` is the design contract every panel is built against;
`site/docs/editor.md` describes the editor for its users, and `site/docs/github.md` is the user's
side of what this README's GitHub section implements.

```powershell
pnpm --filter @horizon36596/zenith-web dev      # http://localhost:5173
pnpm --filter @horizon36596/zenith-web test:e2e # the Playwright smoke, after: pnpm exec playwright install chromium
```

## Local mode

Open a folder with `zenith.json` at its root. Zenith reads the robot, field and waypoint files it
names and lists the autos beside them; Save writes the canonical file back in place. Git stays
yours, in your terminal. A browser without the File System Access API (Firefox, Safari) picks the
files individually instead and Save downloads the canonical file. "Load example" opens the bundled
`examples/starter` at its `collect-and-score` auto, and it is read only.

## GitHub mode

Sign in, pick a repository, edit on a work branch, open a pull request, review someone else's.
Everything happens in the browser: there is no server of ours, and the only host the app ever talks
to is `api.github.com`.

### Creating the token

Zenith v1 signs in with a **fine-grained personal access token** you paste in
(`site/docs/github.md`). There is no OAuth app to authorise and no device flow
yet; `packages/github/README.md` has the long version of these steps and of where the seam for a
later device flow is.

1. On github.com: **Settings → Developer settings → Personal access tokens → Fine-grained tokens →
   Generate new token**.
2. **Resource owner**: the account or organisation that owns the robot repository (for Horizon,
   `Horizon-36596`).
3. **Repository access**: "Only select repositories", and pick the one robot repository. Zenith
   never needs another.
4. **Repository permissions**:
   - **Contents: read and write** — reads `zenith.json` and the robot, field, waypoint and auto
     files; commits to work branches.
   - **Pull requests: read and write** — opens and updates the pull request `Propose` creates, and
     reads one back for review mode.
   - Everything else stays at **no access**.
5. Set an expiry, generate, and paste it into the sign-in dialog (`Ctrl/Cmd K` → "Sign in to
   GitHub", or the GitHub tab of the open-project dialog).

### What is written where

| What | Where |
| --- | --- |
| Every Save | `autos/<name>.auto.json` on the **work branch**, message `auto(<name>): <your summary, or "edit">` |
| Propose | the same file, plus `autos/.renders/<name>.svg` and any waypoint change, then a pull request against the base branch |
| The pull request body | `core.prBody`: the render, the per-step estimate table with its warnings, the totals against the autonomous period, the ledger at the end, and whether the simulator was run |

The work branch is `auto/<auto>/<your login>` unless you name one yourself in the open-project or
Propose dialog. It is created from the base branch the first time you commit to it.

### The safety guarantees

These are enforced in code, in `packages/github` and again in the editor, not just by convention:

- **The base branch is never written to.** `GitHubProject.save` throws before making any request if
  the target branch is the base, the editor's backend checks the same thing before it even looks up
  the branch, and Commit is disabled outright when the work branch and the base are the same.
- **No force-pushes.** Branches are only ever created fresh from the base or advanced by ordinary
  commits. There is no client method that force-updates a ref.
- **Only the declared directories are written.** `autosDir`, `deploy.dir` and `codegen.dir` from
  `zenith.json`, and nothing else; a path outside them is refused locally, before any request.
- **Errors block a proposal, warnings do not.** Warnings travel in the pull request body instead, so
  they are the reviewer's business rather than a silent pass.
- **A merge conflict stops the proposal.** The files in conflict are listed and nothing is written,
  rather than leaving a half-merged branch behind.
- **The token is held in one module** (`src/github/session.ts`) and in no other: not in the store,
  not in a URL, not in a log line. "Remember for this tab" mirrors it to `sessionStorage`, which the
  browser drops when the tab closes; it is never written to `localStorage`. Signing out clears both
  the memory copy and the mirror.

### Review mode

Paste a pull request URL into the GitHub tab of the open-project dialog, or open
`#/review/<owner>/<repo>/<number>` — the one route the app has, so a review can be linked to from a
pull request comment. Zenith draws the head over a **ghosted base**, lists the changed steps from
`core.diff` with what each one did to the estimate, shows the head's findings, and links each
changed step to its own line in the pull request's diff view. Editing is off: comments and approval
happen on GitHub, and merging is a human's.

While developing, `?review=fixture` (dev builds only) opens a review of two versions of the bundled
example with no network at all, which is how the layout is worked on without a repository.
