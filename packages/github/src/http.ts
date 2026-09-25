import type { AuthProvider } from "./auth.js";
import { AuthError, ConflictError, GitHubError, NotFoundError, RateLimitError } from "./errors.js";

/** The last rate-limit snapshot the client saw, read off `x-ratelimit-*` response headers. */
export interface RateLimitSnapshot {
  limit: number;
  remaining: number;
  /** Epoch milliseconds. */
  resetAt: number;
}

export interface HttpOptions {
  apiBase?: string;
  fetchImpl?: typeof fetch;
  /** Retries for 429s and secondary-rate-limit 403s before giving up with `RateLimitError`. */
  maxRetries?: number;
  /** Base delay for the backoff used when GitHub gives no `Retry-After` header. */
  retryDelayMs?: number;
  /** Injectable so tests do not actually wait. Defaults to a real `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
}

export interface RequestOptions {
  method?: string;
  body?: unknown;
  query?: Record<string, string | number | undefined>;
  /** Extra headers, e.g. an `Accept` override for a raw-content fetch. */
  headers?: Record<string, string>;
}

const DEFAULT_API_BASE = "https://api.github.com";

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isSecondaryRateLimitBody(body: unknown): boolean {
  if (typeof body !== "object" || body === null) return false;
  const message = (body as { message?: unknown }).message;
  return typeof message === "string" && /secondary rate limit/i.test(message);
}

function parseRateLimit(headers: Headers): RateLimitSnapshot | null {
  const limit = headers.get("x-ratelimit-limit");
  const remaining = headers.get("x-ratelimit-remaining");
  const reset = headers.get("x-ratelimit-reset");
  if (limit === null || remaining === null || reset === null) return null;
  return {
    limit: Number(limit),
    remaining: Number(remaining),
    resetAt: Number(reset) * 1000,
  };
}

function retryDelayFromHeaders(headers: Headers, fallbackMs: number): number {
  const retryAfter = headers.get("retry-after");
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  }
  const reset = headers.get("x-ratelimit-reset");
  if (reset !== null) {
    const resetAt = Number(reset) * 1000;
    if (Number.isFinite(resetAt)) return Math.max(0, resetAt - Date.now());
  }
  return fallbackMs;
}

/**
 * The one place every `GitHubClient` method funnels through: attaches the bearer token, retries
 * 429s and secondary rate limits with backoff, and turns a non-2xx response into a typed error
 * (site/docs/github.md). Isomorphic: `fetch`, no Octokit, no Node APIs.
 */
export class HttpClient {
  readonly apiBase: string;
  private readonly auth: AuthProvider;
  private readonly fetchImpl: typeof fetch;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private lastRateLimit: RateLimitSnapshot | null = null;

  constructor(auth: AuthProvider, options: HttpOptions = {}) {
    this.auth = auth;
    this.apiBase = options.apiBase ?? DEFAULT_API_BASE;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.maxRetries = options.maxRetries ?? 3;
    this.retryDelayMs = options.retryDelayMs ?? 500;
    this.sleep = options.sleep ?? defaultSleep;
  }

  get rateLimit(): RateLimitSnapshot | null {
    return this.lastRateLimit;
  }

  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const { body } = await this.requestRaw(path, options);
    return body as T;
  }

  /** Like `request`, but also returns the response headers (pagination, ETags, raw byte counts). */
  async requestRaw(
    path: string,
    options: RequestOptions = {},
  ): Promise<{ status: number; body: unknown; headers: Headers }> {
    const token = await this.auth.token();
    const url = this.buildUrl(path, options.query);

    let attempt = 0;
    for (;;) {
      const response = await this.fetchImpl(url, {
        method: options.method ?? "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...options.headers,
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      });

      const rateLimit = parseRateLimit(response.headers);
      if (rateLimit) this.lastRateLimit = rateLimit;

      const parsedBody = await parseBody(response);

      const isRateLimited =
        response.status === 429 ||
        (response.status === 403 && (rateLimit?.remaining === 0 || isSecondaryRateLimitBody(parsedBody)));

      if (isRateLimited) {
        if (attempt >= this.maxRetries) {
          throw new RateLimitError(
            "GitHub's rate limit was hit and the retry budget ran out.",
            retryDelayFromHeaders(response.headers, this.retryDelayMs),
            response.status,
            parsedBody,
          );
        }
        const delay = retryDelayFromHeaders(response.headers, this.retryDelayMs * 2 ** attempt);
        await this.sleep(delay);
        attempt += 1;
        continue;
      }

      if (response.ok) {
        return { status: response.status, body: parsedBody, headers: response.headers };
      }

      throw errorFor(response.status, path, parsedBody);
    }
  }

  private buildUrl(path: string, query?: Record<string, string | number | undefined>): string {
    const url = new URL(path.startsWith("http") ? path : `${this.apiBase}${path}`);
    // `path` can be an absolute URL taken straight from a response's `Link: rel="next"` header
    // (`GitHubClient`'s `paginate`); the bearer token is attached to every request this method
    // builds a URL for, so an attacker-controlled `Link` header pointing off-host must never reach
    // `fetch` (site/docs/github.md).
    if (url.origin !== new URL(this.apiBase).origin) {
      throw new GitHubError(
        `Refusing to follow a URL whose origin (${url.origin}) is not this client's API base (${new URL(this.apiBase).origin}).`,
      );
    }
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }
}

async function parseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function messageOf(body: unknown, fallback: string): string {
  if (typeof body === "object" && body !== null && typeof (body as { message?: unknown }).message === "string") {
    return (body as { message: string }).message;
  }
  return fallback;
}

function errorFor(status: number, path: string, body: unknown): GitHubError {
  const message = messageOf(body, `GitHub returned ${status} for ${path}.`);
  if (status === 401 || status === 403) return new AuthError(message, status, body);
  if (status === 404) return new NotFoundError(message, status, body);
  if (status === 409 || status === 422) return new ConflictError(message, status, body);
  return new GitHubError(message, status, body);
}
