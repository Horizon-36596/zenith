import { describe, expect, it } from "vitest";
import { PatAuth } from "../src/auth.js";
import { GitHubClient } from "../src/client.js";
import { BaseBranchWriteError, PathNotAllowedError } from "../src/errors.js";
import { GitHubProject } from "../src/project.js";
import { createFetchStub, noSleep } from "./fetchStub.js";

const linkJson = {
  $schema: "https://libraries.horizon36596.org/zenith/schema/v1/link.json",
  formatVersion: 1,
  autosDir: "autos",
  robot: "autos/robot.json",
  field: "autos/field.json",
  waypoints: "autos/waypoints.json",
  deploy: { kind: "directory", dir: "deploy" },
  codegen: { package: "org.example", dir: "codegen" },
};

function b64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

/** Matches a Contents-API GET for exactly `path`, with or without its `?ref=` query string. */
function contentsGetPattern(path: string): RegExp {
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`/contents/${escaped}(\\?|$)`);
}

function fileRoute(path: string, text: string) {
  return {
    method: "GET" as const,
    match: contentsGetPattern(path),
    handler: () => ({ status: 200, body: { type: "file", path, sha: `sha-${path}`, content: b64(text), encoding: "base64" } }),
  };
}

function buildProject(extraRoutes: Parameters<typeof createFetchStub>[0] = []) {
  const stub = createFetchStub([
    // Specific files first: the autos-directory listing route below is a looser match and must
    // not shadow them.
    fileRoute("zenith.json", JSON.stringify(linkJson)),
    fileRoute("autos/robot.json", '{"robot":true}'),
    fileRoute("autos/field.json", '{"field":true}'),
    fileRoute("autos/waypoints.json", '{"waypoints":true}'),
    ...extraRoutes,
    {
      method: "GET",
      match: contentsGetPattern("autos"),
      handler: () => ({
        status: 200,
        body: [
          { name: "first-auto.auto.json", path: "autos/first-auto.auto.json", sha: "s1", type: "file" },
          { name: "robot.json", path: "autos/robot.json", sha: "s2", type: "file" },
          { name: ".renders", path: "autos/.renders", sha: "s3", type: "dir" },
        ],
      }),
    },
  ]);
  const client = new GitHubClient(new PatAuth("t"), { fetchImpl: stub.fetchImpl, sleep: noSleep().sleep });
  const project = new GitHubProject(client, { owner: "o", repo: "r", base: "main" });
  return { project, stub };
}

describe("GitHubProject.open", () => {
  it("reads zenith.json, the robot/field/waypoints text, and lists *.auto.json under autosDir", async () => {
    const { project } = buildProject();
    const opened = await project.open();
    expect(opened.link.autosDir).toBe("autos");
    expect(opened.robotText).toBe('{"robot":true}');
    expect(opened.fieldText).toBe('{"field":true}');
    expect(opened.waypointsText).toBe('{"waypoints":true}');
    expect(opened.autos).toEqual([{ name: "first-auto", path: "autos/first-auto.auto.json" }]);
  });
});

describe("GitHubProject.workBranch", () => {
  it("reuses the branch when it already exists, without creating anything", async () => {
    const { project, stub } = buildProject([
      {
        method: "GET",
        match: /\/branches\/auto%2Ffirst-auto%2Foctocat$/,
        handler: () => ({ status: 200, body: { name: "auto/first-auto/octocat", commit: { sha: "existing" }, protected: false } }),
      },
    ]);
    const name = await project.workBranch("first-auto", "octocat");
    expect(name).toBe("auto/first-auto/octocat");
    expect(stub.calls.some((c) => c.method === "POST" && c.url.pathname.endsWith("/git/refs"))).toBe(false);
  });

  it("creates the branch from base when it does not exist yet", async () => {
    const { project, stub } = buildProject([
      {
        method: "GET",
        match: /\/branches\/auto%2Ffirst-auto%2Foctocat$/,
        handler: () => ({ status: 404, body: { message: "Branch not found" } }),
      },
      {
        method: "GET",
        match: /\/branches\/main$/,
        handler: () => ({ status: 200, body: { name: "main", commit: { sha: "main-sha" }, protected: true } }),
      },
      { method: "POST", match: /\/git\/refs$/, handler: () => ({ status: 201, body: {} }) },
    ]);
    const name = await project.workBranch("first-auto", "octocat");
    expect(name).toBe("auto/first-auto/octocat");
    const refCall = stub.calls.find((c) => c.url.pathname.endsWith("/git/refs"));
    expect(refCall?.body).toEqual({ ref: "refs/heads/auto/first-auto/octocat", sha: "main-sha" });
  });

  it("uses a custom branch name when one is given", () => {
    const { project } = buildProject();
    expect(project.workBranchName("first-auto", "octocat", "my-branch")).toBe("my-branch");
  });
});

describe("GitHubProject.save", () => {
  it("refuses to write to the base branch", async () => {
    const { project } = buildProject();
    await expect(project.save("main", "first-auto", "autos/first-auto.auto.json", "{}", "edit")).rejects.toThrow(
      BaseBranchWriteError,
    );
  });

  it("refuses a path outside autosDir/deploy.dir/codegen.dir", async () => {
    const { project } = buildProject();
    await expect(
      project.save("auto/first-auto/octocat", "first-auto", "TeamCode/Robot.java", "text", "edit"),
    ).rejects.toThrow(PathNotAllowedError);
  });

  it("allows a write under deploy.dir and under codegen.dir", async () => {
    const { project, stub } = buildProject([
      { method: "GET", match: contentsGetPattern("deploy/first-auto.json"), handler: () => ({ status: 404, body: { message: "Not Found" } }) },
      { method: "PUT", match: /\/contents\/deploy\/first-auto\.json$/, handler: () => ({ status: 201, body: { content: { sha: "s" }, commit: { sha: "c" } } }) },
      { method: "GET", match: contentsGetPattern("codegen/First-auto.java"), handler: () => ({ status: 404, body: { message: "Not Found" } }) },
      { method: "PUT", match: /\/contents\/codegen\/First-auto\.java$/, handler: () => ({ status: 201, body: { content: { sha: "s" }, commit: { sha: "c" } } }) },
    ]);
    await project.save("auto/first-auto/octocat", "first-auto", "deploy/first-auto.json", "{}", "deploy");
    await project.save("auto/first-auto/octocat", "first-auto", "codegen/First-auto.java", "// code", "codegen");
    expect(stub.calls.filter((c) => c.method === "PUT")).toHaveLength(2);
  });

  it("writes the commit message as auto(<name>): <summary>, defaulting to 'edit'", async () => {
    const { project, stub } = buildProject([
      { method: "GET", match: contentsGetPattern("autos/first-auto.auto.json"), handler: () => ({ status: 404, body: { message: "Not Found" } }) },
      { method: "PUT", match: /\/contents\/autos\/first-auto\.auto\.json$/, handler: () => ({ status: 201, body: { content: { sha: "s" }, commit: { sha: "c" } } }) },
    ]);
    await project.save("auto/first-auto/octocat", "first-auto", "autos/first-auto.auto.json", "{}");
    const put = stub.calls.find((c) => c.method === "PUT");
    expect(put?.body).toMatchObject({ message: "auto(first-auto): edit" });

    await project.save("auto/first-auto/octocat", "first-auto", "autos/first-auto.auto.json", "{}", "move the park pose");
    const secondPut = stub.calls.filter((c) => c.method === "PUT")[1];
    expect(secondPut?.body).toMatchObject({ message: "auto(first-auto): move the park pose" });
  });

  it("passes the existing file's sha when updating, and omits it when creating", async () => {
    const { project, stub } = buildProject([
      {
        method: "GET",
        match: contentsGetPattern("autos/first-auto.auto.json"),
        handler: () => ({ status: 200, body: { type: "file", path: "autos/first-auto.auto.json", sha: "old-sha", content: b64("{}"), encoding: "base64" } }),
      },
      { method: "PUT", match: /\/contents\/autos\/first-auto\.auto\.json$/, handler: () => ({ status: 200, body: { content: { sha: "new-sha" }, commit: { sha: "c" } } }) },
    ]);
    await project.save("auto/first-auto/octocat", "first-auto", "autos/first-auto.auto.json", "{}", "edit");
    const put = stub.calls.find((c) => c.method === "PUT");
    expect(put?.body).toMatchObject({ sha: "old-sha" });
  });
});
