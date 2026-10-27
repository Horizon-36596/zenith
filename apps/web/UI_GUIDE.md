# UI_GUIDE.md — Zenith editor, version 2

> Binding design reference for `apps/web` (and `apps/desktop`, which hosts the same build).
> Horizon (FTC 36596). Rewritten by the `frontend-design` skill on 2026-09-22 for v2, from the
> owner's review of v1. Values live in `src/styles/tokens.css`; this
> file says what they mean and how to use them. Deviate only with a reason in the commit message.

## 0. Direction, and what we are opposed to

The owner's verdict on v1: "very cluttered and not very intuitive for anyone who is new to FTC
pathing", "a bit overwhelming", and the middle "feels very AI". v1 was an instrument panel tuned for
density: every region boxed, every value in a bordered input, a teal glow on the selected path,
translucent robot ghosts stamped down the path, whole findings rows washed red.

v2 is **a quiet night sky with one lit field**. The chrome is the Horizon ground, flat and dark and
mostly empty. The field is the one primary region, the only large lit thing on screen. The Horizon
sunrise (amber, orange, crimson) appears only where the app speaks as a brand or as a control: the
title bar, the logo, the active tool, the primary button and the focus ring. A newcomer
should be able to point at the screen and say "the field, my steps, the settings for the thing I
clicked", and every panel header has a `?` that says what it is for. The settings for the thing
clicked are literal: a step's Inspector holds that step and nothing else. The routine's Start and the
Waypoints list are shown only when nothing is selected (the Routine view), when the start is
selected, or when a waypoint is selected.

Opposed to:

- **The generated dashboard.** Boxes inside boxes, a hairline round everything, a card per
  concept, colour spent because it was available.
- **Glow as selection.** A saturated cyan line with a halo is the look of every AI demo. Selection
  on the field is brightness and weight.
- **Ghost stamping.** Twelve translucent robot rectangles along a path read as noise (the owner
  ruled them out). One robot outline, where the scrubber or the cursor is.
- **All-caps shouting.** `NEEDS MEASUREMENT`, `PERIMETER`, `SET FROM EDITOR` in capitals and
  colour at full weight. Codes and provenance are quiet chips; the sentence is the message.
- **Brand on data.** An orange path, an amber warning, a crimson error: the gradient never touches
  the field or a finding, so brand colour always means "this is Zenith" or "this acts".

**The signature** is the horizon line: a 2 px strip of the Horizon gradient under the title bar,
the same band as the logo's horizon, bright at the centre. It is the only gradient on a routine
screen besides the primary button, and it says "Horizon" without a single word.

### 0.1 Principles (the UX overhaul, issues #409 to #414)

Every change to the editor is checked against these. They come from the UX overhaul plan and
hold for every region.

1. **One place per fact and per control.** A value is shown and edited in one place. Anywhere else
   it shows a link to that place or nothing: heading in the Heading section, a joint under the
   earlier path, the cap in its own row, a finding's fix on its own row.
2. **The selection decides what the Inspector shows, and nothing else does.** The selected thing
   comes first and alone (a marker, a point, a group's members). Its container is a way back, not a
   second copy of everything.
3. **Show the value, hint the explanation.** Rows show numbers and choices. Mode names, reasons, raw
   keys and how-to text go to tooltips, row hints and `?`. A `?` column, a notes preview or a
   sentence never sits where values go.
4. **Show what applies and hide what cannot.** No greyed rows that can never work for this target,
   no bin that cannot delete, no menu item for a tool the toolbar already has. A disabled control
   that stays says why.
5. **Students' words, not file words.** No "t", "envelope", "deadline", "Path chain", "then
   (assumed)", raw `robot.json` keys or finding codes in sentences. Codes and ids stay as quiet chips
   or hints.
6. **Nothing moves under the pointer.** Hover never changes a row's height, tool options never shift
   the toolbar, the toolbar never wraps, and menus open at the cursor inside the window.
7. **Every action answers once, and old answers go away.** The status line describes the latest
   action, in one shape: "Added wait2 after leg1.", "Undid: Added wait2 after leg1.", "Snap off.",
   "Opened first-auto.auto.json." The next edit, an undo or redo, opening an auto, a dialog, a sheet
   or Settings, and the tour ending all replace or clear a message that is no longer true (9.15).
8. **Numbers look the same everywhere.** One degree format, wrapped to (-180, 180] with one decimal
   and the ° tight against the number, in readouts, fields and lists. Editing inputs keep their
   current inch precision.

## 1. Stack reality

Vite + React 18 + TypeScript 5 strict, Canvas 2D for the field (`src/canvas`), plain CSS Modules
over the custom properties in `src/styles/tokens.css`. No CSS framework, no component library, no
CSS-in-JS, no motion library; stack additions need an ADR (`CLAUDE.md` rule 9). Motion is CSS
transitions. Icons are `lucide-react` only. `tokens.css`, then `fonts.css`, then `base.css` are
imported once in `src/main.tsx` before any component stylesheet.

Components read tokens. A literal colour, duration, radius or pixel size in a component stylesheet
is a bug. The canvas reads the same tokens through `src/canvas/theme.ts`; its `FALLBACK` table must
mirror `tokens.css` (it still carried v1 teal values when v2 tokens landed, which the canvas owner
updates). **Every v1 token name still resolves.** Where a name changed meaning, `tokens.css` says so
with "v1 name, kept".

## 2. Identity

| Decision | Value | Why |
|---|---|---|
| Ground | `--bg-app` `#17061D`, the Horizon website's `night.950` | The owner's ruling. Everything sits on the team's own night sky. |
| Surfaces | The website's `night` ramp: `#1C0A24`, `#22102B`, `#2A1735`, `#331E3F` | Violet-tinted on purpose: a cool grey next to this ground reads as a stock template (the website's own note). |
| Text | The website's `haze` ramp: `#FAF6FB`, `#C2B0C8`, `#A08FA8`, `#665572` | Same tint family as the surfaces, so the page reads as one material. |
| Brand | Amber `#FFCB5C`, orange `#F86A43`, crimson `#B13848`, as `--brand-*` and three gradients | Chrome and brand only (section 4.1). |
| Control accent | `--accent` = brand orange `#F86A43` | The one hue that means "active or acts" in the chrome. Teal is retired. |
| Display face | **Jost** 400–600 | Horizon's brand face; its circles and arcs rhyme with the sun-ring mark. Headings, titles, buttons, tabs, the tour. 13 px and up. |
| UI face | **IBM Plex Sans** 400–600 | Body copy, labels, messages, tooltips. Kept from v1; section 5 says why Jost is not the body face. |
| Mono face | **JetBrains Mono** 400–500 | Horizon's figures face: every number, id, path, code and provenance string. Replaces IBM Plex Mono. |
| Icons | Lucide, 16 px, `strokeWidth` `--icon-stroke` 1.75 | One set. 1.75 rather than v1's 1.5 so a 16 px glyph holds its weight next to 13 px text on the dark ground. |
| Product mark | The Z route mark and the Zenith wordmark, `public/brand/` (section 2.1) | The owner chose concept 3 on 2026-09-23. The title bar shows the wordmark, a hairline, then Horizon's white text logo. |

### 2.1 The Zenith logo

The owner chose concept 3, Z route, on 2026-09-23. Its square end markers were tried as rectangles
and then as flat round dots the same day; the owner asked for round points that belong to the route,
so the final mark is a route whose colour flows from end to end, with a waypoint at each turn. The
app's copies of the files are in `public/brand/`.

- **The mark** is a Z drawn as a route on a 64 grid: stroke 8, round caps, legs centred at y 18 and
  46, corners at (48, 18) and (16, 46). The colour runs along the route, amber `#FFCB5C` at the start
  through orange `#F86A43` to crimson `#B13848` at the end; each of the three segments has its own
  gradient laid along its own direction. Over the length where two strokes overlap at a corner,
  both gradients hold the corner's exact colour and then ease out of it, so the join is one flat
  colour and no seam can show. The corners sit at 0.2 and 0.8 of the ramp, so the top waypoint
  is the lightest point on the route and the bottom one the darkest.
- **The waypoints** are dots 10.4 across, the route's own colour where they sit, lit by a soft
  radial gradient from the upper left, each inside a gap 15.3 across cut out of the stroke with a
  mask (so the gap is transparent on any ground). The gap is a circle round the dot, so each stroke
  ends in an arc concentric with it and the ring is the same width all the way round. A soft white
  sheen lies across each stroke, 20 % at the upper edge fading to nothing at the centre line, and
  fades in and out along the stroke so it never reaches a corner or an end. The tile shades from `#241029` at the top to `#17061D`. No
  filters: gradients, one mask and group opacity only, so resvg exports it exactly.
- **One drawing at every size.** The favicon, the app icon and the docs icon are the master itself,
  scaled. A separate hinted 16 px drawing was tried and retired,
  because it made the browser tab show a different logo from the one in the app.
- **The wordmark** is the master's own Z, without the tile, scaled to the cap height, followed by
  "enith" in Jost 550, all outlines, so it needs no font. The Z is wider and heavier than the letters
  on purpose: it is the same drawing as the app icon. `wordmark-dark.svg` (letters `#FAF6FB`) on
  night, `wordmark-light.svg` (letters `#17061D`) on light, and one-colour white and night versions
  for everything else. All are generated from the master; a letter-weight Z was tried and retired.
- **Clear space.** Around the mark, an eighth of the tile's width on every side. Around the
  wordmark, one dot diameter (just under a third of the Z's height) on every side.
- **Minimum size.** The mark: 16 px.
  The wordmark: 14 px tall (about 54 px wide); below that use the mark alone.
- **Never** recolour, stretch, rotate, outline or shadow either, and never set "Zenith" in live Jost
  next to the mark in place of the wordmark.

In the app: `public/favicon.svg`, `favicon.ico`, `favicon-16.png`, `favicon-32.png` and
`apple-touch-icon.png`; `public/brand/zenith-wordmark-dark.svg` in the title bar; the desktop icon in
`apps/desktop/resources/`. Every icon and wordmark is generated from one master,
`brand/zenith-mark.svg`, by `node scripts/brand-icons.mjs`, and `pnpm test` fails if any of them, or
anything that links one, stops matching it. Change the master and re-run the script; never edit an icon by hand.

**Horizon in the app** is the team's white text logo, `public/brand/horizon-wordmark-white.svg`, a
byte-for-byte copy of the team's own file. Never redraw or edit it; size or place it with CSS only.
The Horizon sun mark is not used in the app.

## 3. The frame, and the layout language

```
┌ title bar 36 px · wordmark | HORIZON · auto name ·················· alliance · window controls ┐
╞══════════ horizon line: 2 px --brand-gradient-horizon ═════════════════════════════════════════╡
│ toolbar 44 px · tools │ actions │ view                                           ? · help      │
├──────────────────┬──────────────────────────────────────────────────────┬────────────────────┤
│ steps + timeline │                                                      │ inspector          │
│ --bg-panel       │          THE FIELD  (--bg-canvas well)               │ --bg-panel         │
│ 300 px           │          the one primary region                      │ 320 px             │
│                  ├──────────────────────────────────────────────────────┤                    │
│ ledger (folded)  │ findings  --bg-panel, collapsible                    │                    │
└──────────────────┴──────────────────────────────────────────────────────┴────────────────────┘
```

Neither the desktop window nor the web build draws a border round the whole window: the owner ruled
the gradient window edge out. Column widths are `--panel-left-w`,
`--panel-right-w` and `--findings-h`, each resizable on a 10 px target with a `--resizer-w` 4 px
visual that only appears on hover.

**Layout rules.** These are the ones v1 broke; each is written so a reviewer can point at a line.

1. **One primary region.** The field well is the largest region and the only one that is darker
   than the ground; the field board inside it is the brightest large object on screen. Nothing
   floats over the field except the cursor readout, the scale, and menus that the person opened.
2. **A region is a plane, not a box.** Side panels are `--bg-panel` against the `--bg-app` chrome,
   and that one lightness step is the separation. There is exactly one `--border-default` line
   between two regions, never a border on both sides, never a border round a panel's contents.
3. **Space groups, lines do not, except in the Inspector.** Inside a panel, sections are separated
   by `--gap-section` 24 px of space and a section header. A `--border-subtle` rule is allowed only
   where two lists touch with no header between them. The Inspector is the one exception (issue
   #431, the calm single panel): its sections are separated by full-bleed 1 px `--border-default`
   hairlines under small uppercase headers, as in Premiere's Effect Controls and Figma's right
   panel, because it holds many short sections that space alone could not tell apart.
4. **No card inside a panel.** v1's "Markers (1)" block (a bordered box holding a marker's fields
   inside the inspector) is the pattern to delete: a marker is a sub-section with an indented header.
5. **Three levels per surface, at most.** Region title, section header, row. If a fourth level
   seems needed, it is a disclosure that starts closed. The Inspector's **Advanced**, near the end
   of every step, is the allowed one: it holds the rows a step rarely needs (a command's time limit,
   adding a stay-inside box or a rejoin pose, the full sim's readout) and starts closed, as
   **Notes** does. A chain's **Path n** groups and a curve's **Controls** are disclosures too.
6. **Values are text until you touch them.** An inspector value at rest is mono text on the panel,
   with no box (section 9.5); the input chrome appears on hover and focus. v1 drew 20 bordered
   inputs in the inspector at once; that is most of what "cluttered" meant.
7. **Every panel keeps its place.** The owner ruled "keep every panel". Calm comes from fewer
   lines, fewer colours and real type hierarchy, not from hiding panels. The ledger starts folded
   to its header; the findings panel starts at its default height. A window too narrow for every
   column is rule 9's case: there a panel becomes a sheet, which is still one press away.
8. **Transient messages overlay and never reflow.** A message that comes and goes by itself (the
   status bar, section 9.15) is drawn over the layout, never given a row in it. Nothing may move
   when it appears or clears: not a panel, not the field, not a control under the pointer. A
   layout that jumps 28 px six seconds after an open drops a drag in the wrong place and closes
   whatever was being hovered. A value whose length changes is never what moves a control beside
   it either: the timeline's total takes the room left of a level switch pinned to the row's end.
9. **Below desktop width the field keeps its room, and the window says what moved.** The three
   columns are the layout from 820 px of window up. Between 820 and 1100 px the side panels give
   way before the field does, down to their minimum widths. Below 820 px the Inspector leaves the
   row and opens as a sheet over the field's right side; below 640 px the steps column does too,
   from the left. One sheet is open at a time, chosen on the panel bar under the toolbar (a
   segmented switch: **Steps**, **Field**, **Inspector**), which also says that a wider window shows
   every panel. A second press on an open sheet's segment closes it. The field always has the width
   the sheets gave up, and the status bar starts at the window's left edge when the steps column is
   a closed sheet. A tour stop on a panel that is a sheet opens it, and a stop on the field closes
   it. A view that cannot work as sheets (a pull-request review, a proposal, two library revisions
   side by side) says under the toolbar, below 900 px, that it needs a wider window. A header too
   narrow for everything it holds drops what says least first, such as a zero count, and never
   clips a word.

## 4. Colour

### 4.1 Where the brand may appear

The gradient and the three brand hues appear on **chrome and brand only**:

| Place | Token | Form |
|---|---|---|
| Title bar bottom edge | `--brand-gradient-horizon` | 2 px line, the signature |
| Zenith logo and Horizon wordmark | the SVGs in `public/brand/` | as drawn |
| Active tool | `--brand-gradient` | 2 px bar under the button, and `--accent-muted` fill |
| Primary button | `--brand-gradient-button`, `--brand-ink` text, `--shadow-ember` | one per screen |
| Focus ring | `--ring` = amber | 2 px at 2 px offset |
| Selected row, active tab, text button | `--accent` = orange, flat | 2 px bar or text |
| Tour | `--tour-cutout-ring` amber (Day: crimson with a white keyline, at least 3:1 on a white panel), `--brand-line` card edge | section 10 |

It never appears on: the field, a path, a handle, a finding, a severity, a provenance chip, a
panel background, a table, or as a large wash of any kind. Crimson is 3.3:1 on the ground, fine
for an edge and never used for text.

### 4.2 The hue map

Every hue in the app has one job. The brand owns the warm arc from oklch hue 17 (crimson) to 84
(amber); every data hue is placed outside it or separated from it by place and chroma.

| oklch hue | Hue | Job | Where |
|---|---|---|---|
| 8 | rose `#FB6188` | error severity, finding highlight | findings, canvas highlight |
| 17–84 | crimson, orange, amber | **brand** | chrome only (4.1) |
| 27 | red `#EE3533` | alliance RED | field and alliance pill only |
| 90 | gold `#F5C400` | pollen pieces (`--field-pollen`), with a well-coloured edge; warmer than the lemon tape and zones, past the brand arc's end at 84 | field only |
| 102 | lemon `#EDDB49` | warning severity, rule zones, unverified provenance | findings, field zones, chips |
| 118 | lime `#B9D45C` | the second alliance partner (`--partner-2`) | field, timeline lane and Partners panel swatch only |
| 139 | grass green `#86E268` | the route Optimize path proposes (`--path-candidate`), dashed with joint dots, only while the Optimize card is open; outside the retired teal arc (hues 160 to 195) and between lime and green, so a dash pattern and the dots, never the hue alone, tell it from the second partner's lime and the recorded trace | canvas only |
| 152 | green `#62D286` | ok, measured provenance, recorded trace | status, chips, canvas |
| 200 | aqua `#43D5DC` | hive pivot marks and score claims | field only |
| 235 | sky `#71C9FA` | canvas annotations: heading, markers, snap guides, measure | canvas only |
| 255 | periwinkle `#9ABAE4` | info severity (deliberately low chroma: it must not pull the eye) | findings |
| 258 | blue `#3082F6` | alliance BLUE | field and alliance pill only |
| 282 | iris `#9695FF` | your own robot while its position is unknown (`--canvas-unknown`): the playback robot and its step's envelope during a command that drives the robot by itself, in the partner style, always labelled "position unknown" | canvas only |
| 295 | violet `#B592FF` | the first alliance partner (`--partner-1`) | field, timeline lane and Partners panel swatch only |
| 320 | orchid `#D489E5` | game elements and containers | field only |
| 340 | pink `#F291D2` | the third alliance partner (`--partner-3`) | field, timeline lane and Partners panel swatch only |
| 315, low chroma | haze and night | text, surfaces, authored paths | everywhere |

**Why partners have hues of their own.** The alliance view (spec 13 section 9) draws a partner's
robot, trajectory and envelopes on the same field as yours, so each needs a colour no path, finding
or field element uses. The three partner hues sit in the gaps between hues already taken, off the
brand arc, and a partner is never told apart by colour alone: its name is drawn under its box and
beside its swatch and lane. A fourth partner reuses the first hue.

**Why the unknown position has a hue of its own** (issue #481). While a command that drives the
robot by itself runs, the editor draws your own robot as a guess, in the partner style the owner
chose for it, so it needs a violet that reads like a partner's without passing for the first one.
Iris sits at hue 282, in the gap between alliance blue (258) and the first partner's violet (295),
bluer than the partner and more chromatic than periwinkle info (C 0.15 against 0.07). It is never
the only channel: the robot's label always says "position unknown". Over the light field picture
`liveInk` swaps in `#4E3DBC`, as it does the partner inks.

**Why severities moved.** v1's warning was amber `#E0A44F` (hue 73), eleven degrees from brand
amber: a warning chip next to the primary button would have read as brand. It moves to lemon, 18°
greener and more chromatic, which is still the colour a newcomer expects for "careful". v1's error
was coral `#F2705F` (hue 29), almost exactly brand orange; it moves to rose, pinker and lighter than
crimson, still unmistakably "wrong". **Why alliance red did not move.** Red alliance is red; there
is no other honest colour for it. It is kept apart by place (field and alliance pill only, never
chrome), by chroma (C 0.22, the most saturated red in the app, against orange 0.18 and crimson 0.16),
and by words (the pill always says RED or BLUE). It never appears in the same component as an
error. **Why authored paths are not coloured.** The drawn field carries red and blue tape and hive
cells, orchid flowers, gold pollen and aqua hive pivot marks. Any saturated path colour collides with one of them. A light violet-neutral
path at 2 px, and the selected one near-white at 3 px, reads over all of them.

### 4.3 Token groups

**Surfaces.** `--bg-app` ground (title bar, toolbar, gutters; `--bg-chrome` names the title bar),
`--bg-panel` side panels and findings, `--bg-raised` popovers, menus, tooltips, modals, the palette
and the tour card, `--bg-canvas` the field well, one step darker than the ground, `--bg-inset`
inputs and code. States `--bg-hover`, `--bg-active`, `--bg-selected` (a solid orange tint, so text
contrast on it is fixed and listed below), `--bg-running` a step row running at the playhead (9.6):
`#2A1735` in dark, the same as `--bg-raised`, and `#F1EAF3` in light, the same as `--bg-inset`, so
its contrast is those columns of 4.4. **Borders.** `--border-default` the one line between
regions; `--border-subtle` rare in-panel rules; `--border-strong`, the only border at 3:1, for a
hovered or focused control and a drop target. **Text.** `--text-hi` values and titles, `--text-mid`
labels, `--text-lo` units, hints and timestamps, `--text-disabled` for inert controls only,
`--text-on-accent` / `--brand-ink` dark ink on any orange or gradient fill.

**Severities** `--sev-error`, `--sev-warn`, `--sev-info` and `--ok`, each with a `-bg`. **Provenance**
tiers: `--prov-measured` (MEASURED, SPEC, CALIBRATED FROM ROBOT), `--prov-derived` (SET BY HAND, SET
FROM EDITOR, SET FROM SIM, CALIBRATED FROM SIM, CARRIED OVER), `--prov-unverified` (NEEDS
MEASUREMENT, PLACEHOLDER, APPROX). Within the unverified tier a NEEDS MEASUREMENT chip (and a number
with no provenance) is hollow, the tint replaced by a dashed `currentColor` edge, so "nobody has a
value" never looks like "someone put a guess here". **Paths** `--path-estimated`, `--path-selected`, `--path-hover`,
`--path-actual`, `--path-ghost`, `--path-candidate` (the route Optimize path proposes: grass green
`#86E268` on the dark well, which both page themes share, and `#2D6A12` over a light field picture,
where `liveInk` swaps it in with the other ink). **Canvas** `--canvas-annotation` (and its aliases
`--handle-heading`, `--marker-pin`, `--snap-guide`), `--robot-outline`, `--handle-endpoint`,
`--handle-control`, `--grid-*`, `--highlight-find`, `--canvas-unknown` (your robot and its envelope
while its position is a guess, section 4.2). `--ghost-footprint` survives as a name only.
**Field** `--field-floor` (the tiles inside the wall, one step above the well), `--field-obstacle(-fill)`, `--field-zone(-fill)`, `--field-element(-fill)`,
`--field-target`, `--field-waypoint`. **Bars** `--bar-*`, unchanged in meaning: solid for an
estimate, hatched where there is none, green for a recorded actual. `--bar-preview` is the instant
sim's bar on the timeline, the primary track at the Instant sim playback level (9.16): the same
haze family as `--bar-estimated`, one step brighter in dark and one step darker in light, so the
preview leads and the estimate reads as the band beneath it.

### 4.4 Contrast, every text and background pair

WCAG 2.2: 4.5:1 for text, 3:1 for focus indicators, control edges and graphics. Computed from the
hex in `tokens.css` with the WCAG relative-luminance formula; alpha tints are composited over the
surface named.

**Dark (default).**

| Foreground | Ratio on each background it is allowed on | Needs |
|---|---|---|
| `--text-hi` `#FAF6FB` | `app` 18.2 · `panel` 17.6 · `raised` 15.4 · `inset` 18.5 · `hover` 16.7 · `selected` 14.7 | 4.5 |
| `--text-mid` `#C2B0C8` | `app` 9.6 · `panel` 9.2 · `raised` 8.1 · `inset` 9.7 · `hover` 8.8 · `selected` 7.7 | 4.5 |
| `--text-lo` `#A08FA8` | `app` 6.5 · `panel` 6.2 · `raised` 5.5 · `inset` 6.6 · `hover` 5.9 · `selected` 5.2 | 4.5 |
| `--accent` `#F86A43` | `app` 6.6 · `panel` 6.4 · `raised` 5.6 · `hover` 6.1 · `selected` 5.3 | 4.5 |
| `--sev-error` `#FB6188` | `panel` 6.4 · `raised` 5.6 · on its own `-bg` 5.3 | 4.5 |
| `--sev-warn` `#EDDB49` | `panel` 13.3 · `raised` 11.7 · on its own `-bg` 10.4 | 4.5 |
| `--sev-info` `#9ABAE4` | `panel` 9.4 · `raised` 8.3 · on its own `-bg` 7.7 | 4.5 |
| `--ok` `#62D286` | `panel` 9.9 · `raised` 8.7 · on its own `-bg` 7.9 | 4.5 |
| `--prov-derived` `#A08FA8` | on `--prov-derived-bg` 5.2 | 4.5 |
| `--alliance-red-text` `#FB8276` | `app` 7.9 · `panel` 7.7 · `--alliance-red-bg` 6.8 | 4.5 |
| `--alliance-blue-text` `#80B3FD` | `app` 9.1 · `panel` 8.7 · `--alliance-blue-bg` 7.7 | 4.5 |
| `--brand-ink` `#17061D` | `--accent` 6.6 · button gradient top `#FFCB5C` 12.9 · middle `#FB9A4C` 9.1 · bottom `#F86A43` 6.6 | 4.5 |
| `--text-hi` | `--selection-bg` over panel 10.5 | 4.5 |
| `--ring` `#FFCB5C` | `app` 12.9 · `panel` 12.5 · `raised` 11.0 · `canvas` 13.3 | 3 |
| `--border-strong` `#6F5B7C` | `app` 3.2 · `panel` 3.1 | 3 |
| `--path-estimated` / `--path-selected` | `canvas` 9.8 / 18.7 | 3 |
| `--canvas-annotation` / `--path-actual` | `canvas` 10.9 / 10.5 | 3 |
| `--path-candidate` `#86E268` | `canvas` 12.5 · `--field-floor` 11.7 | 3 |
| `--canvas-unknown` `#9695FF` | `canvas` 7.7 · `--field-floor` 7.2; its light-field ink `#4E3DBC` on the light picture's `#FAF6FB` 7.2 | 3 |
| `--field-obstacle` / `--field-zone` / `--field-element` / `--field-target` | `canvas` 4.6 / 14.1 / 8.1 / 11.2 | 3 |
| `--alliance-red` / `--alliance-blue` / `--field-obstacle` / `--field-element` / `--field-target` on the drawn field | `--field-floor` 4.6 / 5.1 / 4.3 / 7.6 / 10.5 | 3 |
| `--alliance-red` / `--alliance-blue` | `canvas` 4.9 / 5.4 · `panel` 4.6 / 5.1 | 3 |
| `--sev-error` as canvas highlight | `canvas` 6.8 | 3 |
| `--code-keyword` `#B592FF` | `panel` 7.6 · `hover` 7.2 · `selected` 6.4 | 4.5 |
| `--code-string` `#62D286` | `panel` 9.9 · `hover` 9.4 · `selected` 8.3 | 4.5 |
| `--code-number` `#71C9FA` | `panel` 10.2 · `hover` 9.7 · `selected` 8.5 | 4.5 |

The floor is `--text-lo` on `--bg-selected` at 5.2:1. `--text-disabled` (2.3–2.9:1) is exempt as
inactive UI and must never carry information. `--border-subtle` and `--border-default` are below
3:1 by design: they are decoration, and no control may be identifiable only by one of them.
White text on orange (2.9:1) and dark ink on crimson (3.3:1) both fail, which is why the primary
button's gradient stops at orange and carries dark ink.

**Light (`data-theme="light"`).**

| Foreground | Ratio on `app` · `panel` · `raised` · `inset` · `selected` | Needs |
|---|---|---|
| `--text-hi` `#26192C` | 15.1 · 16.2 · 16.7 · 14.2 · 14.0 | 4.5 |
| `--text-mid` `#55475C` | 7.8 · 8.4 · 8.6 · 7.3 · 7.2 | 4.5 |
| `--text-lo` `#6B5D71` | 5.5 · 5.9 · 6.1 · 5.2 · 5.1 | 4.5 |
| `--accent` `#B13848` | 5.4 · 5.8 · 6.0 · 5.0 · 5.0 | 4.5 |
| `--sev-error` `#BE2357` | 5.3 · 5.7 · 5.9 · 5.0 · 4.9 | 4.5 |
| `--sev-warn` `#786900` | 5.0 · 5.3 · 5.5 · 4.7 · 4.6 | 4.5 |
| `--sev-info` `#3E6596` | 5.4 · 5.8 · 6.0 · 5.1 · 5.0 | 4.5 |
| `--ok` `#05773B` | 5.1 · 5.5 · 5.7 · 4.8 · 4.8 | 4.5 |
| `--text-on-accent` `#FFFFFF` | on `--accent` 6.0 | 4.5 |
| `--code-keyword` `#6B3FC0` | panel 6.6 · hover 5.8 · selected 5.7 | 4.5 |
| `--code-string` `#05773B` | panel 5.5 · hover 4.8 · selected 4.8 | 4.5 |
| `--code-number` `#1B6390` | panel 6.3 · hover 5.5 · selected 5.5 | 4.5 |

The `--code-*` rows give the panel, hover and selected grounds, the only ones the Code tab draws
code on; `--code-comment` is `--text-lo`, already in the tables.

| Graphic on the light field picture | Ratio on the picture's near-white ground `#FAF6FB` · `inset` `#F1EAF3` | Needs |
|---|---|---|
| `--path-candidate` on the light field picture, `#2D6A12` | 6.2 · 5.6 | 3 |

The light theme keeps the canvas, the title bar and the brand gradient dark and unchanged, and
the primary button keeps `--brand-ink` on the gradient. The title bar's ink is its own:
`--chrome-text-hi`, `--chrome-text-mid` and `--chrome-text-lo` (18.2, 9.6 and 6.5:1 on
`--bg-chrome`), with `--chrome-hover`, `--chrome-active`, `--chrome-inset`, `--chrome-border`,
`--chrome-border-strong` and `--chrome-ring`. No theme overrides them. The bar maps its own
`--text-*`, hover, border and ring tokens onto them, so anything placed on it reads in both themes.

## 5. Type

Three families, each with one job.

- **Jost** (`--font-display`): the title bar's product name, region titles, section headers,
  button and tab labels, modal titles, empty-state headlines, the tour. Never below 13 px.
- **IBM Plex Sans** (`--font-ui`): body copy, field labels, finding messages, tooltips, menus.
- **JetBrains Mono** (`--font-mono`, with `font-variant-numeric: var(--numeric)`): every number,
  every id, file path, finding code, shortcut and provenance string.

**Why Jost is not the body face.** It is not too wide; it is slightly narrower than Plex (a test
sentence at 100 px sets 1197 px in Jost against 1284 px in Plex). The problem is its x-height:
measured in the running app, Jost's x-height is 0.46 em against Plex's 0.52 em, so 12 px Jost has
the lowercase of 10.6 px Plex. Add Futura's single-storey `a`, near-circular `o`, `e` and `c`,
and a label column at 12 px starts to read as a row of circles. Jost at 13 px and up, in short
runs (a section header, a button), keeps the brand's shape; long runs and dense rows stay Plex.
JetBrains Mono replaces Plex Mono because it is Horizon's figures face and its taller x-height
(0.55 em) makes 13 px numbers the easiest thing on screen to read.

| Token | Size / line | Face | Used for |
|---|---|---|---|
| `--fs-micro` 10 px | `--lh-micro` 12 | mono | timeline ruler ticks only |
| `--fs-xs` 11 px | `--lh-xs` 14 | mono or Plex | chips, unit suffixes, shortcut hints |
| `--fs-sm` 13 px | `--lh-sm` 18 | Plex, mono | the default: rows, labels, values, tooltips (v1 was 12) |
| `--fs-md` 14 px | `--lh-md` 20 | Plex; Jost 500 for section headers | finding messages, modal and tour body, section headers |
| `--fs-lg` 16 px | `--lh-lg` 22 | Jost 500 | region titles, modal titles, the product name |
| `--fs-xl` 20 px | `--lh-xl` 26 | Jost 500 | empty-state headline, tour card title |
| `--fs-2xl` 26 px | `--lh-2xl` 32 | Jost 500 | the tour's choice card, the welcome screen |

Tracking: `--tracking-display` on Jost 20 px and up, `--tracking-tight` on Jost 16 px,
`--tracking-label` on Jost 13–14 px section headers, `--tracking-wide` on 10–11 px chips only.
Weights: 400 for copy and values, 500 for titles, headers, the selected row and buttons, 600 only
for a matched substring in the palette. Sentence case everywhere, including section headers and
chips; the only capitals are an alliance name and a finding code, which are identifiers.

**Units are a suffix.** `24.50` in `--text-hi` mono, 4 px, then `in` in `--fs-xs` `--text-lo`.
Degrees show as `°`. Files are radians; the UI converts.

## 6. Spacing, sizing, radii, elevation

**Spacing** is the 4 px scale `--space-1` … `--space-16`. `--pad-panel` 16 px inside a panel,
`--pad-row-x` 12 px in a row, `--pad-modal` 24 px, `--gap-section` 24 px between sections outside
the Inspector. Proximity: 4 px label to value, 8 px field to field, 24 px section to section. v2 is
roomier than v1 on purpose: rows are `--row-h` 32 px (v1 28), controls `--ctl-h-md` 28 px, tool
buttons `--ctl-h-tool` 32 px. The Inspector is denser (issue #431, section 9.5): 28 px
`--row-h-inspector` headers and rows, 24 px `--row-h-list` list rows, labels at
`--inspector-gutter` 24 px and values at 120 px (`--inspector-label-w` 88 px), still at or above
`--ctl-h-sm`.

**Radii.** `--radius-xs` 4 px chips, inputs and tool buttons; `--radius-sm` 6 px popovers, menus,
tooltips and the field board; `--radius-md` 12 px modals, the palette and the tour card;
`--radius-pill` for severity dots, the `?` affordance, the alliance pill and the tour step dots.
Outer equals inner plus padding.

**Elevation.** Three shadows, each with a 1 px top highlight because a drop shadow alone does
nothing on this ground: `--shadow-raised` (a pressed-in control, rarely), `--shadow-popover`
(menus, tooltips, the context menu), `--shadow-modal` (modals, the palette, the tour card).
`--shadow-ember` is the single tinted shadow, under the one primary button. No shadow on a panel,
a table or a row. Layers are the `--z-*` scale; the tour's cards sit on top at `--z-tour`, and its ring under the popovers at `--z-tour-ring`.

## 7. Motion

`--dur-base` 120 ms `--ease-out` is the house transition (hover, tooltip, disclosure, row
selection). `--dur-fast` 80 ms for press feedback. `--dur-slow` 180 ms, `--ease-in` on exit, for
modals and the palette. `--dur-tour` 240 ms `--ease-out-expo` for the tour's ring moving between
stops. Only `transform` and `opacity` animate, plus the tour ring's box.

Nothing on the canvas animates by itself except playback. A dragged point follows the pointer at
`--dur-none`, and the numbers that change during a drag update without a transition. Playback and
the hover robot outline are driven by `requestAnimationFrame`. `prefers-reduced-motion` sets every
duration to 0 in `tokens.css`; the tour then cuts between stops.

## 8. Iconography

Lucide only, `size={16}` (`--icon`), `strokeWidth` 1.75 (`--icon-stroke`), `--text-mid` at rest,
`--text-hi` on hover, `--accent` when active. 12 px (`--icon-sm`) inside a chip, 20 px
(`--icon-lg`) in a menu's leading slot, 32 px (`--icon-xl`) in an empty state or a tour choice.
One glyph per concept, used everywhere that concept appears (toolbar, insert menu, step row,
palette, context menu). Step kinds come from `src/lib/stepKinds.ts`, which this table mirrors:

| Concept | Lucide | Concept | Lucide |
|---|---|---|---|
| Select | `MousePointer2` | Path step | `Spline` |
| Command step | `Zap` | Wait | `Hourglass` |
| Sequence | `ListOrdered` | Parallel | `Layers` |
| Branch | `GitBranch` | Marker | `MapPin` |
| Heading | `Compass` | Snap | `Magnet` |
| Measure | `Ruler` | Validate | `CircleCheck` |
| Instant sim / play | `Play` | High-fidelity sim | `Cpu` |
| Save | `Save` | Propose / PR | `GitPullRequestArrow` |
| Mirror alliance | `ArrowLeftRight` | Help | `CircleHelp` |
| Error | `OctagonAlert` | Warning | `TriangleAlert` |
| Info | `Info` | Tour | `Map` (never `Sparkles`) |
| Waypoint | `Flag` (never `MapPin`, which is the Marker) | Full tour | `MapPlus` |
| Publish to the team library | `CloudUpload` (the palette and the Share sheet) | | |

A section heading's glyph, as the waypoint sections' flag, is 12 px at `strokeWidth` 1.5 so it
matches the 12 px chevron beside it; that and the tour task's done check (12 px at 2.5, drawn in a
small filled disc) are the only places the stroke is not 1.75. There is no 14 px icon: a glyph is
16 px, or 12 px inside a chip or as a mark beside text (the external-link mark, a select's chevron).

No emoji, no second icon set, no icon inside a coloured tile.

Words follow the same rule: one name per concept, the same in every menu, palette row, tooltip,
status line, tour stop and doc. The planned thing is an **auto** (never a routine or an autonomous;
"autonomous" is only the match period). The bundled project is opened with **Open the example**;
a robot repository's folder with **Open a folder…** (**Open another folder…** once one is open),
and the dialog of every way to open is **Open project**. The robot repository's own simulator is
the **high-fidelity sim**, which **Simulate** runs; **Full sim** names only the playback level that
plays its trace. Adding a revision is **Publish to the team library**, and fetching for an event
with no Wi-Fi is **Keep for offline**. Every review mode (a pull request, a library comparison, an
owner's proposal review, a proposal edit) is left by a text action **Leave** whose tooltip names
what it leaves ("Leave the review", "Leave the comparison", "Leave the proposal").

## 9. Components

### 9.1 Title bar

`--titlebar-h` 36 px, `--bg-chrome`, `--z-titlebar`, with the horizon line
(`--horizon-w` 2 px `--brand-gradient-horizon`) as its bottom edge instead of a border. Left to
right: 16 px gutter; the Zenith wordmark (`/brand/zenith-wordmark-dark.svg`, 16 px tall, which puts
its Z at the cap height of 20 px Jost, `alt="Zenith"`; section 2.1); 8 px; a 1 px by 14 px hairline in
`--chrome-border-strong` with 4 px either side; 8 px; Horizon's white text logo
(`/brand/horizon-wordmark-white.svg`, the team's file unedited, 20 px tall so its capitals are 12 px,
`alt="Horizon"`); 16 px; the
open auto's name in Plex `--fs-sm` `--text-mid` and its folder or `owner/repo@branch` in mono
`--fs-xs` `--text-lo`; an unsaved dot in `--text-mid` (never a colour). Right: the alliance pill,
then on desktop the window controls (Electron `titleBarOverlay`, which draws native buttons over
our colour). The whole bar is a drag region except its controls. The web build shows the same bar
without window controls. The window controls keep their size when the page zooms, so on desktop the
bar's height and right padding come from the controls' area (`env(titlebar-area-*)`): zoomed out,
the bar grows to the controls' height so they never hang over the toolbar.

### 9.2 Toolbar

`--toolbar-h` 44 px, `--bg-app`, no bottom border (the panels below are lighter, which is the
edge). Groups 16 px apart with no divider line:

```
tools (select · path · marker · heading · measure · snap · option slot)   optimize ▾   undo · redo   run (validate · play · sim)   share (save · propose)   view (mirror)
```

It is one row that never wraps. When the window is too narrow for every group, the groups that do
not fit go, last first, into a More tools menu (an `…` icon button at the end of the tools) so the
right cluster stays on screen; its entries carry the same active and on/off state as the buttons
(`menuitemcheckbox` with `aria-checked`), and a tour stop whose anchor is in it rings the More
button. Only on a phone, where even that cannot fit, does the row scroll sideways. A tool's option (such as
Extend this chain) keeps a reserved slot at the end of the tool group, so choosing a tool never
shifts the groups after it. The Optimize wand is a group of its own, with a chevron (9.18). Propose
is drawn only for a project opened from GitHub. With no auto open the tools are disabled with a
reason, and a disabled tool is never drawn as active. `Esc` first leaves a tool other than Select
for Select and keeps the selection; the next `Esc` clears the selection.

The right cluster is search, Settings, Documentation (a book icon) and Help, in that order. Below
1100 px of window Search is icon-only and the Documentation book is hidden; the Help menu keeps
Documentation. The Help menu's items are Documentation, Take the tour, Take the full tour, Choose a
preset…, Keyboard shortcuts, What's this and Report a bug, and no Search actions. Documentation
is the action `help.docs`: it opens the docs in a new tab, so it is a momentary button with no on
state. The same action is the first item of the Help menu and is found in the palette by `docs`. An
item or button that leaves the app for another page carries a 12 px external-link glyph in its
menu row (`ActionDef.external`); the toolbar button's tooltip says what it opens. The address is
`DOCS_URL` in `src/account/config.ts` (`VITE_DOCS_URL` at build time overrides it) and every docs
link is built from it with `docsLink()`, never typed. The button is the future issue #200 registry
entry `display.toolbar.docsButton`, on in every preset.

Undo and Redo are momentary buttons: they do something each press and have no on state, so they
carry no `aria-pressed`. While a proposal is open they move the proposal's own history, never the
auto underneath (`edit.undo` and `edit.redo` in `src/app/actions.ts`). The tour's Run stop anchors on
the group that holds Validate, not on a group's position.

Tool buttons are `--ctl-h-tool` 32 px square, `--radius-xs`, 16 px icon. Rest transparent
`--text-mid`; hover `--bg-hover` `--text-hi`; **active tool**: `--accent-muted` fill, `--accent`
icon, and a 2 px `--brand-gradient` bar inset at the bottom. A toggle that is on (snap) is the fill
and icon without the bar. Disabled is `--text-disabled` and keeps a tooltip that says why. Primary
actions that are text (Propose on the desktop) use the primary button (9.9).

### 9.3 Region titles and section headers, with the `?` affordance

**Region title** (Steps, Findings, Ledger): a 40 px header, `--pad-panel` left, Jost 500
`--fs-lg` `--text-hi`, sentence case. Region actions sit right-aligned as ghost icon buttons. The
Inspector has no region title (issue #431): its **selection header** takes the place, and its
panel keeps `aria-label="Inspector"` and the tour's `inspector` anchor.

**Selection header** (`SelectionHeader.tsx`): one 40 px row with a `--border-default` hairline
under it, which never scrolls. Left to right: the kind's icon (14 px, `--text-lo`; the kind word is
its `aria-label` and tooltip), the id in Jost 500 15 px `--text-hi`, then at the right the facts
that need no row as quiet 12 px icons (`HeaderMark`: an anchor for a command that stands still, a
clipboard for a transfer's Planner only, their words in the tooltip and, in With descriptions,
beside them), the estimate in mono `--fs-xs` `--text-lo` (`4.12 s`, `≤ 1.00 s`, `at most 2.60 s`,
`no estimate`; never a dash and a unit), at most one header action and the `?`, which is always
visible. The estimate's long-hover hint says what it is and holds what it leaves out, such as the
strafe fraction. A marker's header is a breadcrumb, `collectFlower › Marker 1`, whose path id is a
quiet button that selects the path, and its bin is the header's action. A waypoint's header is the
pin's name with ⋯ (Rename, Delete, Select the points that follow it). With nothing selected it
reads **Routine**, and its `?` says to select a step or a point to edit it. The kind's `?` is the
header's; the kind's own section does not repeat it. The Inspector has no Optimize button (9.18).

**Banners** that come and go with the selection (the made-with chip, the Selection line `3 points
in 2 steps` with **Clear selection** · `Esc`, and in With descriptions the estimate's brief) are
one 28 px row each directly under the header, above the first section, in `--text-mid` with their
text button at the right.

**Section header** (inside the Inspector: PATH or PATHS, HEADING, SPEED, MARKERS, WAIT, COMMAND,
GROUP, STEPS, BRANCH, TRANSFER, ADVANCED, NOTES, START, WAYPOINT, WAYPOINTS): a 28 px
(`--row-h-inspector`) row with a filled 8 px disclosure triangle at 8 px in `--text-lo`, turned
down while open, then the title in Plex 600 `--fs-xs` uppercase with `--tracking-section` 0.07em in
`--text-mid` (uppercase by CSS only: the DOM, and a screen reader, keep the sentence-case word).
Every section has a full-bleed 1 px `--border-default` hairline under it (layout rule 3). Caps are
for section titles only, small and quiet, never for values or codes.

- **Count.** A list section shows how many it holds after its title in quiet mono: `PATHS 2`,
  `STEPS 2`, `WAYPOINTS 7`, `MARKERS 1` (none while empty).
- **Dots.** While folded, a 5 px dot after the title says something is set inside (`marked="set"`,
  `--text-lo`: written notes, a time limit in Advanced), or, in lemon `--sev-warn`, that something
  inside needs a look (`marked="warn"`: a wait for a condition with no time limit). Open, the rows
  and their chips say it themselves.
- **Folded summary.** While folded, a header may show what the section holds after its title, in
  Plex `--fs-xs` `--text-lo`, cut to one line (`summary`): `PATH line → scoreSouth`, `HEADING
  Tangent`, `SPEED 80% default`. Advanced and Notes have none: their dot says enough.
- **One header action.** At most one ghost action at the header's right edge, after the `?`: a +
  (Add path to chain, Add marker, Add waypoint), a bin (a stay-inside box, a rejoin pose) or a
  pencil (Switch to Linear). A click anywhere else on the header folds the section.
- **Sub-groups** (`Section variant="sub"`): a group inside a section, such as one path of a chain,
  `Path 1`, has a sentence-case 13 px title with its triangle at 22 px and no hairline; its rows
  move 16 px in, so their labels start at 40 px and their values keep the 120 px column. Its bin
  shows on the header's hover or focus only, and always on a touch screen.
- **Row disclosures** (`variant="row"`): a disclosure drawn as a row of the grid, such as a curve's
  **Controls** `3 points`, with its triangle in the gutter, its title in the label column and its
  folded summary in the value column.
- **Remembered folds.** An Inspector section's fold is remembered per person and per kind of
  section, not per step or per place in the tree: `prefs.inspectorFolds` in `zenith.ui`, keyed by a
  stable id such as `path.heading`, `step.more` or `envelope` (`foldId`). Every section starts open
  except `step.more` (Advanced), `step.notes`, `path.controls` and `transfer.counts`.
  `routine.start` and `waypoint.list` sit in the Routine view, not under a step (section 0): the
  start is open, and the list is open while the project has waypoints. In an Inspector narrower than
  300 px, Speed and Markers start folded too. Only a click on the header writes the memory. A forced
  open, the tour's reveal, a selected point or control point, a selected waypoint or the way back
  from a marker opens a section for now and leaves the memory as it was. The folds are layout, so
  no preset writes them.

**The `?` affordance** sits 8 px after every region title and section header text. A region
title's `?` is always visible. A section header's `?` is revealed on the header's hover or focus
(by opacity, so it keeps its place and stays in the tab order):

- A `--help-size` 16 px circle, `--radius-pill`, 1 px `--border-strong` ring, a `?` in Plex 500
  11 px `--text-lo` centred. Hover: `--text-hi` and `--bg-hover` fill. It is a real `<button>` with
  `aria-label="What is <section>?"`, in the tab order after the header.
- Opens a **help tooltip** on hover after `--help-delay` 150 ms, on keyboard focus immediately, and pinned
  on click (click again, Escape or a click elsewhere closes it). The text comes from
  `src/help/content.ts` (`PANEL_HELP`), never from the component.
- Help tooltip: `--bg-raised`, `--radius-sm`, `--shadow-popover`, `--z-tooltip`, 12 px × 16 px
  padding, `--tooltip-max-w` 280 px. Title line in Jost 500 `--fs-md` `--text-hi`, then the one or
  two sentences in Plex `--fs-sm` `--lh-md` `--text-mid` (the body is at most 220 characters; the
  detail belongs in the docs), then optionally text links in `--accent`: "Show me", which starts the
  tour at that feature's stop, and, only while the tip is pinned, "Read more" with an external-link
  mark, which opens the entry's `docs` page and heading in a new tab. The hover bubble is a
  `role="tooltip"` and holds no link. Every panel entry has a `docs` value, which `help.test.ts`
  checks against `site/docs/`. Placed below-start of the `?`, flipped to
  stay on screen, 8 px off it, no arrow.

The section header is not itself a tooltip trigger; only the `?` is, so hovering a header while
reading does not pop text over the inspector. The `?` of a section header sits before its one
action, so the action keeps the right edge whether the `?` shows or not.

### 9.4 Tooltip contract (every control)

Every interactive element that is not a labelled text button has a tooltip; a missing one fails
review. Content: the action in sentence case, then the shortcut in mono `--fs-xs` `--text-lo`,
right-aligned after 8 px (`Add path` · `P`). A second `--text-mid` line when the action is not
obvious from its name, when the control is disabled (it says why), or when it is a drag target (it
names the keyboard equivalent). Timing `--tooltip-delay` 400 ms (a row hint waits `--hint-delay`,
800 ms; see Row hints below), `--tooltip-skip-delay` 100 ms within a group, instant on keyboard focus, instant close on leave or pointer down. Focus opens a
tooltip only when it came from the keyboard: the last input was a key press
(`src/components/inputModality.ts`) and the element matches `:focus-visible`. Code that moves focus
after a click, a right-click, a drag or a drop never opens one, and nor does a page focusing a control
as it opens before any input, such as the admin page's Close. A field a person types into (a text input, a
textarea) never opens its tooltip on focus, and not on hover while it has focus: browsers draw the
focus ring on a clicked text field too, and the bubble would cover the field's own buttons and error
line while someone types. Its words stay in a hidden `aria-describedby` description. At most one tooltip, `?` help tips included, is
on screen at a time: opening one closes the one before it (`src/components/tooltipGate.ts`). Surface as the
help tooltip but 6 px × 8 px padding and no title line. One `Tooltip` component; it sets
`aria-describedby` and never replaces an `aria-label`. The shortcut map is one table in
`src/app/shortcuts.ts`; tooltips, menus, hints, the tour and the palette read a key only through `keyLabel(id)` or `useKeyLabel(id)`, and a test fails on a `SHORTCUTS` read anywhere but `shortcuts.ts` and `keymap.ts`.

**On touch** there is no hover, so a finger opens a tooltip two ways. Holding a control for about
450 ms opens it; the hold is cancelled by a lift, a cancel, or more than 8 px of movement. A tap on
an `aria-disabled` control opens its reason straight away. Either way the tooltip stays through the
lift's `pointerleave` until the next press anywhere or 4 s. The hold's own `contextmenu` is
prevented and the click it ends with is swallowed, so a long press explains a button without
pressing it. A text field takes no hold (a long press there selects text).

**Row hints** (issue #237). A row that has no tooltip of its own, an Inspector field row
(`FieldRow`) or a Settings `Row`, can take a `hint`: one or two plain sentences saying what the row
is for. A row normally takes it from the description table with `describe` instead (9.13). Its label is the trigger of the same `Tooltip` with `delay="long"`, which opens after
`--hint-delay`, 800 ms. That is SET BY HAND at twice `--tooltip-delay` (CARRIED OVER, 400 ms),
because a row is where the pointer rests while someone reads, and it is one token so the beta can
tune it. Every other tooltip keeps 400 ms. The 100 ms skip delay, one tooltip at a time, closing on
leave and closing on pointer down all hold, and a press anywhere closes an open hint. The same words
are always the `aria-describedby` of the row's controls, so a screen reader hears what the hover
shows. On touch, the 450 ms hold on the label opens the hint, except in a row that drags (a step row,
marked `data-drag-row`), which keeps its drag. **Shift F1**, "What's this" (the Windows convention,
beside the step list's Shift F10), opens the focused element's full hint: its row's hint when the
row has one, otherwise its own tooltip. It works in a text field too, which opens no tooltip on
focus. Esc closes it and does nothing else, and so do a press anywhere and focus moving away. The
shortcut sheet and the Help menu list it. Chosen from the Help menu or the palette, where focus is on
the item itself, it is a one-shot mode: the cursor turns to `help` everywhere, the status line says
"click a control or a row", and the next press opens that target's hint instead of pressing it. Esc
leaves the mode, and a press on something with no hint says so and leaves it too.

### 9.5 Inspector field row

**The grid** (issue #431, `INSPECTOR_GRID`). Every row of every Inspector section sits on one fixed
two-column grid: the label at 24 px (`--inspector-gutter`) in an 88 px column
(`--inspector-label-w`), the value left-aligned at 120 px to the right edge, an inline chip after
the value, and one 24 px inline action at the far right. Rows are 28 px (`--row-h-inspector`);
list rows are 24 px (`--row-h-list`). A sub-group moves the gutter to 40 px and narrows the label
column to 72 px, so values still start at 120 px. Settings and the dialogs keep their own
right-aligned rows.

- Label: Plex 12 px (`--fs-label`) `--text-lo`, sentence case, no colon.
- **Value at rest is text, not a box**: 13 px `--text-hi`, mono for numbers (12.5 px), left-aligned,
  tabular, with its unit suffix in 11 px `--text-lo`. Boxed controls pull back over their own
  padding and border, so their text starts exactly on the 120 px column. Hover shows the input:
  `--bg-inset` fill, 1 px `--border-strong`, `--radius-xs`, `--ctl-h-md` 28 px, the value in place
  so nothing moves. Focus adds `--ring-shadow`. A number and a select are as wide as what they show
  (`field-sizing: content`), so a unit sits right after its number. A select looks the same with a
  12 px chevron that appears on hover.
- **Quiet defaults** (`quiet` on `FieldRow`, `SelectField`, `NumberField`, `ChoiceField` and
  `SourceSelect`): a value still at its default, or read only, is drawn one step dimmer in
  `--text-mid`, so the values that were set stand out: From "Last step's end", Speed `80% default`,
  Stop early "Never", Give up after `none`, a planned heading, a followed waypoint's position.
- **No prose in the panel.** Words that once sat on screen are tooltips: "Select a step or a point
  to edit it" (the Routine header's `?`), Stands still (an anchor), "ends the group" (a flag), a
  followed waypoint's pose on an end that is not selected (its select's tooltip). In With
  descriptions they are drawn as quiet briefs.
- **Angles and units.** An angle field wraps to (-180, 180] with one decimal. The degree sign and
  `%` sit tight against the number (`90.0°`, `80%`); other units keep their space (`12.0 in`). An
  empty nullable field shows no unit.
- **Ranges are said, never clamped in silence** (issue #502). A number field's tooltip ends with its
  range (`Runs 1 to 100%.`, `Takes 0.1 in/s or more.`). A typed value outside it, or text that is
  not a number, is refused: the field puts back what the file holds and the status line says the
  range once, `Speed runs 1 to 100%.` or `Speed takes a number from 1 to 100%.`, and goes by itself
  as a refused edit's line does. The arrows and a scrub still stop at the ends, which the person
  sees happen. Ranges match the real thing: a pose's x and y run across the field and the robot's
  half-diagonal past each wall (`poseBounds.ts`; a curve's control points are shape handles and are
  not held); a robot's sizes, speeds and accelerations have ceilings well past any FTC robot. A team
  number is read by one rule everywhere (`lib/teamNumber.ts`): a whole number from 1 to 999999, and
  one sentence under the field for anything else.
- **A dialog's text field** (`TextField wide`) is the label on its own line and a box the dialog's
  full width under it, with a resting `--border-default` edge on `--bg-inset`, for words a person
  writes (an auto's title and authors, a robot class). A note about what is in it sits under the
  box in `--text-lo` and follows what is typed; a problem with it sits under the box in
  `--sev-error`, with the box's edge in the same colour, never at the dialog's foot.
- **Stacked rows.** `FieldRow` has a stacked variant for a long label with buttons: the label on
  its own line and the value and buttons under it. The Inspector no longer needs it.
- A numeric value without focus scrubs on horizontal drag past a 3 px dead zone, measured from its
  edge: 4 px per step, 1° per px for an angle (`Shift` ×4, `Alt` ÷4), one undo step for the whole
  drag, `Esc` puts the value back. Each value it writes is rounded to the field's decimals, so it
  never stores a number the field cannot show (a count stays whole). A click that does not pass the
  dead zone focuses the input with its text selected; once it has focus, a drag selects text and the
  cursor is the text cursor rather than `ew-resize`. The tooltip names `↑ ↓`.
- **Long values** get the room from 120 px to the action and are cut with an ellipsis; the whole
  choice is the control's tooltip. A label of two lines wraps rather than squeezing its value.
- **Provenance chip**: mono `--fs-xs`, `--radius-xs`, `--ctl-h-sm` tall, tier colour text on the
  tier `-bg`. The derived tier is the quiet default. A pose with no provenance shows "Needs meas.",
  never an empty slot. Clicking opens the provenance menu. On a pose row the chip is **short** and on
  a line under the numbers, at the value column. Elsewhere in the app, a single value with a chip,
  such as a robot setting, shows the full sentence-case label ("Needs measurement", "Set from
  editor"; the file keeps the canonical capitals) on a line under the value.
- **Pose row** (`PoseRow`): one row for a point's own pose, each curve control point, the start,
  a rejoin pose and an envelope's corner. Label, `x`, `y` in two 54 px mono inputs, the unit `in`
  once, then the short chip under them. A followed waypoint's pose is a quiet read-only row instead,
  `Position  -13.00  -36.00 in`. A waypoint has no pose row: it is one 24 px row of the Waypoints
  list (issue #245): its name at 24 px, `x`, `y`, heading in degrees with one decimal
  (`CompactNumber`), with its eye in the gutter and its ⋯ at the end shown on hover or focus (a
  hidden pin keeps its eye-off visible), under one quiet line that holds the **Pins** choice (All,
  This auto's and None; its tooltip counts the hidden pins) and the `x y heading` column heads. A
  long name is cut in the middle so its end still shows. A row has no pencil or bin; the ⋯ menu has
  Rename, Delete and Select the points that follow it. A selected pin's own **WAYPOINT** section
  comes first: **Label** (its short chip and menu) and a quiet **Used by** row whose hint has the
  full lists; its numbers are edited in its list row only. The list is `WAYPOINTS 7` for this auto's
  and `OTHER WAYPOINTS 2`, folded, for the rest. The short labels are Needs meas., Placeholder,
  Approx, Set by hand, Measured, Spec, Carried over, From sim, From editor, Calib. sim and Calib.
  robot; the chip's tooltip gives the full label, its note and what it means
  (`shortProvenanceLabel` in `lib/provenance.ts`, unit-tested to stay within 12 characters). Each
  input is a number field in every other way: it scrubs, steps and types as in this section. A
  curve's control points are shape handles, so they show a provenance chip only on the selected
  point; the From and To poses keep theirs.
- **Inline row actions** (a crosshair, a pencil, a reset) sit in the row's one action slot at the
  far right; they are ghost icon buttons in `--text-lo`, never a row of their own. A text button
  (`TextButton`) is accent words with no box until hovered, used in the value column where a row's
  value is an action, such as **Draw box**, **Add 24 in** or **Add**.
- **Hover-only list actions.** A list row's bin, scissors, eye or ⋯ shows on the row's hover or
  `:focus-within`, by opacity so it stays in the tab order, and always under `(hover: none)`.
- **Source select** (`SourceSelect`): where a path end is, as one select, with the ends it can
  take first (Last step's end, drawn quiet, and This pose) and then a Waypoints group, and its
  inline action at the row's end (a crosshair to select the waypoint followed, a bookmark-plus to
  save one, shown only on an end that has its own pose). The Start is one `Pose` source select like
  a path end, with This pose first, and a start that follows a waypoint shows its Position and
  Heading as quiet rows. In a chain, a later path's From that joins the earlier path's To is the
  read-only line `End of Path n`; the joint is edited under the earlier path's To.
- **Status chip** (`StatusChip`): a warning about a value, such as "No time limit: may wait to the
  end", in its row's chip slot (lemon, the unverified tint), or a quiet state such as a branch's
  `guess`. Plex `--fs-xs`, sentence case, `--ctl-h-sm` tall. It is state, so it shows in both
  description modes, and its tooltip says what it means.
- **Number and unit** (`NumberUnitField`): a number whose unit is a quiet select, such as a
  marker's At, `50% along`, `12.0 in from start`, `in from end`.
- **A selected point** shows in place (issue #243). The block of the primary selected point, a
  path's From or To (source, position and heading) or one control point, takes `--bg-selected`
  and a 2 px `--accent` bar drawn as an inset shadow, so selecting moves no value, and scrolls into
  view with `block: nearest`. Its path, and for a control point its Controls, are forced open
  (`Section forceOpen`, which writes no fold memory) and the chain's other paths fold. With several
  points selected only the primary is marked, and the Selection banner says what is selected.
- **Heading.** A path's heading is shown and edited in its HEADING section. A heading row shows only
  on the primary selected path end: the angle alone (`180.0°`), with the mode in its tooltip and
  hint, and a pencil at its end that focuses the Heading section's field (switching to Linear first
  under a derived mode, and opening the piecewise range that decides it). Under Tangent, Reverse
  tangent or Facing point the Heading section carries the quiet `Planned a° → b°`, and the
  section header's pencil is the one **Switch to Linear**. Every heading readout uses
  `radToDeg(wrapAngle(rad))` with one decimal and the ° tight: a constant heading of -π reads
  `180.0°`.
- **One name for the time limit.** A step's `timeoutS` is **Give up after** on every kind: in SPEED
  beside **Stop early** for a path (a student treats them as one decision), in WAIT for a wait for a
  condition, and in ADVANCED for a command or a wait for a time.
- **Rows by kind.** Speed shows in percent with a reset `RowButton`. A path's condition row is
  **Stop early**, with **Never**. A parallel group's end is **Ends with**, and the member that ends
  it carries a flag in the STEPS list. A branch's **Preview follows** carries a `guess` chip. A
  step's notes are the folded NOTES section, in a `--bg-inset` well that is the box.
- **Piecewise heading editor.** An 18 px track from 0% to 100% with its ticks, a block per range
  (a block too narrow for its label shows none and carries a tooltip naming its mode; the hovered
  or open range is underlined in `--canvas-annotation`), then one 24 px row per range on the grid,
  numbered, `1  0–18%  Linear  90.0° → 135.9°`, where a range the path decides reads "follows the
  path". A click opens its Mode, Ends at and angle rows; its scissors and bin show on hover or focus.
- **Stay-inside box.** The Advanced row reads **Stay inside**, with **Draw box** and **Add 24 in**.
  A box the step has is its own **Stay-inside box** section.
- **Markers.** A selected marker shows alone under its breadcrumb header; no Heading, Speed or
  Markers section is drawn beside it. The MARKERS title counts them, its + adds one, and an empty
  list is the header alone. The At units read `% along`, `in from start` and `in from end`.
- A read-only computed value is quiet `--text-mid` mono with no hover input. A step's estimate is in
  the selection header (section 9.3), with the strafe fraction in its hint.

### 9.6 Step list row

`--row-h` 32 px, `--pad-row-x`, columns `[drag 12] [kind icon 16] [name 1fr] [time, mono,
right-aligned] [finding dot 8]`.

- Drag handle appears only on row hover or focus (`--text-lo`), with no tooltip of its own;
  `Alt + ↑ / ↓` is the keyboard equivalent.
- Kind icon from section 8 in `--text-mid`. A turn on the spot, a path step with no length (core's
  `isTurnInPlace`), reads as a turn wherever a kind shows: the insert menu's `RotateCcw`, "a turn on
  the spot" in the row tooltip, and an Inspector of Heading and Turn only, with Edit as a path to show
  the rest (`TURN_ICON`, `TURN_NOUN` in `src/lib/stepKinds.ts`).
- Name: Plex `--fs-sm` `--text-hi` (a step's id is an identifier, but it is also the thing people
  read; mono is for the id chip in the inspector). No box or pencil on the name, only a text cursor,
  and no tooltip on it.
- Time: right-aligned mono, `3.52 s`, with the Inspector's two decimals (`format.seconds`), so one
  number reads the same in both; an em dash when unknown. No estimate bar on rows; the bars live only
  in the timeline.
- One long-hover tooltip for the whole row: `<id>, a <kind>, about N s`.
- The focus ring is inset across the full row.
- No inline Connect block: a gap between steps shows as the dot, with its fix in Problems.
- Finding dot: 8 px `--radius-pill` in the worst severity on that step, no count badge in the row
  (the count lives in the findings panel). v1's red count pills (`4`, `2`) are removed.
- Selected: `--bg-selected` with a 2 px `--accent` bar on the left edge that replaces padding.
- **Running** (issue #111): while the playhead is placed, every step running at it, the groups it
  sits in and each running branch of a parallel group, is `--bg-running` with its name at weight
  500 and a filled 12 px Lucide `Play` in `--text-hi` in the drag handle's cell (the handle takes the cell
  back on hover and focus). The row has `aria-current="step"` and a visually hidden ", running" in
  its name, so it never reads by colour alone. No bar: the left edge belongs to the selection, and a
  selected row that is running keeps `--bg-selected` and gains the mark and the weight. The set comes
  from the playback level's own timing (`lib/activeSteps.ts`), and the list draws again only when the
  set changes, not every frame.
- Nesting indents 16 px with no guide line; the group's own row carries the chevron.
- **Insert** is a text button at the end of the list: `+ Insert step` Plex `--fs-sm` `--accent`,
  shortcut `Enter` in mono `--text-lo`. Not a dashed box.
- **Selecting several.** Ctrl-click adds a row or takes it out. Shift-click selects the run of rows
  on show from the last row clicked without Shift to the clicked one, as Shift with an arrow walks one;
  when both rows share a list, only that list's rows are taken, so a group between them goes in whole
  and Wrap can wrap the run. With several selected, the Inspector shows the clicked one under a line
  that says so: "3 steps selected. The fields below change driveOut only.", with Select only driveOut.
- **Header actions.** `N steps selected` text when more than one is selected, then `+` Insert step
  (`Enter`), Duplicate and Delete, whose labels count what they touch.
- **Every edit answers** on the status line (9.15), in the past tense: "Added turn after path3.",
  "Wrapped path2 and path3 in group1.", "Renamed a to b.", "Moved wait before path3.", "Moved wait into
  sequence1.", "Added a marker on driveOut at 30 % that runs intakeOn."
- **Renaming** (F2 or a double-click) holds a step's id to the waypoint name rule: a letter, then
  letters, digits, `_` or `-`, at most 64 characters (core's `stepIdProblem`). An id outside it, or one
  another step has, is refused with the reason on the status line, and Enter keeps the field open so
  the person can fix it. A file with an old id still loads; Problems warns (`STEP_ID`) with a one-click
  rename.
- **A default insert starts clean.** Insert a path, Sequence and Parallel never hand the person an
  error they did not draw: the new leg is the first of a few short legs from the anchor that raises
  no error the anchor does not already have, and a group whose every leg would hit something holds a
  wait instead, which the status line says.
- **Step menu.** It hides what cannot apply to the kind: Join with next path only on a path,
  Unwrap group only on a group. Labels say what they touch: `Insert a path after`, `Insert another
  step after…` (the field's menu says the same two), `Duplicate 2 steps`, `Delete group and its 3
  steps`. Wrap is disabled with "Pick steps in
  the same list to wrap them." when the selection spans lists.

### 9.7 Findings row

The panel header is the region title plus counts: `3 errors · 5 warnings · 2 info`, each count in
its severity colour, each a filter toggle. In a header narrower than about 360 px (the panel under
a narrow field) a zero warnings or info count is dropped, since the rows say there are none; the
error count always stays, and the clip ghosts toggle keeps its place at the end (layout rule 9).
The rows:

```
[severity icon 16] [message, 1fr, one line] [code chip] [step name, --text-lo]
                   [fixes, selected row only, on a line of their own under the message]
```

- **One line.** An unselected row is one `--row-h` line; the message is cut by an ellipsis, and its
  full text is a long-hover tooltip (label the help title, hint the message). Pointing at a row never
  moves the others.

- **No row tint.** v1 washed every error row in `--sev-error-bg`, which turned the bottom third of
  the screen red. v2 rows are `--bg-panel`; severity is the 16 px icon (section 8) in its colour.
- Message first, in Plex `--fs-md` `--text-hi`: it is a sentence and it is what a newcomer reads.
- Code chip after it: mono `--fs-xs` `--text-lo` on `--bg-hover`, `--radius-xs`, with a tooltip
  holding the code's "what this means and how to fix it" line from `findingHelp`.
- Hover `--bg-hover`; click selects the step and pans to the geometry, which draws in
  `--highlight-find`. Only the selected row shows its fixes, on a line of their own under the
  message, as verb-and-noun ghost buttons (`Point nose along path`, `Slow sweep`, `Join paths`) with
  core's full label in the tooltip. There is no "How to fix" line; that text stays in the code
  chip's tooltip.
- Empty: "No problems found." then "Checked as you edit." in `--text-lo`. The checks run on every
  edit, so a time since the last Validate would only make a fresh result look old.
- **Header.** The `TIME_BUDGET` info note is not listed or counted (the timeline says the same).
  The clip ghosts toggle is an icon-only button at the far end of the header, with the tooltip "Show
  where the robot hits the wall".
- **Collapse and height.** Collapsed, the panel keeps its 32 px header with the tabs and counts, and
  a tab or count click expands it. When an auto opens with an error or warning, the panel gets room
  for 4 rows (188 px). Opening the Code tab raises the panel to 60% of the column, capped at 420 px,
  and Problems restores the earlier height. Neither applies once the person has resized the panel.

**The Code tab** (issue #102) sits beside Problems. The two tabs take the place of the Problems
title, in its Jost `--fs-lg`, the open one in `--text-hi` with a 2 px `--accent` underline, the
other in `--text-mid`. The header then carries the class file name and the library in mono
`--fs-xs` `--text-lo`, and a labelled Copy button at the right edge. The code sits on the panel,
no box: JetBrains Mono `--fs-sm`, line numbers in `--text-lo` that stay put when the code scrolls
sideways and are never copied with it. The selected step's lines are `--bg-selected` with the
2 px accent bar at the numbers; a step's lines hover `--bg-hover` and select the step on click.
Colours are the `--code-*` tokens only (keyword, string, number, comment). When there is no code,
one plain line says why, in the CLI's words where the CLI has them. With no step selected the tab
starts scrolled to `buildRoutine()`, and comment-only lines wrap at the visible width of the code
area.

### 9.8 Ledger

Folded by default to its region title with a one-line summary in `--text-lo` ("4 pollen
collected, 7 launched"). Open, it draws pieces rather than words (`panels/LedgerPanel.tsx`, from
`panels/ledgerView.ts`), with the field's piece glyphs below and every count as the number in mono
then its glyph:

- **Strip**, sticky at the top, `--bg-panel` with a `--border-subtle` rule under it: two rows, the
  label in `--fs-xs` `--text-lo` on the left, the meter on the right edge. Robot: a 12 px slot per
  piece of `capacity.max`, filled bottom first in the hopper's order, then `held/max` in mono
  (`max` in `--text-lo`, `held` in `--sev-error` when over). Hive: a slot per pollen the up cell
  needs to tip, after the nectar already in it drawn as nectar glyphs: nectar is heavier, so each
  one lowers the pollen the cell needs (the field's tip table), and there are that many fewer
  slots. The pollen in it fills the slots, then `pollen/needed`; the hint says what the nectar saved
  ("3 nectar in the up cell: it tips at 3 pollen instead of 8"), and the label adds the tips so far. Both are the ledger at the playhead, on the playback level's own clock, the
  one the step list's highlight uses (`panels/useLedgerPhases.ts`), so at the end of playback every
  step has run. On a narrow panel a meter drops below its label and stays on the right edge.
- **Step lines**, one per step that moved pieces: the step id in mono `--text-mid` on its own row,
  then one **flow** per movement, always the same pattern: where the pieces came from on the left
  edge, the pieces right up against an `ArrowRight` in a 72 px middle column (so the arrows line up
  down the list), and where they went on the right edge. Each end is a 12 px `--text-lo` icon for
  the kind of place (`Bot` robot, `Flower2` flower, `Sprout` garden, `Grid2x2` floor quarter,
  `Hexagon` hive, `SquareDashed` loading zone, `Hand` human player, `Users` partner,
  `CircleDashed` loose) and its short name ("flower 1", "red garden", "floor, garden side"). A
  collect ends at the robot, a shot at the hive, a shot that landed loose at **missed** in
  `--sev-warn`, and a tip starts at "hive tips" with a `RotateCw` icon and ends at the floor quarter
  the cell dumped onto, with what it dumped. A long name wraps rather than lose its end; below
  260 px of panel the icons go and the middle column is 64 px. The running step has the 2 px
  `--accent` bar; steps still to come are `--text-lo` with hollow
  glyphs (never opacity); while playing, the list keeps the running step in view below the strip,
  except for 3 s after the person scrolls it, as the step list does (issue #411). A line over capacity takes
  `--sev-error-bg` and the words "over capacity". The hint is the ledger's row in words.
- **At the end**, under a `--fs-xs` `--text-lo` caption: `--row-h-compact` rows of label and counts
  for the robot, our hive (tips and what it still needs to tip), every flower on one line (0 for an
  empty one) and each other place that holds a piece. Empty reads "empty" in `--text-lo`.

Piece glyphs in the panel take a ring in `--bg-canvas` on the dark theme and `--text-mid` on the
light one, so gold pollen keeps a 3:1 edge. A free slot, which either piece may fill, and a piece
of a step still to come are a neutral outline in `--border-strong`, never the piece's colour; nectar
keeps its dot, in the same neutral, so the two still read apart.

**Counts on the field** (`canvas/fieldCounts.ts`, issue #118), drawn while the Ledger switch is on.
A chip per place that holds pieces, at a fixed spot for its kind of place: an area's on its centre,
a flower's or a garden line's a few inches towards the field's centre, a hive cell's on the far side
from its other cell. Empty places have none, except the routine's up hive cell. One more chip rides
with the robot outline, above it unless the path or another chip is there, and says what the robot
carries at the playhead; the partner and loose pieces sit in a line at the top right. Each chip reads
`3 ●` per kind of piece, the number in mono `--fs-xs` then an 8 px icon: pollen a plain disc in
`--field-pollen` gold, nectar a ring round a dot in its alliance's colour (the number in
`--alliance-*-text`), the same colours the pieces are drawn in on the field. The icon's shape is the cue that is not colour. Chips are `--chrome-active` with
a `--chrome-border-strong` hairline and `--radius-xs` corners, fixed in both themes and over the light
field picture, because the well stays dark.

### 9.9 Buttons

| Kind | Look | Use |
|---|---|---|
| Primary | `--brand-gradient-button` fill, `--brand-ink` Jost 500 `--fs-sm`, `--ctl-h-lg` 32 px, `--radius-xs`, `--shadow-ember`; hover `--brand-gradient-button-hover` | exactly one per screen or dialog: Open project, Open the example, Save, Jump in |
| Secondary | transparent, 1 px `--border-strong`, `--text-hi` Jost 500 | the alternative in a dialog: Cancel, Take the full tour |
| Ghost | transparent, `--text-mid`, hover `--bg-hover` `--text-hi` | row actions, region actions, Back and Skip in the tour |
| Text | `--accent` Plex `--fs-sm`, no box, hover `--accent-hover` | inline actions: Insert step, Open project in an empty state |

Button labels are specific verbs, never OK. Disabled buttons stay focusable with a tooltip saying
why.

**One Button** (`components/primitives.tsx`) draws all four kinds, and every other module composes
its recipe (`composes: primary from "../components/primitives.module.css"`) instead of copying it,
so a primary looks the same in a modal, a sheet, the admin page, the tour and the host bar. A
disabled button is `aria-disabled`, never `disabled`, so it keeps its place in the tab order; it
takes `whyDisabled`, the reason, which its tooltip shows as "Unavailable: <why>". A disabled submit
button does not submit its form, from a click or from Enter.

**Copy** answers one way (`app/copyText.ts`): the button reads "Copied" where it is, for as long as
the status line beside it says "Copied the link." When the browser refuses, the text is selected
where it shows, the button reads "Press Ctrl C", and the status line says "This browser did not let
Zenith copy the link. It is selected: press Ctrl C to copy it." Text that shows nowhere is given in
the line instead. No Copy writes a sentence of its own.

A button that is busy keeps its verb and ends it with an ellipsis: "Sending…", "Publishing…",
"Saving…". Its disabled reason is a sentence: "Sending already.". A line that waits on a read says
what it reads, the same way: "Reading the team library…", "Loading…" only where nothing more exact
fits.

**Segmented switch.** One component, `Segmented` in `src/components/Segmented.tsx`, for every
choice among a few short words: the sharing sheets, Settings, Set up, the admin page and the
timeline's playback level (9.16). It is a named `role="group"` of `<button aria-pressed>`, each with
its own tooltip saying what it does; an option that cannot be chosen is `aria-disabled` and its
tooltip says `Unavailable:` and why. Test ids are `<testId>` on the group and `<testId>-<value>` on
each option. `size="small"` sets `--fs-xs` for a dense row; `keepFocus` stops a press taking focus.
Never hand-build another. Words: **Show** and **Hide** for something drawn or listed (finding codes,
clip ghosts, outlines, ledger counts), **On** and **Off** for a behaviour or a feature (Snap, the
feature switches).

### 9.10 Menus, the context menu and the command palette

Menus and the right-click context menu: `--bg-raised`, `--radius-sm`, `--shadow-popover`, 4 px
padding, rows `--row-h` with a 16 px icon, the label in Plex `--fs-sm`, and the shortcut right in
mono `--fs-xs` `--text-lo`. Group separators are 8 px of space and a `--border-subtle` rule. An entry
that deletes (`danger` on its `MenuEntry`) comes last, after a separator, in `--sev-error`. A row with
more than one or two actions keeps the main one (Apply) in the row and puts the rest in its `…` row
menu, as a preset in Settings does.

- **One menu row.** Every menu leads each row with its action's Lucide glyph at 16 px and
  `strokeWidth` 1.75, `--text-mid` (`--text-disabled` on a greyed row): the step row menu
  (`ActionMenu`), the toolbar and Help menus, the palette, and the canvas menu
  (`canvas/ContextMenu.tsx`, from each item's `icon`, which the shell fills from the action table).
  A choice shows its 16 px `--accent` check in that column instead. Once any row has a glyph every
  row keeps the 16 px column, so the labels line up.
- **Focus on open.** A menu focuses its first item as it opens, through `focusForInput` (section 11):
  opened by a right-click it draws no ring; opened by Shift F10 or the menu key it does.

- **Placement.** The canvas context menu is `position: fixed` at the pointer, flips to end above it,
  and scrolls when it fits neither way; it is never held to the canvas host. The insert menu is fixed
  to the window too, placed below or above its button, with its height capped to the window and a
  bottom fade while it scrolls.
- **Only what applies.** No tool, Snap, zoom or Optimize rows (the toolbar has them). Make curve or
  Make straight line, never both; Make smooth or Make corner, whichever changes the point. Unwrap
  group shows only inside a group.
- A quiet group label sits above grouped items (`Waypoint <name>`, `Show waypoint pins`, a label that says what its choices decide). Choices are
  `menuitemradio` rows with a check. A greyed item shows its reason in `--text-lo` under its label.
- The shortcut column never says "Double-click", and `Del` shows only on the item `Del` runs.

The **insert menu** uses the kind words Path, Turn, Command, Wait, Transfer, Sequence, Parallel and
Branch, and gives each kind its icon and its name, and in With descriptions its brief in
`--text-lo` on a second line (`INSERT_DESCRIPTIONS`), at `--row-h-comfortable` 36 px or taller; in
Labels only, the default, it is the name alone, so all eight kinds fit at 1440x900 and 1280x720. The
brief wraps onto as many lines as it needs and is never cut with an ellipsis. A robot command or
condition shows its name, and in With descriptions the first sentence of its `robot.json` summary
(`firstSentence`); the whole summary is the hint on a long hover. A wait condition shows its first
sentence in both description modes. A cut at a sentence end is not an
ellipsis: the sentence keeps its own full stop and nothing is added, so the "never cut with an
ellipsis" rule is not broken by it. Transfer keeps a "Planner only" chip in both modes, and a parallel
group's three modes use the Inspector's names (`lib/parallelModes.ts`).

Palette (`Ctrl K`): `--bg-raised`, `--radius-md`, `--shadow-modal`, 560 px, 120 px from the top,
over a `--tour-scrim`-strength backdrop with no blur. Input `--palette-input-h` 40 px Plex
`--fs-md`; results `--row-h-comfortable`; the active result is `--bg-selected` with the `--accent`
bar. Group headers Plex `--fs-xs` `--text-lo`.

- The first row is active under a resting pointer; only a real `pointermove` moves the active row.
- Ranking is tiered, with matches only in a summary last and never first. A Steps group and a
  Recent group join the commands.
- A disabled row shows its reason, and the arrow keys skip it. An empty result shows a hint.
- Choosing a waypoint says `Selected waypoint X (x, y in)` on the status line.

### 9.11 The field (canvas)

- **Well and board.** The well is `--bg-canvas`. The field board is the field image (spec 09 §4)
  or the vector field, with `--radius-sm` corners and nothing else: no title bar over it and no
  meta line (v1's "Three Tip Auto · RED · 12.89 s (10.32-15.47) at most · 6 errors" above the
  board moves to the title bar and the timeline, where it already exists).
- **Grid** `--grid-major` 24 in tile seams and `--grid-minor` finer lines at 1 px, `--grid-axis` at
  x = 0 and y = 0, drawn under the image only in vector mode; in image mode the image's own tiles are
  the grid. The person chooses (Settings, Editor, Field, `display.fieldGrid`): Off, Tiles (24 in
  seams only, the default), 12 in or 6 in (the seams plus lines at that spacing). Every view that
  draws a `FieldCanvas` passes `fieldGrid` from the person's preferences.
- **Paths.** Estimated `--path-estimated` at `--path-w-normal`; hover `--path-hover`; the
  selected step's path `--path-selected` at `--path-w-selected`; no glow, no halo, no gradient.
  Recorded trace `--path-actual` at `--path-w-actual`. Mirrored preview `--path-ghost`, dashed 4 4.
  The route Optimize path proposes `--path-candidate` at `--path-w-normal`, dashed 6 4, with its
  joints as dots and no handles; it is non-interactive and draws only while the Optimize card is
  open. Hovering it moves the one robot outline onto it, labelled "Proposed route"; while the card
  is open a 1 px `--canvas-annotation` hairline shows the margin round each structure within 12 in
  of the route, and an infeasible result draws its closest attempt's worst pose as one clip ghost.
- **One robot outline** (`--robot-outline`, 1.5 px, `--robot-outline-fill`) at the scrubber's time
  or where the cursor hovers on a path, with a heading tick in `--canvas-annotation`. No stamped
  ghosts. Under it, the playback level it comes from ("Ideal", "Instant sim", "Full sim") in 10 px
  mono `--canvas-annotation` with a 3 px `--bg-canvas` keyline, so a pose never appears without its
  source (9.16). While a command that drives the robot by itself runs (issue #481), the same one
  outline is drawn the partner way in `--canvas-unknown`: a 0.1 fill, a 1.5 px edge and a heading
  tick in that ink, labelled "Ideal · position unknown" (or its level) in that ink, and its step's
  envelope is hatched in it, the partner way, while the envelope's window is open. Where the next
  path has a rejoin pose the outline drifts there; no line is drawn for the drift.
- **Ideal transitions.** At the Ideal level, where a step starts away from where the robot is, the
  straight line the ideal robot drives across the gap is a 1 px `--canvas-annotation` line dashed
  3 4. It is the only place the gap shows on the field, so it is never hidden.
- **Handles**, on the selected step and on the step under the pointer: endpoints 8 px filled
  squares `--handle-endpoint`, control points 7 px hollow squares `--handle-control` tied by a 1 px
  hairline. Hit target `--handle-hit`.
- **Any path's dot drags at once.** A press on a dot of a step that is not selected, then a drag,
  moves that dot and selects its step in the same gesture (Figma, Onshape); there is no click to
  select first. A plain click without movement only selects the step, as a click on its path does.
  The drag is one undo step; the selection change adds none. Where dots overlap, the one on top
  wins: the selected step's, then the step drawn last. An unselected step's endpoints are always
  grabbable, and its control points only while its dots are shown, because nothing invisible may
  be grabbed. Snapping, modifiers and waypoints act exactly as on a selected step.
- **Heading handles** (spec 11 section 3), selected step only, all in `--handle-heading`: an arrow
  per end of the heading mode, a 1.5 px shaft 26 px long with a filled 7 px head that is the grab
  point (9 px on hover). An arrow the path decides (Tangent, Reverse tangent, the ends of a Facing
  point) is dashed with a hollow head at 60 % and says why on hover. A Constant's two arrows carry
  a 2.5 px ring at the base and are joined tip to tip by a dashed line while either is hovered. A
  facing point is a 5 px ring with a cross, with dashed sight lines from its ends. Piecewise range
  boundaries are 2 px ticks across the path with a 4 px `--bg-canvas` keyline, and a hovered range
  lights its stretch of the path at 45 %.
- **Markers** are 10 px `--marker-pin` teardrops; their label appears on hover only.
- **Field labels** (`flower0`, `hiveRed`) are hidden by default and shown on hover or when the
  labels view toggle is on. v1 printed every element's id in 8 px mono on the field, the most
  "generated" detail on the screen.
- **Readouts.** The drag bubble (x, y, heading, which snap is acting) is `--bg-raised`,
  `--radius-xs`, mono `--fs-xs`, 12 px from the cursor. The resting cursor readout and the scale
  bar are bare mono text in `--text-lo` at the well's bottom corners, not boxed widgets.
- **Snap and measure guides** in `--snap-guide` at 1 px, gone on release.
- **No Play overlay.** Play is the toolbar's and the scrubber's.
- **Chips at the top-left.** The tool hint line and the mirror banner are `--chrome-active` chips
  at the well's top-left. A mode that changes what the next field click does keeps its line for as
  long as it is armed, never only a status line that fades: Add waypoint shows "Add waypoint: click
  the field to place it. Esc to cancel" until the click or Esc.
- **Zoom controls** (Fit, +, −, zoom %) sit at the bottom-right, one row above the scale bar. Fit
  frames the board: `FIT_MARGIN_IN` 0 and `FIT_PADDING` 8/8/30/8.
- **Clip ghosts.** With a step selected that has clip ghosts, only its ghosts draw.

### 9.12 Empty states

Inside the region, left-aligned, 24 px from its top-left: a 32 px `--icon-xl` Lucide glyph in
`--text-lo`, a Jost 500 `--fs-xl` headline naming what would be here, one Plex `--fs-md`
`--text-mid` sentence saying what to do, and one action. The field's empty state is the welcome
screen: headline "Plan your first autonomous", the one line "Start with the example, or open your
robot's folder.", a primary **Open the example** and a secondary **Open a folder…** whose tooltip hint
says what folder to pick. A project with no autos says so and offers **New auto** as the primary,
with **Open another folder…**. A folder that did not open, with no project open, replaces the
welcome: a folder-x glyph, "robot-repo did not open", the status line's sentence, and a primary
**Open another folder…** with **Open the example** (`app/openProblem.ts`, issue #502). With a
project open, Open project reads "Open another project".
Save the example offers one line per choice. Set up's command library is a segmented control
(SolversLib, Ivy, Decide later). Other regions use a text button: Steps "No steps yet." ·
`Insert step · Enter`; Findings "No problems found."; Partners "No partners loaded" ·
`Load share file…` (and Load the example partner in the example), with the start offset row hidden
until a partner is loaded. With nothing selected the Inspector is the
Routine view: a quiet "Routine" heading and "Select a step or a point to edit it.", never a
"Nothing selected." empty state.

Every empty region uses `EmptyState` from `components/primitives.tsx`: icon, an optional headline,
one sentence ending in a full stop ("No auto is open."), and an action only when nothing else on the
screen already does it. Ledger: "Nothing in the ledger yet" with "It fills in as soon as a step
collects or launches." Library: "No autos in the library yet". Outbox: "Nothing is waiting".

**Loading** always ends. `LoadingLine` shows "Reading …" while a read runs; a read that fails turns
it into why, as a sentence, and a **Try again** text button. A read that fails after an earlier one
worked keeps the earlier data on screen with the failure line above it. Nothing spins forever.

**Offline** is one `OfflineLine` (WifiOff icon, `--text-mid`) at the top of a cloud sheet, saying
what still works and what waits: "This computer is offline. What you saved for offline opens, and a
publish waits in the Outbox." A write made offline never says it was done. It says it waits and what
happens next ("Waiting to send the proposal to Team 36596. It goes from the Outbox when you are back
online."), as information, not success. When the write later fails, the waiting text goes and the
failure takes its place with the way to try again. A refused cloud action always says why: in the
open sheet when one shows it, on the status line when none does.

**Dates** have one form everywhere: "Sat 3 Oct" for a day, "Sat 3 Oct, 18:30" with a time, and the
year added when it is not this year ("Thu 4 Mar 2027"). Words in `account/words.ts` (`dayWords`,
`whenWords`) make them; nothing formats a date with `toLocaleString`.

### 9.13 Descriptions

A row's label carries its meaning. What explains it further is its description, in the table
`src/help/descriptions/` (one file per surface: `inspector.ts`, `insert.ts`, `settings.ts`), never
written into the component. An entry is `{ brief?, more? }`. The **brief** is a fragment drawn on one
line under the label only when Settings, Editor, Appearance, **Descriptions** is "With descriptions";
the default is "Labels only" (decision desc-default). The **more** is never drawn inline. The row's
hint, a long hover on its label or Shift F1 (9.4, Row hints), is the brief and the more together in
both modes, and so is its controls' `aria-describedby`. A row takes its entry with `describe={id}`
(`FieldRow`, the Settings `Row`, an Insert menu kind). Settings keeps a one-line description in both
modes for the feature switches and the two project rows, Command library and Pathing system (the
Settings `Row`'s `keepBrief`), because people open Settings to decide things. A row whose label says
it all, such as Theme, has none. A Settings pane has its title and no summary line under it.

Only explanation collapses. Text that states a fact about the selection ("Ends at hopperFull or
1.00 s"), warns ("No time limit: may wait to the end"), names an empty state, or tells someone what to do
while a tool is active is not a description and shows in both modes. A `<p className={styles.note}>`
with a sentence written into it in `panels/` or `settings/` fails `help.test.ts` unless its file is
on the shrinking allowlist in `src/help/noteLiterals.ts`; pass state in as a value instead. Labels
only adds no underline or icon, and there is no one-time Descriptions hint (its Got it and the
`descriptionsHintSeen` pref are unused). With descriptions on, each brief shows once per Inspector.

The sheets and dialogs (`account/`, `admin/`, `cloud/`, `dialogs/`, `github/`, `library/`,
`project/`, `proposals/`, `report/`) follow the same rules, but they have no description table:
what explained a control is its tooltip's `hint=`, or the long-hover hint on its section heading
(`Tooltip` with `delay="long"` around the `h3`), or the sheet's `?`. A `<p>` or `<span>` in them with
a prose class (`prose`, `hint`, `note`, `lead`, `sentence`, `empty`, `warn`, `caution`, `detail` and
the like) that writes a sentence into the source fails `help.test.ts` unless `SHEET_NOTE_ALLOWLIST`
lists it with its class: `state`, `warn` or `empty`. Delete the sentence if it restates a label or
teaches a gesture.

The writing rules, which `help.test.ts` lints where it can:

1. The label carries the meaning. Write a description only if a new student, with it covered, would
   use the control wrong. Otherwise write none.
2. One place per fact. Never repeat the `?` help, a disabled control's tooltip, the control's own
   label or the value beside it.
3. Do not teach standard gestures: click to select, drag to move, click to edit. Cursors and hover
   states teach them, and keyboard equivalents live in tooltips (9.4). A brief never opens with
   Click, Drag, Pick, Here or This is.
4. Say what it does for the robot or the match, not how Zenith works inside: no "the planner", "the
   ledger says", file names, Pedro API names or Java details. Those go to the `?` help, and from there
   to the docs.
5. A brief is a fragment of 48 characters or fewer, with no full stop (MEASURED: the Inspector fits
   48 Plex 13 px characters on a line at 1440x900). A more is one or two plain sentences of 160
   characters or fewer (SET BY HAND, about two short sentences in the 280 px tooltip). A `?` entry is
   220 characters or fewer.
6. State text gives the fact, not the reasoning: "Ends at hopperFull or 1.00 s".
7. An empty state names what is missing, and the action is the button: "No markers" plus "Add
   marker".
8. Show a read-only notice once per surface, never once per pane: the Settings window shows one
   "Example project, read only" banner with an **Open project…** button on Robot and Commands only,
   and those sections carry no note of their own.
9. In a robot.json summary, the first sentence says what the robot does. Notes for programmers come
   after it. The UI shows only the first sentence inline, and the whole summary is the hint.
10. A tooltip's second line is short. An action's `does` is 100 characters or fewer and a literal
    `hint=` on a Tooltip is 160 or fewer (SET BY HAND: a line and a half, and two lines, of the 300 px
    bubble); `src/help/textCaps.test.ts` fails on any that is longer. Where one action has two states,
    `doesFor` gives the line for the current one instead of adding a sentence to `does`: Save reads
    "Writes the auto to the robot repository." or "Read-only project: asks where to save."
11. A status message is a few words, and its reason goes in `setStatus`'s third argument, which the
    bar draws quieter beside it, after a real space: "Example loaded, read only." and "Save makes your own copy."

**Settings panes.** General holds only personal switches. Robot holds the command library, and
pathing under Follower, with the provenance chip on the value's line and the line that counts
unsettled values with its toggle. Editor carries its rows in a fixed order, and Toolbar's buttons
are icon toggles. The safety margin reads "Change in Robot" and uses the clearance wording. A
behaviour is **On** or **Off**; **Show** and **Hide** are only for drawn things. Presets is one
edited line, with a check and **In use**, and Duplicate in a row menu. Keyboard shows its keys as
chip rows.

### 9.14 Modals

Native `<dialog>`, `--bg-raised`, `--radius-md`, `--shadow-modal`, `--pad-modal`, 520 px, over a
`--tour-scrim` backdrop, focus trapped, Escape closes. Title Jost 500 `--fs-lg`; exactly one
primary button, bottom-right, with its secondary to its left. A dialog whose body has its own
primary (a scan to run first) keeps its footer's action secondary until that is done.

**Asking first, in place** (`components/ConfirmRow.tsx`). An action that cannot be undone or that
another team sees asks with the one confirm row: the question as a sentence, then **Cancel** on the
left and the specific verb as the one primary on the right (Revoke, Remove, Leave team, Delete team,
Reject proposal, Reset all keys). The safe word is always Cancel, never Keep it or Stay. Cancel takes
the focus when the row opens, and Escape answers Cancel and closes nothing else. A field the
question needs, such as the team's name to type, sits between the sentence and the buttons. Ending an
invite is **Revoke** everywhere, and its state word is Revoked.

**Unsaved changes** are asked about with one set of buttons wherever work can be lost
(`UnsavedChoices` in `dialogs/UnsavedDialog.tsx`): **Cancel**, **Discard changes**, then **Save**
(or what Save writes, "Save robot.json", "Save proposal…") as the primary. The dialog asks before an
auto is replaced and before Leave drops a proposal's unsent changes; Settings asks inline (9.17)
with the same buttons.

**One frame for a box over the editor.** A **Modal** is for a blocking question: it needs an answer
before anything else, so it traps focus and dims the app. A **Sheet** (`cloud/controls.tsx`) is for
side work the person does while the editor stays usable: it is docked at the right, not modal, and
Settings and the review page follow the same chrome. Every frame has the same title (Jost 500
`--fs-lg`) and the same close: a Lucide X as a `RowButton` at the right end of the title row, labelled
**Close** with `Esc` in its tooltip. A Modal that has a Cancel button leaves the X off (`closeButton`
is for a frame without one, such as the shortcut sheet). Esc closes every frame, and focus goes back
to what had it when the frame opened. A Modal sits 10 vh from the top, so a dialog that grows (a
section that expands) grows downward and its title stays where it was. A notice over the corner
(the import notice, the expiry warning) stands beside the desktop panel, not over it, and a notice
with one line has one close, in its header.

**The beta notice** (`dialogs/BetaNotice.tsx`) is the one modal that opens by itself: on the first
load of each version, 440 px, title "Zenith is in beta", two sentences, a quiet **What changed** link
at the footer's left and **Got it** as the primary. Got it or `Esc` stores `"dismissed"` under the
localStorage key `zenith.betaNotice.<version>` (`betaNoticeKey` in `dialogs/betaNoticeState.ts`);
blocked storage shows it on every load. It comes first and alone: the preset card and tour (10.4),
a host's tour, and a share, invite or admin link's page wait until it closes. A script that drives
the app (e2e, UX sweep, docs screenshots) seeds that key first, as `e2e/betaNotice.ts` does.

**Side work that floats** (the desktop sim, deploy and git panel, `project/desktopPanel.tsx`) has the
sheet's chrome without the scrim: a title, one close as a `RowButton` with Lucide `X`, "Close" and
`Esc` in its tooltip, `Esc` to close, focus moved into it on open, `--z-popover`, and `aria-live`
on its status lines only. Work that would be cut short (a running sim or deploy) hides the close
rather than offering a Cancel that only hides the panel. A step that takes the file on disk while
the auto has unsaved edits asks first in the panel itself, in one sentence ("X has unsaved edits.
The sim runs the file on disk, so save it first."), with **Cancel** and **Save and …** as the
primary. A question that decides what happens to the person's work (a file changed on disk under
unsaved edits, closing while work runs) is a modal of its own, the safe choice on the left and
under `Esc`.

### 9.15 Status bar

One line of feedback after an action: "Opened …", "Saved.", a failed save. It describes the latest
action: a line from an earlier action clears on the next edit, and on opening a dialog, a sheet or
Settings (`clearStaleStatus`), or when the tour ends. Opening another auto says "Opened <file>.", or
"Discarded the edits to <file>. Opened <file>." after Discard. A toggle says its new state ("Snap
off.", "Paused at 3.2 s."), Validate says what it found ("No problems found." or "2 errors and 1
warning." with the first opened), and a view change Ctrl Z cannot take back names its own way back
in the hint ("Mirror again to go back to RED.").

**Undo and redo answer in one voice**, from the keys, the toolbar and the palette alike: "Undid: "
or "Redid: " and the first sentence of the line the edit wrote, so "Deleted sit. Ctrl Z puts it
back." undoes as "Undid: Deleted sit." An edit that wrote no line undoes as "Undid the last
change." The store does this: the line an action writes with `setStatus`, before or after its
`commit` in the same action, names the undo entry that commit pushed (`HistoryEntry.label`). So an
edit needs nothing new to be undone in this voice. Its line only has to start with a sentence that
says what it did, in the past tense. An entry that needs other words for its undo (a waypoint
delete's "Waypoint park is back.") passes `restore.undoStatus` and `redoStatus` to
`commitWithWaypoints`. A failed save's error stays through an undo, as it does through an edit.

A refused edit's error
expires after 8 s or at the next edit; a failed save's error stays until dismissed. A key's "cannot
run" line does not repeat the action's name when the reason already starts with it. There is still
no Undo button on it. It is an overlay fixed to the bottom of the window, drawn over the Settings
window (its z-index is above `--z-settings`), from the steps column's right edge to the window's
right edge (full width in the review and proposal views, which have no steps column),
`--row-h-compact` tall, `--bg-panel` with a `--border-default` top rule, `--fs-sm` Plex, and the
kind's colour: `--text-mid` for info, `--ok` on an `--ok-bg` tint for ok, `--sev-error` on
`--sev-error-bg` for an error. It fades in at `--dur-base` `--ease-out` and out at `--dur-slow`
`--ease-in`. Info and ok clear themselves after 6 s. The × at the
right end dismisses it.

It is out of the layout flow (layout rule 8), so the panels keep their size and place whether it
shows or not. The pointer passes through it to the panels beneath, so the last findings row under
it still takes a click; only the × takes the pointer. It starts beside the steps column rather
than at the window's left edge, because the folded Ledger and Partners headers sit at the foot of
that column and a full-width bar lay over the Partners header for its 6 s. A compact toast at the
bottom left was tried and rejected: it sat over the ledger's fold header and blocked it. The bar
keeps `aria-live="polite"`, or `role="alert"` for an error, and its live region is always in the
document.

### 9.16 Playback level

The timeline has one head row: the `~` rough chip, the level's total, `of 30 s`, then the level
switch right-aligned with short words, **Ideal**, **Instant**, **Full**, in that order, and the
timeline's `?`. There is no Playback row or label. The level word appears only on the switch and the
field label. The recorded trace's total sits at the end of the trace track. The scrubber row is
Play/Pause, back, the slider, forward, then the readout with no level word. The switch is the same
segmented look as any switch in the app: `--bg-inset` well, `--border-default` edge,
the pressed segment `--bg-raised` with `--text-hi`, the others `--text-lo`. Labels are
`--fs-xs`, never micro (micro is for ruler ticks).

- **Ideal** is the default. The choice is a preference (`prefs.playbackLevel`), remembered across
  visits.
- While the Full sim switch is off (issue #207, `src/state/fullSimSwitch.ts`) the switch has two
  segments, **Ideal** and **Instant**; a host that simulates keeps all
  three. A remembered Full sim plays Instant sim, or Ideal when the instant sim has no run, and
  shows that level pressed.
- A level that cannot play is `aria-disabled` in `--text-disabled`, never `disabled`, so its
  tooltip can say why: the instant sim has not run or failed (with its reason), or there is no full
  sim trace yet and how to get one (desktop: run the high-fidelity sim; browser: load a trace from
  Simulate). A remembered level that cannot play plays Ideal and shows Ideal pressed.
- Every tooltip says what the level is for in one sentence.
- **Everything that shows a simulated pose names its level**, once: the pressed segment of the
  switch and the label under the robot on the field (9.11). The head row's total is the pressed
  level's, so switching level never adds a line or moves the scrubber under the pointer. The
  playhead readout is one line, never wrapping; the slider gives up the width. The trace report and the
  inspector's recorded time are always the full sim's and say "Full sim".
- **The main track follows the level.** Ideal: the estimate's bars, with a transition block before
  any step the ideal robot has to turn or drive to reach: hollow, hatched with
  `--bar-unknown-hatch`, a 1 px inset `--bar-estimated` edge, as wide as its seconds. Instant sim:
  the `--bar-preview` bars lead and the estimate is the 3 px band beneath; the Ideal track keeps
  the room for that band, so the scrubber does not move when the level changes. Full sim: the
  scrubber runs on the trace's clock; the recorded bars stay the track under the estimate, as at
  every level once a trace is loaded.

### 9.17 Customization

Approved by the owner on 2026-10-08, together with Optimize path.

- **Every new switch, display option or key goes into the settings registry first**
  (`src/settings/registry.ts`), with its id, its storage name in `zenith.ui`, its label and
  description, its control, a `parse` that rejects junk, its default and its value in Basic,
  Essential and Full (or `leave`, or `never` for layout). The default is the Essential value.
  Settings rows, the presets and loading and saving read the registry; none keeps its own list.
- **Every change goes through `setSetting`** in the store. A panel, a palette action or a key never
  writes a registered setting with `setPrefs`.
- **A switch that hides file data provides the hidden-data hooks**, as Commands does today: the
  hidden steps, the selection with them taken out, moving past them, and asking before deleting a
  container that holds them. Hiding never changes a file.
- **What a switch hides is its entry's `gates`**: actions (and with them their toolbar buttons, keys
  and menu items), insert kinds, tour stops, finding codes, fix kinds and Settings sections. `state/features.ts`
  derives every gate from them, and an action several switches gate needs them all on.
- **A switch that hides only authoring** (Step groups, Waypoints, Advanced heading) takes away the
  entry points and nothing else. A step or pin made with it shows the quiet Inspector chip "Made with
  Step groups, which your settings turn off" with **Turn on Step groups** (`panels/MadeWithChip.tsx`),
  in `--text-mid` on `--bg-inset`, and edits as usual.
- **A switch registered ahead of its feature** carries `awaiting`: it is stored and preset, but gates
  nothing and has no Settings row until the unit that builds the feature gives it its gates.
- **A toolbar button can be hidden on its own** (`display.toolbar.<actionId>`, Settings, Editor,
  Toolbar). That removes the button only; its key, its menu items and its palette row still work, and
  a group left empty is not drawn. Search, Settings and Help have no such setting.
- **Hidden is never silent.** A palette search lists a hidden action last, in `--text-lo`, under
  "Off in your settings", and choosing it opens Settings at the switch rather than running it. The
  Problems panel ends with "N more problems in hidden features." and a **Show** that turns the
  switches on. With an error among them the line names it, in `--sev-error`, and the header's error
  count's tooltip counts it.
  A rule error is never behind a switch: a switch's `findings` gate names only findings the feature
  itself is about. The Ledger switch hides the ledger's counting and scoring findings (`CAPACITY`,
  `EMPTY_SHOT`, `TRANSFER`, `LAUNCH_TARGET`); a shot from an illegal spot (`LEGAL_APPROACH`) or one
  the turret cannot aim (`TURRET_RANGE`) is listed, drawn and counted with it off.
- Personal settings are never written into a project's files.
- **Closing Settings with a `robot.json` draft** asks inline with the unsaved-changes buttons (9.14):
  **Cancel**, **Discard changes** or **Save robot.json**, and the pane's own save bar steps aside
  while it asks, so one Save is on screen. `Esc` closes the innermost thing first (a menu, then the
  ask, then the window).
- **A preset's changes are derived, never stored** (`src/settings/presets.ts`, Settings, Presets).
  Applying a preset goes through `setSettings` (`src/settings/presetStore.ts`) and records it; a
  setting a user preset should carry needs nothing more than its registry entry (scope `person`,
  not `never`). Picking a preset while there are changes, and applying a user preset's keys, ask
  first in the section itself, with the inline ask Settings uses elsewhere, not a dialog.
- **A project's presets are files the person chose to share** (`src/settings/projectPresets.ts`,
  `src/settings/projectPresetStore.ts`, spec 15 section 6.5). They are read from
  `<autosDir>/presets/` each time Settings, Presets is shown, with an import's checks, and listed
  under This project's presets after the current-preset line. Apply goes through the person's linked
  copy (`applyProjectPreset`) and asks what any preset asks; Add to project and Update in project
  are the only writes, and Update in project asks inline before replacing a different file. A source
  that cannot write says why on the disabled button, never with a missing one.
- **A key is read, never written in.** Show a key with `keyLabel(id)` or `useKeyLabel(id)`, and
  run one through `actionForKey` (`src/app/keymap.ts`), so a key the person set in Settings,
  Keyboard reaches every tooltip, hint, tour line and the shortcut sheet. A key may be missing: a
  sentence then names the control instead (`keyOr`). A new default key goes in `SHORTCUTS`, and a
  new action without one joins `EXTRA_BINDABLE` only if the shortcut sheet still fits 1280x720 with
  every action bound (`e2e/qa/15-visual.spec.ts`). A key with no action of its own is checked by
  key only while it is fixed (the arrows, Esc, Space, Enter, Tab); Turn, Step back, Step forward and
  Next panel are `KEY_BINDINGS`, run through `keyBindingForKey`, and Turn's `Shift` turns the other
  way whatever its key (`shiftTurns`).

### 9.18 The Optimize card

`src/optimize/OptimizeCard.tsx` and `state.ts`.

- **Docked, never modal.** The card sits at the top of the Inspector's column, `--bg-raised` with a
  1 px `--border-default` rule under it, at most 70 % of the column's height. Only the body
  scrolls; the action row (the Apply line, then Run, Stop, Search longer, Apply or Run again, and
  Discard) is pinned under it. The Inspector stays below it and the field stays live. A 40 px header with the wand glyph,
  "Optimize path" in Jost and the step's id in mono, then 28 px field rows.
- **Entry points**, all gated by `features.optimizer`: the toolbar wand, in its own group with a
  chevron; the chevron or a right-click on the wand opens **Optimize path**, **Optimize path with
  options…** and **Optimize every path**. A step row's menu and the palette have Optimize path and
  Optimize path with options…, which have no default key. The Inspector has no wand, and the field's
  path menu no longer has Optimize path. A finding's Route around action is gated the same
  way (`gates.fixes`).
- **Finding actions.** A finding's fix of kind `optimizeRoute` (Route around on `STRUCTURE`,
  `CLEARANCE`, `PERIMETER` and `KEEPOUT`; Find faster heading on `STRAFE_FRACTION`) is a fix
  button that opens this card on the finding's step and runs at once instead of editing the auto.
  The card then starts with one line, in the body's text, repeating the button's words
  (`optimize-action`). Its `data-mode` is `routeAround`, `headingOnly`, `routeOnly` or `routeAndHeading`.
- **A blocked original** (issue #388). From any entry point, when `check()` finds the step as written
  going through something (a collision finding on it), the result line is the chosen route's first change sentence, "The
  original goes through <label>, so this is the fastest clear route found: it is 0.42 s slower in the
  instant sim.", which the change list then leaves out; with no clear route it is the sentence saying
  so. In Optimize every path such a step's line says "cleared" and what the original goes through,
  and the total line counts the blocked paths cleared apart from the time saved. A Route around
  button and Add a clear path here (`data-mode` `routeAround`) also count a `CLEARANCE` finding,
  or a path closer than the margin, as blocked: the line then reads "The original comes within the
  margin of <label>, so this is the fastest route found that keeps the margin: ...".
- **Rows.** Margin (inches, 0 to 6 by 0.25, starting at the robot's clearance, never saved; a
  change once a run has started runs again 300 ms after the last one), Score with, Allow several
  paths, Allow heading ranges, and Hold start heading for and Hold end heading for (inches, 0 to 144 by 1,
  0 off, issue #448) (the remembered options, through `setSetting`). They sit under an **Options**
  disclosure (`optimize-options`) that is open in the options state and folds once a run starts, so
  the result owns the body; its summary says what the run uses, "Options: 1.00 in margin, instant
  sim", and a click opens it again.
- **States.** Options: one primary **Run**. Running: "Searching, up to 5 s" with a 3 px accent bar,
  and **Stop**. Result: one headline ("0.70 s faster in the instant sim", or the blocked-original
  sentence) in one of three tones (`data-tone`): `ok` (Lucide `CircleCheck` in `--ok`) for a route
  that helps, `neutral` (`Info`, the words in `--text-mid` at regular weight) when nothing better
  was found, and `blocked` (`TriangleAlert` in `--sev-warn`) when no route can be clear. Then the
  `before → after` table, then an open **New problems** list of plain sentences, one "Clears …"
  sentence grouped by severity ("Clears 4 errors (hits a field element 3 times, crosses the centre
  line) and a warning (driving sideways)."), and a closed **What changes** disclosure (the change sentences without the
  restated time, the finding and marker sentences, the closest clearance by field label, markers and
  notes). When the route adds problems, the Apply line says "Adds 1 warning" in the worst one's
  severity colour. Continue is **Search longer**. The 5 s time box is the ordinary end of a run and
  says "Searched for 5 s: the best route so far." ("Searched 5 s more" after Search longer), once;
  "Stopped early: the best route so far." is only for the person's own Stop. A robot over the
  centre line or the wall is "over" it, never "inside" it. Then **Apply** (primary, Enter) and **Discard** (ghost, Esc); a disabled Apply shows
  its reason in a tooltip. A stale result says "The auto
  changed. Run again." in `--sev-warn` and offers **Run again** in place of Apply.
- **Keys.** The card takes the focus when it opens and when its result arrives, unless the person
  is somewhere else; Enter in it applies and Esc anywhere outside a field discards, after menus,
  the palette, dialogs and the sharing sheet.
- **Apply** is one `tryEdit` and one undo step; the status line says "Optimized toOtherSide:
  2.59 s → 2.48 s (instant sim)." **Discard** touches nothing: the auto stays the same object.
- **Add a clear path here** (issue #310). The field's right-click menu offers it after Add a
  path to here and Add waypoint here, gated by `features.optimizer`. It opens the card in Route
  around mode on a draft (`src/optimize/clearPath.ts`): the open auto with a path step from where
  the robot is to the point, or, with Extend this chain on and a path step selected, straight after
  that chain. The draft's end heading is the heading for new paths' (D6), or Linear to the legal
  approach when the point is one to the season's target. The field draws the route inside the
  draft. A spot no route can reach clear (the draft's end inside a structure or a keep-out, or over
  the centre line or the wall) is refused at once on the status line, "That spot is over the centre
  line. Right-click somewhere clear of it.", before any search; the menu item's tooltip says what
  it does. The result says "A clear path, the fastest found.", or that the straight path is already
  clear, which Apply then adds as it is. Apply adds one step, or joins the route onto the chain as
  more of its paths, in one undo step, and says "Added path3, a clear path to here: 2.41 s
  (instant sim)." The card's `data-clear-path` is `new` or `extend`.
- **Other modes.** Optimize every path's header chip reads `<n> paths`, and a row with no route
  reads "No faster route found" ("No clear route found" when the original was blocked). A row whose
  run failed is not counted as searched: the total reads "5 of 7 paths searched, 2 failed.", and
  the row ends in a **Try again** `RowButton` (`RotateCcw`) that searches that path alone and
  replaces its row. A clear
  path's card is titled "Add a clear path", with no step chip and no action line.
- **Alternatives switcher** (issue #310). When the result has a pick and alternatives, a row under
  the result line reads "Route 2 of 3: another way round" (or the alternative's own label, such as
  "Faster in the instant sim, slower in the estimate") with two `RowButton`s, Previous route and
  Next route, which wrap round. The times, the clearance, the markers, the findings and the change
  sentences below it are the shown route's, the field draws that route, and Apply writes it. Every
  new result starts at the pick. The alternatives that go round the obstacles another way come
  first. No key is bound to the switcher.

### 9.19 Error sentences: bad files and failed calls

A failure is worded by its kind, not by whichever code caught it, so the same fault reads the same
on every screen. Each sentence names the file (or the thing), says what is wrong in plain words,
and ends with what to do. It is shown once: in the place the person is looking, never there and on
the status bar too. A parser's, a schema validator's or an SDK's own text never reaches the
screen; it differs by browser, quotes the file, and is written for developers.

**A file the person picked** goes through the translators in `project/fileErrors.ts`, which every
reader shares (the project folder, the Partners panel, Import from another planner, Load trace) and
which the desktop app's main process can import too. The reader passes only its own next step.

| The file is | The sentence |
|---|---|
| empty | "`<name>` is empty. `<next>`" |
| a picture | "`<name>` is a picture, not a JSON file. `<next>`" |
| other binary | "`<name>` is not a text file, so it is not JSON. `<next>`" |
| cut off | "`<name>` is cut off: the JSON in it stops part way. `<next>`" |
| a typo | "`<name>` is not valid JSON (line 6, column 150). `<next>`" |
| too large | "`<name>` is 5.0 MB, larger than the 2.0 MB a share file may be, so it was not read. `<next>`" |
| from a newer Zenith | "`<name>` was made by a newer Zenith (share file format 99; this Zenith reads format 1). Update Zenith to load it." |
| another kind | "`<name>` is a Zenith auto, not a share file." and where the right file comes from |

The next step is the reader's: "Fix it, or restore it from git." for a project file, "Ask your
partner to download it again." for a share file, "Ask that team to share it again." for a share
from the cloud, "Check that this is the file you meant, or export it again from that planner." for
an import, and "Run the sim again, then load the trace it writes." for a trace. A damaged share
file names where the damage is ("Zenith cannot read the value at kind") but not the validator's
words, since the person cannot fix somebody else's file. A file already loaded says so: "`<name>`
is already in the alliance view, as Starter partner."

**A failed cloud call** goes through `cloudErrorSentence` (`cloud/errorSentence.ts`): Sharing, the
account and team sheets, the team library and the admin pages. A `CloudError` already carries a
Zenith sentence (the client's own checks, or a store's `RULES_REFUSED` and `OFFLINE_NOT_SAVED`);
anything else shows its text only when it is a sentence Zenith wrote, and otherwise "The request
failed. Try again in a moment." Sharing keeps its own words for a refusal and for signing in
(`sharingErrorSentence`), on the same translator. Offline always reads "This computer cannot reach
the cloud, and has no copy of that saved for offline use. Try again once it is back online."

**Where it shows.** A failure inside a dialog shows inside it, beside the control that caused it,
in `--sev-error` on `--sev-error-bg` with `role="alert"`, because the dialog covers the status bar.
A failure with its own notice (an import) shows only there, and the status bar is cleared. Anything
else is one status bar error line. A link that opens nothing says so: "That link is not complete.
Check it, or ask for a new one."

## 10. The onboarding tour

The tour's content and state live in `src/tour/` (a stop names a `data-tour` anchor, a title, one
or two sentences, optionally a thing to try). This section is how it looks.

### 10.1 Spotlight

The tour is **non-modal**: every control in the app
works exactly as it does with the tour closed, including menus and submenus, hover tooltips,
dropdowns, drags on the canvas and keyboard shortcuts. There is no backdrop or scrim, and nothing
the tour draws takes a pointer event except its cards.

- A **ring** round the anchor's bounding box grown by `--tour-cutout-pad` 8 px, corner radius
  `--tour-cutout-radius` 8 px, edge `--tour-cutout-ring`: a 2 px brand-amber ring, the only brand
  colour on the field during the tour. No glow, no pulse. It sits at `--z-tour-ring`, over the
  panels and under every popover, so a menu or tooltip that opens over it hides the ring.
- A stop with a task ("Try it: drag one of the dots") moves on when the person does the thing
  through the real UI; the rest of the app is live on every stop, task or not.
- Moving between stops, the ring animates its rect over `--dur-tour` 240 ms `--ease-out-expo`
  and the card cross-fades at `--dur-base`. With reduced motion both cut.

### 10.2 Coach-mark card

```
┌───────────────────────────────────────────────┐  --bg-raised, --radius-md, --shadow-modal
│▔▔▔▔▔▔▔▔ 2 px --brand-line top edge ▔▔▔▔▔▔▔▔▔▔│  --tour-card-w 340 px, --pad-modal 24 px
│ This is the field                        2 / 6│  Jost 500 --fs-xl  ·  mono --fs-xs --text-lo
│                                               │
│ The FTC field from above, with an example     │  Plex --fs-md --lh-md --text-mid, 1-2 sentences
│ routine on it. The dots are where the robot   │
│ drives to, and the outline is the robot.      │
│                                               │
│ ○ Try it: drag one of the dots on the path.   │  task line, Plex --fs-sm --text-hi; the circle
│                                               │  becomes a --ok check when the signal arrives
│ ● ● ○ ○ ○ ○                                   │  step dots, 6 px, --radius-pill, --accent / --border-strong
│ Skip tour                     Back    [Next]  │  ghost · ghost · primary
└───────────────────────────────────────────────┘
```

- Placed on the stop's `side` of the ring, `--tour-gap` 12 px away, 16 px inside the window
  (`src/tour/placement.ts`). The card **never covers the ring, nor any open menu, tooltip, listbox
  or dialog**, nor any area the stop's task happens in (`keepClear`, such as the field for the
  Heading arrows stop): if its side has no room it flips, then takes the nearest clear spot anywhere in the
  window, then narrows (down to 260 px) to fit beside a big anchor such as the whole field. It
  stays put while its spot is clear and moves the frame a popover opens under it or its anchor
  moves. A stop with no anchor centres the card with no ring.
- Title: Jost 500 `--fs-xl` `--tracking-display` `--text-hi`. Count: mono `--fs-xs` `--text-lo`,
  top-right, "2 / 6".
- Body: at most two sentences, Plex `--fs-md` `--text-mid`.
- Task line, when present: a 16 px open circle in `--border-strong` then the task in `--text-hi`,
  read as "Try it (optional)", since Next never waits for it.
  When the person does it, the circle fills to an `--ok` check and Next becomes the focus.
- Buttons: **Skip tour** ghost at the left; **Back** ghost and **Next** primary at the right (Back
  hidden on the first stop; Next reads **Finish** on the full tour's last stop, and stays Next on
  the core tour's, which leads to the choice card). Keyboard, only while focus is in the card: `→`/`Enter` next, `←` back, `Esc` skip. Outside the card every key is the app's, so
  `Esc` closes a menu or clears the selection. Focus moves to the card on each stop and returns to
  where it was on exit.
- `role="dialog"`, `aria-modal="false"`, `aria-labelledby` the title, `aria-describedby` the body.

### 10.3 The choice card, after the core tour

Centred, no cut-out, `--tour-choice-w` 560 px, same surface as the coach mark.

```
┌──────────────────────────────────────────────────────────────┐
│ You have the basics                                          │  Jost 500 --fs-2xl
│ That is everything you need to plan a routine. Want the rest?│  Plex --fs-md --text-mid
│                                                              │
│ ┌─────────────────────────┐  ┌─────────────────────────┐     │  two choice buttons, each
│ │ [Map 32]                │  │ [MousePointer2 32]      │     │  --bg-panel, --radius-sm,
│ │ Take the full tour      │  │ Jump in                 │     │  --pad-panel, full-height
│ │ A longer tour of every  │  │ Start planning. You can │     │  Jost 500 --fs-lg title,
│ │ feature, about 5 min.   │  │ replay the tour from    │     │  Plex --fs-sm --text-mid body
│ │                         │  │ Help at any time.       │     │
│ └─────────────────────────┘  └─────────────────────────┘     │
└──────────────────────────────────────────────────────────────┘
```

The longer tour is **Take the full tour** wherever it is offered: this card, the Help menu and the
palette. The two choices are `<button>`s, equal size, side by side. **Jump in** is the default (focused,
`--border-strong` edge and `--shadow-ember` on hover, since it is the likelier choice); **Take the
full tour** is the same surface with `--border-default`. Hover lifts either to `--bg-hover`. There
is no third "close" affordance beyond `Esc`, which counts as Jump in. The full tour's last card
("That is the whole tour") has one primary **Start planning** and the line "Replay it from Help
or the command palette."

Once a person has chosen a preset (on the card of 10.4 or in Settings), the choice card adds one
line under its sentence, in the same body style: "You chose Basic. Change it any time in Settings,
Presets." It names the preset (`data-testid="tour-chose"`); a person who never chose one sees no
such line.

### 10.4 The first-run preset card

Shown once, on the true first run only: nothing seen (`!tour.seen`), nothing chosen
(`!preset.chosen`), the example open, and the plain address. A host's window, a share, invite or
review link, a returning visitor and a replayed tour never show it. With the cloud off, closing a
share or invite link's "not in this version" page leaves the plain address, so the first run, card
included, goes on then.
It is the 10.3 card with three choices: non-modal, centred, no cut-out, `--tour-preset-w` 760 px
(`calc(100vw - 32px)` at most), the same surface.

```
┌────────────────────────────────────────────────────────────────────────────┐
│ How much of Zenith do you want to see?                                     │  Jost 500 --fs-2xl
│ Pick what suits you. Skip or Esc chooses Essential. You can change it any  │  Plex --fs-md --text-mid
│ time in Settings, Presets.                                                 │
│ ┌───────────────┐  ┌ ─ ─ ─ ─ ─ ─ ─ ─ ┐  ┌───────────────┐                  │
│ │ [Sprout 32]   │  │ [Compass 32]    │  │ [Layers 32]   │                  │  three choice buttons
│ │ Basic         │  │ Essential [Rec.]│  │ Full          │                  │  Essential: --border-strong,
│ │ For a first … │  │ The editor as … │  │ Everything, … │                  │  --shadow-ember on hover
│ │ Off: Partner… │  │ Off: Partner…   │  │ Everything on.│                  │  "Off:" line from the registry
│ └───────────────┘  └ ─ ─ ─ ─ ─ ─ ─ ─ ┘  └───────────────┘                  │
│ [FileUp] Import a preset file…                                      Skip   │  ghost · ghost
└────────────────────────────────────────────────────────────────────────────┘
```

- **Essential is the one primary action** (9.12): it carries the `--border-strong` edge, the
  `Recommended` pill (`--fs-xs`, `--text-mid`, `--border-strong`) and the focus when the card opens,
  so `Enter` takes it. Basic and Full are the same surface with `--border-default`. Import and Skip
  are ghost buttons, so there is still exactly one emphasised choice on screen.
- Each choice's copy says the plain outcome for the person, not the switches' names. The "Off:"
  line is generated from the registry (`presetSwitchedOff`), so it cannot drift from the presets. A switch registered ahead of its feature is left out until the feature exists.
- **A choice** (a card, or **Import a preset file…**, which applies the imported preset) applies the
  preset, records it as chosen and starts the core tour. A file that does not read leaves the card
  open with the reason in `--sev-error`. **Skip**, and `Esc` while focus is in the card, count as
  Essential; with a menu, the palette or a dialog open `Esc` belongs to that first.
- `role="dialog"`, `aria-modal="false"`, `aria-labelledby` the title, `aria-describedby` the
  sentence. Tab runs Basic, Essential, Full, Import, Skip; every button is a native `<button>`.
- **At phone width (640 px and narrower) the three choices stack in one column and Import and Skip
  stack full width**; the card then scrolls inside itself rather than outside the window.
- Choosing later is **Help, Choose a preset…** (`help.presets`, also in the palette), which opens
  Settings, Presets. Replaying the tour never shows this card again.

### 10.5 The shortcut sheet

Help, Keyboard shortcuts opens a sheet with two tabs, **Keys** and **Mouse**, and focus
moves to the sheet. Each key is listed once; where one key does two things, such as `S` and `C`,
a note says so. It fits 1280x720 with every action bound (`e2e/qa/15-visual.spec.ts`).

## 11. Accessibility

- **Focus is always visible**: `:focus-visible` applies `--ring-shadow`, a 2 px brand-amber ring at
  a 2 px `--bg-app` spacer, 11:1 or better on every surface and on the canvas.
- **No ring after a pointer action.** Code that moves focus calls `focusForInput(element)`
  (`src/components/inputModality.ts`), never a bare `focus()`: it passes `focusVisible: true` after a
  key press and `focusVisible: false` after a pointer press or before any input. So a menu opened by
  a right-click, the field after a Measure drag, a dropped marker's Command picker and the control a
  closing sheet hands focus back to show no ring, and the same moves from the keyboard still do.
- **Contrast** is section 4.4; `--text-lo` on `--bg-selected` at 5.2:1 is the floor. Colour is
  never the only channel: severities carry an icon and a code, alliance carries its name,
  provenance carries its full string, an unknown estimate is hatched.
- **Every drag has a keyboard equivalent** and its tooltip names it: reorder `Alt + ↑ / ↓`, nudge on
  the arrows (0.5 in, `Shift` 2 in, the defaults of the Nudge and Far nudge settings, Settings, Editor), heading `R` / `Shift R` (Turn's key, which a person may change), marker `↑ / ↓` in the Inspector's At field, scrub `↑ / ↓`.
- **Regions** (title bar, toolbar, steps, field, inspector, findings) are landmarks with names,
  cycled by `F6`. Tool buttons are `<button aria-pressed>`, disclosures `aria-expanded`, modals
  `<dialog>`, the tour a modal dialog.
- Targets are 32 px (the toolbar) and 28 px (row controls), above the 24 px AA floor; the `?` is
  16 px drawn with a 24 px hit area.
- Validation announces in an `aria-live="polite"` region; a failed save is `role="alert"`.

## 12. Do and don't, from the v1 screenshot

Each "don't" is something visible in `docs/images/editor.png` or the owner's review screenshot.

| Don't (v1) | Do (v2) |
|---|---|
| Twelve unlabelled icons across the top, with no product name anywhere on screen. | A title bar with the Zenith wordmark and Horizon's wordmark, then a toolbar in three spaced groups whose every icon has a tooltip with its shortcut. |
| A bordered box round every inspector value: 20 input outlines visible at once. | Values are mono text at rest; the input appears on hover and focus. |
| `NEEDS MEASUREMENT` and `SET FROM EDITOR` in capitals, full colour, beside every number. | "Needs measurement" as a quiet sentence-case chip; the derived tier is the grey default so only unverified numbers stand out. |
| The findings panel washed red row after row, with `PERIMETER` in capitals before each message. | Neutral rows, a severity icon, the sentence first, the code as a muted chip with its explanation in a tooltip. |
| A teal selected path with a glow and a dozen translucent robot rectangles stamped down it. | A near-white 3 px selected path and one robot outline at the scrubber or the cursor. |
| Field element ids (`flower0`, `loadingZoneRed`, `hiveBlue`) printed in 8 px mono all over the field. | Labels on hover, or with the labels toggle. |
| A title and a mono meta line drawn over the field board. | The board is just the field; the auto name is in the title bar and the time is in the timeline. |
| Boxed widgets in the well's corners for the cursor readout and the scale. | Bare `--text-lo` mono text in the corners. |
| A "Markers (1)" bordered card inside the inspector panel. | A sub-section header, indented 16 px, no box. |
| Red count pills (`4`, `2`) in the step rows next to the estimate bar. | One 8 px dot in the worst severity; counts live in the findings header. |
| The ledger open by default, repeating `end` down its first column. | Folded to a one-line summary; end-of-auto state grouped under its own header. |
| `Insert step` as a dashed box. | `+ Insert step · Enter` as a text button. |

**Always:** let the field be the brightest large thing on screen · keep the brand gradient on
chrome · give every panel and section a `?` · mono and tabular figures for every number · the unit
as a muted suffix · one primary button per screen · sentence case.

**Never:** a border round a panel's contents · a card inside a panel · a brand hue on the field or
on a finding · a glow · a severity hue for something that is not a finding · capitals for emphasis
· a gradient anywhere but the chrome and the primary button · any logo but the files in
`public/brand/`, or "Zenith" typed in live Jost where the wordmark belongs.

## 13. Before-you-merge checklist

```
[ ] Colours come from tokens; no literal hex, px or ms in a component stylesheet
[ ] Brand gradient and brand hues only on the places in section 4.1
[ ] No border round a panel's contents; no card inside a panel; one line between regions
[ ] Every region title and inspector section has a ? with text in src/help/content.ts
[ ] Every icon-only control has a tooltip with its name and shortcut; disabled ones say why
[ ] Jost only at 13 px and up; Plex for copy; JetBrains Mono for every number and id
[ ] Sentence case, including provenance chips and section headers
[ ] One primary button on the screen or dialog
[ ] Nothing on the canvas animates by itself except playback; no glow; one robot outline
[ ] :focus-visible ring visible on every control, including inside the tour
[ ] New text/background pairs checked against section 4.4, or added to it
[ ] Nothing transient reflows the layout: messages overlay (layout rule 8)
[ ] A bad file or a failed call is worded by its kind's translator and shown once (9.19)
[ ] A new switch, option or key is in the settings registry and written through setSetting (9.17)
```
