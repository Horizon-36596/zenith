/**
 * The shortcut sheet and the keyboard handler read one table (QA-13), so every key the sheet lists
 * runs what the sheet says, and no two actions claim the same key. The person's own keys
 * are resolved over that table, and the checks that keep them sound are here too.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ALL_FEATURES, NO_FEATURES, actionShown, setFeatures } from "../state/features";
import { setSetting } from "../state/store";
import { ACTIONS, actionById, pageShortcutOf, shortcutOf, type ActionDef } from "./actions";
import {
  BINDINGS,
  EXTRA_BINDABLE,
  KEY_BINDINGS,
  KEY_ONLY,
  RESERVED_CHORDS,
  UPDATE_DESKTOP_NOTE,
  actionForKey,
  bindingsOf,
  assignKey,
  chordOfEvent,
  chordsFor,
  chordsOverlap,
  fieldKeepsChord,
  isCustomKey,
  keyBindingForKey,
  keysLeftAfterMove,
  normalizeKeys,
  overlappingBindings,
  parseShortcut,
  resolveKeymap,
  validateBinding,
  worstCaseKeys,
  writeChord,
  type Binding,
  type KeyChord,
  type KeyLike,
  type Keymap,
} from "./keymap";
import { SHORTCUTS, keyLabel } from "./shortcuts";

/** The keystroke a chord describes, as a browser would report it. */
const press = (chord: KeyChord): KeyLike => ({
  key: chord.key.length === 1 && chord.shift === true ? chord.key.toUpperCase() : chord.key,
  ctrlKey: chord.ctrl,
  metaKey: false,
  shiftKey: chord.shift === true,
  altKey: chord.alt,
});

const key = (key: string, mods: Partial<KeyLike> = {}): KeyLike => ({
  key,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  ...mods,
});

describe("the keymap", () => {
  // Every feature on, so every action is on show; the switches' own test is below.
  beforeEach(() => {
    setFeatures(ALL_FEATURES);
  });
  afterEach(() => {
    setFeatures(NO_FEATURES);
  });

  it("leaves the keys of a feature that is switched off doing nothing", () => {
    setFeatures(NO_FEATURES);
    expect(actionForKey(key("c"))).toBeUndefined();
    expect(actionForKey(key("p"))?.id).toBe("tool.addPath");
    setFeatures(ALL_FEATURES);
    expect(actionForKey(key("c"))?.id).toBe("tool.addCommand");
  });

  it("runs every action the sheet lists from the keys the sheet shows for it", () => {
    for (const action of ACTIONS) {
      const written = shortcutOf(action);
      if (written === undefined) continue;
      const chords = parseShortcut(written);
      expect(chords.length, `${action.id}: "${written}" names no key`).toBeGreaterThan(0);
      for (const chord of chords) {
        expect(actionForKey(press(chord))?.id, `${written} runs ${action.id}`).toBe(action.id);
      }
    }
  });

  it("gives no two actions the same key", () => {
    const seen = new Map<string, string>();
    for (const action of ACTIONS) {
      for (const chord of chordsFor(action)) {
        const id = JSON.stringify(chord);
        expect(seen.get(id), `${action.id} and ${seen.get(id) ?? ""} share ${id}`).toBeUndefined();
        seen.set(id, action.id);
      }
    }
  });

  it("lists every shortcut in the table, on an action or as a key of its own", () => {
    const shown = new Set([
      ...ACTIONS.map((action) => shortcutOf(action)).filter((keys): keys is string => keys !== undefined),
      ...KEY_ONLY.map((row) => row.keys),
    ]);
    for (const [id, keys] of Object.entries(SHORTCUTS)) {
      expect(shown.has(keys), `${id} (${keys}) is on the sheet`).toBe(true);
    }
  });

  it("runs Propose from Ctrl Shift Enter, and Insert only from a plain Enter", () => {
    expect(actionForKey(key("Enter", { ctrlKey: true, shiftKey: true }))?.id).toBe("run.propose");
    expect(actionForKey(key("Enter"))?.id).toBe("insert.menu");
    expect(actionForKey(key("Enter", { shiftKey: true }))).toBeUndefined();
  });

  it("leaves browser chords alone: Ctrl C, A, V, R and P run nothing", () => {
    for (const letter of ["c", "a", "v", "r", "p"]) {
      expect(actionForKey(key(letter, { ctrlKey: true })), `Ctrl ${letter}`).toBeUndefined();
      expect(actionForKey(key(letter, { metaKey: true })), `Cmd ${letter}`).toBeUndefined();
    }
  });

  it("takes a plain letter with or without Shift, and a chord only exactly", () => {
    expect(actionForKey(key("V", { shiftKey: true }))?.id).toBe("tool.select");
    expect(actionForKey(key("z", { ctrlKey: true }))?.id).toBe("edit.undo");
    expect(actionForKey(key("Z", { ctrlKey: true, shiftKey: true }))?.id).toBe("edit.redo");
    expect(actionForKey(key("?", { shiftKey: true }))?.id).toBe("help.shortcuts");
    expect(actionForKey(key("Backspace"))?.id).toBe("edit.delete");
  });

  it("opens What's this from Shift F1 and keeps a plain F1 for the shortcut sheet", () => {
    expect(actionForKey(key("F1", { shiftKey: true }))?.id).toBe("help.whatsThis");
    expect(actionForKey(key("F1"))?.id).toBe("help.shortcuts");
  });

  it("leaves Ctrl Z, Ctrl Y and Ctrl D to a text field, but runs undo and redo from a select", () => {
    for (const tag of ["INPUT", "TEXTAREA", "DIV"]) {
      expect(fieldKeepsChord("edit.undo", tag), tag).toBe(true);
      expect(fieldKeepsChord("edit.redo", tag), tag).toBe(true);
      expect(fieldKeepsChord("edit.duplicate", tag), tag).toBe(true);
    }
    // A select has no undo of its own, so a pick in one is undone in the routine (issue #144).
    expect(fieldKeepsChord("edit.undo", "SELECT")).toBe(false);
    expect(fieldKeepsChord("edit.redo", "SELECT")).toBe(false);
    expect(fieldKeepsChord("edit.duplicate", "SELECT")).toBe(true);
    // A chord that does not edit the document runs from any field.
    expect(fieldKeepsChord("run.save", "INPUT")).toBe(false);
    expect(fieldKeepsChord("run.save", "SELECT")).toBe(false);
  });
});

/** One chord from one written key. */
const chord = (text: string): KeyChord => {
  const [first] = parseShortcut(text);
  if (first === undefined) throw new Error(`${text} names no key`);
  return first;
};

const DEFAULTS = resolveKeymap(BINDINGS, {});

/** Every pair of bindings in a resolved keymap whose chords overlap. */
function overlaps(keymap: Keymap): string[] {
  const found: string[] = [];
  const all = [...keymap.bindings.values()];
  for (const [index, one] of all.entries()) {
    for (const other of all.slice(index + 1)) {
      if (one.chords.some((a) => other.chords.some((b) => chordsOverlap(a, b)))) found.push(`${one.id} and ${other.id}`);
    }
  }
  return found;
}

describe("custom keys", () => {
  beforeEach(() => {
    setFeatures(ALL_FEATURES);
  });
  afterEach(() => {
    setSetting("keys.bindings", {});
    setFeatures(NO_FEATURES);
  });

  it("has no overlap in the defaults, aliases included", () => {
    expect(overlaps(DEFAULTS)).toEqual([]);
    expect(DEFAULTS.displaced).toEqual([]);
  });

  it("binds every action with a key, and the curated extras that exist", () => {
    const ids = BINDINGS.map((binding) => binding.id);
    for (const action of ACTIONS) if (action.shortcut !== undefined) expect(ids, action.id).toContain(action.id);
    for (const id of EXTRA_BINDABLE) expect(ids.includes(id), id).toBe(actionById(id) !== undefined);
    expect(BINDINGS.find((binding) => binding.id === "view.play")?.fixed).toBeDefined();
    expect(BINDINGS.find((binding) => binding.id === "insert.menu")?.fixed).toBeDefined();
  });

  it("finds overlap, not string equality: Shift H overlaps H, and a chord is exact", () => {
    expect(chordsOverlap(chord("Shift H"), chord("H"))).toBe(true);
    expect(chordsOverlap(chord("H"), chord("Shift H"))).toBe(true);
    expect(chordsOverlap(chord("Ctrl H"), chord("H"))).toBe(false);
    expect(chordsOverlap(chord("Ctrl Shift Z"), chord("Ctrl Z"))).toBe(false);
    expect(validateBinding("run.validate", "Shift H", DEFAULTS)).toEqual({ kind: "conflict", keys: "Shift H", other: "tool.heading" });
  });

  it("refuses every reserved chord, with a reason", () => {
    for (const entry of RESERVED_CHORDS) {
      const check = validateBinding("run.validate", entry.keys, DEFAULTS);
      expect(check.kind, entry.keys).toBe("refused");
      expect(check.kind === "refused" && check.reason.length > 0, entry.keys).toBe(true);
    }
    // Ctrl Shift - arrives as Ctrl _, which zooms out as Ctrl - does, so capture refuses it too.
    const zoomOut = chordOfEvent({ key: "_", ctrlKey: true, metaKey: false, shiftKey: true, altKey: false });
    expect(zoomOut !== "modifier" && zoomOut !== undefined && writeChord(zoomOut)).toBe("Ctrl _");
    expect(validateBinding("run.validate", "Ctrl _", DEFAULTS)).toEqual({ kind: "refused", reason: "The browser zooms out with it." });
    // Ctrl means Cmd on a Mac, so a Cmd chord is written, and refused, as its Ctrl twin is.
    const cmdW = chordOfEvent({ key: "w", ctrlKey: false, metaKey: true, shiftKey: false, altKey: false });
    expect(cmdW !== "modifier" && cmdW !== undefined && writeChord(cmdW)).toBe("Ctrl W");
  });

  it("refuses the fixed keys, a modifier alone, and the desktop keys even in the browser", () => {
    // R, comma, full stop and F6 are bindings of their own now (issue #290), so they are a conflict, below.
    const fixed = ["Esc", "Tab", "Shift Tab", "←", "Alt ↑", "Space", "Enter", "F10", "Shift F10", "Ctrl F5", "Ctrl Shift D", "Ctrl Shift G", "Control"];
    for (const keys of fixed) expect(validateBinding("run.validate", keys, DEFAULTS).kind, keys).toBe("refused");
    expect(validateBinding("view.play", "Ctrl P", DEFAULTS).kind, "Play is fixed").toBe("refused");
    expect(validateBinding("run.validate", "Alt F", DEFAULTS).kind).toBe("ok");
    expect(validateBinding("run.validate", "Alt F", DEFAULTS, BINDINGS, { desktop: true }).kind, "a desktop menu letter").toBe("refused");
    expect(validateBinding("run.validate", "Ctrl Enter", DEFAULTS).kind).toBe("ok");
    // Ctrl and Alt together are AltGr on many layouts, which types characters.
    expect(validateBinding("run.validate", "Ctrl Alt E", DEFAULTS)).toMatchObject({ kind: "refused", reason: expect.stringContaining("AltGr") });
    expect(chordOfEvent({ key: "Shift", ctrlKey: false, metaKey: false, shiftKey: true, altKey: false })).toBe("modifier");
  });

  it("counts a hidden action's key as a conflict", () => {
    setFeatures(NO_FEATURES);
    expect(actionShown("tool.addCommand", NO_FEATURES)).toBe(false);
    expect(actionForKey(key("c")), "C runs nothing while Commands is off").toBeUndefined();
    expect(validateBinding("run.validate", "C", resolveKeymap(BINDINGS, {}))).toEqual({ kind: "conflict", keys: "C", other: "tool.addCommand" });
  });

  it("displaces a new default that collides with a custom key, and never overwrites the custom key", () => {
    const later: Binding[] = [...BINDINGS, { id: "later.action", group: "run", label: "Later", does: "Added later.", keys: "Ctrl E", aliases: [] }];
    const overrides = { "run.validate": "Ctrl E" };
    const keymap = resolveKeymap(later, overrides);
    expect(keymap.bindings.get("run.validate")).toMatchObject({ keys: "Ctrl E", custom: true });
    expect(keymap.bindings.get("later.action")).toMatchObject({ keys: undefined, custom: false, chords: [] });
    expect(keymap.displaced).toEqual(["later.action"]);
    expect(overrides).toEqual({ "run.validate": "Ctrl E" });
    expect(overlaps(keymap)).toEqual([]);
  });

  it("keeps the stored keymap free of overlaps, whatever is moved where", () => {
    let overrides = assignKey(BINDINGS, {}, "run.validate", "Ctrl E");
    expect(overrides).toEqual({ "run.validate": "Ctrl E" });
    // Ctrl E moves to Simulate, so Validate has no key, not two bindings on one key.
    overrides = assignKey(BINDINGS, overrides, "run.simulate", "Ctrl E");
    expect(overrides).toEqual({ "run.validate": null, "run.simulate": "Ctrl E" });
    overrides = assignKey(BINDINGS, overrides, "run.save", "F8");
    // F1 moves from the sheet's "? or F1": the sheet keeps ?.
    expect(keysLeftAfterMove(resolveKeymap(BINDINGS, overrides), "help.shortcuts", "F1")).toBe("?");
    overrides = assignKey(BINDINGS, overrides, "edit.undo", "F1");
    // V, the Select tool's only key, moves: Select is left with no key on purpose, not displaced.
    overrides = assignKey(BINDINGS, overrides, "run.propose", "V");
    expect(overrides["tool.select"]).toBeNull();
    // Reset gives Validate F8 back, and takes it from Save.
    overrides = assignKey(BINDINGS, overrides, "run.validate", undefined);
    expect(overrides["run.save"]).toBeNull();
    const keymap = resolveKeymap(BINDINGS, overrides);
    expect(overlaps(keymap)).toEqual([]);
    expect(keymap.displaced).toEqual([]);
    expect(keymap.bindings.get("help.shortcuts")?.keys).toBe("?");
    expect(keymap.bindings.get("run.validate")).toMatchObject({ keys: "F8", custom: false });
  });

  it("gives no key, not a displacement, to a default whose last alternative moves after another went custom", () => {
    // ? goes to Switch theme first, so the sheet keeps only F1; then F1 moves too.
    let overrides = assignKey(BINDINGS, {}, "view.theme", "?");
    expect(overrides).toEqual({ "view.theme": "?" });
    expect(keysLeftAfterMove(resolveKeymap(BINDINGS, overrides), "help.shortcuts", "F1")).toBeUndefined();
    overrides = assignKey(BINDINGS, overrides, "view.clipGhosts", "F1");
    expect(overrides).toEqual({ "view.theme": "?", "view.clipGhosts": "F1", "help.shortcuts": null });
    const keymap = resolveKeymap(BINDINGS, overrides);
    expect(keymap.displaced).toEqual([]);
    expect(keymap.bindings.get("help.shortcuts")).toMatchObject({ keys: undefined, custom: true });
    expect(overlaps(keymap)).toEqual([]);
  });

  it("names every binding a Reset takes from, when the default overlaps two of the person's keys", () => {
    let overrides = assignKey(BINDINGS, {}, "view.theme", "?");
    overrides = assignKey(BINDINGS, overrides, "view.clipGhosts", "F1");
    const keymap = resolveKeymap(BINDINGS, overrides);
    // Reset gives the sheet "? or F1" back, which takes ? from Switch theme and F1 from Clip ghosts.
    expect([...overlappingBindings(keymap, "help.shortcuts", "? or F1")].sort()).toEqual(["view.clipGhosts", "view.theme"]);
    const after = assignKey(BINDINGS, overrides, "help.shortcuts", undefined);
    expect(after).toEqual({ "view.theme": null, "view.clipGhosts": null });
    expect(overlappingBindings(keymap, "view.theme", "?")).toEqual([]);
  });

  it("counts Turn's Shift twin when Turn takes a named key, in the Move it here line and the bindings it names", () => {
    // Turn on F1 runs on F1 and Shift F1, so it takes the sheet's F1 and What's this's Shift F1.
    expect(keysLeftAfterMove(DEFAULTS, "help.shortcuts", "F1", "keys.rotate")).toBe("?");
    expect(keysLeftAfterMove(DEFAULTS, "help.whatsThis", "F1", "keys.rotate")).toBeUndefined();
    // Without the mover, F1 is only F1, and What's this would seem to keep Shift F1.
    expect(keysLeftAfterMove(DEFAULTS, "help.whatsThis", "F1")).toBe("Shift F1");
    expect([...overlappingBindings(DEFAULTS, "keys.rotate", "F1")].sort()).toEqual(["help.shortcuts", "help.whatsThis"]);
    expect(overlappingBindings(DEFAULTS, "run.validate", "F1")).toEqual(["help.shortcuts"]);
    // And Move it here takes both, as the line says.
    const overrides = assignKey(BINDINGS, {}, "keys.rotate", "F1");
    const keymap = resolveKeymap(BINDINGS, overrides);
    expect(keymap.bindings.get("help.shortcuts")?.keys).toBe("?");
    expect(keymap.bindings.get("help.whatsThis")?.keys).toBeUndefined();
    expect(overlaps(keymap)).toEqual([]);
  });

  it("leaves a default displaced before a move displaced, so its upgrade note still shows", () => {
    const later: Binding[] = [...BINDINGS, { id: "later.action", group: "run", label: "Later", does: "Added later.", keys: "Ctrl E", aliases: [] }];
    const overrides = assignKey(later, { "run.validate": "Ctrl E" }, "run.save", "F9");
    expect(overrides).toEqual({ "run.validate": "Ctrl E", "run.save": "F9" });
    expect(resolveKeymap(later, overrides).displaced).toEqual(["later.action"]);
  });

  it("ignores a stored key no one may use, and the second of two overlapping ones", () => {
    const keymap = resolveKeymap(BINDINGS, {
      "run.validate": "Ctrl W",
      "run.simulate": "Ctrl B",
      "run.save": "Ctrl B",
      "view.play": "P",
      nonsense: "F9",
      "edit.undo": "Ctrl Ctrl",
    });
    expect(keymap.bindings.get("run.validate")).toMatchObject({ keys: "F8", custom: false });
    expect(keymap.bindings.get("run.simulate")).toMatchObject({ keys: "Ctrl B", custom: true });
    expect(keymap.bindings.get("run.save")).toMatchObject({ keys: "Ctrl S", custom: false });
    expect(keymap.bindings.get("view.play")?.keys).toBe("Space");
    expect(keymap.bindings.get("edit.undo")?.keys).toBe("Ctrl Z");
    expect(keymap.bindings.has("nonsense")).toBe(false);
    expect(overlaps(keymap)).toEqual([]);
  });

  it("runs Validate from Ctrl E once it is rebound, and F8 then runs nothing", () => {
    setSetting("keys.bindings", { "run.validate": "Ctrl E" });
    expect(actionForKey(key("e", { ctrlKey: true }))?.id).toBe("run.validate");
    expect(actionForKey(key("e", { metaKey: true }))?.id).toBe("run.validate");
    expect(actionForKey(key("F8"))).toBeUndefined();
    expect(keyLabel("validate")).toBe("Ctrl E");
    const validate = actionById("run.validate");
    expect(validate === undefined ? undefined : pageShortcutOf(validate)).toBe("Ctrl E");
  });

  it("never lets a Ctrl chord with a custom binding fall through to a plain key (QA-14)", () => {
    setSetting("keys.bindings", { "tool.select": "Ctrl B", "run.validate": "E" });
    expect(actionForKey(key("b", { ctrlKey: true }))?.id).toBe("tool.select");
    expect(actionForKey(key("b")), "plain B is not Ctrl B").toBeUndefined();
    expect(actionForKey(key("v")), "V is no longer Select").toBeUndefined();
    expect(actionForKey(key("v", { ctrlKey: true }))).toBeUndefined();
    expect(actionForKey(key("e", { ctrlKey: true })), "Ctrl E is not the plain E").toBeUndefined();
    expect(actionForKey(key("E", { shiftKey: true }))?.id, "a plain letter, with or without Shift").toBe("run.validate");
  });

  it("leaves an action whose key was removed off the keys and the tooltips", () => {
    setSetting("keys.bindings", { "edit.undo": null });
    expect(keyLabel("undo")).toBeUndefined();
    expect(actionForKey(key("z", { ctrlKey: true }))).toBeUndefined();
    // The redo alias stays while redo has its default key, and goes with it.
    expect(actionForKey(key("Z", { ctrlKey: true, shiftKey: true }))?.id).toBe("edit.redo");
    setSetting("keys.bindings", { "edit.redo": "Ctrl Shift Y" });
    expect(actionForKey(key("Z", { ctrlKey: true, shiftKey: true }))).toBeUndefined();
    const redo = actionById("edit.redo");
    expect(redo === undefined ? 0 : chordsFor(redo).length).toBe(1);
  });

  it("writes a keystroke the way the table does, and reads it back", () => {
    const write = (event: Partial<KeyLike> & { key: string }): string | undefined => {
      const made = chordOfEvent({ ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...event });
      return made === undefined || made === "modifier" ? undefined : writeChord(made);
    };
    expect(write({ key: "E", ctrlKey: true, shiftKey: true })).toBe("Ctrl Shift E");
    expect(write({ key: "e" })).toBe("E");
    expect(write({ key: "E", shiftKey: true }), "Shift is part of a chord with a letter").toBe("Shift E");
    expect(write({ key: "?", shiftKey: true })).toBe("?");
    expect(write({ key: "Backspace" })).toBe("Del");
    expect(write({ key: "+", ctrlKey: true })).toBe("Ctrl Plus");
    expect(write({ key: "PageDown", ctrlKey: true, shiftKey: true })).toBe("Ctrl Shift PgDn");
    expect(write({ key: "Insert", altKey: true })).toBe("Alt Ins");
    expect(write({ key: "Dead" })).toBeUndefined();
    expect(normalizeKeys("Ctrl e")).toBe("Ctrl E");
    expect(normalizeKeys("Shift Ctrl E")).toBe("Ctrl Shift E");
    expect(normalizeKeys("Ctrl Foo")).toBeUndefined();
    expect(normalizeKeys("? or F1")).toBeUndefined();
  });

  it("builds a worst case that binds every rebindable action to a long, legal, distinct key", () => {
    const keys = worstCaseKeys(BINDINGS);
    const rebindable = BINDINGS.filter((binding) => binding.fixed === undefined);
    expect(Object.keys(keys).sort()).toEqual(rebindable.map((binding) => binding.id).sort());
    for (const [id, written] of Object.entries(keys)) {
      expect(written !== null && validateBinding(id, written, DEFAULTS).kind !== "refused", `${id} ${String(written)}`).toBe(true);
    }
    const keymap = resolveKeymap(BINDINGS, keys);
    expect(overlaps(keymap)).toEqual([]);
    for (const binding of rebindable) expect(keymap.bindings.get(binding.id), binding.id).toMatchObject({ custom: true, keys: keys[binding.id] });
    // No label is longer than Ctrl Shift Enter, a default today.
    expect(Math.max(...Object.values(keys).map((written) => String(written).length))).toBe("Ctrl Shift Enter".length);
  });
});

describe("the turn, step and next-panel keys as bindings (issue #290)", () => {
  beforeEach(() => {
    setFeatures(ALL_FEATURES);
  });
  afterEach(() => {
    setSetting("keys.bindings", {});
    setFeatures(NO_FEATURES);
  });

  it("are bindings with today's keys, none of them fixed", () => {
    for (const [id, keys] of [
      ["keys.rotate", "R"],
      ["keys.stepBack", ","],
      ["keys.stepForward", "."],
      ["keys.cycleRegion", "F6"],
    ] as const) {
      const binding = BINDINGS.find((one) => one.id === id);
      expect(binding, id).toMatchObject({ keys, group: "keys" });
      expect(binding?.fixed, id).toBeUndefined();
      expect(KEY_BINDINGS.some((one) => one.id === id), id).toBe(true);
    }
  });

  it("match their default keys, R with or without Shift, and nothing with Ctrl or Alt (QA-14)", () => {
    expect(keyBindingForKey(key("r"))).toBe("keys.rotate");
    expect(keyBindingForKey(key("R", { shiftKey: true }))).toBe("keys.rotate");
    expect(keyBindingForKey(key(","))).toBe("keys.stepBack");
    expect(keyBindingForKey(key("."))).toBe("keys.stepForward");
    expect(keyBindingForKey(key("F6"))).toBe("keys.cycleRegion");
    expect(keyBindingForKey(key("r", { ctrlKey: true })), "Ctrl R").toBeUndefined();
    expect(keyBindingForKey(key("r", { altKey: true })), "Alt R").toBeUndefined();
    expect(keyBindingForKey(key(",", { ctrlKey: true })), "Ctrl comma is Settings").toBeUndefined();
    expect(actionForKey(key(",", { ctrlKey: true }))?.id).toBe("view.settings");
    expect(keyBindingForKey(key("F6", { shiftKey: true })), "Shift F6").toBeUndefined();
  });

  it("show the keys the sheet and the tooltips always showed", () => {
    expect(keyLabel("rotate")).toBe("R / Shift R");
    expect(keyLabel("stepTime")).toBe(", .");
    expect(keyLabel("cycleRegion")).toBe("F6");
  });

  it("turn from T and Shift T once Turn is T, and R then turns nothing", () => {
    setSetting("keys.bindings", { "keys.rotate": "T" });
    expect(keyBindingForKey(key("t"))).toBe("keys.rotate");
    expect(keyBindingForKey(key("T", { shiftKey: true }))).toBe("keys.rotate");
    expect(keyBindingForKey(key("r"))).toBeUndefined();
    expect(keyBindingForKey(key("R", { shiftKey: true }))).toBeUndefined();
    expect(keyBindingForKey(key("t", { ctrlKey: true })), "Ctrl T is not the plain T").toBeUndefined();
    expect(keyLabel("rotate")).toBe("T / Shift T");
    expect(isCustomKey("keys.rotate")).toBe(true);
  });

  it("keep Shift for the other way: Turn takes its key without Shift, and covers the Shift twin", () => {
    expect(validateBinding("keys.rotate", "Shift T", DEFAULTS)).toEqual({ kind: "ok", keys: "T" });
    expect(validateBinding("keys.rotate", "Alt Shift T", DEFAULTS)).toEqual({ kind: "ok", keys: "Alt T" });
    expect(validateBinding("keys.rotate", "F7", DEFAULTS)).toEqual({ kind: "ok", keys: "F7" });
    // Shift H is the Heading tool's too, since a plain letter covers itself with Shift.
    expect(validateBinding("keys.rotate", "Shift H", DEFAULTS)).toEqual({ kind: "conflict", keys: "H", other: "tool.heading" });
    // Ctrl T and Ctrl Shift T are the browser's; Turn would take both.
    expect(validateBinding("keys.rotate", "Ctrl T", DEFAULTS).kind).toBe("refused");
    // Shift turns a digit or a punctuation key into another character, so its other way would never arrive.
    for (const keys of ["1", ";", "Alt /"]) {
      expect(validateBinding("keys.rotate", keys, DEFAULTS), keys).toMatchObject({ kind: "refused", reason: expect.stringContaining("Shift") });
    }
    // A stored Turn key with Shift in it is read as the key without it.
    const keymap = resolveKeymap(BINDINGS, { "keys.rotate": "Alt Shift T" });
    expect(keymap.bindings.get("keys.rotate")).toMatchObject({ keys: "Alt T", custom: true });
    expect(keymap.bindings.get("keys.rotate")?.chords.every((one) => one.shift === "any")).toBe(true);
    // Another binding's Alt Shift T would run with Turn's Alt T held with Shift, so it is Turn's.
    setSetting("keys.bindings", { "keys.rotate": "Alt T" });
    expect(validateBinding("run.validate", "Alt Shift T", resolveKeymap(BINDINGS, { "keys.rotate": "Alt T" }))).toEqual({
      kind: "conflict",
      keys: "Alt Shift T",
      other: "keys.rotate",
    });
    expect(keyLabel("rotate")).toBe("Alt T / Alt Shift T");
  });

  it("are a conflict, not a refusal, when another action takes R, a comma, a full stop or F6", () => {
    expect(validateBinding("run.validate", "R", DEFAULTS)).toEqual({ kind: "conflict", keys: "R", other: "keys.rotate" });
    expect(validateBinding("run.validate", "Shift R", DEFAULTS)).toEqual({ kind: "conflict", keys: "Shift R", other: "keys.rotate" });
    expect(validateBinding("run.validate", ",", DEFAULTS)).toEqual({ kind: "conflict", keys: ",", other: "keys.stepBack" });
    expect(validateBinding("run.validate", ".", DEFAULTS)).toEqual({ kind: "conflict", keys: ".", other: "keys.stepForward" });
    expect(validateBinding("run.validate", "F6", DEFAULTS)).toEqual({ kind: "conflict", keys: "F6", other: "keys.cycleRegion" });
    // Moving F6 to Validate leaves Next panel with no key, never two bindings on F6.
    const overrides = assignKey(BINDINGS, {}, "run.validate", "F6");
    expect(overrides).toEqual({ "run.validate": "F6", "keys.cycleRegion": null });
    expect(overlaps(resolveKeymap(BINDINGS, overrides))).toEqual([]);
  });

  it("step the playhead from their new keys, and chords never fall through to the plain key (QA-14)", () => {
    setSetting("keys.bindings", { "keys.stepBack": "Alt J", "keys.stepForward": "L", "keys.cycleRegion": "F7" });
    expect(keyBindingForKey(key("j", { altKey: true }))).toBe("keys.stepBack");
    expect(keyBindingForKey(key("j")), "plain J is not Alt J").toBeUndefined();
    expect(keyBindingForKey(key(","))).toBeUndefined();
    expect(keyBindingForKey(key("l"))).toBe("keys.stepForward");
    expect(keyBindingForKey(key("l", { ctrlKey: true })), "Ctrl L").toBeUndefined();
    expect(keyBindingForKey(key("."))).toBeUndefined();
    expect(keyBindingForKey(key("F7"))).toBe("keys.cycleRegion");
    expect(keyBindingForKey(key("F6"))).toBeUndefined();
    expect(keyLabel("stepTime")).toBe("Alt J L");
    expect(keyLabel("cycleRegion")).toBe("F7");
  });

  it("name the person's Turn key in the Heading binding's text, read each time and never the copy from load", () => {
    const heading = () => BINDINGS.find((one) => one.id === "tool.heading")?.does ?? "";
    expect(heading()).toContain("R and Shift R turn the selected point 5°.");
    setSetting("keys.bindings", { "keys.rotate": "T" });
    expect(heading()).toContain("T and Shift T turn the selected point 5°.");
    expect(heading()).not.toContain("R and Shift R");
    setSetting("keys.bindings", { "keys.rotate": null });
    expect(heading()).not.toContain("turn the selected point");
  });

  it("leave the label of a half that has no key out, and have none when neither has", () => {
    setSetting("keys.bindings", { "keys.stepBack": null });
    expect(keyLabel("stepTime")).toBe(".");
    setSetting("keys.bindings", { "keys.stepBack": null, "keys.stepForward": null, "keys.rotate": null });
    expect(keyLabel("stepTime")).toBeUndefined();
    expect(keyLabel("rotate")).toBeUndefined();
    expect(keyBindingForKey(key("r"))).toBeUndefined();
  });
});

describe("the desktop menu's keys as bindings", () => {
  const validate = actionById("run.validate");
  if (validate === undefined) throw new Error("run.validate is missing");
  const { shortcut: _shortcut, ...base } = validate;
  const desktop = (id: string, menuShortcut: string): ActionDef => ({ ...base, id, label: id, does: id, menuShortcut });
  const robotActions = [desktop("desktop.sim", "Ctrl F5"), desktop("desktop.deploy", "Ctrl Shift D"), desktop("desktop.git", "Ctrl Shift G")];
  const bindings = [...BINDINGS, ...bindingsOf(robotActions, true)];
  const fixedBindings = [...BINDINGS, ...bindingsOf(robotActions, false)];

  it("have their menu default and are fixed, with the update note, in a desktop app that cannot take menu keys", () => {
    const sim = bindingsOf(robotActions, true).find((binding) => binding.id === "desktop.sim");
    expect(sim).toMatchObject({ keys: "Ctrl F5", desktop: true });
    expect(sim?.fixed).toBeUndefined();
    for (const binding of bindingsOf(robotActions, false)) expect(binding).toMatchObject({ desktop: true, fixed: UPDATE_DESKTOP_NOTE });
    // The note is the spec's sentence.
    expect(UPDATE_DESKTOP_NOTE).toBe("Update the desktop app to change these.");
  });

  it("take a new key, so the menu can run on Ctrl Shift F5 instead of Ctrl F5", () => {
    expect(validateBinding("desktop.sim", "Ctrl Shift F5", resolveKeymap(bindings, {}), bindings)).toEqual({ kind: "ok", keys: "Ctrl Shift F5" });
    const overrides = assignKey(bindings, {}, "desktop.sim", "Ctrl Shift F5");
    expect(overrides).toEqual({ "desktop.sim": "Ctrl Shift F5" });
    const keymap = resolveKeymap(bindings, overrides);
    expect(keymap.bindings.get("desktop.sim")).toMatchObject({ keys: "Ctrl Shift F5", custom: true });
    expect(overlaps(keymap)).toEqual([]);
  });

  it("keep their default key to themselves in the page, and give Ctrl F5 to no page action", () => {
    expect(validateBinding("run.validate", "Ctrl F5", resolveKeymap(bindings, {}), bindings).kind).toBe("refused");
    // Its own default is not refused as "the desktop app's key", so Reset works.
    expect(validateBinding("desktop.sim", "Ctrl F5", resolveKeymap(bindings, { "desktop.sim": "Ctrl Shift F5" }), bindings)).toEqual({ kind: "ok", keys: "Ctrl F5" });
  });

  it("refuse the Robot keys the menu has now, so a key Simulate moved off is free for a page action", () => {
    const moved = { "desktop.sim": "Ctrl Shift F5" };
    const keymap = resolveKeymap(bindings, moved);
    expect(validateBinding("run.validate", "Ctrl F5", keymap, bindings)).toEqual({ kind: "ok", keys: "Ctrl F5" });
    expect(validateBinding("run.validate", "Ctrl Shift F5", keymap, bindings)).toEqual({ kind: "refused", reason: "The desktop app's Robot menu uses it." });
    const overrides = assignKey(bindings, moved, "run.validate", "Ctrl F5");
    expect(overrides).toEqual({ "desktop.sim": "Ctrl Shift F5", "run.validate": "Ctrl F5" });
    expect(resolveKeymap(bindings, overrides).bindings.get("run.validate")).toMatchObject({ keys: "Ctrl F5", custom: true });
    // Reset gives Simulate Ctrl F5 back, and takes it from Validate.
    expect(assignKey(bindings, overrides, "desktop.sim", undefined)).toEqual({ "run.validate": null });
    // In the browser, and in a desktop app that cannot take menu keys, the defaults stay refused.
    expect(validateBinding("run.validate", "Ctrl F5", resolveKeymap(fixedBindings, moved), fixedBindings)).toEqual({
      kind: "refused",
      reason: "The desktop app's Robot menu uses it.",
    });
    expect(resolveKeymap(fixedBindings, { "run.validate": "Ctrl F5" }).bindings.get("run.validate")).toMatchObject({ keys: "F8", custom: false });
  });

  it("refuse a key the menu would run while someone types, and the reserved and fixed keys", () => {
    for (const keys of ["S", "Shift S", "Del", "Ctrl W", "F10", "Esc", "Ctrl Alt S", "F12"]) {
      expect(validateBinding("desktop.sim", keys, resolveKeymap(bindings, {}), bindings).kind, keys).toBe("refused");
    }
    for (const keys of ["Ctrl Shift F5", "F9", "Alt S", "Ctrl 1", "Ctrl Enter"]) {
      expect(validateBinding("desktop.sim", keys, resolveKeymap(bindings, {}), bindings).kind, keys).toBe("ok");
    }
    // A stored plain key for a menu binding is ignored, so a damaged entry falls back alone.
    expect(resolveKeymap(bindings, { "desktop.sim": "S" }).bindings.get("desktop.sim")).toMatchObject({ keys: "Ctrl F5", custom: false });
  });

  it("settle a clash with a page key like any other, naming the other binding", () => {
    expect(validateBinding("desktop.deploy", "Ctrl S", resolveKeymap(bindings, {}), bindings)).toEqual({ kind: "conflict", keys: "Ctrl S", other: "run.save" });
    const overrides = assignKey(bindings, {}, "desktop.deploy", "Ctrl S");
    expect(overrides).toEqual({ "desktop.deploy": "Ctrl S", "run.save": null });
    expect(overlaps(resolveKeymap(bindings, overrides))).toEqual([]);
  });

  it("ignore an override while the desktop app cannot take menu keys", () => {
    const keymap = resolveKeymap(fixedBindings, { "desktop.sim": "Ctrl Shift F5" });
    expect(keymap.bindings.get("desktop.sim")).toMatchObject({ keys: "Ctrl F5", custom: false });
    expect(validateBinding("desktop.sim", "Ctrl Shift F5", keymap, fixedBindings)).toEqual({ kind: "refused", reason: UPDATE_DESKTOP_NOTE });
    expect(assignKey(fixedBindings, {}, "desktop.sim", "Ctrl Shift F5")).toEqual({});
  });

  it("are never run by the page's own key handler, whatever key they have", () => {
    for (const action of robotActions) expect(chordsFor(action), action.id).toEqual([]);
  });

  it("stay out of the worst case the shortcut sheet is checked against", () => {
    expect(Object.keys(worstCaseKeys(bindings)).some((id) => id.startsWith("desktop."))).toBe(false);
  });
});
