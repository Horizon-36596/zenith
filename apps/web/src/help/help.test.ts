import { readFileSync, readFileSync as read, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { FINDING_HELP, loadAuto, loadField, loadRobot, loadWaypoints } from "@horizon36596/zenith-core";
import { derive } from "../state/derived";
import { describe, expect, it } from "vitest";
import { ACTIONS, HELP_MENU, TOOLBAR_GROUPS, actionById } from "../app/actions";
import { CANVAS_HELP } from "../canvas/help";
import { canvasHelp } from "./canvasHelp";
import { INSERT_KINDS, PANEL_HELP, findingHelp, panelHelp, type HelpEntry } from "./content";
import { DESCRIPTIONS, descriptionHint, descriptionProblems, type Description, type DescriptionId } from "./descriptions";
import {
  NOTE_LITERAL_DIRS,
  PROSE_CLASSES,
  SHEET_NOTE_ALLOWLIST,
  SHEET_NOTE_DIRS,
  noteLiteralProblems,
  noteLiteralSites,
  sheetNoteProblems,
  sheetNoteSites,
  type SheetNoteSite,
} from "./noteLiterals";
import { CORE_STOPS, FULL_STOPS } from "../tour/stops";

/**
 * Help everywhere (site/docs/editor.md): every toolbar button, panel header,
 * inspector section, insert kind and finding code has plain-language help, and nothing that ships
 * a `?` points at help that does not exist.
 */
const SRC = fileURLToPath(new URL("..", import.meta.url));
const DOCS_DIR = fileURLToPath(new URL("../../../../site/docs/", import.meta.url));

/** The longest a panel tip's body may be: the detail belongs in the docs page the tip links to. */
const PANEL_HELP_BODY_CAP = 220;

/**
 * The anchor mkdocs' toc extension gives a heading: lowercase, anything that is not a word
 * character, a space or a hyphen dropped, and runs of spaces and hyphens made one hyphen.
 */
function slug(heading: string): string {
  return heading
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/g, "-");
}

/**
 * The text a markdown heading renders to, which is what mkdocs' toc slugifies: a link or an
 * emphasis keeps its words and loses its markup and URL, an image or an HTML tag renders no text,
 * and a code span keeps its contents as they are.
 */
function headingText(markdown: string): string {
  return markdown
    .split(/(`[^`]*`)/)
    .map((part) =>
      part.startsWith("`")
        ? part.slice(1, -1)
        : part
            .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
            .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
            .replace(/\[([^\]]*)\]\[[^\]]*\]/g, "$1")
            .replace(/<[^>]+>/g, "")
            .replace(/(\*{1,3}|_{1,3})(\S(?:.*?\S)?)\1/g, "$2"),
    )
    .join("");
}

/** The anchor of one heading line's text: its `{ #id }` attribute when it has one, else its slug. */
function anchorOf(heading: string): string {
  const id = /\{\s*#([\w-]+)[^}]*\}\s*$/.exec(heading);
  return id?.[1] ?? slug(headingText(heading));
}

/** The anchors of one docs page: an anchor for each heading outside a code fence. */
function anchorsOf(markdown: string): string[] {
  let fenced = false;
  const anchors: string[] = [];
  for (const line of markdown.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    const heading = fenced ? null : /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading?.[1] !== undefined) anchors.push(anchorOf(heading[1]));
  }
  return anchors;
}

/** Why a `docs` value does not name a page in site/docs/ and a heading on it; empty when it does. */
function docsProblems(docs: string, read: (file: string) => string | null): string[] {
  const match = /^([a-z0-9-]+)\/(?:#([a-z0-9-]+))?$/.exec(docs);
  if (match === null) return [`"${docs}" is not page/ or page/#anchor`];
  const [, page = "", anchor] = match;
  const text = read(`${page}.md`);
  if (text === null) return [`site/docs/${page}.md does not exist`];
  if (anchor !== undefined && !anchorsOf(text).includes(anchor)) return [`${page}.md has no heading with the anchor #${anchor}`];
  return [];
}

const readDocs = (file: string): string | null => {
  try {
    return readFileSync(join(DOCS_DIR, file), "utf8");
  } catch {
    return null;
  }
};

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return entry.name.endsWith(".tsx") ? [readFileSync(path, "utf8")] : [];
  });
}

const ALL = sources(SRC).join("\n");

describe("help tips that link to the docs", () => {
  const page = ["# The editor", "", "## Timeline and playback", "", "### `race`: stop when it ends", "", "```", "# not a heading", "```", ""].join("\n");

  it("makes anchors the way mkdocs does", () => {
    expect(slug("Timeline and playback")).toBe("timeline-and-playback");
    expect(slug("`race`: stop when the drive ends")).toBe("race-stop-when-the-drive-ends");
    expect(anchorsOf(page)).toEqual(["the-editor", "timeline-and-playback", "race-stop-when-it-ends"]);
  });

  it("slugifies a heading's rendered text, not its markdown", () => {
    expect(anchorOf("Read the [Pedro docs](https://pedropathing.com/docs) first")).toBe("read-the-pedro-docs-first");
    expect(anchorOf("Paths and [chains][ref]")).toBe("paths-and-chains");
    expect(anchorOf("The _start_ of a **routine**")).toBe("the-start-of-a-routine");
    expect(anchorOf("The `snake_case` keys")).toBe("the-snake_case-keys");
    expect(anchorOf("Field ![icon](img/field.png) layout <small>new</small>")).toBe("field-layout-new");
    expect(anchorOf("Heading names { #custom-anchor }")).toBe("custom-anchor");
    expect(anchorsOf("## See [the guide](guide.md)\n")).toEqual(["see-the-guide"]);
  });

  it("fails a page that is not in site/docs/", () => {
    expect(docsProblems("nowhere/#timeline", readDocs)).toEqual(["site/docs/nowhere.md does not exist"]);
  });

  it("fails an anchor that is not a heading of its page, and passes one that is", () => {
    const read = (): string => page;
    expect(docsProblems("editor/#timeline-and-playbak", read)).toEqual(["editor.md has no heading with the anchor #timeline-and-playbak"]);
    expect(docsProblems("editor/#timeline-and-playback", read)).toEqual([]);
    expect(docsProblems("editor/", read)).toEqual([]);
    expect(docsProblems("editor/#Timeline", read)).toHaveLength(1);
  });

  it("gives every panel tip a docs value that names a real page and heading", () => {
    for (const [id, entry] of Object.entries(PANEL_HELP) as Array<[string, HelpEntry]>) {
      expect(entry.docs, `PANEL_HELP.${id} has no docs value`).toBeDefined();
      expect(docsProblems(entry.docs ?? "", readDocs), id).toEqual([]);
    }
  });
});

describe("help coverage", () => {
  it("gives every action a name and a sentence saying what it does", () => {
    for (const action of ACTIONS) {
      expect(action.label.trim(), action.id).not.toBe("");
      expect(action.does.trim().length, action.id).toBeGreaterThan(10);
      expect(action.does.trim(), action.id).toMatch(/[.?!]$/);
    }
  });

  it("says why whenever an action can be disabled", () => {
    for (const action of ACTIONS) {
      if (action.enabled === undefined) continue;
      expect(action.whyDisabled, `${action.id} can be disabled but never says why`).toBeDefined();
    }
  });

  it("builds every toolbar and help menu button from an action that exists", () => {
    for (const id of [...TOOLBAR_GROUPS.flat(), ...HELP_MENU]) {
      expect(actionById(id), id).toBeDefined();
    }
  });

  it("starts the help menu with Documentation, an external action, and keeps the others in order", () => {
    // Search actions has its own button beside Help, so the menu does not repeat it (issue #412).
    expect(HELP_MENU).toEqual(["help.docs", "help.tour", "help.fullTour", "help.presets", "help.shortcuts", "help.whatsThis", "help.reportBug"]);
    expect(actionById("help.fullTour")?.label).toBe("Take the full tour");
    expect(actionById("help.docs")?.external).toBe(true);
    expect(actionById("help.docs")?.shortcut).toBeUndefined();
  });

  it("gives every help menu row its own glyph, so the two tours do not look alike", () => {
    const icons = HELP_MENU.map((id) => actionById(id)?.icon);
    expect(new Set(icons).size).toBe(icons.length);
  });

  it("offers Choose a preset… in the help menu and the palette, with no key of its own", () => {
    const action = actionById("help.presets");
    expect(action?.label).toBe("Choose a preset…");
    expect(action?.group).toBe("help");
    expect(action?.shortcut).toBeUndefined();
    expect(action?.keywords).toEqual(expect.arrayContaining(["preset", "basic", "essential", "full"]));
  });

  it("gives every toolbar button with a key its shortcut in the tooltip", () => {
    for (const id of TOOLBAR_GROUPS.flat()) {
      const action = actionById(id);
      if (id.startsWith("tool.") || id === "view.snap" || id === "view.alliance") {
        expect(action?.shortcut, `${id} has no shortcut`).toBeDefined();
      }
    }
  });

  it("has help text for every panel header and inspector section, and uses all of it", () => {
    const used = new Set(
      [...ALL.matchAll(/"((?:section\.)?[a-z]+)"/g)].map((match) => match[1] ?? ""),
    );
    for (const [id, entry] of Object.entries(PANEL_HELP)) {
      expect(entry.title.trim(), id).not.toBe("");
      expect(entry.body.length, id).toBeGreaterThan(20);
      expect(entry.body.length, `${id} is longer than a tooltip should be`).toBeLessThanOrEqual(PANEL_HELP_BODY_CAP);
      expect(used.has(id), `PANEL_HELP.${id} is never shown`).toBe(true);
    }
    for (const match of ALL.matchAll(/help="([a-z.]+)"/g)) {
      expect(Object.keys(PANEL_HELP), `help="${match[1] ?? ""}" has no entry`).toContain(match[1]);
    }
  });

  it("gives every region title a ?", () => {
    // A panel's attributes, up to the start of its children, fit well inside 600 characters.
    for (const at of ALL.matchAll(/<Panel\b/g)) {
      const tag = ALL.slice(at.index, at.index + 600);
      const title = /title="([^"]+)"/.exec(tag)?.[1];
      if (title === undefined) continue;
      expect(tag, `the ${title} panel has no ?`).toMatch(/help="/);
    }
  });

  it("names every insert kind, and describes each one in the description table", () => {
    for (const [kind, entry] of Object.entries(INSERT_KINDS)) {
      expect(entry.title.trim(), kind).not.toBe("");
      expect(DESCRIPTIONS[`insert.${kind}` as DescriptionId].label, kind).toBe(entry.title);
    }
    expect(Object.keys(INSERT_KINDS).sort()).toEqual(
      ["branch", "command", "parallel", "path", "sequence", "transfer", "turn", "wait"].sort(),
    );
  });

  it("explains every finding code, with a fix, including every one the example raises", () => {
    const examples = fileURLToPath(new URL("../../../../examples/starter/autos/", import.meta.url));
    const json = (name: string): unknown => JSON.parse(read(`${examples}${name}`, "utf8"));
    const raised = derive(
      loadAuto(json("collect-and-score.auto.json")),
      loadRobot(json("robot.json")),
      loadField(json("field/biobuzz.field.json")),
      loadWaypoints(json("waypoints.json")),
    ).findings.map((finding) => finding.code);
    expect(raised.length).toBeGreaterThan(0);
    for (const code of new Set([...Object.keys(FINDING_HELP), ...raised])) {
      const help = findingHelp(code);
      expect(help, code).not.toBeNull();
      expect(help?.means.length ?? 0, code).toBeGreaterThan(10);
      expect(help?.fix.length ?? 0, code).toBeGreaterThan(5);
    }
  });

  it("lists every canvas gesture in the overlay", () => {
    expect(canvasHelp()).toHaveLength(CANVAS_HELP.length);
  });

  it("points every tour stop, and every area it keeps clear, at an anchor the shell renders", () => {
    const rendered = (anchor: string): boolean =>
      ALL.includes(`data-tour="${anchor}"`) ||
      ALL.includes(`? "${anchor}"`) ||
      ALL.includes(`tour="${anchor}"`) ||
      ALL.includes(`help="${anchor}"`) ||
      ACTIONS.some((action) => action.id === anchor);
    for (const stop of [...CORE_STOPS, ...FULL_STOPS]) {
      for (const anchor of [...(stop.anchor === null ? [] : [stop.anchor]), ...(stop.keepClear ?? [])]) {
        expect(rendered(anchor), `the ${stop.id} stop points at ${anchor}, which nothing renders`).toBe(true);
      }
    }
  });

  it("teaches the heading arrows, not the retired per-point knob", () => {
    const heading = FULL_STOPS.find((stop) => stop.id === "tool.heading");
    expect(heading?.body).not.toMatch(/knob/i);
    expect(heading?.body).toMatch(/arrow/i);
    expect(heading?.body).toMatch(/Split heading here/);
    expect(heading?.task?.signal).toBe("headingTurned");
    expect(heading?.prepare).toBe("selectPathWithHeadingArrows");
  });

  it("names Full sim in the timeline's help only while that switch is on (issue #207)", () => {
    expect(panelHelp("timeline", true)).toBe(PANEL_HELP.timeline);
    const without = panelHelp("timeline", false);
    expect(without.docs).toBe(PANEL_HELP.timeline.docs);
    expect(without.body).not.toMatch(/full sim/i);
    expect(without.body).toMatch(/Playback is Ideal or Instant sim\.$/);
    expect(panelHelp("steps", false)).toBe(PANEL_HELP.steps);
  });
});

/**
 * The description table (issue #238, UI_GUIDE section 9.13): every entry follows the writing rules,
 * every `describe="…"` in the sources names an entry, and every entry is used.
 */
describe("the description table", () => {
  const entry = (patch: Partial<Description>): Description => ({ label: "Timeout", ...patch });

  it("passes the real tables", () => {
    for (const [id, description] of Object.entries(DESCRIPTIONS)) {
      expect(descriptionProblems(description), id).toEqual([]);
    }
  });

  it("fails a brief of 49 characters and passes one of 48", () => {
    expect(descriptionProblems(entry({ brief: "a".repeat(48) }))).toEqual([]);
    expect(descriptionProblems(entry({ brief: "a".repeat(49) }))).toEqual(["brief is 49 characters, over 48"]);
  });

  it("fails a more of 161 characters and passes one of 160", () => {
    expect(descriptionProblems(entry({ more: "a".repeat(160) }))).toEqual([]);
    expect(descriptionProblems(entry({ more: "a".repeat(161) }))).toEqual(["more is 161 characters, over 160"]);
  });

  it("fails a brief that ends in a full stop, or holds one", () => {
    expect(descriptionProblems(entry({ brief: "Caps the wait." }))).toEqual(["brief has a full stop"]);
    expect(descriptionProblems(entry({ brief: "Caps it. Then stops" }))).toEqual(["brief has a full stop"]);
    expect(descriptionProblems(entry({ brief: "Ends at 1.00 s" }))).toEqual([]);
  });

  it("fails a brief that opens with Click, Drag, Pick, Here or This is", () => {
    for (const opener of ["Click", "Drag", "Pick", "Here", "This is"]) {
      expect(descriptionProblems(entry({ brief: `${opener} the field to set it` })), opener).toEqual([`brief opens with "${opener}"`]);
    }
    expect(descriptionProblems(entry({ brief: "Clicks of the dial" }))).toEqual([]);
  });

  it("fails an empty entry", () => {
    expect(descriptionProblems(entry({}))).toEqual(["has neither a brief nor a more"]);
    expect(descriptionProblems(entry({ brief: " ", more: "" }))).toEqual(["has neither a brief nor a more"]);
  });

  it("fails a brief that holds its own label", () => {
    expect(descriptionProblems(entry({ brief: "The timeout of the step" }))).toEqual(['brief repeats its label "Timeout"']);
  });

  it("makes the hint the brief, as a sentence, then the more", () => {
    expect(descriptionHint(entry({ brief: "Caps the wait", more: "Empty means none." }))).toBe("Caps the wait. Empty means none.");
    expect(descriptionHint(entry({ more: "Empty means none." }))).toBe("Empty means none.");
    expect(descriptionHint(entry({ brief: "Caps the wait" }))).toBe("Caps the wait.");
  });

  it("fails a brief that ends in punctuation, and never doubles the ending in the hint", () => {
    for (const brief of ["Why cap it?", "Cap it!", "Caps the wait:", "Caps, then,", "Caps;"]) {
      expect(descriptionProblems(entry({ brief })), brief).toEqual(["brief ends with punctuation"]);
    }
    expect(descriptionProblems(entry({ brief: "Caps the wait (s)" }))).toEqual([]);
    expect(descriptionHint(entry({ brief: "Why cap it?" }))).toBe("Why cap it?");
    expect(descriptionHint(entry({ brief: "Caps the wait (s)" }))).toBe("Caps the wait (s).");
  });

  it("names an entry wherever a source says describe=, and uses every entry", () => {
    // `describe: "…"` too: a MetaLine detail names its entry as an object key (issue #239).
    const named = [...ALL.matchAll(/describe(?:=(?:\{\s*)?|:\s*)"([a-zA-Z.]+)"/g)].map((match) => match[1] ?? "");
    for (const id of named) expect(Object.keys(DESCRIPTIONS), `describe="${id}" has no entry`).toContain(id);
    // A map that names an entry as a string, such as the Insert menu's, shows it as well.
    for (const id of Object.keys(DESCRIPTIONS)) {
      expect(named.includes(id) || ALL.includes(`"${id}"`), `DESCRIPTIONS["${id}"] is never shown`).toBe(true);
    }
  });
});

/** A new always-visible note that writes a sentence into the source fails (issue #238). */
describe("notes with a literal sentence", () => {
  const filesIn = (dir: string): Array<{ path: string; text: string }> =>
    readdirSync(join(SRC, dir), { withFileTypes: true, recursive: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".tsx"))
      .map((entry) => {
        const full = join(entry.parentPath, entry.name);
        return { path: relative(SRC, full).split(sep).join("/"), text: readFileSync(full, "utf8") };
      });
  const real = NOTE_LITERAL_DIRS.flatMap(filesIn);

  it("passes today's allowlisted sites, and the allowlist is no longer than they are", () => {
    expect(noteLiteralProblems(noteLiteralSites(real))).toEqual([]);
  });

  it("fails a fixture file in panels/ that adds a note with a literal", () => {
    const fixture = { path: "panels/Fixture.tsx", text: "export const F = () => <p className={styles.note}>Some literal</p>;" };
    expect(noteLiteralProblems(noteLiteralSites([...real, fixture]))).toEqual([
      expect.stringContaining("panels/Fixture.tsx has 1 <p className={styles.note}> with a literal sentence, 0 allowed"),
    ]);
  });

  it("fails a literal sentence in a string or a ternary, and passes a value passed in", () => {
    const sites = (text: string) => noteLiteralSites([{ path: "panels/F.tsx", text }]);
    expect(sites('<p className={styles.note} data-testid="x">{"Drag the pin to move it."}</p>')).toEqual({ "panels/F.tsx": 1 });
    expect(sites('<p className={styles.note}>{none ? "None yet, add one." : list}</p>')).toEqual({ "panels/F.tsx": 1 });
    expect(sites("<p className={styles.note} data-testid={testId}>\n  {summary}\n</p>")).toEqual({});
    expect(sites("<p className={styles.error}>Some literal</p>")).toEqual({});
  });

  it("passes a value wrapped in an element, and fails prose beside one", () => {
    const sites = (text: string) => noteLiteralSites([{ path: "panels/F.tsx", text }]);
    expect(sites("<p className={styles.note}><strong>{count}</strong></p>")).toEqual({});
    expect(sites("<p className={styles.note}><span className={styles.value} title={tip}>{count}</span></p>")).toEqual({});
    expect(sites("<p className={styles.note}><strong>{count}</strong> waypoints</p>")).toEqual({ "panels/F.tsx": 1 });
    expect(sites("<p className={styles.note}><strong>Hidden</strong></p>")).toEqual({ "panels/F.tsx": 1 });
  });

  it("fails a one-word sentence in a string, and passes a lowercase key or a value", () => {
    const sites = (text: string) => noteLiteralSites([{ path: "panels/F.tsx", text }]);
    expect(sites('<p className={styles.note}>{hidden ? "Hidden." : list}</p>')).toEqual({ "panels/F.tsx": 1 });
    expect(sites('<p className={styles.note}>{hidden ? "Hidden" : list}</p>')).toEqual({ "panels/F.tsx": 1 });
    expect(sites('<p className={styles.note}>{hidden ? "none" : list}</p>')).toEqual({});
    expect(sites('<p className={styles.note}>{row["name"]}</p>')).toEqual({});
  });
});

/** The sheets and dialogs write only state, a warning or an empty state into an always-visible note (issue #248). */
describe("notes in sheets and dialogs", () => {
  const files = SHEET_NOTE_DIRS.flatMap((dir) =>
    readdirSync(join(SRC, dir), { withFileTypes: true, recursive: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".tsx") && !entry.name.includes(".test."))
      .map((entry) => {
        const full = join(entry.parentPath, entry.name);
        return { path: relative(SRC, full).split(sep).join("/"), text: readFileSync(full, "utf8") };
      }),
  );
  const real = sheetNoteSites(files);

  it("lists every sentence the sheets keep, each as state, a warning or an empty state, and none that is gone", () => {
    expect(sheetNoteProblems(real)).toEqual([]);
    expect(SHEET_NOTE_ALLOWLIST.length).toBeGreaterThan(100);
    for (const entry of SHEET_NOTE_ALLOWLIST) {
      expect(["state", "warn", "empty"], `${entry.file} "${entry.text}"`).toContain(entry.kind);
    }
  });

  it("fails a new explanation in a sheet under every class in PROSE_CLASSES", () => {
    expect(PROSE_CLASSES).toEqual(expect.arrayContaining(["caption", "meta", "itemMeta"]));
    for (const className of PROSE_CLASSES) {
      const fixture = {
        path: "cloud/Fixture.tsx",
        text: `export const F = () => <p className={styles.${className}}>Click the row to edit it.</p>;`,
      };
      expect(sheetNoteProblems(sheetNoteSites([...files, fixture])), className).toEqual([
        expect.stringContaining('cloud/Fixture.tsx writes "Click the row to edit it."'),
      ]);
    }
  });

  it("reads a prose class on any import name and in a plain string class", () => {
    const sites = (path: string, text: string) => sheetNoteSites([{ path, text }]);
    expect(sites("dialogs/SetupDialog.tsx", "<p className={dialogs.prose}>Pick a team first.</p>")).toHaveLength(1);
    expect(sites("account/F.tsx", "<p className={account.hint}>Pick a team first.</p>")).toHaveLength(1);
    expect(sites("settings/AccountPanes.tsx", "<p className={accountStyles.hint}>Explains the device list.</p>")).toHaveLength(1);
    expect(sites("cloud/F.tsx", '<p className="hint">Click the row to edit it.</p>')).toHaveLength(1);
    expect(sites("cloud/F.tsx", '<span className="mono hint">Click the row to edit it.</span>')).toHaveLength(1);
    expect(sites("cloud/F.tsx", '<p className="hinted">Click the row to edit it.</p>')).toEqual([]);
  });

  it("reads settings/, except the styles.note sites the first check counts", () => {
    expect(SHEET_NOTE_DIRS).toContain("settings");
    const sites = (text: string) => sheetNoteSites([{ path: "settings/F.tsx", text }]);
    expect(sites("<p className={styles.note}>Some literal sentence here.</p>")).toEqual([]);
    expect(sites("<p className={styles.hint}>Some literal sentence here.</p>")).toHaveLength(1);
    expect(sheetNoteSites([{ path: "cloud/F.tsx", text: "<p className={styles.note}>Some literal sentence here.</p>" }])).toHaveLength(1);
  });

  it("fails a sentence that only starts like a listed one, and a second copy of a listed one", () => {
    const listed: SheetNoteSite[] = [{ file: "account/TeamsSheet.tsx", kind: "empty", text: "No invites yet." }];
    const site = (text: string) => ({ file: "account/TeamsSheet.tsx", text });
    expect(sheetNoteProblems([site("No invites yet.")], listed)).toEqual([]);
    expect(sheetNoteProblems([site("No invites yet. Invites are made from the team's settings.")], listed)).toEqual([
      expect.stringContaining("writes"),
      expect.stringContaining("no longer has"),
    ]);
    expect(sheetNoteProblems([site("No invites yet."), site("No invites yet.")], listed)).toEqual([expect.stringContaining("writes")]);
  });

  it("reads a sentence in a span, in a template or in a ternary, and not a value passed in", () => {
    const sites = (text: string) => sheetNoteSites([{ path: "cloud/F.tsx", text }]);
    expect(sites("<span className={styles.hint}>Drag the pin to move it.</span>")).toHaveLength(1);
    expect(sites("<p className={`${styles.row} ${styles.prose}`}>Showing shares of one auto.</p>")).toHaveLength(1);
    expect(sites('<p className={styles.hint} onClick={() => go()}>{ok ? "Pick a team to see it." : list}</p>')).toHaveLength(1);
    expect(sites("<p className={styles.hint} data-testid={id}>{summary}</p>")).toEqual([]);
    expect(sites("<p className={styles.error}>Some literal sentence here.</p>")).toEqual([]);
  });

  it("fails an allowed sentence that is no longer in its file", () => {
    const stale: SheetNoteSite[] = [
      ...SHEET_NOTE_ALLOWLIST,
      { file: "cloud/ShareSheet.tsx", kind: "state", text: "A sentence that was deleted" },
    ];
    expect(sheetNoteProblems(real, stale)).toEqual([expect.stringContaining("no longer has")]);
  });
});
