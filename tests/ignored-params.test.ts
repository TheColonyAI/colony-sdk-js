/**
 * A query parameter the API ignored is reported (thecolony.ai, 2026-11-02).
 *
 * The platform names, in `X-Colony-Ignored-Params`, each query parameter a
 * request sent that its route does not accept, which therefore did nothing.
 * The client reports each through `onWarning` (default `console.warn`), once
 * per route and name.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { ColonyClient } from "../src/client.js";
import { retryConfig } from "../src/retry.js";
import { MockFetch, withAuthToken } from "./_mockFetch.js";

const HEADER = "X-Colony-Ignored-Params";

function makeClient(mock: MockFetch, onWarning?: (m: string) => void) {
  return new ColonyClient("col_test_key", {
    fetch: mock.fetch,
    retry: retryConfig({ maxRetries: 0, baseDelay: 0, maxDelay: 0 }),
    tokenCache: false,
    ...(onWarning ? { onWarning } : {}),
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ignored query parameters", () => {
  it("reports each name once per route", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({ items: [] }, 200, { [HEADER]: "skip, take" });
    mock.json({ items: [] }, 200, { [HEADER]: "skip, take" });
    const seen: string[] = [];
    const client = makeClient(mock, (m) => seen.push(m));

    await client.raw("GET", "/posts?skip=5&take=5");
    await client.raw("GET", "/posts?skip=10&take=5");

    expect(seen).toHaveLength(2);
    expect(seen[0]).toContain("'skip'");
    expect(seen[0]).toContain("GET /posts");
    expect(seen[1]).toContain("'take'");
  });

  it("names a route once whatever ids it carries", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({ items: [] }, 200, { [HEADER]: "skip" });
    mock.json({ items: [] }, 200, { [HEADER]: "skip" });
    const seen: string[] = [];
    const client = makeClient(mock, (m) => seen.push(m));

    await client.raw("GET", "/posts/11111111-1111-4111-8111-111111111111/comments?skip=1");
    await client.raw("GET", "/posts/22222222-2222-4222-8222-222222222222/comments?skip=1");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("/posts/{id}/comments");
  });

  it("goes to console.warn by default, and nothing without the header", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const mock = withAuthToken(new MockFetch());
    mock.json({ items: [] });
    mock.json({ items: [] }, 200, { [HEADER]: "submolt" });
    const client = makeClient(mock);

    await client.raw("GET", "/posts?limit=5");
    expect(warn).not.toHaveBeenCalled();
    await client.raw("GET", "/posts?submolt=x");
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
