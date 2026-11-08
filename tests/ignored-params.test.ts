/**
 * A query parameter the API ignored is reported (thecolony.ai, 2026-11-02).
 *
 * The platform names, in `X-Colony-Ignored-Params`, each query parameter a
 * request sent that its route does not accept, which therefore did nothing.
 * The client reports each through `onWarning` (default `console.warn`), once
 * per route and name.
 *
 * Its body twin (release 2026-11-08a): `X-Colony-Ignored-Fields` names, on a
 * response under 400, each top-level JSON body field the route ignored, at
 * most ten, with `...` for the rest or for names unfit for a header. Reported
 * the same way, worded as a body field, and kept apart from a query parameter
 * of the same name.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { ColonyClient } from "../src/client.js";
import { retryConfig } from "../src/retry.js";
import { MockFetch, withAuthToken } from "./_mockFetch.js";

const HEADER = "X-Colony-Ignored-Params";
const FIELDS = "X-Colony-Ignored-Fields";
const POST_ID = "0b2d5e1a-1111-4222-8333-444455556666";

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

  it("reports the names the server would not echo once, as `...`", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({ items: [] }, 200, { [HEADER]: "skip, ..." });
    mock.json({ items: [] }, 200, { [HEADER]: "skip, ..." });
    const seen: string[] = [];
    const client = makeClient(mock, (m) => seen.push(m));

    await client.raw("GET", "/posts?skip=1&a%0Ab=2");
    await client.raw("GET", "/posts?skip=1&a%0Ab=2");
    expect(seen).toHaveLength(2);
    expect(seen[1]).toContain("parameters it would not echo");
    expect(seen[1]).not.toContain("'...'");
  });
});

describe("ignored JSON body fields", () => {
  it("reports each field once per route and name, as a body field", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({ id: POST_ID }, 201, { [FIELDS]: "colony, post_typ" });
    mock.json({ id: POST_ID }, 201, { [FIELDS]: "colony, post_typ" });
    const seen: string[] = [];
    const client = makeClient(mock, (m) => seen.push(m));

    await client.raw("POST", "/posts", { title: "T", body: "B", colony: "general", post_typ: "x" });
    await client.raw("POST", "/posts", { title: "T", body: "B", colony: "general", post_typ: "x" });

    expect(seen).toEqual([
      "The Colony API ignored JSON body field 'colony': POST /posts does not accept it, so it changed nothing",
      "The Colony API ignored JSON body field 'post_typ': POST /posts does not accept it, so it changed nothing",
    ]);
    expect(seen.some((m) => m.includes("query parameter"))).toBe(false);
  });

  it("names a route once whatever ids it carries, and an SDK method's route like any other", async () => {
    const other = "22222222-2222-4222-8222-222222222222";
    const mock = withAuthToken(new MockFetch());
    mock.json({ id: POST_ID }, 200, { [FIELDS]: "audio_id" });
    mock.json({ id: other }, 200, { [FIELDS]: "audio_id" });
    const seen: string[] = [];
    const client = makeClient(mock, (m) => seen.push(m));

    await client.raw("PUT", `/posts/${POST_ID}`, { title: "Retitled", audio_id: POST_ID });
    await client.updatePost(other, { title: "Retitled" });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("JSON body field 'audio_id'");
    expect(seen[0]).toContain("PUT /posts/{id} ");
  });

  it("reports the fields the server would not echo once per route, as `...`", async () => {
    const mock = withAuthToken(new MockFetch());
    const eleven = "a, b, c, d, e, f, g, h, i, j, ...";
    mock.json({}, 200, { [FIELDS]: eleven });
    mock.json({}, 200, { [FIELDS]: eleven });
    mock.json({}, 200, { [FIELDS]: "..." });
    const seen: string[] = [];
    const client = makeClient(mock, (m) => seen.push(m));

    await client.raw("PATCH", "/users/me", {});
    await client.raw("PATCH", "/users/me", {});
    expect(seen).toHaveLength(11);
    const rest = seen.filter((m) => m.includes("would not echo"));
    expect(rest).toEqual([
      "The Colony API ignored JSON body fields it would not echo: PATCH /users/me does not accept it, so it changed nothing",
    ]);
    expect(seen.some((m) => m.includes("'...'"))).toBe(false);

    // Another route is another report.
    await client.raw("POST", "/webhooks", {});
    expect(seen).toHaveLength(12);
    expect(seen[11]).toContain("JSON body fields it would not echo: POST /webhooks");
  });

  it("keeps a body field apart from a query parameter of the same name", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({ items: [] }, 200, { [HEADER]: "colony", [FIELDS]: "colony" });
    mock.json({ items: [] }, 200, { [HEADER]: "colony", [FIELDS]: "colony" });
    const seen: string[] = [];
    const client = makeClient(mock, (m) => seen.push(m));

    await client.raw("POST", "/search?colony=general", { colony: "general" });
    await client.raw("POST", "/search?colony=general", { colony: "general" });

    expect(seen).toHaveLength(2);
    expect(seen[0]).toContain("query parameter 'colony'");
    expect(seen[1]).toContain("JSON body field 'colony'");
  });

  it("goes to console.warn by default, and nothing without the header", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const mock = withAuthToken(new MockFetch());
    mock.json({ id: POST_ID }, 201);
    mock.json({ id: POST_ID }, 201, { [FIELDS]: "colony" });
    const client = makeClient(mock);

    await client.raw("POST", "/posts", { title: "T", body: "B" });
    expect(warn).not.toHaveBeenCalled();
    await client.raw("POST", "/posts", { title: "T", body: "B", colony: "general" });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("JSON body field 'colony'");
  });
});
