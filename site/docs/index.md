# Zenith

**Plan an FTC autonomous on the real field, see whether it will work, and run it on the robot without editing Java.**

Zenith is an autonomous path planner for FTC. People draw and edit routines in the editor, and AI agents edit the same files from the command line or over MCP, so both work on one plan and get the same checks. It is built by Horizon (FTC 36596).

![The Zenith editor](assets/screenshots/editor-overview.png)

*The editor with the starter example open: the steps on the left, the field in the middle, the inspector on the right and the problems panel below the field.*

!!! warning "Status: beta"
    Zenith works end to end: draw, check, preview, save and run. File formats, command names and the
    editor layout may still change before 1.0. Pin the version you use, and read the
    [changelog](changelog.md) before you upgrade.

## What it does

- **Draw routines on the field.** Paths, headings, curves and robot commands, in the robot's own coordinate frame, with the robot drawn at its real size, intakes included.
- **Check them while you edit.** Every change is checked against the field walls, field elements, season rules, autonomous period and the robot dimensions and motion limits in your files. Problems appear as plain sentences, and many have a one-click fix.
- **Preview them.** The built-in simulator plays the routine on the field as you edit. Use it to inspect the plan, then compare with your robot repository's full sim and a real robot run.
- **Run them on the robot.** Each routine is one readable JSON file. The Zenith runtime on the robot reads the file and builds the routine at init, with Ivy or SolversLib commands, whichever your robot code uses, so a changed auto needs no Java edits. See [Choosing a command library](command-libraries.md).
- **Share and review.** Autos live in your robot repository, so they are diffed, reviewed and merged like any other code.
- **Plan with your alliance partner.** Load a partner's file next to your auto to see both robots on one field and one clock, with predicted collisions and one-click fixes, and suggest changes back as a file. [Alliance partners](alliance-partners.md)
- **Bring paths from other planners.** Pedro Pathing Visualizer projects, RoadRunner through MeepMeep, and two documented interchange files. [Bring paths from other planners](import.md)

## Start here

### Desktop

Download the Windows installer from GitHub Releases and open a robot project folder directly. The desktop app adds a few actions the browser cannot do, such as running your robot repository's own simulator. [Install the desktop app](getting-started.md#install-the-desktop-app).

### Web

Open the web app in your browser at [zenith.horizon36596.org](https://zenith.horizon36596.org/). There is nothing to install, and the bundled example loads with one click. [Open the web app](getting-started.md#open-the-web-app).

### Agents

Use Zenith from Claude Code or any MCP client. The CLI and the MCP server create, edit, validate, render and simulate the same auto files the editor saves, and return every finding as structured data. [Agents and MCP](agents-mcp.md).

## New to autonomous paths?

[Autonomous paths, explained](paths-explained.md) covers poses, headings, curves, commands and markers from the beginning, using the BIOBUZZ field as the example. Then [Getting started](getting-started.md) walks you through planning a first auto in ten steps.

## Works with SimLoop

[SimLoop](https://libraries.horizon36596.org/simloop/) is Horizon's library for running FTC robot code on a laptop. Zenith's high-fidelity sim runs your robot repository's own headless sim, and a SimLoop setup can be that sim. Zenith does not depend on SimLoop, and nothing in Zenith needs it to plan, check or preview an auto. [Full sim with SimLoop](full-sim-simloop.md) sets the two up together, and the [SimLoop docs](https://libraries.horizon36596.org/simloop/) cover SimLoop itself.

## Licence

Zenith is released under the MIT licence, copyright Horizon (FTC 36596). You may use it, change it and share it, including in your own team's code and in commercial work. Keep the copyright notice and the licence text with any copy you pass on.

The bundled fonts are under the SIL Open Font Licence. The `NOTICE` file in the repository lists every third-party credit.
