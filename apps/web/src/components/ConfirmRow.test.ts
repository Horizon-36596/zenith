/**
 * The one in-place confirm and the one Button (UI_GUIDE 9.9, 9.14): Cancel on the left and the
 * specific verb as the one primary on the right, and a disabled button that stays focusable with a
 * tooltip saying why.
 */
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("./Tooltip", () => ({
  Tooltip: ({ label, hint, children }: { label: string; hint?: string; children: ReactElement }) =>
    createElement("span", { "data-tooltip": label, "data-hint": hint }, children),
}));

const { ConfirmRow } = await import("./ConfirmRow");
const { Button } = await import("./primitives");

const buttons = (markup: string): string[] => [...markup.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((match) => match[1] ?? "");

describe("the confirm row", () => {
  const row = (extra: Record<string, unknown> = {}): string =>
    renderToStaticMarkup(
      createElement(ConfirmRow, {
        sentence: "Revoke the share with 1234?",
        verb: "Revoke",
        onConfirm: () => undefined,
        onCancel: () => undefined,
        testId: "share-confirm",
        ...extra,
      }),
    );

  it("asks with the sentence, then Cancel on the left and the verb on the right", () => {
    const markup = row();
    expect(markup).toContain("Revoke the share with 1234?");
    expect(buttons(markup)).toEqual(["Cancel", "Revoke"]);
    expect(markup).toMatch(/data-testid="share-confirm-cancel"/);
    expect(markup).toMatch(/data-testid="share-confirm-yes"/);
  });

  it("makes the verb the one primary and Cancel its secondary", () => {
    const markup = row();
    const cancel = /<button[^>]*class="([^"]*)"[^>]*data-testid="share-confirm-cancel"/.exec(markup)?.[1];
    const verb = /<button[^>]*class="([^"]*)"[^>]*data-testid="share-confirm-yes"/.exec(markup)?.[1];
    expect(verb).toMatch(/primary/);
    expect(cancel).toMatch(/secondary/);
    expect(markup.match(/class="[^"]*primary[^"]*"/g)).toHaveLength(1);
  });

  it("keeps a screen's own test ids for its buttons", () => {
    const markup = row({ confirmTestId: "teams-leave-yes", cancelTestId: "teams-leave-keep" });
    expect(markup).toContain('data-testid="teams-leave-yes"');
    expect(markup).toContain('data-testid="teams-leave-keep"');
  });

  it("says why the verb cannot act, and leaves it focusable", () => {
    const markup = row({ whyDisabled: "Type Horizon exactly." });
    expect(markup).toContain('data-hint="Unavailable: Type Horizon exactly."');
    const verb = /<button[^>]*data-testid="share-confirm-yes"[^>]*>/.exec(markup)?.[0] ?? "";
    expect(verb).toContain('aria-disabled="true"');
    expect(verb).not.toMatch(/\sdisabled=""/);
  });
});

describe("the Button", () => {
  it("is aria-disabled with an Unavailable tooltip, never natively disabled", () => {
    const markup = renderToStaticMarkup(createElement(Button, { whyDisabled: "Say what happened first.", children: "Send report" }));
    expect(markup).toContain('data-tooltip="Send report"');
    expect(markup).toContain('data-hint="Unavailable: Say what happened first."');
    expect(markup).toContain('aria-disabled="true"');
    expect(markup).not.toMatch(/\sdisabled=""/);
  });

  it("has no tooltip while it can act and was given none", () => {
    const markup = renderToStaticMarkup(createElement(Button, { whyDisabled: null, children: "Cancel" }));
    expect(markup).not.toContain("data-tooltip");
    expect(markup).not.toContain("aria-disabled");
  });

  it("draws each kind with its own recipe, secondary by default", () => {
    const classOf = (kind?: "primary" | "secondary" | "ghost" | "text"): string =>
      /class="([^"]*)"/.exec(renderToStaticMarkup(createElement(Button, { ...(kind === undefined ? {} : { kind }), children: "Go" })))?.[1] ?? "";
    expect(classOf()).toMatch(/secondary/);
    expect(classOf("primary")).toMatch(/primary/);
    expect(classOf("ghost")).toMatch(/ghost/);
    expect(classOf("text")).toMatch(/textButton/);
  });
});
