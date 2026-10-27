/**
 * Every piece of help text the shell shows, in one table per surface, written for someone who has
 * never planned an FTC path (site/docs/editor.md). Panels and inspector sections
 * read `PANEL_HELP`, the insert menu reads `INSERT_KINDS` and the description table, and the findings
 * panel reads `findingHelp`. `help.test.ts` fails when a panel, a section, a toolbar button or a finding code
 * has no entry, so a new surface cannot ship without its explanation.
 */
import { FINDING_HELP, FINDING_HELP_BY_SEVERITY, type FindingHelp, type Severity } from "@horizon36596/zenith-core";
import { helpForFinding, type Finding } from "@horizon36596/zenith-core";

export type { FindingHelp };

export interface HelpEntry {
  title: string;
  /** One or two plain sentences: what this is for, not how it is built. */
  body: string;
  /**
   * Where the docs say the rest, as a page and an optional heading anchor of site/docs/, such as
   * `editor/#timeline-and-playback`. A pinned tip links to it as "Read more"; `help.test.ts` fails
   * when the page or the heading is not there.
   */
  docs?: string;
}

/** Panel headers and inspector sections, by the id the `?` affordance is given. */
export const PANEL_HELP = {
  field: {
    title: "Field",
    body: "The FTC field from above, with your routine on it. Drag a point to move the path; the outline is the robot's size. Filled shapes block the robot at its height, such as a hive leg's low part; dashed ones are overhead.",
    docs: "editor/#the-field",
  },
  steps: {
    title: "Steps",
    body: "The routine, in the order the robot runs it, top to bottom. Click a step to edit it; drag a step to reorder it or to move it into a group.",
    docs: "editor/#steps-panel",
  },
  timeline: {
    title: "Timeline",
    body: "How long each step takes, turns at path joints included, against the 30 second period. Drag the scrubber or press Play to watch the robot. Playback is Ideal, Instant sim or Full sim.",
    docs: "editor/#timeline-and-playback",
  },
  ledger: {
    title: "Ledger",
    body: "Where the game pieces are, drawn as on the field: what the robot carries and what the hive holds at the playhead, where each step moved pieces from and to, and where pieces lie at the end.",
    docs: "editor/#ledger",
  },
  findings: {
    title: "Problems",
    body: "Everything Zenith noticed that could go wrong on the real field, worst first. Click one to jump to its step or the start; some have a one-click fix. The last line counts problems of features you switched off.",
    docs: "editor/#problems-panel",
  },
  optimize: {
    title: "Optimize path",
    body: "A faster route for this path, or every path with Optimize every path. A collision gets the fastest clear route, even a slower one; Route around keeps the margin. Arrows step through routes. Nothing changes until Apply.",
    docs: "editor/#optimize-path",
  },
  code: {
    title: "Code",
    body: "Java for this auto, updated as you edit. Reference is a class to read: the robot runs the auto file. Export is an OpMode you own that needs no file (not recommended). Click a step's code to select it.",
    docs: "editor/#code-panel",
  },
  partners: {
    title: "Partners",
    body: "Your alliance partners' shared autos, on the field and the timeline with yours. Load a share file a partner sent and set when each robot starts. Nothing here changes your auto.",
    docs: "editor/#partners-panel",
  },
  alliance: {
    title: "Alliance findings",
    body: "Where your robot and a partner's are predicted to meet, pass close, share a start tile, go for one element or enter a reserved area. They are forecasts and never block a save, a deploy or a propose.",
    docs: "editor/#alliance-lanes-and-findings",
  },
  changes: {
    title: "Changed steps",
    body: "Every step the proposal adds, removes or changes, against the version it started from. Click one to see both on the field.",
    docs: "editor/#proposal-mode",
  },
  suggest: {
    title: "Partner steps",
    body: "Your partner's routine as they shared it: steps by id, commands only as tokens with their time. Drag its points on the field, or pick a step to change it. Your own auto is never touched.",
    docs: "editor/#proposal-mode",
  },
  proposal: {
    title: "Proposed changes",
    body: "Every change you are proposing, in the order the partner will read them, each with an optional one-line comment. A change their app would refuse says why here, live.",
    docs: "editor/#proposal-mode",
  },
  partnerstep: {
    title: "Partner step",
    body: "What you can change about the selected partner step: its heading, speed, timeout, wait, markers and envelope. Commands can be moved but never renamed, edited or seen.",
    docs: "editor/#proposal-mode",
  },
  review: {
    title: "Proposal",
    body: "Each change a partner proposes, what it does in your step names, their comment and its effect on the time. Accept or reject each one, then Apply: one undo step, and nothing is saved until you save.",
    docs: "editor/#proposal-mode",
  },
  pinned: {
    title: "Read against",
    body: "The version of your auto the proposal is checked against. A change to a step that has changed since then is a conflict and can only be rejected.",
    docs: "alliance-partners/#proposals",
  },
  inspector: {
    title: "Inspector",
    body: "Select a step or a point to edit it. With nothing selected, this is the routine: its start and its waypoints. Click a section's title to fold it; a dot on a folded one means something is set inside.",
    docs: "editor/#inspector",
  },
  "section.step": {
    title: "Path step",
    body: "One path, or a chain of paths driven one after another, and how long it takes. Paths holds their ends, Heading which way the robot faces, Speed how fast and when to give up. Advanced holds the rest.",
    docs: "editor/#inspector",
  },
  "section.segment": {
    title: "Path",
    body: "Where this path starts and ends, straight or curved. For a curve, set Kind to Curve and drag the hollow squares, listed under Controls. The + adds another path after the last; the chain stays joined.",
    docs: "paths-explained/#paths",
  },
  "section.heading": {
    title: "Heading",
    body: "Which way the robot faces while it drives, by Pedro Pathing's names. Hover a mode to see what it does. Piecewise uses a different mode on each stretch. Drag the arrows on the path to set angles.",
    docs: "paths-explained/#heading-modes",
  },
  "section.speed": {
    title: "Speed",
    body: "How fast this drive goes, as a share of the robot's top speed, a sensor condition that ends it early, and the time it gives up after. An empty speed drives at the robot's default.",
    docs: "step-kinds/#path",
  },
  "section.markers": {
    title: "Markers",
    body: "Commands that fire partway along this path without stopping, such as starting the intake as you approach a piece. Click one to edit it.",
    docs: "paths-explained/#markers",
  },
  "section.marker": {
    title: "Marker",
    body: "The selected marker: the command it fires, that command's settings, and where along the path it fires. Drag the marker on the field to move it too.",
    docs: "paths-explained/#markers",
  },
  "section.command": {
    title: "Command",
    body: "An action from your robot's code, such as running the intake or shooting. The list comes from robot.json.",
    docs: "step-kinds/#command",
  },
  "section.wait": {
    title: "Wait",
    body: "Pause for a time, or until a sensor condition from robot.json becomes true, never both: Wait for picks which. A condition also stops at Give up after, so give it one.",
    docs: "step-kinds/#wait",
  },
  "section.transfer": {
    title: "Transfer",
    body: "Game pieces the planner should assume move between two places, such as your partner scoring into the hive. Expected is what the auto is written for; set Actual to preview an edge case.",
    docs: "step-kinds/#transfer",
  },
  "section.parallel": {
    title: "Parallel group",
    body: "Steps that run at the same time. The Mode says when the group ends: when all of them have, when the first does, or when the one under Ends with does, which starts as the first step that drives.",
    docs: "step-kinds/#parallel",
  },
  "section.sequence": {
    title: "Sequence",
    body: "Steps that run one after another as a single block. Useful inside a parallel group, where one lane needs several steps.",
    docs: "step-kinds/#sequence",
  },
  "section.branch": {
    title: "Branch",
    body: "Runs one set of steps if a condition is true and another if it is not, such as skipping a pickup when the robot is already full.",
    docs: "step-kinds/#branch",
  },
  "section.envelope": {
    title: "Stay-inside box",
    body: "A rectangle this robot promises to stay inside while the step runs, and the longest the step takes. Draw it on the field, then drag its corners, sides or inside. Partners see it on their field.",
    docs: "alliance-partners/#envelopes",
  },
  "section.rejoin": {
    title: "Rejoin",
    body: "Where this path picks the robot up after a command that drives it by itself. The planner starts the path here; on the robot, the path starts wherever the robot really is.",
    docs: "file-format/#rejoinfrom",
  },
  "section.start": {
    title: "Start",
    body: "Where the robot is placed on the field before autonomous begins. Every path that says 'continue from the last step' starts here first. Drag it on the field to move it.",
    docs: "editor/#inspector",
  },
  "section.waypoints": {
    title: "Waypoints",
    body: "A named spot measured once on the real field, in waypoints.json. Autos that follow it move with it; a MEASURED pin selects first. The field shows this auto's; select another to show it. The eye hides a pin for you alone.",
    docs: "editor/#waypoints-explained",
  },
  share: {
    title: "Share this auto",
    body: "Let another team see where your robot drives and when, without your code, notes or robot settings. The sentence at the top says exactly who sees what, and until when.",
    docs: "editor/#the-sharing-chip-and-the-share-dialog",
  },
  sharing: {
    title: "Sharing",
    body: "Every share and invite your team has made. Extend one before it ends, change what a team may do, or revoke it.",
    docs: "editor/#the-sharing-chip-and-the-share-dialog",
  },
  signin: {
    title: "Sign in",
    body: "An account is optional. It adds a team library and sharing; planning, checking and saving autos all work without one. Zenith never asks for a password, asks your age first and keeps only a display name.",
    docs: "editor/#sign-in-and-your-account",
  },
  settings: {
    title: "Settings",
    body: "Everything but the routine itself: account, presets, features, the robot, how the editor looks, keys and data. Search finds any setting in every section (Ctrl F). The robot is saved when you press Save.",
    docs: "editor/#settings",
  },
  teams: {
    title: "Teams",
    body: "Create a team, invite members with a link that ends when you choose, approve them and set what each may do. A team number is unverified until a Horizon admin checks it.",
    docs: "teams-and-sharing/#teams",
  },
  library: {
    title: "Team library",
    body: "Your team's autos in one place, each kept as numbered revisions that are never overwritten. Publish a saved auto, open any revision, or download the whole project.",
    docs: "editor/#team-library",
  },
  versions: {
    title: "Changed steps",
    body: "Every step one library revision adds, removes or changes against the other, with the time each change adds or saves. Click one to see it on the field.",
    docs: "editor/#team-library",
  },
  keep: {
    title: "Choose one",
    body: "Two revisions published from the same one. Keep publishes your choice as the next revision, built on the other, and deletes nothing. Open in project brings either into your folder.",
    docs: "editor/#team-library",
  },
  outbox: {
    title: "Outbox",
    body: "Changes made on this computer wait here until the server has them. Offline, they are sent in order when the connection comes back. The list clears when the page closes; changes still waiting go out on the next visit.",
    docs: "editor/#outbox",
  },
} as const satisfies Record<string, HelpEntry>;

export type PanelHelpId = keyof typeof PANEL_HELP;

/** The timeline's help while Full sim is switched off (issue #207): it names only the levels on offer. */
const TIMELINE_WITHOUT_FULL_SIM: HelpEntry = {
  ...PANEL_HELP.timeline,
  body: PANEL_HELP.timeline.body.replace("Playback is Ideal, Instant sim or Full sim.", "Playback is Ideal or Instant sim."),
};

/** A panel's help as it reads now: the timeline's names Full sim only while that switch is on. */
export const panelHelp = (id: PanelHelpId, fullSim: boolean): HelpEntry =>
  id === "timeline" && !fullSim ? TIMELINE_WITHOUT_FULL_SIM : PANEL_HELP[id];

/**
 * The step kinds the insert menu offers, with the name each one shows. What each one does is in the
 * description table (`descriptions/insert.ts`): a brief in With descriptions, and the rest as a hint.
 */
export const INSERT_KINDS = {
  path: { title: "Path" },
  turn: { title: "Turn" },
  command: { title: "Command" },
  wait: { title: "Wait" },
  transfer: { title: "Transfer" },
  sequence: { title: "Sequence" },
  parallel: { title: "Parallel" },
  branch: { title: "Branch" },
} as const satisfies Record<string, { title: string }>;

export type InsertKind = keyof typeof INSERT_KINDS;

/**
 * What a finding code means and how to fix it: core's `FINDING_HELP`, which the CLI's
 * `validate --explain` and the MCP server print as well, so all three say the same thing. With a
 * severity, a code that has words of its own for it (TIME_BUDGET's info note) gets those instead.
 */
export function findingHelp(code: string, severity?: Severity): FindingHelp | null {
  const bySeverity = (FINDING_HELP_BY_SEVERITY as Readonly<Record<string, Partial<Record<Severity, FindingHelp>> | undefined>>)[code];
  const own = severity === undefined ? undefined : bySeverity?.[severity];
  return own ?? (FINDING_HELP as Readonly<Record<string, FindingHelp | undefined>>)[code] ?? null;
}

/**
 * The help for one finding row: its code's, or narrower words where the code covers two problems,
 * such as a gap between two segments of one path, which is not mended the way a step's start is
 * (issue #146), or TIME_BUDGET's info note, which is not about running over (core's
 * `helpForFinding`).
 */
export function helpOfFinding(finding: Pick<Finding, "code" | "severity" | "fixes">): FindingHelp | null {
  return findingHelp(finding.code) === null ? null : helpForFinding(finding);
}
