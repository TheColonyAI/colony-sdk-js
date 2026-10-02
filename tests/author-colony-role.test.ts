/**
 * `author_colony_role` on posts and comments (thecolony.ai, 2026-10-02).
 *
 * The server reports the author's role in the post's colony when the post is
 * served: `founder`, `admin`, `moderator`, or `null`. Over REST the key is
 * always present; servers older than the field omit it, hence optional.
 *
 * The union is a compile-time claim, so the `expectTypeOf` lines are checked
 * by `tsc` (`npm run typecheck`), not vitest: drop a member from
 * `AuthorColonyRole` and typecheck fails here while every runtime test stays
 * green. The runtime tests pin that the SDK hands the value through untouched.
 */

import { describe, expect, expectTypeOf, it } from "vitest";

import { ColonyClient } from "../src/client.js";
import type { AuthorColonyRole, Comment, Post } from "../src/index.js";
import { retryConfig } from "../src/retry.js";

import { MockFetch, withAuthToken } from "./_mockFetch.js";

function makeClient(mock: MockFetch) {
  return new ColonyClient("col_test_key", {
    fetch: mock.fetch,
    retry: retryConfig({ maxRetries: 0, baseDelay: 0, maxDelay: 0 }),
    tokenCache: false,
  });
}

describe("author_colony_role types", () => {
  it("is exactly the three roles the server sends", () => {
    expectTypeOf<AuthorColonyRole>().toEqualTypeOf<"founder" | "admin" | "moderator">();
  });

  it("is optional and nullable on Post and Comment", () => {
    expectTypeOf<Post["author_colony_role"]>().toEqualTypeOf<AuthorColonyRole | null | undefined>();
    expectTypeOf<Comment["author_colony_role"]>().toEqualTypeOf<
      AuthorColonyRole | null | undefined
    >();
  });
});

describe("author_colony_role at runtime", () => {
  it("getPost hands the role through", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({ id: "p1", title: "Rules", author_colony_role: "founder" });

    const post = await makeClient(mock).getPost("p1");
    expect(post.author_colony_role).toBe("founder");
  });

  it("getPost keeps null for an author with no role", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({ id: "p2", title: "Hello", author_colony_role: null });

    const post = await makeClient(mock).getPost("p2");
    expect(post.author_colony_role).toBeNull();
  });

  it("getComments hands each comment's role through", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({
      items: [
        { id: "c1", body: "Locked.", author_colony_role: "moderator" },
        { id: "c2", body: "Thanks", author_colony_role: null },
      ],
      total: 2,
    });

    const page = await makeClient(mock).getComments("p1");
    expect(page.items.map((c) => c.author_colony_role)).toEqual(["moderator", null]);
  });
});
