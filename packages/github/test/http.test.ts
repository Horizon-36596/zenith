import { describe, expect, it } from "vitest";
import { PatAuth } from "../src/auth.js";
import { AuthError, ConflictError, GitHubError, NotFoundError, RateLimitError } from "../src/errors.js";
import { HttpClient } from "../src/http.js";
import { createFetchStub, noSleep } from "./fetchStub.js";

const auth = new PatAuth("t");

describe("HttpClient", () => {
  it("finding 3: refuses an absolute path whose origin is not the configured API base", async () => {
    const { fetchImpl, calls } = createFetchStub([
      { method: "GET", match: () => true, handler: () => ({ status: 200, body: { ok: true } }) },
    ]);
    const http = new HttpClient(auth, { fetchImpl });
    await expect(http.request("https://attacker.example/steal?p=2")).rejects.toThrow(GitHubError);
    // The refusal happens before any network call is made.
    expect(calls.length).toBe(0);
  });

  it("finding 3: still accepts an absolute URL that matches the configured API base", async () => {
    const { fetchImpl } = createFetchStub([
      { method: "GET", match: /\/ok$/, handler: () => ({ status: 200, body: { ok: true } }) },
    ]);
    const http = new HttpClient(auth, { fetchImpl });
    await expect(http.request("https://api.github.com/ok")).resolves.toEqual({ ok: true });
  });

  it("attaches the bearer token and the API version header", async () => {
    const { fetchImpl, calls } = createFetchStub([
      { method: "GET", match: /\/ok$/, handler: () => ({ status: 200, body: { ok: true } }) },
    ]);
    const http = new HttpClient(auth, { fetchImpl });
    await http.request("/ok");
    expect(calls[0]!.headers.authorization).toBe("Bearer t");
    expect(calls[0]!.headers["x-github-api-version"]).toBe("2022-11-28");
  });

  it("maps 404, 401 and 409 to typed errors", async () => {
    const { fetchImpl } = createFetchStub([
      { method: "GET", match: /\/missing$/, handler: () => ({ status: 404, body: { message: "Not Found" } }) },
      { method: "GET", match: /\/denied$/, handler: () => ({ status: 401, body: { message: "Bad credentials" } }) },
      { method: "GET", match: /\/clash$/, handler: () => ({ status: 409, body: { message: "sha mismatch" } }) },
    ]);
    const http = new HttpClient(auth, { fetchImpl });
    await expect(http.request("/missing")).rejects.toThrow(NotFoundError);
    await expect(http.request("/denied")).rejects.toThrow(AuthError);
    await expect(http.request("/clash")).rejects.toThrow(ConflictError);
  });

  it("retries a 429 with the Retry-After delay and then succeeds", async () => {
    const { sleep, delays } = noSleep();
    let attempts = 0;
    const { fetchImpl } = createFetchStub([
      {
        method: "GET",
        match: /\/flaky$/,
        handler: () => {
          attempts += 1;
          if (attempts === 1) return { status: 429, headers: { "retry-after": "2" } };
          return { status: 200, body: { ok: true } };
        },
      },
    ]);
    const http = new HttpClient(auth, { fetchImpl, sleep });
    const result = await http.request<{ ok: boolean }>("/flaky");
    expect(result).toEqual({ ok: true });
    expect(attempts).toBe(2);
    expect(delays).toEqual([2000]);
  });

  it("retries a secondary-rate-limit 403 and gives up as RateLimitError past the budget", async () => {
    const { sleep } = noSleep();
    const { fetchImpl } = createFetchStub([
      {
        method: "GET",
        match: /\/secondary$/,
        handler: () => ({
          status: 403,
          body: { message: "You have exceeded a secondary rate limit. Please retry later." },
        }),
      },
    ]);
    const http = new HttpClient(auth, { fetchImpl, sleep, maxRetries: 2 });
    await expect(http.request("/secondary")).rejects.toThrow(RateLimitError);
  });

  it("treats a 403 with ratelimit-remaining: 0 as a rate limit, not an auth failure", async () => {
    const { sleep } = noSleep();
    let attempts = 0;
    const { fetchImpl } = createFetchStub([
      {
        method: "GET",
        match: /\/exhausted$/,
        handler: () => {
          attempts += 1;
          const headers = { "x-ratelimit-remaining": "0", "x-ratelimit-limit": "60", "x-ratelimit-reset": "0" };
          if (attempts === 1) return { status: 403, headers };
          return { status: 200, body: { ok: true } };
        },
      },
    ]);
    const http = new HttpClient(auth, { fetchImpl, sleep });
    await expect(http.request("/exhausted")).resolves.toEqual({ ok: true });
    expect(attempts).toBe(2);
  });

  it("does not retry a plain 403 (a real auth failure)", async () => {
    const { sleep } = noSleep();
    let attempts = 0;
    const { fetchImpl } = createFetchStub([
      {
        method: "GET",
        match: /\/forbidden$/,
        handler: () => {
          attempts += 1;
          return { status: 403, body: { message: "Resource not accessible by personal access token" } };
        },
      },
    ]);
    const http = new HttpClient(auth, { fetchImpl, sleep });
    await expect(http.request("/forbidden")).rejects.toThrow(AuthError);
    expect(attempts).toBe(1);
  });

  it("exposes the last rate-limit snapshot it saw", async () => {
    const { fetchImpl } = createFetchStub([
      {
        method: "GET",
        match: /\/ok$/,
        handler: () => ({
          status: 200,
          body: { ok: true },
          headers: { "x-ratelimit-limit": "5000", "x-ratelimit-remaining": "4999", "x-ratelimit-reset": "1000" },
        }),
      },
    ]);
    const http = new HttpClient(auth, { fetchImpl });
    await http.request("/ok");
    expect(http.rateLimit).toEqual({ limit: 5000, remaining: 4999, resetAt: 1_000_000 });
  });
});
