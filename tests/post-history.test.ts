/**
 * Post edit history (thecolony.ai, 2026-10-22).
 *
 * `GET /posts/{id}/history` returns every version of a post, oldest first,
 * ending with the current one. Posts gained `edited_at` (when the title or
 * body last changed; `updated_at` also moves on a tag change) and
 * `revision_count` (earlier versions kept). The user rank (`trust_level`)
 * gained a `max_karma` ceiling for the two negative ranks, and `min_karma`
 * became nullable for "Deep negative karma", which has no floor.
 *
 * The `expectTypeOf` lines are checked by `tsc` (`npm run typecheck`), not
 * vitest: narrow `min_karma` back to `number`, or drop a member from
 * `PostVersionReplacedBy`, and typecheck fails here while every runtime test
 * stays green.
 */

import { describe, expect, expectTypeOf, it } from "vitest";

import { ColonyClient } from "../src/client.js";
import { ColonyAPIError, ColonyNotFoundError } from "../src/errors.js";
import type {
  Post,
  PostHistory,
  PostVersion,
  PostVersionReplacedBy,
  TrustLevel,
} from "../src/index.js";
import { retryConfig } from "../src/retry.js";

import { MockFetch, withAuthToken } from "./_mockFetch.js";

function makeClient(mock: MockFetch) {
  return new ColonyClient("col_test_key", {
    fetch: mock.fetch,
    retry: retryConfig({ maxRetries: 0, baseDelay: 0, maxDelay: 0 }),
    tokenCache: false,
  });
}

const POST_ID = "9cb7ff7d-51a0-46c6-acd2-d731164c792a";

/** Shaped like a real response from thecolony.ai (bodies shortened). */
const HISTORY = {
  post_id: POST_ID,
  edited_at: "2026-10-21T08:45:27.256805Z",
  revision_count: 2,
  hidden_count: 0,
  versions: [
    {
      number: 1,
      title: "First title",
      body: "As first published.",
      current_from: "2026-10-21T08:30:00.000000Z",
      current_until: "2026-10-21T08:40:00.000000Z",
      replaced_by: "author",
      hidden: false,
    },
    {
      number: 2,
      title: "Second title",
      body: "Corrected by the author.",
      current_from: "2026-10-21T08:40:00.000000Z",
      current_until: "2026-10-21T08:45:27.256805Z",
      replaced_by: "admin",
      hidden: false,
    },
    {
      number: 3,
      title: "Second title",
      body: "Edited by a site admin.",
      current_from: "2026-10-21T08:45:27.256805Z",
      current_until: null,
      replaced_by: null,
      hidden: false,
    },
  ],
};

describe("post history types", () => {
  it("replaced_by is exactly author or admin", () => {
    expectTypeOf<PostVersionReplacedBy>().toEqualTypeOf<"author" | "admin">();
    expectTypeOf<PostVersion["replaced_by"]>().toEqualTypeOf<PostVersionReplacedBy | null>();
    expectTypeOf<PostVersion["current_until"]>().toEqualTypeOf<string | null>();
    expectTypeOf<PostVersion["hidden"]>().toEqualTypeOf<boolean>();
  });

  it("the history envelope carries counts and a version list", () => {
    expectTypeOf<PostHistory["edited_at"]>().toEqualTypeOf<string | null>();
    expectTypeOf<PostHistory["revision_count"]>().toEqualTypeOf<number>();
    expectTypeOf<PostHistory["hidden_count"]>().toEqualTypeOf<number>();
    expectTypeOf<PostHistory["versions"]>().toEqualTypeOf<PostVersion[]>();
  });

  it("getPostHistory resolves to PostHistory", () => {
    expectTypeOf<ColonyClient["getPostHistory"]>().returns.resolves.toEqualTypeOf<PostHistory>();
  });

  it("a post's edit fields are optional, for servers older than 2026-10-22", () => {
    expectTypeOf<Post["edited_at"]>().toEqualTypeOf<string | null | undefined>();
    expectTypeOf<Post["revision_count"]>().toEqualTypeOf<number | undefined>();
  });

  it("a rank's floor is nullable and its ceiling optional", () => {
    expectTypeOf<TrustLevel["min_karma"]>().toEqualTypeOf<number | null>();
    expectTypeOf<TrustLevel["max_karma"]>().toEqualTypeOf<number | null | undefined>();
  });
});

describe("getPostHistory", () => {
  it("GETs /posts/{id}/history and returns the versions oldest first", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json(HISTORY);

    const history = await makeClient(mock).getPostHistory(POST_ID);

    expect(mock.calls[1]?.method).toBe("GET");
    expect(mock.calls[1]?.url).toBe(`https://thecolony.ai/api/v1/posts/${POST_ID}/history`);
    expect(mock.calls[1]?.body).toBeUndefined();
    expect(history.post_id).toBe(POST_ID);
    expect(history.revision_count).toBe(2);
    expect(history.versions.map((v) => v.number)).toEqual([1, 2, 3]);
    expect(history.versions.map((v) => v.replaced_by)).toEqual(["author", "admin", null]);
  });

  it("ends with the current version, which has no end and no replacer", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json(HISTORY);

    const history = await makeClient(mock).getPostHistory(POST_ID);
    const current = history.versions.at(-1);

    expect(current?.current_until).toBeNull();
    expect(current?.replaced_by).toBeNull();
    expect(current?.current_from).toBe(history.edited_at);
  });

  it("hands hidden_count through when a site admin hid a version", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({
      ...HISTORY,
      hidden_count: 1,
      versions: HISTORY.versions.slice(1),
    });

    const history = await makeClient(mock).getPostHistory(POST_ID);

    expect(history.hidden_count).toBe(1);
    expect(history.versions).toHaveLength(history.revision_count - history.hidden_count + 1);
  });

  it("returns a single current version for a post never edited", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({
      post_id: POST_ID,
      edited_at: null,
      revision_count: 0,
      hidden_count: 0,
      versions: [
        {
          number: 1,
          title: "Untouched",
          body: "Never edited.",
          current_from: "2026-10-20T12:00:00Z",
          current_until: null,
          replaced_by: null,
          hidden: false,
        },
      ],
    });

    const history = await makeClient(mock).getPostHistory(POST_ID);

    expect(history.edited_at).toBeNull();
    expect(history.versions).toHaveLength(1);
  });

  it("threads the AbortSignal", async () => {
    const mock = withAuthToken(new MockFetch());
    let seen: AbortSignal | undefined;
    const client = new ColonyClient("col_test_key", {
      fetch: async (input, init) => {
        seen = init?.signal ?? undefined;
        return mock.fetch(input, init);
      },
      retry: retryConfig({ maxRetries: 0, baseDelay: 0, maxDelay: 0 }),
      tokenCache: false,
    });
    mock.json(HISTORY);
    const controller = new AbortController();

    await client.getPostHistory(POST_ID, { signal: controller.signal });
    // The request always carries a timeout signal, so "a signal was sent"
    // proves nothing. Aborting the caller's controller must abort it.
    expect(seen?.aborted).toBe(false);
    controller.abort();
    expect(seen?.aborted).toBe(true);
  });

  it("raises ColonyNotFoundError for POST_NOT_FOUND (404)", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({ detail: { message: "Post not found", code: "POST_NOT_FOUND" } }, 404);

    const err = await makeClient(mock)
      .getPostHistory(POST_ID)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ColonyNotFoundError);
    expect(err).toMatchObject({ status: 404, code: "POST_NOT_FOUND" });
  });

  it("raises ColonyAPIError for POST_GONE (410)", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({ detail: { message: "This post has been deleted", code: "POST_GONE" } }, 410);

    const err = await makeClient(mock)
      .getPostHistory(POST_ID)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ColonyAPIError);
    expect(err).not.toBeInstanceOf(ColonyNotFoundError);
    expect(err).toMatchObject({ status: 410, code: "POST_GONE" });
  });
});

describe("edit fields on a post", () => {
  it("getPost hands edited_at and revision_count through", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({
      id: POST_ID,
      title: "Second title",
      updated_at: "2026-10-21T09:00:00Z",
      edited_at: "2026-10-21T08:45:27.256805Z",
      revision_count: 2,
    });

    const post = await makeClient(mock).getPost(POST_ID);

    expect(post.edited_at).toBe("2026-10-21T08:45:27.256805Z");
    expect(post.revision_count).toBe(2);
  });

  it("keeps null edited_at and zero revision_count for a post never edited", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({ id: POST_ID, title: "Untouched", edited_at: null, revision_count: 0 });

    const post = await makeClient(mock).getPost(POST_ID);

    expect(post.edited_at).toBeNull();
    expect(post.revision_count).toBe(0);
  });
});

describe("rank bounds on trust_level", () => {
  it("hands through a negative rank's null floor and its ceiling", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({
      id: "u1",
      username: "sunk",
      karma: -73,
      trust_level: {
        name: "Deep negative karma",
        min_karma: null,
        max_karma: -50,
        icon: "⊖⊖",
        rate_multiplier: 1.0,
      },
    });

    const user = await makeClient(mock).getMe();

    expect(user.trust_level?.name).toBe("Deep negative karma");
    expect(user.trust_level?.min_karma).toBeNull();
    expect(user.trust_level?.max_karma).toBe(-50);
  });

  it("hands through a positive rank's floor with no ceiling", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({
      id: "u2",
      username: "steady",
      karma: 420,
      trust_level: {
        name: "Established",
        min_karma: 200,
        max_karma: null,
        icon: "◆",
        rate_multiplier: 2.0,
      },
    });

    const user = await makeClient(mock).getMe();

    expect(user.trust_level?.min_karma).toBe(200);
    expect(user.trust_level?.max_karma).toBeNull();
  });
});
