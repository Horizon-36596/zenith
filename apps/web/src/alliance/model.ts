/**
 * The alliance view's pure arithmetic (spec 13 section 9): the partners
 * the user has loaded, the one alliance clock every robot and the scrubber share, the predicted
 * findings from core's `checkAlliance`, and what the canvas and the timeline draw for each partner.
 *
 * Nothing here touches the DOM, a clock or the store, so every piece is tested in node.
 *
 * **The alliance clock.** While any partner is loaded, the playback scrubber reads the alliance
 * clock: seconds from the start of the match period, the clock `checkAlliance` reports its
 * findings on. A robot with a start offset holds its start pose for that many seconds and then
 * runs its auto, so the user's own robot is drawn at `ownLocalS(scrubber, ownOffset)` of its own
 * routine and each partner at `partnerLocalS(scrubber, partnerOffset)` of its trajectory. With no
 * partner loaded the own offset is not applied and the scrubber is the routine's own clock, as it
 * always was.
 */
import {
  add,
  ALLIANCE_TICK_S,
  alliancePoseAt,
  allianceRobotFromProjection,
  checkAlliance,
  isClearableAllianceCode,
  mirrorAllianceRobot,
  rectCorners,
  rotate,
  smallestClearingOffset,
  type AllianceOptions,
  type AlliancePhaseLabel,
  type AllianceRobot,
  type ClaimPlace,
  type ClearableAllianceCode,
  type ClearingOffset,
  type Finding,
  type MirrorIds,
  type MirrorMode,
  type Pose,
  type Vec2,
} from "@horizon36596/zenith-core";
import type { Projection } from "@horizon36596/zenith-schema";
import type { PartnerShare } from "../cloud/partnerShare";
import { timedCommands } from "../cloud/projectionModel";

/** How many partner colours there are (`--partner-1` to `--partner-3`); a fourth reuses the first. */
export const PARTNER_COLOURS = 3;

/**
 * The longest start offset the inputs accept, in seconds. SPEC: the FTC autonomous period is
 * 30 s, and a robot that waits longer than that never drives.
 */
export const MAX_START_OFFSET_S = 30;

/** One partner the user has loaded, and how they chose to show it. */
export interface PartnerEntry {
  /** Stable for the session: `partner1`, `partner2`, and so on, never reused. */
  id: string;
  /** The file it came from, or where the source says it came from. */
  fileName: string;
  projection: Projection;
  /** How the panel, the canvas and the findings name it: the projection's title, else the file. */
  label: string;
  /** Which of the `PARTNER_COLOURS` it is drawn in, from 0. */
  colour: number;
  /** A hidden partner is left off the field, the timeline and the alliance findings. */
  visible: boolean;
  /** Seconds this partner waits at its start pose before its auto begins, on the 0.1 s grid. */
  offsetS: number;
  /** The received cloud share it was loaded from; absent for a partner loaded from a file. */
  share?: PartnerShare;
}

/** The name a partner is shown by: the projection's title, else its file name without `.json`. */
export function partnerLabel(projection: Pick<Projection, "title">, fileName: string): string {
  const title = projection.title?.trim();
  if (title !== undefined && title.length > 0) return title;
  const base = fileName.slice(Math.max(fileName.lastIndexOf("/"), fileName.lastIndexOf("\\")) + 1);
  const stripped = base.replace(/\.json$/i, "").replace(/\.projection$/i, "");
  return stripped.length > 0 ? stripped : "Partner";
}

/** The first colour no loaded partner uses, or the next in turn when every one is taken. */
export function nextColour(partners: readonly Pick<PartnerEntry, "colour">[]): number {
  for (let colour = 0; colour < PARTNER_COLOURS; colour += 1) {
    if (!partners.some((partner) => partner.colour === colour)) return colour;
  }
  return partners.length % PARTNER_COLOURS;
}

/**
 * A start offset as the checks compare it: a finite number of seconds from 0 to 30, on the same
 * 0.1 s grid as the comparison, so what the input shows is exactly what was checked.
 */
export function snapOffset(valueS: number): number {
  if (!Number.isFinite(valueS)) return 0;
  const clamped = Math.min(MAX_START_OFFSET_S, Math.max(0, valueS));
  return Math.round(clamped / ALLIANCE_TICK_S) / Math.round(1 / ALLIANCE_TICK_S);
}

// ---------------------------------------------------------------------------------------------
// The alliance clock.
// ---------------------------------------------------------------------------------------------

/** Seconds into the user's own routine at a time on the alliance clock: 0 while it waits. */
export const ownLocalS = (allianceS: number, ownOffsetS: number): number => Math.max(0, allianceS - ownOffsetS);

/** Seconds into a partner's trajectory at a time on the alliance clock: 0 while it waits. */
export const partnerLocalS = (allianceS: number, offsetS: number): number => Math.max(0, allianceS - offsetS);

/** Where on the alliance clock a finding happened, for the scrubber: the finding's own time. */
export const findingAllianceS = (finding: Pick<Finding, "timeS">): number => Math.max(0, finding.timeS ?? 0);

/** How long a partner's part of the alliance runs: its trajectory or its last envelope, plus its offset. */
export function partnerEndS(projection: Pick<Projection, "totalS" | "trajectory" | "envelopes">, offsetS: number): number {
  const trajectoryS = (projection.trajectory.poses.length - 1) * ALLIANCE_TICK_S;
  const envelopeS = projection.envelopes.reduce((latest, envelope) => Math.max(latest, envelope.endS), 0);
  return offsetS + Math.max(projection.totalS, trajectoryS, envelopeS);
}

/**
 * How long the scrubber runs while partners are loaded: until the last robot, the user's with its
 * offset and every visible partner with theirs, has finished. Null when the user's own run length
 * is not known, since then the scrubber cannot run at all.
 */
export function allianceRunS(
  ownRunS: number | null,
  ownOffsetS: number,
  partners: readonly Pick<PartnerEntry, "projection" | "offsetS" | "visible">[],
): number | null {
  if (ownRunS === null) return null;
  let end = ownRunS + ownOffsetS;
  for (const partner of partners) {
    if (!partner.visible) continue;
    end = Math.max(end, partnerEndS(partner.projection, partner.offsetS));
  }
  return end;
}

// ---------------------------------------------------------------------------------------------
// The partners as the checks and the canvas see them.
// ---------------------------------------------------------------------------------------------

/** How a partner written for the other alliance is put onto the user's. */
export interface AllianceFrame {
  /** The alliance the user's auto is written for. */
  alliance: "RED" | "BLUE";
  /** The field's own mirror (`mirrorForField`). */
  mirror: MirrorMode;
  /** The season's `mirrorId` hook, to rename a mirrored partner's claimed elements. */
  mirrorId?: MirrorIds;
  /** The season's `claimPlace` hook, bound to the field, so an element conflict compares places. */
  claimPlace?: ClaimPlace;
}

/** A partner as an alliance robot, in the user's alliance frame: mirrored when written for the other. */
export function alignedPartner(entry: Pick<PartnerEntry, "projection" | "label">, frame: AllianceFrame): AllianceRobot {
  const robot = allianceRobotFromProjection(entry.projection, entry.label);
  if (robot.alliance === undefined || robot.alliance === frame.alliance) return robot;
  return mirrorAllianceRobot(robot, frame.mirror, frame.mirrorId);
}

/** One partner, loaded and aligned. */
export interface AlignedPartner {
  entry: PartnerEntry;
  robot: AllianceRobot;
  /** True when its projection was written for the other alliance and was mirrored. */
  mirrored: boolean;
}

/** A predicted alliance finding, with the partner it is about. */
export interface AllianceFinding {
  finding: Finding;
  partnerId: string;
}

/** What the alliance view shows for the current inputs. */
export interface AllianceResult {
  partners: AlignedPartner[];
  /** Partner by partner in load order, each partner's in time order. */
  findings: AllianceFinding[];
  /**
   * The "delay my start" fix: the smallest own start offset, in 0.1 s steps up to 10 s, that
   * clears every predicted collision with every visible partner. Undefined when there is no
   * collision to clear, null when no offset in that range clears it.
   */
  clearingOffset: ClearingOffset | null | undefined;
  /**
   * The same fix for every code a later start can clear (spec 13 section 9): for each of
   * ALLIANCE_COLLISION, ALLIANCE_NEAR_MISS and ALLIANCE_ENVELOPE that was raised, the smallest own
   * start offset that clears every finding of that code without leaving a collision, or null when
   * none up to 10 s does. A code that was not raised has no entry. `clearingOffset` is this map's
   * collision entry.
   */
  clearingOffsets: Partial<Record<ClearableAllianceCode, ClearingOffset | null>>;
}

/** The options every alliance comparison in the editor passes to core. */
export function allianceOptions(
  ownOffsetS: number,
  partners: readonly Pick<PartnerEntry, "offsetS">[],
  frame?: Pick<AllianceFrame, "claimPlace">,
): AllianceOptions {
  return {
    ownStartOffsetS: ownOffsetS,
    partnerStartOffsetsS: partners.map((partner) => partner.offsetS),
    ...(frame?.claimPlace === undefined ? {} : { claimPlace: frame.claimPlace }),
  };
}

/**
 * The predicted findings for the user's robot against every visible partner. Partners arrive
 * already in the user's frame (`alignedPartner`), so core mirrors nothing again.
 */
export function computeAlliance(
  own: AllianceRobot,
  entries: readonly PartnerEntry[],
  ownOffsetS: number,
  frame: AllianceFrame,
): AllianceResult {
  const partners: AlignedPartner[] = entries
    .filter((entry) => entry.visible)
    .map((entry) => ({
      entry,
      robot: alignedPartner(entry, frame),
      mirrored: entry.projection.alliance !== frame.alliance,
    }));
  const ownRobot: AllianceRobot = { ...own, alliance: frame.alliance };
  const findings: AllianceFinding[] = [];
  for (const partner of partners) {
    const raised = checkAlliance(ownRobot, [partner.robot], allianceOptions(ownOffsetS, [partner.entry], frame));
    for (const finding of raised) findings.push({ finding, partnerId: partner.entry.id });
  }
  const clearingOffsets: Partial<Record<ClearableAllianceCode, ClearingOffset | null>> = {};
  for (const { finding } of findings) {
    const code = finding.code;
    if (!isClearableAllianceCode(code) || code in clearingOffsets) continue;
    clearingOffsets[code] = smallestClearingOffset(
      ownRobot,
      partners.map((partner) => partner.robot),
      allianceOptions(ownOffsetS, partners.map((partner) => partner.entry), frame),
      code,
    );
  }
  return { partners, findings, clearingOffset: clearingOffsets.ALLIANCE_COLLISION, clearingOffsets };
}

// ---------------------------------------------------------------------------------------------
// Memoisation: the checks rerun only when something they read has changed.
// ---------------------------------------------------------------------------------------------

const identities = new WeakMap<object, number>();
let nextIdentity = 1;

/** A small number standing for one object's identity, so an object can be part of a string key. */
export function identityOf(value: object): number {
  const known = identities.get(value);
  if (known !== undefined) return known;
  const id = nextIdentity;
  nextIdentity += 1;
  identities.set(value, id);
  return id;
}

/**
 * The key the alliance result is memoised on: the user's robot (one object per plan), the own
 * offset, the frame, and each partner's identity, visibility and offset. A change to anything the
 * checks do not read, such as a partner's colour or the scrubber, leaves the key alone.
 */
export function allianceKey(
  own: object,
  ownOffsetS: number,
  frame: Pick<AllianceFrame, "alliance" | "mirror">,
  partners: readonly Pick<PartnerEntry, "id" | "projection" | "visible" | "offsetS" | "label">[],
): string {
  const parts = partners.map(
    (partner) =>
      `${partner.id}:${String(identityOf(partner.projection))}:${partner.visible ? "1" : "0"}:${partner.offsetS.toFixed(1)}:${partner.label}`,
  );
  return [String(identityOf(own)), ownOffsetS.toFixed(1), frame.alliance, frame.mirror, ...parts].join("|");
}

/** A one-entry memo: the last key and its value. */
export function lastValueMemo<T>(): (key: string, compute: () => T) => T {
  let last: { key: string; value: T } | null = null;
  return (key, compute) => {
    if (last !== null && last.key === key) return last.value;
    const value = compute();
    last = { key, value };
    return value;
  };
}

// ---------------------------------------------------------------------------------------------
// What the canvas draws.
// ---------------------------------------------------------------------------------------------

/** One partner on the field at one moment, in the user's alliance frame, in inches. */
export interface PartnerDraw {
  id: string;
  label: string;
  colour: number;
  /** The robot's box at the scrubber's time, four corners counter-clockwise. */
  boxIn: Vec2[];
  poseIn: Pose;
  /** True while it is still waiting out its start offset. */
  waiting: boolean;
  /** Its whole trajectory, drawn as a faint polyline. */
  trajectoryIn: Vec2[];
  /** The envelopes it has reserved that are active at the scrubber's time, drawn hatched. */
  envelopesIn: Vec2[][];
}

/** A robot's box at a pose, the same box `checkAlliance` compares. */
export function partnerBoxAt(robot: Pick<AllianceRobot, "boundingBox">, pose: Pose): Vec2[] {
  const box = robot.boundingBox;
  return rectCorners({
    centreIn: add(pose, rotate(box.centreOffsetIn, pose.headingRad)),
    lengthIn: box.lengthIn,
    widthIn: box.widthIn,
    headingRad: pose.headingRad,
  });
}

/** Every visible partner as the canvas draws it at `allianceS` on the alliance clock. */
export function buildPartnerScene(partners: readonly AlignedPartner[], allianceS: number): PartnerDraw[] {
  return partners.map(({ entry, robot }) => {
    const poseIn = alliancePoseAt(robot, allianceS, entry.offsetS);
    const localS = allianceS - entry.offsetS;
    return {
      id: entry.id,
      label: entry.label,
      colour: entry.colour,
      boxIn: partnerBoxAt(robot, poseIn),
      poseIn,
      waiting: localS < 0,
      trajectoryIn: robot.poses.map((pose) => ({ xIn: pose.xIn, yIn: pose.yIn })),
      envelopesIn: robot.envelopes
        .filter((envelope) => localS >= envelope.startS - 1e-6 && localS <= envelope.endS + 1e-6)
        .map((envelope) => envelope.polygon.map((vertex) => ({ ...vertex }))),
    };
  });
}

// ---------------------------------------------------------------------------------------------
// What the timeline draws.
// ---------------------------------------------------------------------------------------------

/** One block in a partner's timeline lane, on the alliance clock. */
export interface LaneBlock {
  startS: number;
  endS: number;
  kind: "offset" | "phase" | "envelope";
  /** The phase label, for a phase. */
  label?: AlliancePhaseLabel;
  /**
   * For a phase of a projection that names its commands ("Include command names"): the commands
   * that ran during it, by name and settings, in the order they were called. Absent otherwise, so
   * a lane from a projection without names reads as it always did.
   */
  commands?: string[];
}

/**
 * A partner's lane: its start offset as a hollow block, then every phase of its projection, then
 * every envelope window, each shifted onto the alliance clock by the offset. Phases can overlap
 * where the partner's auto ran steps in parallel; they are kept in the projection's order.
 */
export function partnerLane(entry: Pick<PartnerEntry, "projection" | "offsetS">): LaneBlock[] {
  const blocks: LaneBlock[] = [];
  const offsetS = entry.offsetS;
  if (offsetS > 0) blocks.push({ startS: 0, endS: offsetS, kind: "offset" });
  const named = timedCommands(entry.projection);
  for (const phase of entry.projection.phases) {
    const block: LaneBlock = { startS: phase.startS + offsetS, endS: phase.endS + offsetS, kind: "phase", label: phase.label };
    // A command belongs to the phase its step's run overlaps; one that takes no time, to the phase it starts in.
    const during = named
      .filter((command) =>
        command.endS > command.startS
          ? command.startS < phase.endS && command.endS > phase.startS
          : command.startS >= phase.startS && command.startS < phase.endS,
      )
      .map((command) => command.words);
    if (during.length > 0) block.commands = during;
    blocks.push(block);
  }
  for (const envelope of entry.projection.envelopes) {
    blocks.push({ startS: envelope.startS + offsetS, endS: envelope.endS + offsetS, kind: "envelope" });
  }
  return blocks;
}

/** A block's place on a lane `scaleS` seconds wide, as percentages of the lane's width. */
export function laneGeometry(block: Pick<LaneBlock, "startS" | "endS">, scaleS: number): { leftPct: number; widthPct: number } {
  if (!(scaleS > 0)) return { leftPct: 0, widthPct: 0 };
  const start = Math.min(Math.max(block.startS, 0), scaleS);
  const end = Math.min(Math.max(block.endS, start), scaleS);
  return { leftPct: (start / scaleS) * 100, widthPct: ((end - start) / scaleS) * 100 };
}

/** "predicted at 4.0 s": how a finding's time reads in the panel. */
export const findingTimeLabel = (finding: Pick<Finding, "timeS">): string =>
  `${findingAllianceS(finding).toFixed(1)} s`;
