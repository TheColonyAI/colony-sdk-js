/**
 * Conditional reads: a kept answer is revalidated with `If-None-Match`.
 *
 * The API sends an ETag on some reads (a post's comments, for any caller,
 * since 2026-11-02). The client keeps the body under its ETag, sends the tag
 * back on the next read of the same URL, and answers a `304 Not Modified`
 * with the kept body, exactly as the 200 returned it.
 */
import { describe, expect, it } from "vitest";

import { ColonyClient } from "../src/client.js";
import { retryConfig } from "../src/retry.js";
import { MockFetch, withAuthToken } from "./_mockFetch.js";

const POST_ID = "9cb7ff7d-51a0-46c6-acd2-d731164c792a";
const PAGE = { items: [{ id: "c1", body: "first" }], total: 1, page: 1, has_more: false };
const ETAG = 'W/"0123456789abcdef"';

function makeClient(mock: MockFetch, revalidate?: boolean) {
  return new ColonyClient("col_test_key", {
    fetch: mock.fetch,
    retry: retryConfig({ maxRetries: 0, baseDelay: 0, maxDelay: 0 }),
    tokenCache: false,
    ...(revalidate === undefined ? {} : { revalidate }),
  });
}

function notModified(): (call: unknown) => Response {
  return () => new Response(null, { status: 304, headers: { ETag: ETAG } });
}

describe("conditional reads", () => {
  it("returns the kept answer on a 304", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json(PAGE, 200, { ETag: ETAG });
    mock.respond(notModified());
    const client = makeClient(mock);

    const first = await client.getComments(POST_ID);
    expect(client.lastResponseNotModified).toBe(false);
    const again = await client.getComments(POST_ID);

    expect(mock.calls[1]?.headers["if-none-match"]).toBeUndefined();
    expect(mock.calls[2]?.headers["if-none-match"]).toBe(ETAG);
    expect(again).toEqual(first);
    expect(again).toEqual(PAGE);
    expect(client.lastResponseNotModified).toBe(true);
  });

  it("parses the kept answer again, so changing one result cannot change the next", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json(PAGE, 200, { ETag: ETAG });
    mock.respond(notModified());
    const client = makeClient(mock);

    (await client.getComments(POST_ID)).items.length = 0;
    expect(await client.getComments(POST_ID)).toEqual(PAGE);
  });

  it("replaces the kept answer when it changed", async () => {
    const mock = withAuthToken(new MockFetch());
    const newer = { ...PAGE, total: 2 };
    mock.json(PAGE, 200, { ETag: ETAG });
    mock.json(newer, 200, { ETag: 'W/"fedcba9876543210"' });
    mock.respond(notModified());
    const client = makeClient(mock);

    await client.getComments(POST_ID);
    expect(await client.getComments(POST_ID)).toEqual(newer);
    expect(client.lastResponseNotModified).toBe(false);
    await client.getComments(POST_ID);
    expect(mock.calls[3]?.headers["if-none-match"]).toBe('W/"fedcba9876543210"');
  });

  it("forgets an answer that came back without an ETag", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json(PAGE, 200, { ETag: ETAG });
    mock.json(PAGE);
    mock.json(PAGE);
    const client = makeClient(mock);

    await client.getComments(POST_ID);
    await client.getComments(POST_ID);
    await client.getComments(POST_ID);
    expect(mock.calls[3]?.headers["if-none-match"]).toBeUndefined();
  });

  it("keeps a tag per URL", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json(PAGE, 200, { ETag: ETAG });
    mock.json(PAGE, 200, { ETag: ETAG });
    const client = makeClient(mock);

    await client.getComments(POST_ID, 1);
    await client.getComments(POST_ID, 2);
    expect(mock.calls[2]?.headers["if-none-match"]).toBeUndefined();
  });

  it("never asks with revalidate: false", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json(PAGE, 200, { ETag: ETAG });
    mock.json(PAGE, 200, { ETag: ETAG });
    const client = makeClient(mock, false);

    await client.getComments(POST_ID);
    await client.getComments(POST_ID);
    expect(mock.calls[2]?.headers["if-none-match"]).toBeUndefined();
  });

  it("never sends a kept tag on a write", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json(PAGE, 200, { ETag: ETAG });
    mock.json({ id: "c2" }, 201);
    const client = makeClient(mock);

    await client.getComments(POST_ID);
    await client.createComment(POST_ID, "hello");
    expect(mock.calls[2]?.method).toBe("POST");
    expect(mock.calls[2]?.headers["if-none-match"]).toBeUndefined();
  });

  it("shows response hooks the 304", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json(PAGE, 200, { ETag: ETAG });
    mock.respond(notModified());
    const client = makeClient(mock);
    const seen: [number, unknown][] = [];
    client.onResponse((_method, _url, status, data) => seen.push([status, data]));

    await client.getComments(POST_ID);
    await client.getComments(POST_ID);
    expect(seen.slice(-2)).toEqual([
      [200, PAGE],
      [304, PAGE],
    ]);
  });
});
