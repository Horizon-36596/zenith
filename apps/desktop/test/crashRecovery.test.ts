import { describe, expect, it } from "vitest";
import { DraftKeeper, checkDraft, stoppedQuestion } from "../src/main/crashRecovery.js";

const DRAFT = { root: "C:\\robot", fileName: "first-auto.auto.json", text: "{}" };

describe("DraftKeeper", () => {
  it("holds the last draft the page sent, and nothing once it is saved", () => {
    const drafts = new DraftKeeper();
    expect(drafts.held()).toBeNull();
    drafts.hold(DRAFT);
    expect(drafts.held()).toEqual(DRAFT);
    drafts.hold(null);
    expect(drafts.held()).toBeNull();
  });

  it("hands the draft back once, and only to a page reloaded after a stop", () => {
    const drafts = new DraftKeeper();
    drafts.hold(DRAFT);
    // A page that was not reloaded after a stop starts clean.
    expect(drafts.take()).toBeNull();
    drafts.recover();
    expect(drafts.take()).toEqual(DRAFT);
    expect(drafts.take()).toBeNull();
    // Still held, so a second crash before a save does not lose it.
    expect(drafts.held()).toEqual(DRAFT);
  });

  it("refuses what is not a draft", () => {
    expect(checkDraft(undefined)).toBeNull();
    expect(() => checkDraft("text")).toThrow("That is not a draft Zenith can keep.");
    expect(() => checkDraft({ ...DRAFT, fileName: "../x.auto.json" })).toThrow(/no usable file name/);
    expect(() => checkDraft({ ...DRAFT, text: 4 })).toThrow(/too large/);
    expect(() => checkDraft({ ...DRAFT, root: 4 })).toThrow(/names no project folder/);
  });
});

describe("stoppedQuestion", () => {
  it("offers Reload first, and Save edits as… when there are edits", () => {
    const question = stoppedQuestion("crashed", DRAFT);
    expect(question.message).toBe("Zenith stopped.");
    expect(question.buttons).toEqual(["Reload", "Save edits as…", "Close Zenith"]);
    expect(question.choices).toEqual(["reload", "save", "close"]);
    expect(question.detail).toContain("Your unsaved edits to first-auto.auto.json are kept: Reload brings them back, and Close Zenith loses them.");
  });

  it("says nothing was unsaved when there is no draft", () => {
    const question = stoppedQuestion("load", null);
    expect(question.message).toBe("Zenith could not load its page.");
    expect(question.buttons).toEqual(["Reload", "Close Zenith"]);
    expect(question.detail).toContain("Nothing was left unsaved.");
  });

  it("names the close for what it does, and the copy once it is saved", () => {
    expect(stoppedQuestion("close", DRAFT).buttons).toEqual(["Reload", "Save edits as…", "Close without saving"]);
    const saved = stoppedQuestion("close", DRAFT, "first-auto (copy).auto.json");
    expect(saved.buttons).toEqual(["Reload", "Close without saving"]);
    expect(saved.detail).toContain("Saved a copy of your edits to first-auto.auto.json as first-auto (copy).auto.json.");
  });
});
