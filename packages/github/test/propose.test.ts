import { describe, expect, it } from "vitest";
import { PatAuth } from "../src/auth.js";
import { GitHubClient } from "../src/client.js";
import { MergeConflictError } from "../src/errors.js";
import { GitHubProject } from "../src/project.js";
import { propose, RENDER_URL_PLACEHOLDER } from "../src/propose.js";
import { createFetchStub, noSleep } from "./fetchStub.js";

const linkJson = {
  $schema: "https://libraries.horizon36596.org/zenith/schema/v1/link.json",
  formatVersion: 1,
  autosDir: "autos",
  robot: "autos/robot.json",
  field: "autos/field.json",
  waypoints: "autos/waypoints.json",
};

function b64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

function contentsGetPattern(path: string): RegExp {
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`/contents/${escaped}(\\?|$)`);
}

const rawPull = {
  number: 7,
  url: "https://api.github.com/repos/o/r/pulls/7",
  html_url: "https://github.com/o/r/pull/7",
  state: "open",
  title: "first-auto",
  body: "old body",
  head: { ref: "auto/first-auto/octocat", sha: "headsha" },
  base: { ref: "main", sha: "basesha" },
};

function baseRoutes() {
  return [
    { method: "GET" as const, match: contentsGetPattern("zenith.json"), handler: () => ({ status: 200, body: { type: "file", path: "zenith.json", sha: "s", content: b64(JSON.stringify(linkJson)), encoding: "base64" } }) },
    { method: "GET" as const, match: /\/user$/, handler: () => ({ status: 200, body: { login: "octocat", id: 1, name: null } }) },
    { method: "GET" as const, match: /\/branches\/auto%2Ffirst-auto%2Foctocat$/, handler: () => ({ status: 200, body: { name: "auto/first-auto/octocat", commit: { sha: "worksha" }, protected: false } }) },
    { method: "POST" as const, match: /\/merges$/, handler: () => ({ status: 204 }) },
    { method: "GET" as const, match: contentsGetPattern("autos/first-auto.auto.json"), handler: () => ({ status: 404, body: { message: "Not Found" } }) },
    { method: "PUT" as const, match: /\/contents\/autos\/first-auto\.auto\.json$/, handler: () => ({ status: 201, body: { content: { sha: "s1" }, commit: { sha: "c1" } } }) },
    { method: "GET" as const, match: contentsGetPattern("autos/.renders/first-auto.svg"), handler: () => ({ status: 404, body: { message: "Not Found" } }) },
    { method: "PUT" as const, match: /\/contents\/autos\/\.renders\/first-auto\.svg$/, handler: () => ({ status: 201, body: { content: { sha: "s2" }, commit: { sha: "c2" } } }) },
  ];
}

function buildProject(extraRoutes: Parameters<typeof createFetchStub>[0]) {
  const stub = createFetchStub([...baseRoutes(), ...extraRoutes]);
  const client = new GitHubClient(new PatAuth("t"), { fetchImpl: stub.fetchImpl, sleep: noSleep().sleep });
  const project = new GitHubProject(client, { owner: "o", repo: "r", base: "main" });
  return { client, project, stub };
}

describe("propose", () => {
  it("creates a new PR when none exists for the work branch, and fills in the render URL", async () => {
    const { client, project, stub } = buildProject([
      { method: "GET", match: /\/pulls\?/, handler: () => ({ status: 200, body: [] }) },
      { method: "POST", match: /\/pulls$/, handler: () => ({ status: 201, body: rawPull }) },
    ]);

    const result = await propose(client, project, {
      autoName: "first-auto",
      autoText: '{"auto":true}\n',
      renderSvg: "<svg/>",
      body: `see ![render](${RENDER_URL_PLACEHOLDER})`,
      base: "main",
    });

    expect(result).toEqual({ url: "https://github.com/o/r/pull/7", number: 7, branch: "auto/first-auto/octocat" });
    const createCall = stub.calls.find((c) => c.method === "POST" && c.url.pathname.endsWith("/pulls"));
    expect((createCall?.body as { body: string }).body).toBe(
      "see ![render](https://raw.githubusercontent.com/o/r/auto/first-auto/octocat/autos/.renders/first-auto.svg)",
    );
  });

  it("updates the existing PR it finds for the work branch instead of creating a new one", async () => {
    const { client, project, stub } = buildProject([
      { method: "GET", match: /\/pulls\?/, handler: () => ({ status: 200, body: [rawPull] }) },
      { method: "PATCH", match: /\/pulls\/7$/, handler: () => ({ status: 200, body: { ...rawPull, body: "updated" } }) },
    ]);

    const result = await propose(client, project, {
      autoName: "first-auto",
      autoText: '{"auto":true}\n',
      renderSvg: "<svg/>",
      body: "see the render",
      base: "main",
    });

    expect(result.number).toBe(7);
    expect(stub.calls.some((c) => c.method === "POST" && c.url.pathname.endsWith("/pulls"))).toBe(false);
    expect(stub.calls.some((c) => c.method === "PATCH" && c.url.pathname.endsWith("/pulls/7"))).toBe(true);
  });

  it("requests reviewers after the PR exists", async () => {
    const { client, project, stub } = buildProject([
      { method: "GET", match: /\/pulls\?/, handler: () => ({ status: 200, body: [] }) },
      { method: "POST", match: /\/pulls$/, handler: () => ({ status: 201, body: rawPull }) },
      { method: "POST", match: /\/requested_reviewers$/, handler: () => ({ status: 201, body: {} }) },
    ]);

    await propose(client, project, {
      autoName: "first-auto",
      autoText: "{}",
      renderSvg: "<svg/>",
      body: "b",
      base: "main",
      reviewers: ["a-reviewer"],
    });

    const reviewerCall = stub.calls.find((c) => c.method === "POST" && c.url.pathname.endsWith("/requested_reviewers"));
    expect(reviewerCall?.body).toEqual({ reviewers: ["a-reviewer"] });
  });

  it("propagates MergeConflictError from the update-from-base step and never commits the auto", async () => {
    const stub = createFetchStub([
      { method: "GET", match: contentsGetPattern("zenith.json"), handler: () => ({ status: 200, body: { type: "file", path: "zenith.json", sha: "s", content: b64(JSON.stringify(linkJson)), encoding: "base64" } }) },
      { method: "GET", match: /\/user$/, handler: () => ({ status: 200, body: { login: "octocat", id: 1, name: null } }) },
      { method: "GET", match: /\/branches\/auto%2Ffirst-auto%2Foctocat$/, handler: () => ({ status: 200, body: { name: "auto/first-auto/octocat", commit: { sha: "worksha" }, protected: false } }) },
      { method: "POST", match: /\/merges$/, handler: () => ({ status: 409, body: { message: "Merge conflict" } }) },
      { method: "GET", match: /\/compare\/auto%2Ffirst-auto%2Foctocat\.\.\.main$/, handler: () => ({ status: 200, body: { merge_base_commit: { sha: "mb" } } }) },
      { method: "GET", match: /\/compare\/mb\.\.\.auto%2Ffirst-auto%2Foctocat$/, handler: () => ({ status: 200, body: { files: [{ filename: "autos/first-auto.auto.json" }] } }) },
      { method: "GET", match: /\/compare\/mb\.\.\.main$/, handler: () => ({ status: 200, body: { files: [{ filename: "autos/first-auto.auto.json" }] } }) },
    ]);
    const client = new GitHubClient(new PatAuth("t"), { fetchImpl: stub.fetchImpl, sleep: noSleep().sleep });
    const project = new GitHubProject(client, { owner: "o", repo: "r", base: "main" });

    await expect(
      propose(client, project, { autoName: "first-auto", autoText: "{}", renderSvg: "<svg/>", body: "b", base: "main" }),
    ).rejects.toThrow(MergeConflictError);
    expect(stub.calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("throws when called with a base that does not match the project's base", async () => {
    const { client, project } = buildProject([]);
    await expect(
      propose(client, project, { autoName: "first-auto", autoText: "{}", renderSvg: "<svg/>", body: "b", base: "other" }),
    ).rejects.toThrow(/bound to base "main"/);
  });
});
