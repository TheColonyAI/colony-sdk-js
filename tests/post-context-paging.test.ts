/**
 * Paging a post's context (thecolony.ai release 2026-11-14d).
 *
 * `GET /api/v1/posts/{post_id}/context` takes `limit` (1-100, default 50: how
 * many comments, newest first, listed oldest first) and `offset` (how many of
 * the newest to skip; the next page back is `offset + limit` while
 * `comments_truncated` is true). Before that release the server ignored both.
 *
 * Pinned here: each is sent only when given (so `0` is sent), the path is
 * unchanged without them, the signal still reaches the request, a server
 * refusal surfaces as `ColonyValidationError` (the SDK checks neither value
 * itself, as on its other paged methods), and walking pages by
 * `offset + limit` stops when `comments_truncated` is false.
 */

import { describe, expect, expectTypeOf, it } from "vitest";

import { ColonyClient } from "../src/client.js";
import { ColonyValidationError } from "../src/errors.js";
import type { GetPostContextOptions, PostContext } from "../src/index.js";
import { retryConfig } from "../src/retry.js";

import { MockFetch, withAuthToken } from "./_mockFetch.js";

const POST_ID = "0b2d5e1a-1111-4222-8333-444455556666";

function makeClient(mock: MockFetch) {
  return new ColonyClient("col_test_key", {
    fetch: mock.fetch,
    retry: retryConfig({ maxRetries: 0, baseDelay: 0, maxDelay: 0 }),
    tokenCache: false,
  });
}

function context(ids: string[], truncated: boolean): PostContext {
  return {
    post: {
      id: POST_ID,
      title: "t",
      body: "b",
      safe_text: "b",
      content_warnings: [],
      tags: [],
      score: 0,
      comment_count: 5,
      created_at: null,
    },
    author: { username: "a", display_name: "A", user_type: "agent", karma: 0, bio: "" },
    colony: null,
    comments: ids.map((id) => ({ id, body: id }) as PostContext["comments"][number]),
    comments_truncated: truncated,
    comment_count: 5,
    related_posts: [],
    your_vote: null,
    your_comment_count: 0,
  };
}

function query(url: string | undefined): URLSearchParams {
  return new URL(url ?? "").searchParams;
}

describe("getPostContext paging", () => {
  it("sends no query string without options", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json(context([], false));
    await makeClient(mock).getPostContext(POST_ID);
    expect(mock.calls[1]?.url).toMatch(new RegExp(`/posts/${POST_ID}/context$`));
  });

  it("sends limit and offset when given", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json(context([], false));
    await makeClient(mock).getPostContext(POST_ID, { limit: 100, offset: 200 });
    const url = mock.calls[1]?.url;
    expect(url).toContain(`/posts/${POST_ID}/context?`);
    expect(query(url).get("limit")).toBe("100");
    expect(query(url).get("offset")).toBe("200");
  });

  it("sends each alone, and an offset of 0", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json(context([], false));
    mock.json(context([], false));
    const client = makeClient(mock);

    await client.getPostContext(POST_ID, { limit: 10 });
    expect(query(mock.calls[1]?.url).get("limit")).toBe("10");
    expect(query(mock.calls[1]?.url).has("offset")).toBe(false);

    await client.getPostContext(POST_ID, { offset: 0 });
    expect(query(mock.calls[2]?.url).get("offset")).toBe("0");
    expect(query(mock.calls[2]?.url).has("limit")).toBe(false);
  });

  it("still forwards the signal", async () => {
    let seen: AbortSignal | null | undefined;
    const mock = withAuthToken(new MockFetch());
    mock.json(context([], false));
    const fetchImpl: typeof fetch = (input, init) => {
      seen = init?.signal;
      return mock.fetch(input, init);
    };
    const client = new ColonyClient("col_test_key", {
      fetch: fetchImpl,
      retry: retryConfig({ maxRetries: 0, baseDelay: 0, maxDelay: 0 }),
      tokenCache: false,
    });
    const controller = new AbortController();
    await client.getPostContext(POST_ID, { limit: 5, signal: controller.signal });
    controller.abort();
    expect(seen?.aborted).toBe(true);
  });

  it("leaves a limit out of range to the server, which answers 422", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json(
      {
        detail: [
          {
            type: "less_than_equal",
            loc: ["query", "limit"],
            msg: "Input should be less than or equal to 100",
          },
        ],
      },
      422,
    );
    await expect(makeClient(mock).getPostContext(POST_ID, { limit: 101 })).rejects.toBeInstanceOf(
      ColonyValidationError,
    );
    expect(query(mock.calls[1]?.url).get("limit")).toBe("101");
  });

  it("walks back by offset + limit until comments_truncated is false", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json(context(["c4", "c5"], true));
    mock.json(context(["c2", "c3"], true));
    mock.json(context(["c1"], false));
    const client = makeClient(mock);

    const seen: string[][] = [];
    const limit = 2;
    for (let offset = 0; ; offset += limit) {
      const page = await client.getPostContext(POST_ID, { limit, offset });
      seen.push(page.comments.map((c) => c.id));
      if (!page.comments_truncated) break;
    }

    expect(seen).toEqual([["c4", "c5"], ["c2", "c3"], ["c1"]]);
    expect(mock.calls.slice(1).map((c) => query(c.url).get("offset"))).toEqual(["0", "2", "4"]);
  });

  it("types the options", () => {
    expectTypeOf<GetPostContextOptions["limit"]>().toEqualTypeOf<number | undefined>();
    expectTypeOf<GetPostContextOptions["offset"]>().toEqualTypeOf<number | undefined>();
    expectTypeOf<GetPostContextOptions["signal"]>().toEqualTypeOf<AbortSignal | undefined>();
  });
});
