# FAQ and troubleshooting

Short answers to the questions new users and mentors ask most.

## Installing and running

### Why does Windows SmartScreen warn about the desktop installer?

The installer and portable exe are not code-signed yet. Windows may show "Windows protected your PC"
when you run a downloaded build.
To run it, choose **More info**, then **Run anyway**. Download it only from the project's GitHub
Releases page. If you would rather not run an unsigned exe, use the web app instead; it has the same
editor.

### Does the app work offline?

The desktop editor can open local folders, edit, validate and save offline. A high-fidelity sim can
also run offline once Java, the Android SDK and its Gradle dependencies are installed; the first run
may need downloads. The web app needs a connection to load, then can edit an open local folder
without one. GitHub mode and review links need a connection.

### Why can't the web app save into my folder?

Saving in place uses the File System Access API, which Chrome and Edge support. Firefox and Safari
fall back to a read-only file picker, and Save downloads the auto, or the whole project as a zip. Use Chrome, Edge or the desktop app
to save in place.

## Reading the numbers

### Why does a step show "unknown" time?

Zenith does not invent a number. A step's time is unknown when something it depends on is unknown:

- a command whose registry entry in `robot.json` says `"estimateS": "unknown"`,
- a step that ends on a condition the ledger cannot predict, such as collecting pollen whose position
  is not known after a hive tips,
- a sequence or group that contains an unknown step.

For a command, add a measured estimate in `robot.json` with its provenance. A wait on an unpredictable
condition can remain unknown; a recorded trace gives the time observed in that run, not a guarantee
for the next one. Calibration fits path timing and does not fill in unknown command estimates or
make sensor conditions predictable.

### What does a provenance label mean, and why does it matter?

Every number in `robot.json` and `field.json` carries a label that says where it came from:
MEASURED, SPEC, SET BY HAND, SET FROM SIM, CALIBRATED FROM ROBOT, PLACEHOLDER, NEEDS MEASUREMENT and
the rest. The editor shows the label next to the number and ranks it: measured, derived or
unverified.

It matters because an estimate is only as good as its inputs. A routine that fits in 29 s on
PLACEHOLDER drive constants may not fit on the real robot. The label tells you which numbers to
trust and which to go and measure.

### What is the difference between the instant sim and the high-fidelity sim?

The **instant sim** is built into Zenith. It follows each path the way Pedro Pathing does, within
the robot's limits from `robot.json`, and it re-runs every time you edit, so the playback and the
timeline update as you drag.

The **high-fidelity sim** is your team's own headless sim in the robot repository, named by the
`sim` command in `zenith.json`. It runs your robot code against the simulated hardware and physics
you provide. Run it with **Run high-fidelity sim** in the desktop app or `zenith sim` on the command
line. Zenith overlays the recorded run on the plan. `zenith calibrate` can fit the estimate's
acceleration and settle time from those traces; it does not tune your follower or validate the
physics model against the robot.

## Seasons and robots

### What if my season does not have a plugin yet?

Zenith still works. Paths, headings, timing, perimeter and obstacle checks all run. Only the
season-specific checks and ledger rows are missing, and Zenith says so in a warning rather than
guessing. See [Seasons](seasons.md) for how to write a plugin, or open a season request issue.

### Does Zenith replace tuning my follower?

No. Your follower's tuning and constants stay in your robot repository, where they are today. Zenith
reads the numbers it needs for estimates from `robot.json`, and the robot runtime plays your auto
through your own Pedro Pathing setup and your Ivy or SolversLib commands. Tune the follower on the
robot as usual.

### Which command library does Zenith use?

Whichever one you name. The robot runtime builds each auto from Ivy, Pedro Pathing's command library,
or from SolversLib, and Zenith does not pick one for you: set `"commandLibrary": "ivy"` or
`"commandLibrary": "solverslib"` in the `deploy` block of `zenith.json`. Until you do, Zenith writes
no Java: `zenith codegen` refuses, and so does `zenith deploy` once `zenith.json` has a `codegen`
section. The auto files do not name a library, so the editor, the checks and the sims work the same
either way.
Horizon (FTC 36596) runs SolversLib on its own robot, so the SolversLib runtime gets more testing on a
real robot from the team. [Choosing a command library](command-libraries.md) compares the two and lists
the steps to switch.

## Working as a team

### Can I use Zenith without an AI agent?

Yes. Everything an agent can do, a person can do in the editor or with the `zenith` CLI. The CLI and
the MCP server exist so agents can author the same files; neither is required.

### Can several people edit the same auto at once?

No, by design. In GitHub mode each person edits on their own work branch, `auto/<autoName>/<login>`.
Two people changing the same auto open two pull requests, and a merge conflict on GitHub shows the
overlap, the same as with code. Canonical form keeps those conflicts small.

### Why does my pull request review show two paths on the field?

Review mode draws the auto from the base branch and from the pull request's head at the same time.
The ghosted path is the base, the solid one is the change. The step list beside it shows what
changed and how the estimate moved. See [Working with GitHub](github.md#review-links).
