/**
 * The ledger's counts on the field, split by piece (issue #118): a small chip beside each place
 * that holds something, and one that rides with the robot outline saying what the robot carries at
 * the playback time. Each chip reads "3 ●" per kind of piece: the number, then a small piece icon,
 * both in the piece's colour. Pollen is a plain gold disc; nectar is a ring with a dot in its
 * alliance's colour. The icon's shape is the cue that does not depend on colour.
 *
 * Placement is fixed per kind of place, so a chip does not wander: an area (a floor quarter, a
 * loading zone) has its chip on its centre; a flower or a garden line has it a few inches towards
 * the field's centre, clear of the thing itself; a hive cell has it on the far side from the other
 * cell, clear of the hive. A chip that would overlap one already placed tries the next side. The
 * robot's chip is placed last, above the outline unless that covers the path or another chip.
 *
 * The chips sit on the field well, which stays dark in both themes, so they draw with the fixed
 * `--chrome-*` ink (`theme.ts` `count*` keys), also over the light field picture.
 *
 * The layout is pure (`countParts`, `layoutFieldCounts`); `drawFieldCounts` is the one painter, and
 * the live layer calls it once per frame. Nothing here reads a clock: the counts are the ledger's at
 * the playback time the shell hands in.
 */
import { footprintAt, mirrorVec, type LedgerLocation, type MirrorMode, type Pose, type Vec2 } from "@horizon36596/zenith-core";
import type { Robot } from "@horizon36596/zenith-schema";
import { glyphCentredOrigin } from "./ledgerBadges.js";
import { pieceEdge, pieceInk, type NectarKinds } from "./pieceColours.js";
import type { Scene } from "./scene.js";
import type { CanvasTheme } from "./theme.js";
import { worldToScreen, type ScreenVec, type View } from "./view.js";

/** What a kind of piece is, for its colour and icon. */
export type Piece = "pollen" | "nectar" | "other";

/** One kind of piece in a chip: how many, and how to draw it. */
export interface CountPart {
  /** The season's kind, as the ledger's holds name it (`pollen`, `nectarRed`). */
  kind: string;
  count: number;
  piece: Piece;
  /** The alliance a nectar belongs to, or null for pollen and unknown kinds. */
  alliance: "RED" | "BLUE" | null;
}

/** A chip as laid out, in CSS pixels: its centre and size, and what it says. */
export interface CountLabel {
  id: string;
  /** The kind of place (`robot`, `hiveCell`, `flower`, ...). */
  kind: string;
  parts: CountPart[];
  xPx: number;
  yPx: number;
  widthPx: number;
  heightPx: number;
  /** Where it sits: on the field beside its place, riding with the robot, or in the top-right line. */
  at: "field" | "robot" | "line";
}

/** What `pieceOf` says about a kind. BIOBUZZ names its nectar `nectarRed` and `nectarBlue`. */
export function pieceOf(kind: string): { piece: Piece; alliance: "RED" | "BLUE" | null } {
  if (kind === "pollen") return { piece: "pollen", alliance: null };
  if (/^nectar/i.test(kind)) {
    const alliance = /red$/i.test(kind) ? "RED" : /blue$/i.test(kind) ? "BLUE" : null;
    return { piece: "nectar", alliance };
  }
  return { piece: "other", alliance: null };
}

const PIECE_ORDER: Record<Piece, number> = { pollen: 0, nectar: 1, other: 2 };

/**
 * The nonzero kinds a place holds, pollen first, then the routine's own nectar, then any other.
 * A place whose season gives no split counts as one part of the season's one kind.
 */
export function countParts(location: Pick<LedgerLocation, "count" | "holds">, alliance: "RED" | "BLUE"): CountPart[] {
  const holds = location.holds ?? (location.count === null ? {} : { pieces: location.count });
  const parts: CountPart[] = [];
  for (const [kind, count] of Object.entries(holds)) {
    if (!(count > 0)) continue;
    parts.push({ kind, count, ...pieceOf(kind) });
  }
  const rank = (part: CountPart): number =>
    PIECE_ORDER[part.piece] * 4 + (part.alliance === null ? 0 : part.alliance === alliance ? 1 : 2);
  return parts.sort((a, b) => rank(a) - rank(b) || a.kind.localeCompare(b.kind));
}

/** The chip's size and spacing, in CSS pixels. */
export const CHIP = {
  heightPx: 18,
  padXPx: 6,
  /** Between a number and its icon. */
  iconGapPx: 3,
  iconPx: 8,
  /** Between one kind's icon and the next kind's number. */
  partGapPx: 7,
  /** `--fs-xs`, the chip size (UI_GUIDE section 5). */
  fontPx: 11,
  /** Kept clear between two chips. */
  marginPx: 3,
} as const;

/** How wide a chip is, from the width of one digit in the mono font. */
export function chipWidthPx(parts: readonly CountPart[], digitPx: number): number {
  if (parts.length === 0) return CHIP.padXPx * 2 + digitPx;
  let width = CHIP.padXPx * 2;
  for (const [index, part] of parts.entries()) {
    if (index > 0) width += CHIP.partGapPx;
    width += String(part.count).length * digitPx + CHIP.iconGapPx + CHIP.iconPx;
  }
  return width;
}

/** How far from its place a chip keeps, in field inches, by kind of place; 0 centres it there. */
const CLEAR_IN: Record<string, number> = { flower: 7, garden: 4, hiveCell: 12, floor: 0, loadingZone: 0 };

/** Below this zoom the field chips would cover what they count, so only the robot's and the line show. */
export const FIELD_CHIPS_MIN_PX_PER_IN = 2;

/** The places that always have a chip, even empty: the routine's up hive cell and the robot. */
const alwaysShown = (location: LedgerLocation): boolean => location.kind === "robot" || /UpCell$/.test(location.id);

interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const rectOf = (xPx: number, yPx: number, widthPx: number, heightPx: number): Rect => ({
  left: xPx - widthPx / 2,
  top: yPx - heightPx / 2,
  right: xPx + widthPx / 2,
  bottom: yPx + heightPx / 2,
});

const overlaps = (a: Rect, b: Rect, marginPx: number): boolean =>
  a.left < b.right + marginPx && b.left < a.right + marginPx && a.top < b.bottom + marginPx && b.top < a.bottom + marginPx;

/** True when the segment from `a` to `b` crosses the rectangle (Liang-Barsky clipping). */
export function segmentHitsRect(a: ScreenVec, b: ScreenVec, rect: Rect): boolean {
  const dx = b.xPx - a.xPx;
  const dy = b.yPx - a.yPx;
  let t0 = 0;
  let t1 = 1;
  const edges: Array<[number, number]> = [
    [-dx, a.xPx - rect.left],
    [dx, rect.right - a.xPx],
    [-dy, a.yPx - rect.top],
    [dy, rect.bottom - a.yPx],
  ];
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) return false;
      continue;
    }
    const t = q / p;
    if (p < 0) {
      if (t > t1) return false;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return false;
      if (t < t1) t1 = t;
    }
  }
  return true;
}

/** The unit vector from `from` to `to`, or straight down when they coincide. */
function direction(from: ScreenVec, to: ScreenVec): ScreenVec {
  const dx = to.xPx - from.xPx;
  const dy = to.yPx - from.yPx;
  const length = Math.hypot(dx, dy);
  return length < 1e-6 ? { xPx: 0, yPx: 1 } : { xPx: dx / length, yPx: dy / length };
}

const rotate90 = (v: ScreenVec, sign: 1 | -1): ScreenVec => ({ xPx: -v.yPx * sign, yPx: v.xPx * sign });

export interface FieldCountsLayoutInput {
  badges: readonly LedgerLocation[];
  alliance: "RED" | "BLUE";
  view: View;
  mirror: MirrorMode;
  widthPx: number;
  heightPx: number;
  /** The width of one digit in the chip font, in CSS pixels. */
  digitPx: number;
  /** The robot outline's corners on screen, or null when no robot is drawn. */
  robotCornersPx: readonly ScreenVec[] | null;
  /** The routine's paths on screen, which the robot's chip keeps off where it can. */
  pathsPx: readonly (readonly ScreenVec[])[];
  /** Kept clear in the top right (the field's `?` button), as a width in CSS pixels. */
  topRightClearPx?: number;
}

/** Space kept along the canvas edges, and the gap between the robot outline and its chip. */
const EDGE_PAD_PX = 8;
const ROBOT_GAP_PX = 6;
/** The playback level's name sits under the outline (`liveLayer.ts` `drawRobotLabel`), this tall. */
const ROBOT_LEVEL_LABEL_PX = 16;

/**
 * Every chip to draw at one moment, laid out. Field chips first, in the ledger's order and each at
 * its kind's place, so they keep their place as the robot moves; then the robot's; then the line in
 * the top right for the partner, the pieces whose place is unknown, and the robot when it has no
 * outline to ride with.
 */
export function layoutFieldCounts(input: FieldCountsLayoutInput): CountLabel[] {
  const { view, mirror, alliance, digitPx } = input;
  const labels: CountLabel[] = [];
  const placed: Rect[] = [];
  const screenOf = (point: Vec2): ScreenVec => worldToScreen(view, mirrorVec(point, mirror));
  const centrePx = screenOf({ xIn: 0, yIn: 0 });
  const inCanvas = (rect: Rect): boolean =>
    rect.left >= 0 && rect.top >= 0 && rect.right <= input.widthPx && rect.bottom <= input.heightPx;
  const byId = new Map(input.badges.map((badge) => [badge.id, badge]));
  const lineItems: LedgerLocation[] = [];
  let robot: LedgerLocation | null = null;

  for (const badge of input.badges) {
    if (badge.count === null) continue;
    if (badge.kind === "robot") {
      robot = badge;
      continue;
    }
    if (badge.atIn === null) {
      if (badge.count > 0) lineItems.push(badge);
      continue;
    }
    if (view.pxPerIn < FIELD_CHIPS_MIN_PX_PER_IN) continue;
    const parts = countParts(badge, alliance);
    if (parts.length === 0 && !alwaysShown(badge)) continue;
    const widthPx = chipWidthPx(parts, digitPx);
    const heightPx = CHIP.heightPx;
    const anchor = screenOf(badge.atIn);
    const clearIn = CLEAR_IN[badge.kind] ?? 4;
    let centre = anchor;
    if (clearIn > 0) {
      // A hive cell points away from its hive's other cell; anything else towards the field's centre.
      let away: ScreenVec = direction(anchor, centrePx);
      if (badge.kind === "hiveCell") {
        const otherId = badge.id.endsWith("UpCell") ? badge.id.replace(/UpCell$/, "DownCell") : badge.id.replace(/DownCell$/, "UpCell");
        const other = byId.get(otherId)?.atIn;
        if (other !== undefined && other !== null) away = direction(screenOf(other), anchor);
      }
      const clearPx = clearIn * view.pxPerIn;
      const candidates = [away, rotate90(away, 1), rotate90(away, -1), { xPx: -away.xPx, yPx: -away.yPx }];
      const at = (dir: ScreenVec): ScreenVec => {
        const reach = clearPx + Math.abs(dir.xPx) * (widthPx / 2) + Math.abs(dir.yPx) * (heightPx / 2);
        return { xPx: anchor.xPx + dir.xPx * reach, yPx: anchor.yPx + dir.yPx * reach };
      };
      centre = at(away);
      for (const dir of candidates) {
        const spot = at(dir);
        const rect = rectOf(spot.xPx, spot.yPx, widthPx, heightPx);
        if (inCanvas(rect) && !placed.some((other) => overlaps(rect, other, CHIP.marginPx))) {
          centre = spot;
          break;
        }
      }
    }
    placed.push(rectOf(centre.xPx, centre.yPx, widthPx, heightPx));
    labels.push({ id: badge.id, kind: badge.kind, parts, xPx: centre.xPx, yPx: centre.yPx, widthPx, heightPx, at: "field" });
  }

  // The robot's chip, beside the outline: above it, else right, left, or under the level's name.
  let robotOnLine = robot !== null;
  const corners = input.robotCornersPx;
  if (robot !== null && corners !== null && corners.length > 0 && view.pxPerIn >= FIELD_CHIPS_MIN_PX_PER_IN) {
    const parts = countParts(robot, alliance);
    const widthPx = chipWidthPx(parts, digitPx);
    const heightPx = CHIP.heightPx;
    const box: Rect = {
      left: Math.min(...corners.map((corner) => corner.xPx)),
      right: Math.max(...corners.map((corner) => corner.xPx)),
      top: Math.min(...corners.map((corner) => corner.yPx)),
      bottom: Math.max(...corners.map((corner) => corner.yPx)),
    };
    const midX = (box.left + box.right) / 2;
    const midY = (box.top + box.bottom) / 2;
    const candidates: ScreenVec[] = [
      { xPx: midX, yPx: box.top - ROBOT_GAP_PX - heightPx / 2 },
      { xPx: box.right + ROBOT_GAP_PX + widthPx / 2, yPx: midY },
      { xPx: box.left - ROBOT_GAP_PX - widthPx / 2, yPx: midY },
      { xPx: midX, yPx: box.bottom + ROBOT_LEVEL_LABEL_PX + ROBOT_GAP_PX + heightPx / 2 },
    ];
    // The fewest path segments and chips covered wins; the first side wins a tie, so the chip stays
    // above the robot unless something is there.
    let best = candidates[0] as ScreenVec;
    let bestScore = Number.POSITIVE_INFINITY;
    for (const spot of candidates) {
      const rect = rectOf(spot.xPx, spot.yPx, widthPx, heightPx);
      let score = 0;
      if (!inCanvas(rect)) score += 1000;
      for (const other of placed) if (overlaps(rect, other, CHIP.marginPx)) score += 100;
      for (const path of input.pathsPx) {
        for (let index = 1; index < path.length; index += 1) {
          if (segmentHitsRect(path[index - 1] as ScreenVec, path[index] as ScreenVec, rect)) score += 1;
        }
      }
      if (score < bestScore) {
        best = spot;
        bestScore = score;
      }
      if (score === 0) break;
    }
    placed.push(rectOf(best.xPx, best.yPx, widthPx, heightPx));
    labels.push({ id: robot.id, kind: robot.kind, parts, xPx: best.xPx, yPx: best.yPx, widthPx, heightPx, at: "robot" });
    robotOnLine = false;
  }

  // The top-right line, right to left from the corner the `?` button leaves free.
  const line = robotOnLine && robot !== null ? [robot, ...lineItems] : lineItems;
  let rightPx = input.widthPx - (input.topRightClearPx ?? 0);
  for (const item of [...line].reverse()) {
    const parts = countParts(item, alliance);
    const widthPx = chipWidthPx(parts, digitPx) + lineWordPx(item, digitPx);
    const xPx = rightPx - widthPx / 2;
    labels.push({
      id: item.id,
      kind: item.kind,
      parts,
      xPx,
      yPx: EDGE_PAD_PX + CHIP.heightPx / 2,
      widthPx,
      heightPx: CHIP.heightPx,
      at: "line",
    });
    rightPx -= widthPx + CHIP.partGapPx;
  }
  return labels;
}

/** The word a top-line chip starts with, so a reader knows whose count it is. */
const LINE_WORDS: Record<string, string> = { robot: "robot", partner: "partner", loose: "loose" };
const lineWord = (location: Pick<LedgerLocation, "id" | "kind">): string => LINE_WORDS[location.kind] ?? location.id;
/** The mono font's advance is one digit's width for every character. */
const lineWordPx = (location: Pick<LedgerLocation, "id" | "kind">, digitPx: number): number =>
  lineWord(location).length * digitPx + CHIP.iconGapPx * 2;

/** `id=kind:count,...@x,y` for every chip, which the canvas publishes for tests and bug reports. */
export const countLabelsSummary = (labels: readonly CountLabel[]): string =>
  labels
    .map(
      (label) =>
        `${label.id}=${label.parts.map((part) => `${part.kind}:${String(part.count)}`).join(",")}@${label.at}:${label.xPx.toFixed(1)},${label.yPx.toFixed(1)}`,
    )
    .join(";");

/** What the painter needs from the live layer's input. */
export interface FieldCountsInput {
  ledgerBadges?: readonly LedgerLocation[];
  alliance?: "RED" | "BLUE";
  view: View;
  mirror: MirrorMode;
  theme: CanvasTheme;
  widthPx: number;
  heightPx: number;
  robot: Robot;
  robotPose: { poseIn: Pose } | null;
  scene: Scene;
  /** Told the chips drawn this frame, so the canvas can publish them. */
  onFieldCounts?: (labels: readonly CountLabel[]) => void;
}

/**
 * The field's `?` help button sits in the canvas's top right corner (`.fieldHelp` in
 * `app/App.module.css`: `--space-2` in from the edges, `--help-size` wide). The top line ends this far
 * in from the right edge, so its last chip is never under the button.
 */
const HELP_CORNER_PX = 8 + 16 + EDGE_PAD_PX;

/**
 * The colours a part draws with: the number's and the icon's. The icon is `pieceInk`'s, the colour a
 * piece of that kind is drawn in on the field (`pieceColours.ts`): pollen gold, nectar its alliance's
 * colour, the other alliance's when the view is mirrored, as its hive is. The number takes the
 * matching text colour, which keeps 4.5:1 on the chip. A kind that is neither is drawn in plain ink.
 */
export function partInk(part: CountPart, theme: CanvasTheme, mirrored: boolean): { text: string; icon: string } {
  if (part.piece === "other") return { text: theme.countInk, icon: theme.countInk };
  const nectar: NectarKinds = {
    RED: part.alliance === "RED" ? part.kind : null,
    BLUE: part.alliance === "BLUE" ? part.kind : null,
  };
  const icon = pieceInk(theme, part.kind, nectar, mirrored);
  const text = icon === theme.allianceRed ? theme.allianceRedText : icon === theme.allianceBlue ? theme.allianceBlueText : icon;
  return { text, icon };
}

/**
 * A piece's icon, centred on (x, y): pollen a plain disc, nectar a ring around a dot. Like a piece on
 * the field, it is outlined in `pieceEdge`.
 */
function drawPieceIcon(ctx: CanvasRenderingContext2D, piece: Piece, xPx: number, yPx: number, colour: string, edge: string): void {
  const radius = CHIP.iconPx / 2;
  ctx.beginPath();
  ctx.strokeStyle = edge;
  ctx.lineWidth = 1;
  ctx.arc(xPx, yPx, radius + 0.5, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  if (piece === "nectar") {
    ctx.strokeStyle = colour;
    ctx.lineWidth = 1.5;
    ctx.arc(xPx, yPx, radius - 0.75, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.fillStyle = colour;
    ctx.arc(xPx, yPx, 1.6, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  ctx.fillStyle = colour;
  if (piece === "pollen") {
    ctx.arc(xPx, yPx, radius, 0, Math.PI * 2);
  } else {
    ctx.rect(xPx - radius + 0.5, yPx - radius + 0.5, CHIP.iconPx - 1, CHIP.iconPx - 1);
  }
  ctx.fill();
}

/** How many times larger than drawn the digits are measured, for their ink box. */
const INK_MEASURE_SCALE = 10;

/** Draws every count chip for this frame and returns them as laid out. */
export function drawFieldCounts(ctx: CanvasRenderingContext2D, input: FieldCountsInput): CountLabel[] {
  const badges = input.ledgerBadges ?? [];
  if (badges.length === 0) {
    input.onFieldCounts?.([]);
    return [];
  }
  const { theme, view, mirror } = input;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  // Lining figures share one ink height, so one measure centres every number in its chip. It is
  // taken at ten times the drawn size, where Chromium's whole-pixel rounding of the ink box is small.
  ctx.font = `${String(CHIP.fontPx * INK_MEASURE_SCALE)}px ${theme.fontMono}`;
  const digits = ctx.measureText("0123456789");
  ctx.font = `${String(CHIP.fontPx)}px ${theme.fontMono}`;
  const digitPx = digits.width / 10 / INK_MEASURE_SCALE;
  const origin = glyphCentredOrigin(digits, { xPx: 0, yPx: 0 }, 1 / INK_MEASURE_SCALE);
  const baselineDropPx = origin.inkMeasured ? origin.yPx : CHIP.fontPx * 0.36;

  const robotCornersPx =
    input.robotPose === null
      ? null
      : footprintAt(input.robotPose.poseIn, input.robot, "expandedIn").bodyIn.map((corner) =>
          worldToScreen(view, mirrorVec(corner, mirror)),
        );
  const pathsPx = input.scene.steps.map((step) => step.poses.map((pose) => worldToScreen(view, mirrorVec(pose, mirror))));
  const labels = layoutFieldCounts({
    badges,
    alliance: input.alliance ?? "RED",
    view,
    mirror,
    widthPx: input.widthPx,
    heightPx: input.heightPx,
    digitPx,
    robotCornersPx,
    pathsPx,
    topRightClearPx: HELP_CORNER_PX,
  });

  for (const label of labels) {
    const left = label.xPx - label.widthPx / 2;
    const top = label.yPx - label.heightPx / 2;
    ctx.fillStyle = theme.countChip;
    ctx.strokeStyle = theme.countEdge;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(Math.round(left) + 0.5, Math.round(top) + 0.5, Math.round(label.widthPx) - 1, label.heightPx - 1, 4);
    ctx.fill();
    ctx.stroke();
    const baseline = Math.round(top) + label.heightPx / 2 + baselineDropPx;
    let x = Math.round(left) + CHIP.padXPx;
    if (label.at === "line") {
      const word = lineWord(label);
      ctx.fillStyle = theme.countInkLo;
      ctx.fillText(word, x, baseline);
      x += word.length * digitPx + CHIP.iconGapPx * 2;
    }
    if (label.parts.length === 0) {
      // An empty place that always shows (the robot, the up hive cell): a muted zero, no icon.
      ctx.fillStyle = theme.countInkLo;
      ctx.fillText("0", x, baseline);
      continue;
    }
    for (const [index, part] of label.parts.entries()) {
      if (index > 0) x += CHIP.partGapPx;
      const ink = partInk(part, theme, mirror !== "none");
      const text = String(part.count);
      ctx.fillStyle = ink.text;
      ctx.fillText(text, x, baseline);
      x += text.length * digitPx + CHIP.iconGapPx;
      drawPieceIcon(ctx, part.piece, x + CHIP.iconPx / 2, Math.round(top) + label.heightPx / 2, ink.icon, pieceEdge(theme));
      x += CHIP.iconPx;
    }
  }
  input.onFieldCounts?.(labels);
  return labels;
}
