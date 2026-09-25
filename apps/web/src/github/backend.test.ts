/**
 * The GitHub backend against a stubbed `fetch` (`fetchStub.ts`, the pattern packages/github tests use):
 * no network, and every request the backend makes is inspectable, which is how the never-write-base
 * guard and the commit-message rule of site/docs/github.md are held.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { canonicalize } from "@horizon36596/zenith-core";
import { BaseBranchWriteError, GitHubClient, GitHubProject, PatAuth } from "@horizon36596/zenith-github";
import { createFetchStub, noSleep, type StubRoute } from "./fetchStub";
import { GitHubBackend } from "./backend";

const example = (path: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../../examples/starter/${path}`, import.meta.url)), "utf8");

const b64 = (text: string): string => Buffer.from(text, "utf8").toString("base64");

const contentsGet = (path: string): RegExp =>
  new RegExp(`/contents/${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\?|$)`);

function fileRoute(path: string, text: string, ref?: string): StubRoute {
  return {
    method: "GET",
    match: (url) =>
      contentsGet(path).test(url.pathname + url.search) &&
      (ref === undefined || url.searchParams.get("ref") === ref),
    handler: () => ({
      status: 200,
      body: { type: "file", path, sha: `sha-${path}`, content: b64(text), encoding: "base64" },
    }),
  };
}

const FIRST_AUTO = example("autos/first-auto.auto.json");

/** The five files `zenith.json` names, at the base branch, plus the autos listing. */
function baseRoutes(extra: StubRoute[] = []): StubRoute[] {
  return [
    ...extra,
    fileRoute("zenith.json", example("zenith.json")),
    fileRoute("autos/robot.json", example("autos/robot.json")),
    fileRoute("autos/field/biobuzz.field.json", example("autos/field/biobuzz.field.json")),
    fileRoute("autos/waypoints.json", example("autos/waypoints.json")),
    fileRoute("autos/first-auto.auto.json", FIRST_AUTO),
    fileRoute("autos/collect-and-score.auto.json", example("autos/collect-and-score.auto.json")),
    {
      method: "GET",
      match: contentsGet("autos"),
      handler: () => ({
        status: 200,
        body: [
          { name: "first-auto.auto.json", path: "autos/first-auto.auto.json", sha: "a", type: "file" },
          { name: "collect-and-score.auto.json", path: "autos/collect-and-score.auto.json", sha: "b", type: "file" },
          { name: "robot.json", path: "autos/robot.json", sha: "c", type: "file" },
        ],
      }),
    },
  ];
}

function build(routes: StubRoute[]) {
  const stub = createFetchStub(routes);
  const client = new GitHubClient(new PatAuth("token"), {
    fetchImpl: stub.fetchImpl,
    sleep: noSleep,
  });
  const project = new GitHubProject(client, { owner: "example-team", repo: "robot", base: "main" });
  const branches: string[] = [];
  const backend = new GitHubBackend({
    client,
    project,
    login: "example-user",
    onBranch: (branch) => branches.push(branch),
  });
  return { stub, backend, branches };
}

describe("GitHubBackend", () => {
  it("opens the repository as the project the editor already knows", async () => {
    const { backend } = build(baseRoutes());
    const project = await backend.open();

    expect(backend.kind).toBe("github");
    expect(backend.canPropose).toBe(true);
    expect(project.name).toBe("example-team/robot");
    expect(project.source).toMatchObject({ kind: "github", base: "main", branch: "main" });
    // Only the autos, named the way the local backend names them, and sorted.
    expect(project.autoFiles).toEqual(["collect-and-score.auto.json", "first-auto.auto.json"]);
    expect(project.robot.kinematics.maxForwardVelInPerS.value).toBeGreaterThan(0);
  });

  it("names the work branch auto/<auto>/<login> when an auto is opened", async () => {
    const { backend, branches } = build(baseRoutes());
    await backend.open();
    const loaded = await backend.readAuto("first-auto.auto.json");

    expect(loaded.auto.name).toBe("first-auto");
    expect(loaded.canonical).toBe(canonicalize("auto", loaded.auto));
    expect(backend.workBranch).toBe("auto/first-auto/example-user");
    expect(branches).toContain("auto/first-auto/example-user");
  });

  it("reads the work branch's copy of an auto when the branch already has one", async () => {
    const edited = FIRST_AUTO.replace('"title"', '"title"');
    const { backend, stub } = build(
      baseRoutes([fileRoute("autos/first-auto.auto.json", edited, "auto/first-auto/example-user")]),
    );
    await backend.open();
    await backend.readAuto("first-auto.auto.json");
    await backend.readAuto("first-auto.auto.json");

    const refs = stub.calls
      .filter((call) => call.url.pathname.endsWith("/contents/autos/first-auto.auto.json"))
      .map((call) => call.url.searchParams.get("ref"));
    expect(refs[0]).toBe("main");
    expect(refs[1]).toBe("auto/first-auto/example-user");
  });

  it("commits to the work branch, creating it from the base, with 06's message", async () => {
    const created: unknown[] = [];
    const puts: { body: unknown; path: string }[] = [];
    const { backend } = build(
      baseRoutes([
        {
          method: "GET",
          match: /\/branches\/auto%2Ffirst-auto%2Fexample-user$/,
          handler: () => ({ status: 404, body: { message: "Branch not found" } }),
        },
        {
          method: "GET",
          match: /\/branches\/main$/,
          handler: () => ({ status: 200, body: { name: "main", commit: { sha: "base-sha" }, protected: false } }),
        },
        {
          method: "POST",
          match: /\/git\/refs$/,
          handler: (request) => {
            created.push(request.body);
            return { status: 201, body: {} };
          },
        },
        {
          method: "PUT",
          match: /\/contents\//,
          handler: (request) => {
            puts.push({ body: request.body, path: request.url.pathname });
            return { status: 200, body: { content: { sha: "blob-sha" }, commit: { sha: "commit-sha" } } };
          },
        },
      ]),
    );
    await backend.open();
    await backend.readAuto("first-auto.auto.json");
    const result = await backend.save("first-auto.auto.json", FIRST_AUTO, "drive out further");

    expect(created).toEqual([{ ref: "refs/heads/auto/first-auto/example-user", sha: "base-sha" }]);
    expect(puts).toHaveLength(1);
    expect(puts[0]?.body).toMatchObject({
      message: "auto(first-auto): drive out further",
      branch: "auto/first-auto/example-user",
    });
    expect(result.commitSha).toBe("commit-sha");
    expect(result.note).toContain("auto/first-auto/example-user");
  });

  it("defaults the summary to edit, which is the rule's own default", async () => {
    const puts: unknown[] = [];
    const { backend } = build(
      baseRoutes([
        {
          method: "GET",
          match: /\/branches\/work$/,
          handler: () => ({ status: 200, body: { name: "work", commit: { sha: "s" }, protected: false } }),
        },
        {
          method: "PUT",
          match: /\/contents\//,
          handler: (request) => {
            puts.push(request.body);
            return { status: 200, body: { content: { sha: "blob" }, commit: { sha: "commit" } } };
          },
        },
      ]),
    );
    await backend.open();
    backend.setBranch("work", "first-auto");
    await backend.save("first-auto.auto.json", FIRST_AUTO);

    expect(puts[0]).toMatchObject({ message: "auto(first-auto): edit", branch: "work" });
  });

  it("refuses to write to the base branch before it sends anything", async () => {
    const { backend, stub } = build(baseRoutes());
    await backend.open();
    backend.setBranch("main", "first-auto");

    await expect(backend.save("first-auto.auto.json", FIRST_AUTO)).rejects.toBeInstanceOf(
      BaseBranchWriteError,
    );
    expect(stub.calls.some((call) => call.method === "PUT")).toBe(false);
  });

  it("goes back to the default branch name when the typed one is cleared", async () => {
    const { backend } = build(baseRoutes());
    await backend.open();
    backend.setBranch("my-branch", "first-auto");
    expect(backend.workBranch).toBe("my-branch");

    backend.setBranch("  ", "first-auto");
    expect(backend.workBranch).toBe("auto/first-auto/example-user");
  });
});
