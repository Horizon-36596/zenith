import { describe, expect, it } from "vitest";
import { BrowserTokenStore, MemoryTokenStore, NodeTokenStore, PatAuth, validateToken } from "../src/auth.js";
import { AuthError } from "../src/errors.js";
import { createFetchStub } from "./fetchStub.js";

describe("PatAuth", () => {
  it("resolves the token it was constructed with", async () => {
    const auth = new PatAuth("github_pat_abc123");
    await expect(auth.token()).resolves.toBe("github_pat_abc123");
  });

  it("refuses an empty token up front", () => {
    expect(() => new PatAuth("   ")).toThrow(AuthError);
  });

  it("finding 36: does not expose the token as an enumerable own property", () => {
    const auth = new PatAuth("github_pat_super_secret");
    expect(Object.keys(auth)).toEqual([]);
    expect(Object.getOwnPropertyNames(auth)).toEqual([]);
    expect(JSON.stringify(auth)).toBe("{}");
    expect(JSON.stringify({ auth })).not.toContain("github_pat_super_secret");
    for (const key in auth) {
      throw new Error(`unexpected enumerable key ${key} found via for...in`);
    }
  });
});

describe("validateToken", () => {
  it("returns the login and the scopes header for a classic-shaped token", async () => {
    const { fetchImpl } = createFetchStub([
      {
        method: "GET",
        match: /\/user$/,
        handler: () => ({
          status: 200,
          body: { login: "octocat" },
          headers: { "x-oauth-scopes": "repo, workflow" },
        }),
      },
    ]);

    const info = await validateToken(new PatAuth("t"), "https://api.github.com", fetchImpl);
    expect(info).toEqual({ login: "octocat", scopes: ["repo", "workflow"] });
  });

  it("reports an empty scope list for a fine-grained PAT, which sends no scopes header", async () => {
    const { fetchImpl } = createFetchStub([
      { method: "GET", match: /\/user$/, handler: () => ({ status: 200, body: { login: "octocat" } }) },
    ]);
    const info = await validateToken(new PatAuth("t"), "https://api.github.com", fetchImpl);
    expect(info.scopes).toEqual([]);
  });

  it("throws AuthError on 401", async () => {
    const { fetchImpl } = createFetchStub([
      { method: "GET", match: /\/user$/, handler: () => ({ status: 401, body: { message: "Bad credentials" } }) },
    ]);
    await expect(validateToken(new PatAuth("t"), "https://api.github.com", fetchImpl)).rejects.toThrow(AuthError);
  });
});

describe("MemoryTokenStore", () => {
  it("round-trips and clears", () => {
    const store = new MemoryTokenStore();
    expect(store.load()).toBeNull();
    store.save("abc");
    expect(store.load()).toBe("abc");
    store.clear();
    expect(store.load()).toBeNull();
  });
});

/** A minimal in-memory Storage so the test does not need a real browser. */
function fakeSessionStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
    clear: () => map.clear(),
    key: (index) => [...map.keys()][index] ?? null,
    get length() {
      return map.size;
    },
  };
}

describe("BrowserTokenStore", () => {
  it("mirrors saves to sessionStorage when persist is on", () => {
    const storage = fakeSessionStorage();
    const store = new BrowserTokenStore({ persist: true, storage });
    store.save("s3cret");
    expect(store.load()).toBe("s3cret");
    expect(storage.getItem("zenith.github.token")).toBe("s3cret");
    store.clear();
    expect(storage.getItem("zenith.github.token")).toBeNull();
  });

  it("never writes to localStorage-shaped storage when persist is off", () => {
    const storage = fakeSessionStorage();
    const store = new BrowserTokenStore({ persist: false, storage });
    store.save("s3cret");
    expect(store.load()).toBe("s3cret");
    expect(storage.getItem("zenith.github.token")).toBeNull();
  });

  it("picks up a token already sitting in storage from a previous page load", () => {
    const storage = fakeSessionStorage();
    storage.setItem("zenith.github.token", "already-there");
    const store = new BrowserTokenStore({ storage });
    expect(store.load()).toBe("already-there");
  });

  it("falls back to memory-only if storage throws", () => {
    const throwing: Storage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {},
      clear: () => {},
      key: () => null,
      length: 0,
    };
    const store = new BrowserTokenStore({ storage: throwing });
    expect(() => store.save("abc")).not.toThrow();
    expect(store.load()).toBe("abc");
  });
});

describe("NodeTokenStore", () => {
  it("is a no-op: nothing persists", () => {
    const store = new NodeTokenStore();
    store.save("abc");
    expect(store.load()).toBeNull();
    expect(() => store.clear()).not.toThrow();
  });
});
