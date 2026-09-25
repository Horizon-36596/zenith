import type { Link } from "@horizon36596/zenith-schema";
import { describe, expect, it } from "vitest";
import { PatAuth } from "../src/auth.js";
import { GitHubClient } from "../src/client.js";
import { BaseBranchWriteError, MergeConflictError, NotFoundError, PathNotAllowedError } from "../src/errors.js";
import { createFetchStub, noSleep } from "./fetchStub.js";

/** A minimal Link, just enough for assertPathAllowed to have autosDir/deploy/codegen to check. */
const testLink: Link = {
  $schema: "https://libraries.horizon36596.org/zenith/schema/v1/link.json",
  formatVersion: 1,
  autosDir: "autos",
  robot: "autos/robot.json",
  field: "autos/field/field.json",
};

function client(routes: Parameters<typeof createFetchStub>[0]) {
  const stub = createFetchStub(routes);
  return { client: new GitHubClient(new PatAuth("t"), { fetchImpl: stub.fetchImpl, sleep: noSleep().sleep }), stub };
}

describe("GitHubClient.repos", () => {
  it("get() maps the raw repo shape", async () => {
    const { client: c } = client([
      {
        method: "GET",
        match: /\/repos\/horizon-36596\/zenith$/,
        handler: () => ({
          status: 200,
          body: {
            name: "zenith",
            full_name: "horizon-36596/zenith",
            owner: { login: "horizon-36596" },
            default_branch: "main",
            private: true,
            html_url: "https://github.com/horizon-36596/zenith",
          },
        }),
      },
    ]);
    const repo = await c.repos.get("horizon-36596", "zenith");
    expect(repo).toEqual({
      owner: "horizon-36596",
      repo: "zenith",
      fullName: "horizon-36596/zenith",
      defaultBranch: "main",
      private: true,
      htmlUrl: "https://github.com/horizon-36596/zenith",
    });
  });

  it("listWritable() keeps only push-permitted repos and follows pagination", async () => {
    const page1 = [
      { name: "a", full_name: "me/a", owner: { login: "me" }, default_branch: "main", private: false, html_url: "u", permissions: { push: true } },
      { name: "b", full_name: "me/b", owner: { login: "me" }, default_branch: "main", private: false, html_url: "u", permissions: { push: false } },
    ];
    const page2 = [
      { name: "c", full_name: "me/c", owner: { login: "me" }, default_branch: "main", private: false, html_url: "u", permissions: { push: true } },
    ];
    const { client: c } = client([
      {
        method: "GET",
        match: (url) => url.pathname === "/user/repos" && !url.searchParams.has("page"),
        handler: () => ({ status: 200, body: page1, headers: { link: '<https://api.github.com/user/repos?page=2>; rel="next"' } }),
      },
      {
        method: "GET",
        match: (url) => url.pathname === "/user/repos" && url.searchParams.get("page") === "2",
        handler: () => ({ status: 200, body: page2 }),
      },
    ]);
    const repos = await c.repos.listWritable();
    expect(repos.map((r) => r.repo)).toEqual(["a", "c"]);
  });

  it("finding 3: refuses to follow a Link: rel=\"next\" header pointing at another host", async () => {
    const page1 = [
      { name: "a", full_name: "me/a", owner: { login: "me" }, default_branch: "main", private: false, html_url: "u", permissions: { push: true } },
    ];
    const { client: c, stub } = client([
      {
        method: "GET",
        match: (url) => url.pathname === "/user/repos",
        handler: () => ({
          status: 200,
          body: page1,
          headers: { link: '<https://attacker.example/steal?p=2>; rel="next"' },
        }),
      },
      // If the client ever did follow the attacker Link, this route would answer it; the test
      // asserts below that it is never called.
      { method: "GET", match: () => true, handler: () => ({ status: 200, body: [] }) },
    ]);
    await expect(c.repos.listWritable()).rejects.toThrow(/attacker\.example|origin/i);
    expect(stub.calls.some((call) => call.url.origin === "https://attacker.example")).toBe(false);
  });

  it("merge() surfaces a conflict as MergeConflictError naming the overlapping files", async () => {
    const { client: c } = client([
      {
        method: "POST",
        match: /\/merges$/,
        handler: () => ({ status: 409, body: { message: "Merge conflict" } }),
      },
      {
        method: "GET",
        match: /\/compare\/work\.\.\.main$/,
        handler: () => ({ status: 200, body: { merge_base_commit: { sha: "base-sha" } } }),
      },
      {
        method: "GET",
        match: /\/compare\/base-sha\.\.\.work$/,
        handler: () => ({ status: 200, body: { merge_base_commit: { sha: "base-sha" }, files: [{ filename: "autos/a.auto.json" }, { filename: "autos/b.auto.json" }] } }),
      },
      {
        method: "GET",
        match: /\/compare\/base-sha\.\.\.main$/,
        handler: () => ({ status: 200, body: { merge_base_commit: { sha: "base-sha" }, files: [{ filename: "autos/b.auto.json" }] } }),
      },
    ]);
    const error = await c.repos.merge("o", "r", "work", "main").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MergeConflictError);
    expect((error as InstanceType<typeof MergeConflictError>).files).toEqual(["autos/b.auto.json"]);
  });

  it("merge() reports no-op merges (204) as merged: false", async () => {
    const { client: c } = client([{ method: "POST", match: /\/merges$/, handler: () => ({ status: 204 }) }]);
    await expect(c.repos.merge("o", "r", "work", "main")).resolves.toEqual({ commitSha: null, merged: false });
  });

  it("finding 12: merge() refuses to write to the base branch when a guard is given", async () => {
    const { client: c, stub } = client([{ method: "POST", match: /\/merges$/, handler: () => ({ status: 204 }) }]);
    await expect(c.repos.merge("o", "r", "main", "some-branch", { base: "main" })).rejects.toThrow(
      BaseBranchWriteError,
    );
    expect(stub.calls.length).toBe(0);
  });

  it("finding 12: merge() without a guard behaves exactly as before (backward compatible)", async () => {
    const { client: c } = client([{ method: "POST", match: /\/merges$/, handler: () => ({ status: 204 }) }]);
    await expect(c.repos.merge("o", "r", "main", "some-branch")).resolves.toEqual({ commitSha: null, merged: false });
  });
});

describe("GitHubClient.branches", () => {
  it("create() reads the source branch's sha and POSTs a new ref, never a force update", async () => {
    const { client: c, stub } = client([
      {
        method: "GET",
        match: /\/branches\/main$/,
        handler: () => ({ status: 200, body: { name: "main", commit: { sha: "main-sha" }, protected: true } }),
      },
      {
        method: "POST",
        match: /\/git\/refs$/,
        handler: () => ({ status: 201, body: { ref: "refs/heads/auto/first-auto/octocat" } }),
      },
    ]);
    const branch = await c.branches.create("o", "r", "auto/first-auto/octocat", { branch: "main" });
    expect(branch).toEqual({ name: "auto/first-auto/octocat", sha: "main-sha", protected: false });
    const refCall = stub.calls.find((call) => call.url.pathname.endsWith("/git/refs"));
    expect(refCall?.body).toEqual({ ref: "refs/heads/auto/first-auto/octocat", sha: "main-sha" });
  });

  it("get() throws NotFoundError for a missing branch", async () => {
    const { client: c } = client([
      { method: "GET", match: /\/branches\/ghost$/, handler: () => ({ status: 404, body: { message: "Branch not found" } }) },
    ]);
    await expect(c.branches.get("o", "r", "ghost")).rejects.toThrow(NotFoundError);
  });
});

describe("GitHubClient.contents", () => {
  it("get() decodes UTF-8 base64 content and returns the sha", async () => {
    const text = '{"name":"café"}\n';
    const content = Buffer.from(text, "utf8").toString("base64");
    const { client: c } = client([
      {
        method: "GET",
        match: /\/contents\/autos\/a\.auto\.json/,
        handler: () => ({ status: 200, body: { type: "file", path: "autos/a.auto.json", sha: "filesha", content, encoding: "base64" } }),
      },
    ]);
    const file = await c.contents.get("o", "r", "autos/a.auto.json", "main");
    expect(file).toEqual({ path: "autos/a.auto.json", sha: "filesha", text });
  });

  it("put() base64-encodes the text and sends the branch and sha", async () => {
    const { client: c, stub } = client([
      {
        method: "PUT",
        match: /\/contents\/autos\/a\.auto\.json/,
        handler: () => ({ status: 200, body: { content: { sha: "newsha" }, commit: { sha: "commitsha" } } }),
      },
    ]);
    const result = await c.contents.put("o", "r", "autos/a.auto.json", "hello", "auto(a): edit", "work", "oldsha");
    expect(result).toEqual({ sha: "newsha", commitSha: "commitsha" });
    const call = stub.calls[0]!;
    expect(call.body).toMatchObject({ message: "auto(a): edit", branch: "work", sha: "oldsha" });
    expect(Buffer.from((call.body as { content: string }).content, "base64").toString("utf8")).toBe("hello");
  });

  it("put() omits sha for a new file", async () => {
    const { client: c, stub } = client([
      {
        method: "PUT",
        match: /\/contents\//,
        handler: () => ({ status: 201, body: { content: { sha: "s" }, commit: { sha: "c" } } }),
      },
    ]);
    await c.contents.put("o", "r", "autos/new.auto.json", "x", "auto(new): edit", "work");
    expect(stub.calls[0]!.body).not.toHaveProperty("sha");
  });

  it("list() maps directory entries", async () => {
    const { client: c } = client([
      {
        method: "GET",
        match: /\/contents\/autos(\?|$)/,
        handler: () => ({
          status: 200,
          body: [
            { name: "a.auto.json", path: "autos/a.auto.json", sha: "s1", type: "file" },
            { name: ".renders", path: "autos/.renders", sha: "s2", type: "dir" },
          ],
        }),
      },
    ]);
    const entries = await c.contents.list("o", "r", "autos", "main");
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({ name: "a.auto.json", path: "autos/a.auto.json", sha: "s1", type: "file" });
  });

  it("deleteFile() sends the sha and branch", async () => {
    const { client: c, stub } = client([
      { method: "DELETE", match: /\/contents\/autos\/old\.auto\.json/, handler: () => ({ status: 200, body: {} }) },
    ]);
    await c.contents.deleteFile("o", "r", "autos/old.auto.json", "remove old", "work", "sha1");
    expect(stub.calls[0]!.body).toEqual({ message: "remove old", sha: "sha1", branch: "work" });
  });

  // finding 12: the never-write-base guard and the path allowlist used to live only in
  // GitHubProject.save, above the client. These prove a *raw* GitHubClient.contents.put/deleteFile
  // call — not routed through GitHubProject at all — is refused the same way, as long as it passes
  // the same guard GitHubProject always does.
  it("finding 12: put() refuses a write to the base branch even called raw, with a guard", async () => {
    const { client: c, stub } = client([
      { method: "PUT", match: /\/contents\//, handler: () => ({ status: 200, body: { content: { sha: "s" }, commit: { sha: "c" } } }) },
    ]);
    await expect(
      c.contents.put("o", "r", "autos/a.auto.json", "hello", "msg", "main", undefined, { base: "main", link: testLink }),
    ).rejects.toThrow(BaseBranchWriteError);
    expect(stub.calls.length).toBe(0);
  });

  it("finding 12: put() refuses a path outside the allowlist even called raw, with a guard", async () => {
    const { client: c, stub } = client([
      { method: "PUT", match: /\/contents\//, handler: () => ({ status: 200, body: { content: { sha: "s" }, commit: { sha: "c" } } }) },
    ]);
    await expect(
      c.contents.put("o", "r", "README.md", "hello", "msg", "work", undefined, { base: "main", link: testLink }),
    ).rejects.toThrow(PathNotAllowedError);
    expect(stub.calls.length).toBe(0);
  });

  it("finding 12: put() without a guard behaves exactly as before (backward compatible)", async () => {
    const { client: c } = client([
      { method: "PUT", match: /\/contents\//, handler: () => ({ status: 200, body: { content: { sha: "s" }, commit: { sha: "c" } } }) },
    ]);
    await expect(c.contents.put("o", "r", "README.md", "hello", "msg", "main")).resolves.toEqual({
      sha: "s",
      commitSha: "c",
    });
  });

  it("finding 12: deleteFile() refuses a write to the base branch, with a guard", async () => {
    const { client: c, stub } = client([
      { method: "DELETE", match: /\/contents\//, handler: () => ({ status: 200, body: {} }) },
    ]);
    await expect(
      c.contents.deleteFile("o", "r", "autos/a.auto.json", "msg", "main", "sha1", { base: "main", link: testLink }),
    ).rejects.toThrow(BaseBranchWriteError);
    expect(stub.calls.length).toBe(0);
  });

  it("finding 12: deleteFile() refuses a path outside the allowlist, with a guard", async () => {
    const { client: c, stub } = client([
      { method: "DELETE", match: /\/contents\//, handler: () => ({ status: 200, body: {} }) },
    ]);
    await expect(
      c.contents.deleteFile("o", "r", "README.md", "msg", "work", "sha1", { base: "main", link: testLink }),
    ).rejects.toThrow(PathNotAllowedError);
    expect(stub.calls.length).toBe(0);
  });
});

describe("GitHubClient.git.mergeBase", () => {
  it("reads merge_base_commit.sha from the compare endpoint", async () => {
    const { client: c } = client([
      { method: "GET", match: /\/compare\/main\.\.\.work$/, handler: () => ({ status: 200, body: { merge_base_commit: { sha: "mb" } } }) },
    ]);
    await expect(c.git.mergeBase("o", "r", "main", "work")).resolves.toBe("mb");
  });

  it("returns null when either ref is missing", async () => {
    const { client: c } = client([
      { method: "GET", match: /\/compare\//, handler: () => ({ status: 404, body: { message: "Not Found" } }) },
    ]);
    await expect(c.git.mergeBase("o", "r", "main", "ghost")).resolves.toBeNull();
  });
});

describe("GitHubClient.pulls", () => {
  const rawPull = {
    number: 7,
    url: "https://api.github.com/repos/o/r/pulls/7",
    html_url: "https://github.com/o/r/pull/7",
    state: "open",
    title: "first-auto",
    body: "body",
    head: { ref: "auto/first-auto/octocat", sha: "headsha" },
    base: { ref: "main", sha: "basesha" },
  };

  it("create() posts title/head/base/body", async () => {
    const { client: c, stub } = client([
      { method: "POST", match: /\/pulls$/, handler: () => ({ status: 201, body: rawPull }) },
    ]);
    const pr = await c.pulls.create("o", "r", { title: "first-auto", head: "auto/first-auto/octocat", base: "main", body: "body" });
    expect(pr.number).toBe(7);
    expect(pr.htmlUrl).toBe("https://github.com/o/r/pull/7");
    expect(stub.calls[0]!.body).toEqual({ title: "first-auto", head: "auto/first-auto/octocat", base: "main", body: "body" });
  });

  it("update() patches the given fields", async () => {
    const { client: c } = client([
      { method: "PATCH", match: /\/pulls\/7$/, handler: () => ({ status: 200, body: { ...rawPull, body: "new body" } }) },
    ]);
    const pr = await c.pulls.update("o", "r", 7, { body: "new body" });
    expect(pr.body).toBe("new body");
  });

  it("listForBranch() filters by head and state", async () => {
    const { client: c, stub } = client([
      { method: "GET", match: /\/pulls\?/, handler: () => ({ status: 200, body: [rawPull] }) },
    ]);
    const prs = await c.pulls.listForBranch("o", "r", "auto/first-auto/octocat", "open");
    expect(prs).toHaveLength(1);
    expect(stub.calls[0]!.url.searchParams.get("head")).toBe("o:auto/first-auto/octocat");
    expect(stub.calls[0]!.url.searchParams.get("state")).toBe("open");
  });

  it("files() maps the changed-file list", async () => {
    const { client: c } = client([
      {
        method: "GET",
        match: /\/pulls\/7\/files/,
        handler: () => ({ status: 200, body: [{ filename: "autos/a.auto.json", status: "modified", sha: "s" }] }),
      },
    ]);
    const files = await c.pulls.files("o", "r", 7);
    expect(files).toEqual([{ filename: "autos/a.auto.json", status: "modified", sha: "s", patch: undefined }]);
  });

  it("requestReviewers() posts the reviewer list and no-ops on an empty list", async () => {
    const { client: c, stub } = client([
      { method: "POST", match: /\/requested_reviewers$/, handler: () => ({ status: 201, body: {} }) },
    ]);
    await c.pulls.requestReviewers("o", "r", 7, ["reviewer1"]);
    expect(stub.calls).toHaveLength(1);
    await c.pulls.requestReviewers("o", "r", 7, []);
    expect(stub.calls).toHaveLength(1);
  });
});

describe("GitHubClient.users", () => {
  it("me() maps login/id/name", async () => {
    const { client: c } = client([
      { method: "GET", match: /\/user$/, handler: () => ({ status: 200, body: { login: "octocat", id: 1, name: "The Octocat" } }) },
    ]);
    await expect(c.users.me()).resolves.toEqual({ login: "octocat", id: 1, name: "The Octocat" });
  });
});
