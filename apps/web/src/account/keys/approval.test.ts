/**
 * Approving with a typed code, waiting for the key, and the list of devices waiting for it: that
 * Approve waits for the whole code, who can approve what, and what each row says.
 */
import { createElement, type ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

// The tooltip draws its hint only in the browser, so the server render shows it as attributes here.
vi.mock("../../components/Tooltip", () => ({
  Tooltip: ({ label, hint, children }: { label: string; hint?: string; children: ReactElement }) =>
    createElement("span", { "data-tooltip": label, "data-hint": hint }, children),
}));
import { APPROVAL_CODE_CHARACTERS } from "@horizon36596/zenith-cloud/crypto";
import { ApproveWithCode, typedApprovalCode, type ApproveWithCodeProps } from "./ApproveWithCode";
import { isWrongCode } from "./errors";
import { requestTitle, whoCanApprove } from "./logic";
import { NewDeviceRequestList, type DeviceRequest } from "./NewDeviceRequests";
import { APPROVAL, CODE, MADE, NOW_MS, click, html, nothing, tagOf, text } from "./testMarkup";
import { WaitingForKey, type WaitingForKeyProps } from "./WaitingForKey";
import { APPROVE, DEVICE_REQUESTS, WAITING } from "./words";

describe("approving with a code", () => {
  const props = (over: Partial<ApproveWithCodeProps> = {}): ApproveWithCodeProps => ({
    who: "Ada",
    kind: "member",
    onApprove: () => Promise.resolve(),
    onDecline: nothing,
    busy: false,
    ...over,
  });

  it("asks the approver to type the code, counts the characters, and holds Approve until the count is complete", () => {
    const markup = html(createElement(ApproveWithCode, props()));
    const shown = text(markup);
    expect(shown).toContain(APPROVE.titleMember("Ada"));
    expect(shown).toContain(APPROVE.ask("Ada"));
    expect(text(markup)).toContain(APPROVE.count(0, APPROVAL_CODE_CHARACTERS));
    expect(text(markup)).toContain("0 of 18 characters");
    expect(tagOf(markup, "approve-with-code-approve")).toContain('aria-disabled="true"');
    expect(tagOf(markup, "approve-with-code-decline")).toContain('aria-disabled="false"');
  });

  it("says why the code is typed in the code field's tooltip, not in a paragraph", () => {
    const markup = html(createElement(ApproveWithCode, props()));
    const wrapper = /<span data-tooltip="([^"]*)" data-hint="([^"]*)"><input[^>]*data-testid="approve-with-code-input"/.exec(markup);
    expect(wrapper?.[1]).toBe(APPROVE.inputLabel);
    expect(wrapper?.[2]).toBe(`${APPROVE.why} ${APPROVE.inputHint}`.replace(/'/g, "&#x27;"));
    expect(text(markup.replace(/data-hint="[^"]*"/g, ""))).not.toContain(APPROVE.why);
  });

  it("has no tick for matching codes: typing the code replaces it", () => {
    const markup = html(createElement(ApproveWithCode, props()));
    expect(markup).not.toContain("approve-with-code-match");
    expect(markup).not.toContain('type="checkbox"');
  });

  it("counts a code typed any way, and says what is missing or extra", () => {
    const of = APPROVAL_CODE_CHARACTERS;
    expect(of).toBe(18);
    expect(typedApprovalCode("")).toEqual({ typed: 0, of, whyNot: APPROVE.notYet(of) });
    expect(typedApprovalCode(APPROVAL)).toEqual({ typed: of, of, whyNot: null });
    expect(typedApprovalCode("7k2qxd m9a1rt 4zc8pw")).toEqual({ typed: of, of, whyNot: null });
    expect(typedApprovalCode(" 7K2QXDM9A1RT4ZC8PW ")).toEqual({ typed: of, of, whyNot: null });
    expect(typedApprovalCode(`${APPROVAL}9`).whyNot).toBe(APPROVE.tooLong);
    expect(typedApprovalCode("7K2QXD").typed).toBe(6);
    // A twenty-digit verification code is not an approval code.
    expect(typedApprovalCode(CODE).whyNot).toBe(APPROVE.tooLong);
  });

  it("names a new device, the approver's own device, and the device's label", () => {
    const device = text(html(createElement(ApproveWithCode, props({ kind: "device", deviceLabel: "Chrome on Windows" }))));
    expect(device).toContain(APPROVE.titleDevice("Ada"));
    expect(device).toContain(APPROVE.device("Chrome on Windows"));
    const own = text(html(createElement(ApproveWithCode, props({ kind: "device", ownDevice: true }))));
    expect(own).toContain(APPROVE.titleOwnDevice);
    expect(own).toContain(APPROVE.askOwn);
    expect(own).not.toContain("Device:");
  });

  it("holds both buttons while the approval is being written, and says why Approve cannot act", () => {
    const markup = html(createElement(ApproveWithCode, props({ busy: true })));
    expect(tagOf(markup, "approve-with-code-approve")).toContain('aria-disabled="true"');
    expect(tagOf(markup, "approve-with-code-decline")).toContain('aria-disabled="true"');
    const blocked = html(createElement(ApproveWithCode, props({ whyCannotApprove: "Their device has not asked yet." })));
    expect(tagOf(blocked, "approve-with-code-approve")).toContain('aria-disabled="true"');
  });

  it("tells a wrong code from any other failure", () => {
    const wrong = Object.assign(new Error("x"), { name: "CloudError", code: "wrong-code" });
    expect(isWrongCode(wrong)).toBe(true);
    expect(isWrongCode(Object.assign(new Error("x"), { name: "CloudError", code: "no-key" }))).toBe(false);
    expect(isWrongCode("wrong-code")).toBe(false);
  });
});

describe("waiting for the key", () => {
  const props = (over: Partial<WaitingForKeyProps> = {}): WaitingForKeyProps => ({
    teamName: "Horizon",
    teamNumber: 36596,
    code: APPROVAL,
    kind: "member",
    onUseRecoveryCode: nothing,
    ...over,
  });

  it("says who can approve: owners and admins for a member, and the member's own devices too for a device", () => {
    expect(whoCanApprove("member", "36596 Horizon", false)).toBe(WAITING.whoMember("36596 Horizon"));
    expect(whoCanApprove("member", "36596 Horizon", true)).toBe(WAITING.whoMember("36596 Horizon"));
    expect(whoCanApprove("device", "36596 Horizon", false)).toBe(WAITING.whoDevice);
    expect(whoCanApprove("device", "36596 Horizon", true)).toBe(WAITING.whoDeviceAnyMember);
  });

  it("shows the waiting sentence, this device's approval code, and that the rest of the app still works", () => {
    const shown = text(html(createElement(WaitingForKey, props())));
    expect(shown).toContain(WAITING.title);
    expect(shown).toContain(WAITING.whoMember("36596 Horizon"));
    expect(shown).toContain(WAITING.readOut);
    expect(shown).toContain(WAITING.caption);
    expect(shown).toContain(WAITING.meanwhile);
    expect(shown).toContain(WAITING.useRecovery);
  });

  it("shows exactly one code, the approval code, in three groups of six however it is given", () => {
    const groups = (markup: string) => [...markup.matchAll(/<span aria-hidden="true">([^<]*)<\/span>/g)].map((match) => match[1]);
    const markup = html(createElement(WaitingForKey, props({ code: "7k2qxdm9a1rt4zc8pw" })));
    expect(groups(markup)).toEqual(["7K2QXD", "M9A1RT", "4ZC8PW"]);
    expect(markup.match(/data-testid="waiting-for-key-code"/g)).toHaveLength(1);
    expect(markup).not.toContain(CODE);
  });

  it("says when the request is gone, and asks again from its button", () => {
    expect(text(html(createElement(WaitingForKey, props({ onAskAgain: nothing }))))).not.toContain(WAITING.notWaiting);
    let asked = 0;
    const gone = props({
      requested: false,
      onAskAgain: () => {
        asked += 1;
      },
    });
    expect(text(html(createElement(WaitingForKey, gone)))).toContain(WAITING.notWaiting);
    click(WaitingForKey(gone), "waiting-for-key-ask-again");
    expect(asked).toBe(1);
    expect(tagOf(html(createElement(WaitingForKey, { ...gone, busy: true })), "waiting-for-key-ask-again")).toContain('aria-disabled="true"');
  });

  it("says approval will be needed each time only when this browser could not save the code", () => {
    expect(text(html(createElement(WaitingForKey, props())))).not.toContain(WAITING.notSaved);
    const markup = html(createElement(WaitingForKey, props({ savedOnDevice: false })));
    expect(text(markup)).toContain(WAITING.notSaved);
    expect(WAITING.notSaved).toBe("This browser can't save keys; approval will be needed each time.");
    expect(tagOf(markup, "waiting-for-key-not-saved")).toContain('role="status"');
  });

  it("opens the recovery code entry from its link", () => {
    let opened = 0;
    click(
      WaitingForKey(
        props({
          onUseRecoveryCode: () => {
            opened += 1;
          },
        }),
      ),
      "waiting-for-key-recovery",
    );
    expect(opened).toBe(1);
  });
});

describe("new device requests", () => {
  const request = (over: Partial<DeviceRequest> = {}): DeviceRequest => ({
    deviceId: "d1",
    who: "Ada",
    deviceLabel: "Chrome on Windows",
    code: CODE,
    requestedAt: MADE,
    isYours: false,
    ...over,
  });

  it("renders nothing when no device is waiting", () => {
    expect(html(createElement(NewDeviceRequestList, { requests: [], nowMs: NOW_MS, onApprove: () => Promise.resolve(), onDecline: nothing }))).toBe("");
  });

  it("lists each waiting device compactly, with whose it is, its label and when it asked", () => {
    const markup = html(
      createElement(NewDeviceRequestList, {
        requests: [request(), request({ deviceId: "d2", isYours: true, deviceLabel: null })],
        nowMs: NOW_MS,
        onApprove: () => Promise.resolve(),
        onDecline: nothing,
      }),
    );
    const shown = text(markup);
    expect(shown).toContain(DEVICE_REQUESTS.heading);
    expect(shown).toContain("Ada's new device Chrome on Windows asked 5 minutes ago");
    expect(shown).toContain(`${DEVICE_REQUESTS.yours} asked 5 minutes ago`);
    expect(tagOf(markup, "device-request-d1-approve")).toContain('aria-disabled="false"');
    // The code entry opens only after Approve is pressed.
    expect(markup).not.toContain("device-request-d1-check");
  });

  it("says why a viewer cannot approve a device", () => {
    const markup = html(
      createElement(NewDeviceRequestList, {
        requests: [request()],
        nowMs: NOW_MS,
        onApprove: () => Promise.resolve(),
        onDecline: nothing,
        whyCannotApprove: () => "Only owners and admins approve devices.",
      }),
    );
    expect(tagOf(markup, "device-request-d1-approve")).toContain('aria-disabled="true"');
  });

  it("titles a request by whose device it is", () => {
    expect(requestTitle({ who: "Ada", isYours: false })).toBe("Ada's new device");
    expect(requestTitle({ who: "Ada", isYours: true })).toBe(DEVICE_REQUESTS.yours);
  });
});
