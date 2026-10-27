/**
 * The Settings search (issue #430), as pure logic: the index of every row Settings draws, the match
 * of a query against it, and the parts of a text to highlight. The window (`SettingsWindow.tsx`)
 * draws the box and the results; nothing here touches the DOM, the stores or storage, so every rule
 * is tested in `search.test.ts`.
 *
 * The index is built from the registry (`registry.ts`): each setting a section lists is a row, with
 * its group, label and description, and its choices as value names, so a new setting is found as
 * soon as it is registered. The rows a section draws by hand (the account, the robot's numbers, the
 * presets, the keys) are listed below them, and `search.test.ts` fails when a registered setting is
 * neither a row nor named in `NOT_SEARCHABLE`.
 */
import { CAPACITY, CLEARANCE, MOUTH_NUMBERS, ROBOT_GROUPS, SHOOTER_SETTLE } from "./robotSettings";
import { SETTINGS, type AnySettingEntry, type SettingId } from "./registry";
import { SECTIONS, sectionInfo, type SettingsSection } from "./sections";

/** One row of Settings, as the search sees it. */
export interface SearchRow {
  /** Unique: a registry id, or the test id of a row a section draws by hand. */
  key: string;
  section: SettingsSection;
  /** The group the row sits under in its section, shown beside the match. */
  group: string;
  label: string;
  description: string;
  /** Other words a person might type for it. They are matched, and never shown. */
  keywords: readonly string[];
  /** The names of its choices, such as Tangent and Linear. Matched, never shown. */
  values: readonly string[];
  /**
   * What the window brings into view: a row's `data-setting` or its test id. Several, separated by a
   * bar, are tried in order, for a row that is not always drawn (a toolbar button the toolbar lacks).
   */
  target: string;
}

/**
 * The registered settings that have no row in Settings, so a result for them would land nowhere:
 * the Keys setting is the whole Keyboard section (its own row below), and the other two are stored
 * and set by an action, not by a row.
 */
export const NOT_SEARCHABLE: ReadonlySet<SettingId> = new Set<SettingId>(["keys.bindings", "editing.addPathExtends", "display.fieldStyle"]);

/** Extra words for registered settings, for what people call them. */
const REGISTRY_KEYWORDS: Readonly<Partial<Record<SettingId, readonly string[]>>> = {
  "display.theme": ["dark mode", "light mode", "appearance", "colour", "color"],
  "display.fieldGrid": ["lines", "tiles", "snap to grid"],
  "display.waypointPins": ["pins", "markers on the field"],
  "editing.snap": ["magnet", "stick"],
  "editing.nudgeIn": ["arrow keys", "move a point"],
  "editing.nudgeFarIn": ["arrow keys", "shift", "move a point"],
  "editing.rotateDeg": ["turn", "heading", "angle"],
  "editing.scrubStepS": ["timeline", "playhead", "step"],
  "optimizer.scorer": ["optimise", "time"],
  "sim.speed": ["high-fidelity sim", "sim server", "simloop", "warm", "memory"],
  "optimizer.allowSplit": ["optimise", "split"],
  "optimizer.allowRanges": ["optimise", "heading"],
  "optimizer.holdStartHeadingIn": ["optimise", "heading", "hold", "straight"],
  "optimizer.holdEndHeadingIn": ["optimise", "heading", "hold", "straight", "last bit"],
};

const optionNames = (entry: AnySettingEntry): readonly string[] => {
  const { control } = entry;
  if (control.type !== "segmented" && control.type !== "dropdown") return [];
  return control.options === "fieldStyles" ? [] : control.options.map((option) => option.label);
};

const targetOf = (entry: AnySettingEntry): string => {
  // A number setting is a field with no row around it: its own test id is what the window finds.
  if (entry.control.type === "number") return `settings-editing-${entry.storage}`;
  // A toolbar button's toggle is not there while the toolbar lacks the button: the group is the next best place.
  return entry.id.startsWith("display.toolbar.") ? `${entry.id}|settings-toolbar` : entry.id;
};

const registryRow = (entry: AnySettingEntry): SearchRow => ({
  key: entry.id,
  section: entry.section,
  group: entry.id.startsWith("display.toolbar.") ? "Toolbar buttons" : entry.group,
  label: entry.label,
  description: entry.description,
  keywords: [
    ...(REGISTRY_KEYWORDS[entry.id] ?? []),
    ...(entry.kind === "feature" ? ["switch", "turn on", "turn off", "show", "hide"] : []),
    ...(entry.id.startsWith("display.toolbar.") ? ["toolbar", "button", "hide", "show"] : []),
  ],
  values: optionNames(entry),
  target: targetOf(entry),
});

const by = (
  section: SettingsSection,
  group: string,
  key: string,
  label: string,
  description: string,
  keywords: readonly string[] = [],
  values: readonly string[] = [],
): SearchRow => ({ key, section, group, label, description, keywords, values, target: key });

/** The rows a section draws by hand. Each key is the test id of the row, or of its control. */
const HAND_DRAWN: readonly SearchRow[] = [
  by("account", "Profile", "settings-display-name", "Display name", "Shown to the members of your teams, never to other teams.", ["name", "profile", "rename"]),
  by("account", "Profile", "settings-sign-in-method", "Signed in with", "The sign-in method of this account, and its email.", ["email", "google", "github", "microsoft", "login", "provider"]),
  by("account", "Profile", "settings-sign-out", "Sign out", "Leave this account on this computer.", ["log out", "logout"]),
  by("account", "Account", "settings-sign-in", "Sign in", "An account adds a team library and sharing; everything else works without one.", ["log in", "login", "account"]),

  by("presets", "This project's presets", "presets-project", "This project's presets", "Presets kept in the open project for the whole team. Apply one, or put one of yours there with Add to project.", ["team", "share", "teammate", "everyone", "project", "add to project", "preset"]),
  by("presets", "Built-in presets", "presets-builtins", "Built-in presets", "Basic, Essential and Full: sets of switches and options to start from.", ["preset", "basic", "essential", "full"], ["Basic", "Essential", "Full"]),
  by("presets", "Your presets", "presets-mine", "Your presets", "Presets you saved or imported. Apply, rename, duplicate, export, add to the project or delete them.", ["rename", "duplicate", "export", "delete", "update", "add to project"]),
  by("presets", "Your presets", "presets-save-row", "Save my settings", "Keep the settings you have now as a preset of your own.", ["preset", "new preset"]),
  by("presets", "Your presets", "presets-import-row", "Preset file", "Import a .zenith-preset.json file from a teammate. It changes nothing until you apply it.", ["import", "share", "teammate", "file"]),

  { ...by("robot", "Robot", "settings-robot-name", "Name", "What this robot is called in the editor and in shared autos.", ["robot name", "rename"]), target: "settings-robot-name|settings-robot-identity" },
  ...ROBOT_GROUPS.flatMap((group) =>
    group.numbers.map((entry) => by("robot", group.title, `settings-robot-${entry.id}`, entry.label, entry.hint, ["robot.json", entry.unit.label])),
  ),
  by("robot", "Size", "robot.clearance", CLEARANCE.label, CLEARANCE.hint, ["safety margin", "structures", "keep out", "robot.json"]),
  by("robot", "Follower", "settings-command-library", "Command library", "The library the generated auto class runs on, written to the project's zenith.json.", ["solverslib", "pedro", "commands", "code"]),
  by("robot", "Follower", "settings-pathing", "Pathing system", "The path follower the generated code uses.", ["pedro", "follower", "code"]),
  { ...by("robot", "Follower", "settings-robot-follower-version", "Pedro Pathing version", "The Pedro Pathing version the robot code builds against.", ["follower", "pedro", "follower version"]), target: "settings-robot-follower-version|settings-robot-follower" },
  by("robot", "Follower", "settings-robot-follower", "Hold the end of each path", "Whether the follower holds the end of each path.", ["follower", "hold end", "pedro"]),
  by("robot", "Intakes", "settings-robot-mouths", "Intakes", "Where each intake sits on the robot, and how wide and deep it is.", ["mouth", ...MOUTH_NUMBERS.map((entry) => entry.label.toLowerCase())]),
  by("robot", "Game pieces", `settings-robot-${CAPACITY.id}`, CAPACITY.label, CAPACITY.hint, ["capacity", "ledger", "robot.json"]),
  by("robot", "Game pieces", `settings-robot-${SHOOTER_SETTLE.id}`, SHOOTER_SETTLE.label, SHOOTER_SETTLE.hint, ["shooter", "launch", "robot.json"]),

  { ...by("commands", "Commands", "settings-commands-add", "Add command", "Add a command your robot code registers, with its arguments and how long it takes.", ["new command", "named command"]), target: "settings-commands-add|settings-commands-list" },
  by("commands", "Commands", "settings-commands-import", "Import from Java", "Read the NamedCommands registrations in your robot code and add the ones robot.json is missing.", ["import commands", "named commands", "registry"]),

  by("editor", "Appearance", "settings-descriptions", "Descriptions", "Whether rows show a short line under their labels, or only the label.", ["labels only", "with descriptions", "help text", "hints"], ["Labels only", "With descriptions"]),
  by("editor", "Field", "settings-overhead-outlines", "Overhead outlines", "Dashed outlines of the hive frame and hive the robot drives under.", ["hive", "outline", "legs"], ["Show", "Hide"]),
  by("editor", "Optimize path", "settings-optimize-margin", "Safety margin", "The robot's clearance from field elements, which Optimize path keeps.", ["clearance", "optimise", "robot"]),

  by("keyboard", "Keys", "keyboard-filter", "Keyboard shortcuts", "Your own keys for the editor's actions. Filter them by action or key, and rebind or clear any of them.", ["keys", "keybinding", "hotkey", "rebind", "keymap", "shortcut", "key"]),
  by("keyboard", "Keys", "keyboard-reset-all", "Reset all keys", "Give every action its default key back. Asks first.", ["default keys", "shortcuts", "reset"]),

  by("teams", "Your teams", "account-open-teams", "Manage teams", "Create a team, invite and approve members, and set roles.", ["team", "join", "create", "members", "invite"]),
  by("data", "Your data", "settings-export", "Export my data", "Downloads your profile, your memberships, and what you wrote in your teams.", ["download", "privacy", "gdpr", "copy"]),
  by("data", "Delete account", "settings-delete", "Delete my account", "Removes you from every team and deletes your profile and your sign-in. It cannot be undone.", ["remove account", "privacy", "erase"]),
  by("admin", "Admin", "account-admin-dashboard", "Admin dashboard", "The page for Horizon admins.", ["admin", "dashboard"]),
  by("developer", "Developer", "fake-demo-reviewer", "Test users", "Switch between the fake cloud's test users and devices.", ["fake cloud", "developer", "feedback", "cloud reads"]),
];

const rowsFor = new Map<boolean, readonly SearchRow[]>();

/**
 * Every row Settings has, in the order the sections list them and the registry lists the settings.
 * `desktop` says whether this is the desktop app: a browser lists no `desktopOnly` setting.
 */
export function searchRows(desktop: boolean): readonly SearchRow[] {
  const cached = rowsFor.get(desktop);
  if (cached !== undefined) return cached;
  const registered = SETTINGS.filter(
    (entry) =>
      entry.awaiting === undefined &&
      entry.unlisted === undefined &&
      !NOT_SEARCHABLE.has(entry.id) &&
      (entry.desktopOnly !== true || desktop),
  ).map(registryRow);
  const order = (row: SearchRow): number => SECTIONS.findIndex((section) => section.id === row.section);
  const rows = [...registered, ...HAND_DRAWN]
    .map((row, index) => ({ row, index }))
    .sort((a, b) => order(a.row) - order(b.row) || a.index - b.index)
    .map(({ row }) => row);
  rowsFor.set(desktop, rows);
  return rows;
}

/* ---- Matching ----------------------------------------------------------------------------------- */

/** The words of a query: lower case, split on whitespace. A blank query has none. */
export const tokensOf = (query: string): string[] => query.toLowerCase().split(/\s+/).filter((token) => token !== "");

/** Whether a word of `text` (already lower case) begins with `token`, or, given `at`, whether one begins there. */
const startsWord = (text: string, token: string, at?: number): boolean => {
  const begins = (index: number): boolean => index === 0 || !/[\p{L}\p{N}]/u.test(text.charAt(index - 1));
  if (at !== undefined) return begins(at);
  for (let found = text.indexOf(token); found !== -1; found = text.indexOf(token, found + 1)) {
    if (begins(found)) return true;
  }
  return false;
};

/**
 * How well one word matches a row, lower is better, or null when it is nowhere in it: 0 starts a
 * word of the label, 1 is inside the label, 2 starts a word of a keyword, a value or the group, 3 is
 * anywhere else, in the description or the section's name.
 */
function tierOf(row: SearchRow, token: string): number | null {
  const label = row.label.toLowerCase();
  if (startsWord(label, token)) return 0;
  // One letter is found only where a word begins: inside words it would match nearly every row.
  if (token.length > 1 && label.includes(token)) return 1;
  const aside = [...row.keywords, ...row.values, row.group].map((text) => text.toLowerCase());
  if (aside.some((text) => startsWord(text, token))) return 2;
  if (token.length === 1) return null;
  const rest = [row.description, sectionInfo(row.section).label, ...aside].map((text) => text.toLowerCase());
  return rest.some((text) => text.includes(token)) ? 3 : null;
}

/** A row's score for a query, lower is better, or null when any word of the query is missing from it. */
function scoreOf(row: SearchRow, tokens: readonly string[]): number | null {
  let score = 0;
  for (const token of tokens) {
    const tier = tierOf(row, token);
    if (tier === null) return null;
    score += tier;
  }
  return score;
}

/** The rows of one section that a query found, best first. */
export interface SearchGroup {
  section: SettingsSection;
  rows: readonly SearchRow[];
}

/** Whether every word of the query starts a word of the section's own name: "key" names Keyboard. */
const namesSection = (section: SettingsSection, tokens: readonly string[]): boolean => {
  const label = sectionInfo(section).label.toLowerCase();
  return tokens.every((token) => startsWord(label, token));
};

/**
 * The rows `query` finds in the sections this person sees, grouped by section. Every word of the
 * query must be in the row, in any order and any case; a row whose label has the words comes before
 * one that has them only in its description. Rows that match alike stay in their order. The sections
 * go best first (#498, W1-14): a section the query names leads, then the one whose best row matches
 * best, so "key" lists Keyboard before the toolbar rows whose descriptions mention a key; sections
 * that tie keep the list's order. A blank query finds nothing: the window shows its sections then.
 */
export function matchRows(all: readonly SearchRow[], query: string, sections: readonly SettingsSection[]): SearchGroup[] {
  const tokens = tokensOf(query);
  if (tokens.length === 0) return [];
  const groups = sections.flatMap((section, order) => {
    const hits = all
      .filter((row) => row.section === section)
      .map((row, index) => ({ row, index, score: scoreOf(row, tokens) }))
      .filter((hit): hit is { row: SearchRow; index: number; score: number } => hit.score !== null)
      .sort((a, b) => a.score - b.score || a.index - b.index);
    if (hits.length === 0) return [];
    const best = namesSection(section, tokens) ? -1 : (hits[0]?.score ?? 0);
    return [{ group: { section, rows: hits.map((hit) => hit.row) }, best, order }];
  });
  return groups.sort((a, b) => a.best - b.best || a.order - b.order).map(({ group }) => group);
}

/** How many rows a search found in all. */
export const resultCount = (groups: readonly SearchGroup[]): number => groups.reduce((sum, group) => sum + group.rows.length, 0);

/* ---- Highlighting ------------------------------------------------------------------------------- */

export interface TextPart {
  text: string;
  /** Whether a word of the query is here. */
  match: boolean;
}

/** `text` cut into the parts that match a word of `query` and the parts that do not; the parts joined are `text`. */
export function highlightParts(text: string, query: string): TextPart[] {
  if (text === "") return [];
  const tokens = tokensOf(query);
  const lower = text.toLowerCase();
  // A letter that changes length in lower case would put the marks in the wrong place: show it plain.
  if (tokens.length === 0 || lower.length !== text.length) return [{ text, match: false }];
  const ranges: Array<[number, number]> = [];
  for (const token of tokens) {
    for (let at = lower.indexOf(token); at !== -1; at = lower.indexOf(token, at + token.length)) {
      if (token.length > 1 || startsWord(lower, token.slice(0, 1), at)) ranges.push([at, at + token.length]);
    }
  }
  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: Array<[number, number]> = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last !== undefined && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([range[0], range[1]]);
  }
  const parts: TextPart[] = [];
  let from = 0;
  for (const [start, end] of merged) {
    if (start > from) parts.push({ text: text.slice(from, start), match: false });
    parts.push({ text: text.slice(start, end), match: true });
    from = end;
  }
  if (from < text.length) parts.push({ text: text.slice(from), match: false });
  return parts.length === 0 ? [{ text, match: false }] : parts;
}
