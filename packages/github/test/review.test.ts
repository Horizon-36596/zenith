import { SCHEMA_ID } from "@horizon36596/zenith-schema";
import { describe, expect, it } from "vitest";
import { PatAuth } from "../src/auth.js";
import { GitHubClient } from "../src/client.js";
import { GitHubProject } from "../src/project.js";
import { diffAnchor, diffFileHash, lineAnchor, loadReview } from "../src/review.js";
import { createFetchStub, noSleep } from "./fetchStub.js";

/** A minimal, valid v1 auto, canonicalized by hand (two-space indent) so lineAnchor has real lines. */
function auto(stepId: string): string {
  const doc = {
    $schema: SCHEMA_ID.auto,
    formatVersion: 1,
    name: "first-auto",
    alliance: "RED",
    start: { pose: { xIn: -40, yIn: -63, headingRad: 1.5708 } },
    steps: [
      {
        id: stepId,
        kind: "path",
        segments: [{ kind: "line", from: "current", to: { xIn: -40, yIn: -40 } }],
        heading: { mode: "tangent" },
      },
    ],
  };
  return JSON.stringify(doc, null, 2) + "\n";
}

describe("lineAnchor", () => {
  it("finds the 1-based line holding a step's id", () => {
    const text = auto("driveOut");
    const line = lineAnchor(text, "driveOut");
    expect(line).not.toBeNull();
    expect(text.split("\n")[line! - 1]).toContain('"id": "driveOut"');
  });

  it("returns null for a step id that is not in the file", () => {
    expect(lineAnchor(auto("driveOut"), "nope")).toBeNull();
  });
});

describe("diffFileHash", () => {
  it("is the sha256 hex of the path, the way GitHub computes its diff anchors", async () => {
    // Cross-checked against `sha256sum` on the same literal string.
    await expect(diffFileHash("autos/first-auto.auto.json")).resolves.toBe(
      "25b6688284a2dfee93b45cd9a2081f3dfe68eaf50fd92b44becd6661326f84fc",
    );
  });

  it("is deterministic and path-sensitive", async () => {
    const a = await diffFileHash("autos/a.auto.json");
    const b = await diffFileHash("autos/b.auto.json");
    expect(a).not.toBe(b);
    await expect(diffFileHash("autos/a.auto.json")).resolves.toBe(a);
  });
});

describe("diffAnchor", () => {
  it("combines the path hash and the line into a #diff-<hash>R<line> anchor", async () => {
    const text = auto("driveOut");
    const anchor = await diffAnchor("autos/first-auto.auto.json", text, "driveOut", "head");
    const hash = await diffFileHash("autos/first-auto.auto.json");
    const line = lineAnchor(text, "driveOut");
    expect(anchor).toBe(`#diff-${hash}R${line}`);
  });

  it("uses L for the base side", async () => {
    const text = auto("driveOut");
    const anchor = await diffAnchor("autos/first-auto.auto.json", text, "driveOut", "base");
    expect(anchor).toMatch(/L\d+$/);
  });

  it("returns null when the step id is not found", async () => {
    await expect(diffAnchor("p", auto("driveOut"), "missing")).resolves.toBeNull();
  });
});

function contentsGetPattern(path: string): RegExp {
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`/contents/${escaped}(\\?|$)`);
}

function b64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

const rawPull = {
  number: 7,
  url: "https://api.github.com/repos/o/r/pulls/7",
  html_url: "https://github.com/o/r/pull/7",
  state: "open" as const,
  title: "first-auto",
  body: "body",
  head: { ref: "auto/first-auto/octocat", sha: "headsha" },
  base: { ref: "main", sha: "basesha" },
};

function buildProject(routes: Parameters<typeof createFetchStub>[0]) {
  const stub = createFetchStub(routes);
  const client = new GitHubClient(new PatAuth("t"), { fetchImpl: stub.fetchImpl, sleep: noSleep().sleep });
  const project = new GitHubProject(client, { owner: "o", repo: "r", base: "main" });
  return { client, project, stub };
}

describe("loadReview", () => {
  it("loads base and head text for the one changed *.auto.json file", async () => {
    const baseText = auto("driveOut");
    const headText = auto("driveOut-moved");
    const { client, project } = buildProject([
      { method: "GET", match: /\/pulls\/7$/, handler: () => ({ status: 200, body: rawPull }) },
      { method: "GET", match: /\/pulls\/7\/files/, handler: () => ({ status: 200, body: [{ filename: "autos/first-auto.auto.json", status: "modified", sha: "s" }] }) },
      {
        method: "GET",
        match: (url) => url.pathname.endsWith("/contents/autos/first-auto.auto.json") && url.searchParams.get("ref") === "headsha",
        handler: () => ({ status: 200, body: { type: "file", path: "autos/first-auto.auto.json", sha: "h", content: b64(headText), encoding: "base64" } }),
      },
      {
        method: "GET",
        match: (url) => url.pathname.endsWith("/contents/autos/first-auto.auto.json") && url.searchParams.get("ref") === "basesha",
        handler: () => ({ status: 200, body: { type: "file", path: "autos/first-auto.auto.json", sha: "b", content: b64(baseText), encoding: "base64" } }),
      },
    ]);

    const review = await loadReview(client, project, "https://github.com/o/r/pull/7");
    expect(review.head?.steps[0]?.id).toBe("driveOut-moved");
    expect(review.base?.steps[0]?.id).toBe("driveOut");
    expect(review.files).toEqual(["autos/first-auto.auto.json"]);
    expect(review.prMeta.number).toBe(7);
  });

  it("accepts a bare PR number too", async () => {
    const text = auto("driveOut");
    const { client, project } = buildProject([
      { method: "GET", match: /\/pulls\/7$/, handler: () => ({ status: 200, body: rawPull }) },
      { method: "GET", match: /\/pulls\/7\/files/, handler: () => ({ status: 200, body: [{ filename: "autos/first-auto.auto.json", status: "modified", sha: "s" }] }) },
      { method: "GET", match: contentsGetPattern("autos/first-auto.auto.json"), handler: () => ({ status: 200, body: { type: "file", path: "autos/first-auto.auto.json", sha: "s", content: b64(text), encoding: "base64" } }) },
    ]);
    const review = await loadReview(client, project, 7);
    expect(review.head?.steps[0]?.id).toBe("driveOut");
  });

  it("leaves base null when the auto file was added by this PR", async () => {
    const headText = auto("driveOut");
    const { client, project } = buildProject([
      { method: "GET", match: /\/pulls\/7$/, handler: () => ({ status: 200, body: rawPull }) },
      { method: "GET", match: /\/pulls\/7\/files/, handler: () => ({ status: 200, body: [{ filename: "autos/first-auto.auto.json", status: "added", sha: "s" }] }) },
      { method: "GET", match: contentsGetPattern("autos/first-auto.auto.json"), handler: () => ({ status: 200, body: { type: "file", path: "autos/first-auto.auto.json", sha: "s", content: b64(headText), encoding: "base64" } }) },
    ]);
    const review = await loadReview(client, project, 7);
    expect(review.base).toBeNull();
  });

  it("throws when no *.auto.json file changed", async () => {
    const { client, project } = buildProject([
      { method: "GET", match: /\/pulls\/7$/, handler: () => ({ status: 200, body: rawPull }) },
      { method: "GET", match: /\/pulls\/7\/files/, handler: () => ({ status: 200, body: [{ filename: "README.md", status: "modified", sha: "s" }] }) },
    ]);
    await expect(loadReview(client, project, 7)).rejects.toThrow(/does not change any/);
  });

  it("throws when more than one *.auto.json file changed", async () => {
    const { client, project } = buildProject([
      { method: "GET", match: /\/pulls\/7$/, handler: () => ({ status: 200, body: rawPull }) },
      {
        method: "GET",
        match: /\/pulls\/7\/files/,
        handler: () => ({
          status: 200,
          body: [
            { filename: "autos/a.auto.json", status: "modified", sha: "s" },
            { filename: "autos/b.auto.json", status: "modified", sha: "s" },
          ],
        }),
      },
    ]);
    await expect(loadReview(client, project, 7)).rejects.toThrow(/expects exactly one/);
  });

  it("rejects a PR URL for a different repository", async () => {
    const { client, project } = buildProject([]);
    await expect(loadReview(client, project, "https://github.com/other/repo/pull/7")).rejects.toThrow(/other\/repo/);
  });
});
