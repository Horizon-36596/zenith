# Changelog

All notable changes to Zenith are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Before 1.0.0, a minor version may change
the file format; every such change ships a migration.

## [Unreleased]

## [0.1.2] - 2026-10-26

### Changed

- **GitHub mode signs in with GitHub.** The sign-in dialog opens on **Sign in with GitHub**: a GitHub
  window in the web app, a short code in the desktop app, and no token to make. It reaches every
  repository your account can, and the dialog says so. Pasting a fine-grained token stays, for access
  to one repository only.
- In the web app, **Remember the sign-in** can now keep you signed in to GitHub in this browser until
  you sign out, so reopening Zenith does not ask again. Until this tab closes stays the default.

- **Accounts, teams and sharing are on in public releases.** The web app on the docs site and the desktop app are built with Zenith's cloud and App Check, and the encryption's source is public. See "Accounts, teams and sharing" below.
- **The web app has its own address.** Links that send people to the web app (the README, the docs, and share and invite links made in the desktop app) now point at <https://zenith.horizon36596.org/>. The copy under <https://libraries.horizon36596.org/zenith/app/> keeps working.
- `zenith` exits 2 for an unknown option, a bad flag value or a missing argument, as the exit-code table
  says. It used to exit 1, the code for a failed check.
- In the desktop app, the GitHub sign-in box reads "Remember on this computer". Ticked, the token is kept
  encrypted until you sign out, so the old "Remember until Zenith closes" understated how long it lasts.
- The shortcut sheet has a Close button with a tooltip, and no longer leaves blank space under its lists.
- Dialogs open near the top of the window, so one that grows (Open another project) no longer moves its title.
- Dialog titles use the same weight as the sheets' titles.
- The status line's close is an X with a tooltip, like every other close.
- The time stamps in the Library and Teams sheets show their full date in the standard tooltip.
- The invite expiry notice has one close when it lists one line, and names the invite by its role.
- An admin invite always waits for an owner or admin to approve whoever opens it: **Approve
  automatically** is off for the admin role, and the cloud refuses it, so a leaked admin link alone
  never lets anyone in.
- The import and expiry notices stand beside the desktop panel instead of over it.
- Team safety codes and device verification codes are 20 digits in five groups of four, from a slow
  hash, so a server can no longer make a key of its own that shows a real team's code. Every code
  shown before changes once; pins are kept.
- After a member leaves or a device is taken off, nothing new is published, shared or proposed until
  an owner or admin makes a new team key, and the status line says so. A device works out that a key
  change is due from the team's device list, not only from the database's mark.
- The database rules keep an admin from deleting every device's team key or replacing the recovery
  record's key without a key change.
- A share manifest that does not name its projection, from before 2026-10-11, is refused.

### Upgrading from 0.1.1

- **The documentation site counts page views** (no cookies). The docs at libraries.horizon36596.org/zenith/ count page views with GoatCounter: the page and its title, the referring site, browser, operating system, screen size and country, with no cookies. Only Horizon's own few lines run on the page and send one request to GoatCounter; no third-party script is loaded, because the docs share an origin with the web editor at /zenith/app/. The privacy notice says so in a new section, This documentation site. The app, the desktop app and the CLI stay free of analytics. Counts go to horizon36596.goatcounter.com, and only from libraries.horizon36596.org.
- **Full sim with SimLoop** (#207 reversed, owner ruling 2026-10-14). A new docs page, [Full sim with SimLoop](https://libraries.horizon36596.org/zenith/full-sim-simloop/), sets up the high-fidelity sim with SimLoop, Horizon's library for running FTC robot code on a laptop, step by step from its starter folder. The README and the docs home gain a short Works with SimLoop section. The high-fidelity sim, Simulate (`F5`), loading a trace file and the Full sim playback level stay as they were in 0.1.1; they were hidden from the private beta for a week and are on again. Zenith does not depend on SimLoop.
- **The Inspector is one calm panel** (#431). A selection header (the kind's icon, the id, the estimate such as `4.12 s`, the `?`) replaces the "Inspector" title, and sections such as PATHS, HEADING, SPEED, MARKERS, ADVANCED and NOTES sit under small uppercase headers with hairlines between them, a count on a list, a summary and a dot when folded (lemon when something inside needs a look), and their one action, such as + Add path to chain, + Add marker or the Switch to Linear pencil, at the header's right. Every row is on one grid, labels at 24 px and values at 120 px, and a value still at its default is drawn quieter. A chain's paths are groups inside PATHS, a curve's control points sit behind Controls, an end shows its waypoint's pose only while it is selected, piecewise ranges are one numbered row each that opens to its rows ("follows the path" for a range the path decides), Give up after is the one name for a time limit and a path's is in Speed beside Stop early, notes are a folded section, a marker's header is a `collectFlower › Marker 1` breadcrumb, a group's members are a STEPS list with a flag on the one that ends it, and a selected waypoint has its own section above the list, whose Pins choice shares the column heads' line. Bins, eyes and menus in lists show on hover or focus. With descriptions on, the words the icons stand for are written out.
- **The field's tile seams show the tiles' interlocking tabs** (#428). Every seam inside the wall is drawn with the dovetail edge of FIRST's am-2499 soft tiles, as FIRST's BIOBUZZ field CAD has it: 8 whole tabs each way on every tile edge, 0.81 in deep, repeating every 2.37 in, in both themes and wherever the field's seams are drawn; zoomed so far out that a tab would be under 2 px, the seams are the straight lines of before.
- **Inspector rows, the Waypoints list and the command palette read more plainly** (#410). Every angle shows wrapped to between -180° and 180° with one decimal and the degree sign tight against it, so a heading stored as -180° reads `180.0°` beside the other `180.0°`, and a typed 270 is still written as 270. An empty timeout reads `none`, not `none s`. A section's `?` shows only on a header hover or focus. Piecewise ranges speak in percent of the path (`Range 1`, `Ends at 20%`, `0%` to `100%`), and a track block too narrow for its name shows none. Command arguments read `Count`, not `count`, and More's envelope row is **Stay-inside box (for partners)** with **Draw box** and **Add 24 in box**. The Waypoints title is `Waypoints (9)`, **Pins** is a labelled row, the list has an `x y heading` line, long names cut in the middle, the pencil and bin are gone from the selected row (the **⋯** menu has them), and Save as waypoint is offered only on a pose of its own. The palette keeps its first row active under a resting pointer, ranks name matches before summary matches, finds steps, says why a row cannot run, and leads with the Recent actions.
- **Update the robot runtime with the editor.** This release saves every auto as auto
  `formatVersion` 4 (it adds the transfer step) and every field file as field `formatVersion` 3 (it
  adds the slanted `strut` obstacle). The 0.1.1 robot runtime reads autos up to version 3, so an auto
  saved by this release fails at init on a robot still on the 0.1.1 runtime, with a message that it
  is formatVersion 4. Before you deploy autos saved with this release, change the robot's JitPack
  line, `com.github.Horizon-36596:zenith:v<version>`, to the runtime of the same version as the
  editor. Older autos still load and are saved as version 4; 0.1.1 and older Zenith editors and
  CLIs cannot open the new files.
- **Copy the new BIOBUZZ field file.** The season's field file now has the hive frame's four
  slanted legs and its foot bars where FIRST's field CAD puts them. A team's own copy of
  `biobuzz.field.json` keeps the old frame until it copies the new one.
- **Path speeds now come from `robot.json` on the robot.** `ZenithRobot.defaultSpeedFraction()` reads
  `kinematics.defaultPathSpeedFraction` from the deployed `robot.json` instead of returning 1.0. A
  robot that overrides it is unchanged.
- **`zenith sim --json`** now prints only the JSON report on stdout; the sim's own output, such as
  Gradle's lines, goes to stderr.

### Added

- **A new auto made from DSIM starts where DSIM's robot starts** (sweep W4-7, decision O5). Host mode's `open` gains an optional `newAutoStart`, an alliance and a pose: the start the person picked in the host. A new auto made in that session, from the host's New in Zenith or from the auto picker, starts there (mirrored onto the field's own alliance when the host's robot plays the other one) instead of at a `start` waypoint or a legal start Zenith finds. Its provenance says it was picked in the host. A host that leaves it out gets the behaviour it had before, and a Zenith from before it ignores it. [Host mode](https://libraries.horizon36596.org/zenith/host-protocol/) describes it.
- **Export an auto as an OpMode you own, not recommended** (#535). `zenith codegen --export <auto>` writes `<Name>Exported.java`, and the Code tab's new **Export** switch shows and copies the same class: a concrete `@Autonomous` OpMode that reads no auto file, with its alliance, start pose and default path speed written into `loadSpec()` and the routine written out step by step. Paste it into TeamCode and add whatever the auto file cannot hold, such as logging or vision. Zenith stops tracking the routine once it is exported, so a change made there is not in the auto file, the editor, its checks or its sim; the class, the CLI and the tab all say so. It refuses without `deploy.robotClass`, because the OpMode constructs the robot. The robot runtime gains `AutoFromFile.loadSpec()` and an in-code spec (`AutoSpec.inCode` for SolversLib, `AutoFile.inCode` for Ivy) that reads no file, and the conformance suite runs both exported starter classes against the routine built from the file, on both alliances.
- **`ZenithRobot` can run your code around the routine** (#532). Four new default methods, with the same names in the SolversLib and Ivy runtimes: `onStart` once at start, before the routine is scheduled; `periodic` before the scheduler on every loop (new on SolversLib; Ivy already had it); `afterLoop` after the scheduler on every loop; and `onStop` once when the OpMode stops, however it stops, a failure at init or at start included, whenever your robot was created. The scheduler is still reset if `onStop` throws. They are the place for a match log that opens at the whistle and closes at the end.
- **`deploy.opModeBase` lets generated OpModes extend your own class** (#533). Name an abstract subclass of your library's `AutoFromFile`, fully qualified, and every stub `zenith deploy` writes extends it instead, so a team's own logging, telemetry or start-up applies to every Zenith auto without giving up the generated OpModes. It is optional, so `zenith.json` stays at `formatVersion` 1.
- **Share presets with your whole team through the project** (#484, owner ruling 2026-10-21). In Settings, Presets, **Add to project** on one of your presets writes it to `autos/presets/<name>.zenith-preset.json` in the open folder, in the browser or the desktop app, so the team gets it with the autos. Everyone who opens the project sees it under **This project's presets** and can **Apply** it with the usual asks; applying keeps a copy in Your presets marked "From this project.", and applying again after the file changed updates that copy rather than adding another. **Update in project** asks before it replaces a different file. GitHub mode lists a repository's presets and does not write them. Nobody's settings change until they apply a preset, and `zenith validate` and `zenith deploy` ignore the folder.
- **A command that drives the robot by itself drifts to its rejoin pose, as a ghost, and an envelope can preview a shorter run** (#481). When the path after a `movesRobot` command has a rejoin pose, the Ideal playback and the Instant sim both move the robot from where the command starts to that pose within the command's own time, eased from rest to rest, so the path starts there with no transition: on the vision-collect demo the Ideal total is now the estimate's 12.91 s instead of 14.15 s, and the Instant sim's robot reaches the rejoin pose instead of driving back from where it parked (12.37 s, was 11.79 s), which a partner's projection now shows moving inside the envelope. While such a command runs, your robot is drawn in the partner style in a new canvas colour, `--canvas-unknown` (iris, `#9695FF`), labelled "Ideal · position unknown" (or the level it is at), and its envelope is hatched in that colour while its window is open. An envelope gains an optional `actualDurationS`, over 0 and at most `maxDurationS`, that the estimate, the timeline, the Ideal playback and the Instant sim time the step by instead, to preview a faster or failed run; a projection keeps `maxDurationS`. The Stay-inside box has an **Actual** row for it with the Ledger switch (one the file sets always shows), and the header and the timeline read it as `what-if`. The key is optional and planner-only, so the auto stays at `formatVersion` 4, and the robot runtime reads past it. `zenith.edit.setEnvelope` takes it too.
- **Full sim speed: Basic, Fast and Ultrafast.** In the desktop app, Settings, General has **Full sim speed**. Basic runs `sim.command` for every run, as before. Fast (the default) starts a sim server on the first run, keeps it for 10 minutes after the last one, and plays each run at the Full sim level while it is simulated: the timeline says Simulating and the playhead waits at the last time received. Ultrafast starts the server with the project and runs an auto again in the background shortly after it is saved, so the next run of an unchanged auto plays at once. The server is the new optional `sim.server` section of `zenith.json` (`prepare`, `args`, `cwd`, `watch`; `zenith.json` stays at `formatVersion` 1), started as `java @<args>` and spoken to over its standard input and output with protocol 1. A project without it runs Basic, and the setting says so; any server failure runs that click as Basic and says why. [Full sim with SimLoop](https://libraries.horizon36596.org/zenith/full-sim-simloop/#full-sim-speed) describes the speeds, their cost and the keys.
- **The robot runtime's trace writer records contacts, the ledger and events.** `AutoTraceWriter`, for both SolversLib and Ivy, gains `structureContact(obstacle, penetrationIn)`, `ledger()` (a row to fill with `held`, `launches` and `tips(alliance, count)`, leaving out what is not set), `event(kind)` and `event(kind, alliance)`, each stamped with the time of the last `tick`, and `sha(commit)`. Until now it wrote those sections empty, so a headless sim had no way to fill them and `zenith sim` always called the contact and ledger checks inert. Recording one adds its capability, and the new constants `AutoTrace.STRUCTURE_CONTACTS`, `LEDGER` and `EVENTS` let a sim declare a check before the run, so a clean run reads as checked. The trace format stays at version 1, and a trace that records none of them is byte for byte what it was. [The trace](https://libraries.horizon36596.org/zenith/simulation/#the-trace) and [Full sim with SimLoop](https://libraries.horizon36596.org/zenith/full-sim-simloop/) show how.
- **Optimize path offers the turn onto the path, and takes heading holds** (#448). A route the estimate has faster and the instant sim slower, such as turning onto a long diagonal drive, driving it nose first and turning back, is now offered as an alternative labelled "Faster in the estimate, slower in the instant sim", never as the pick; and **Hold start heading** and **Hold end heading** (inches, 0 off, remembered in the card and Settings, `--hold-start-in` and `--hold-end-in` on `zenith optimize`, `holdStartHeadingIn` and `holdEndHeadingIn` on `zenith.optimize`) keep the start heading over the first N inches of the route's arc length and reach and keep the end heading over the last N inches, in every route offered, enforced by the final check.
- **New paths start at the previous path's end heading, and a new auto's first path uses your default heading** (#435). A new auto's starter path is no longer always Tangent: it takes **Heading for new paths** (Linear unless you chose another). A new setting under Settings, Editor, Editing, **Start a new path with the previous path's end heading**, on in every preset, makes every new path (the Add path tool, Add a path here, Insert, Extend this chain, Add a clear path here and a new auto) start at the heading the robot has where the step before it ends, and a Linear one end there too until you change it; off, Linear paths turn to the way they drive as before. Tangent is unaffected, and no file format changes.
- **Settings has a search** (#430). A box under the title filters every section's rows at once by name, description and the names of their choices, marks the words that matched, shows each match under its section with a count in the list, and says when nothing matches; `Enter` opens the first match, `Ctrl F` focuses the box, and `Esc` empties it before it closes the window.
- **Settings, the first run and the dialogs say one clear thing each** (#414). Settings, General keeps only your own switches, and the command library and pathing system are in Robot under Follower. Presets shows one "Using Basic (edited)" line, a check and In use on the preset in use, and Duplicate in a row menu. Editor ends with Toolbar buttons as one row of icon toggles, and Protect measured waypoints is On and Off. Robot puts the provenance on the value's line, counts the placeholders and the values that need measuring, and the clearance reads 1 in (default) with a Change button. Closing Settings with an unsaved robot.json asks Save robot.json, Discard or Keep editing, and Esc closes a form or a question inside Settings first. Keyboard is a key chip on each row. The shortcut sheet has a Keys and a Mouse tab and opens on the sheet. The preset card and the tour say what you get, and the last tour stop says Finish. The welcome screen is one sentence and two buttons, a project with no autos offers New auto, and Open project leads with the open project's autos. Save the example is one line for each choice, and Set up has the command library as a three-way choice.
- **Crossing the centre line in auto is an error** (#365). `OPPONENT_SIDE` reports, as an error cited to G402 (BIOBUZZ Competition Manual V1, §11.4.1), any path, turn on the spot or standing step where the robot's footprint or an intake mouth goes past the centre line into the other alliance's side by more than the 0.05 in `START_ILLEGAL` already allows, using the same line and the auto's own alliance; the editor tints the stretch and draws a clip ghost, `zenith validate` and the MCP server report it, it offers Route around the centre line, and the optimizer treats the other side as a keep-out. The starter's routes went under the hive over the line, so they now go round the west of the hive frame, with the start and scoring spots 4 in clear of it.
- **Optimize path is easy to find, and Optimize every path** (#366). The toolbar has an Optimize button next to Undo and Redo, with its own Settings, Editor, Toolbar switch, and the field's right-click menu on a path and a step row's menu have **Optimize path**. **Optimize every path** (the palette, or a right-click on the toolbar button) runs it on every path step in turn, lists each result and the total time saved, and applies the ticked ones as one undo step. All of it is off with the Optimize path switch, as in Basic.
- **Add a clear path to here, and the Optimize card's alternatives** (#310, spec 16 Phase 2). Right-clicking an empty field point offers **Add a clear path to here**, which opens the Optimize card in Route around mode on a new path from where the robot is to the point, or, with Extend this chain on, on more paths of the selected chain (refused before the run, with a sentence, when that chain is in a parallel group); the path ends on the heading for new paths, or facing the season's target where the point is a legal approach to it (core's `legalApproachEnd`). Apply adds the route the card shows in one undo step, and the straight path when it is already clear. The card steps through the pick and up to two alternatives, each of which passed the final check, and core now lists the alternatives that go round some obstacle another way first, putting up to three seeds of a way round the search's starts missed through the final check (`optimize/homotopy.ts`). With the Optimize path switch off the item is gone.
- **Route around and Find a faster heading** (#309, spec 16 section 8.3). On a path step, `STRUCTURE`, `CLEARANCE`, `PERIMETER` and `KEEPOUT` now offer **Route around** the obstacle (the season's words for it), the field wall or the keep-out zone, and `STRAFE_FRACTION` offers **Find a faster heading**. Both are the `optimizeRoute` fix, which writes nothing: the button selects the step, opens the Optimize card on it and runs at once, the second with the path's segments kept exactly as written (`headingOnly`). The optimizer gains the option `routeAround`, which accepts a route that clears every structure, keep-out and the wall whatever its time when the original collides, and is refused with `headingOnly`. `check()` still never runs the optimizer, and with the Optimize path switch off neither button shows.
- **The Optimize card** (#308, spec 16 section 8.1). Optimize path now starts from the wand in a path chain's Step header or from the palette's **Optimize path** and **Optimize path with options…**, which have no default key. A card docked over the Inspector shows the margin (the robot's clearance until changed, for that run only, re-running 300 ms after a change), Score with, Allow several paths and Allow heading ranges, then the run's progress with Stop and Continue, then the result: the step's time before and after in the instant sim and the estimate, the closest clearance, the markers that move, the findings removed and added, and the change sentences. The field draws the proposed route dashed in `--path-candidate` with dots at its joints and nothing to press, moves the one robot outline onto it under the pointer, outlines the margin round the structures it passes near, and draws an infeasible run's closest attempt as one clip ghost. **Apply** (Enter) writes the route with `setRoute` as one undo step and says "Optimized toOtherSide: 2.59 s → 2.48 s (instant sim)."; **Discard** (Esc) leaves the auto the same object; an edit while the card is open marks its result stale. With the Optimize path switch off the wand, both palette commands and a finding's `optimizeRoute` action are gone: a switch's gates may now list fix kinds.
- **The Optimize path worker and its host** (#306). The editor gains `src/optimize/host.ts`, which runs one optimizer run in a module Web Worker (`src/optimize/worker.ts`, built into its own chunk for the beta, Pages and the desktop app) and, where no Worker can be built or the worker fails to load, the same driver on the page in short slices on `setTimeout`, with the same result. Stop asks the generator for a snapshot through the new `{ snapshot: true }` command, which gives the `stoppedEarly` result a stop would and pauses there, so Continue ends on the same result as a run that was never stopped; the 5 s safety stop does the same; an edit to the auto, the robot, the field or the waypoints cancels the run without touching the document; and a worker that does not answer Stop within 3 s is ended. Nothing in the editor starts a run yet; the Optimize card builds on it.
- **The Optimize path switch, its settings and the candidate colour** (#305, spec 16). **Optimize path** is a feature switch in Settings, General (`features.optimizer`), off in the Basic preset and on in Essential and Full, kept as stored and falling back to on for anything else. While it is on, Settings, Editor shows an **Optimize path** group with the robot's **Safety margin** (read only: the margin is `footprint.clearanceIn` in `robot.json`, never a person's setting) and the card's remembered options, **Score with** (instant sim by default), **Allow several paths** and **Allow heading ranges**; Settings, Robot's clearance row now says Pedro's follower may drift up to 2.5 in, so Optimize path also checks the instant sim's own motion. The `--path-candidate` token (grass green, with a darker ink over a light field picture) is defined, with its UI_GUIDE entry and contrast rows, for the preview the Optimize card will draw.
- **Optimize path's structural moves** (#307). Core gains `optimize/moves.ts`, and the search now tries six moves, in a fixed order, where its continuous passes stall: split a path at its arc-length midpoint by de Casteljau, merge two paths into one cubic fitted by least squares, step a path's degree up or down, split a linear heading range at the heading it already has there, merge two ranges, and change a range's mode with the knots re-pinned. Each move is followed by a continuous pass of its own and kept only when that ends strictly lower in J, so a route can now gain or lose paths and heading ranges during the search, never past `maxPaths`. A split, a range split and a step up in degree leave the estimate unchanged until the next pass moves something (D3); under the instant sim a path split costs the time the follower takes to hand over at the new joint, so it is kept only when what follows wins that back. The moves run after every continuous pass, so a budget that runs out among them never leaves the search worse than without them, and the final check no longer spends its limit on routes of one start, with as many paths, that are a hair apart and refused for the same shortfall.
#### Editor

- **Optimize path.** Finds a faster route for a path step, or a clear one for a path that runs into
  something. Start it from the toolbar's Optimize button, a path's right-click menu, a step's menu,
  the palette (**Optimize path** and **Optimize path with options…**) or a finding's **Route
  around** or **Find a faster heading** button. A card over the Inspector sets the margin (the
  robot's clearance unless you change it for that run), **Score with** (instant sim by default),
  **Allow several paths** and **Allow heading ranges**, shows progress with Stop and Search longer,
  then the result: the time before and after in the instant sim and the estimate, the closest
  clearance, the markers that move, the findings it clears and adds, and up to two alternatives. The
  field draws the proposed route dashed in green. **Apply** (Enter) writes it as one undo step;
  **Discard** (Esc) leaves the auto as it was; an edit while the card is open marks its result
  stale. The search can split and merge paths, change a path's degree and add or merge heading
  ranges, and every route it offers keeps both ends, every marker and every kept key, passes the
  whole auto's checks and a swept clearance test on the plan and on the instant sim's motion. It
  runs in the background and stops itself after 5 s; on the example a run takes 1 to 3 s. A path that goes
  through a structure, past the wall, into a keep-out or over the centre line gets the fastest clear
  route found, even a slower one, with a sentence saying what the original goes through; a route
  faster in one model and slower in the other is offered only as a labelled alternative. Every pose
  it places is labelled `SET FROM EDITOR: placed by Optimize path`. **Optimize every path** runs it
  on each path step in turn and applies the ticked results as one undo step. Settings, General has
  an **Optimize path** switch, off in the Basic preset.
- **Add a clear path to here.** Right-clicking an empty field point opens Optimize path on a new
  path from where the robot is to that point, ending on the heading for new paths, or facing the
  season's target where the point is a legal approach to it. With Extend this chain on, it adds the
  paths to the selected chain.
- **Turn on the spot.** The Insert menu and a path's right-click menu add a turn where the selected
  step ends, with one draggable end arrow. The runtime holds a path step of 2 in or less at its end
  pose until the heading is within 2° and the robot within 0.5 in, or the robot has stayed still for
  0.25 s within 10° and 2 in, so every turn ends; a new turn gets a timeout of a half turn's estimate
  plus 1.5 s. The plan, the estimate, the playback levels and the checks model it.
- **Path chains grow, shrink and join.** The Inspector has Add path to chain and Remove this path;
  `Del` on one selected point removes that point and joins its two paths. The Add path tool's
  **Extend this chain** toggle adds a click's path to the selected chain instead of a new step.
  **Join with next path** on the step menu makes two following path steps one chain, refused with
  the reason when their speed, end condition or timeout differ. Markers and heading ranges keep
  their distance along the unchanged part.
- **Waypoints in the editor.** Drag a waypoint pin, or select it and use the arrow keys and Turn (`R`):
  every point that follows it moves with it, and its provenance becomes SET FROM EDITOR. Add one
  with **Add waypoint here** on the field's right-click menu, the Waypoints list's **+**, the palette,
  or **Save as waypoint…** on the start or a path end. Rename (double-click or `F2`) and Delete
  (`Del`, after a dialog) say first which autos follow it; a pin's right-click menu also has Copy
  position, Select the points that follow it and Zoom to it. Save writes `waypoints.json` in canonical
  form before the auto. Moving a waypoint other autos use names the autos it breaks, in the
  Inspector, on the status line and when you save. **Protect measured waypoints** (on in every
  preset) makes the first press on a MEASURED or CALIBRATED FROM ROBOT pin only select it. Waypoint
  editing is off, with a sentence saying why, where the project cannot write `waypoints.json`.
- **Waypoint pins on the field.** **Waypoint pins** (Settings, Editor, Field; the field's
  right-click menu; the palette) shows all pins, the ones the open auto uses (the default in Basic
  and Essential) or none, and an eye on each pin's row overrides it for that pin. A hidden pin is not
  drawn, hit or snapped onto, and hiding never changes a file. Pin names are drawn in the waypoint
  colour and never overlap, and waypoints have a flag icon. The Waypoints `?` help, a tour stop and
  the docs explain what a waypoint is.
- **The Waypoints list.** One compact list of 24 px rows, with an eye, the name, and x, y and heading
  typed in place, leads with the open auto's waypoints and keeps the rest under "Other waypoints".
  With nothing selected the Inspector shows the Routine view: the start and this list.
- **A Settings window.** The gear, `Ctrl ,` or the palette opens one window with Presets, General,
  Robot, Commands, Editor and Keyboard, and a search box that filters every row by name, description
  and choice (`Ctrl F` focuses it, `Enter` opens the first match). Closing it with an unsaved
  `robot.json` asks Save, Discard or Keep editing.
- **Robot and Commands settings.** Robot shows and edits the open project's `robot.json`: size,
  speeds, drivetrain, follower, intakes and game pieces, each with its unit and provenance, with the
  values that still need measuring counted. Commands lists, adds, edits and removes the robot's
  commands and their arguments, and imports them from Java. A folder project and the desktop app
  save in place; other projects show the values read only, with the reason.
- **Feature switches and presets.** Settings, General has switches for Commands, Partner sharing,
  Ledger and ball counting, Step groups, Waypoints, Advanced heading, the Code tab and Optimize path.
  They are yours, kept on this computer and never written into a project. Off takes the feature out
  of the whole editor (panels, buttons, palette rows, keys, insert kinds, field drawing, problems,
  tour stops, help), while a file that already uses it still shows, edits and saves unchanged. A
  palette search lists a hidden action last, under "Off in your settings", and opens its switch; the
  Problems panel ends with "N more problems in hidden features." and **Show**. Settings, Presets
  names the preset your settings came from (Basic, Essential or Full) and what you changed since,
  with Revert, and lets you save, rename, export and import presets of your own (`.zenith-preset.json`,
  at most 64 KB). A first visit asks which preset to start with, and Help, **Choose a preset…** opens
  Presets again. One damaged setting no longer resets the rest.
- **Your own keys.** Settings, Keyboard lets every action with a key, and seven without one, take a
  key of your own, including Turn, Step back, Step forward and Next panel. A key another action has
  asks to move it; keys the browser, the system, the desktop app or Zenith reserve are refused with
  the reason. Tooltips, the palette, the tour, the shortcut sheet and the desktop app's menu show
  your keys. Nudge, Far nudge, Rotate and Playhead step distances are settings too, in Settings,
  Editor, Editing.
- **Heading for new paths.** Settings, Editor chooses Tangent, Linear (the default) or Constant for a
  new path, and **Start a new path with the previous path's end heading** (on in every preset) makes
  every new path, a new auto's first path included, start at the heading the robot has where the
  step before it ends.
- **A Code tab beside Problems.** It shows the Java `zenith codegen` writes for the open auto, read
  only, and updates as you edit. Copy puts the class on the clipboard, the selected step's lines are
  highlighted, and clicking a step's code selects that step. When the auto has errors, or the
  project names no command library, it says so in one line.
- **Set up Zenith in a robot repository.** Opening a folder with no `zenith.json` offers Set up,
  which reads TeamCode, fills in the robot class and command library where it can tell, and writes
  `zenith.json`, `robot.json` with the commands the code registers, `waypoints.json`, the season's
  field and one auto, never over a file.
- **New auto in the web editor.** The palette and the Open project dialog start a blank auto in the
  open project; Save writes it into the project, or downloads it from a read-only project.
- **Save the example as a full project or just the auto.** Save on the read-only example asks one
  question: write `zenith.json`, the robot, the field, the waypoints and every auto into an empty
  folder (or a zip) and open it, or put just this auto into a project you already have, checking that
  project's waypoints first.
- **Play from here, and the running steps light up.** Right-click a step and choose Play from here
  to play on from where it starts. While the robot plays or you scrub, the Steps panel highlights
  every step running at the playhead, the groups it sits in included.
- **The BIOBUZZ field is drawn by the editor.** Tiles (with the soft tiles' interlocking tab seams),
  the wall, each alliance's loading zone, garden and alliance area, the flowers and the hives come
  from the season geometry, so what you see is what the checks use. The hives move with playback:
  which cell is up, the pieces in it, and a tip as a swing of about 4 s. The field picture no longer
  ships; a field file of your own can still name one.
- **Pollen and nectar counts on the field.** With the Ledger on, each place that holds pieces has a
  small chip with its pollen and nectar, and one above the robot says what it carries at the
  playhead.
- **Clip ghosts.** Where a path leaves the field, runs into a structure or enters a keep-out zone,
  the field shows a translucent red robot at the worst point. Pointing at a problem emphasises its
  ghost, and clicking it selects the step. **Clip ghosts** in the Problems header or the palette hides
  them.
- **Download a picture of the auto.** **Download picture (PNG)** and **(SVG)** in the palette save
  the picture `zenith render` writes.
- **Undo and Redo in the toolbar, and tooltips on touch.** Holding a control for half a second on a
  touch screen opens its tooltip, and a tap on a disabled button shows why it is disabled.
- **Mouse back and forward buttons**, and `Alt + ←` and `Alt + →`, move between the autos, pages and
  dialogs you had open. Going back never undoes an edit.
- **Row hints and descriptions.** A long hover, a touch hold or `Shift F1` on a row's label opens its
  hint. Settings, Editor, Appearance, **Descriptions** adds a one-line brief under each row. A pinned
  `?` tip links to the part of the docs that covers it, and a book button opens the docs.
- **Set a value's provenance by hand.** The provenance chip beside a pose, a control point, the
  start, an envelope or a rejoin pose opens a menu of the labels, with a note after the label
  (`MEASURED: tape, 2026-09-30`). Typing a number over a MEASURED or CALIBRATED FROM ROBOT value
  says it relabels it SET FROM EDITOR.
- **The start pose can be dragged and turned on the field**, with the same snapping as a path point,
  and a start or path point that follows a waypoint gets a pose of its own where it is dropped; one
  undo links it again.
- **Move the start to the nearest legal spot.** A START_ILLEGAL problem offers a fix that tries the
  nearest legal starts against the whole auto and takes the first that adds no new error. Its pose
  says Zenith found it, so it still needs checking on the real field.
- **Report a bug.** Help, Report a bug asks what happened and shows everything the report carries
  (app version, browser and system, window size, the open file's problems, recent action ids, and a
  snapshot of the auto only if you tick it). With accounts off, Copy report puts it on the clipboard.
  No name, email, team or key is ever included.
- **A resizable Ledger panel**, whose height is remembered.
- **Beta notice.** The first time each version opens, a short note says Zenith is in beta and has
  been tested mostly by Horizon (FTC 36596), and where to report a bug. **Got it** or `Esc` closes it
  for that version; when the browser blocks site storage it shows on every load.

#### Seasons, checks and the sim

- **Crossing the centre line in auto is an error.** `OPPONENT_SIDE` reports, cited to G402, any
  path, turn or standing step where the robot or an intake mouth goes past the centre line into the
  other alliance's side by more than 0.05 in. The editor tints the stretch, `zenith validate` and the
  MCP server report it, and Optimize path treats the other side as a keep-out.
- **A per-robot clearance and the CLEARANCE warning.** `robot.json` gains the optional
  `footprint.clearanceIn` `{ value, provenance }` (`formatVersion` stays 1). CLEARANCE warns where
  the robot passes a structure closer than that, 1 in when the file leaves it out; contact stays the
  STRUCTURE error. Settings, Robot sets it, and **Clearance outline** (Settings, Editor, Field) draws
  the robot grown by it.
- **A slanted bar obstacle, `strut`, in field format version 3.** A strut runs between two 3D points
  with a round envelope, and STRUCTURE checks only its part below the robot's `heightIn` (18 in when
  absent), so a slanted leg blocks more of the floor for a taller robot. Field files move from
  version 2 to 3; version 2 files still load and are saved as version 3. The BIOBUZZ field gains the
  hive frame's four legs as struts, from FIRST's BIOBUZZ field CAD, and its foot bars move to where
  the CAD has them. The field draws the part of each leg below the robot's height as an obstacle, and
  **Overhead outlines** hides the dashed outline of the rest.
- **New findings.** `WAIT_NO_TIMEOUT` warns about a wait for a condition with no timeout;
  `TIMEOUT_TIGHT` warns when a timeout is shorter than its step's estimate, says where the robot is
  stopped and offers "Raise the timeout"; `LAUNCH_TARGET` warns about pieces launched at a target
  that is not on the field; `TRANSFER` checks transfer steps; `REGISTRY` checks `robot.json`
  against the robot's Java.
- **More one-click fixes.** HEADING over half a turn offers Split the path; CONTINUITY and
  MOVES_ROBOT offer Start from where the robot is; PERIMETER or STRUCTURE at a path's end offers
  Push the end back, and where the robot turns on the spot as a path starts, Turn while driving; a
  gap between two paths of a chain offers Join path N to path N-1.
- **Transfer steps.** A planner-only step says that pieces move between two places, such as the
  partner scoring into the hive, with an expected count and an optional actual count. The robot runs
  it as a wait of zero seconds and the generated Java carries it as a comment. It moves the auto
  `formatVersion` to 4 (see Upgrading).
- **Nectar in the ledger, and a ledger for the whole field.** The ledger counts pollen and nectar by
  kind in every hive cell, both robots, each floor quarter, each loading zone, the flowers and the
  garden. A field file marks a loading zone with the optional `ledger: "loadingZone"`, and an id
  ending in `.nectar` or `.pollen` names one kind.
- **Conditions the preview reads from the ledger.** A condition in `robot.json` may give its
  `ledger` as a quantity test, such as `{ "quantity": "hiveOwn.tips", "min": 1 }`, so the preview
  picks a branch's side and times a `wait until` or an `endCondition` from the ledger. On the robot
  the condition is still the team's own `BooleanSupplier`.
- **Full sim speed: Basic, Fast and Ultrafast.** In the desktop app, Settings, General has **Full sim
  speed**. Basic runs `sim.command` for every run, as before. Fast (the default) keeps a sim server
  running for 10 minutes after the last run and plays each run while it is simulated. Ultrafast
  starts the server with the project and runs an auto again in the background shortly after it is
  saved, so the next run of an unchanged auto plays at once. The server is the new optional
  `sim.server` section of `zenith.json` (`prepare`, `args`, `cwd`, `watch`; `zenith.json` stays at
  `formatVersion` 1), started as `java @<args>` and spoken to over standard input and output with
  protocol 1. A project without it runs Basic whatever the setting says, and the sim panel says so
  when a run starts; any server failure runs that click as Basic and says why.
  [Full sim with SimLoop](https://libraries.horizon36596.org/zenith/full-sim-simloop/#full-sim-speed)
  describes the speeds and their cost.
- **Envelopes.** A step can declare the rectangle its robot stays in while it runs, for routines
  that path on the fly from vision; its time replaces the unknown estimate, and a path can declare
  the pose it rejoins from. Draw it on the field, then drag its corners, sides or middle; typed x, y,
  width and height work too. The Envelope row shows while the Commands switch is on.

#### Partners

- **Partner files.** **Download share file** in the editor, `zenith projection` and the
  `zenith.projection` tool write a partner file (`.projection.json`): the auto's path over time,
  bounding box and the elements it takes, with every command replaced by a token unless you choose
  `--include-commands`.
- **Alliance view.** Load a partner's share file next to your auto: both robots on one field and one
  clock, with predicted collision, near-miss, start-overlap, element-conflict and envelope findings
  that never block a save, a deploy or a run. Fixes delay your start or add a wait before a step, and
  Make it a wait step turns the start offset into a real wait. Each auto keeps its own offset.
  `zenith alliance` and the `zenith.alliance` tool give the same findings and fixes.
- **Proposed changes.** From a partner's propose-level share file, suggest moved poses, headings,
  waits and envelopes (never commands) and save them as a proposal file; the owning team opens it
  with Open proposal… and accepts or rejects each change. `zenith proposal validate` and
  `zenith proposal apply`, and the matching tools, do the same.
- **Imports.** Pedro Pathing Visualizer projects (`.pp`), RoadRunner trajectories through a MeepMeep
  exporter class, and two documented interchange files, `trajectory.json` and `path.json`. `zenith
  import`, Import in the editor and the `zenith.import` tool read them, and a `trajectory.json` can
  become an auto of drive, wait and turn steps. Imports over 16 MB are refused before they are read.
- **Host mode** (`zenith-host/1`, in [the host protocol](https://libraries.horizon36596.org/zenith/host-protocol/)).
  A web app on an allowed origin can open Zenith in a popup with a project, get each saved auto back
  and lay its own run's trace over the plan. DSIM is the first host. The bar says which alliance to
  draw for and when the host is out of date or its window has closed, and a new auto made for the
  host starts at a legal pose. A host's `open` may carry `newAuto: true` (start a new auto that clashes
  with none of the host's) and `hostBuild` (its own build number); the protocol stays `zenith-host/1`.
- **Live run** (`createLiveRun` in `@horizon36596/zenith-core`). A program that drives its own robot,
  such as a simulator, can run an auto with Zenith's own Pedro v3 follower and command tree, passing
  in the pose and velocity each tick and getting drive powers back.

#### CLI, MCP and GitHub

- **`zenith optimize <auto> --step <id>`** runs Optimize path on one path step (`--margin-in`,
  `--budget`, `--score sim|estimate`, `--mode both|route|heading`, `--no-split`, `--no-ranges`,
  `--max-paths`, `--hold-start-in`, `--hold-end-in`). It is a dry run that prints the times, the
  alternatives, the markers that move and the lines that would change; `--write` saves the pick and
  `--json` prints the result. It exits 0 for improved or no better, 2 when no route passes the final check, and 1
  for an error. The MCP server gains the read-only `zenith.optimize`, with the same options, and
  `zenith.edit.setRoute`, which writes a route without moving either end.
- **Heading holds for Optimize path.** **Hold start heading** and **Hold end heading** (inches, 0 off)
  keep the start heading over the first N inches of the route and reach and keep the end heading
  over the last N, in every route offered (`--hold-start-in` and `--hold-end-in` on `zenith optimize`,
  `holdStartHeadingIn` and `holdEndHeadingIn` on `zenith.optimize`).
- **`zenith import-commands`** reads the `NamedCommands.register` and `registerCondition` calls in the
  robot's Java or Kotlin, with each command's arguments, and adds what `robot.json` is missing with
  `"estimateS": "unknown"` and a provenance naming the file; nothing a person wrote is changed or
  removed. `--check` writes nothing and exits 1 while they disagree, and `zenith validate --java
  <dir>` checks with the new `REGISTRY` finding. The editor's **Import commands from Java…** and the
  `zenith.importCommands` tool do the same. `robot.json` commands, params and conditions may carry an
  optional `provenance`, and `zenith.json` gains `javaDir`, the folder or folders where the robot's
  code lives, so `zenith validate` checks against it with no flag.
- **Connect a robot repository to GitHub in one step.** `zenith setup` (MCP: `zenith.setup`) runs
  `zenith init` when needed, adds the Zenith server to `.mcp.json`, checks `origin`, the GitHub
  sign-in and the branch, validates every auto and says the next step. `zenith github status` (MCP:
  `zenith.github.status`) reports
  the repository, login, push access, branch and its open pull request. `zenith propose <auto>` (MCP:
  `zenith.propose`) is no longer dry-run only: it commits the canonical auto, changed waypoints and the render to
  `auto/<auto>/<login>` with the base merged in, pushes and opens or updates the pull request,
  without touching your checkout. The sign-in is `GH_TOKEN`, `GITHUB_TOKEN` or `gh auth token`; the
  token goes only to api.github.com and is never printed or written. It never writes the base
  branch and never force-pushes.
- **Sign in with the GitHub CLI, and `zenith open`.** In the desktop app, when `gh` is installed and
  signed in, GitHub sign-in offers Sign in with the GitHub CLI, keeping the token in memory only. A
  folder that is a git clone of a github.com repository offers Open this repository in GitHub mode.
  `zenith open [dir] [--auto <name>]` and the `zenith.app.open` tool open a project in the desktop
  app.
- **`@horizon36596/zenith-core` additions.** `setRoute`, `joinSteps`, `optimizeRoute` and
  `runOptimize`, the fix kinds `replaceRoute` and `optimizeRoute`, `SimOptions.stopAfterStepId`, and
  `geometry.poseIn`, `geometry.footprintIn` and `geometry.worstPolygonIndex` on PERIMETER, STRUCTURE
  and KEEPOUT findings (optional fields). The MCP server gains `zenith.edit.joinSteps`,
  `appendSegment`, `removeSegmentJoined` and `joinSegmentsAt`, and `zenith.edit.setPose` takes
  `joint: true` to move both ends at a joint.

#### Robot runtime

- **The trace writer records contacts, the ledger and events.** `AutoTraceWriter`, for both
  SolversLib and Ivy, gains `structureContact(obstacle, penetrationIn)`, `ledger()`, `event(kind)`,
  `event(kind, alliance)` and `sha(commit)`, and the constants `AutoTrace.STRUCTURE_CONTACTS`,
  `LEDGER` and `EVENTS` let a sim declare a check before the run, so `zenith sim` can check contacts
  and the ledger in a headless sim. The trace format stays at version 1, and a trace that records
  none of them is byte for byte what it was.
- **Path speeds are checked at init.** Init shows a `Zenith warning` naming each path step set below
  full speed when the team's `ZenithRobot` does not implement `atSpeed`, since only `atSpeed` makes a
  speed reach the robot.

#### Documentation

- **Full sim with SimLoop.** A new page,
  [Full sim with SimLoop](https://libraries.horizon36596.org/zenith/full-sim-simloop/), sets up the
  high-fidelity sim with SimLoop, Horizon's library for running FTC robot code on a laptop, step by
  step from its starter folder. Zenith does not depend on SimLoop.
- **Guides for when accounts launch:** a privacy notice, terms of use, a retention policy, a guide for
  school administrators and a guide to teams and sharing.

### Changed

- **The Ledger draws the pieces instead of listing them.** Pollen and nectar are the same glyphs as
  on the field, each count a number and its piece. A strip at the top shows the robot's hopper, a
  slot per piece it can hold, and our hive's up cell filling toward its tip, both at the playhead;
  the nectar in the cell is drawn too, with fewer pollen slots for each, since nectar tips the hive
  sooner. Below it, every movement in a step reads the same way, from a place to a place with the
  pieces on an arrow: flower, garden or floor to the robot, the robot to the hive, a missed shot to
  loose, and a tip from the hive to the floor quarter it dumped onto. Empty slots and steps still to
  come are a neutral outline, since either piece may fill a slot. While the auto plays, the running step is marked, the steps still to come
  are drawn hollow and the list keeps the running step in view. "At the end" shows where every piece
  lies once the auto ends, with every flower on one line. Each line's hint keeps the ledger's words.

- **The desktop app's sim, deploy and git panel works like the rest of the app.** It takes focus
  when it opens, Esc closes it, and its close is the usual X with a tooltip. Deploy and Commit ask
  before they save unsaved edits, as the sim does. Each disabled git button says why under the row,
  the next step is the primary button, and Open pull request says it pushes first. The git panel
  signs in to GitHub through the same dialog as the toolbar, and says whether the GitHub CLI could
  sign you in instead.
- **The desktop menus use the palette's words.** Each item has the same name as its action in the
  palette, and Edit and View items have access keys. Open recent shortens long paths and has
  Clear recent. About Zenith has Copy version and Close, and F10 opens the menu under its button.
- **Opening a robot repository says the same thing every way you open it**, including that Save
  writes in place.
- **The desktop app says when a newer version is out.** Once per launch it asks GitHub, with no
  token and nothing about you, for the latest release. When there is a newer one, the status line
  says so once and Help has Get Zenith, which opens the releases page.
- **Shorter share screens.** The share dialog keeps command names, the auto's name and the version
  under More options, with their current values shown while it is closed. A received share is one
  line, with Details for the version, the safety-number check, Keep for offline and More time. The
  first-share safety code has a How to check link. "Pinned to revision" now reads "Stays on version".
- **One look for empty, loading and offline.** Empty regions have an icon and a headline, loading
  lines end in data or an error with Try again, and cloud sheets say when the computer is offline and
  what still works. Busy buttons end in an ellipsis ("Sending…"), dates read "Sat 3 Oct, 18:30"
  everywhere, and the account button's tooltip names who is signed in.
- **The first run and the tour leave the example as they found it.** What a tour stop's Try it task
  changes, a dragged dot, an added path or a turned heading, goes back when you leave that stop, so
  Problems and Play show the example as it was; Undo brings your change back. Tour cards keep off
  the steps list, the inspector and the field when their sentence is about them, the Heading arrows
  stop is two short sentences, and the ring round each stop is crimson with a white edge in Day so
  it shows on a white panel.
- **The start screen shows only what is there.** With no auto open, the empty inspector and Problems
  panel are gone at every window width, the Steps list says "No steps yet" instead of repeating "No
  auto open", and "Other ways to open" is drawn as a link you can press.
- **One name for each thing.** The example is opened with **Open the example**, your robot's
  folder with **Open a folder…** (in the desktop app's File menu too), the robot repository's own
  simulator is the high-fidelity sim and Full sim is only the playback level, the planned thing is
  an auto, the library's buttons are **Publish to the team library** and **Keep for offline**, and
  every review is left with **Leave**, whose tooltip names what it leaves.
- **What's this from the Help menu is a mode.** The pointer turns into a question mark and the next
  control or row you click shows its hint instead of doing anything; Esc cancels.
- **Report a bug works with accounts off.** The dialog links a new issue on GitHub to paste the
  copied report into, says that issues there are public, and a greyed Copy report says why.
- **The palette and the toolbar say why.** Enter on the first result runs that result, or, when it
  cannot run, says why and keeps the palette open instead of running one further down. Snap shows
  whether it is on and is found by "wall". The arrow beside Optimize path is greyed with the same
  reason as the wand while neither can run, the alliance pill's tooltip names Mirror and its key,
  and the palette's Settings row no longer mentions an account when there is none.
- **Settings opens each section at its top, and searches best match first.** Searching "key" lists
  the Keyboard section before the toolbar rows that mention a key. A Needs measurement chip is drawn
  hollow so it no longer looks like a Placeholder chip, and a robot height in a finding reads
  "(placeholder)" rather than in capitals.
- **A preset file that will not import says which file and why**, on one error line in Settings and
  on the first-run card, which no longer jumps when the line appears.
- **Bad files say what is wrong and what to do.** A share file, an import or a sim trace that
  cannot be read now gets one plain sentence that names the file, says what is wrong with it (empty,
  cut off, a picture, too large, from a newer Zenith, another kind of Zenith file, or damaged) and
  what to do next, the way a broken project file already did. A share file is no longer refused with
  "Share files end in .projection.json" when its name already does, an import error shows once
  instead of twice, a Zenith auto picked in Import from another planner says to open it as an auto,
  and a trace that does not load says so inside the Simulate dialog beside a Load trace button. The
  same share file picked twice is refused instead of drawing the partner twice.
- **Cloud failures read the same everywhere.** Sharing, the account and team sheets, the team
  library and the admin pages word an offline or refused call the same way, with what to do next,
  and no longer show the cloud's developer messages. An invite or share link that was cut short
  says "That link is not complete. Check it, or ask for a new one." instead of doing nothing.
- **Optimize results say at a glance whether a run helped.** A run that used its 5 s search says
  "Searched for 5 s: the best route so far." "Stopped early" is kept for your own Stop. The result
  line has a green check when the route helps, is quiet grey when nothing better was found, and has
  a yellow warning sign when no route can be clear. The option rows fold under "Options" once a
  run starts, so the result has the room. What a route clears is one sentence, such as "Clears 4
  errors (hits a field element 3 times, crosses the centre line)."
- **Optimize every path counts a failed path apart.** The total reads "5 of 7 paths searched, 2
  failed.", and each failed path has Try again, which searches that path alone.
- **Add a clear path here refuses a blocked spot at once**, before any search, and its menu item
  says what it does in its tooltip. A robot over the centre line or the wall is "over" it, not
  "inside" it.
- **The Code tab with errors says "No code while the auto has 4 errors."** It has Show the errors,
  which opens Problems, and says how many of the errors are in features your settings hide.
- **A loaded trace names the run one way.** The timeline's track ends in "Full sim 6.20 s +0.25 s",
  and Simulate's report says "6.20 s, +0.25 s on the 5.95 s plan".
- **The instant sim says why its total differs** from the Ideal plan when nothing else explains it:
  "The instant sim drives the plan within the robot's limits: 0.30 s longer."
- The Full level's tooltip on the web says to run the sim command in your robot repository.
- **Delay my start now says what it left and how to take it back**: "One near miss is left." and
  "To undo it, set Your start offset back to 0.0 s."
- **Loading a partner's share file that is already loaded replaces it** instead of adding a second
  copy, and the status line says so. Removing a partner says so, and says to load its file again to
  bring it back.
- **The Partners panel with no partner loaded shows "No partners loaded"** with one Load share
  file... action. The start offset row appears once a partner is loaded.
- **With the Ledger switch off, a shot from a spot the rules do not allow, or one the turret cannot
  aim, is listed in Problems, drawn on the field and counted.** The switch hides only the ledger's
  counting problems, such as a shot with nothing loaded.
- **A path that runs into several parts of one structure offers Route around once**, on the first
  row, and the other rows say it covers them.
- **Route around is no longer offered for crossing the centre line** when the path starts or ends
  on the other alliance's side, since no route between those ends can stay on your side.
- **Step edits say what they did.** Inserting from the Steps list or the Insert menu, wrapping,
  renaming, moving a step and placing a marker each write one status line, such as "Added turn after
  path3.", "Wrapped path2 and path3 in group1." or "Added a marker on driveOut at 30 % that runs
  intakeOn."
- **A new path or group starts with no error.** Insert a path, Sequence and Parallel pick a short leg
  that hits nothing, and a group with no clear leg near starts with a wait instead.
- **Shift-click selects a run of steps.** Shift-click in the Steps list selects every row from the
  last one you clicked, ready to wrap; Ctrl-click still adds or removes one row. With several steps
  selected, the Inspector says that its fields change one of them only.
- **Step ids follow the waypoint name rule.** A step's id starts with a letter and holds only letters,
  digits, `_` and `-`. Renaming to anything else is refused with the reason. A file with an older id
  still opens and generates working Java, and Problems warns (`STEP_ID`) with a one-click rename that
  updates the groups that name it.
- **A turn on the spot reads as a turn.** Its row has the turn icon, and the Inspector shows only its
  heading and its time limit, with Edit as a path for the rest.
- **One name for each action.** The field's menu and the step menu both say "Insert a path after" and
  "Insert another step after…". The two parallel modes that stop early read "Stop when any step ends"
  and "Stop when a chosen step ends". An empty time limit reads "Never", as Stop early does, and a
  waypoint's provenance row is called Origin.
- **The marker menu can change the command.** Right-click a marker for Change command, which selects it
  and puts focus on its command.
- **Menus look the same everywhere.** Every menu row, the field's right-click menu included, has its
  16 px icon, every segmented switch is the same control, Take the full tour has its own icon, and
  Publish has one icon in the palette and the Share sheet.
- **No focus ring after a click.** A menu opened by right-click, the field after Measure, a dropped
  marker's command and a closing sheet no longer show a focus ring or open a tooltip; the keyboard
  still shows both.
- **Partner findings look like Problems rows.** One line until selected, fixes on the selected row,
  and the code chip's tooltip titled with its code and split into what it means and how to fix it.
- **Smaller wording fixes.** Make curve on a one-path step says "path1 is a curve now.", Delete on the
  end of an auto's only step says why it cannot go, a step's time has the same two decimals in the
  list and the Inspector, Add waypoint keeps its line at the top of the field while it waits for the
  click, and the waypoint check dialog writes a heading of 180° as the Inspector does.
- **The Code tab says that the robot does not run the class it shows** (#534). A line beside the new Reference / Export switch says the robot runs the auto file, which builds the same routine, and that the code is not the thing to edit. The docs no longer say the generated class serves teams that use the file format without the runtime: it extends the runtime's `AutoFromFile`, which reads the auto file. The exported OpMode is the class that does without the file.
- **A SolversLib auto that fails at init now ends and resets the scheduler** (#532). `AutoFromFile.runOpMode` runs `initialize()` inside its `try`, as the Ivy runtime always has, so `end()`, `reset()` and the new `onStop` run after a failure on the tile too.
- **The Inspector is one calm panel.** A selection header (the kind's icon, the id, the estimate and
  `?`) replaces the title, and sections such as PATHS, HEADING, SPEED, MARKERS, ADVANCED and NOTES
  sit under small headers that fold, with a count, a summary and a dot when something inside needs a
  look. Rows share one grid, a value at its default is drawn quieter, a pose is one line with a
  short provenance chip, and folds are remembered. A path step reads as a "path chain" of "paths" in
  the editor only; the file keys, MCP tool names and generated Java keep "segment". Each From and To
  is one select (the previous end, This pose, or a waypoint), heading is edited only in the Heading
  section, a marker's **At** reads `% along`, Speed reads like `80% · robot default`, End condition is
  **Stop early when**, a wait's cap is **Give up after**, and a branch reads **Preview follows**.
  Clicking a point on the field opens its path and marks the point's row.
- **Angles read plainly.** Every angle shows wrapped to between -180° and 180° with one decimal, an
  empty timeout reads `none`, and piecewise ranges speak in percent of the path.
- **The steps list, the timeline and the status line.** Each step row shows its time (`3.5 s`, or
  `—`) and one tooltip such as "toGarden, a path, about 3.5 s". The Steps header has **+** for the
  insert menu, the step menu offers only what applies and counts what Duplicate and Delete touch,
  and Duplicate copies every selected step. The timeline head shows one total for the playback level,
  "of 30 s", and the running row stays in view while playing. A status line goes at the next edit.
- **The toolbar, tools and field menus.** The toolbar is one row that never wraps, with Optimize path
  in a group of its own and Propose only for a project opened from GitHub. A tool stays on until
  `Esc`, which goes back to Select, with a hint line at the top of the field. The field gains Fit,
  +, − and a zoom percent at its corner and loses its Play button. Right-click menus open at the
  pointer and show only what applies, with a greyed item's reason in its row.
- **The Problems panel and the Code tab.** A problem row is one line until it is selected, and only
  the selected row shows its fixes, which say a verb and a noun ("Push end clear", "Route around").
  The time budget's info note is no longer listed (`check()`, Validate and Save are unchanged). The
  Code tab opens at `buildRoutine()`.
- **Settings, the first run and the dialogs say one thing each.** The command library and pathing
  system are in Robot, under Follower. The welcome screen is one sentence and two buttons, and a
  project with no autos offers New auto. Sheets and dialogs keep state, warnings and empty states,
  and explanations moved into tooltips; action tooltips are at most 100 characters.
- **One Grid setting: Off, Tiles, 12 in or 6 in.** Tiles, the 24 in tile seams, is the default, so the
  12 in lines are off until chosen.
- **A linear heading on a curve turns where the robot turns it.** On a Bezier, `linear` headings and
  the linear ranges of `piecewise` headings now turn evenly in each segment's own parameter, as Pedro
  and the robot runtime do, so the checks, the estimate and the ideal playback match the robot.
  Estimates on such curves move a little; lines are unchanged and so is the file format.
- **No pause between two path steps in the preview.** A path followed straight away by another path
  no longer costs a settle time, which takes 0.25 s off the estimate for each such joint. The robot
  still slows into the joint, because Pedro brakes into the end of every path.
- **The estimate counts the turns at path joints** at `maxAngularVelRadPerS`, so a zigzag routine
  reads its real total, and the Ideal level plays the same turn.
- **New path steps are named `path1`, `path2`** and so on in the editor, `zenith new`, the MCP
  template tool and host mode. Files with `leg` names open and save unchanged.
- **The starter example plays BIOBUZZ the way a team would.** `collect-and-score` shoots all four
  preloads as soon as it drives out, goes round the west of the hive frame (so it never crosses the
  centre line), collects from the north flower, sweeps the garden line and scores again for a second
  tip, inside the 30 s period. It validates with no error or warning. The starter's waypoints change
  to match and lose the unused `gardenApproach` and `gardenPickup`; the example partner parks at the
  west wall.
- **The BIOBUZZ hive and human player follow the manual.** A tip dumps its cell onto the floor
  quarter on that cell's side, the down cell is always empty, 5 or more nectar tip a cell, the robot
  scores only from the up cell's floor quarter, its hopper is last in, first out, and the human
  player brings in one nectar per tip of its own hive, five in all. The tip cost reads the nectar in
  the up cell, so the first tip costs 3 pollen.
- **The aqua target reticle is gone from the flowers**, on screen and in downloaded pictures.
- **The field pans with the middle mouse button**, or Ctrl and the right button, and a double-click
  on empty field fits it.
- **One logo everywhere.** The favicon, the desktop app icon, the docs site and every wordmark use
  the one Z mark.
- **Envelopes are rectangles.** Files keep the same four-corner polygon; an envelope of another shape
  still loads, and the Inspector offers to make it the rectangle round it.
- **The desktop window has no gradient border**, and it opens fitted to the screen's work area, with
  a minimum of 1024 by 600.
- **One name for a partner's file: share file.** It is still a `.projection.json`, in the same
  format.
- **An auto in an older format says so when it opens**: saving writes it in the current format,
  which older versions of Zenith cannot open.

### Fixed

- **Exported JSON Schemas use valid numeric bounds.** Positive-only fields now emit a numeric
  `exclusiveMinimum`, as required by the declared 2020-12 dialect. Runtime validation and file
  format versions are unchanged.
- **Host mode says when it is saving, keeps the robot findable on a narrow window, and says a closed session once.** Save to DSIM reads "Saving to DSIM…" and is off while it waits for DSIM's answer, and the status line says "Saving <auto> to DSIM…". Below 1100 px wide, where the robot and alliance lines are not drawn, Save to DSIM's tooltip says them. When DSIM ends the session, the bar says so, the status line says only that Save to DSIM is off and Save a copy keeps your edits, and the title bar reads "was in DSIM".
- **The editor works in a narrow window.** Below 820 px the Inspector opens as a sheet over the
  field, and below 640 px the steps do too, one at a time from a Steps, Field and Inspector switch
  under the toolbar. The field keeps the width, and the bar says a wider window shows every panel.
  A pull-request review, a proposal or a library comparison says when it needs a wider window. The
  Problems header drops a zero count instead of cutting it, and the timeline's level switch stays in
  place and in view when the total is long or the column is narrow.
- **An offline send no longer says it was sent.** A proposal, a decision or a share made while the
  computer is offline says it waits in the Outbox and goes when you are back online. A share that
  fails once the connection is back drops "Waiting to share", says why, and offers Share again.
- **A refused publish always says why.** When no sheet is open to show it, the status line does.
- **Reading the library or the team always ends.** A read that fails says why and offers Try again,
  and what an earlier read found stays on show.
- **A Horizon admin's team delete removes its members.** Shares sent to a deleted team stop opening
  for the people who were in it.
- **Every action answers on the status line, and old answers go away.** Undo and redo say
  "Undid:" or "Redid:" and what the edit did, from the keys, the toolbar and the palette alike.
  Opening another auto says "Opened" and its name, and after Discard it says the edits were
  discarded instead of still saying they were kept. Validate says "No problems found." or how many
  errors and warnings it found, and opens the first. Snap, Play, Mirror, Set timeout, discarding an
  Optimize result, removing a partner, skipping the tour, and changing or resetting a key each say
  what happened. Applying a preset says how many settings it changed and offers Undo. A line from
  an earlier action clears when a dialog, a sheet or Settings opens, or when the tour ends.
- **"Example loaded, read only."** The status line reads as two sentences, with a real space
  before its reason, and a wait with no time limit says "No time limit: may wait to the end".
- **Number fields say their range.** A number typed outside a field's range, or text that is not a
  number, is refused: the field keeps its value and the status line says the range once, such as
  "Speed runs 1 to 100%.", and each number's tooltip ends with its range. A path's position runs
  across the field and a robot-length past each wall, a robot's sizes, speeds and accelerations have
  ceilings, and a team number is a whole number from 1 to 999999 in Teams, Share and the admin page,
  with the same sentence under the field when it is not one.
- **Step names.** Renaming a step to an empty name says "A step needs a name.", a name with a space
  says "Step names are one word, like shootPreload.", and a name another step has says "Another step
  is already called" that name.
- **Set up and Auto details fields.** Set up's robot class is a full-width box whose note follows
  what is typed, and a class that is not a Java class name is refused under the box rather than at
  the foot of the dialog. Auto details' Title and Authors are full-width boxes with an edge, and Holds
  at start counts the game piece the field places, or says it is read only.
- **Set up a folder that already has autos.** Opening a folder that has autos but no zenith.json, in
  the browser or the desktop app, offers to write only zenith.json, pointing at the autos where they
  are. It moves and writes over nothing, adds a robot or field file only where the folder has none,
  and opens the project.
- **A folder that did not open says so on the canvas.** When a folder's zenith.json, robot or field
  file is broken, the empty canvas says the folder did not open and why, with Open another folder,
  instead of still inviting you to plan a first auto. Set up Zenith on a folder that is already set
  up says so.
- **The sign-in email field** has a visible label and an example address.
- **The desktop app recovers from a crashed page.** It no longer leaves a blank window. It asks
  whether to Reload, Save edits as… or close, and Reload brings back your unsaved edits. Closing the
  window of a stopped page asks first when it had unsaved edits.
- **Closing the desktop app while a sim, deploy, commit or push runs asks first.**
- **Save a copy and Download picture in the desktop app say Saved only once the file is written.**
  A cancelled Save dialog no longer reads as a download.
- **A file changed on disk while you have unsaved edits asks what to do**, Keep mine or Reload from
  disk. A change to `zenith.json`, the robot, the field or the waypoints no longer replaces edits
  made while the project was being read again.
- **The git panel says what is wrong.** Without Git installed it says Git is missing, not that the
  folder is not a git repository. Offline, it says GitHub could not be reached instead of refusing
  a good token. A push that stalls stops after two minutes and says so.
- **Desktop errors are written for the person reading them.** A failed save says why and what to
  do next instead of the raw system error. A sim that fails says so in one sentence, with its exit
  code in its output, and a missing Java or `gradlew` is named. A cancelled sim reads as cancelled,
  not as a failure. Robot > Cancel the sim with nothing running says no sim is running. A deploy
  that skipped autos is a warning with the next step. Sign-in providers that are off say so in plain
  words, and the browser page after a sign-in has Zenith's look.
- Autos with deeply nested groups no longer crash the instant sim.
- **`zenith sim <auto> --json` prints only JSON on stdout.** The sim command's own output now goes
  to stderr with `--json`.
- **Every "are you sure" asks the same way.** Revoking a share or an invite, removing a member,
  leaving or deleting a team, revoking a device, signing out with waiting changes, deleting your
  account, deleting a preset, resetting every key and withdrawing a proposal now ask with one row:
  the question, then Cancel on the left and the action itself on the right. Rejecting a proposal
  and taking a tester off the beta list ask first too. Ending an invite is called Revoke in Teams,
  as on the Sharing page.
- **One question for unsaved changes.** Closing Settings with an unsaved robot.json asks Cancel,
  Discard changes or Save robot.json, the same buttons as switching autos, and the Robot pane's own
  Save steps aside while it asks. Leave on a proposal with changes not saved or sent asks the same
  question instead of dropping them.
- **One look for buttons.** The main button of every dialog has the same orange look as the
  sheets, in both themes, and a dialog shows one at a time. A button that cannot be pressed stays
  reachable with Tab and its tooltip says why. Problem fixes are quiet buttons, not orange links.
- **Copy answers the same everywhere.** Every Copy button reads Copied and the status line says
  what was copied, the share link's Copy included. When the browser refuses, the text is selected
  and the button says Press Ctrl C.
- **Tidier rows.** Revoke on the Sharing page is a labelled button set apart from the other row
  icons. A preset you saved keeps Apply in its row and the rest in its menu, with Delete last. The
  Teams sheet shows a member's role once, and says why an owner cannot leave next to the button.
- **Generated Java and the runtimes match the sim.** `zenith codegen` writes a path step of 2 in or
  less as `TurnInPlace`, decides at run time whether a path from `"current"` turns in place, gives
  parallel members whose ids read the same in camelCase separate locals, and ends piecewise ranges at
  the segment t the runtime uses. An unregistered end condition on a path from `"current"` fails at
  init on both runtimes, a mirror that moves the field without turning headings moves a `facePoint`
  target too, and `argInt` refuses a whole number outside the `int` range instead of clamping it.
- **Path markers.** A path cut short by its `endCondition` fires only the markers the robot passed,
  on the robot, in the instant sim and in generated Java. Two markers on one path that need the same
  subsystem no longer run at once, and a marker no longer fires on the previous path's progress.
- **The instant sim and traces.** A turn on the spot ends when its `endCondition` comes true, ideal
  playback turns from the heading the robot arrives with, and a trace with step times that are not
  finite, or end before they start, is refused with the step named.
- **Checks.** A wait or non-driving command between a `movesRobot` command and the next path no longer
  hides MOVES_ROBOT. A marker that stops the intake ends its running stretch, short westbound paths
  no longer get a spurious MOUTH_LEADING, and splitting a linear range across π keeps the turn.
  STRUCTURE and PERIMETER report how far the robot would have to move to get clear, once, with the
  obstacle's name and how long the robot stays in contact. A path that turns against the wall, and a
  start wholly in the other alliance's half, say so plainly. A shot made illegal by an earlier step
  names that step.
- **The time estimate.** A race that a member's timeout ends is timed at that timeout, a branch side
  with a step of unknown length keeps the time of its known steps, a timeout bounds its step's
  estimate, and a move shorter than 2 in is timed.
- **The ledger.** A deadline group whose deadline stands still ends where the driving member leaves
  the robot, a branch's `else` side carries on correctly, members of a `deadline` or `race` group that
  start after it ends are skipped, and markers that launch or tip change the ledger at their place.
- **The file format refuses or repairs odd input.** A share file nested deeper than 32 levels is
  refused, a positive-only number such as `timeoutS: 0.0004` saves as `0.001` instead of `0`, a file
  with no `$schema` gets the current id on save, and provenance such as `NOT MEASURED` ranks as
  unverified.
- **Opening and saving projects.** In the desktop app, a file changed on disk is reloaded only if it
  is still the open auto with no unsaved edits. A project zip is read at the paths `zenith.json`
  names, and the first save of a new auto never writes over a file it could not read, or one whose
  name differs only in case. Opening an auto names the file it cannot read, and opening one of the
  example's other autos no longer fails.
- **`zenith init` sets up the OpModes, and `zenith deploy` says when it writes none.** `zenith init`
  writes a `codegen` section and takes `--robot-class`; without a `codegen` section, `zenith deploy`
  warns that no OpMode was written and `--json` has `"stubs": false`.
- **`zenith diff`** and review mode report only the steps whose order changed as moved.
- **GitHub mode lists repositories in a browser.** The Open project dialog's GitHub tab listed none
  after sign-in.
- **Commit** in the desktop app replaces a link at a render's own path instead of refusing, and is
  off when there is nothing to commit.
- **Field editing.** Shift locks a path line's direction, so a diagonal can be made shorter; the Add
  path tool's preview shows where its point will land, and a snap onto a waypoint follows it; a click
  where paths overlap keeps the selected step, and `Alt` + click reaches the ones under it; `Esc`
  during a drag cancels it, and a second finger is ignored; the point a split adds moves as one, so
  the path never tears; turning a line into a curve keeps it on the line, and Make curve is in the
  path's right-click menu; a right-click on a selected path near its start gives the path menu; pan,
  zoom and Zoom to fit keep the whole field and frame the routine.
- **Headings.** A path point's heading row and Turn act on the heading mode, which alone decides
  which way the robot faces; switching to Constant or Linear keeps the path's heading instead of
  starting at 0°.
- **The Inspector.** A number shows what the file keeps and writes only real edits; a drag across a
  number field is one undo step and its text can be selected; a value left with Tab is kept; a
  parallel group's deadline, a wait's choice and a path's speed can no longer make an auto invalid
  or drop a setting; duplicating or moving a deadline group's steps keeps its deadline valid; a
  marker opens its own section, and `Del` removes the marker, not its path; text fields are wide
  enough to read.
- **The steps list.** Arrows, Home, End, Enter and Space on a focused row act on the list, and a held
  key is one undo step; Alt + Up and Alt + Down move a step into and out of groups; Wrap in a branch
  follows the rules of the other wraps; Delete removes every selected step; every delete says how to
  get it back, and undo selects the steps again; undo and redo never leave the selection on
  something that is gone; renaming a step works and keeps focus on the row; command descriptions are
  shown whole.
- **Playback.** The playhead stops at the routine's end, and the folded Ledger reads like "4 pollen
  in, 3 launched"; the Ledger's end rows say what is held; choosing Instant sim no longer moves the
  playback controls.
- **The tour.** New users see it when a host opens Zenith or a link carries a query, and Escape
  leaves it straight after Next.
- **The desktop app.** `Ctrl =` zooms in; the window buttons stay clear of the toolbar at every zoom;
  closing it with the example open offers Save a copy… and waits for it; File > Open project… has
  `Ctrl O`; the shortcut sheet lists the desktop keys; GitHub sign-in speaks of the app.
- **Layout.** The field keeps its room in a narrow window, the insert menu opens where you can see
  it, a text field's tooltip no longer covers it while you type, the status line leaves the steps
  column clear, and file buttons in dialogs look like the app's buttons.
- **Smaller wording fixes.** "1 auto", not "1 autos"; an empty Problems panel reads "No problems
  found. Checked as you edit."; picking files without a folder picker names every file still
  needed; the tour's last stop says what Save does in the example.
- **Move to approach** picks a legal spot that hits nothing and makes no existing problem worse,
  turns the robot so the same side faces the target as before, and marks the pose SET FROM EDITOR.
  With no such spot nearby it offers no button.
- **Sideways driving.** STRAFE_FRACTION tints the stretch of the path that drives sideways, not a
  shape across the field. Its cost counts the turn that nose-first needs, and **Point nose along
  path** is offered only when it is faster.
- **Route around and Push end clear.** Route around says when the path's own end is within the
  margin, and is not offered for a CLEARANCE at the path's end. Push end clear moves the end to the
  robot's clearance, so no CLEARANCE warning follows. A row with no fix says why.
- **PERIMETER** names the wall and where along the path the robot leaves the field.
- **Every one-click fix** says on the status line what it changed and which key undoes it.
- **Keyboard.** After an insert the new step's row has the focus, an Insert pane opens with its first
  field focused, and Escape returns the focus to where the menu was opened. On the tour's card,
  Enter goes to the next stop, as the guide says.
- **Inspector.** Give up after stays readable at the narrowest Inspector, a field's tooltip sits off
  its labels, and a marker's distance is held to its path's length in the editor, the sim and the
  generated code. A command argument's hint gives its range.
- **Instant sim.** A wait in a parallel group now waits for the path beside it to fill the hopper,
  instead of ending at once, and the timeline says when the instant sim did not run every step. A
  recorded run counts a group's time once.
- **Full sim.** The Full level's total and scrubber end where the routine ended, not at the end of
  the recorded period.
- **Smaller editor fixes.** Optimize every path says "No faster routes found." when there are none;
  Extend this chain keeps one plain heading when nothing turns; the Waypoints list fits four-digit
  headings such as -135.0°; Default path speed reads in percent, as the Inspector does.
- **Hidden problems.** An error from a feature your settings hide is named under the Problems
  header, and blocks Propose and a share file as a shown one does; Save says it too. The Deploy
  panel says in plain words why it skipped an auto and that its OpMode was removed.
- **Broken files.** Opening a project with a broken or invalid file names the file and the place,
  and says what to do. A broken first auto no longer hides the project's other autos. A file that is
  not a share file in Partners gets one line, and Save a copy to downloads says what it saved.
- **Host mode.** When DSIM is too old to read this Zenith's autos, Save to DSIM and Simulate in DSIM
  are off and say why, and Save a copy keeps your work. DSIM can say why it could not run an auto
  (`runFailed`). The host bar keeps the robot name and Save to DSIM in view at DSIM's popup size.
- **First run.** In a narrow window the toolbar keeps Search, Settings, Help and Documentation on
  screen. The web app no longer shows Full sim speed, which only the desktop app uses. The tour's
  stops for groups, heading modes and fixes fit what is on screen, and the first Tab on the start
  screen reaches **Open the example**.
- **Docs.** The screenshots and the Getting started walk-through show this version.
- **No element conflict for two robots scoring into different cells of one hive** (#460). The alliance view, `zenith alliance` and `zenith.alliance` compared a BIOBUZZ hive's up cell by its id, which names whichever cell is up, so a partner scoring from the north quarter after your preload tipped the hive from the south was reported as scoring into the same element. Each claim on a hive cell is now placed in the cell over the floor quarter the robot scores from, and a conflict names the cell, such as `hiveRedUpCell (the south cell)`.
- **The proposal editor's alliance findings match the alliance view** (#482). The preview of your robot against a proposed partner now uses the season's hooks the alliance view uses: a partner written for the other alliance has its claimed elements renamed when it is mirrored, and a partner scoring into the other cell of a tipped BIOBUZZ hive no longer shows an element conflict (#460).
- **`zenith sim <auto> --json` prints only JSON on stdout** (#405). In 0.1.1 the sim command's own output, such as Gradle's task lines and `BUILD SUCCESSFUL`, went to stdout ahead of the report, so a script could not parse it. With `--json` that output now goes to stderr, and stdout holds only the JSON report. Without `--json` nothing changes.
- **A new path facing a wall is no longer Constant** (#445). Insert, the palette's Insert a path, and the first path of a new sequence or group, made beside a wall with under 12 in left to drive, held the heading it arrives with as Constant whatever **Heading for new paths** said, so a person on the defaults got a Constant path. It now holds it as Linear from that heading to itself, the same as every other new path, and is Constant only when the setting is Constant; the path drives the same way. No file format changes.
- **Commit replaces a link at a render's own name** (#453). The desktop app's Commit used to refuse with "leads outside the project through a link" when a link, such as a symlink or a Windows junction, sat at `autos/.renders/<name>.svg`; it now removes that link itself, never following it, and writes the render in its place. A `.renders` folder that is itself a link is still refused.
- **The file format refuses or repairs odd input** (#377). A shared projection nested deeper than 32 levels is refused with a schema issue instead of crashing the reader. A positive-only number such as `timeoutS: 0.0004` saves as `0.001` instead of `0`, so the file loads again. A file with no `$schema` gets the current id on save; files that have one are unchanged. Provenance such as `UNMEASURED` or `NOT MEASURED` ranks as unverified, and measured and derived labels count only as whole words. An estimate expression naming `toString` or another built-in gives no number instead of NaN.
- **Generated Java and the runtimes match the sim** (#372). `zenith codegen` writes a path step of 2 in or less as `TurnInPlace` with its markers beside it, decides at run time whether a path from `"current"` turns in place or follows the path, gives parallel members whose ids read the same in camelCase (`arm-1`, `arm1`) separate locals, and ends piecewise heading ranges at the segment t the runtime uses. An unregistered end condition on a path from `"current"` fails at init on both runtimes. A robot frame that moves the field without turning headings moves a `facePoint` target too, and `argInt` refuses a whole number outside the `int` range instead of clamping it.
- **Path markers** (#371). A path cut short by its `endCondition` no longer starts every marker it had not reached: only markers the robot passed fire, on the robot, in the instant sim and in generated Java. Two markers on one path that need the same subsystem no longer run at once; the later one interrupts the earlier one, as the scheduler would. A marker no longer fires on the previous path's progress before the follower has picked up its own path.
- **The instant sim and traces** (#376). A turn on the spot ends when its `endCondition` comes true, as on the robot. Ideal playback turns from the heading the robot arrives with, so a turn after a cut-short turn no longer swings back to the planned heading first. A run stopped after a step no longer reports a timeout or condition for a step it cut off. A trace's duration is its latest step end, so a short last child of a parallel group no longer shortens it, and a trace with step times that are not finite, or end before they start, is refused with the step named.
- **Checks through waits, intake stops and branches** (#375). A wait, transfer or non-driving command between a `movesRobot` command and the next path no longer hides the MOVES_ROBOT error, and the path no longer starts at a stale pose. A marker that stops the intake ends its running stretch there, so MOUTH_LEADING and SWEEP_SPEED still check the part before it; each branch arm starts from the intake state on entry. A stretch's heading is averaged the short way, so short westbound paths no longer get a spurious MOUTH_LEADING. Splitting a linear range that turns the short way across π keeps the turn, and a Linear heading sweeping more than half a turn over several segments becomes one range per segment when made Piecewise or split on the canvas.
- **Opening and saving projects** (#380). In the desktop app, a file changed on disk is reloaded only if it is still the open auto with no unsaved edits. A project zip is read at the paths `zenith.json` names, so a backup `robot.json` elsewhere is ignored and a robot file with another name loads; a zip without `zenith.json` with two files of one name is refused. The first save of a new auto no longer writes over a file it could not read, or one whose name differs only in case. When sign-out cannot clear the offline copy, the cloud keeps working without a reload and keeps nothing on disk, waiting changes stay in the Outbox, and Zenith says the copy was not cleared.
- **The time estimate** (#374). A race that a member's timeout ends is timed at that timeout. A branch side with a step of unknown length keeps the time of its known steps, so TIME_BUDGET sees it. TIME_BUDGET's optimistic end leaves out paths that end on a condition, and the upper-bound note stays when the total is over the period. The "at least / at most" label leaves out race and deadline members the group stops early, and a move shorter than 2 in is timed instead of drawn as instant.
- **Team keys and shares** (#378). A key rotation made with only the recovery code can no longer raise a role or the sharing setting, whichever member it claims to be, or give the key to a device nobody approved; Zenith refuses such a rotation before writing it, with a plain message. A remembered team open is used only while the team's whole public key is unchanged, so a swapped signing key cannot show a false safety code. A share's signed manifest now names the projection it shows, so the database cannot put back an older version of a followed auto.
- **The ledger** (#373). A parallel group whose deadline member stands still ends where the member that drives leaves the robot. When the ledger can tell a branch takes its `else` side, later steps launch and transfer from where that side leaves the robot. `expect.count` beside `collectFrom` is only a collect count. Members of a `deadline` or `race` group that start after the group ends are skipped, and path markers that launch or tip change the ledger at their place on the path. Pieces launched at a target that is not on the field land loose, with a new `LAUNCH_TARGET` warning. `Own` and `Opponent` work in collect ids, a location id such as `toString` is refused as unknown, and "move to legal approach" keeps an off-field pose inside the up cell's quarter.
- **Optimize path** (#379). A route that makes a later step in its scoring window time out, when the original does not, is refused instead of scored as faster. With heading ranges off, no route with piecewise ranges is offered. Stopping in the first few evaluations gives the same result as a budget of that many. The swept clearance test keeps the rotation bulge at a fixed end inside the margin, and grows every box by how far a curve can leave the straight line between two samples.

- **Optimize path ends on its own result, and says what it found** (#434). Its default budget was chosen from what one candidate costs to score, which is about a quarter of what a run costs, so a typical step took 7 to 9 s and nearly every run in the editor met the 5 s safety stop and read "Stopped early: no faster route yet." with Apply off. The bench (`scripts/bench-optimizer.ts`) now also times a whole run on every path step, and the budget is 250 evaluations, about 2.7 s a run, the smallest at which the OPT-10 Contract still holds; on the example the same routes are found in 1 to 3 s. Every pose the optimizer places now carries `SET FROM EDITOR: placed by Optimize path`, so an optimized route no longer adds a "where did this come from?" note on its own step. A run stopped before it found anything says "no clear path yet" for Add a clear path here and "no clear route yet" round a blocked path, and its Apply says to search longer; a clear path with no route says so instead of naming an original it does not have; the same finding cleared or added several times is said once with its count ("Clears 3 errors: hits a field element."); Optimize every path lists a path the safety stop cut short as stopped early; and `zenith optimize` names the centre line instead of printing `""`.
- **Optimize path finds a clear route for a path that goes through something** (#388). A path through a structure, past the wall, into a keep-out or over the centre line (a `STRUCTURE`, `PERIMETER`, `KEEPOUT` or `OPPONENT_SIDE` finding on it) used to get "no faster route" from Optimize path, because nothing legal beats a shortcut through the hive frame. Every entry point (the toolbar button and menus, Optimize every path, `zenith optimize` and `zenith.optimize`) now applies the Route around rule on its own: it returns the fastest clear route found, even a slower one, says what the original goes through and how the new route's time compares, and says no clear route joins the step's ends (infeasible) when there is none; Optimize every path counts such steps as cleared, not as time saved, and `OptimizeResult` gains `originalBlocked` (spec 16 section 4.4 step 7). A path that the checks pass is never called blocked, even where the swept tests see it come within the margin or ride the wall in the instant sim, as the starter's toScoreNorth, sweepGarden and driveBack do: a new route must then be faster and come no closer to anything than the original, so it is improved or no better, never infeasible, and a heading change at the same time is no better. Round a blocked path, the best clear route is the pick even when it is faster only in the instant sim, and it keeps that label. An explicit Route around (a finding's button and Add a clear path to here) is the exception for the margin: a `CLEARANCE` finding on the step, or a path that comes closer than the margin to anything, counts as blocked for it, so the route it returns keeps the whole margin even when that is slower, and says the original comes within the margin.
- **The playhead stops at the routine's end, and the folded Ledger says what was collected and
  launched** (issue #316). Step forward (`.`, or your own key for it) no longer runs the playhead
  past the total the scrubber shows, by any Playhead step, and an edit that makes the routine shorter brings a playhead past the new end back to it.
  The folded Ledger's one line now reads like "4 pollen in, 3 launched" instead of a count
  of changes.
- **R on a waypoint keeps its heading in range** (#318). Turning a selected pin with Turn (`R` or Shift `R`, or your own key for it) now wraps `headingRad` into (-180, 180] by any Rotate step, so 80 presses of 5 degrees from 90 degrees read 130 degrees, not 490, and `waypoints.json` never gets a heading past a half turn.
- **Alt + Up and Alt + Down move a step into and out of groups, as a drag does** (issue #317). At the top or bottom of a group the step leaves it, landing just before or after the group; next to an open group it goes inside, as its first step going down or its last going up; a folded group is passed over whole. A step that is the only one in a sequence or parallel group is refused in plain words, by the keys or a drag, and so is deleting it: "clearThenSpinUp is a sequence and needs at least one step, so readyLauncher cannot be deleted", in place of the schema's text. A rename refused because another step has that id keeps the step being renamed selected.
- **GitHub mode lists repositories in a browser** (found while building issue #213). The GitHub
  client called the browser's `fetch` as a method of itself, which a browser refuses with "Illegal
  invocation", so the Open project dialog's GitHub tab never listed a repository after sign-in.
- **Arrows, Enter, Space and R on a focused step row act on the list, and a held key is one undo** (#161). `↑`, `↓`, `Home` and `End` on a row select and focus the previous, next, first or last row, `←` and `→` fold and unfold a group, `Shift` with `↑` or `↓` extends the multi-selection, and `R` does nothing, where they used to nudge or turn the step's end and unlink its waypoint; one row is in the Tab order, so `Tab` leaves the list. Nudge and turn keys skip a button, link or field inside a panel. With no point picked, an arrow no longer moves the end of the selected step when it follows a waypoint or is `"current"`; the status line says to select the waypoint or click the end on the field. On the only selected row or timeline block, `Enter` opens the insert menu and `Space` plays; on any other row they select it. `Space` works from the scrubber, and the Step back, Step forward and level buttons no longer take focus when pressed. A held arrow or `R` is one undo step, so one `Ctrl Z` links a nudged end to its waypoint again.
- **Wrap in a branch follows the rules of the other wraps** (issue #312). Steps with others
  between them are refused with the same reason Wrap in a sequence gives, instead of being pulled
  together at the top of the list and changing the routine. Wrapping a deadline group's deadline
  step in a branch passes the deadline to the new branch, so the group no longer names a step it
  does not hold and Problems no longer shows a SCHEMA error.

- **An Inspector number shows the number the file keeps, and writes only real edits** (issue #314). A typed value that rounds or clamps back to the value already held, such as a count of 3.6 kept as 4, a speed of 1.5 above its maximum of 1, or a piecewise range end typed past its neighbour a second time, no longer stays on screen as typed. Arrow keys round to the field's decimals as a drag does, so three Up presses from a speed of 0.30 write 0.45, not 0.44999999999999996. Typing the value a field already holds, or any edit that leaves the file the same, adds no undo step.
- **Undo and redo never leave the selection on something that is gone** (issue #315). Undoing an
  Add path click clears the selection on the path it removed, so the arrow keys, R and Delete no
  longer act on a step the auto does not have, and undoing a rename of the selected waypoint takes
  the selection back to the old name (redo takes it on to the new one) instead of leaving the
  inspector on a waypoint `waypoints.json` no longer has. Any step, point, marker or waypoint an
  undo or redo removes is dropped from the selection.

- **Right-click on a selected path near its start gives the path menu** (#320). With a step selected, a right-click where its heading arrow handle sits on the line gave the empty-field menu; it now gives the path menu, with Make curve, Insert a path, Marker and Split path here. 
- **Settings, Robot: the provenance menu opens over the window, and the close hint tells the truth**
  (issue #313). The menu a Robot value's provenance chip opens was drawn under the Settings window,
  so neither a click nor the keyboard could reach it. Menus and choice lists opened inside Settings
  now draw over it and keep focus inside the window; Escape or Tab out of the menu closes it and
  goes back to the chip. While Robot has an unsaved change, the close button's hint names the
  unsaved `robot.json` instead of saying everything is saved.
- **Signing out no longer drops waiting changes without a word** (issue #319). Signing out clears the
  offline cache that holds changes still waiting in the Outbox, so Settings now asks first, in the
  Account pane, when any are waiting: **Stay signed in** keeps them for the Outbox to send, and
  **Sign out anyway** drops them. A dropped change reads **Dropped** in the Outbox, with "Signing out
  dropped this before the server confirmed it. It may not have reached the server.", instead of
  **Refused**, and the Outbox summary counts dropped changes instead of saying "Everything is sent".
  A write refused as signed out while nobody signed out, such as with an expired sign-in, still reads
  **Refused** with its own message, and a sign-out that fails puts the changes back in the queue.
- **Your start offset belongs to one auto** (issue #193). "Delay my start" no longer carries over
  to the next auto and hides its own predicted collision. Each auto of a project keeps its own
  offset, going back to an auto finds it again, and when an auto opens with none the status line
  says where the last delay stayed. Opening another project or Load example clears the offsets;
  loaded partners stay.
- **Shift locks a path line's direction, not the point's press axis** (issue #188). Holding Shift
  while dragging a path end or node used to pin it to the horizontal or vertical line through where
  it was at the press, so a diagonal line could not be made shorter than its offset on that axis.
  Now the end stays on a line from the other end of its path, at the line's own angle or the
  nearest 45°, goes to the pointer's projection onto it and can be as short as you like; the length
  rounds to half an inch, a waypoint catches it only if it lies on the line, a wall moves it along
  the line, and the line is drawn while you hold Shift. The Add path preview and click do the same
  from the end the new path continues from. The start, pins, curve handles, facing points and
  envelopes keep the one-axis rule.
- **The field stays whole while you pan and zoom, and Zoom to fit takes in the routine** (issue
  #151). A pan, a wheel zoom or a fit no longer shows the empty well where the field was off screen
  until the view stops. Zoom to fit, and the fit when an auto opens, frame the routine's start,
  paths and curve handles with room for the robot round them, keep that area through a resize, and
  leave the Play button and the count chips clear of the wall.
- **The Add path tool shows where its point will land, and a snap onto a waypoint follows it**
  (issue #150). The dashed line and the corner readout showed the raw pointer while only the click
  snapped, so a point near a wall landed up to 11 in from where the preview drew it, and "Add a path
  to here" did not snap at all. Now the preview, the readout (which names the snap, such as `wall` or
  `waypoint park`), the click and the menu item place the point the same way, also while the pointer
  holds still through `Esc`, a tool key, a zoom or a held key. A path end that snaps
  onto a waypoint, by a drag or by an Add path click, follows it (`{ "ref": ... }`) instead of
  copying its numbers as SET FROM EDITOR, and the status line says so; an end that already followed
  the waypoint keeps following it, and a curve handle snapped onto a pin keeps the waypoint's
  provenance.
- **Where paths overlap, a click keeps the selected step, and `Alt` + click reaches the ones under it**
  (issue #149). A click, a hover, a double-click and the context menu on overlapping paths always
  went to the step drawn last, even on the selected step's own path, so a double-click split the
  wrong step and nothing reached the steps underneath. Now the selected step's markers and path come
  first, then other steps' markers and paths, and a double-click on an overlap splits the selected
  step. `Alt` + click with the select tool selects the next step under the pointer, and repeated
  `Alt` + clicks at one spot visit each step there in turn. On a point, the start mark or a waypoint
  pin, which sit on top of the paths, `Alt` + click does what a click does.
- **Escape, Shift, a second finger and a nudge after a drag are safe during a press on the field**
  (issue #148). `Esc` during a drag cancels it: what it moved, turned or drew goes back, with no undo
  entry, and the selection stays, where it used to clear the selection and let the drag commit. A
  drag the browser cancels is cancelled the same way. A second finger on the field is ignored until
  the first lifts, so it can no longer leave the drag's undo step open and make later edits
  impossible to undo. Holding `Shift` before pressing a selected point moves the whole selection
  along one axis, not that point alone, and dragging a point selects it, so the arrow keys and `R`
  act on the point you dragged rather than the step's end.
- **A path point's heading row and `R` act on the heading mode** (issue #147). A path point's own
  heading in the file turns nothing, because the step's heading mode alone decides which way the
  robot faces, yet the inspector let you type it and `R` wrote it, unlinking a point that followed
  a waypoint. Now each From and To shows the heading the plan gives the robot there, read only, with
  what decides it; **Set it** changes Constant's angle or Linear's From or To, and under Tangent,
  Reverse tangent and Facing point **Switch to Linear** makes it one you can set. `R` on a path point
  turns what that end's heading arrow turns, and where the path or a joint decides the heading it
  changes nothing and says why on the status line. The hover bubble, the drag readout and **Save as
  waypoint…** use the planned heading, and the Add path tool no longer writes a heading into the new
  path's end. A waypoint saved from a point whose own heading is not the planned one is labelled SET
  FROM EDITOR, so a measured or hand-set label never covers a heading Zenith worked out.
- **The point a split adds moves as one point, so the path never tears** (issue #146). Where one
  segment of a path ends and the next starts, dragging, snapping, nudging, turning with `R` or
  typing the point moved only the first segment's end, which left a gap and a CONTINUITY error. Now
  both ends move in one edit and one undo step, in the editor and through `zenith.edit.setPose` with
  `joint: true`. A gap between two segments has its own help and a one-click fix, **Join path N to
  path N-1**. The inspector and `R` say that the step's heading mode decides the heading at such a
  point. Dragging or nudging a curve's control point no longer writes a heading into it, and the
  control points a split curve gets are marked SET FROM EDITOR.
- **The legal-start fix leaves a runnable auto, and start findings select the start** (issue #155). With the start dragged to (-40, -40), Move the start to the nearest legal spot put it at (-42, -63) facing north, so driveOut turned the robot about 48 degrees against the south wall and START_ILLEGAL became PERIMETER; it now checks the whole auto from each of the 40 nearest legal starts and takes the first that adds no new error and lets the first path leave facing the way the robot starts, then tries them turned to that path's start tangent, and otherwise keeps the nearest and names the error on the status line. A PERIMETER, or a STRUCTURE, where the robot turns on the spot as a path starts offers Turn while driving, a linear heading from the way it faces to the way the path ends. Clicking a START_ILLEGAL row selects the start, pauses and puts the playhead at 0, and the start mark and its outline are drawn in the error colour, over the robot.
- **Timeouts bound the time estimate, and a wait that could wait forever warns** (issue #154). The starter's time budget note called its 24.0 s a lower bound that "may not fit", named no step and selected nothing; it now reads "The routine fits the 30 s period even if waitForFull runs its full 1 s timeout (25.0 s)", and clicking it selects waitForFull. A wait until a condition with no timeout raises the new WAIT_NO_TIMEOUT warning, whose fix puts the cursor in the Timeout field, and a race of such waits warns on each of them, since none of them is sure to end it. A timeout shorter than its step's estimate is now a TIMEOUT_TIGHT warning that says where the robot is stopped, the estimate counts the step only up to its timeout, the Ideal level stops the robot there and drives the next path's start as a transition, and "Raise the timeout to N s" sets 1.2 times the estimate.
- **Turning a line into a curve keeps it on the line, and Make curve is easy to find** (issue #143).
  Kind Curve in the inspector put the new control point at the field centre, with no provenance,
  whenever either end of the segment was the last step's end or a waypoint, which is every path Add
  path makes and almost every starter segment, so the curve swung through the hive and raised
  STRUCTURE errors. The control now goes in the middle of the segment's own ends, as the planner
  resolves them, labelled Set from editor, so the new curve lies on the line and the problems and the
  estimate stay as they were; drag its hollow square to bend it. When Zenith cannot work out where
  the segment is, it says so and writes nothing. Make curve and Make straight line are also in a
  path's right-click menu, for the segment under the pointer, and in the command palette.
- **A parallel group's deadline, a wait and a path's speed can no longer make an auto invalid or
  lose a setting** (issue #144). Switching a group to deadline now names its first step that drives,
  switching it back takes the deadline out of the file, and an empty deadline or one outside the
  group is refused in plain words. When the deadline step is dragged out of the group or deleted, the
  group makes the same pick again from the steps left, so it is never a deadline group with no
  deadline. A wait shows one Wait for choice, A time or A condition, with only that field, and each
  switch says how to undo it, where typing seconds used to drop the condition silently. `Ctrl Z`
  and `Ctrl Y` now undo and redo a pick in any choice list straight away, while the list still has
  the focus. An empty Speed fraction shows the robot's default, Use the robot default goes back to
  it, and the arrow keys work on an empty Speed or Timeout. `↓` or a drag to the left on an empty
  Timeout leaves it at none, rather than writing its 0.01 s floor.
- **A drag across a number field is one undo step, and its text can be selected** (issue #145). A
  scrub in the inspector added an undo step for every pixel, so one gesture took many `Ctrl Z`, an
  angle turned 5° per pixel, and a press-drag in a field you were typing in scrubbed it instead of
  selecting its text. Now a field you are not typing in scrubs once the pointer has moved 3 px,
  counted from there so the value does not jump, at 4 px per arrow step and 1° per pixel for an
  angle, as one undo step, and `Esc` during the drag puts the value back. It writes only numbers the
  field can show, rounded to its decimals, so a count such as Holds at start stays whole and the
  file keeps the Speed fraction the inspector shows. A click puts you in the field with its text
  selected, and a drag in a field that has the focus selects text. Neither a scrub nor a drag on the
  heading ranges' track counts as the tour's "drag one of the dots" task.
- **Duplicating or moving a deadline group's steps keeps its deadline valid** (issue #160).
  Duplicating a deadline group, or a group that holds one, left the copy's deadline naming the
  original's step, a SCHEMA error that stopped the Code tab writing any Java; the copy's deadline
  now names its own copy of that step. Dragging the deadline step out of its group no longer leaves
  the group naming a step it no longer holds: the deadline passes to the group's first remaining step
  that drives (issue #144), and the status line names it and says to pick another in the Inspector
  or press `Ctrl Z`.
- **`zenith init` sets up the OpModes, and `zenith deploy` says when it writes none** (issue #156).
  `zenith init` writes a `codegen` section, takes `--robot-class`, prints a `ZenithRobot` class it
  finds as a suggestion without writing it, and ends by saying to set `deploy.robotClass`. Without a
  `codegen` section, `zenith deploy` warns that no OpMode was written, so the Driver Station will not
  list the autos, and `--json` has `"stubs": false`; the desktop app's Deploy no longer says the stubs
  were written, and the Code tab shows the exact `codegen` JSON to add.
- **The time estimate counts the turns at path joints** (issue #153). Where a tangent path starts
  facing a different way from how the last one ended, the robot turns in place before it drives, and
  the estimate now times that turn at `maxAngularVelRadPerS` as part of the path step, under its band.
  A zigzag that read 25.84 s of 30 s while the ideal run took 32.39 s now reads its real total, goes
  red over the period and raises TIME_BUDGET. The Ideal level plays the same turn inside the step, so
  its total matches the estimate unless a path starts somewhere else, and the timeline draws the turn
  as the hatched start of the path's own bar.
- **STRUCTURE and PERIMETER report the real depth, once, with a name a student can find** (issue #152). Driving across the 1 in hive frame bar read as a 1.00 in graze; the depth is now how far the robot would have to move to get clear, and the message says how long it stays in contact, such as "drives into the west base bar of the hive frame (frameBarWest) for about 56 in (t 0.15 to 0.85), up to 9.50 in deep". The field tints that whole stretch, the ghost sits in the middle of the deepest part, and pointing at the row outlines the obstacle. A collision the robot then stands in through a wait, a command and the next path's start is reported once, on the step that drove into it, instead of on every one of them.
- **A saved New auto is listed, and a later New auto never writes over it** (issue #157). Saving a
  New auto in a folder or the desktop app now puts it in the auto picker, the palette and the waypoint
  followers. New auto and an import list the autos folder again before they pick a name, and the
  first save of a new auto whose file has appeared on disk writes nothing and says so.
- **Saving the example opens what was saved, and Just this auto checks the waypoints first** (issue
  #158). Save on the unsaved-edits question, before another of the example's autos opens or a New
  auto starts, now opens the folder Save the full project wrote, and that auto opens from it; before
  another project replaces the example, the row says to open the folder later. The example keeps
  what Save wrote, so the auto reopens with its edits. Just this auto says how many waypoints the
  auto follows, reads the picked project's `waypoints.json` first, and when some are missing or
  somewhere else lists each with both poses and offers to give those points their own poses, to add
  the missing ones to that file without changing any name in it, or to follow that project's own;
  Cancel writes nothing. A save that leaves errors there says so in a warning instead of "Saved".
  The desktop app picks the project, then writes, in two steps.
- **Opening a robot repository with no zenith.json offers to set Zenith up there** (issue #159).
  Open folder used to stop at "Could not read zenith.json in this folder."; it now shows Set up,
  which reads TeamCode, prefills the robot class from the class that implements `ZenithRobot` and
  the command library only from an import that names one, and writes `zenith.json` (no sim command,
  and a `codegen` section only with a robot class), `robot.json` with the commands the code
  registers, `waypoints.json`, the season's field and one auto, never over a file, then opens the
  folder and shows the Gradle lines; the palette and the welcome screen point to it, and the desktop
  app's main process builds `zenith.json` itself. Save the full project on the example now leaves
  out its sim command, robot class and command library and writes only into an empty folder, never a
  robot repository.
- **A start that follows a waypoint can be moved** (issue #133). The starter autos start at the
  waypoint `start`, and their start could not be dragged, turned or nudged. Now dragging, turning or
  nudging it, or taking **Move the start to the nearest legal spot**, gives it a pose of its own
  where it is dropped, and a path whose first point sits on the start moves with it. A path point
  that follows a waypoint is unlinked the same way when it is dragged or nudged. The status line says
  what no longer follows which waypoint, and one undo links it again. In the inspector, for the start
  and for a segment's From and To alike, **this pose** keeps the point where it stands, with the
  waypoint's provenance when it followed one, instead of moving it to the middle of the field, and
  **a waypoint** picks the waypoint at the point's spot, or the nearest one, instead of the first by
  name.
- **Escape leaves the tour straight after Next** (issue #139). Each stop's card took focus a frame
  or two after it appeared, so a key pressed at once went to the page: Escape cleared the selection
  and left the tour open, and a second quick arrow went to the editor, where it nudges a selected
  point, instead of moving the tour on.
  The new card now takes focus as it appears.
- **Ctrl and = zooms in on the desktop app** (issue #114). Zoom In was bound to Ctrl and Plus, which
  on a US keyboard needs Shift, so only zooming out worked from the keyboard. Zoom In now answers
  Ctrl and =, Ctrl, Shift and =, and the numeric keypad's plus; Zoom Out also answers the keypad's
  minus.
- **The field pans the way Onshape does** (issue #115). Drag with the middle mouse button, or hold
  Ctrl and drag with the right button, to pan the field; the cursor shows a grabbing hand while it
  pans. The browser's middle-button autoscroll no longer starts on the field, and a Ctrl + right drag
  opens no menu. A plain right-click still opens the field's menu, Space + drag still pans, scroll
  still zooms about the pointer, and a double-click on empty field fits it again.
- **The window buttons stay clear of the toolbar at every zoom** (desktop, issue #122). Zoomed out
  with Ctrl and -, Windows' minimise, maximise and close buttons no longer cover the right end of the
  toolbar: the title bar grows to their height, and its right end always leaves exactly their width.
  The menu that the title bar's menu button opens also appears under the button at any zoom.
- **The example auto plays BIOBUZZ the way a team would** (issue #113). `collect-and-score`, the
  auto the app opens with, shoots all four preloaded pollen in one volley as soon as it drives out,
  which tips the hive. It then drives under the hive to the other side, where the up cell now is,
  takes four pollen from the north flower and scores them, sweeps the RED garden line and scores
  again for the second tip, inside the 30 s period. `cycle-and-park` and `all-step-kinds` also shoot
  all four preloads at once, collect along the garden line and score from the up cell's side, and
  `cycle-and-park` parks partly in the loading zone. The starter's waypoints gain `scoreNorth`, the
  flower poses and the garden sweep poses, and the docs that quote the example follow it.
- **The BIOBUZZ hive and human player follow the manual and DSim** (issue #95). A tip dumps its
  cell onto the floor quarter on that cell's side instead of an unknown place, and the down cell is
  always empty. The tip table's last row holds past its end, so 5 or more nectar tip a cell. This
  robot scores only from the up cell's floor quarter, and its pieces land loose from anywhere else.
  The robot's hopper is last in, first out. A hive cell gives nothing back. Only the routine's own
  alliance's nectar goes into its robot or hive, and the Ledger shows only its own hive and human
  player. The human player brings in one nectar per tip of its own hive, five in all, onto its own
  loading zone.
- **The count circles on the field are centred.** The number in each circle that counts the game
  elements at a place now sits in the middle of its circle on both axes, at every zoom and display
  scale, and a flower's count circle is centred on the flower's disc and on its top ring's target.
- **A marker can be edited where you expect it.** Placing a marker with the Marker tool, or clicking
  one on the field or in the path's Markers list, now selects it and opens a **Marker** section at the
  top of the inspector: the command it fires (from `robot.json`), that command's settings, where along
  the path it fires, and **Remove marker**. Before, the only marker editor was at the bottom of the
  path's inspector, below the fold, and nothing pointed to it. `Del` with a marker selected now removes
  the marker, not its whole path.
- **The tip cost reads the nectar in the up cell.** The ledger indexed the tip table by how many
  times a hive had tipped and compared it with every piece in the up cell, so the first tip cost 5
  pollen on top of the 3 staged nectar. The table is the pollen needed for the nectar in the up cell,
  so the first tip costs 3 pollen and the next, with the nectar spilled, costs 8. The hive and end
  rows say how much pollen the up cell still needs. An `assumeTipped` after a volley the table says
  tipped the hive now confirms that tip instead of swinging the hive again. The starter autos that
  score twice from the south now launch two of the preload first, so the second volley still has a
  legal approach.
- **A removed member is told which team they left.** After an owner or admin removed them, the
  Teams sheet said only "You are not in a team yet." It now says "You are no longer a member of
  36596 Horizon. If you did not leave, an owner or admin removed you. Ask them for a new invite to
  come back."
- **Removing a member keeps the status line short.** The long notice about the recovery code and
  links filled three lines of the status bar, and at 1280 by 720 its end sat under the Teams sheet.
  The status line now says "Removed the member. See Teams for what to do next.", and the whole notice
  stays in the Teams sheet.
- **Share no longer says nobody can see an auto that is shared.** Opening Share on an auto that
  already has a share led with "Nobody outside your team can see this auto yet." It now says "Add a
  team number to share this auto with another team." until a team is chosen.
- **A partner's changed safety code is called out.** When a team that shared with you replaced its
  team key, the Partners panel showed the new safety code under the same "First share" words. It now
  says "Team 36596's safety code changed, because they replaced their team key. Compare the new code
  with them before you trust this share", followed by the code.
- **A text field's tooltip no longer covers what is under it while you type.** Clicking or tabbing
  into a text field opened its tooltip below it, over the field's own buttons and error line: the
  user-code line on the private-beta screen, Add tester and Add admin in Beta access, and the Create a
  team form. A field you type into now shows its tooltip only on hover while it does not have focus,
  and screen readers still read its words as the field's description.
- **The field's help button no longer sits on the ledger line.** The counts at the top right of the
  field ran under the `?` button, so the last one read "loose ?0" at 1280 by 720 and 1440 by 900. The
  line now ends to the left of the button.
- **A shot made illegal by an earlier step says which step.** When a transfer filled the hive's up
  cell, an earlier shot tipped the hive and a later shot got a `LEGAL_APPROACH` error that did not
  point back to either. The message now names the step after which the pose stopped being legal,
  what the ledger says changed there, and any transfer before it that moved pieces into or out of
  the target.
- **A save the host refuses reads as one sentence.** When DSIM refused a save, its reason already
  ended in a full stop and Zenith added another, so the line ended "then save again..". Zenith now
  adds a full stop only when the host's reason does not end in one.
- **The desktop window fits small laptop screens.** It opened at 1440 by 900 with a 680 px minimum
  height, which is taller than a 1080p laptop at 150% scaling (about 1280 by 672 once the taskbar is
  taken off), so the title bar and its window controls could open off screen. The first window is now
  fitted to the primary display's work area and centred on it, a saved window that no longer fits,
  such as one saved on a bigger monitor or at a lower scaling, is shrunk and moved back onto the screen
  it is mostly on, and the minimum size is 1024 by 600, never larger than the screen.
- **The field keeps its room in a narrow window.** The steps panel and the inspector kept their full
  300 and 320 px however narrow the window, so at 800 px wide the field was 180 px across. Below
  about 1150 px they now give way first, to 260 and 240 px at the least, which leaves an 800 px
  window a field half again as wide. Dragging a panel's edge starts from the width it is drawn at.
- **A proposed change counts segments the way the Inspector does.** A moved pose read "Move the to
  pose of segment 0 of s3" and a moved control point "control point 1 of segment 0" for the first
  segment's second control point, while the Inspector calls that segment Segment 1 and its points
  Control 1 and Control 2. Proposals, `zenith proposal apply` and review mode now say "Move the end
  of segment 1 of s3" and "control point 2 of segment 1"; the proposal file itself is unchanged.
- **Robot names on the field no longer print over each other.** With a partner loaded, each
  robot's name was drawn under its box, so two robots side by side read "Starter partnpartnIdeal".
  A partner's name now goes over its box, a line higher when another name is already there, and
  under it only at the top of the field; your own robot's name stays under its outline.
- **Delete removes every selected step.** With several steps selected (Ctrl or Shift and click),
  Delete removed only the last one clicked while the others stayed highlighted. It now removes them
  all as one undo step, with a group's own steps going with the group, and says so rather than
  deleting anything when that would leave the auto with no steps.
- **The insert menu opens where you can see it.** Opened from the command palette in a long step
  list, the insert menu's panes (Wait, Parallel group, Branch) opened beside an Insert button
  scrolled out of view, under the Ledger. The button now scrolls into view first, and the menu is
  placed again when it changes pane or a step is added while it is open.
- **Text boxes wide enough to read.** Text fields set in mono, such as an auto's name and authors
  in Auto details, a command's text setting and a proposal's share id, were the width of a number
  box, so "collect-and-score" showed as "collect-an" and "Horizon (FTC 36596)" as "Horizon (F", with
  the drag-to-scrub cursor. They are now as wide as the other text fields, and a field marked as
  prose, such as the title, is set in the UI face. An empty Timeout reads "none" instead of a blank
  box, and the dialog the palette calls Auto details is called that too, not Auto metadata.
- **Opening an auto says the right thing.** Opening any auto but the first in the bundled example,
  or in a project opened from picked files, reported "Cannot use autos/robot.json", because the auto
  names the project's own robot file and that kind of project cannot read a file twice; an auto that
  names the project's own robot or field file now simply uses it. An auto that cannot be read now
  says which file it is ("Cannot open a.auto.json: …"), and when it is the one a project opens first
  the message stays instead of being replaced by "Opened from files". An error from an earlier open
  goes away once another auto opens, and "A auto file" reads "An auto file".
- **Problems you can read.** A problem with two one-click fixes kept room beside its message for
  the fix buttons even while they were hidden, so the message wrapped one or two words to a line,
  and in a narrow window a long name ran under the code chip. The fixes now sit on a line under the
  message, which keeps the row's width, and long names wrap. With few problems, the collapse
  button's column no longer grows to half the panel, and the counts in the header no longer break
  over two lines.
- **Moved steps in a diff.** Adding a step, such as a wait from a proposal, reported every later step
  as moved in `zenith diff`, `zenith proposal apply` and review mode. Only a step whose order changed
  is reported as moved now.
- **The tour points at Save to DSIM.** In a window opened from DSIM, the tour's last stop said Save
  to DSIM sends the auto back, while its spotlight ringed the toolbar's check, play and simulate
  buttons. It now rings Save to DSIM on the right of the toolbar.
- **A path that turns against the wall says so.** When a path starts with the robot flush against
  the wall and the robot turns before it has moved clear, the PERIMETER finding now says that is the
  cause and offers the two ways out: drive straight off the wall first, or give the path a constant
  or linear heading. A tangent path drawn off a wall start did this, and the old message pointed at
  the end point, which was not the problem.
- **A start in the wrong half says so.** A BIOBUZZ start pose wholly in the other alliance's half
  was reported as crossing the centre line by, say, 72 in, which reads like a small overlap. The
  finding now names the alliance, says its own half is the side with its hive, and says the robot
  starts entirely in the other half. A start that only overlaps the line still gives the overlap.
- **No pause between two path steps in the preview.** The estimate added its settle time after every
  path, and the ideal playback held the robot still for it, so two paths in a row stopped and waited
  at the joint. The robot never waits there: it starts the next path on the same loop the first one
  ends. A path followed straight away by another path now costs no settle time, which also takes
  0.25 s off the estimate for each such joint. The robot still slows into the joint, because Pedro
  brakes into the end of every path it is given; two legs in one path step, as two segments, flow
  through without slowing.
- **The password page looks like Zenith.** The hosted build's password page, and the short page
  that reloads a window DSIM opened, still used the teal and grey the app dropped on 2026-09-22.
  They now use the app's night background, orange button, amber focus ring and rose error text.
- **Renaming a step works and can be found.** The rename field that opens on a double-click was too
  narrow to show a single letter; it now fills the name's cell and is never narrower than the name.
  Hovering a step's name outlines it, shows a pencil and a text cursor, and a tooltip says to
  double-click it or press F2 to rename.
- **Path steps are called paths everywhere.** The editor's help, the Problems panel's sideways,
  mouth and sweep-speed findings, and the note in a new auto said "leg". New path steps are now
  named `path1`, `path2` and so on, in the editor, in a new auto from `zenith new`, the MCP
  `newAutoFromTemplate` tool and host mode, instead of `leg1`, `path-2` or `leg`. Files that already
  use `leg` names open and save unchanged.
- **Command descriptions are shown whole.** A command's summary from `robot.json` was cut to one
  line in the insert menu and not shown at all in the inspector or the palette. The insert menu now
  wraps it, the palette shows it under the command's name, and the inspector's command pickers show
  the picked command's summary under them and every option's summary in its tooltip.
- **New users see the tour, including when DSIM opens Zenith.** The first-run tour only started
  from the standalone start page, and only when the address had no query at all, so nobody opened
  from a host (`?host=dsim`) ever saw it, and neither did anyone who followed a link with tracking
  parameters. It now starts once for a first visit when a host's project opens, with copy about the
  host's auto and Save to the host, and on the start page whatever unrelated query the link carries.
  Returning users still never get it by itself, and the help menu still replays it.
- **A new auto in host mode starts legal.** With no start waypoint, a new auto made for DSIM
  started at the field centre, which is always an illegal start. It now starts at the first pose
  touching a wall that the season's own start rule accepts for the field's alliance, found from the
  field's `startRules`, its size and the robot's footprint, and its path drives 24 in straight out
  from there. For the BIOBUZZ field and an 18 in robot that is (-12, -63) facing into the field.
  The start is marked NEEDS MEASUREMENT; with no start rule to check it still falls back to the
  centre.
- **The start pose can be dragged and turned on the field.** With the select tool, drag the start
  mark to move it with the same snapping as a path point, keeping its heading, or drag the heading
  arrow that appears on it to turn it (15° steps, 45° with Shift, free with Alt); click it to nudge it
  with the arrow keys. A start that follows a waypoint gets a pose of its own where it is dropped.
- **One logo everywhere.** The browser-tab icon was a separate 16 px drawing that did not match the
  logo in the app, the docs site used a different mark entirely, and the title-bar and README
  wordmarks used a redrawn, thinner Z. The favicon, the desktop app icon, the docs site's logo and
  favicon, and every wordmark now use the one Z from `brand/zenith-mark.svg`, generated from it, and
  `pnpm test` fails if any of them drifts from it.
- **An Inspector value left with Tab.** A number or text typed into the Inspector and left with Tab
  was dropped, so saving right after reported "Saved." with the old value. It is kept now, as it is
  with Enter.
- **Counts of one.** Messages such as "Downloaded 1 autos" and "1 steps" read "1 auto" and "1 step".
- **Host mode notices when the host's window closes.** Closing DSIM's tab while Zenith was open from
  it left Save to DSIM enabled until a save failed. Zenith now notices within a second: the bar says
  DSIM's window was closed, Save is off with the reason in its tooltip, and a Save a copy button,
  shown whenever the session is over, downloads the auto.
- **Host mode says why no project came.** A page opened for DSIM without a DSIM window behind it,
  which is what a blocked pop-up leaves, and a DSIM speaking another version of the host protocol
  both waited ten seconds and then said DSIM did not send a project. Each now says what happened at
  once and what to do. A save DSIM does not answer names DSIM instead of "the host".
- **Closing the desktop app with the example open keeps your edits.** The close question's Save
  started a download and let the window close before its Save As dialog could be answered. For the
  read-only example, and for files opened on their own, the button is now **Save a copy…**: it opens
  the Save As dialog, and the window closes only once the copy is written. Cancelling the dialog
  keeps the window and the edits.
- **The desktop menu's Ctrl+O is what Ctrl+O does.** File > Open robot repo… showed Ctrl+O, which
  opens the Open project dialog. The shortcut is now on a new File > Open project… item, and Open
  robot repo… goes straight to the folder picker, as before.
- **The desktop app's own keys are listed.** The shortcut sheet has a Desktop group, in the desktop
  app only, with F10 (the menu), Ctrl F5 (high-fidelity sim), Ctrl Shift D (deploy) and Ctrl Shift G
  (commit and push), and the sim, deploy and commit buttons show their keys in their tooltips and in
  the command palette.
- **Commit waits for something to commit.** With the open auto the same as in the last commit, the
  desktop Commit button is off and the panel says "Nothing to commit"; an edit or a save turns it
  back on. The desktop app also refuses such a commit itself, which before went through with only
  the auto's rendered picture in it.
- **GitHub sign-in in the desktop app speaks of the app.** It said the token was held "in this tab";
  it now says Zenith, "Remember until Zenith closes", and that the Commit panel keeps its own token.
- **The desktop tour says where your own autos come from.** Its end cards point at File > Open robot
  repo… in the ≡ menu.
- **`#/admin` says it is not in this version.** With accounts switched off, the admin address opens
  the same short notice as a share or invite link, instead of doing nothing.
- **`?cloud=fake` does nothing in a release build.** The in-memory demonstration cloud is only in
  development builds, so a published build shows no sign-in or sharing screen, whatever its address
  or browser storage says.
- **Constant and Linear keep the path's heading.** Switching a path from Tangent, or any other mode
  with no angle of its own, to Constant now holds the heading the robot ends the path at, and Linear
  turns from the heading it starts at to the one it ends at, instead of both starting at 0°.
- **The Ledger's end rows say what is held.** An end row reads "robot: empty" or "garden: 3 pieces"
  where it showed only the holder's name and kept what it held in a hover title.
- **One name for a partner's file: share file.** The Partners panel's **Load share file…** (it was
  Load projection…), its help, the palette's descriptions and the status lines all call it a share
  file. The file is still a `.projection.json`, and its format has not changed.
- **An auto in an older format says so when it opens.** Opening an auto written in an older
  `formatVersion` says that saving writes it in the current format, which older versions of Zenith
  cannot open.
- **Renaming a step from the keyboard keeps focus on the row.** After F2, Enter or Escape puts focus
  back on the step's row instead of dropping it to the page.
- **An empty Problems panel says the checks are live.** It reads "No problems found. Checked as you
  edit." where it gave the time since the auto opened or Validate was pressed, which looked stale
  straight after an edit.
- **Picking files without a folder picker names every file still needed.** Picking one auto file
  said only "Pick the repository's zenith.json too."; it now says a project needs zenith.json,
  robot.json and the season's field file picked together with the autos, and names each one missing.
- **An import says what Save will do.** After an import into the read-only example, the status line
  says Save downloads the auto, where it said Save writes it into the project.
- **The tour's last stop says what Save does in the example.** It said Save writes the file back to
  your robot's repository while the read-only example, where Save downloads, was open; it now says
  both. The desktop end cards still point at File > Open robot repo… for your own autos.
- **The insert menu shows each kind's help whole.** The line under Path, Command, Wait and the other
  kinds wraps instead of being cut with an ellipsis, so it no longer has to be read from the tooltip.
- **The file buttons in dialogs look like the app's buttons.** The browser's grey "Choose Files"
  button in Open project, and the Load trace button in Simulate, are drawn as the app's outlined
  button. They are still the browser's own file inputs, so the keyboard reaches them as before.
- **The status line leaves the steps column clear.** It starts at the steps column's right edge
  instead of the window's left edge, so the line shown after opening a project no longer lies over
  the Partners header for its 6 seconds. It still overlays the layout and moves nothing.
- **Choosing Instant sim no longer moves the playback controls.** The level total has its own line
  under the total at every level, and the Ideal track keeps the room the instant sim's band takes,
  so the scrubber and the level switch stay where they are when the level changes.

### Accounts, teams and sharing

In the published web app and the desktop app: anyone can sign in with GitHub, Microsoft or Google and
make or join a team, with no request and no approval from Horizon.
Release builds now carry the production cloud and fail to build without it. A build from source
without a cloud config has none of these controls, and a share, invite or admin link opens a short
page that says that build has no accounts.

- **Teams and sharing.** Optional accounts on a no-cost backend: sign in with GitHub, Microsoft or
  Google (13 or older, or with a school account the school approved), create a team, invite members
  with roles, keep autos in a team library that works offline, and share an auto with specific teams
  or anyone with the link. What leaves the team is a projection, never the auto file. Shares are view
  only, pinned to one version and last 7 days unless the sharer chooses otherwise, and the Share
  dialog says who can see what until when, with a preview. Changes made offline wait in the Outbox.
- **End-to-end encryption.** Team libraries, auto titles, shares and proposals are encrypted on your
  devices, and Horizon holds no key to them; compare safety codes before a first share that matters,
  since until then a first share trusts the key the server shows. Each device gets the team key from someone who types
  the approval code from the new device; removing someone changes the key; a recovery code opens the
  team if every device is lost; a link share's key is in the link after the `#`. The team's devices,
  roles, shares, share terms and proposals are signed, so a server that misbehaves cannot slip in a
  device or a key, roll a team or a share back, raise a share's level or make up a proposal. Each
  team's safety code is shown the first time you share with it, and a changed one is called out.
- **Sharing tools.** Include command names and Include the auto's name (both off by default), Update
  share, Extend to a date and time, Request more time, Withdraw a proposal, Keep a share for offline,
  Stopped shares and Share again, expiry warnings in the app, and a team-number status (unverified,
  verified or contested) beside each team's name. Proposals can be sent through the cloud on a
  propose-level share.
- **Team-number verification by review.** A team can ask for its number to be verified with evidence,
  and a Horizon admin decides, with one appeal.
- **Your data.** Export my data downloads what you wrote; Delete my account asks you to sign in again
  first, so a deletion never stops halfway; deleting a team deletes its data and revokes its shares;
  a daily clean-up deletes what the retention policy no longer keeps; the database caps a share and a
  proposal at 1,000,000 bytes. Bug reports go to a private collection only Horizon admins read. The
  privacy notice gives `privacy@horizon36596.org`.
- **The desktop app and the cloud.** Signing in happens in your own browser, and links made in the
  desktop app point at the public web app.

## [0.1.1] - 2026-09-25

### Fixed

- **CLI on Linux and macOS.** The `zenith` command installed from npm exited without doing anything,
  because npm links a bin there as a symlink and the CLI did not recognise itself through it. It now
  resolves the link. Windows was not affected. CI now packs and installs the npm packages and runs
  their commands on Linux on every change, which is where this showed.
- **npm.** 0.1.0 was not published to npm, because this fault stopped its publish run. 0.1.1 is the
  first version of the `@horizon36596/zenith-*` packages there.
- **A `timeoutS` on a group step.** The robot runtime used to honour a `timeoutS` on a `sequence`,
  `parallel` or `branch`, which the file format does not give those kinds and the editor drops, so a
  hand-written file ran differently on the robot from the way the editor planned it. Both runtimes now
  ignore it and show a `Zenith warning` line in init telemetry naming the step (`AutoFile.warnings`).
  Put the timeout on a step inside the group, or bound the group with a `deadline` whose deadline is a
  `wait`.
- **Waypoints in a mirrored routine.** `mirrorAuto` kept a waypoint reference as it was, so a mirrored
  file drove to the waypoint itself where the robot, running the original as the other alliance, drives
  to its mirror. Given the project's waypoints, `mirrorAuto` now writes a referenced pose as the
  mirrored waypoint's numbers. A caller that saves the result has to pass them.
- **BLUE files in the editor.** A file's `alliance` is the alliance its poses are written for, and
  the robot runtime mirrors a file only when it runs as the other alliance. The editor, `zenith render`
  and the MCP render mirrored whenever the view was BLUE, so a BLUE file opened on RED's half, the
  opposite of where the robot drives it, and a point drawn on a BLUE file was stored mirrored. They now
  follow the runtime: a file is drawn as it is when viewed as its own alliance, and mirrored only when
  viewed as the other, with every edit made there mirrored back. The start rules read a BLUE file's
  start against BLUE's own half and BLUE's loading zone, and `zenith new --alliance BLUE` writes its
  skeleton on BLUE's half. The file format is unchanged.

## [0.1.0] - 2026-09-25

The first public release.

### Added

- **Editor, web.** The Zenith editor as a static web app at
  <https://libraries.horizon36596.org/zenith/app/>, public, with no sign-in needed to use it. Draw
  paths with headings, attach commands, and see timing and findings update as you drag. Local mode
  opens a robot repository folder and saves in place in Chrome and Edge.
- **Editor, desktop.** A Windows installer and a portable exe on GitHub Releases, built from the same
  UI. Adds native folder open, file watching, the high-fidelity sim button with an automatic overlay,
  deploy, and commit, push and open a pull request. Not code-signed yet, so SmartScreen warns on first
  run.
- **Playback levels.** Three levels, chosen under the timeline's scrubber: **Ideal** (the
  default) follows the planned path exactly on the estimate's clock and turns or drives across any
  gap between steps; **Instant sim** is the preview sim; **Full sim** plays a loaded
  high-fidelity sim trace. The robot, the timeline and the readouts say which level they show.
  `idealTrajectory` and `idealPoseAt` in `@horizon36596/zenith-core` compute the ideal level.
- **Headings by Pedro's names.** The editor names each heading mode the way Pedro Pathing does:
  Tangent, Reverse tangent, Constant, Linear, Facing point and Piecewise, with the plain meaning and
  the Pedro call in each mode's tooltip. The values in the file did not change.
- **Heading arrows.** The selected path shows its heading as arrows on the field, which you drag to
  turn it: a Constant's two arrows turn together, a Linear's start and end turn apart. They snap to
  15° steps like points do.
- **Piecewise headings.** A `piecewise` heading mode gives each stretch of a path its own mode, as
  ranges of t from 0 to 1. Split a range on the inspector's track or with **Split heading here** on
  the path's right-click menu, and drag a boundary's tick along the path. The runtime follows it with
  Pedro's piecewise interpolator. It moves the auto `formatVersion` to 3; version 1 and 2 files load
  and are migrated.
- **Direct dot drags.** Any path's dot can be dragged straight away, without selecting its step
  first; the drag selects the step, and one undo puts the dot back.
- **Tour.** A first-run tour of six stops, then an optional tour of every feature. It is
  non-modal: every control in the editor works while it runs, and its card keeps clear of what it
  points at and of any open menu, tooltip or dialog.
- **One tooltip at a time.** Opening a tooltip closes any other, and keyboard focus opens a
  tooltip only when it came from the keyboard, not from a click.
- **Step kinds.** Path, command, wait (for seconds or until a condition), sequence, parallel (all,
  race or deadline) and branch (if/else).
- **Checks and findings.** Continuity, perimeter, keep-out, heading, capacity, legal approach, start
  legality and timing checks, each with a plain-language explanation and, where one exists, a
  one-click fix.
- **Instant sim.** A deterministic follower sim in the core that re-runs on every edit and drives
  playback, the hover robot and the timeline.
- **Provenance.** Every number in `robot.json` and `field.json` carries a provenance label, shown and
  ranked in the editor.
- **CLI.** `@horizon36596/zenith-cli`, which installs the `zenith` command: `init`, `new`,
  `validate`, `estimate`, `render`, `codegen`, `deploy`, `diff`, `sim`, `calibrate` and
  `propose --dry-run`. Every verb takes `--json` and none of them prompts.
- **MCP server.** `@horizon36596/zenith-mcp`, which installs `zenith-mcp`: the same work as MCP tools,
  plus structural edit primitives so an agent never hand-edits JSON.
- **Libraries on npm.** `@horizon36596/zenith-schema`, `@horizon36596/zenith-core`,
  `@horizon36596/zenith-seasons`, `@horizon36596/zenith-season-biobuzz` and
  `@horizon36596/zenith-github`, published with provenance.
- **Robot runtime, on Ivy or SolversLib.** The Java runtime that plays an auto file on the robot
  through Pedro Pathing v3, on JitPack as `com.github.Horizon-36596:zenith`. It builds the file into
  a command tree on either of two command libraries, both first-class: Ivy, Pedro Pathing's own
  (`com.pedropathing.ivy:pedro:1.1.1`), with the classes in `org.horizon36596.zenith.ivy`, or
  SolversLib (`org.solverslib:core:0.3.6`), with the classes in `org.horizon36596.zenith.solverslib`.
  The classes a team uses have the same names in both packages, and what names no command library,
  such as `Args` and `RobotClock`, is shared in `org.horizon36596.zenith`. One artifact holds both, and
  a team declares only the library its robot code uses. A new auto needs no Java edit. On either
  library, if a command left running from init blocks the routine at start, the OpMode fails and
  names what blocked it rather than doing nothing. See
  the robot runtime page and "Choosing a command library" on the docs site.
- **`deploy.commandLibrary` in `zenith.json`.** `"ivy"` or `"solverslib"`, the library the robot code
  uses. Zenith picks neither, and writes no Java until it is set: `zenith codegen` refuses without it,
  and so do `zenith deploy` and the desktop app's Deploy when `zenith.json` has a `codegen` section,
  because only then do they write OpMode stubs. `zenith deploy` writes stubs for the named runtime and
  names it on the first line of its output, the desktop app's deploy preview names it, and
  `zenith codegen` writes that runtime's form of the readable class. `zenith init --command-library ivy`
  or `--command-library solverslib` writes it into a new project; without the option, `init` leaves it
  out and says so.
- **Alliance mirroring, headings included.** A file run as the other alliance is mirrored through the
  team's `ZenithRobot.mirror`, poses and headings together, decided in one place
  (`AutoFile.mirrorsInto`). A `constant` heading and the start of a `linear` sweep go through the
  mirror, a `facePoint` point goes through it, a sweep keeps its size and turns the other way under a
  reflection, and every `piecewise` range is treated the same way. The runtime reads how headings move
  and whether turns reverse from the team's mirror, so a point symmetry and a reflection both work, and
  a mirror whose headings disagree with its positions fails at init. The editor's mirror to the other
  alliance keeps a `linear` sweep's size and direction the same way, and the robot tests check that a
  file run as the other alliance drives what the editor's mirror of it drives, on both runtimes, under
  a point symmetry and a reflection.
- **Conformance suite.** Every starter auto, and a fixture for every end rule, timeout, parallel mode,
  branch arm, marker kind, piecewise headings and three-deep nesting, runs through both runtimes in the robot
  tests, as its own alliance and mirrored, which fail unless every step, command and path starts and
  ends on the same loop on both.
- **Generated Java examples.** The starter's `cycle-and-park` auto (markers, timeouts, an end
  condition, a race, a deadline group with a sequence in it, and a branch) has what `zenith codegen`
  and `zenith deploy` write for it with each command library checked in under
  `examples/starter/generated/`, and a test fails if those files go stale.
- **GitHub mode.** Sign in with a fine-grained personal access token, edit on a work branch
  (`auto/<autoName>/<login>`), and propose a pull request whose body carries a rendered SVG, an
  estimate table and the end-of-routine ledger. Review mode draws the base and head of a pull request
  together from a `#/review/<owner>/<repo>/<number>` link.
- **BIOBUZZ season plugin.** The field file and rules for BIOBUZZ presented by RTX (FTC 2026-27):
  hives, tip table, flowers, garden and pollen, the legal-approach rule and the start rules.
- **Starter example.** A generic mecanum robot with one front intake, round PLACEHOLDER numbers, the
  BIOBUZZ field, waypoints and teaching routines that cover every step kind.
- **JSON Schemas.** Published at `https://libraries.horizon36596.org/zenith/schema/v1/<kind>.json`.
- **One version.** Every package, the desktop app and the Java runtime carry the version set in the
  root `package.json`; `zenith --version` and the MCP server report it.
- **Documentation.** The docs site at <https://libraries.horizon36596.org/zenith/>: getting started,
  the editor guide, a newcomer's guide to autonomous paths, the file-format reference, checks, sims,
  the robot runtime, choosing a command library, the CLI, agents and MCP, seasons, GitHub, and the FAQ.

### Changed

- **Schema ids.** The `$schema` ids moved to
  `https://libraries.horizon36596.org/zenith/schema/v1/<kind>.json`, where the docs site serves the
  schemas. Files that still carry the development ids under `zenith.horizon36596.org/schema/v1/` load,
  because the loader reads them as aliases, and are written back with the new id. The data format
  did not change, so no `formatVersion` moved.

[0.1.2]: https://github.com/Horizon-36596/zenith/releases/tag/v0.1.2
[0.1.1]: https://github.com/Horizon-36596/zenith/releases/tag/v0.1.1
[0.1.0]: https://github.com/Horizon-36596/zenith/releases/tag/v0.1.0
