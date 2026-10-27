# Working with GitHub

Zenith keeps autos in your team's robot repository. You can work on a local clone and use git
yourself, or open the repository in **GitHub mode**, where the app reads and writes through the GitHub
API and opens pull requests for you. This page covers GitHub mode, the propose flow and review links.

## Local mode and GitHub mode

Local mode
:   The default. The app opens a folder on your computer, reads `zenith.json` and the files it points
    at, and saves in place. Git is yours: commit and push from your terminal or IDE as usual. Works
    offline. Agents always work this way, through the CLI or the MCP server on the clone they are in,
    and propose with `zenith propose` (below).

GitHub mode
:   Sign in, pick a repository your account can push to, and pick a base branch (the repository's
    default branch unless you choose another). The app reads the same files through the GitHub API
    and edits on a work branch it creates. Nothing is written to the base branch.

## Signing in

The sign-in dialog opens on **Sign in with GitHub**. There is no token to make:

- In the web app, GitHub's sign-in page opens in a small window. Sign in there and allow Zenith.
- In the desktop app, Zenith opens GitHub in your browser and shows a short code to type there.

GitHub then lets Zenith read and write every repository your account can, private ones included,
because GitHub cannot limit this kind of sign-in to one repository. Zenith only touches the repository
you open and never writes to its base branch. An organisation that restricts outside apps has to
approve Zenith once (**Settings -> Third-party access** on the organisation) before its repositories
show up.

### Signing in with a token for one repository

If you want Zenith to reach only the robot repository, choose **Use a token for one repository only**
and paste a **fine-grained personal access token** (PAT):

1. On GitHub, open **Settings -> Developer settings -> Personal access tokens -> Fine-grained tokens**
   and choose **Generate new token**.
2. Under **Repository access**, pick only the robot repository.
3. Under **Permissions**, set **Contents** to *Read and write* and **Pull requests** to *Read and
   write*.
4. Copy the token and paste it into Zenith's sign-in dialog.

The app checks the token against GitHub and shows the account it belongs to. If GitHub rejects it,
the dialog says so; generate a fresh token with the permissions above.

### Signing in with the GitHub CLI (desktop app)

In the desktop app, if the [GitHub CLI](https://cli.github.com/) (`gh`) is installed and signed in to
github.com, the sign-in dialog opens on **Sign in with the GitHub CLI** and you do not need to make a
token. Zenith runs `gh auth token --hostname github.com` and uses the token it prints.

- The token is held in Zenith's memory only, and only until you sign out or close Zenith. It is never
  saved, not even to `sessionStorage`, never put in a URL or a log line, and only ever sent to
  `api.github.com`. After a reload, sign in again with one click.
- GitHub mode then has the GitHub CLI's permissions. Those usually reach every repository your
  account can, not only the robot repository. A fine-grained token made for the one repository is
  the narrower choice, and **Paste a personal access token instead** in the same dialog still takes one.
- Signing out of Zenith does not sign the GitHub CLI out.

If `gh` is installed but signed out, the dialog says to run `gh auth login`. The web app has no
CLI to ask, so it offers Sign in with GitHub and the pasted token.

### Where the token lives

The same rules hold for a token from Sign in with GitHub and a pasted one. In the browser, the dialog's
**Remember the sign-in** choice says where it is kept:

- **Not at all**: in memory only. A reload asks again.
- **Until this tab closes** (the default): also in `sessionStorage`, so a reload does not ask again.
- **In this browser until I sign out**: in `localStorage`, so reopening Zenith, in a new tab or after
  a restart, signs you straight back in. Anyone using the same browser profile can then use it, so
  choose this only on a computer that is yours. Signing out removes it.
- In the desktop app the box reads **Remember on this computer**. The Git panel opens the same
  sign-in dialog, and a pasted token is handed to the desktop app for pull requests too. Ticked, and
  with Windows encryption available, that copy is stored encrypted in the app's settings and lasts
  across launches until you sign out. Unticked, it lasts until Zenith closes. Signing out clears both
  Zenith copies; it does not sign out the GitHub CLI.
- Never in a URL, never in a log line.
- It is only ever sent to `api.github.com`.

GitHub mode in the editor does not read the desktop app's stored copy, so after a restart it may
ask you to sign in again even when the Git panel still has a token.

## Opening a clone in GitHub mode

In the desktop app, when the open folder is a git clone whose `origin` remote is on github.com, the
**Open project** dialog offers **Open this repository in GitHub mode**. The owner, the repository and
the base branch are filled in from the clone: the base is the remote's default branch, else `main`
or `master`, the same branch the Commit panel opens pull requests into. Sign in if you have not, and
the GitHub tab has that repository picked at that base. Your folder is not changed.

The offer needs `zenith.json` at the top of the repository. A project in a subfolder of a repository
cannot be opened in GitHub mode, so the dialog does not offer it.

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

When an auto opens, it opens from its work branch if the branch already has a copy. If the file
changed on the branch after you opened it (you saved it from another tab or computer, or Propose
merged a change from the base into it), **Save** and **Propose** stop and say it changed on GitHub
since you opened it, instead of writing over that commit. Open the auto again to get that version.

## Propose: a pull request that reviews itself

**Propose** (the button in the editor) turns your work branch into a pull request:

1. **Validate.** The auto must pass validation. Errors block the proposal; warnings are listed in the
   pull request body.
2. **Branch.** The work branch is created if it does not exist, and brought up to date with the base
   by merging the base into it. If that merge conflicts, Zenith stops and tells you which files.
3. **Commit.** The auto, any changed waypoints, and a rendered SVG of the routine are committed in
   canonical form, to the branch Save uses unless you type another. The SVG goes to `<autosDir>/.renders/<autoName>.svg`.
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
zenith propose my-auto
```

Run inside a clone of the robot repository, this does every step above: it commits to the work
branch with git, pushes it and opens or updates the pull request. The MCP server has the same as
`zenith.propose`, so an agent can propose too; see
[Connect to GitHub](agents-mcp.md#connect-to-github). It signs in with `GH_TOKEN`, `GITHUB_TOKEN` or
the GitHub CLI (`gh auth login`), not with a pasted token, and git pushes with its own credentials.
The same safety rules apply. `zenith setup` checks all of this in one step.

```powershell
zenith propose my-auto --dry-run
```

`--dry-run` only validates the auto, renders it and prints the pull request body to stdout, so you
can paste it into a pull request you open yourself. See [`zenith propose`](cli-reference.md#zenith-propose).

## Review links

A pull request that changes an auto can be opened in the app in **review mode**:

- paste the pull request URL into the open-project dialog, or
- link straight to it with the route `#/review/<owner>/<repo>/<number>`, for example
  `https://zenith.horizon36596.org/#/review/<owner>/<repo>/12`. Put that link in a pull
  request comment so reviewers can open the change with one click.

Review mode loads the auto from both the base and the head of the pull request and:

- draws both on the field, with the base ghosted and the head drawn normally, each against its own
  waypoints when the pull request changes them,
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

- The app and `zenith propose` never write to the base branch and never force-push.
- It writes only under the directories `zenith.json` declares: `autosDir` (which holds
  `.renders/`), the deploy directory and the codegen directory. A path outside those, or one that
  contains `..`, is refused.
- Your token is only ever sent to `api.github.com`.
- The public web app carries no team data. Everything lives in your repository.
