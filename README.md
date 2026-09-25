<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/assets/wordmark-dark.svg">
    <img src=".github/assets/wordmark-light.svg" alt="Zenith" height="56">
  </picture>
</h1>

**Plan an FTC autonomous on the real field, see whether it will work, and run it on the robot without
editing Java.**

[![Status: beta](https://img.shields.io/badge/status-beta-f5b94a)](https://libraries.horizon36596.org/zenith/changelog/)
[![Licence: MIT](https://img.shields.io/badge/licence-MIT-6c4a7a)](LICENSE)
[![Docs](https://img.shields.io/badge/docs-libraries.horizon36596.org%2Fzenith-b13848)](https://libraries.horizon36596.org/zenith/)

Zenith is a PathPlanner-style autonomous path planner for FTC. You draw a routine on the field as
paths with headings, attach robot commands to points on those paths, and see at once whether the
robot can do it inside the 30 second period without hitting anything. AI agents edit the same files
through a CLI and an MCP server and get the same checks. Each routine is one readable JSON file in
your robot repository, and a small runtime on the robot plays it through Pedro Pathing v3 and
Ivy or SolversLib, so a new auto needs no Java edit.

![The Zenith editor with the starter example open](site/docs/assets/screenshots/editor-overview.png)

Zenith is in beta. It works end to end, but file formats, command names and the editor layout may
still change before 1.0. Pin the version you use and read the [changelog](CHANGELOG.md) before you
upgrade.

## Start here

| | What it is | Where |
|---|---|---|
| **Desktop** | The Windows app. Opens a robot project folder in place, and adds the high-fidelity sim, deploy, commit and pull request buttons. | [GitHub Releases](https://github.com/Horizon-36596/zenith/releases) |
| **Web** | The same editor in a browser. Nothing to install; the example loads with one click. | [libraries.horizon36596.org/zenith/app/](https://libraries.horizon36596.org/zenith/app/) |
| **Agents** | The `zenith` CLI and the `zenith-mcp` server, for Claude Code or any MCP client. | [Agents and MCP](https://libraries.horizon36596.org/zenith/agents-mcp/) |
| **Robot runtime** | The Java library that plays an auto file on the robot. | [Robot runtime](https://libraries.horizon36596.org/zenith/robot-runtime/) |

The documentation is at **<https://libraries.horizon36596.org/zenith/>**: getting started, the editor
guide, a newcomer's guide to autonomous paths, the file-format reference and the JSON Schemas, the
checks, the sims, the CLI, agents and MCP, seasons and the FAQ.

## Install

The CLI and the MCP server, from npm:

```powershell
npm install --save-dev @horizon36596/zenith-cli @horizon36596/zenith-mcp
```

Or point your MCP client at the server with no install, in `.mcp.json` at your robot repository's
root:

```json
{
  "mcpServers": {
    "zenith": { "command": "npx", "args": ["-y", "@horizon36596/zenith-mcp"] }
  }
}
```

The robot runtime, from JitPack, in `build.dependencies.gradle` at the root of your FTC project. It
runs on Ivy, Pedro Pathing's command library, or on SolversLib; both are first-class, and you declare
the one your robot code uses.

For Ivy:

```groovy
repositories {
    mavenCentral()
    maven { url = 'https://jitpack.io' }                                       // Zenith
    maven { url = 'https://central.sonatype.com/repository/maven-snapshots' }  // Pedro Pathing v3
}

dependencies {
    implementation 'com.pedropathing.ivy:pedro:1.1.1'
    implementation 'com.pedropathing:core:3.0.0-20260828.185437-17'
    implementation 'com.github.Horizon-36596:zenith:v0.1.1'
}
```

For SolversLib:

```groovy
repositories {
    maven { url = 'https://jitpack.io' }                                       // Zenith
    maven { url = 'https://repo.dairy.foundation/releases' }                   // SolversLib
    maven { url = 'https://central.sonatype.com/repository/maven-snapshots' }  // Pedro Pathing v3
}

dependencies {
    implementation 'org.solverslib:core:0.3.6'
    implementation 'com.pedropathing:core:3.0.0-20260828.185437-17'
    implementation 'com.github.Horizon-36596:zenith:v0.1.1'
}
```

Then name the same library in the `deploy` block of `zenith.json`, `"commandLibrary": "ivy"` or
`"commandLibrary": "solverslib"`. Zenith does not pick one, and writes no Java until it is set.
The [robot runtime page](https://libraries.horizon36596.org/zenith/robot-runtime/) covers the Pedro
and command library setup and deploying autos, and
[Choosing a command library](https://libraries.horizon36596.org/zenith/command-libraries/) says how to
choose and how to switch. Horizon (FTC 36596) runs SolversLib on its own robot, so that runtime is the
one the team tests most on a real robot.

## Build it yourself

You need Node 22 and pnpm 10.

```powershell
pnpm install; pnpm build; pnpm test
```

```powershell
pnpm --filter ./apps/web dev
```

[CONTRIBUTING.md](CONTRIBUTING.md) has the checks a change must pass and the rules the code depends
on.

## Licence

MIT, copyright Horizon (FTC 36596). You may use Zenith, change it and share it, including in your own
team's code and in commercial work. Keep the copyright notice and the licence text with any copy you
pass on. The full text is in [LICENSE](LICENSE).

## Credits

- The BIOBUZZ field images are by **Team Juice 16236**, from their r/FTC post "BIOBUZZ custom field
  images (MeepMeep compatible)".
- The bundled fonts are Jost, IBM Plex Sans and JetBrains Mono, each under the SIL Open Font Licence
  1.1.
- Robot following is Pedro Pathing v3, and commands are Ivy, Pedro Pathing's command library, or
  SolversLib.

[NOTICE](NOTICE) lists every third-party credit and licence.

Zenith is built by Horizon (FTC 36596).
