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
frame edge, the title bar, the logo, the active tool, the primary button and the focus ring. A newcomer
should be able to point at the screen and say "the field, my steps, the settings for the thing I
clicked", and every panel header has a `?` that says what it is for.

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
- **The 16 px mark** (`mark-16.svg`) is a separate drawing on the pixel grid: 2 px legs on whole
  rows, corners at x 12 and 4 (where the master's fall), a 2 px diagonal and dots 4.6 px across
  centred on those whole-pixel corners, in the same route colours. The gap and the light are left
  out, because at 16 px they are under a pixel wide. It is the favicon.
- **The wordmark** is that Z at letter weight (stroke 118 units against Jost's 119 unit stem, the
  same route colours, lit dots 1.6 times the stroke echoing the dot on the i, and no gap, which is
  under a pixel wide at wordmark sizes) followed by "enith" in Jost 550, all outlines, so it needs
  no font. `wordmark-dark.svg` (letters `#FAF6FB`) on night, `wordmark-light.svg` (letters
  `#17061D`) on light, and one-colour white and night versions for everything else.
- **Clear space.** Around the mark, an eighth of the tile's width on every side. Around the
  wordmark, one dot diameter (about a quarter of the Z's height) on every side.
- **Minimum size.** The mark: 16 px; use `mark-16.svg` from 16 to 23 px and `mark.svg` from 24 px up.
  The wordmark: 14 px tall (about 50 px wide); below that use the mark alone.
- **Never** recolour, stretch, rotate, outline or shadow either, and never set "Zenith" in live Jost
  next to the mark in place of the wordmark.

In the app: `public/favicon.svg` (the 16 px drawing), `favicon.ico`, `favicon-16.png`,
`favicon-32.png` and `apple-touch-icon.png`; `public/brand/zenith-wordmark-dark.svg` in the title bar;
the desktop icon in `apps/desktop/resources/`.

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

The desktop window draws a `--frame-edge-w` 1 px `--brand-gradient` hairline round its whole edge;
the web build draws none (the browser is the frame). Column widths are `--panel-left-w`,
`--panel-right-w` and `--findings-h`, each resizable on a 10 px target with a `--resizer-w` 4 px
visual that only appears on hover.

**Layout rules.** These are the ones v1 broke; each is written so a reviewer can point at a line.

1. **One primary region.** The field well is the largest region and the only one that is darker
   than the ground; the field board inside it is the brightest large object on screen. Nothing
   floats over the field except the cursor readout, the scale, and menus that the person opened.
2. **A region is a plane, not a box.** Side panels are `--bg-panel` against the `--bg-app` chrome,
   and that one lightness step is the separation. There is exactly one `--border-default` line
   between two regions, never a border on both sides, never a border round a panel's contents.
3. **Space groups, lines do not.** Inside a panel, sections are separated by `--gap-section`
   24 px of space and a section header. A `--border-subtle` rule is allowed only where two lists
   touch with no header between them.
4. **No card inside a panel.** v1's "Markers (1)" block (a bordered box holding a marker's fields
   inside the inspector) is the pattern to delete: a marker is a sub-section with an indented header.
5. **Three levels per surface, at most.** Region title, section header, row. If a fourth level
   seems needed, it is a disclosure that starts closed.
6. **Values are text until you touch them.** An inspector value at rest is mono text on the panel,
   with no box (section 9.5); the input chrome appears on hover and focus. v1 drew 20 bordered
   inputs in the inspector at once; that is most of what "cluttered" meant.
7. **Every panel keeps its place.** The owner ruled "keep every panel". Calm comes from fewer
   lines, fewer colours and real type hierarchy, not from hiding panels. The ledger starts folded
   to its header; the findings panel starts at its default height.
8. **Transient messages overlay and never reflow.** A message that comes and goes by itself (the
   status bar, section 9.14) is drawn over the layout, never given a row in it. Nothing may move
   when it appears or clears: not a panel, not the field, not a control under the pointer. A
   layout that jumps 28 px six seconds after an open drops a drag in the wrong place and closes
   whatever was being hovered.

## 4. Colour

### 4.1 Where the brand may appear

The gradient and the three brand hues appear on **chrome and brand only**:

| Place | Token | Form |
|---|---|---|
| Desktop frame edge | `--brand-gradient` | 1 px hairline |
| Title bar bottom edge | `--brand-gradient-horizon` | 2 px line, the signature |
| Zenith logo and Horizon wordmark | the SVGs in `public/brand/` | as drawn |
| Active tool | `--brand-gradient` | 2 px bar under the button, and `--accent-muted` fill |
| Primary button | `--brand-gradient-button`, `--brand-ink` text, `--shadow-ember` | one per screen |
| Focus ring | `--ring` = amber | 2 px at 2 px offset |
| Selected row, active tab, text button | `--accent` = orange, flat | 2 px bar or text |
| Tour | `--tour-cutout-ring` amber, `--brand-line` card edge | section 10 |

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
| 102 | lemon `#EDDB49` | warning severity, rule zones, unverified provenance | findings, field zones, chips |
| 152 | green `#62D286` | ok, measured provenance, recorded trace | status, chips, canvas |
| 200 | aqua `#43D5DC` | scoring targets | field only |
| 235 | sky `#71C9FA` | canvas annotations: heading, markers, snap guides, measure | canvas only |
| 255 | periwinkle `#9ABAE4` | info severity (deliberately low chroma: it must not pull the eye) | findings |
| 258 | blue `#3082F6` | alliance BLUE | field and alliance pill only |
| 320 | orchid `#D489E5` | game elements and containers | field only |
| 315, low chroma | haze and night | text, surfaces, authored paths | everywhere |

**Why severities moved.** v1's warning was amber `#E0A44F` (hue 73), eleven degrees from brand
amber: a warning chip next to the primary button would have read as brand. It moves to lemon, 18°
greener and more chromatic, which is still the colour a newcomer expects for "careful". v1's error
was coral `#F2705F` (hue 29), almost exactly brand orange; it moves to rose, pinker and lighter than
crimson, still unmistakably "wrong". **Why alliance red did not move.** Red alliance is red; there
is no other honest colour for it. It is kept apart by place (field and alliance pill only, never
chrome), by chroma (C 0.22, the most saturated red in the app, against orange 0.18 and crimson 0.16),
and by words (the pill always says RED or BLUE). It never appears in the same component as an
error. **Why authored paths are not coloured.** The field image carries red and blue hives, orange
flowers and yellow tape. Any saturated path colour collides with one of them. A light violet-neutral
path at 2 px, and the selected one near-white at 3 px, reads over all of them.

### 4.3 Token groups

**Surfaces.** `--bg-app` ground (title bar, toolbar, gutters; `--bg-chrome` names the title bar),
`--bg-panel` side panels and findings, `--bg-raised` popovers, menus, tooltips, modals, the palette
and the tour card, `--bg-canvas` the field well, one step darker than the ground, `--bg-inset`
inputs and code. States `--bg-hover`, `--bg-active`, `--bg-selected` (a solid orange tint, so text
contrast on it is fixed and listed below). **Borders.** `--border-default` the one line between
regions; `--border-subtle` rare in-panel rules; `--border-strong`, the only border at 3:1, for a
hovered or focused control and a drop target. **Text.** `--text-hi` values and titles, `--text-mid`
labels, `--text-lo` units, hints and timestamps, `--text-disabled` for inert controls only,
`--text-on-accent` / `--brand-ink` dark ink on any orange or gradient fill.

**Severities** `--sev-error`, `--sev-warn`, `--sev-info` and `--ok`, each with a `-bg`. **Provenance**
tiers: `--prov-measured` (MEASURED, SPEC, CALIBRATED FROM ROBOT), `--prov-derived` (SET BY HAND, SET
FROM EDITOR, SET FROM SIM, CALIBRATED FROM SIM, CARRIED OVER), `--prov-unverified` (NEEDS
MEASUREMENT, PLACEHOLDER, APPROX). **Paths** `--path-estimated`, `--path-selected`, `--path-hover`,
`--path-actual`, `--path-ghost`. **Canvas** `--canvas-annotation` (and its aliases
`--handle-heading`, `--marker-pin`, `--snap-guide`), `--robot-outline`, `--handle-endpoint`,
`--handle-control`, `--grid-*`, `--highlight-find`. `--ghost-footprint` survives as a name only.
**Field** `--field-obstacle(-fill)`, `--field-zone(-fill)`, `--field-element(-fill)`,
`--field-target`, `--field-waypoint`. **Bars** `--bar-*`, unchanged in meaning: solid for an
estimate, hatched where there is none, green for a recorded actual. `--bar-preview` is the instant
sim's bar on the timeline, the primary track at the Instant sim playback level (9.15): the same
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
| `--field-obstacle` / `--field-zone` / `--field-element` / `--field-target` | `canvas` 4.6 / 14.1 / 8.1 / 11.2 | 3 |
| `--alliance-red` / `--alliance-blue` | `canvas` 4.9 / 5.4 · `panel` 4.6 / 5.1 | 3 |
| `--sev-error` as canvas highlight | `canvas` 6.8 | 3 |

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
`--pad-row-x` 12 px in a row, `--pad-modal` 24 px, `--gap-section` 24 px between inspector
sections. Proximity: 4 px label to value, 8 px field to field, 24 px section to section. v2 is
roomier than v1 on purpose: rows are `--row-h` 32 px (v1 28), controls `--ctl-h-md` 28 px, tool
buttons `--ctl-h-tool` 32 px.

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

No emoji, no second icon set, no icon inside a coloured tile.

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
without window controls.

### 9.2 Toolbar

`--toolbar-h` 44 px, `--bg-app`, no bottom border (the panels below are lighter, which is the
edge). Three groups, 16 px apart with no divider line:

```
select · path · marker · heading · measure · snap   validate · play · sim · save · propose   mirror · help
```

Tool buttons are `--ctl-h-tool` 32 px square, `--radius-xs`, 16 px icon. Rest transparent
`--text-mid`; hover `--bg-hover` `--text-hi`; **active tool**: `--accent-muted` fill, `--accent`
icon, and a 2 px `--brand-gradient` bar inset at the bottom. A toggle that is on (snap) is the fill
and icon without the bar. Disabled is `--text-disabled` and keeps a tooltip that says why. Primary
actions that are text (Propose on the desktop) use the primary button (9.9).

### 9.3 Region titles and section headers, with the `?` affordance

**Region title** (Steps, Inspector, Findings, Ledger): a 40 px header, `--pad-panel` left, Jost
500 `--fs-lg` `--text-hi`, sentence case. Region actions sit right-aligned as ghost icon buttons.

**Section header** (inside the inspector: Start, Segment 1, Heading, Speed and end, Markers): a
`--row-h` header row, Jost 500 `--fs-md` `--tracking-label` `--text-mid`, a 16 px disclosure
chevron to its left in `--text-lo`, 24 px of space above it, no rule.

**The `?` affordance** sits 8 px after every region title and section header text:

- A `--help-size` 16 px circle, `--radius-pill`, 1 px `--border-strong` ring, a `?` in Plex 500
  11 px `--text-lo` centred. Hover: `--text-hi` and `--bg-hover` fill. It is a real `<button>` with
  `aria-label="What is <section>?"`, in the tab order after the header.
- Opens a **help tooltip** on hover after `--help-delay` 150 ms, on keyboard focus immediately, and pinned
  on click (click again, Escape or a click elsewhere closes it). The text comes from
  `src/help/content.ts` (`PANEL_HELP`), never from the component.
- Help tooltip: `--bg-raised`, `--radius-sm`, `--shadow-popover`, `--z-tooltip`, 12 px × 16 px
  padding, `--tooltip-max-w` 280 px. Title line in Jost 500 `--fs-md` `--text-hi`, then the one or
  two sentences in Plex `--fs-sm` `--lh-md` `--text-mid`, then optionally a text link "Show me" in
  `--accent` that starts the tour at that feature's stop. Placed below-start of the `?`, flipped to
  stay on screen, 8 px off it, no arrow.

The section header is not itself a tooltip trigger; only the `?` is, so hovering a header while
reading does not pop text over the inspector.

### 9.4 Tooltip contract (every control)

Every interactive element that is not a labelled text button has a tooltip; a missing one fails
review. Content: the action in sentence case, then the shortcut in mono `--fs-xs` `--text-lo`,
right-aligned after 8 px (`Add path` · `P`). A second `--text-mid` line when the action is not
obvious from its name, when the control is disabled (it says why), or when it is a drag target (it
names the keyboard equivalent). Timing `--tooltip-delay` 400 ms, `--tooltip-skip-delay` 100 ms
within a group, instant on keyboard focus, instant close on leave or pointer down. Focus opens a
tooltip only when it came from the keyboard (`:focus-visible`), never when code moves focus, such as
a menu focusing its first item as a click opens it. At most one tooltip, `?` help tips included, is
on screen at a time: opening one closes the one before it (`src/components/tooltipGate.ts`). Surface as the
help tooltip but 6 px × 8 px padding and no title line. One `Tooltip` component; it sets
`aria-describedby` and never replaces an `aria-label`. The shortcut map is one table in
`src/app/shortcuts.ts`; tooltips, menus and the palette read it.

### 9.5 Inspector field row

`--row-h` 32 px, grid `label 1fr / value auto / chip auto`, 8 px gaps, `--pad-row-x`.

- Label: Plex `--fs-sm` `--text-mid`, sentence case, no colon.
- **Value at rest is text, not a box**: mono `--fs-sm` `--text-hi`, right-aligned, tabular, with
  its unit suffix. Hover shows the input: `--bg-inset` fill, 1 px `--border-strong`, `--radius-xs`,
  `--ctl-h-md` 28 px, the value in place so nothing moves. Focus adds `--ring-shadow`. A select
  looks the same with a 12 px chevron that appears on hover.
- Numeric values scrub on horizontal drag (`Shift` ×4, `Alt` ÷4); the tooltip names `↑ ↓`.
- **Provenance chip**: right end of the row, mono `--fs-xs` in **sentence-case display**
  ("Needs measurement", "Set from editor"; the file keeps the canonical capitals), `--radius-xs`,
  2 px × 6 px, `--ctl-h-sm` tall, tier colour text on the tier `-bg`. The derived tier is the quiet
  default. A pose with no provenance shows "Needs measurement", never an empty slot. Clicking opens
  the provenance menu.
- A read-only computed value (Estimated, Strafe fraction) is `--text-mid` mono with no hover input.

### 9.6 Step list row

`--row-h` 32 px, `--pad-row-x`, columns `[drag 12] [kind icon 16] [name 1fr] [estimate bar 56]
[finding dot 8]`.

- Drag handle appears only on row hover or focus (`--text-lo`); `Alt + ↑ / ↓` is the keyboard
  equivalent and the tooltip says so.
- Kind icon from section 8 in `--text-mid`.
- Name: Plex `--fs-sm` `--text-hi` (a step's id is an identifier, but it is also the thing people
  read; mono is for the id chip in the inspector).
- Estimate bar 56 px × `--bar-h` 4 px on `--bar-track`, `--radius-pill` ends.
- Finding dot: 8 px `--radius-pill` in the worst severity on that step, no count badge in the row
  (the count lives in the findings panel). v1's red count pills (`4`, `2`) are removed.
- Selected: `--bg-selected` with a 2 px `--accent` bar on the left edge that replaces padding.
- Nesting indents 16 px with no guide line; the group's own row carries the chevron.
- **Insert** is a text button at the end of the list: `+ Insert step` Plex `--fs-sm` `--accent`,
  shortcut `Enter` in mono `--text-lo`. Not a dashed box.

### 9.7 Findings row

The panel header is the region title plus counts: `3 errors · 5 warnings · 2 info`, each count in
its severity colour, each a filter toggle. The rows:

```
[severity icon 16] [message, 1fr] [code chip] [step name, --text-lo] [fix, on hover]
```

- **No row tint.** v1 washed every error row in `--sev-error-bg`, which turned the bottom third of
  the screen red. v2 rows are `--bg-panel`; severity is the 16 px icon (section 8) in its colour.
- Message first, in Plex `--fs-md` `--text-hi`: it is a sentence and it is what a newcomer reads.
- Code chip after it: mono `--fs-xs` `--text-lo` on `--bg-hover`, `--radius-xs`, with a tooltip
  holding the code's "what this means and how to fix it" line from `findingHelp`.
- Hover `--bg-hover`; click selects the step and pans to the geometry, which draws in
  `--highlight-find`. The fix button (`Make tangent`, `Slow this sweep`) is a ghost button that
  appears on hover and focus-within and is never hidden from the keyboard.
- Empty: "No problems found." with the validate time in `--text-lo`.

### 9.8 Ledger

Folded by default to its region title with a one-line summary in `--text-lo` ("4 pollen
collected, 7 launched"). Open: `--row-h` rows, a sticky header in Plex `--fs-xs` `--text-lo`,
numeric columns mono right-aligned, no vertical rules, no zebra, rows that are the end-of-auto
state ("end · robot") grouped under their own section header rather than repeated with `end` in
the first column.

### 9.9 Buttons

| Kind | Look | Use |
|---|---|---|
| Primary | `--brand-gradient-button` fill, `--brand-ink` Jost 500 `--fs-sm`, `--ctl-h-lg` 32 px, `--radius-xs`, `--shadow-ember`; hover `--brand-gradient-button-hover` | exactly one per screen or dialog: Open project, Load example, Save, Jump in |
| Secondary | transparent, 1 px `--border-strong`, `--text-hi` Jost 500 | the alternative in a dialog: Cancel, Show me everything |
| Ghost | transparent, `--text-mid`, hover `--bg-hover` `--text-hi` | row actions, region actions, Back and Skip in the tour |
| Text | `--accent` Plex `--fs-sm`, no box, hover `--accent-hover` | inline actions: Insert step, Open project in an empty state |

Button labels are specific verbs, never OK. Disabled buttons stay focusable with a tooltip saying
why.

### 9.10 Menus, the context menu and the command palette

Menus and the right-click context menu: `--bg-raised`, `--radius-sm`, `--shadow-popover`, 4 px
padding, rows `--row-h` with a 16 px icon, the label in Plex `--fs-sm`, and the shortcut right in
mono `--fs-xs` `--text-lo`. Group separators are 8 px of space and a `--border-subtle` rule. The
**insert menu** gives each kind its icon, its name and its one-line help in `--text-lo` on a second
line (`INSERT_HELP`), at `--row-h-comfortable` 36 px.

Palette (`Ctrl K`): `--bg-raised`, `--radius-md`, `--shadow-modal`, 560 px, 120 px from the top,
over a `--tour-scrim`-strength backdrop with no blur. Input `--palette-input-h` 40 px Plex
`--fs-md`; results `--row-h-comfortable`; the active result is `--bg-selected` with the `--accent`
bar. Group headers Plex `--fs-xs` `--text-lo`.

### 9.11 The field (canvas)

- **Well and board.** The well is `--bg-canvas`. The field board is the field image (spec 09 §4)
  or the vector field, with `--radius-sm` corners and nothing else: no title bar over it and no
  meta line (v1's "Three Tip Auto · RED · 12.89 s (10.32-15.47) at most · 6 errors" above the
  board moves to the title bar and the timeline, where it already exists).
- **Grid** `--grid-minor` 12 in and `--grid-major` 24 in at 1 px, `--grid-axis` at x = 0 and
  y = 0, drawn under the image only in vector mode; in image mode the image's own tiles are the grid.
- **Paths.** Estimated `--path-estimated` at `--path-w-normal`; hover `--path-hover`; the
  selected step's path `--path-selected` at `--path-w-selected`; no glow, no halo, no gradient.
  Recorded trace `--path-actual` at `--path-w-actual`. Mirrored preview `--path-ghost`, dashed 4 4.
- **One robot outline** (`--robot-outline`, 1.5 px, `--robot-outline-fill`) at the scrubber's time
  or where the cursor hovers on a path, with a heading tick in `--canvas-annotation`. No stamped
  ghosts. Under it, the playback level it comes from ("Ideal", "Instant sim", "Full sim") in 10 px
  mono `--canvas-annotation` with a 3 px `--bg-canvas` keyline, so a pose never appears without its
  source (9.15).
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

### 9.12 Empty states

Inside the region, left-aligned, 24 px from its top-left: a 32 px `--icon-xl` Lucide glyph in
`--text-lo`, a Jost 500 `--fs-xl` headline naming what would be here, one Plex `--fs-md`
`--text-mid` sentence saying what to do, and one action. The field's empty state is the welcome
screen: headline "Plan your first autonomous", the sentence "Open a robot project folder, or load the
BIOBUZZ example to look around.", a primary **Load example** and a secondary **Open project**.
Other regions use a text button: Steps "No steps yet." · `Insert step · Enter`; Inspector
"Nothing selected." · "Click a step or a point on the field."; Findings "No problems found."

### 9.13 Modals

Native `<dialog>`, `--bg-raised`, `--radius-md`, `--shadow-modal`, `--pad-modal`, 520 px, over a
`--tour-scrim` backdrop, focus trapped, Escape closes. Title Jost 500 `--fs-lg`; exactly one
primary button, bottom-right, with its secondary to its left.

### 9.14 Status bar

One line of feedback after an action: "Opened …", "Saved.", a failed save. It is an overlay fixed
to the bottom of the window at `--z-popover`, full width, `--row-h-compact` tall, `--bg-panel`
with a `--border-default` top rule, `--fs-sm` Plex, and the kind's colour: `--text-mid` for info,
`--ok` on an `--ok-bg` tint for ok, `--sev-error` on `--sev-error-bg` for an error. It fades in at
`--dur-base` `--ease-out` and out at `--dur-slow` `--ease-in`. Info and ok clear themselves after
6 s; an error stays until dismissed. The × at the right end dismisses it.

It is out of the layout flow (layout rule 8), so the panels keep their size and place whether it
shows or not. The pointer passes through it to the panels beneath, so the ledger header and the
last findings row under it still take a click; only the × takes the pointer. A compact toast at
the bottom left was tried and rejected: it sat over the ledger's fold header and blocked it. The
bar keeps `aria-live="polite"`, or `role="alert"` for an error, and its live region is always in
the document.

### 9.15 Playback level

One labelled row under the timeline's scrubber: the word "Playback" in `--fs-xs` `--text-mid`, then
a three-segment switch, **Ideal**, **Instant sim**, **Full sim**, in that order, filling the row. It
is the same segmented look as any switch in the app: `--bg-inset` well, `--border-default` edge,
the pressed segment `--bg-raised` with `--text-hi`, the others `--text-lo`. Labels are
`--fs-xs`, never micro (micro is for ruler ticks).

- **Ideal** is the default. The choice is a preference (`prefs.playbackLevel`), remembered across
  visits.
- A level that cannot play is `aria-disabled` in `--text-disabled`, never `disabled`, so its
  tooltip can say why: the instant sim has not run or failed (with its reason), or there is no full
  sim trace yet and how to get one (desktop: run the high-fidelity sim; browser: load a trace from
  Simulate). A remembered level that cannot play plays Ideal and shows Ideal pressed.
- Every tooltip says what the level is for in one sentence.
- **Everything that shows a simulated pose names its level.** The label under the robot on the
  field (9.11). The level total in the timeline head, `ideal 13.48 s`, `instant sim 12.67 s`,
  `full sim 6.20 s`, in `--fs-xs` mono `--text-mid`. The playhead readout, `5.23 s ideal`,
  `5.23 s instant`, one line, never wrapping; the slider gives up the width. The hover readout's
  time on a path, `1.24 s ideal`. The trace report and the inspector's recorded time are always
  the full sim's and say "Full sim".
- **The main track follows the level.** Ideal: the estimate's bars, with a transition block before
  any step the ideal robot has to turn or drive to reach: hollow, hatched with
  `--bar-unknown-hatch`, a 1 px inset `--bar-estimated` edge, as wide as its seconds. Instant sim:
  the `--bar-preview` bars lead and the estimate is the 3 px band beneath. Full sim: the scrubber
  runs on the trace's clock; the recorded bars stay the track under the estimate, as at every level
  once a trace is loaded.

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
- Task line, when present: a 16 px open circle in `--border-strong` then the task in `--text-hi`.
  When the person does it, the circle fills to an `--ok` check and Next becomes the focus.
- Buttons: **Skip tour** ghost at the left; **Back** ghost and **Next** primary at the right (Back
  hidden on the first stop; Next reads **Finish** on the last). Keyboard, only while focus is in
  the card: `→`/`Enter` next, `←` back, `Esc` skip. Outside the card every key is the app's, so
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
│ │ Show me everything      │  │ Jump in                 │     │  --pad-panel, full-height
│ │ A longer tour of every  │  │ Start planning. You can │     │  Jost 500 --fs-lg title,
│ │ feature, about 5 min.   │  │ replay the tour from    │     │  Plex --fs-sm --text-mid body
│ │                         │  │ Help at any time.       │     │
│ └─────────────────────────┘  └─────────────────────────┘     │
└──────────────────────────────────────────────────────────────┘
```

The two choices are `<button>`s, equal size, side by side. **Jump in** is the default (focused,
`--border-strong` edge and `--shadow-ember` on hover, since it is the likelier choice); **Show me
everything** is the same surface with `--border-default`. Hover lifts either to `--bg-hover`. There
is no third "close" affordance beyond `Esc`, which counts as Jump in. The full tour's last card
("That is the whole tour") has one primary **Start planning** and the line "Replay it from Help
or the command palette."

## 11. Accessibility

- **Focus is always visible**: `:focus-visible` applies `--ring-shadow`, a 2 px brand-amber ring at
  a 2 px `--bg-app` spacer, 11:1 or better on every surface and on the canvas.
- **Contrast** is section 4.4; `--text-lo` on `--bg-selected` at 5.2:1 is the floor. Colour is
  never the only channel: severities carry an icon and a code, alliance carries its name,
  provenance carries its full string, an unknown estimate is hatched.
- **Every drag has a keyboard equivalent** and its tooltip names it: reorder `Alt + ↑ / ↓`, nudge on
  the arrows (0.5 in, `Shift` 2 in), heading `R` / `Shift R`, marker `Alt + ← / →`, scrub `↑ / ↓`.
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
```
