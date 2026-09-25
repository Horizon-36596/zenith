# Working with GitHub

Zenith keeps autos in your team's robot repository. You can work on a local clone and use git
yourself, or open the repository in **GitHub mode**, where the app reads and writes through the GitHub
API and opens pull requests for you. This page covers GitHub mode, the propose flow and review links.

## Local mode and GitHub mode

Local mode
:   The default. The app opens a folder on your computer, reads `zenith.json` and the files it points
    at, and saves in place. Git is yours: commit and push from your terminal or IDE as usual. Works
    offline. Agents always work this way, through the CLI on the clone they are in.

GitHub mode
:   Sign in, pick a repository your account can push to, and pick a base branch (the repository's
    default branch unless you choose another). The app reads the same files through the GitHub API
    and edits on a work branch it creates. Nothing is written to the base branch.

## Signing in

In v0.1.0 you sign in with a **fine-grained personal access token** (PAT) that you paste into the
app.

1. On GitHub, open **Settings -> Developer settings -> Personal access tokens -> Fine-grained tokens**
   and choose **Generate new token**.
2. Under **Repository access**, pick only the robot repository.
3. Under **Permissions**, set **Contents** to *Read and write* and **Pull requests** to *Read and
   write*.
4. Copy the token and paste it into Zenith's sign-in dialog.

The app checks the token against GitHub and shows the account it belongs to. If GitHub rejects it,
the dialog says so; generate a fresh token with the permissions above.

!!! note "Device-flow sign-in"
    Sign-in through a GitHub OAuth App with the device flow (you enter a short code on github.com
    instead of pasting a token) is planned. The PAT stays as the fallback for accounts whose
    organisation does not let them authorise apps.

### Where the token lives

- In memory by default. Close the tab and it is gone.
- If you tick **Remember for this tab**, it is also mirrored to `sessionStorage`, so a reload does not
  ask again. It still ends with the browser session.
- Never in `localStorage`, never in a URL, never in a log line.
- It is only ever sent to `api.github.com`.

## Work branches

Every auto you edit in GitHub mode gets its own branch:

```text
auto/<autoName>/<login>
```

For example, `auto/close-cycle/octocat`. You can type a different name when the branch is created.

Every **Save** commits the canonical file to that branch with the message:

```text
auto(<autoName>): <summary you typed, or "edit">
```

One author per branch is the rule. Two people editing the same auto open two branches and two pull
requests, and a merge conflict on GitHub is the signal, the same as with code. Canonical form keeps
those conflicts small: usually one step, a few lines.

## Propose: a pull request that reviews itself

**Propose** (the button in the editor) turns your work branch into a pull request:

1. **Validate.** The auto must pass validation. Errors block the proposal; warnings are listed in the
   pull request body.
2. **Branch.** The work branch is created if it does not exist, and brought up to date with the base
   by merging the base into it. If that merge conflicts, Zenith stops and tells you which files.
3. **Commit.** The auto, any changed waypoints, and a rendered SVG of the routine are committed in
   canonical form. The SVG goes to `<autosDir>/.renders/<autoName>.svg`.
4. **Open or update the pull request** against the base. The body is generated from the auto and
   contains:
    - the auto's name and description,
    - the rendered SVG, linked from the branch, so the picture needs no hosting and is versioned with
      the file,
    - a table with each step's estimated time (with its range), strafe share and findings,
    - the total against the 30 s period, with error and warning counts,
    - the ledger at the end of the routine (what the robot holds and the state of the field),
    - the sim result, if a trace was recorded, or "not run".

Merging is always a human's job, on GitHub.

### Proposing from the command line

```powershell
zenith propose autos/my-auto.auto.json --dry-run
```

This validates the auto, renders it and prints the pull request body to stdout, so you can paste it
into a pull request you open yourself. In v0.1.0 `--dry-run` is the only CLI mode; the branch,
commit and pull request steps run from the editor.

## Review links

A pull request that changes an auto can be opened in the app in **review mode**:

- paste the pull request URL into the open-project dialog, or
- link straight to it with the route `#/review/<owner>/<repo>/<number>`, for example
  `https://libraries.horizon36596.org/zenith/app/#/review/<owner>/<repo>/12`. Put that link in a pull
  request comment so reviewers can open the change with one click.

Review mode loads the auto from both the base and the head of the pull request and:

- draws both on the field, with the base ghosted and the head drawn normally,
- lists the changed steps with their estimate deltas,
- shows the head's findings,
- links each changed step to its line in the pull request's diff view on GitHub.

Comments and approval happen on GitHub.

To compare two versions of an auto on the command line, check out both files and run:

```powershell
zenith diff base.auto.json head.auto.json
```

Add `--json` for a machine-readable diff.

## Permissions and safety

- The app never writes to the base branch and never force-pushes.
- It writes only under the directories `zenith.json` declares: `autosDir` (which holds
  `.renders/`), the deploy directory and the codegen directory. A path outside those, or one that
  contains `..`, is refused.
- Your token is only ever sent to `api.github.com`.
- The public web app carries no team data. Everything lives in your repository.
