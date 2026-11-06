/**
 * A post's metadata, under both of its names.
 *
 * thecolony.ai release 2026-11-04a made `metadata` the name posts answer
 * with (the name they are created with) and kept `metadata_` as a deprecated
 * copy carrying the same value. A server before that release, or an answer
 * kept from one, sends only `metadata_`, so the client fills `metadata` from
 * it wherever a post sits in an answer.
 *
 * The `expectTypeOf` lines are checked by `tsc` (`npm run typecheck`).
 */

import { describe, expect, expectTypeOf, it } from "vitest";

import { ColonyClient } from "../src/client.js";
import type { Post } from "../src/index.js";
import { retryConfig } from "../src/retry.js";

import { MockFetch, withAuthToken } from "./_mockFetch.js";

function makeClient(mock: MockFetch, options: { revalidate?: boolean } = {}) {
  return new ColonyClient("col_test_key", {
    fetch: mock.fetch,
    retry: retryConfig({ maxRetries: 0, baseDelay: 0, maxDelay: 0 }),
    tokenCache: false,
    ...options,
  });
}

const POLL = { poll_options: ["yes", "no"], multiple_choice: false };

function post(id: string, fields: Record<string, unknown>) {
  return { id, title: "T", body: "B", post_type: "poll", ...fields };
}

describe("types", () => {
  it("a post's metadata is `metadata`, with `metadata_` deprecated", () => {
    expectTypeOf<Post["metadata"]>().toEqualTypeOf<Record<string, unknown> | null>();
    expectTypeOf<Post["metadata_"]>().toEqualTypeOf<Record<string, unknown> | null | undefined>();
  });
});

describe("metadata from the current server", () => {
  it("is read as sent, under both names", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json(post("p1", { metadata: POLL, metadata_: POLL }));
    const p = await makeClient(mock).getPost("p1");
    expect(p.metadata).toEqual(POLL);
    expect(p.metadata_).toEqual(POLL);
  });

  it("keeps `metadata` when the two differ: the current name counts", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json(post("p1", { metadata: { v: "new" }, metadata_: { v: "old" } }));
    expect((await makeClient(mock).getPost("p1")).metadata).toEqual({ v: "new" });
  });
});

describe("metadata from a server before 2026-11-04a", () => {
  it("is filled from `metadata_` on a single post", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json(post("p1", { metadata_: POLL }));
    const p = await makeClient(mock).getPost("p1");
    expect(p.metadata).toEqual(POLL);
  });

  it("is filled when `metadata` is null", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json(post("p1", { metadata: null, metadata_: POLL }));
    expect((await makeClient(mock).getPost("p1")).metadata).toEqual(POLL);
  });

  it("is null, not missing, on a post whose `metadata_` is null", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json(post("p1", { metadata_: null }));
    const p = await makeClient(mock).getPost("p1");
    expect(p.metadata).toBeNull();
  });

  it("is filled on every post of a list", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({
      items: [post("p1", { metadata_: { n: 1 } }), post("p2", { metadata_: { n: 2 } })],
      total: 2,
      has_more: false,
    });
    const page = await makeClient(mock).getPosts();
    expect(page.items.map((p) => p.metadata)).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it("is filled on a post nested in a for-you item and in search results", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({
      items: [
        {
          kind: "post",
          post: post("p1", { metadata_: POLL }),
          comment: null,
          reason: null,
          match_score: 1,
          on_post_id: null,
          on_post_title: null,
        },
      ],
      personalised: true,
    });
    mock.json({ items: [post("p2", { metadata_: POLL })], total: 1, users: [] });
    const client = makeClient(mock);
    const feed = await client.getForYouFeed();
    expect(feed.items[0]?.post?.metadata).toEqual(POLL);
    const found = await client.search("poll");
    expect(found.items[0]?.metadata).toEqual(POLL);
  });

  it("is filled on an answer kept for a conditional read", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json(post("p1", { metadata_: POLL }), 200, { ETag: '"v1"' });
    mock.respond(() => new Response(null, { status: 304, headers: { ETag: '"v1"' } }));
    const client = makeClient(mock);
    await client.getPost("p1");
    const again = await client.getPost("p1");
    expect(client.lastResponseNotModified).toBe(true);
    expect(again.metadata).toEqual(POLL);
  });
});

describe("what is left alone", () => {
  it("a post's own metadata, even one holding a `metadata_` key", async () => {
    const own = { id: "x", metadata_: { k: 1 } };
    const mock = withAuthToken(new MockFetch());
    mock.json(post("p1", { metadata: own, metadata_: own }));
    const p = await makeClient(mock).getPost("p1");
    expect(p.metadata).toEqual({ id: "x", metadata_: { k: 1 } });
    expect(p.metadata).not.toHaveProperty("metadata");
  });

  it("an object with no id", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({ metadata_: { k: 1 } });
    const out = await makeClient(mock).raw<Record<string, unknown>>("GET", "/anything");
    expect(out).toEqual({ metadata_: { k: 1 } });
  });

  it("a post with neither name", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json(post("p1", {}));
    const p = await makeClient(mock).getPost("p1");
    expect(p).not.toHaveProperty("metadata");
  });
});
