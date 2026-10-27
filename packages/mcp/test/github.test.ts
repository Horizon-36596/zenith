import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { editDemo, makeRepo, removeTemplates, TOKEN, type TestRepo } from "../../cli/test/gitHubHarness.js";
import { createServer } from "../src/server.js";

/**
 * The GitHub tools in process, against a real git clone whose origin is a local bare repository
 * and a fake api.github.com: setup, status, then propose, the way an agent in a fresh clone calls
 * them. Nothing here reaches GitHub or the real GitHub CLI.
 */

vi.setConfig({ testTimeout: 60_000 });

let repos: TestRepo[] = [];
afterEach(() => {
  for (const repo of repos) repo.cleanup();
  repos = [];
});
afterAll(removeTemplates);

async function connect(t: TestRepo): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createServer({ github: t.deps }).connect(serverSide);
  const client = new Client({ name: "zenith-mcp-github-test", version: "0.0.0" });
  await client.connect(clientSide);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<{ isError: boolean; text: string; value: Record<string, unknown> }> {
  const result = (await client.callTool({ name, arguments: args })) as { content: { type: string; text: string }[]; isError?: boolean };
  const text = result.content.find((item) => item.type === "text")?.text ?? "";
  let value: Record<string, unknown> = {};
  try {
    value = JSON.parse(text) as Record<string, unknown>;
  } catch {
    value = {};
  }
  return { isError: result.isError === true, text, value };
}

describe("the GitHub tools", () => {
  it("setup, status, then propose opens the pull request, and the token never shows", async () => {
    const t = makeRepo({ github: { zenithOnMain: true } });
    repos.push(t);
    const client = await connect(t);
    try {
      const setup = await call(client, "zenith.setup", { project: t.repo });
      expect(setup.isError).toBe(false);
      expect(setup.value.ok).toBe(true);
      expect(setup.value.next).toContain("zenith propose");

      const status = await call(client, "zenith.github.status", { project: t.repo });
      expect(status.value).toMatchObject({ ok: true, login: "octocat", defaultBranch: "main", auth: "GH_TOKEN" });

      editDemo(t.repo, 0.6);
      const proposed = await call(client, "zenith.propose", { auto: "demo", project: t.repo, summary: "slower start" });
      expect(proposed.isError).toBe(false);
      expect(proposed.value).toMatchObject({
        ok: true,
        branch: "auto/demo/octocat",
        pullRequest: { number: 1, url: "https://github.com/o/r/pull/1", created: true },
      });
      expect(t.git(["log", "--format=%s", "-1", "refs/heads/auto/demo/octocat"], t.remote)).toBe("auto(demo): slower start");

      for (const text of [setup.text, status.text, proposed.text]) expect(text).not.toContain(TOKEN);
      for (const request of t.github.calls) expect(request.url.origin).toBe("https://api.github.com");
      expect(readFileSync(join(t.repo, ".mcp.json"), "utf8")).not.toContain(TOKEN);
    } finally {
      await client.close();
    }
  });

  it("a propose that cannot go ahead is a tool error naming the next step", async () => {
    const t = makeRepo({ env: { GH_TOKEN: undefined } });
    repos.push(t);
    const client = await connect(t);
    try {
      editDemo(t.repo, 0.6);
      const proposed = await call(client, "zenith.propose", { auto: "demo", project: t.repo });
      expect(proposed.isError).toBe(true);
      expect(proposed.value.next).toContain("gh auth login");
      expect(t.remoteRev("refs/heads/auto/demo/octocat")).toBeNull();
    } finally {
      await client.close();
    }
  });

  it("refuses an auto outside the project", async () => {
    const t = makeRepo();
    repos.push(t);
    const client = await connect(t);
    try {
      const proposed = await call(client, "zenith.propose", { auto: "../../outside.auto.json", project: t.repo });
      expect(proposed.isError).toBe(true);
      expect(proposed.text).toContain("outside the project root");
    } finally {
      await client.close();
    }
  });

  it("dryRun returns the body and touches neither git nor GitHub", async () => {
    const t = makeRepo();
    repos.push(t);
    const client = await connect(t);
    try {
      const proposed = await call(client, "zenith.propose", { auto: "demo", project: t.repo, dryRun: true });
      expect(proposed.isError).toBe(false);
      expect(proposed.value.render).toBe("autos/.renders/demo.svg");
      expect(String(proposed.value.body)).toContain("## demo");
      expect(t.github.calls).toEqual([]);
    } finally {
      await client.close();
    }
  });
});
