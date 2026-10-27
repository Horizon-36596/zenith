# Alliance partners

Everything on this page works today, with no account and no network: your partner gives you a file,
you load it next to your auto, and anything you suggest back goes to them as a file too.

- **Your partner makes the file** with **Download share file** in the editor's command palette (or
  **Download share file for proposals**, to let you suggest changes), `zenith projection`, or the
  `zenith.projection` MCP tool. It carries the robot's path over time, its bounding box and the
  elements it takes, with every command replaced by a token, never the auto file, `robot.json` or any
  code. [The file format](file-format.md#projectionjson) has the details.
- **You load it** in the editor's [Partners panel](editor.md#partners-panel) (**Load share file…**, or
  drop the file on the panel). A partner's `trajectory.json` loads the same way; see
  [Bring paths from other planners](import.md#load-a-partners-trajectoryjson).

Signed in, a share made to your team loads the same way and carries the same projection;
[Teams and sharing](teams-and-sharing.md) describes it.

## The alliance view

The alliance view puts your auto and a partner's auto on one field, on one clock. Both robots
follow the same playback. You can give either robot a **start offset** ("what if I wait 0.5 s"), and
turn your own into a real wait step with one click: **Make it a wait step**, under your start offset,
puts that wait in front of your first step and sets the offset back to 0 s. Undo takes the wait out
and puts the offset back. A
partner's offset cannot become a step in your auto; ask them to add the wait to theirs.

Your start offset belongs to the auto you set it on. Open another auto and its offset is 0 s, so
its own predicted findings show; the status line says where the delay stayed, and going back to the
first auto finds it again. Opening another project or loading the example clears your offsets, and
the partners you loaded stay.

It checks, on a 0.1 s grid:

| check | what it means |
|---|---|
| **Collision** | the two robots' boxes, each grown by a small margin, overlap at the same time. |
| **Near miss** | they come close without touching. |
| **Start overlap** | the two start poses overlap or share a tile. |
| **Element conflict** | both autos go for the same field element or target. |
| **Envelope** | your robot enters a partner's envelope while it is active. |

Each finding says "predicted", because it compares two simulated predictions, not real robots. On a
collision, a near miss or an envelope, two one-click fixes suggest the smallest delay that clears it
without a collision: delay my start, or wait before this step. A start overlap or an element conflict
has none, because waiting cannot fix it.

**Alliance checks never block anything.** They do not stop a save, a deploy, a proposal or a run. They
are advice for the two teams to talk about. From the command line, `zenith alliance` runs the same
checks.

## Envelopes

Some teams let the robot pick its own path from vision. An **envelope** on a step says: while this
step runs, for at most so many seconds, the robot stays inside this area. The editor draws it, the
step's time becomes that limit, and a later step can say where the robot rejoins a known path.

A share file, like a share, carries the area and the time window, never the command behind it. A partner's
alliance view treats that area as taken for that window. A robot passing through a partner's envelope
is flagged, and **still allowed to run**.

## Proposals

When a partner gives you a propose-level share file (they make it with **Download share file for
proposals**), load it in the **Partners** panel and press **Suggest changes…** under it. **Save
proposal…** saves what you changed as a proposal file, which you send to them however you like; the
team that owns the auto opens it with **Open proposal…**. In a proposal you:

- **Can:** move poses and control points, change heading modes, speeds and timeouts, add or change
  waits, reorder, add or delete path steps, slide markers and set envelopes, each with a one-line
  comment.
- **Cannot:** create, rename or change a command, or see what a command is.
- The owning team opens a proposal in the review view and **accepts or rejects each change** on its
  own. Accepted changes go through the normal edit and undo path. A change to a step that has changed
  since the share can only be rejected.
- A proposal never touches your robot repository, never deploys and cannot run anything.

Only the owning team chooses the propose level: a share file made with plain **Download share
file** gives you no **Suggest changes…**.
