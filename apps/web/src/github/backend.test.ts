/**
 * The GitHub backend against a stubbed `fetch` (`fetchStub.ts`, the pattern packages/github tests use):
 * no network, and every request the backend makes is inspectable, which is how the never-write-base
 * guard and the commit-message rule of site/docs/github.md are held.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { canonicalize, loadWaypoints } from "@horizon36596/zenith-core";
import {
  BaseBranchWriteError,
  ConflictError,
  GitHubClient,
  GitHubProject,
  PatAuth,
  PathNotAllowedError,
} from "@horizon36596/zenith-github";
import { createFetchStub, noSleep, type StubRoute } from "./fetchStub";
import type { ProjectBackend } from "../project/backend";
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

  it("lists the project's preset files, and none when it has no presets folder (spec 15 section 6.5)", async () => {
    const presets: StubRoute = {
      method: "GET",
      match: contentsGet("autos/presets"),
      handler: () => ({
        status: 200,
        body: [
          { name: "Scouts.zenith-preset.json", path: "autos/presets/Scouts.zenith-preset.json", sha: "s", type: "file" },
          { name: "Drive team.zenith-preset.json", path: "autos/presets/Drive team.zenith-preset.json", sha: "d", type: "file" },
          { name: "README.md", path: "autos/presets/README.md", sha: "r", type: "file" },
          { name: "old.zenith-preset.json", path: "autos/presets/old.zenith-preset.json", sha: "o", type: "dir" },
        ],
      }),
    };
    const { backend } = build(baseRoutes([presets]));
    await backend.open();
    expect(await backend.listPresetFiles()).toEqual(["Drive team.zenith-preset.json", "Scouts.zenith-preset.json"]);
    expect((backend as ProjectBackend).writePresetFile, "GitHub mode never writes a preset").toBeUndefined();

    const missing: StubRoute = { method: "GET", match: contentsGet("autos/presets"), handler: () => ({ status: 404, body: { message: "Not Found" } }) };
    const bare = build(baseRoutes([missing])).backend;
    await bare.open();
    expect(await bare.listPresetFiles()).toEqual([]);
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

  it("reads the work branch's copy of an auto the first time it is opened (issue #407)", async () => {
    const edited = FIRST_AUTO.replace('"description": "', '"description": "Edited on the branch. ');
    expect(edited).not.toBe(FIRST_AUTO);
    const { backend, stub } = build(
      baseRoutes([fileRoute("autos/first-auto.auto.json", edited, "auto/first-auto/example-user")]),
    );
    await backend.open();
    const loaded = await backend.readAuto("first-auto.auto.json");

    const refs = stub.calls
      .filter((call) => call.url.pathname.endsWith("/contents/autos/first-auto.auto.json"))
      .map((call) => call.url.searchParams.get("ref"));
    expect(refs).toEqual(["auto/first-auto/example-user"]);
    expect(loaded.auto.description).toMatch(/^Edited on the branch\./);
  });

  it("reads a second auto from its own work branch, not the one the first auto left behind (issue #407)", async () => {
    const { backend, stub } = build(baseRoutes());
    await backend.open();
    await backend.readAuto("first-auto.auto.json");
    await backend.readAuto("collect-and-score.auto.json");

    const refs = stub.calls
      .filter((call) => call.url.pathname.endsWith("/contents/autos/collect-and-score.auto.json"))
      .map((call) => call.url.searchParams.get("ref"));
    expect(refs[0]).toBe("auto/collect-and-score/example-user");
    expect(refs).not.toContain("auto/first-auto/example-user");
    expect(backend.workBranch).toBe("auto/collect-and-score/example-user");
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

  it("does not pin the open auto's default branch for every other auto when the field is left as it was (issue #407)", async () => {
    const { backend } = build(baseRoutes());
    await backend.open();
    await backend.readAuto("first-auto.auto.json");
    backend.setBranch("auto/first-auto/example-user", "first-auto");
    await backend.readAuto("collect-and-score.auto.json");

    expect(backend.workBranch).toBe("auto/collect-and-score/example-user");
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

describe("GitHubBackend and waypoints.json (issue #134)", () => {
  const WORK = "auto/first-auto/example-user";
  const WAYPOINTS = example("autos/waypoints.json");
  const moved = WAYPOINTS.replace('"xIn": -13,\n      "yIn": -63', '"xIn": -36,\n      "yIn": -63');

  const workBranchExists: StubRoute = {
    method: "GET",
    match: /\/branches\/auto%2Ffirst-auto%2Fexample-user$/,
    handler: () => ({ status: 200, body: { name: WORK, commit: { sha: "s" }, protected: false } }),
  };

  it("draws an auto against the waypoints its work branch has", async () => {
    expect(moved).not.toBe(WAYPOINTS);
    const { backend } = build(baseRoutes([fileRoute("autos/waypoints.json", moved, WORK)]));
    await backend.open();
    const loaded = await backend.readAuto("first-auto.auto.json");
    expect(loaded.waypoints?.waypoints["start"]?.xIn).toBe(-36);
  });

  it("commits waypoints.json in canonical form to the auto's work branch, with the auto's message", async () => {
    const puts: { body: { message: string; branch: string; content: string }; path: string }[] = [];
    const { backend } = build(
      baseRoutes([
        workBranchExists,
        {
          method: "PUT",
          match: /\/contents\//,
          handler: (request) => {
            puts.push({ body: request.body as never, path: request.url.pathname });
            return { status: 200, body: { content: { sha: "blob" }, commit: { sha: "commit" } } };
          },
        },
      ]),
    );
    const project = await backend.open();
    await backend.readAuto("first-auto.auto.json");
    const waypoints = loadWaypoints(JSON.parse(moved));
    const text = await backend.writeWaypoints(waypoints, "first-auto.auto.json", "move the start");

    expect(text).toBe(canonicalize("waypoints", waypoints));
    expect(project.waypoints?.waypoints["start"]?.xIn).toBe(-13);
    expect(puts).toHaveLength(1);
    expect(puts[0]?.path).toMatch(/\/contents\/autos\/waypoints\.json$/);
    expect(puts[0]?.body).toMatchObject({ message: "auto(first-auto): move the start", branch: WORK });
    expect(Buffer.from(puts[0]?.body.content ?? "", "base64").toString("utf8")).toBe(text);
  });

  it("refuses waypoints.json outside the folders Zenith may write, and the base branch, before it sends anything", async () => {
    const link = JSON.parse(example("zenith.json")) as Record<string, unknown>;
    link["waypoints"] = "config/waypoints.json";
    const outside = build([
      fileRoute("zenith.json", JSON.stringify(link)),
      fileRoute("config/waypoints.json", WAYPOINTS),
      ...baseRoutes(),
    ]);
    await outside.backend.open();
    await outside.backend.readAuto("first-auto.auto.json");
    const waypoints = loadWaypoints(JSON.parse(WAYPOINTS));
    await expect(outside.backend.writeWaypoints(waypoints, "first-auto.auto.json")).rejects.toBeInstanceOf(PathNotAllowedError);

    const onBase = build(baseRoutes());
    await onBase.backend.open();
    onBase.backend.setBranch("main", "first-auto");
    await expect(onBase.backend.writeWaypoints(waypoints, "first-auto.auto.json")).rejects.toBeInstanceOf(BaseBranchWriteError);
    for (const { stub } of [outside, onBase]) {
      expect(stub.calls.some((call) => call.method === "PUT" || call.method === "POST" || /\/branches\//.test(call.url.pathname))).toBe(false);
    }
  });
});

describe("GitHubBackend and commits made since an auto was opened (issue #407)", () => {
  const WORK = "auto/first-auto/example-user";
  const path = "autos/first-auto.auto.json";

  function saving(branchSha: string) {
    const puts: { sha?: string }[] = [];
    let readsOfBranch = 0;
    const built = build(
      baseRoutes([
        {
          method: "GET",
          match: (url) => url.pathname.endsWith(`/contents/${path}`) && url.searchParams.get("ref") === WORK,
          handler: () => {
            // The first read is the editor opening it; the next is Save checking what is there now.
            readsOfBranch += 1;
            const sha = readsOfBranch === 1 ? "opened-sha" : branchSha;
            return { status: 200, body: { type: "file", path, sha, content: b64(FIRST_AUTO), encoding: "base64" } };
          },
        },
        {
          method: "GET",
          match: /\/branches\/auto%2Ffirst-auto%2Fexample-user$/,
          handler: () => ({ status: 200, body: { name: WORK, commit: { sha: "s" }, protected: false } }),
        },
        {
          method: "PUT",
          match: /\/contents\//,
          handler: (request) => {
            puts.push(request.body as { sha?: string });
            return { status: 200, body: { content: { sha: "saved-sha" }, commit: { sha: "commit" } } };
          },
        },
      ]),
    );
    return { ...built, puts };
  }

  it("refuses to write over a commit made on the work branch from somewhere else", async () => {
    const { backend, puts } = saving("someone-elses-sha");
    await backend.open();
    await backend.readAuto("first-auto.auto.json");

    const refused = await backend.save("first-auto.auto.json", FIRST_AUTO).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ConflictError);
    expect((refused as Error).message).toContain("since you opened it");
    expect(puts).toHaveLength(0);
  });

  it("saves over the copy it opened, then over its own commit", async () => {
    const { backend, puts } = saving("opened-sha");
    await backend.open();
    await backend.readAuto("first-auto.auto.json");
    await backend.save("first-auto.auto.json", FIRST_AUTO);

    expect(puts[0]?.sha).toBe("opened-sha");
    expect(backend.expectedShas(WORK)[path]).toBe("saved-sha");
  });
});
