/**
 * A hand-rolled `fetch` stub for the GitHub client's tests. No network, no msw: each test builds a
 * small table of routes (method + path matcher -> response), and every call is recorded so
 * assertions can check what the client actually sent (method, body, headers).
 */

export interface StubRequest {
  url: URL;
  method: string;
  body: unknown;
  headers: Record<string, string>;
}

export interface StubResponse {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface StubRoute {
  method: string;
  match: RegExp | ((url: URL) => boolean);
  handler: (request: StubRequest) => StubResponse | Promise<StubResponse>;
}

export interface FetchStub {
  fetchImpl: typeof fetch;
  calls: StubRequest[];
}

export function createFetchStub(routes: StubRoute[]): FetchStub {
  const calls: StubRequest[] = [];

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    const headers: Record<string, string> = {};
    if (init?.headers) {
      for (const [key, value] of new Headers(init.headers as HeadersInit).entries()) {
        headers[key.toLowerCase()] = value;
      }
    }
    const request: StubRequest = { url, method, body, headers };
    calls.push(request);

    for (const route of routes) {
      if (route.method !== method) continue;
      const path = url.pathname + url.search;
      const matches = route.match instanceof RegExp ? route.match.test(path) : route.match(url);
      if (!matches) continue;
      const result = await route.handler(request);
      const responseHeaders = new Headers(result.headers ?? {});
      const payload = result.body === undefined ? null : JSON.stringify(result.body);
      return new Response(payload, { status: result.status, headers: responseHeaders });
    }

    throw new Error(`fetchStub: no route matched ${method} ${url.toString()}`);
  }) as typeof fetch;

  return { fetchImpl, calls };
}

/** A `sleep` that resolves immediately but still records how long it was asked to wait. */
export function noSleep(): { sleep: (ms: number) => Promise<void>; delays: number[] } {
  const delays: number[] = [];
  return {
    sleep: async (ms: number) => {
      delays.push(ms);
    },
    delays,
  };
}
