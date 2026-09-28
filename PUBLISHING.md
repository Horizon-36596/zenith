# Publishing

How a Zenith release goes out. A release is a `v*` tag pushed by a person; nothing publishes on its own.
Every command here is for Windows PowerShell 5.1, and each block runs on its own. Unless a block says
otherwise, run it from the repository root.

One tag starts three workflows:

| workflow | what it publishes | where |
|---|---|---|
| `docs-publish.yml` | the docs site, the web app and the JSON Schemas, as one Pages artifact | <https://libraries.horizon36596.org/zenith/>, `/zenith/app/`, `/zenith/schema/v1/<kind>.json` |
| `release.yml` | `Zenith-Setup-<version>.exe`, `Zenith-Portable-<version>.exe` and `SHA256SUMS.txt`, with the notes from `CHANGELOG.md` | <https://github.com/Horizon-36596/zenith/releases> |
| `npm-publish.yml` | the seven `@horizon36596/zenith-*` packages, with provenance | <https://www.npmjs.com/org/horizon36596> |

The fourth channel, the robot runtime on JitPack, builds on demand from the tag (see
[The robot runtime on JitPack](#the-robot-runtime-on-jitpack)).

All three workflows fail before building anything when the tag does not match the version in the root
`package.json`, and `release.yml` also fails when `CHANGELOG.md` has no section for that version.

## The first release, v0.1.0

The public `Horizon-36596/zenith` starts from one commit: a snapshot of the private development
repository, built from an explicit allowlist and scrubbed. These steps happen once. Steps 1, 2 and 13
run in the private development repository; the rest run anywhere with `gh` signed in as an owner of
the Horizon-36596 organisation.

### 1. Check the snapshot builds on its own

In the development repository, on the commit being released:

```powershell
pnpm release:check
```

It makes the public snapshot, scrubs it (Horizon robot specifics, private repository names, local
paths, personal names and emails, secrets), then installs, builds, tests and builds the Pages artifact
inside the snapshot with nothing else on hand. The last line must read `release-check: ready`. Any
`FAIL` line is a stop.

### 2. Make the snapshot to publish

A fresh snapshot of the same commit, which is what gets pushed. The one `release:check` built in has
`node_modules` and build output in it.

```powershell
Remove-Item -Recurse -Force "$env:TEMP\zenith-public" -ErrorAction SilentlyContinue; node scripts/public-snapshot.mjs "$env:TEMP\zenith-public"; if ($?) { node scripts/scrub-check.mjs "$env:TEMP\zenith-public" }
```

The last line must read `scrub: clean`.

### 3. Rename the private repository to `zenith-dev`

The name `zenith` is needed for the public repository.

```powershell
gh repo rename zenith-dev --repo Horizon-36596/zenith --yes
```

GitHub redirects the old name only until a new repository takes it, which step 4 does. Point the
development clone at the new name now:

```powershell
git remote set-url origin https://github.com/Horizon-36596/zenith-dev.git; if ($?) { git fetch origin }
```

### 4. Create the public repository

```powershell
gh repo create Horizon-36596/zenith --public --description "Plan an FTC autonomous on the real field, check it, and run it on the robot without editing Java. Horizon (FTC 36596)." --homepage "https://libraries.horizon36596.org/zenith/"
```

The topics, Discussions (the issue template links to them) and private vulnerability reporting (what
`SECURITY.md` tells people to use):

```powershell
gh repo edit Horizon-36596/zenith --add-topic ftc --add-topic first-tech-challenge --add-topic robotics --add-topic path-planning --add-topic autonomous --add-topic pedro-pathing --add-topic solverslib --add-topic mcp --add-topic typescript --add-topic java --enable-discussions
```

```powershell
gh api -X PUT repos/Horizon-36596/zenith/private-vulnerability-reporting
```

### 5. Commit the snapshot as the first commit and push it

The commit's author is set explicitly, so the name and address are a choice rather than whatever the
machine's git config holds. Both are public for good. Set `$authorName` and `$authorEmail` on the
first line; the block refuses to run until the address is changed.

```powershell
$authorName = 'Horizon (FTC 36596)'; $authorEmail = 'CHANGE-ME'; if ($authorEmail -eq 'CHANGE-ME') { Write-Error 'Set $authorEmail to the address the first commit should carry.' } else { Set-Location "$env:TEMP\zenith-public"; git init -b main; git add -A; git -c user.name="$authorName" -c user.email="$authorEmail" commit -m "chore: release Zenith 0.1.0"; if ($?) { git remote add origin https://github.com/Horizon-36596/zenith.git; git push -u origin main } }
```

If the push is refused with `GH007: Your push would publish a private email address`, the address is
marked private on GitHub (Settings, Emails, "Block command line pushes that expose my email"). Either
untick that setting, or use the account's `users.noreply.github.com` address shown on the same page.

Check what was pushed: one commit, the Horizon author, and the README rendered with the wordmark.

```powershell
gh api repos/Horizon-36596/zenith/commits --jq '.[] | .commit.author.name + " <" + .commit.author.email + "> " + .commit.message'
```

### 6. Turn on Pages, with no custom domain

Source **GitHub Actions**. The Custom domain field stays **empty**: the landing repository
`Horizon-36596/Horizon-36596.github.io` owns `libraries.horizon36596.org`, and a project site with no
domain of its own is served under it at the repository's name, `/zenith/`. Setting a domain here would
take the domain root from every library.

```powershell
gh api -X POST repos/Horizon-36596/zenith/pages -f build_type=workflow
```

In the UI: Settings, Pages, Build and deployment, Source: **GitHub Actions**. Leave Custom domain
empty. Do not add a `CNAME` file.

### 7. Let tags deploy to the `github-pages` environment

Turning Pages on creates a `github-pages` environment that allows the default branch only. A tag is
not a branch, so without this the tag's deploy is rejected before any step runs, with `Tag "v0.1.0" is
not allowed to deploy to github-pages due to environment protection rules.` That message is an
annotation on the run, not a line in a log.

```powershell
gh api -X POST repos/Horizon-36596/zenith/environments/github-pages/deployment-branch-policies -f "name=v*" -f "type=tag"
```

In the UI: Settings, Environments, `github-pages`, Deployment branches and tags, Add rule, ref type
**Tag**, pattern `v*`. Check it:

```powershell
gh api repos/Horizon-36596/zenith/environments/github-pages/deployment-branch-policies --jq '.branch_policies[] | .type + " " + .name'
```

The list must include `tag v*`.

### 8. Add the npm token

On <https://www.npmjs.com/>: create the organisation `horizon36596` (free for public packages), then
a **granular access token** with **Read and write** on the `@horizon36596` scope's packages and an
expiry you will remember. Then store it as the `NPM_TOKEN` secret. `gh` asks for the value and does
not echo it:

```powershell
gh secret set NPM_TOKEN --repo Horizon-36596/zenith
```

If the secret was already set before step 3, it went with the rename to `zenith-dev`. The public
repository needs its own copy (the command above), and the development repository should not keep
one, because it carries the same publish workflow and a `v*` tag pushed there would publish from it:

```powershell
gh secret delete NPM_TOKEN --repo Horizon-36596/zenith-dev
```

### 9. Tag v0.1.0 and push the tag

In the public clone from step 5:

```powershell
Set-Location "$env:TEMP\zenith-public"; git tag v0.1.0; if ($?) { git push origin v0.1.0 }
```

### 10. Watch the three workflows

```powershell
gh run list --repo Horizon-36596/zenith --event push --limit 6
```

Each one, until it finishes; a non-zero exit means it failed:

```powershell
gh run watch --repo Horizon-36596/zenith --exit-status $(gh run list --repo Horizon-36596/zenith --workflow docs-publish.yml --limit 1 --json databaseId --jq '.[0].databaseId')
```

```powershell
gh run watch --repo Horizon-36596/zenith --exit-status $(gh run list --repo Horizon-36596/zenith --workflow release.yml --limit 1 --json databaseId --jq '.[0].databaseId')
```

```powershell
gh run watch --repo Horizon-36596/zenith --exit-status $(gh run list --repo Horizon-36596/zenith --workflow npm-publish.yml --limit 1 --json databaseId --jq '.[0].databaseId')
```

A deploy job with zero steps and no log is the environment rule in step 7; read the annotation in the
Actions tab.

### 11. Trigger JitPack

Open <https://jitpack.io/#Horizon-36596/zenith>, find `v0.1.0` under Releases or Tags, and press
**Get it**. Or ask for the POM, which starts the build and waits for it (a few minutes):

```powershell
Invoke-WebRequest -UseBasicParsing -TimeoutSec 900 https://jitpack.io/com/github/Horizon-36596/zenith/v0.1.1/zenith-v0.1.1.pom | Select-Object StatusCode
```

[The robot runtime on JitPack](#the-robot-runtime-on-jitpack) says what a good build log looks like.

### 12. Check every channel

The docs site answers, and its footer carries the version:

```powershell
$page = Invoke-WebRequest -UseBasicParsing https://libraries.horizon36596.org/zenith/; "$($page.StatusCode) footer has 0.1.0: $($page.Content.Contains('Zenith 0.1.0'))"
```

The web app answers and loads its assets from under `/zenith/app/`. Open it in a browser afterwards
and press **Load example**; the field picture should draw.

```powershell
$app = Invoke-WebRequest -UseBasicParsing https://libraries.horizon36596.org/zenith/app/; "$($app.StatusCode) assets under /zenith/app/: $($app.Content.Contains('/zenith/app/assets/'))"
```

Each JSON Schema is served at its own `$id`:

```powershell
foreach ($kind in 'auto', 'robot', 'field', 'waypoints', 'link') { $url = "https://libraries.horizon36596.org/zenith/schema/v1/$kind.json"; $id = (Invoke-RestMethod $url).'$id'; "$kind $($id -eq $url)" }
```

The npm packages are at the new version:

```powershell
foreach ($name in 'schema', 'core', 'season-biobuzz', 'seasons', 'github', 'cli', 'mcp') { "@horizon36596/zenith-$name $(npm view "@horizon36596/zenith-$name" version)" }
```

The Release has its three files, and the checksums match the downloads:

```powershell
Remove-Item -Recurse -Force "$env:TEMP\zenith-release" -ErrorAction SilentlyContinue; gh release download v0.1.0 --repo Horizon-36596/zenith --dir "$env:TEMP\zenith-release"; if ($?) { Get-Content "$env:TEMP\zenith-release\SHA256SUMS.txt" | ForEach-Object { $hash, $file = $_ -split '  '; "$file $((Get-FileHash -Algorithm SHA256 "$env:TEMP\zenith-release\$file").Hash -eq $hash)" } }
```

The JitPack build log ends in success:

```powershell
(Invoke-WebRequest -UseBasicParsing https://jitpack.io/com/github/Horizon-36596/zenith/v0.1.0/build.log).Content -split "`n" | Select-String 'BUILD SUCCESSFUL', 'FAILED'
```

### 13. Archive the development repository

Once the public repository is the one work goes into. An archived repository is read-only, so do this
after the last change you want in its history.

```powershell
gh repo archive Horizon-36596/zenith-dev --yes
```

### 14. Add Zenith to the library site

The landing page is `index.html` in `Horizon-36596/Horizon-36596.github.io`. Add this card inside
`<main>`, alongside the other library cards:

```html
    <a class="library" href="/zenith/" aria-label="Zenith - read the documentation">
      <h3>Zenith</h3>
      <p>
        Plan an FTC autonomous on the real field, see whether it will work, and run it on the robot
        without editing Java. Draw paths and commands in the editor, on the web or on Windows, or let an
        agent edit the same file over MCP; every change is checked against the field, the game rules
        and the 30 second period.
      </p>
      <div class="meta">
        <span class="tag beta">beta</span>
        <span class="tag">TypeScript + Java</span>
        <span class="tag">MIT</span>
        <span class="tag">com.github.Horizon-36596:zenith</span>
      </div>
      <p class="go">Read the documentation</p>
    </a>
```

Clone it on a branch:

```powershell
gh repo clone Horizon-36596/Horizon-36596.github.io "$env:TEMP\horizon-landing"; if ($?) { Set-Location "$env:TEMP\horizon-landing"; git switch -c add-zenith }
```

Paste the card into `$env:TEMP\horizon-landing\index.html`, then commit and open the pull request:

```powershell
Set-Location "$env:TEMP\horizon-landing"; git commit -am "feat: list Zenith on the library site"; if ($?) { git push -u origin add-zenith; gh pr create --fill }
```

After the merge, <https://libraries.horizon36596.org/> shows the card and its link opens the docs.

## Every later release

1. Move the `[Unreleased]` entries in `CHANGELOG.md` under a new `## [x.y.z] - YYYY-MM-DD` heading and
   add its link at the bottom.
2. Set the version in the root `package.json`, stamp it everywhere and check for drift (see
   [The npm packages](#the-npm-packages)), commit, and let CI go green.
3. Tag and push the tag:

   ```powershell
   $version = (Get-Content package.json -Raw | ConvertFrom-Json).version; git tag "v$version"; if ($?) { git push origin "v$version" }
   ```

4. Do steps 10, 11 and 12 above with the new version.

## Rollback

A published version is never moved or reused. The fix for a bad release is a new patch version; what
follows only limits the damage until it is out.

- **Something private went public.** Make the repository private at once, then fix the snapshot and
  push again. Treat any exposed secret as leaked and revoke it, whatever the history says.

  ```powershell
  gh repo edit Horizon-36596/zenith --visibility private --accept-visibility-change-consequences
  ```

- **The docs site or the web app is broken.** Redeploy the previous good tag from the Actions tab
  (Publish documentation site, Run workflow, pick the tag), or from here. There is no earlier tag for
  v0.1.0; to take the site down instead, turn Pages off (`gh api -X DELETE repos/Horizon-36596/zenith/pages`)
  and redo steps 6 and 7 when fixed.

  ```powershell
  gh workflow run docs-publish.yml --repo Horizon-36596/zenith --ref v0.1.0
  ```

- **The desktop release is bad.** Turn it back into a draft, which hides it and keeps the files:

  ```powershell
  gh release edit v0.1.0 --repo Horizon-36596/zenith --draft
  ```

- **An npm package is bad.** Deprecate the version, so installs warn, and publish a fixed patch.
  `npm unpublish` works only within 72 hours and blocks that version number forever, so it is for a
  leaked secret, not a bug.

  ```powershell
  foreach ($name in 'schema', 'core', 'season-biobuzz', 'seasons', 'github', 'cli', 'mcp') { npm deprecate "@horizon36596/zenith-$name@0.1.0" "Broken release; use 0.1.1." }
  ```

- **The JitPack build failed.** It is cached against the tag. Fix it on a new commit and tag a new
  version, or delete the failed build from the JitPack page (see below).

- **The library card is wrong.** Revert its pull request in the landing repository.

- **Starting the public repository over.** Delete it on GitHub (Settings, Danger zone; `gh repo delete`
  needs the `delete_repo` scope), then rename the development repository back if it is wanted under
  the old name, and begin again at step 1:

  ```powershell
  gh repo unarchive Horizon-36596/zenith-dev --yes; if ($?) { gh repo rename zenith --repo Horizon-36596/zenith-dev --yes }
  ```

## The robot runtime on JitPack

JitPack builds the Java runtime from the tag the first time anyone asks for it, following `jitpack.yml`
(JDK 17, then `./robot/gradlew -p robot :auto-runtime:publishToMavenLocal`). The one artifact holds both
runtimes: the Ivy classes in `org.horizon36596.zenith.ivy`, the SolversLib classes in
`org.horizon36596.zenith.solverslib`, and the shared classes in `org.horizon36596.zenith`. The
`:ivy-runtime` module is not published; it compiles the Ivy side with no SolversLib on its classpath
and runs the Ivy tests. Teams on either library install the same line:

```groovy
implementation 'com.github.Horizon-36596:zenith:v0.1.1'
```

The version is the tag exactly as written, `v` included. JitPack only builds public repositories on its
free tier, so the repository must be public before this works.

### Before the tag

1. Root `package.json` says the version you are about to tag (`"version": "0.1.0"` for `v0.1.0`). The
   Gradle build reads its version from there, so a tag that disagrees publishes a POM with the wrong
   version inside it.

2. Both runtimes build, their tests pass (the SolversLib and conformance tests in `:auto-runtime`, the
   Ivy tests in `:ivy-runtime`) and the artifact publishes locally. This is the command CI's `robot`
   job runs:

   ```powershell
   .\robot\gradlew.bat -p robot build :auto-runtime:publishToMavenLocal :ivy-runtime:testDebugUnitTest
   ```

   It needs JDK 17 on `JAVA_HOME` and the Android SDK (Android Studio's, or `ANDROID_HOME`). The result
   lands in `~\.m2\repository\org\horizon36596\zenith-runtime\<version>\`, one AAR with the classes of
   both runtimes.

3. The `robot` job in CI is green on the commit you are tagging.

### After the tag

1. Push the tag:

   ```powershell
   git tag v0.1.0; if ($?) { git push origin v0.1.0 }
   ```

2. Open <https://jitpack.io/#Horizon-36596/zenith>, find `v0.1.0` in the Releases or Tags list, and
   press **Get it**. That starts the build. It takes a few minutes.

3. Press the **Log** icon next to the tag and read the log to the end. A good build ends with
   `BUILD SUCCESSFUL` and lists the artifacts it found in the local Maven repository: one AAR, its
   sources jar and its POM, all from `org/horizon36596/zenith-runtime`. That one AAR is both runtimes;
   there is no second artifact for Ivy. A red icon means the build failed; the log says why, and nothing is
   served for that tag.

4. Check that the artifact is served under the repository's name:

   ```powershell
   Invoke-WebRequest -UseBasicParsing -Method Head https://jitpack.io/com/github/Horizon-36596/zenith/v0.1.1/zenith-v0.1.1.pom | Select-Object StatusCode
   ```

   `200` means teams can install it. A `404` after a green build means JitPack published it under a
   different name; the log's file list shows which, and `robot/README.md`
   and `site/docs/robot-runtime.md` then need the real
   coordinate.

5. Optional, the real consumer check: in a robot project, add the snippet from `robot/README.md`, sync
   Gradle and build TeamCode.

A failed JitPack build is cached against the tag. After fixing the cause on a new commit, delete the
failed build on the JitPack page (the log view has a delete control for the owner) or tag a new version.

## The npm packages

`.github/workflows/npm-publish.yml` publishes the seven packages on the same `v*` tag, in dependency
order: `@horizon36596/zenith-schema`, `-core`, `-season-biobuzz`, `-seasons`, `-github`, `-cli` and
`-mcp`. Each goes out with an npm provenance statement. The job fails before publishing anything
when the tag does not match the root `package.json` version, and it skips a version npm already has,
so a run that stopped halfway can be re-run.

### Once, before the first release

1. Create the `horizon36596` organization on <https://www.npmjs.com/> (the scope must match
   `@horizon36596`).
2. Create a granular access token with read and write permission on the `@horizon36596` packages, and
   add it to the repository as the Actions secret `NPM_TOKEN` (Settings, Secrets and variables,
   Actions).

### Before the tag

1. The version is stamped everywhere and the drift check passes:

   ```powershell
   node scripts/stamp-version.mjs; if ($?) { node scripts/check-version.mjs }
   ```

2. The packages build, pack and install cleanly. This packs all seven, installs the tarballs into an
   empty folder and runs `zenith --version`, `zenith validate` and a `zenith-mcp` session:

   ```powershell
   pnpm install; if ($?) { pnpm build }; if ($?) { node scripts/smoke-pack.mjs }
   ```

3. Optional: run the workflow by hand from the Actions tab with **publish** unticked. It builds, tests
   and smoke-tests, then prints what it would publish.

### After the tag

1. The tag push starts the **npm publish** workflow. Watch it in the Actions tab.
2. Check that each package is on npm at the new version:

   ```powershell
   npm view @horizon36596/zenith-cli version; npm view @horizon36596/zenith-mcp version
   ```

3. Check the install a team would do, from an empty folder:

   ```powershell
   npx -y @horizon36596/zenith-cli --version
   ```
