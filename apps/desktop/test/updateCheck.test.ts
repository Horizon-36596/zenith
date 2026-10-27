import { describe, expect, it, vi } from "vitest";
import { LATEST_RELEASE_URL, RELEASES_PAGE, checkForUpdate, isNewer, parseVersion } from "../src/main/updateCheck.js";

const answer = (body: unknown, ok = true) => vi.fn(async () => ({ ok, json: async () => body }));

describe("the update check", () => {
  it("reads versions with or without a v, and nothing else", () => {
    expect(parseVersion("v0.1.2")).toEqual([0, 1, 2]);
    expect(parseVersion("0.10.0")).toEqual([0, 10, 0]);
    expect(parseVersion("0.1.2-beta.1")).toBeNull();
    expect(parseVersion("latest")).toBeNull();
  });

  it("compares versions by number", () => {
    expect(isNewer("v0.1.10", "0.1.9")).toBe(true);
    expect(isNewer("0.2.0", "0.1.9")).toBe(true);
    expect(isNewer("0.1.2", "0.1.2")).toBe(false);
    expect(isNewer("0.1.1", "0.1.2")).toBe(false);
    expect(isNewer("0.2.0-beta", "0.1.2")).toBe(false);
  });

  it("asks GitHub once, anonymously, and returns a newer release", async () => {
    const fetch = answer({ tag_name: "v0.2.0", html_url: `${RELEASES_PAGE}/tag/v0.2.0` });
    expect(await checkForUpdate("0.1.2", fetch)).toEqual({ version: "0.2.0", url: `${RELEASES_PAGE}/tag/v0.2.0` });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, { headers: Record<string, string> }];
    expect(url).toBe(LATEST_RELEASE_URL);
    expect(Object.keys(init.headers).map((key) => key.toLowerCase())).not.toContain("authorization");
  });

  it("says nothing for the same version, a pre-release, a failure or no network", async () => {
    expect(await checkForUpdate("0.2.0", answer({ tag_name: "v0.2.0" }))).toBeNull();
    expect(await checkForUpdate("0.1.2", answer({ tag_name: "v0.2.0", prerelease: true }))).toBeNull();
    expect(await checkForUpdate("0.1.2", answer({}, false))).toBeNull();
    const offline = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    expect(await checkForUpdate("0.1.2", offline)).toBeNull();
  });

  it("only ever links to the releases page", async () => {
    const found = await checkForUpdate("0.1.2", answer({ tag_name: "v0.2.0", html_url: "https://example.com/zenith.exe" }));
    expect(found).toEqual({ version: "0.2.0", url: RELEASES_PAGE });
  });
});
