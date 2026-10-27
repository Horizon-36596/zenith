/**
 * The work-branch field on the Open project dialog's GitHub tab (issue #248): its explanation is the
 * field's tooltip, and the fact that the base branch is never written to stays visible beside it.
 */
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("../components/Tooltip", () => ({
  Tooltip: ({ label, hint, children }: { label: string; hint?: string; children: ReactElement }) =>
    createElement("span", { "data-tooltip": label, "data-hint": hint }, children),
}));
vi.mock("../state/store", () => ({
  setDialog: () => undefined,
  useEditor: () => ({
    auth: { login: "ada" },
    project: { source: { kind: "github" } },
    repo: { base: "main", branch: "auto/first/ada" },
    fileName: "first.auto.json",
    busy: false,
  }),
}));
vi.mock("./session", () => ({ currentClient: () => ({}) }));
vi.mock("./actions", () => ({
  openFromGitHub: () => undefined,
  openReviewFromUrl: () => undefined,
  setWorkBranch: () => undefined,
}));

const { GitHubTab, listBranches } = await import("./OpenFromGitHub");

describe("the work-branch field", () => {
  const markup = renderToStaticMarkup(createElement(GitHubTab));

  it("wraps the field in a tooltip that says where the branch comes from and that the base is never written to", () => {
    const wrapper = /<span data-tooltip="Work branch" data-hint="([^"]*)"><input[^>]*data-testid="github-branch"/.exec(markup);
    expect(wrapper).not.toBeNull();
    expect(wrapper?.[1]).toContain("Created from main the first time");
    expect(wrapper?.[1]).toContain("the base branch is never written to");
  });

  it("says beside the field, always visible, that Zenith never writes to the base branch", () => {
    expect(markup).toContain('data-testid="github-branch-base">Zenith never writes to main.</p>');
  });
});

describe("the base-branch list (issue #407)", () => {
  const summary = (name: string) => ({ owner: "team", repo: name, fullName: `team/${name}`, defaultBranch: "main", private: false });

  it("drops a branch list that arrives after another repository was picked", async () => {
    const pending = new Map<string, (names: { name: string }[]) => void>();
    const client = {
      branches: {
        list: (_owner: string, repo: string) =>
          new Promise<{ name: string; sha: string; protected: boolean }[]>((resolve) => {
            pending.set(repo, (names) => resolve(names.map(({ name }) => ({ name, sha: "s", protected: false }))));
          }),
      },
    } as never;
    const latest = { current: null as string | null };
    const shown: string[][] = [];

    latest.current = "team/a";
    const first = listBranches(client, summary("a"), latest, (names) => shown.push(names), () => undefined);
    latest.current = "team/b";
    const second = listBranches(client, summary("b"), latest, (names) => shown.push(names), () => undefined);
    pending.get("b")?.([{ name: "b-main" }]);
    await second;
    pending.get("a")?.([{ name: "a-only" }]);
    await first;

    expect(shown).toEqual([["b-main"]]);
  });
});
