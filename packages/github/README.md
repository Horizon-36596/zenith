# @horizon36596/zenith-github

GitHub collaboration for [Zenith](https://libraries.horizon36596.org/zenith/), the FTC autonomous
planner by Horizon (FTC 36596): propose an auto as a pull request, and load a review link, from the
browser or Node.

```
npm install @horizon36596/zenith-github
```

Documentation: https://libraries.horizon36596.org/zenith/. Licence: MIT.

## Package reference

An isomorphic (browser + Node) GitHub client, built on `fetch` with no Octokit and no Node-only
APIs. It is the only package that talks to `api.github.com`; `apps/web` and `packages/cli` both
build on it. The user-facing side is the docs site's GitHub page
(https://libraries.horizon36596.org/zenith/github/).

### Creating a token

Zenith v1 signs in with a pasted **fine-grained personal access token**.
There is no OAuth App and no device flow yet.

1. On github.com: **Settings -> Developer settings -> Personal access tokens -> Fine-grained
   tokens -> Generate new token**.
2. **Resource owner**: the account or organisation that owns the robot repository.
3. **Repository access**: "Only select repositories", and pick the one robot repository the token
   is for (e.g. `example-team/robot`). Do not grant access to every repository the account can
   see; Zenith only ever needs the one.
4. **Permissions** (under "Repository permissions"):
   - **Contents**: Read and write — reads `zenith.json` and the robot/field/waypoints/auto files,
     writes commits to work branches.
   - **Pull requests**: Read and write — opens and updates the PR `propose` creates, and reads PR
     metadata and changed files for review mode.
   - Everything else can stay "No access".
5. Set an expiry (GitHub's fine-grained tokens require one) and generate. Paste the token into
   Zenith's sign-in screen when it asks.

A fine-grained token scoped this way cannot read or write any other repository, cannot see issues,
actions, settings or anything else in the one repository it can reach, and expires on its own.

### How the token is stored

- The token is held in memory for the life of the tab or process. It is never written to disk by
  this package.
- In the browser, `BrowserTokenStore` can also mirror it to `sessionStorage` (the default) so a
  page reload does not force a re-paste; that mirror is cleared when the tab closes. It is never
  written to `localStorage`, which would outlive the browser session.
- In Node (the CLI), `NodeTokenStore` is a no-op: nothing persists between runs, and it is the
  caller's job (an environment variable, a local file the user manages themselves, an interactive
  prompt) to hand the token to `PatAuth` each time.
- `GitHubClient` sends the token as an `Authorization: Bearer` header to `apiBase` only (default
  `https://api.github.com`). It is never logged, never included in error messages beyond GitHub's
  own response text, and never sent to any other host.

### Safety guarantees

These are enforced in code,
not just by convention:

- **The base branch is never written to.** `GitHubProject.save` throws `BaseBranchWriteError`
  before making any network call if the target branch equals the project's base branch.
- **No force-pushes.** The client has no method that force-updates an existing ref; branches are
  only ever created fresh (`branches.create`, from the base branch's current sha) or advanced by
  ordinary commits (`contents.put`).
- **Path allowlist.** `GitHubProject.save` refuses (`PathNotAllowedError`) any path that is not
  under `zenith.json`'s `autosDir`, `deploy.dir` or `codegen.dir` (which is where
  `autosDir/.renders/` already lives). This is checked locally before any request is sent.
- **Tokens go to `api.github.com` only.** See the storage section above.
- **Merge conflicts are surfaced, not hidden.** `repos.merge` throws a typed `MergeConflictError`
  naming the files involved when the work branch cannot be brought up to date with the base branch
  cleanly, instead of leaving a half-merged branch behind.

### Where the device flow plugs in later

Everything in this package that needs a token depends only on the `AuthProvider` interface:

```ts
interface AuthProvider {
  token(): Promise<string>;
}
```

`PatAuth` is the only implementation today: it wraps a pasted token and always returns it. A later
device-flow implementation (show a code, poll `github.com` for the token, store it with the same `TokenStore`) is a second class implementing the
same interface; `GitHubClient`, `GitHubProject`, `propose` and `loadReview` take an `AuthProvider`
and never construct one, so none of them change when it arrives. Swapping sign-in methods is then a
matter of which `AuthProvider` the app hands to `GitHubClient`, not a rewrite of this package.

### Exported API

See `src/index.ts` for the full surface. In short:

- **Auth**: `AuthProvider`, `PatAuth`, `validateToken`, `TokenStore` (`MemoryTokenStore`,
  `BrowserTokenStore`, `NodeTokenStore`).
- **Client**: `GitHubClient` — `repos`, `branches`, `contents`, `git`, `pulls`, `users`.
- **Project**: `GitHubProject` — `open`, `workBranch`, `save`; `isPathAllowed` /
  `assertPathAllowed`.
- **Propose**: `propose`, `RENDER_URL_PLACEHOLDER`.
- **Review**: `loadReview`, `lineAnchor`, `diffFileHash`, `diffAnchor`.
- **Errors**: `AuthError`, `NotFoundError`, `ConflictError`, `RateLimitError`,
  `MergeConflictError`, `PathNotAllowedError`, `BaseBranchWriteError`, `GitHubError`.

### Testing

`pnpm exec vitest run --project github` (or `pnpm test` for the whole workspace). Every test uses
the hand-rolled `fetch` stub in `test/fetchStub.ts`; nothing here touches the network.
