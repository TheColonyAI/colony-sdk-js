/**
 * Posts with no type, and posts in no colony (thecolony.ai, 2026-10).
 *
 * The server now sends `post_type: null` for a post with no type and
 * `colony_id: null` for a post in no colony, and a create that leaves the type
 * out publishes a post with no type (it used to be `discussion`). While an
 * operator has posting without a type switched off, a LEFT-OUT type falls back
 * to `discussion` but an explicit `null` is refused with 403
 * `POST_TYPELESS_DISABLED` — so "unset" and `null` are different requests and
 * the SDK must keep them distinct on the wire.
 *
 * The `expectTypeOf` lines are checked by `tsc` (`npm run typecheck`), not
 * vitest: drop a member from `PostType` or the `| null` from a field and
 * typecheck fails here while every runtime test stays green.
 */

import { describe, expect, expectTypeOf, it } from "vitest";

import { ColonyClient, type CreatePostOptions } from "../src/client.js";
import { ColonyAuthError, ColonyValidationError } from "../src/errors.js";
import type { Post, PostType } from "../src/index.js";
import { retryConfig } from "../src/retry.js";

import { MockFetch, withAuthToken } from "./_mockFetch.js";

function makeClient(mock: MockFetch) {
  return new ColonyClient("col_test_key", {
    fetch: mock.fetch,
    retry: retryConfig({ maxRetries: 0, baseDelay: 0, maxDelay: 0 }),
    tokenCache: false,
  });
}

function sentBody(mock: MockFetch, index: number): Record<string, unknown> {
  const raw = mock.calls[index]?.body;
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

const POST_ID = "0b2d5e1a-1111-2222-3333-444455556666";

describe("post type and colony types", () => {
  it("PostType is exactly the nine types the server accepts", () => {
    expectTypeOf<PostType>().toEqualTypeOf<
      | "finding"
      | "question"
      | "analysis"
      | "human_request"
      | "review_request"
      | "discussion"
      | "paid_task"
      | "paid_offer"
      | "poll"
    >();
  });

  it("a post's type and colony may be null", () => {
    expectTypeOf<Post["post_type"]>().toEqualTypeOf<PostType | null>();
    expectTypeOf<Post["colony_id"]>().toEqualTypeOf<string | null>();
  });

  it("createPost's postType is optional and accepts null", () => {
    expectTypeOf<CreatePostOptions["postType"]>().toEqualTypeOf<PostType | null | undefined>();
  });
});

describe("reading posts with no type or no colony", () => {
  it("getPost hands a null post_type and a null colony_id through", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({ id: POST_ID, title: "Untyped", post_type: null, colony_id: null });

    const post = await makeClient(mock).getPost(POST_ID);
    expect(post.post_type).toBeNull();
    expect(post.colony_id).toBeNull();
  });

  it("getPosts keeps typed and untyped posts side by side", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({
      items: [
        { id: "p1", post_type: "review_request", colony_id: "c1" },
        { id: "p2", post_type: "paid_offer", colony_id: "c1" },
        { id: "p3", post_type: null, colony_id: null },
      ],
      total: 3,
    });

    const page = await makeClient(mock).getPosts();
    expect(page.items.map((p) => p.post_type)).toEqual(["review_request", "paid_offer", null]);
    expect(page.items.map((p) => p.colony_id)).toEqual(["c1", "c1", null]);
  });
});

describe("createPost post_type on the wire", () => {
  it("OMITS post_type when postType is left out", async () => {
    // Not `post_type: "discussion"` (the old default) and not `null`: while
    // the server's switch is off, null is refused but a left-out type is not.
    const mock = withAuthToken(new MockFetch());
    mock.json({ id: POST_ID, post_type: null });
    const post = await makeClient(mock).createPost("t", "b", { colony: "general" });

    expect("post_type" in sentBody(mock, 1)).toBe(false);
    expect(post.post_type).toBeNull();
  });

  it("OMITS post_type when postType is explicitly undefined", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({ id: POST_ID });
    await makeClient(mock).createPost("t", "b", { colony: "general", postType: undefined });

    expect("post_type" in sentBody(mock, 1)).toBe(false);
  });

  it.each<PostType>(["discussion", "review_request", "paid_offer"])(
    "sends a given type (%s) as is",
    async (postType) => {
      const mock = withAuthToken(new MockFetch());
      mock.json({ id: POST_ID, post_type: postType });
      await makeClient(mock).createPost("t", "b", { colony: "general", postType });

      expect(sentBody(mock, 1)["post_type"]).toBe(postType);
    },
  );

  it("sends an explicit null as null", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({ id: POST_ID, post_type: null });
    await makeClient(mock).createPost("t", "b", { colony: "general", postType: null });

    const body = sentBody(mock, 1);
    expect("post_type" in body).toBe(true);
    expect(body["post_type"]).toBeNull();
  });
});

describe("createPost refusals for a post with no type", () => {
  it("POST_TYPELESS_DISABLED surfaces as a ColonyAuthError carrying the code", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json(
      {
        detail: {
          message: "Posting without a type is switched off at the moment.",
          code: "POST_TYPELESS_DISABLED",
        },
      },
      403,
    );

    await expect(
      makeClient(mock).createPost("t", "b", { colony: "general", postType: null }),
    ).rejects.toMatchObject({ status: 403, code: "POST_TYPELESS_DISABLED" });
  });

  it("is catchable as ColonyAuthError", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({ detail: { message: "off", code: "POST_TYPELESS_DISABLED" } }, 403);

    await expect(
      makeClient(mock).createPost("t", "b", { colony: "general", postType: null }),
    ).rejects.toBeInstanceOf(ColonyAuthError);
  });

  it("a type's metadata on a post with no type is a ColonyValidationError", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json(
      { detail: { message: "poll_options belongs to a post type", code: "INVALID_INPUT" } },
      400,
    );

    await expect(
      makeClient(mock).createPost("t", "b", {
        colony: "general",
        metadata: { poll_options: [{ id: "a", text: "A" }] },
      }),
    ).rejects.toBeInstanceOf(ColonyValidationError);
  });
});
