/**
 * Client ergonomics — GET response cache, circuit breaker, request/response
 * hooks.
 *
 * These are the last of the Python-parity backlog, and unlike every other
 * cohort they are not endpoint wrappers: they change the behaviour of the
 * shared request path that all 300+ methods go through. So the tests below care
 * less about shapes and more about the properties that make them safe:
 *
 * - a cache hit makes **no request at all** (the only thing that proves it is a
 *   cache rather than a fast path);
 * - a write **clears** the cache, because guessing which GETs a write
 *   invalidates is how a cache starts serving stale data that looks fresh;
 * - the breaker counts **logical calls**, not network attempts, so a retried
 *   request does not trip it N times;
 * - a single success **closes** the breaker;
 * - the request hook fires **per attempt**, which is what makes it useful for
 *   observing retries rather than hiding them.
 *
 * Each of those is a negative or a count, which no shape assertion would catch.
 */

import { describe, expect, it } from "vitest";

import { ColonyClient } from "../src/client.js";
import { ColonyNetworkError } from "../src/errors.js";
import { retryConfig } from "../src/retry.js";

import { MockFetch, withAuthToken } from "./_mockFetch.js";

function makeClient(mock: MockFetch, retries = 0) {
  return new ColonyClient("col_test_key", {
    fetch: mock.fetch,
    retry: retryConfig({ maxRetries: retries, baseDelay: 0, maxDelay: 0 }),
    tokenCache: false,
  });
}

describe("response cache", () => {
  it("serves a repeat GET without making a request", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({ username: "a" });
    const c = makeClient(mock);
    c.enableCache();

    const first = await c.getMe();
    const callsAfterFirst = mock.calls.length;
    const second = await c.getMe();

    expect(second).toEqual(first);
    // The whole point: no second network call. A queued-but-unused handler
    // would also have thrown "no handler queued" if it had tried.
    expect(mock.calls.length).toBe(callsAfterFirst);
  });

  it("is off by default", async () => {
    // The control for the test above — without it, "no second call" could be
    // any other coincidence.
    const mock = withAuthToken(new MockFetch());
    mock.json({ username: "a" });
    mock.json({ username: "a" });
    const c = makeClient(mock);

    await c.getMe();
    await c.getMe();
    expect(mock.calls.length).toBe(3); // auth + two live GETs
  });

  it("keys on the full path, so different queries do not collide", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({ items: [1] });
    mock.json({ items: [2] });
    const c = makeClient(mock);
    c.enableCache();

    const a = await c.getPosts({ limit: 1 });
    const b = await c.getPosts({ limit: 2 });
    expect(a).not.toEqual(b);
  });

  it("expires entries after the TTL", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({ username: "a" });
    mock.json({ username: "b" });
    const c = makeClient(mock);
    c.enableCache(1); // 1ms

    await c.getMe();
    await new Promise((r) => setTimeout(r, 5));
    const second = await c.getMe();

    expect(second).toEqual({ username: "b" });
  });

  it("a write clears the whole cache", async () => {
    // Blunt on purpose: without a server-side dependency map, invalidating
    // only the "related" GETs is a guess, and a wrong guess serves stale data
    // that looks fresh.
    const mock = withAuthToken(new MockFetch());
    mock.json({ username: "before" });
    mock.json({ id: "p1" }); // the write
    mock.json({ username: "after" });
    const c = makeClient(mock);
    c.enableCache();

    expect(await c.getMe()).toEqual({ username: "before" });
    await c.votePost("p1", 1);
    expect(await c.getMe()).toEqual({ username: "after" });
  });

  it("writes are never cached themselves", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({ ok: 1 });
    mock.json({ ok: 2 });
    const c = makeClient(mock);
    c.enableCache();

    const a = await c.votePost("p1", 1);
    const b = await c.votePost("p1", 1);
    expect(a).not.toEqual(b);
  });

  it("clearCache() drops entries but leaves caching on", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({ username: "a" });
    mock.json({ username: "b" });
    mock.json({ username: "ignored-if-still-cached" });
    const c = makeClient(mock);
    c.enableCache();

    await c.getMe();
    c.clearCache();
    expect(await c.getMe()).toEqual({ username: "b" });
    // Still caching: this third read is served from the entry just stored.
    expect(await c.getMe()).toEqual({ username: "b" });
  });

  it("enableCache(0) disables and drops what was cached", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({ username: "a" });
    mock.json({ username: "b" });
    const c = makeClient(mock);
    c.enableCache();
    await c.getMe();

    c.enableCache(0);
    expect(await c.getMe()).toEqual({ username: "b" });
  });
});

describe("circuit breaker", () => {
  it("opens after the threshold and stops hitting the network", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({ detail: { message: "boom", code: "X" } }, 500);
    mock.json({ detail: { message: "boom", code: "X" } }, 500);
    const c = makeClient(mock);
    c.enableCircuitBreaker(2);

    await expect(c.getMe()).rejects.toThrow();
    await expect(c.getMe()).rejects.toThrow();
    const callsBefore = mock.calls.length;

    await expect(c.getMe()).rejects.toThrow(ColonyNetworkError);
    // The third call never reached fetch.
    expect(mock.calls.length).toBe(callsBefore);
  });

  it("names itself in the error so the failure is diagnosable", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({ detail: { message: "boom", code: "X" } }, 500);
    const c = makeClient(mock);
    c.enableCircuitBreaker(1);
    await expect(c.getMe()).rejects.toThrow();

    await expect(c.getMe()).rejects.toThrow(/[Cc]ircuit breaker open/);
  });

  it("a single success closes it", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({ detail: { message: "boom", code: "X" } }, 500);
    mock.json({ username: "a" });
    mock.json({ detail: { message: "boom", code: "X" } }, 500);
    const c = makeClient(mock);
    c.enableCircuitBreaker(2);

    await expect(c.getMe()).rejects.toThrow();
    await expect(c.getMe()).resolves.toEqual({ username: "a" });
    // Counter reset, so one more failure must NOT open it.
    await expect(c.getMe()).rejects.toThrow();
    expect(await c.getMe().catch((e: Error) => e.message)).not.toMatch(/[Cc]ircuit breaker open/);
  });

  it("counts logical calls, not network attempts", async () => {
    // A retried request must not trip a threshold-2 breaker by itself, or
    // enabling retries would silently make the breaker far more sensitive.
    const mock = withAuthToken(new MockFetch());
    mock.json({ detail: { message: "boom", code: "X" } }, 503);
    mock.json({ detail: { message: "boom", code: "X" } }, 503);
    mock.json({ username: "a" });
    const c = makeClient(mock, 1); // one retry: 2 network attempts per call
    c.enableCircuitBreaker(2);

    await expect(c.getMe()).rejects.toThrow(); // 2 attempts, 1 logical failure
    // If attempts were counted, the breaker would be open and this would be a
    // ColonyNetworkError instead of a live success.
    await expect(c.getMe()).resolves.toEqual({ username: "a" });
  });

  it("is off by default", async () => {
    const mock = withAuthToken(new MockFetch());
    for (let i = 0; i < 6; i++) mock.json({ detail: { message: "boom", code: "X" } }, 500);
    const c = makeClient(mock);

    for (let i = 0; i < 6; i++) {
      await expect(c.getMe()).rejects.not.toThrow(/[Cc]ircuit breaker open/);
    }
  });

  it("enableCircuitBreaker(0) disables and resets", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({ detail: { message: "boom", code: "X" } }, 500);
    mock.json({ detail: { message: "boom", code: "X" } }, 500);
    const c = makeClient(mock);
    c.enableCircuitBreaker(1);
    await expect(c.getMe()).rejects.toThrow();

    c.enableCircuitBreaker(0);
    // Would be a breaker error if it were still armed.
    await expect(c.getMe()).rejects.not.toThrow(/[Cc]ircuit breaker open/);
  });
});

describe("hooks", () => {
  it("onRequest sees method, url and body", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({ id: "p1" });
    const c = makeClient(mock);
    const seen: Array<[string, string, unknown]> = [];
    c.onRequest((m, u, b) => seen.push([m, u, b]));

    await c.votePost("p1", 1);

    const vote = seen.find(([, u]) => u.includes("/vote"));
    expect(vote?.[0]).toBe("POST");
    expect(vote?.[2]).toEqual({ value: 1 });
  });

  it("onResponse sees the status and parsed body", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({ username: "a" });
    const c = makeClient(mock);
    const seen: Array<[number, unknown]> = [];
    c.onResponse((_m, _u, status, data) => seen.push([status, data]));

    await c.getMe();

    expect(seen.some(([s, d]) => s === 200 && JSON.stringify(d).includes("username"))).toBe(true);
  });

  it("onRequest fires per ATTEMPT, so retries are visible", async () => {
    // The design decision worth pinning: a hook that fired once per logical
    // call would hide exactly the behaviour people add hooks to observe.
    const mock = withAuthToken(new MockFetch());
    mock.json({ detail: { message: "boom", code: "X" } }, 503);
    mock.json({ username: "a" });
    const c = makeClient(mock, 1);
    let meCalls = 0;
    c.onRequest((_m, u) => {
      if (u.includes("/users/me")) meCalls += 1;
    });

    await c.getMe();
    expect(meCalls).toBe(2);
  });

  it("neither hook fires on a cache hit", async () => {
    // No request was made, so reporting one would be a lie.
    const mock = withAuthToken(new MockFetch());
    mock.json({ username: "a" });
    const c = makeClient(mock);
    c.enableCache();
    await c.getMe();

    let reqs = 0;
    let resps = 0;
    c.onRequest(() => (reqs += 1));
    c.onResponse(() => (resps += 1));
    await c.getMe();

    expect(reqs).toBe(0);
    expect(resps).toBe(0);
  });

  it("onResponse does not fire for a failure", async () => {
    // Scoped to the failing call: the internal /auth/token exchange succeeds
    // and legitimately fires the hook, which is what the next test is about.
    const mock = withAuthToken(new MockFetch());
    mock.json({ detail: { message: "boom", code: "X" } }, 500);
    const c = makeClient(mock);
    let meResponses = 0;
    c.onResponse((_m, u) => {
      if (u.includes("/users/me")) meResponses += 1;
    });

    await expect(c.getMe()).rejects.toThrow();
    expect(meResponses).toBe(0);
  });

  it("hooks see the internal /auth/token exchange, API key and all", async () => {
    // Not a leak in the SDK, but a real consequence for anyone logging bodies
    // wholesale — so it is documented on onRequest and pinned here rather than
    // left for someone to discover in their log aggregator.
    const mock = withAuthToken(new MockFetch());
    mock.json({ username: "a" });
    const c = makeClient(mock);
    const bodies: unknown[] = [];
    c.onRequest((_m, u, b) => {
      if (u.includes("/auth/token")) bodies.push(b);
    });

    await c.getMe();

    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toEqual({ api_key: "col_test_key" });
  });

  it("supports several hooks, in registration order", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({ username: "a" });
    const c = makeClient(mock);
    const order: string[] = [];
    c.onRequest(() => order.push("first"));
    c.onRequest(() => order.push("second"));

    await c.getMe();
    expect(order.slice(0, 2)).toEqual(["first", "second"]);
  });
});
