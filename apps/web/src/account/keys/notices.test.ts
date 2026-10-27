/**
 * The shared computer choice, the key changed warning, the team safety code, the rotation banner and
 * the team page's privacy section: what each says, and that each button calls the callback it should.
 */
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { KeyChangedWarning, type KeyChangedWarningProps } from "./KeyChangedWarning";
import { RotationPending, type RotationPendingProps } from "./RotationPending";
import { SharedComputerChoice } from "./SharedComputerChoice";
import { TeamPrivacy } from "./TeamPrivacy";
import { TeamSafetyCode } from "./TeamSafetyCode";
import { CODE, click, html, nothing, tagOf, text } from "./testMarkup";
import { KEY_CHANGED, PRIVACY, ROTATION, SAFETY_CODE, SHARED_COMPUTER, spokenCode } from "./words";

describe("the shared computer choice", () => {
  it("is a labelled group of two radio buttons with one name, and the chosen one checked", () => {
    const markup = html(createElement(SharedComputerChoice, { value: "shared", onChange: nothing }));
    expect(markup).toMatch(/<fieldset[^>]*><legend[^>]*>Whose device is this\?<\/legend>/);
    const own = tagOf(markup, "shared-computer-own");
    const shared = tagOf(markup, "shared-computer-shared");
    expect(own).toContain('type="radio"');
    expect(own).not.toContain("checked");
    expect(shared).toContain('checked=""');
    expect(/name="([^"]+)"/.exec(own)?.[1]).toBe(/name="([^"]+)"/.exec(shared)?.[1]);
  });

  it("says what each choice means, and recommends the desktop app outside it", () => {
    const shown = text(html(createElement(SharedComputerChoice, { value: "own", onChange: nothing })));
    expect(shown).toContain(`${SHARED_COMPUTER.own} ${SHARED_COMPUTER.ownDetail}`);
    expect(shown).toContain(`${SHARED_COMPUTER.shared} ${SHARED_COMPUTER.sharedDetail}`);
    expect(shown).toContain(SHARED_COMPUTER.desktop);
    const desktop = text(html(createElement(SharedComputerChoice, { value: "own", onChange: nothing, inDesktopApp: true })));
    expect(desktop).not.toContain(SHARED_COMPUTER.desktop);
  });
});

describe("the key changed warning", () => {
  const props = (over: Partial<KeyChangedWarningProps> = {}): KeyChangedWarningProps => ({
    teamName: "Partner",
    teamNumber: 12345,
    safetyCode: CODE,
    onContinue: nothing,
    onDontSend: nothing,
    ...over,
  });

  it("is announced, names the team and shows its safety code to compare", () => {
    const markup = html(createElement(KeyChangedWarning, props()));
    expect(tagOf(markup, "key-changed-warning")).toContain('role="alert"');
    const shown = text(markup);
    expect(shown).toContain(KEY_CHANGED.title("12345 Partner"));
    expect(shown).toContain(KEY_CHANGED.compare);
    expect(shown).toContain(KEY_CHANGED.caption("12345 Partner"));
    expect(markup).toContain(spokenCode(CODE));
  });

  it("puts Don't send first, and calls each callback from its own button", () => {
    const markup = html(createElement(KeyChangedWarning, props()));
    expect(markup.indexOf("key-changed-warning-dont-send")).toBeLessThan(markup.indexOf("key-changed-warning-continue"));
    const calls: string[] = [];
    const tree = KeyChangedWarning(
      props({
        onContinue: () => calls.push("continue"),
        onDontSend: () => calls.push("dont-send"),
      }),
    );
    click(tree, "key-changed-warning-dont-send");
    click(tree, "key-changed-warning-continue");
    expect(calls).toEqual(["dont-send", "continue"]);
  });

  it("holds Continue, but never Don't send, while the send is under way", () => {
    const markup = html(createElement(KeyChangedWarning, props({ busy: true })));
    expect(tagOf(markup, "key-changed-warning-continue")).toContain('aria-disabled="true"');
    expect(tagOf(markup, "key-changed-warning-dont-send")).toContain('aria-disabled="false"');
  });
});

describe("the team safety code and the rotation banner", () => {
  it("shows the team's safety code, and leaves when to compare it to the heading's hint", () => {
    const shown = text(html(createElement(TeamSafetyCode, { code: CODE })));
    expect(shown).toContain(SAFETY_CODE.heading);
    expect(shown).toContain(SAFETY_CODE.caption);
    expect(shown).not.toContain(SAFETY_CODE.when);
    expect(shown).not.toContain(SAFETY_CODE.changes);
  });

  const rotation = (over: Partial<RotationPendingProps> = {}): RotationPendingProps => ({ onRotate: nothing, busy: false, ...over });

  it("asks for a new team key, naming the member who left when there is one", () => {
    expect(text(html(createElement(RotationPending, rotation())))).toContain(ROTATION.anyone);
    expect(text(html(createElement(RotationPending, rotation({ leaverName: "Ada" }))))).toContain(
      "Ada left. Make a new team key so they cannot open new versions.",
    );
  });

  it("makes the key from its button, and says so while it works", () => {
    let rotated = 0;
    click(
      RotationPending(
        rotation({
          onRotate: () => {
            rotated += 1;
          },
        }),
      ),
      "rotation-pending-rotate",
    );
    expect(rotated).toBe(1);
    const busy = html(createElement(RotationPending, rotation({ busy: true })));
    expect(text(busy)).toContain(ROTATION.rotating);
    expect(tagOf(busy, "rotation-pending-rotate")).toContain('aria-disabled="true"');
    const offline = html(createElement(RotationPending, rotation({ whyCannotRotate: "You are offline." })));
    expect(tagOf(offline, "rotation-pending-rotate")).toContain('aria-disabled="true"');
  });
});

describe("the team page's privacy section", () => {
  it("says what the encryption means, then who can do what by role and by kind of share", () => {
    const shown = text(html(createElement(TeamPrivacy, { editorsMayProposeShare: false, editorsMayLinkShare: false })));
    expect(shown).toContain(`${PRIVACY.what} ${PRIVACY.who}`);
    for (const row of [PRIVACY.owner, PRIVACY.admin, PRIVACY.viewer, PRIVACY.pending, PRIVACY.viewGives, PRIVACY.proposeGives, PRIVACY.linkGives]) {
      expect(shown).toContain(row);
    }
    expect(shown).toContain("Waiting for approval Nothing until an owner or admin approves them.");
    expect(shown).toContain("Editor Publish, send proposals, and share with other teams to view.");
  });

  it("gives editors what the team's two sharing settings allow", () => {
    const both = text(html(createElement(TeamPrivacy, { editorsMayProposeShare: true, editorsMayLinkShare: true })));
    expect(both).toContain("share with other teams to view or propose, or by link.");
    const link = text(html(createElement(TeamPrivacy, { editorsMayProposeShare: false, editorsMayLinkShare: true })));
    expect(link).toContain("share with other teams to view, or by link.");
  });
});
