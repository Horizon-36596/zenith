/**
 * The unsaved-changes question has one set of buttons wherever work can be lost (UI_GUIDE 9.14):
 * Cancel, Discard changes, then Save as the one primary on the right. The dialog that asks before an
 * auto is replaced and the ask when Settings closes with a robot.json draft both draw it.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("../app/unsaved", () => ({ answerUnsaved: () => undefined }));
vi.mock("../state/store", () => ({ useEditor: () => ({ unsavedPrompt: null }) }));

const { UnsavedChoices } = await import("./UnsavedDialog");

const buttons = (markup: string): string[] => [...markup.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((match) => match[1] ?? "");

describe("the unsaved-changes choices", () => {
  it("are Cancel, Discard changes and Save, in that order, with Save the one primary", () => {
    const markup = renderToStaticMarkup(createElement(UnsavedChoices, { testId: "unsaved", onAnswer: () => undefined }));
    expect(buttons(markup)).toEqual(["Cancel", "Discard changes", "Save"]);
    expect(markup.match(/class="[^"]*primary[^"]*"/g)).toHaveLength(1);
    expect(markup).toContain('data-testid="unsaved-cancel"');
    expect(markup).toContain('data-testid="unsaved-discard"');
    expect(markup).toContain('data-testid="unsaved-save"');
  });

  it("name what Save writes, and say why it waits while a save is on its way", () => {
    const named = renderToStaticMarkup(createElement(UnsavedChoices, { testId: "settings-close", saveLabel: "Save autos/robot.json", onAnswer: () => undefined }));
    expect(buttons(named)).toEqual(["Cancel", "Discard changes", "Save autos/robot.json"]);
    const saving = renderToStaticMarkup(
      createElement(UnsavedChoices, { testId: "settings-close", saveLabel: "Save robot.json", saving: "Saving robot.json now.", onAnswer: () => undefined }),
    );
    expect(saving).toContain("Saving…");
    expect(saving).toContain('aria-disabled="true"');
  });
});
