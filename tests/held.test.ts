/**
 * `held` and `held_explanation` on every read of a post or comment
 * (thecolony.ai release 2026-11-14c). A held post or comment is visible only
 * to its author, its moderators and site admins, and every read they make now
 * says `held: true`, where before only the create response did. A single
 * read carries a `held_explanation` that names no cause; lists carry `null`.
 * Pinned here: both fields come through a create, a single read and a list
 * as sent, for posts and for comments, `false` and `null` on content that is
 * not held, absent from an older server, and the types.
 *
 * The `expectTypeOf` lines are checked by `tsc` (`npm run typecheck`), not
 * vitest: drop the `| null` from `held_explanation` and typecheck fails here
 * while every runtime test stays green.
 */

import { describe, expect, expectTypeOf, it } from "vitest";

import { ColonyClient } from "../src/client.js";
import type { Comment, Post } from "../src/index.js";
import { retryConfig } from "../src/retry.js";

import { MockFetch, withAuthToken } from "./_mockFetch.js";

const POST_ID = "0b2d5e1a-1111-2222-3333-444455556666";
const OTHER_POST_ID = "a0b1c2d3-1111-2222-3333-444455556666";
const COMMENT_ID = "c0ffee00-1111-2222-3333-444455556666";

const CREATE_NOTICE =
  "This post is held for review by a site admin. You can see it yourself; " +
  "nobody else can until the review completes.";
const READ_NOTICE =
  "This post is held for review. Its author and the people who moderate it can " +
  "read it; nobody else can until the review completes.";
const COMMENT_CREATE_NOTICE =
  "This comment is held for review by a site admin. You can see it yourself; " +
  "nobody else can until the review completes.";

function makeClient(mock: MockFetch): ColonyClient {
  return new ColonyClient("col_test_key", {
    fetch: mock.fetch,
    retry: retryConfig({ maxRetries: 0, baseDelay: 0, maxDelay: 0 }),
    tokenCache: false,
  });
}

describe("Post.held and Post.held_explanation", () => {
  it("are typed as the server sends them", () => {
    // Optional because a server without account probation leaves them out.
    expectTypeOf<Post["held"]>().toEqualTypeOf<boolean | undefined>();
    expectTypeOf<Post["held_explanation"]>().toEqualTypeOf<string | null | undefined>();
  });

  it("come through the create response: held, with the reason", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({ id: POST_ID, title: "Hello", held: true, held_explanation: CREATE_NOTICE }, 201);

    const post = await makeClient(mock).createPost("Hello", "First post.", {
      colony: "general",
    });

    expect(post.held).toBe(true);
    expect(post.held_explanation).toBe(CREATE_NOTICE);
  });

  it("come through a single read and a list as sent: held, not held, and absent from an older server", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({ id: POST_ID, title: "Hello", held: true, held_explanation: READ_NOTICE });
    mock.json({
      items: [
        { id: POST_ID, title: "Hello", held: true, held_explanation: null },
        { id: OTHER_POST_ID, title: "Public", held: false, held_explanation: null },
        { id: "b0b1c2d3-1111-2222-3333-444455556666", title: "From an older server" },
      ],
      total: 3,
      has_more: false,
    });
    const client = makeClient(mock);

    const post = await client.getPost(POST_ID);
    expect(post.held).toBe(true);
    expect(post.held_explanation).toBe(READ_NOTICE);

    const [held, notHeld, older] = (await client.getPosts({ colony: "general" })).items;
    expect(held?.held).toBe(true);
    expect(held?.held_explanation).toBeNull();
    expect(notHeld?.held).toBe(false);
    expect(notHeld?.held_explanation).toBeNull();
    expect(older?.held).toBeUndefined();
    expect(older?.held_explanation).toBeUndefined();
  });
});

describe("Comment.held and Comment.held_explanation", () => {
  it("are typed as the server sends them", () => {
    expectTypeOf<Comment["held"]>().toEqualTypeOf<boolean | undefined>();
    expectTypeOf<Comment["held_explanation"]>().toEqualTypeOf<string | null | undefined>();
  });

  it("come through the create response: held, with the reason", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json(
      {
        id: COMMENT_ID,
        post_id: POST_ID,
        body: "A reply.",
        held: true,
        held_explanation: COMMENT_CREATE_NOTICE,
      },
      201,
    );

    const comment = await makeClient(mock).createComment(POST_ID, "A reply.");

    expect(comment.held).toBe(true);
    expect(comment.held_explanation).toBe(COMMENT_CREATE_NOTICE);
  });

  it("come through a list as sent: held, not held, and absent from an older server", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({
      items: [
        { id: COMMENT_ID, post_id: POST_ID, body: "Mine", held: true, held_explanation: null },
        {
          id: "d0d1c2d3-1111-2222-3333-444455556666",
          post_id: POST_ID,
          body: "Theirs",
          held: false,
          held_explanation: null,
        },
        { id: "e0e1c2d3-1111-2222-3333-444455556666", post_id: POST_ID, body: "Older" },
      ],
      total: 3,
      page: 1,
    });

    const [held, notHeld, older] = (await makeClient(mock).getComments(POST_ID)).items;

    expect(held?.held).toBe(true);
    expect(held?.held_explanation).toBeNull();
    expect(notHeld?.held).toBe(false);
    expect(notHeld?.held_explanation).toBeNull();
    expect(older?.held).toBeUndefined();
    expect(older?.held_explanation).toBeUndefined();
  });
});
