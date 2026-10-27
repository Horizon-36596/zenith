/**
 * The recovery code sheet, the recovery code entry and the verification code: when Continue may act,
 * what each screen says and prints, and that the entry counts a real code the way the parser reads it.
 */
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { newRecoveryCode, recoveryCodeFromText, recoveryCodeToText } from "@horizon36596/zenith-cloud/crypto";
import { recoveryCharactersTyped, whyCannotContinue } from "./logic";
import { RecoveryCodeEntry, type RecoveryCodeEntryProps } from "./RecoveryCodeEntry";
import { RecoveryCodeSheet, type RecoveryCodeSheetProps } from "./RecoveryCodeSheet";
import { CODE, MADE, RECOVERY, html, nothing, tagOf, text } from "./testMarkup";
import { VerificationCode } from "./VerificationCode";
import { RECOVERY_CODE_CHARACTERS, RECOVERY_ENTRY, RECOVERY_SHEET, dateWords, messageOf, spokenCode } from "./words";

describe("the recovery code sheet", () => {
  const props = (over: Partial<RecoveryCodeSheetProps> = {}): RecoveryCodeSheetProps => ({
    teamName: "Horizon",
    teamNumber: 36596,
    code: RECOVERY,
    madeAt: MADE,
    onPrint: nothing,
    onSaved: nothing,
    ...over,
  });

  it("lets Continue act only once the code was printed or ticked as saved, and either is enough", () => {
    expect(whyCannotContinue(false, false)).toBe(RECOVERY_SHEET.whyNotYet);
    expect(whyCannotContinue(true, false)).toBeNull();
    expect(whyCannotContinue(false, true)).toBeNull();
    expect(whyCannotContinue(true, true)).toBeNull();
  });

  it("opens with Continue unavailable, and with Print and the saved tick ready", () => {
    const markup = html(createElement(RecoveryCodeSheet, props()));
    expect(tagOf(markup, "recovery-code-continue")).toContain('aria-disabled="true"');
    expect(tagOf(markup, "recovery-code-print")).toContain('aria-disabled="false"');
    expect(tagOf(markup, "recovery-code-saved")).toContain('type="checkbox"');
    expect(tagOf(markup, "recovery-code-saved")).not.toContain("checked");
    expect(text(markup)).toContain(RECOVERY_SHEET.saved);
  });

  it("says what the code is for, where to keep it and that it outlives key changes", () => {
    const shown = text(html(createElement(RecoveryCodeSheet, props())));
    expect(shown).toContain("Keep this code safe for 36596 Horizon.");
    expect(shown).toContain(RECOVERY_SHEET.what);
    expect(shown).toContain(RECOVERY_SHEET.where);
    expect(shown).toContain(RECOVERY);
    expect(shown).toContain(RECOVERY_SHEET.madeOn(dateWords(MADE)));
    expect(shown).not.toContain(RECOVERY_SHEET.replacing);
  });

  it("offers no Cancel when the code is required, and one when an owner is only making a new code", () => {
    expect(html(createElement(RecoveryCodeSheet, props()))).not.toContain("recovery-code-cancel");
    const renewing = html(createElement(RecoveryCodeSheet, props({ onCancel: nothing, replacing: true })));
    expect(renewing).toContain('data-testid="recovery-code-cancel"');
    expect(text(renewing)).toContain(RECOVERY_SHEET.replacing);
  });

  it("prints a page with only the team, the code, the date and one line of instructions", () => {
    const markup = html(createElement(RecoveryCodeSheet, props()));
    const page = /<div[^>]*data-testid="recovery-code-print-page"[^>]*>(.*?)<\/div>/.exec(markup)?.[1] ?? "";
    expect(text(page)).toBe(
      ["36596 Horizon", RECOVERY, RECOVERY_SHEET.madeOn(dateWords(MADE)), RECOVERY_SHEET.printInstruction].join(" "),
    );
    expect(page).not.toMatch(/<(button|input|label)/);
  });

  it("names a team without a number by its name alone", () => {
    expect(text(html(createElement(RecoveryCodeSheet, props({ teamNumber: null }))))).toContain("Keep this code safe for Horizon.");
  });
});

describe("the recovery code entry", () => {
  const props = (over: Partial<RecoveryCodeEntryProps> = {}): RecoveryCodeEntryProps => ({
    teamName: "Horizon",
    teamNumber: 36596,
    onSubmit: () => Promise.resolve(),
    busy: false,
    ...over,
  });

  it("counts a real code's characters however it is typed, as the parser reads it", async () => {
    const code = await recoveryCodeToText(newRecoveryCode());
    const bare = code.slice("ZNTH-".length);
    const variants = [code, code.toLowerCase(), code.replace(/-/g, " "), bare, bare.replace(/-/g, ""), ` ${code.replace(/-/g, "–")} `];
    for (const typed of variants) {
      expect(recoveryCharactersTyped(typed), typed).toBe(RECOVERY_CODE_CHARACTERS);
      await expect(recoveryCodeFromText(typed)).resolves.toBeInstanceOf(Uint8Array);
    }
  });

  it("counts a code as it is being typed, with or without the prefix", () => {
    expect(recoveryCharactersTyped("")).toBe(0);
    expect(recoveryCharactersTyped("ZNTH")).toBe(0);
    expect(recoveryCharactersTyped("znth-abcde")).toBe(5);
    expect(recoveryCharactersTyped("abcde fghjk")).toBe(10);
  });

  it("labels the input, says what using the code does, and starts with Use code unavailable", () => {
    const markup = html(createElement(RecoveryCodeEntry, props()));
    expect(markup).toMatch(/<label[^>]*>Recovery code<input[^>]*data-testid="recovery-entry-input"/);
    expect(tagOf(markup, "recovery-entry-input")).toContain('aria-invalid="false"');
    expect(tagOf(markup, "recovery-entry-submit")).toContain('aria-disabled="true"');
    const shown = text(markup);
    expect(shown).toContain(RECOVERY_ENTRY.title("36596 Horizon"));
    expect(shown).toContain(RECOVERY_ENTRY.how);
    expect(shown).toContain(RECOVERY_ENTRY.count(0));
    expect(markup).not.toContain("recovery-entry-error");
  });

  it("says it is checking while busy", () => {
    const markup = html(createElement(RecoveryCodeEntry, props({ busy: true })));
    expect(text(markup)).toContain(RECOVERY_ENTRY.checking);
    expect(tagOf(markup, "recovery-entry-submit")).toContain('aria-disabled="true"');
  });

  it("shows the parser's own message for a wrong code, and a plain one when there is none", () => {
    expect(messageOf(new Error("That recovery code has a typing mistake in it."), RECOVERY_ENTRY.failed)).toBe(
      "That recovery code has a typing mistake in it.",
    );
    expect(messageOf("Not this team's code.", RECOVERY_ENTRY.failed)).toBe("Not this team's code.");
    expect(messageOf(new Error(""), RECOVERY_ENTRY.failed)).toBe(RECOVERY_ENTRY.failed);
    expect(messageOf(undefined, RECOVERY_ENTRY.failed)).toBe(RECOVERY_ENTRY.failed);
    expect(messageOf({ code: 42 }, RECOVERY_ENTRY.failed)).toBe(RECOVERY_ENTRY.failed);
  });

  it("has a Cancel only when it is given somewhere to go back to", () => {
    expect(html(createElement(RecoveryCodeEntry, props()))).not.toContain("recovery-entry-cancel");
    expect(html(createElement(RecoveryCodeEntry, props({ onCancel: nothing })))).toContain("recovery-entry-cancel");
  });
});

describe("a verification code", () => {
  it("shows the five groups large, and says each digit to a screen reader", () => {
    const markup = html(createElement(VerificationCode, { code: CODE, caption: "This device's code", testId: "code" }));
    expect(markup).toContain(
      '<span aria-hidden="true">0417</span><span aria-hidden="true">2958</span><span aria-hidden="true">3361</span><span aria-hidden="true">7720</span><span aria-hidden="true">5164</span>',
    );
    expect(markup).toContain(`<span class="visually-hidden">${spokenCode(CODE)}</span>`);
    expect(spokenCode(CODE)).toBe("0 4 1 7, 2 9 5 8, 3 3 6 1, 7 7 2 0, 5 1 6 4");
  });

  it("is named by its caption", () => {
    const markup = html(createElement(VerificationCode, { code: CODE, caption: "This device's code" }));
    const labelledBy = /<figure[^>]*aria-labelledby="([^"]+)"/.exec(markup)?.[1];
    expect(labelledBy).toBeDefined();
    expect(markup).toContain(`<figcaption id="${labelledBy ?? ""}"`);
    expect(text(markup)).toContain("This device's code");
  });
});
