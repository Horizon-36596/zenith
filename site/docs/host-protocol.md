# Host mode and the `zenith-host/1` protocol

Host mode lets another web app open the Zenith web editor in a popup window with a
robot project, let the person edit an auto there, and take the saved auto back. The first host is
DSIM, the FTC driver-practice simulator, whose robot builder already knows the robot and whose
simulator can run the auto. Nothing here is specific to DSIM: a host is a row in a table.

The code is `apps/web/src/project/`: `hostOrigins.ts` (the allowlist), `hostProtocol.ts` (the message
types and the validator), `hostBackend.ts` (the `ProjectBackend`), `hostSession.ts` (the browser side)
and `hostPanel.tsx` (the UI). The protocol types and the validator have no DOM and are unit-tested in
node; `apps/web/e2e/host-mode.spec.ts` drives the whole exchange from a fake host page.

## 1. Lifecycle

```
host                                              Zenith popup
 │ window.open("<zenith>/?host=dsim")  ─────────▶  loads, reads ?host=dsim
 │                                                 posts ready to window.opener, target "*"
 │  ◀─────────────────────────────  {type:"ready", protocol:"zenith-host/1"}
 │ {type:"open", protocol, project, …}  ────────▶  checks source and origin, pins the origin,
 │                                                 builds the project, opens the auto
 │                                   … the person edits …
 │  ◀─────────────────────────────  {type:"save", name, text}          (Save, Ctrl S)
 │ {type:"saved", name, ok, error?} ────────────▶  resolves the save, or fails it
 │  ◀─────────────────────────────  {type:"run", name, text}           (Simulate in DSIM)
 │ {type:"trace", auto, trace}      ────────────▶  lays the recorded run over the plan
 │   or {type:"runFailed", auto?, reason} ──────▶  shows the host's reason (optional)
 │ {type:"close"}                   ────────────▶  "DSIM closed this session", Save off
 │  ◀─────────────────────────────  {type:"bye"}                       (window closing)
```

1. The host opens `<zenith>/?host=<hostId>` with `window.open`, **without** `noopener`, because
   Zenith talks back through `window.opener`. `hostId` is a short name Zenith knows (section 3).
2. On load Zenith posts `ready` to `window.opener` with target origin `"*"`. It carries nothing, so it
   is safe to send before Zenith knows who the host is. It is posted once; the host should listen
   before it calls `window.open`.
3. Zenith waits up to **10 s** for an `open`. The first valid `open` pins the sender's origin.
4. Editing proceeds. Save posts `save` and waits up to **5 s** for `saved`. "Simulate in" posts `run`
   and waits up to **60 s** for a `trace`, or for a `runFailed` that says why the host could not run
   it.
5. The host ends the session with `close`, or the person closes the window, which posts `bye` (best
   effort: `pagehide` is not guaranteed). If the host's own window closes first, Zenith notices
   within a second, and at once when its window gets the focus back: the bar reads "DSIM's window
   was closed" and Save is off, as after a `close`.

If no `open` arrives within 10 s, Zenith shows a full page: "Zenith was opened for DSIM but DSIM did
not send a project. Open it again from DSIM.", with a button that continues to the usual start
screen (the same address without `?host=`). The same page, each with its own sentence, is shown at
once when `?host=` is present but there is no opener ("… not from a DSIM window, so no project can
arrive", which also says to allow pop-ups), when an `open` from an allowed origin names another
protocol such as `zenith-host/2` ("… the two are out of step. Reload DSIM and open Zenith from it
again."), and when the `hostId` is unknown.

## 2. Messages

Every message is a plain object sent with `postMessage` (structured clone, not a JSON string).

### Host to Zenith

| `type` | fields | meaning |
|---|---|---|
| `open` | `protocol: "zenith-host/1"`, `project`, `open?`, `readOnlyRobot?`, `capabilities?`, `newAuto?`, `newAutoStart?`, `hostBuild?` | Here is the project. Required first; a later `open` from the pinned origin replaces the project (asking first if the open auto has unsaved edits). |
| `trace` | `auto: string`, `trace: object` | A recorded run of `auto`, in the trace format `core.parseTrace` reads ([Simulation](simulation.md)). Laid over the plan when `auto` is the open auto; otherwise Zenith says so and ignores it. A `trace` posted right behind an `open` waits for that open to finish, so a host may send a project and a recorded run of it together. |
| `runFailed` | `auto?: string \| null`, `reason: string` | Optional. The host could not run the auto a `run` asked for. Zenith stops waiting for that run's `trace` and shows "DSIM could not simulate <auto>: <reason>". `auto` is the name from the `run`; without it, or with `null`, the answer is for the run Zenith is waiting on. With no run waiting (a trace already came, or the wait timed out), or for another auto, it is ignored. `reason` must be non-empty text; control characters become spaces and only the first 500 characters are shown. A host that never sends it gets the 60 s timeout instead. |
| `saved` | `name: string`, `ok: boolean`, `error?: string` | The answer to a `save` of `name`. `ok: false` fails the save and shows `error`. An answer nobody is waiting for is still shown on the status line. |
| `close` | none | The host has ended the session. Zenith shows it, fails anything pending, and disables Save. |

`project` is:

| field | type | notes |
|---|---|---|
| `name` | string, non-empty | The project's name, used when there is no `hostLabel`. |
| `hostLabel` | string, optional | The first line of the host bar, such as the host's name for the robot build. Without it Zenith uses `robot.name`. |
| `robot` | object or JSON text | A `robot.json` ([File format reference](file-format.md)). Validated on open. |
| `field` | object or JSON text | A `*.field.json`. Validated on open. |
| `waypoints` | object or JSON text, optional | A `waypoints.json`. |
| `autos` | `Record<autoName, string>` | Each value is the auto file's text (an object is accepted and serialised). May be empty. |

`open` names the auto to open first. `readOnlyRobot: true` shows the robot as the host's ("This robot
comes from your DSIM build. Change it in DSIM's robot builder."). `capabilities.simulate: true` means
the host answers `run` with `trace`; without it there is no "Simulate in" button.

`newAuto: true` starts a new auto as soon as the project is open, even though `autos` is not empty
(see below). `newAutoStart` is where a new auto starts (see below). `hostBuild` is the host's own
build number (see [Host builds](#host-builds)). All three are optional additions to `zenith-host/1`:
a host that leaves them out gets exactly the behaviour it had before they existed, and a Zenith from
before them ignores them. Like every field, each must have the right type when present (`newAuto` a
boolean, `newAutoStart` an object as below, `hostBuild` a whole number from 0 up), or the `open` is
dropped.

**Auto names.** An auto name may be `first-auto` or `first-auto.auto.json`; Zenith's file name is the
name with `.auto.json` added when it lacks it, and every message back uses the host's own name. A name
may not contain `/`, `\`, a control character, or be `.` or `..`. A new auto made in Zenith takes the
style the host used (suffixed if any of the host's names were, bare otherwise), so a host that sent
bare names gets `new-auto` back.

If `autos` is empty, or the `open` says `newAuto: true`, Zenith starts a new auto from core's
`newAutoFromTemplate` (the same template
`zenith new` and the MCP tool build): the field's canonical alliance, a start at the host's
`newAutoStart` when it sent one, else at the waypoint called `start` or the first whose name contains
"start", else a legal wall start Zenith finds (else a `PLACEHOLDER` pose at the field centre), the
field's `startRules.holds` as its preload, and one placeholder leg. It is unsaved until Save sends it.

**Where a new auto starts: `newAutoStart`.** `{ alliance: "RED" | "BLUE", xIn, yIn, headingRad }`,
the start the person picked in the host, as a pose on that alliance's side (file-format frame,
inches and radians; each coordinate within 1000 in). Every new auto made in that session, from
`newAuto` or from the auto picker's "New auto", starts there, mirrored onto the field's canonical
alliance by the field's own symmetry when the host's robot plays the other one, with the provenance
`SET BY HAND: the start picked in DSIM when this auto was made`. It wins over a `start` waypoint and
over the legal start Zenith would find. Zenith does not move it to make it legal: a start the season
rules refuse is reported like any other. The next `open` replaces it, and an `open` without it
returns to the rules above.

**Starting a new auto with `newAuto`.** A host that stores autos by name should send the autos it
already has along with `newAuto: true`, rather than an empty `autos`. Zenith names the new auto
`new-auto`, or `new-auto-2`, `new-auto-3` and so on when a name the host sent is taken, so two new
autos started one after the other never come back under the same name. `open` is ignored while
`newAuto` is true. Without the flag an empty `autos` still starts a new auto, as it always has.

### Host builds

A host page stays open for days, so the page someone uses may be older than the host's latest deploy,
and hand Zenith an old field or robot. An `open` may carry `hostBuild`, a whole number the host raises
whenever what it sends in `open` changes. Each host's row in `hostOrigins.ts` may set `minBuild`, the
lowest build this version of Zenith expects from it. When `hostBuild` is below `minBuild`, the project
still opens, but the host cannot take what this Zenith would send back, so "Save to DSIM" and
"Simulate in DSIM" are off and the bar shows "DSIM needs an update" with a "Save a copy" button. The
badge's tooltip, the status line and both buttons' tooltips say "DSIM needs an update before it can
read autos from this Zenith, so Save to DSIM and Simulate in DSIM are off. Save a copy keeps your work.
This DSIM page is build 1, and this Zenith needs build 2 or later; if DSIM has been updated, reload it
and open Zenith from it again." When the auto that opens was written in an older format, the status
line adds that it was written in that format and that saving writes format 4, which this DSIM cannot
open until it is updated; an older-format auto opened later in the session says the same in its own
notice. Below 1100 px wide the update badge and the disabled "Simulate in DSIM" are not drawn, to
leave room for "Save a copy" and "Save to DSIM"; the status line and Save to DSIM's tooltip still say
why. With no `hostBuild`, or no `minBuild` for the host, nothing is said.

DSIM's row sets `minBuild` 2. DSIM build 1 vendors Zenith 0.1.1, which reads auto format 3 and refuses
the format 4 files this Zenith writes, so its Save and Simulate would fail inside DSIM. **The DSIM
release that vendors this Zenith must send `hostBuild: 2`** (DSIM's host build number, `HOST_BUILD`)
and ship together with it. A DSIM page from before builds were numbered sends none, so it is not
called out of date.

### Zenith to host

| `type` | fields | when |
|---|---|---|
| `ready` | `protocol: "zenith-host/1"` | On load, to target origin `"*"`. |
| `save` | `name: string`, `text: string` | Save or `Ctrl S`. `text` is the canonical auto JSON (`core.canonicalize("auto", …)`), ending in a newline. |
| `run` | `name: string`, `text: string` | "Simulate in DSIM", only when the host offered `capabilities.simulate`. `text` is the canonical JSON of the auto as it is in the editor, saved or not. |
| `bye` | none | On `pagehide`, best effort. |

Every message after `ready` is posted to the pinned origin, never to `"*"`.

### Timeouts

| wait | limit | on timeout |
|---|---|---|
| `open` after load | 10 s | the full-page message above |
| `saved` after `save` | 5 s | the save fails: "DSIM did not answer within 5 s, so … may not be saved in DSIM." |
| `trace` after `run` | 60 s | "DSIM did not send a trace back within 60 s. Check DSIM's window, then try again." A `runFailed` ends the wait at once with the host's reason. |

A second `save` of the same name before the first is answered replaces it; the first fails.

## 3. Origin rules

`apps/web/src/project/hostOrigins.ts` maps each `hostId` to a display name and an allowlist:

| `hostId` | name | allowed origins |
|---|---|---|
| `dsim` | DSIM | `https://www.playdsim.com`, `https://playdsim.com`, `https://alpha.playdsim.com`, `https://beta.playdsim.com`, and any `http://localhost[:port]` or `http://127.0.0.1[:port]` |

The build may add origins with `VITE_ZENITH_HOST_ORIGINS` (comma separated, for a host's preview
deployments); entries that are not origins are dropped. Origins compare exactly after lower-casing
and dropping a trailing slash: scheme, host and port, no path. `https://localhost` is not a dev origin
and `http://playdsim.com` is not `https://playdsim.com`.

A message is accepted only when **all** of these hold:

1. `event.source === window.opener`: the window that opened Zenith sent it, not another frame, tab or
   Zenith itself.
2. Before the pin: `event.origin` is on the host's allowlist, and the message is a valid `open`. Any
   other message before the first `open` is dropped.
3. After the pin: `event.origin` is exactly the pinned origin.
4. `parseHostMessage(event.data)` returns a message: the exact shape of section 2, with only the named
   fields copied over. Anything else is dropped silently.

## 4. The editor in host mode

- The project is a `HostBackend` (`ProjectBackend` kind `host`, source `{kind: "host", hostId}`), with
  a synthesized `zenith.json`: `autosDir: "autos"`, `robot: "autos/robot.json"`,
  `field: "autos/field.json"` and `waypoints: "autos/waypoints.json"` when waypoints came. It names no
  sim command, deploy target or codegen directory. An auto's own `robot` or `field` path that names a
  `robot.json` or a `*.field.json` resolves to the host's robot and field; the host sent one of each.
- The toolbar's right-hand group shows two short lines, the label and which alliance to draw for
  ("Draw for RED · DSIM mirrors for BLUE"), edged in that alliance's colour, with "Editing for DSIM"
  and the whole sentence in its tooltip. Then come "Simulate in DSIM" when offered, and "Save to
  DSIM", the screen's primary button. `Ctrl S` runs the same action. Below 1400 px wide "Simulate in
  DSIM" and "Save a copy" are their icons alone, and below 1100 px the two lines are left out, so
  "Save to DSIM" keeps its words and stays in view down to 900 px; there its tooltip says the two
  lines. While a `save` waits for its `saved`, the button reads "Saving to DSIM…" and is off. The toolbar's own Save and Propose
  buttons are not shown.
- The Simulate dialog (`F5`) offers "Simulate in DSIM" as the high-fidelity option, with the trace
  report and "Load trace"; the Full sim playback level's tooltip says to simulate in DSIM.
- Hidden: open a folder, the bundled example, GitHub sign in and out, Propose, and the desktop app's
  sim, deploy and git actions. The start screen and the first-run example never appear, the last
  folder is not reopened, and no review route is followed. The Propose stop leaves the full tour.
- The auto picker (the title bar's auto name, `Ctrl O`) lists the host's autos and has "New auto".
- Kept: the editor, findings, estimate, instant sim, the three playback levels, the palette, the tour,
  and "Save a copy to downloads". Once the session is over, whether the host sent `close` or its
  window closed, or while the host needs an update ([Host builds](#host-builds)), the bar has a
  "Save a copy" button next to the disabled "Save to DSIM", and the title bar reads "was in DSIM".
- Unsaved edits still ask before the window closes.

## 5. Security notes

- **Why a popup and not an iframe.** The hosted build sends `X-Frame-Options: DENY` and
  `frame-ancestors 'none'` (`vercel.json`), so no other site can frame it, and the password gate's
  session cookie is `SameSite=Strict` (`api/_lib/session.ts`), so a cross-site iframe would never
  carry it. A popup is a top-level window of Zenith's own origin; once the person is signed in to the
  gate inside it, its navigations are same-site and the cookie applies.
- **The gate and the first load.** `SameSite=Strict` also withholds the cookie from a top-level
  navigation that another site started, which is what `window.open` from the host is. The gate
  handles that in two steps. A cross-site navigation that arrives without the cookie (told apart by
  `Sec-Fetch-Site: cross-site` and `Sec-Fetch-Mode: navigate`) gets a script-free page whose
  `<meta>` refresh reloads the same address; that reload is Zenith's own navigation, so the cookie
  goes with it and a signed-in person lands in host mode. Anyone still without a cookie gets the
  login page, which carries the interrupted address (a same-origin relative path, validated by
  `api/_lib/returnTo.ts`) and returns to it after the login, `?host=` included. When that address
  carries `?host=` for a host Zenith knows, the login page also says so: "DSIM opened Zenith; sign in
  to edit your auto." A `?host=` value Zenith does not know adds no line. Zenith then posts
  `ready` again, and the host answers with `open` as it would for a first load. The public build has
  no gate and is not affected.
- **Never postMessage secrets.** Nothing Zenith posts carries a token, a cookie or anything from
  another project: `ready` is empty, and `save` and `run` carry the one auto's canonical text. Host
  mode never signs in to GitHub. A host must not put credentials in `open` either; Zenith would not
  use them.
- **Pinning.** `ready` goes to `"*"` because it is empty. Everything after it goes to the pinned
  origin only, so a navigation of the opener to another site cannot receive an auto.
- **The host validates what it saves.** `save.text` is canonical auto JSON as Zenith wrote it, but the
  host must still parse and validate it (for example with `@horizon36596/zenith-schema`'s `parseAuto`)
  before it stores or runs it, and answer `saved` with `ok: false` and a reason when it refuses.
  Zenith treats every host message the same way: shape-checked by `parseHostMessage`, then the robot,
  field and autos parsed through the schema like any file from a folder.
