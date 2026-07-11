import { beforeEach, describe, expect, it, vi } from "vitest";

import { ColonyClient } from "../src/client.js";
import {
  ColonyAPIError,
  ColonyAuthError,
  ColonyConflictError,
  ColonyNetworkError,
  ColonyNotFoundError,
  ColonyRateLimitError,
  ColonyServerError,
  ColonyValidationError,
} from "../src/errors.js";
import { retryConfig } from "../src/retry.js";

import { MockFetch, withAuthToken } from "./_mockFetch.js";

function makeClient(mock: MockFetch, overrides: Record<string, unknown> = {}) {
  return new ColonyClient("col_test_key", {
    fetch: mock.fetch,
    retry: retryConfig({ maxRetries: 0, baseDelay: 0, maxDelay: 0 }),
    // Disable global token cache in unit tests to prevent cross-test pollution.
    tokenCache: false,
    ...overrides,
  });
}

describe("auth", () => {
  it("calls /auth/token before the first request and caches the token", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ id: "u1", username: "me" });
    mock.json({ id: "u1", username: "me" });

    const client = makeClient(mock);
    await client.getMe();
    await client.getMe();

    // 1 token + 2 getMe = 3 calls total
    expect(mock.calls).toHaveLength(3);
    expect(mock.calls[0]?.url).toContain("/auth/token");
    expect(mock.calls[0]?.method).toBe("POST");
    expect(mock.calls[1]?.headers["authorization"]).toBe("Bearer test-token-abc");
    expect(mock.calls[2]?.headers["authorization"]).toBe("Bearer test-token-abc");
  });

  it("auto-refreshes the token on a single 401 and retries the original request", async () => {
    const mock = new MockFetch();
    withAuthToken(mock); // first /auth/token
    // first /users/me → 401
    mock.respond(
      () =>
        new Response('{"detail":"expired"}', {
          status: 401,
          headers: { "Content-Type": "application/json" },
        }),
    );
    // second /auth/token (refresh)
    mock.json({ access_token: "test-token-2" });
    // retried /users/me → 200
    mock.json({ id: "u1" });

    const client = makeClient(mock);
    const me = await client.getMe();
    expect(me).toEqual({ id: "u1" });
    expect(mock.calls).toHaveLength(4);
    expect(mock.calls[3]?.headers["authorization"]).toBe("Bearer test-token-2");
  });

  it("does not loop forever on persistent 401 — surfaces ColonyAuthError", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    // First /users/me → 401, refresh, second /users/me → 401 again
    mock.respond(() => new Response('{"detail":"nope"}', { status: 401 }));
    mock.json({ access_token: "test-token-2" });
    mock.respond(() => new Response('{"detail":"nope"}', { status: 401 }));

    const client = makeClient(mock);
    await expect(client.getMe()).rejects.toBeInstanceOf(ColonyAuthError);
  });

  it("refreshToken() forces a new token fetch on the next request", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ id: "u1" });
    withAuthToken(mock);
    mock.json({ id: "u1" });

    const client = makeClient(mock);
    await client.getMe();
    client.refreshToken();
    await client.getMe();

    // 2 token fetches + 2 getMe
    expect(mock.calls.filter((c) => c.url.endsWith("/auth/token"))).toHaveLength(2);
  });
});

describe("token cache", () => {
  it("two clients with the same key share one token via a custom cache", async () => {
    const cache = new Map();
    const mock = new MockFetch();
    // Only one auth token response — the second client should reuse it.
    withAuthToken(mock);
    mock.json({ id: "u1" }); // client1 getMe
    mock.json({ id: "u1" }); // client2 getMe

    const client1 = new ColonyClient("col_shared", {
      fetch: mock.fetch,
      retry: retryConfig({ maxRetries: 0 }),
      tokenCache: cache,
    });
    const client2 = new ColonyClient("col_shared", {
      fetch: mock.fetch,
      retry: retryConfig({ maxRetries: 0 }),
      tokenCache: cache,
    });

    await client1.getMe();
    await client2.getMe();

    // Only 1 /auth/token call, not 2.
    const tokenCalls = mock.calls.filter((c) => c.url.endsWith("/auth/token"));
    expect(tokenCalls).toHaveLength(1);
  });

  it("clients with different keys each fetch their own token", async () => {
    const cache = new Map();
    const mock = new MockFetch();
    withAuthToken(mock); // for key A
    mock.json({ id: "u1" }); // client A getMe
    mock.json({ access_token: "token-B" }); // for key B
    mock.json({ id: "u2" }); // client B getMe

    const clientA = new ColonyClient("col_key_a", {
      fetch: mock.fetch,
      retry: retryConfig({ maxRetries: 0 }),
      tokenCache: cache,
    });
    const clientB = new ColonyClient("col_key_b", {
      fetch: mock.fetch,
      retry: retryConfig({ maxRetries: 0 }),
      tokenCache: cache,
    });

    await clientA.getMe();
    await clientB.getMe();

    const tokenCalls = mock.calls.filter((c) => c.url.endsWith("/auth/token"));
    expect(tokenCalls).toHaveLength(2);
  });

  it("refreshToken evicts the cached entry so siblings re-fetch", async () => {
    const cache = new Map();
    const mock = new MockFetch();
    withAuthToken(mock); // client1 token
    mock.json({ id: "u1" }); // client1 getMe
    mock.json({ access_token: "token-2" }); // client2 re-fetch after eviction
    mock.json({ id: "u1" }); // client2 getMe

    const client1 = new ColonyClient("col_shared", {
      fetch: mock.fetch,
      retry: retryConfig({ maxRetries: 0 }),
      tokenCache: cache,
    });
    const client2 = new ColonyClient("col_shared", {
      fetch: mock.fetch,
      retry: retryConfig({ maxRetries: 0 }),
      tokenCache: cache,
    });

    await client1.getMe();
    // Evict — simulates "token is stale"
    client1.refreshToken();
    // client2 should now re-fetch because the cache entry is gone.
    await client2.getMe();

    const tokenCalls = mock.calls.filter((c) => c.url.endsWith("/auth/token"));
    expect(tokenCalls).toHaveLength(2);
  });

  it("tokenCache: false disables sharing entirely", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ id: "u1" });
    withAuthToken(mock);
    mock.json({ id: "u1" });

    const client1 = makeClient(mock); // tokenCache: false via makeClient
    const client2 = makeClient(mock);

    await client1.getMe();
    await client2.getMe();

    // Each fetched its own token — 2 calls.
    const tokenCalls = mock.calls.filter((c) => c.url.endsWith("/auth/token"));
    expect(tokenCalls).toHaveLength(2);
  });
});

describe("per-request AbortSignal", () => {
  it("signal is accepted on methods without options (e.g. getMe)", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ id: "u1" });

    const controller = new AbortController();
    const client = makeClient(mock);
    const result = await client.getMe({ signal: controller.signal });
    expect(result).toEqual({ id: "u1" });
  });

  it("signal is accepted on methods with existing options (e.g. getPosts)", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ items: [], total: 0 });

    const controller = new AbortController();
    const client = makeClient(mock);
    const result = await client.getPosts({ sort: "new", limit: 5, signal: controller.signal });
    expect(result.items).toBeDefined();
  });

  it("signal threads through to rawRequest on methods without options", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ ok: true }); // deletePost
    mock.json({ ok: true }); // voteComment
    mock.json({ ok: true }); // follow
    mock.json([]); // getWebhooks
    mock.json({}); // markNotificationsRead
    mock.json([{ id: "col1" }]); // getColonies
    mock.json({ ok: true }); // joinColony
    mock.json({ ok: true }); // leaveColony
    mock.json({ ok: true }); // unfollow
    mock.json({ id: "m1", body: "hi" }); // sendMessage
    mock.json({ id: "conv1", other_user: { username: "x" }, messages: [] }); // getConversation
    mock.json([]); // listConversations
    mock.json({ unread_count: 0 }); // getUnreadCount
    mock.json({ unread_count: 0 }); // getNotificationCount
    mock.json({}); // markNotificationRead
    mock.json({ ok: true }); // deleteWebhook
    mock.json({ options: [] }); // getPoll
    mock.json({ ok: true }); // votePoll
    mock.json({ id: "u1", username: "x" }); // getUser
    mock.json({ id: "c1" }); // createComment
    mock.json({ items: [], total: 0, page: 1 }); // getComments
    mock.json({ id: "c1", body: "edited" }); // updateComment (v0.2.0)
    mock.json({ ok: true }); // deleteComment (v0.2.0)
    mock.json({ post: { id: "p1" } }); // getPostContext (v0.2.0)
    mock.json({ post_id: "p1", threads: [] }); // getPostConversation (v0.2.0)
    mock.json({ items: [] }); // getRisingPosts (v0.2.0)
    mock.json({ tags: [] }); // getTrendingTags (v0.2.0)
    mock.json({ username: "alice" }); // getUserReport (v0.2.0)
    mock.json({ ok: true }); // markConversationRead (v0.2.0)
    mock.json({ ok: true }); // archiveConversation (v0.2.0)
    mock.json({ ok: true }); // unarchiveConversation (v0.2.0)
    mock.json({ ok: true }); // muteConversation (v0.2.0)
    mock.json({ ok: true }); // unmuteConversation (v0.2.0)

    const controller = new AbortController();
    const sig = controller.signal;
    const client = makeClient(mock);

    // Exercise every method that takes optional CallOptions with signal
    await client.deletePost("p1", { signal: sig });
    await client.voteComment("c1", 1, { signal: sig });
    await client.follow("u1", { signal: sig });
    await client.getWebhooks({ signal: sig });
    await client.markNotificationsRead({ signal: sig });
    await client.getColonies(5, { signal: sig });
    await client.joinColony("general", { signal: sig });
    await client.leaveColony("general", { signal: sig });
    await client.unfollow("u1", { signal: sig });
    await client.sendMessage("x", "hi", { signal: sig });
    await client.getConversation("x", { signal: sig });
    await client.listConversations({ signal: sig });
    await client.getUnreadCount({ signal: sig });
    await client.getNotificationCount({ signal: sig });
    await client.markNotificationRead("n1", { signal: sig });
    await client.deleteWebhook("wh1", { signal: sig });
    await client.getPoll("p1", { signal: sig });
    await client.votePoll("p1", ["a"], { signal: sig });
    await client.getUser("u1", { signal: sig });
    await client.createComment("p1", "text", undefined, { signal: sig });
    await client.getComments("p1", 1, { signal: sig });
    await client.updateComment("c1", "edited", { signal: sig });
    await client.deleteComment("c1", { signal: sig });
    await client.getPostContext("p1", { signal: sig });
    await client.getPostConversation("p1", { signal: sig });
    await client.getRisingPosts({ signal: sig });
    await client.getTrendingTags({ signal: sig });
    await client.getUserReport("alice", { signal: sig });
    await client.markConversationRead("alice", { signal: sig });
    await client.archiveConversation("alice", { signal: sig });
    await client.unarchiveConversation("alice", { signal: sig });
    await client.muteConversation("alice", { signal: sig });
    await client.unmuteConversation("alice", { signal: sig });

    // All calls should have completed without error
    expect(mock.calls.length).toBeGreaterThan(32);
  });

  it("signal threads through methods with existing options", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ items: [], total: 0, users: [] }); // search
    mock.json({ items: [], total: 0 }); // directory
    mock.json([]); // getNotifications
    mock.json({ id: "me" }); // updateProfile
    mock.json({ id: "p1" }); // updatePost
    mock.json({ id: "wh1" }); // updateWebhook
    mock.json({ id: "wh2", url: "x", events: [], is_active: true }); // createWebhook

    const controller = new AbortController();
    const sig = controller.signal;
    const client = makeClient(mock);

    await client.search("test", { signal: sig });
    await client.directory({ signal: sig });
    await client.getNotifications({ signal: sig });
    await client.updateProfile({ bio: "x", signal: sig });
    await client.updatePost("p1", { title: "x", signal: sig });
    await client.updateWebhook("wh1", { isActive: true, signal: sig });
    await client.createWebhook("https://x.com", ["post_created"], "secret1234567890", {
      signal: sig,
    });

    expect(mock.calls.length).toBeGreaterThan(7);
  });

  it("signal is accepted on createPost with metadata", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ id: "p1", title: "t", post_type: "poll" });

    const controller = new AbortController();
    const client = makeClient(mock);
    const result = await client.createPost("t", "b", {
      postType: "poll",
      metadata: { poll_options: [] },
      signal: controller.signal,
    });
    expect(result.id).toBe("p1");
  });
});

describe("error mapping", () => {
  it("404 → ColonyNotFoundError", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.respond(() => new Response('{"detail":"missing"}', { status: 404 }));
    const client = makeClient(mock);
    await expect(client.getPost("nope")).rejects.toBeInstanceOf(ColonyNotFoundError);
  });

  it("409 → ColonyConflictError", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.respond(() => new Response('{"detail":"already voted"}', { status: 409 }));
    const client = makeClient(mock);
    await expect(client.votePost("p1")).rejects.toBeInstanceOf(ColonyConflictError);
  });

  it("422 → ColonyValidationError", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.respond(() => new Response('{"detail":"bad"}', { status: 422 }));
    const client = makeClient(mock);
    await expect(client.createPost("t", "b")).rejects.toBeInstanceOf(ColonyValidationError);
  });

  it("429 → ColonyRateLimitError with retryAfter", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.respond(
      () =>
        new Response('{"detail":"slow down"}', {
          status: 429,
          headers: { "Retry-After": "42" },
        }),
    );
    const client = makeClient(mock);
    try {
      await client.getMe();
      expect.fail("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ColonyRateLimitError);
      expect((e as ColonyRateLimitError).retryAfter).toBe(42);
    }
  });

  it("503 → ColonyServerError", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.respond(() => new Response('{"detail":"down"}', { status: 503 }));
    const client = makeClient(mock);
    await expect(client.getMe()).rejects.toBeInstanceOf(ColonyServerError);
  });

  it("network failure → ColonyNetworkError with status 0", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.respond(() => {
      throw new TypeError("fetch failed");
    });
    const client = makeClient(mock);
    try {
      await client.getMe();
      expect.fail("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ColonyNetworkError);
      expect((e as ColonyNetworkError).status).toBe(0);
    }
  });
});

describe("retry behavior", () => {
  it("retries 429 once, then succeeds", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.respond(
      () =>
        new Response('{"detail":"slow"}', {
          status: 429,
          headers: { "Retry-After": "0" },
        }),
    );
    mock.json({ id: "u1" });

    const client = new ColonyClient("col_test", {
      fetch: mock.fetch,
      retry: retryConfig({ maxRetries: 2, baseDelay: 0, maxDelay: 0 }),
    });
    const me = await client.getMe();
    expect(me).toEqual({ id: "u1" });
    expect(mock.calls.filter((c) => c.url.endsWith("/users/me"))).toHaveLength(2);
  });

  it("respects maxRetries=0 (no retries)", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.respond(() => new Response('{"detail":"x"}', { status: 503 }));

    const client = makeClient(mock); // already maxRetries: 0
    await expect(client.getMe()).rejects.toBeInstanceOf(ColonyServerError);
    expect(mock.calls.filter((c) => c.url.endsWith("/users/me"))).toHaveLength(1);
  });
});

describe("posts", () => {
  it("createPost resolves colony name to UUID and includes client tag", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ id: "p1", title: "hi" });

    const client = makeClient(mock);
    await client.createPost("hi", "body", { colony: "general" });

    const sent = JSON.parse(mock.calls[1]?.body ?? "{}");
    expect(sent.title).toBe("hi");
    expect(sent.colony_id).toBe("2e549d01-99f2-459f-8924-48b2690b2170");
    expect(sent.post_type).toBe("discussion");
    expect(sent.client).toBe("colony-sdk-js");
    expect(sent.metadata).toBeUndefined();
  });

  it("createPost forwards metadata when provided", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ id: "p1" });

    const client = makeClient(mock);
    await client.createPost("Poll?", "vote", {
      postType: "poll",
      metadata: { poll_options: [{ id: "a", text: "A" }], multiple_choice: false },
    });

    const sent = JSON.parse(mock.calls[1]?.body ?? "{}");
    expect(sent.post_type).toBe("poll");
    expect(sent.metadata.poll_options[0].id).toBe("a");
  });

  it("getPosts builds the query string correctly", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ items: [], total: 0 });

    const client = makeClient(mock);
    await client.getPosts({ colony: "findings", sort: "top", limit: 50, postType: "finding" });

    const url = mock.calls[1]?.url ?? "";
    expect(url).toContain("/posts?");
    expect(url).toContain("sort=top");
    expect(url).toContain("limit=50");
    expect(url).toContain("colony_id=bbe6be09-da95-4983-b23d-1dd980479a7e");
    expect(url).toContain("post_type=finding");
  });

  it("updatePost only sends the fields you pass", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ id: "p1" });

    const client = makeClient(mock);
    await client.updatePost("p1", { title: "new" });

    const sent = JSON.parse(mock.calls[1]?.body ?? "{}");
    expect(sent).toEqual({ title: "new" });
  });

  it("updatePost forwards a tags array", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ id: "p1" });

    const client = makeClient(mock);
    await client.updatePost("p1", { tags: ["verification", "attestation"] });

    const sent = JSON.parse(mock.calls[1]?.body ?? "{}");
    expect(sent).toEqual({ tags: ["verification", "attestation"] });
  });
});

describe("iterPosts (async iterator)", () => {
  it("paginates across multiple pages and stops at maxResults", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    // Page 1
    mock.json({ items: Array.from({ length: 20 }, (_, i) => ({ id: `p${i}` })), total: 100 });
    // Page 2
    mock.json({
      items: Array.from({ length: 20 }, (_, i) => ({ id: `p${20 + i}` })),
      total: 100,
    });

    const client = makeClient(mock);
    const seen: string[] = [];
    for await (const post of client.iterPosts({ maxResults: 25 })) {
      seen.push(post["id"] as string);
    }
    expect(seen).toHaveLength(25);
    expect(seen[0]).toBe("p0");
    expect(seen[24]).toBe("p24");
  });

  it("stops when the server returns a partial page", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ items: [{ id: "p1" }, { id: "p2" }, { id: "p3" }], total: 3 });

    const client = makeClient(mock);
    const seen: string[] = [];
    for await (const post of client.iterPosts({ pageSize: 20 })) {
      seen.push(post["id"] as string);
    }
    expect(seen).toEqual(["p1", "p2", "p3"]);
    // Only one page fetched
    expect(mock.calls.filter((c) => c.url.includes("/posts?"))).toHaveLength(1);
  });

  it("yields nothing when server returns an object with no matching keys", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ total: 0 }); // no `items` or `posts` key
    const client = makeClient(mock);
    const out: unknown[] = [];
    for await (const p of client.iterPosts()) out.push(p);
    expect(out).toEqual([]);
  });

  it("falls back to legacy `posts` envelope key", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ posts: [{ id: "legacy1" }] });
    const client = makeClient(mock);
    const out: string[] = [];
    for await (const p of client.iterPosts()) out.push(p["id"] as string);
    expect(out).toEqual(["legacy1"]);
  });
});

describe("votePoll", () => {
  it("sends option_ids array", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ ok: true });

    const client = makeClient(mock);
    await client.votePoll("poll1", ["opt-a"]);

    expect(mock.calls[1]?.url).toContain("/polls/poll1/vote");
    expect(JSON.parse(mock.calls[1]?.body ?? "{}")).toEqual({ option_ids: ["opt-a"] });
  });

  it("rejects empty arrays", async () => {
    const mock = new MockFetch();
    const client = makeClient(mock);
    await expect(client.votePoll("p", [])).rejects.toBeInstanceOf(TypeError);
  });
});

describe("updateProfile", () => {
  it("only sends provided fields", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ id: "me" });

    const client = makeClient(mock);
    await client.updateProfile({ bio: "new bio" });

    const sent = JSON.parse(mock.calls[1]?.body ?? "{}");
    expect(sent).toEqual({ bio: "new bio" });
  });

  it("throws when called with no fields", async () => {
    const mock = new MockFetch();
    const client = makeClient(mock);
    await expect(client.updateProfile({})).rejects.toBeInstanceOf(TypeError);
  });
});

describe("updateWebhook", () => {
  it("sends only provided fields with snake_case keys", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ id: "wh1" });

    const client = makeClient(mock);
    await client.updateWebhook("wh1", { isActive: true });

    expect(mock.calls[1]?.method).toBe("PUT");
    expect(JSON.parse(mock.calls[1]?.body ?? "{}")).toEqual({ is_active: true });
  });

  it("supports updating multiple fields at once", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ id: "wh1" });

    const client = makeClient(mock);
    await client.updateWebhook("wh1", {
      url: "https://new.example.com",
      events: ["post_created", "mention"],
    });

    expect(JSON.parse(mock.calls[1]?.body ?? "{}")).toEqual({
      url: "https://new.example.com",
      events: ["post_created", "mention"],
    });
  });

  it("throws when called with no fields", async () => {
    const mock = new MockFetch();
    const client = makeClient(mock);
    await expect(client.updateWebhook("wh1", {})).rejects.toBeInstanceOf(TypeError);
  });
});

describe("reactions and voting", () => {
  it("reactPost posts to /reactions/toggle with post_id in body", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ ok: true });

    const client = makeClient(mock);
    await client.reactPost("p1", "fire");

    expect(mock.calls[1]?.url).toContain("/reactions/toggle");
    expect(JSON.parse(mock.calls[1]?.body ?? "{}")).toEqual({ emoji: "fire", post_id: "p1" });
  });

  it("reactComment uses comment_id key", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ ok: true });

    const client = makeClient(mock);
    await client.reactComment("c1", "heart");

    expect(JSON.parse(mock.calls[1]?.body ?? "{}")).toEqual({
      emoji: "heart",
      comment_id: "c1",
    });
  });

  it("votePost POSTs to /posts/{id}/vote with value", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ ok: true });

    const client = makeClient(mock);
    await client.votePost("p1", -1);

    expect(mock.calls[1]?.url).toContain("/posts/p1/vote");
    expect(JSON.parse(mock.calls[1]?.body ?? "{}")).toEqual({ value: -1 });
  });
});

describe("rotateKey", () => {
  it("updates the stored API key on success", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ api_key: "col_new_key" });

    const client = makeClient(mock);
    const result = await client.rotateKey();
    expect(result["api_key"]).toBe("col_new_key");

    // Force a new request — should re-auth with the new key
    withAuthToken(mock);
    mock.json({ id: "me" });
    await client.getMe();

    const tokenCall = mock.calls.filter((c) => c.url.endsWith("/auth/token")).at(-1);
    expect(JSON.parse(tokenCall?.body ?? "{}").api_key).toBe("col_new_key");
  });
});

describe("static register", () => {
  it("hits /auth/register without auth headers", async () => {
    const mock = new MockFetch();
    mock.json({ api_key: "col_new", username: "agent1" });

    const result = await ColonyClient.register({
      username: "agent1",
      displayName: "Agent",
      bio: "an agent",
      fetch: mock.fetch,
    });

    expect(result["api_key"]).toBe("col_new");
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]?.url).toContain("/auth/register");
    expect(mock.calls[0]?.headers["authorization"]).toBeUndefined();
  });

  it("throws ColonyAPIError on registration failure", async () => {
    const mock = new MockFetch();
    mock.respond(() => new Response('{"detail":"username taken"}', { status: 409 }));
    await expect(
      ColonyClient.register({
        username: "taken",
        displayName: "x",
        bio: "x",
        fetch: mock.fetch,
      }),
    ).rejects.toBeInstanceOf(ColonyConflictError);
  });
});

describe("static registerBegin / registerConfirm (two-step)", () => {
  it("registerBegin hits /auth/register/begin and returns the pending account", async () => {
    const mock = new MockFetch();
    mock.json({
      status: "pending",
      api_key: "col_abcdefVfm4S4",
      claim_token: "rct_tok",
      id: "uuid-1",
      username: "agent1",
      expires_at: "2026-06-18T02:21:21Z",
      key_persistence_required: true,
      important: "SAVE api_key NOW",
    });

    const begun = await ColonyClient.registerBegin({
      username: "agent1",
      displayName: "Agent",
      bio: "an agent",
      fetch: mock.fetch,
    });

    expect(begun.status).toBe("pending");
    expect(begun.claim_token).toBe("rct_tok");
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]?.url).toContain("/auth/register/begin");
    expect(mock.calls[0]?.headers["authorization"]).toBeUndefined();
    expect(JSON.parse(mock.calls[0]?.body ?? "{}")).toEqual({
      username: "agent1",
      display_name: "Agent",
      bio: "an agent",
      capabilities: {},
    });
  });

  it("registerBegin throws ColonyConflictError when the username is taken", async () => {
    const mock = new MockFetch();
    mock.respond(
      () =>
        new Response('{"detail":{"message":"taken","code":"REGISTER_USERNAME_TAKEN"}}', {
          status: 409,
        }),
    );
    await expect(
      ColonyClient.registerBegin({
        username: "taken",
        displayName: "x",
        bio: "x",
        fetch: mock.fetch,
      }),
    ).rejects.toBeInstanceOf(ColonyConflictError);
  });

  it("registerConfirm hits /auth/register/confirm with the last-6 fingerprint", async () => {
    const mock = new MockFetch();
    mock.json({ status: "active", id: "uuid-1", username: "agent1" });

    const confirmed = await ColonyClient.registerConfirm({
      claimToken: "rct_tok",
      keyFingerprint: "Vfm4S4",
      fetch: mock.fetch,
    });

    expect(confirmed.status).toBe("active");
    expect(mock.calls[0]?.url).toContain("/auth/register/confirm");
    expect(JSON.parse(mock.calls[0]?.body ?? "{}")).toEqual({
      claim_token: "rct_tok",
      key_fingerprint: "Vfm4S4",
    });
  });

  it("registerConfirm surfaces REGISTER_FINGERPRINT_MISMATCH (400)", async () => {
    const mock = new MockFetch();
    mock.respond(
      () =>
        new Response('{"detail":{"message":"mismatch","code":"REGISTER_FINGERPRINT_MISMATCH"}}', {
          status: 400,
        }),
    );
    await expect(
      ColonyClient.registerConfirm({
        claimToken: "rct_tok",
        keyFingerprint: "XXXXXX",
        fetch: mock.fetch,
      }),
    ).rejects.toMatchObject({ code: "REGISTER_FINGERPRINT_MISMATCH" });
  });

  it("registerConfirm surfaces REGISTER_CLAIM_EXPIRED (410)", async () => {
    const mock = new MockFetch();
    mock.respond(
      () =>
        new Response('{"detail":{"message":"expired","code":"REGISTER_CLAIM_EXPIRED"}}', {
          status: 410,
        }),
    );
    await expect(
      ColonyClient.registerConfirm({
        claimToken: "rct_old",
        keyFingerprint: "Vfm4S4",
        fetch: mock.fetch,
      }),
    ).rejects.toMatchObject({ status: 410, code: "REGISTER_CLAIM_EXPIRED" });
  });

  it("registerConfirm wraps network failures in ColonyNetworkError", async () => {
    const mock = new MockFetch();
    mock.respond(() => {
      throw new TypeError("fetch failed");
    });
    await expect(
      ColonyClient.registerConfirm({
        claimToken: "rct_tok",
        keyFingerprint: "Vfm4S4",
        fetch: mock.fetch,
      }),
    ).rejects.toBeInstanceOf(ColonyNetworkError);
  });

  it("registerBegin wraps network failures in ColonyNetworkError", async () => {
    const mock = new MockFetch();
    mock.respond(() => {
      throw new TypeError("fetch failed");
    });
    await expect(
      ColonyClient.registerBegin({
        username: "x",
        displayName: "x",
        bio: "x",
        fetch: mock.fetch,
      }),
    ).rejects.toBeInstanceOf(ColonyNetworkError);
  });
});

describe("deleteAccount", () => {
  it("DELETEs /auth/account and resolves to {} on 204", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.noContent();

    const client = makeClient(mock);
    const result = await client.deleteAccount();

    expect(result).toEqual({});
    const del = mock.calls.find((c) => c.url.endsWith("/auth/account"));
    expect(del?.method).toBe("DELETE");
  });

  it("throws ColonyAuthError on AUTH_AGENT_ONLY (403)", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.respond(
      () =>
        new Response('{"detail":{"message":"agent only","code":"AUTH_AGENT_ONLY"}}', {
          status: 403,
        }),
    );
    await expect(makeClient(mock).deleteAccount()).rejects.toBeInstanceOf(ColonyAuthError);
  });

  it("throws ColonyConflictError on ACCOUNT_DELETE_HAS_ACTIVITY (409)", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.respond(
      () =>
        new Response('{"detail":{"message":"has activity","code":"ACCOUNT_DELETE_HAS_ACTIVITY"}}', {
          status: 409,
        }),
    );
    await expect(makeClient(mock).deleteAccount()).rejects.toMatchObject({
      code: "ACCOUNT_DELETE_HAS_ACTIVITY",
    });
  });
});

describe("raw escape hatch", () => {
  it("forwards arbitrary requests with auth", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ ok: true });

    const client = makeClient(mock);
    await client.raw("PUT", "/posts/p1/language?language=es");

    expect(mock.calls[1]?.method).toBe("PUT");
    expect(mock.calls[1]?.url).toContain("/posts/p1/language?language=es");
    expect(mock.calls[1]?.headers["authorization"]).toBe("Bearer test-token-abc");
  });
});

describe("comments", () => {
  it("createComment sends body and parentId", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ id: "c1", post_id: "p1", body: "hello" });
    const client = makeClient(mock);
    await client.createComment("p1", "hello", "parent1");
    const sent = JSON.parse(mock.calls[1]?.body ?? "{}");
    expect(sent.body).toBe("hello");
    expect(sent.parent_id).toBe("parent1");
    expect(sent.client).toBe("colony-sdk-js");
  });

  it("getComments hits the correct URL with page", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ items: [{ id: "c1" }], total: 1, page: 2 });
    const client = makeClient(mock);
    await client.getComments("p1", 2);
    expect(mock.calls[1]?.url).toContain("/posts/p1/comments?page=2");
  });

  it("getAllComments buffers into an array", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ items: [{ id: "c1" }, { id: "c2" }], total: 2 });
    const client = makeClient(mock);
    const all = await client.getAllComments("p1");
    expect(all).toHaveLength(2);
  });

  it("iterComments paginates and respects maxResults", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ items: Array.from({ length: 20 }, (_, i) => ({ id: `c${i}` })), total: 50 });
    mock.json({ items: Array.from({ length: 20 }, (_, i) => ({ id: `c${20 + i}` })), total: 50 });
    const client = makeClient(mock);
    const out: string[] = [];
    for await (const c of client.iterComments("p1", 25)) out.push(c["id"] as string);
    expect(out).toHaveLength(25);
  });

  it("updateComment sends PUT with body (v0.2.0)", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ id: "c1", body: "edited" });
    const client = makeClient(mock);
    await client.updateComment("c1", "edited");
    expect(mock.calls[1]?.method).toBe("PUT");
    expect(mock.calls[1]?.url).toContain("/comments/c1");
    expect(JSON.parse(mock.calls[1]?.body ?? "{}")).toEqual({ body: "edited" });
  });

  it("deleteComment sends DELETE to the correct path (v0.2.0)", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ ok: true });
    const client = makeClient(mock);
    await client.deleteComment("c1");
    expect(mock.calls[1]?.method).toBe("DELETE");
    expect(mock.calls[1]?.url).toContain("/comments/c1");
  });

  it("getPostContext hits /posts/{id}/context (v0.2.0)", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ post: { id: "p1" }, comments: [], author: {} });
    const client = makeClient(mock);
    const result = await client.getPostContext("p1");
    expect(mock.calls[1]?.method).toBe("GET");
    expect(mock.calls[1]?.url).toContain("/posts/p1/context");
    expect((result["post"] as { id: string }).id).toBe("p1");
  });

  it("getPostConversation hits /posts/{id}/conversation (v0.2.0)", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({
      post_id: "p1",
      thread_count: 1,
      total_comments: 1,
      threads: [{ id: "c1", replies: [] }],
    });
    const client = makeClient(mock);
    const result = await client.getPostConversation("p1");
    expect(mock.calls[1]?.method).toBe("GET");
    expect(mock.calls[1]?.url).toContain("/posts/p1/conversation");
    expect((result["threads"] as Array<{ id: string }>)[0]?.id).toBe("c1");
  });
});

describe("deletePost", () => {
  it("sends DELETE to the correct path", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ ok: true });
    const client = makeClient(mock);
    await client.deletePost("p1");
    expect(mock.calls[1]?.method).toBe("DELETE");
    expect(mock.calls[1]?.url).toContain("/posts/p1");
  });
});

describe("crosspost", () => {
  it("POSTs colony_id (and optional title) to /posts/{id}/crosspost", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ id: "p2" });
    const client = makeClient(mock);
    await client.crosspost("p1", "c9", { title: "Reframed" });
    expect(mock.calls[1]?.method).toBe("POST");
    expect(mock.calls[1]?.url).toContain("/posts/p1/crosspost");
    expect(JSON.parse(mock.calls[1]?.body ?? "{}")).toEqual({
      colony_id: "c9",
      title: "Reframed",
    });
  });

  it("omits title when not provided", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ id: "p2" });
    const client = makeClient(mock);
    await client.crosspost("p1", "c9");
    expect(JSON.parse(mock.calls[1]?.body ?? "{}")).toEqual({ colony_id: "c9" });
  });
});

describe("post pin/close/reopen", () => {
  it.each([
    ["pinPost", "pin"],
    ["closePost", "close"],
    ["reopenPost", "reopen"],
  ] as const)("%s POSTs to /posts/{id}/%s", async (method, path) => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ id: "p1" });
    const client = makeClient(mock);
    await client[method]("p1");
    expect(mock.calls[1]?.method).toBe("POST");
    expect(mock.calls[1]?.url).toContain(`/posts/p1/${path}`);
  });
});

describe("setPostLanguage", () => {
  it("PUTs to /posts/{id}/language with the language query param", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ post_id: "p1", language: "en" });
    const client = makeClient(mock);
    const result = await client.setPostLanguage("p1", "en");
    expect(mock.calls[1]?.method).toBe("PUT");
    expect(mock.calls[1]?.url).toContain("/posts/p1/language?language=en");
    expect(result.language).toBe("en");
  });
});

describe("getSuggestions", () => {
  it("hits /suggestions with default limit", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ suggestions: [], count: 0, categories: {} });
    const client = makeClient(mock);
    const result = await client.getSuggestions();
    expect(mock.calls[1]?.method).toBe("GET");
    expect(mock.calls[1]?.url).toContain("/suggestions?");
    expect(mock.calls[1]?.url).toContain("limit=20");
    expect(mock.calls[1]?.url).not.toContain("category");
    expect(mock.calls[1]?.url).not.toContain("kinds");
    expect(result.count).toBe(0);
  });

  it("forwards limit, category, and kinds filters", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ suggestions: [], count: 0, categories: {} });
    const client = makeClient(mock);
    await client.getSuggestions({ limit: 5, category: "network", kinds: "follow_user" });
    expect(mock.calls[1]?.url).toContain("limit=5");
    expect(mock.calls[1]?.url).toContain("category=network");
    expect(mock.calls[1]?.url).toContain("kinds=follow_user");
  });
});

describe("voteComment", () => {
  it("sends POST with value to /comments/{id}/vote", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ ok: true });
    const client = makeClient(mock);
    await client.voteComment("c1", -1);
    expect(mock.calls[1]?.url).toContain("/comments/c1/vote");
    expect(JSON.parse(mock.calls[1]?.body ?? "{}")).toEqual({ value: -1 });
  });
});

describe("getPoll", () => {
  it("hits /polls/{id}/results", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ options: [{ id: "a", text: "A" }] });
    const client = makeClient(mock);
    const result = await client.getPoll("poll1");
    expect(mock.calls[1]?.url).toContain("/polls/poll1/results");
    expect(result.options).toHaveLength(1);
  });
});

describe("messaging", () => {
  it("sendMessage posts to /messages/send/{username}", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ id: "m1", body: "hi" });
    const client = makeClient(mock);
    const msg = await client.sendMessage("alice", "hi");
    expect(mock.calls[1]?.url).toContain("/messages/send/alice");
    expect(JSON.parse(mock.calls[1]?.body ?? "{}").body).toBe("hi");
    expect(msg.body).toBe("hi");
  });

  it("getConversation hits the correct path", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ id: "conv1", other_user: { username: "bob" }, messages: [] });
    const client = makeClient(mock);
    const detail = await client.getConversation("bob");
    expect(mock.calls[1]?.url).toContain("/messages/conversations/bob");
    expect(detail.other_user.username).toBe("bob");
  });

  it("listConversations returns an array", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json([{ id: "conv1" }]);
    const client = makeClient(mock);
    const result = await client.listConversations();
    expect(Array.isArray(result)).toBe(true);
  });

  it("getUnreadCount returns unread_count", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ unread_count: 3 });
    const client = makeClient(mock);
    const result = await client.getUnreadCount();
    expect(result.unread_count).toBe(3);
  });

  it("markConversationRead posts to /conversations/{u}/read (v0.2.0)", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ ok: true });
    const client = makeClient(mock);
    await client.markConversationRead("alice");
    expect(mock.calls[1]?.method).toBe("POST");
    expect(mock.calls[1]?.url).toContain("/messages/conversations/alice/read");
  });

  it("archiveConversation + unarchiveConversation (v0.2.0)", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ ok: true });
    mock.json({ ok: true });
    const client = makeClient(mock);
    await client.archiveConversation("alice");
    await client.unarchiveConversation("alice");
    expect(mock.calls[1]?.url).toContain("/messages/conversations/alice/archive");
    expect(mock.calls[2]?.url).toContain("/messages/conversations/alice/unarchive");
  });

  it("muteConversation + unmuteConversation (v0.2.0)", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ ok: true });
    mock.json({ ok: true });
    const client = makeClient(mock);
    await client.muteConversation("alice");
    await client.unmuteConversation("alice");
    expect(mock.calls[1]?.url).toContain("/messages/conversations/alice/mute");
    expect(mock.calls[2]?.url).toContain("/messages/conversations/alice/unmute");
  });

  it("conversation-state methods URL-encode usernames with special chars (v0.2.0)", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ ok: true });
    const client = makeClient(mock);
    await client.markConversationRead("alice+bob");
    expect(mock.calls[1]?.url).toContain("/messages/conversations/alice%2Bbob/read");
  });
});

describe("group conversations: lifecycle + members", () => {
  const GROUP_ID = "11111111-2222-3333-4444-555555555555";
  const USER_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

  it("createGroupConversation puts title + repeated members as query params", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ id: GROUP_ID, title: "team", is_group: true, members: [] });
    const client = makeClient(mock);
    const result = await client.createGroupConversation("team", ["alice", "bob"]);
    expect(mock.calls[1]?.method).toBe("POST");
    const url = mock.calls[1]?.url ?? "";
    expect(url).toContain("/messages/groups?");
    expect(url).toContain("title=team");
    // Multiple members must serialize as repeated keys, not a comma list.
    expect(url).toContain("members=alice");
    expect(url).toContain("members=bob");
    expect(result.id).toBe(GROUP_ID);
  });

  it("createGroupConversation URL-encodes special characters in title", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ id: GROUP_ID });
    const client = makeClient(mock);
    await client.createGroupConversation("R&D Lab", ["alice"]);
    // `&` must be percent-encoded so the server parses one `title` param.
    expect(mock.calls[1]?.url).toContain("title=R%26D+Lab");
  });

  it("listGroupTemplates hits /messages/groups/templates", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ templates: [{ slug: "team", title: "Team" }] });
    const client = makeClient(mock);
    const result = await client.listGroupTemplates();
    expect(mock.calls[1]?.url).toContain("/messages/groups/templates");
    expect(result.templates[0]?.slug).toBe("team");
  });

  it("createGroupFromTemplate threads template + titleOverride", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ id: GROUP_ID, template: "team" });
    const client = makeClient(mock);
    await client.createGroupFromTemplate("team", ["alice"], { titleOverride: "Squad A" });
    const url = mock.calls[1]?.url ?? "";
    expect(url).toContain("/messages/groups/from-template?");
    expect(url).toContain("template=team");
    expect(url).toContain("members=alice");
    expect(url).toContain("title_override=Squad+A");
  });

  it("getGroupConversation defaults limit=50 offset=0", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ id: GROUP_ID, member_count: 2, messages: [] });
    const client = makeClient(mock);
    await client.getGroupConversation(GROUP_ID);
    expect(mock.calls[1]?.url).toContain(`/messages/groups/${GROUP_ID}?limit=50&offset=0`);
  });

  it("getGroupConversation accepts custom pagination", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ id: GROUP_ID });
    const client = makeClient(mock);
    await client.getGroupConversation(GROUP_ID, { limit: 20, offset: 40 });
    expect(mock.calls[1]?.url).toContain("limit=20");
    expect(mock.calls[1]?.url).toContain("offset=40");
  });

  it("updateGroupConversation with empty description clears (does NOT omit)", async () => {
    // `description: ""` is a deliberate three-state: empty string clears,
    // undefined means "don't touch", non-empty string sets new value.
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ ok: true });
    const client = makeClient(mock);
    await client.updateGroupConversation(GROUP_ID, { description: "" });
    expect(mock.calls[1]?.method).toBe("PATCH");
    expect(mock.calls[1]?.url).toContain("description=");
  });

  it("updateGroupConversation with both fields omitted sends PATCH with no query string", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ ok: true });
    const client = makeClient(mock);
    await client.updateGroupConversation(GROUP_ID);
    // No "?" — server is expected to 400; we let it surface naturally.
    expect(mock.calls[1]?.url).toMatch(/\/messages\/groups\/[^?]+$/);
  });

  it("updateGroupConversation with only title sends ?title=...", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ ok: true });
    const client = makeClient(mock);
    await client.updateGroupConversation(GROUP_ID, { title: "Renamed" });
    expect(mock.calls[1]?.method).toBe("PATCH");
    expect(mock.calls[1]?.url).toContain("title=Renamed");
    expect(mock.calls[1]?.url).not.toContain("description=");
  });

  it("createGroupFromTemplate works without titleOverride", async () => {
    // Exercise the no-override path so the cond is covered both ways.
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ id: GROUP_ID, template: "team" });
    const client = makeClient(mock);
    await client.createGroupFromTemplate("team", ["alice"]);
    const url = mock.calls[1]?.url ?? "";
    expect(url).toContain("template=team");
    expect(url).toContain("members=alice");
    expect(url).not.toContain("title_override");
  });

  it("sendGroupMessage posts body to /messages/groups/{id}/send", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ id: "m1", body: "hello" });
    const client = makeClient(mock);
    const msg = await client.sendGroupMessage(GROUP_ID, "hello");
    expect(mock.calls[1]?.url).toContain(`/messages/groups/${GROUP_ID}/send`);
    expect(JSON.parse(mock.calls[1]?.body ?? "{}").body).toBe("hello");
    expect(msg.body).toBe("hello");
  });

  it("sendGroupMessage threads replyToMessageId into the JSON body as reply_to_message_id", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ id: "m1" });
    const client = makeClient(mock);
    await client.sendGroupMessage(GROUP_ID, "hi", { replyToMessageId: "parent-id" });
    const body = JSON.parse(mock.calls[1]?.body ?? "{}");
    expect(body.reply_to_message_id).toBe("parent-id");
  });

  it("sendGroupMessage sets the Idempotency-Key header when supplied", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ id: "m1" });
    const client = makeClient(mock);
    await client.sendGroupMessage(GROUP_ID, "hi", { idempotencyKey: "key-123" });
    expect(mock.calls[1]?.headers["idempotency-key"]).toBe("key-123");
  });

  it("sendGroupMessage omits Idempotency-Key when not supplied", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ id: "m1" });
    const client = makeClient(mock);
    await client.sendGroupMessage(GROUP_ID, "hi");
    expect(mock.calls[1]?.headers["idempotency-key"]).toBeUndefined();
  });

  it("listGroupMembers hits /messages/groups/{id}/members", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ title: "team", description: null, creator_id: "x", members: [] });
    const client = makeClient(mock);
    const result = await client.listGroupMembers(GROUP_ID);
    expect(mock.calls[1]?.method).toBe("GET");
    expect(mock.calls[1]?.url).toContain(`/messages/groups/${GROUP_ID}/members`);
    expect(result.title).toBe("team");
  });

  it("addGroupMember POSTs username as query param", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ already_member: false, username: "alice" });
    const client = makeClient(mock);
    await client.addGroupMember(GROUP_ID, "alice");
    expect(mock.calls[1]?.method).toBe("POST");
    expect(mock.calls[1]?.url).toContain(`/messages/groups/${GROUP_ID}/members?username=alice`);
  });

  it("removeGroupMember DELETEs /members/{userId}", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ removed: true });
    const client = makeClient(mock);
    await client.removeGroupMember(GROUP_ID, USER_ID);
    expect(mock.calls[1]?.method).toBe("DELETE");
    expect(mock.calls[1]?.url).toContain(`/messages/groups/${GROUP_ID}/members/${USER_ID}`);
  });

  it("setGroupAdmin uses lowercase 'true'/'false' for FastAPI bool coercion", async () => {
    // FastAPI parses query-string bools strictly: 'true'/'false' (and a few
    // others). Python's `str(True)` → 'True' would be rejected. Pinned to
    // catch any future capitalisation regression.
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ user_id: USER_ID, is_admin: true });
    mock.json({ user_id: USER_ID, is_admin: false });
    const client = makeClient(mock);
    await client.setGroupAdmin(GROUP_ID, USER_ID, true);
    expect(mock.calls[1]?.method).toBe("PUT");
    expect(mock.calls[1]?.url).toContain("is_admin=true");
    expect(mock.calls[1]?.url).not.toContain("is_admin=True");
    await client.setGroupAdmin(GROUP_ID, USER_ID, false);
    expect(mock.calls[2]?.url).toContain("is_admin=false");
  });

  it("transferGroupCreator threads new_creator_username", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ conversation_id: GROUP_ID, new_creator_id: USER_ID });
    const client = makeClient(mock);
    await client.transferGroupCreator(GROUP_ID, "bob");
    expect(mock.calls[1]?.url).toContain(
      `/messages/groups/${GROUP_ID}/transfer-creator?new_creator_username=bob`,
    );
  });

  it("respondToGroupInvite serializes accept as lowercase bool", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ status: "accepted" });
    mock.json({ status: "declined" });
    const client = makeClient(mock);
    await client.respondToGroupInvite(GROUP_ID, true);
    expect(mock.calls[1]?.url).toContain("accept=true");
    await client.respondToGroupInvite(GROUP_ID, false);
    expect(mock.calls[2]?.url).toContain("accept=false");
  });

  it("markGroupAllRead hits /messages/groups/{id}/read-all", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ marked: 3 });
    const client = makeClient(mock);
    const result = await client.markGroupAllRead(GROUP_ID);
    expect(mock.calls[1]?.method).toBe("POST");
    expect(mock.calls[1]?.url).toContain(`/messages/groups/${GROUP_ID}/read-all`);
    expect(result.marked).toBe(3);
  });
});

describe("group conversations: state + search", () => {
  const GROUP_ID = "11111111-2222-3333-4444-555555555555";
  const MSG_ID = "22222222-3333-4444-5555-666666666666";

  it("muteGroupConversation with no until sends bare POST (server reads as forever)", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ muted: true, muted_until: null });
    const client = makeClient(mock);
    await client.muteGroupConversation(GROUP_ID);
    expect(mock.calls[1]?.method).toBe("POST");
    expect(mock.calls[1]?.url).toMatch(/\/messages\/groups\/[^?]+\/mute$/);
  });

  it("muteGroupConversation threads until into query string", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ muted: false, muted_until: "2026-05-28T11:00:00Z" });
    const client = makeClient(mock);
    await client.muteGroupConversation(GROUP_ID, { until: "1h" });
    expect(mock.calls[1]?.url).toContain(`/messages/groups/${GROUP_ID}/mute?until=1h`);
  });

  it("unmuteGroupConversation POSTs /unmute", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ muted: false, muted_until: null });
    const client = makeClient(mock);
    await client.unmuteGroupConversation(GROUP_ID);
    expect(mock.calls[1]?.method).toBe("POST");
    expect(mock.calls[1]?.url).toContain(`/messages/groups/${GROUP_ID}/unmute`);
  });

  it("snoozeGroupConversation threads duration as query param", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ snoozed_until: "2026-05-27T16:00:00Z" });
    const client = makeClient(mock);
    await client.snoozeGroupConversation(GROUP_ID, "until_morning");
    expect(mock.calls[1]?.method).toBe("POST");
    expect(mock.calls[1]?.url).toContain(
      `/messages/groups/${GROUP_ID}/snooze?duration=until_morning`,
    );
  });

  it("unsnoozeGroupConversation POSTs /unsnooze", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ snoozed_until: null });
    const client = makeClient(mock);
    await client.unsnoozeGroupConversation(GROUP_ID);
    expect(mock.calls[1]?.url).toContain(`/messages/groups/${GROUP_ID}/unsnooze`);
  });

  it("setGroupReadReceipts with show=true sends ?show=true (lowercase)", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ override: true, effective: true });
    const client = makeClient(mock);
    await client.setGroupReadReceipts(GROUP_ID, { show: true });
    expect(mock.calls[1]?.method).toBe("PATCH");
    expect(mock.calls[1]?.url).toContain(`/messages/groups/${GROUP_ID}/receipts?show=true`);
    expect(mock.calls[1]?.url).not.toContain("show=True");
  });

  it("setGroupReadReceipts with show=false sends ?show=false (lowercase)", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ override: false, effective: false });
    const client = makeClient(mock);
    await client.setGroupReadReceipts(GROUP_ID, { show: false });
    expect(mock.calls[1]?.url).toContain("show=false");
    expect(mock.calls[1]?.url).not.toContain("show=False");
  });

  it("setGroupReadReceipts with no show clears the override (no query string)", async () => {
    // The three-state contract: show=undefined → PATCH with no query
    // string at all. Distinct from show:true (?show=true) and show:false
    // (?show=false). Server falls back to user-level preference.
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ override: null, effective: true });
    const client = makeClient(mock);
    await client.setGroupReadReceipts(GROUP_ID);
    expect(mock.calls[1]?.method).toBe("PATCH");
    expect(mock.calls[1]?.url).toMatch(/\/messages\/groups\/[^?]+\/receipts$/);
  });

  it("pinGroupMessage POSTs /messages/{msgId}/pin", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ pinned: true, message_id: MSG_ID });
    const client = makeClient(mock);
    await client.pinGroupMessage(GROUP_ID, MSG_ID);
    expect(mock.calls[1]?.method).toBe("POST");
    expect(mock.calls[1]?.url).toContain(`/messages/groups/${GROUP_ID}/messages/${MSG_ID}/pin`);
  });

  it("unpinGroupMessage DELETEs /messages/{msgId}/pin", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ pinned: false, message_id: MSG_ID });
    const client = makeClient(mock);
    await client.unpinGroupMessage(GROUP_ID, MSG_ID);
    expect(mock.calls[1]?.method).toBe("DELETE");
    expect(mock.calls[1]?.url).toContain(`/messages/groups/${GROUP_ID}/messages/${MSG_ID}/pin`);
  });

  it("searchGroupMessages defaults limit=50 offset=0", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ hits: [], total: 0 });
    const client = makeClient(mock);
    await client.searchGroupMessages(GROUP_ID, "hi");
    expect(mock.calls[1]?.url).toContain(
      `/messages/groups/${GROUP_ID}/search?q=hi&limit=50&offset=0`,
    );
  });

  it("searchGroupMessages accepts custom pagination", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ hits: [], total: 0 });
    const client = makeClient(mock);
    await client.searchGroupMessages(GROUP_ID, "term", { limit: 20, offset: 40 });
    expect(mock.calls[1]?.url).toContain("limit=20");
    expect(mock.calls[1]?.url).toContain("offset=40");
  });

  it("searchGroupMessages percent-encodes ampersands in the query", async () => {
    // `R&D` must serialize as `q=R%26D` so the server parses one `q`
    // param. URLSearchParams handles this; pin to catch any future
    // hand-rolled query-string construction.
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ hits: [], total: 0 });
    const client = makeClient(mock);
    await client.searchGroupMessages(GROUP_ID, "R&D");
    expect(mock.calls[1]?.url).toContain("q=R%26D");
  });
});

describe("per-message operations (1:1 + group)", () => {
  const MSG_ID = "22222222-3333-4444-5555-666666666666";

  it("markMessageRead POSTs /messages/{id}/read", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ message_id: MSG_ID, was_unread: true });
    const client = makeClient(mock);
    await client.markMessageRead(MSG_ID);
    expect(mock.calls[1]?.method).toBe("POST");
    expect(mock.calls[1]?.url).toContain(`/messages/${MSG_ID}/read`);
  });

  it("listMessageReads GETs /messages/{id}/reads", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ is_group: false, seen: [], unseen: [] });
    const client = makeClient(mock);
    await client.listMessageReads(MSG_ID);
    expect(mock.calls[1]?.method).toBe("GET");
    expect(mock.calls[1]?.url).toContain(`/messages/${MSG_ID}/reads`);
  });

  it("addMessageReaction POSTs emoji in the JSON body", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ emoji: "👍", user_id: "u" });
    const client = makeClient(mock);
    await client.addMessageReaction(MSG_ID, "👍");
    expect(mock.calls[1]?.method).toBe("POST");
    expect(mock.calls[1]?.url).toContain(`/messages/${MSG_ID}/reactions`);
    expect(JSON.parse(mock.calls[1]?.body ?? "{}").emoji).toBe("👍");
  });

  it("removeMessageReaction percent-encodes the emoji in the path", async () => {
    // 👍 = U+1F44D → UTF-8 F0 9F 91 8D → %F0%9F%91%8D
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ removed: true });
    const client = makeClient(mock);
    await client.removeMessageReaction(MSG_ID, "👍");
    expect(mock.calls[1]?.method).toBe("DELETE");
    expect(mock.calls[1]?.url).toContain(`/messages/${MSG_ID}/reactions/%F0%9F%91%8D`);
  });

  it("editMessage PATCHes /messages/{id} with body", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ id: MSG_ID, body: "Fixed" });
    const client = makeClient(mock);
    await client.editMessage(MSG_ID, "Fixed");
    expect(mock.calls[1]?.method).toBe("PATCH");
    expect(mock.calls[1]?.url).toContain(`/messages/${MSG_ID}`);
    expect(JSON.parse(mock.calls[1]?.body ?? "{}").body).toBe("Fixed");
  });

  it("listMessageEdits GETs /messages/{id}/edits", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ message_id: MSG_ID, versions: [] });
    const client = makeClient(mock);
    await client.listMessageEdits(MSG_ID);
    expect(mock.calls[1]?.url).toContain(`/messages/${MSG_ID}/edits`);
  });

  it("deleteMessage DELETEs /messages/{id}", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ deleted: true, message_id: MSG_ID });
    const client = makeClient(mock);
    await client.deleteMessage(MSG_ID);
    expect(mock.calls[1]?.method).toBe("DELETE");
    expect(mock.calls[1]?.url).toMatch(/\/messages\/[^/]+$/);
  });

  it("toggleStarMessage POSTs /messages/{id}/star", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ saved: true });
    const client = makeClient(mock);
    const result = await client.toggleStarMessage(MSG_ID);
    expect(mock.calls[1]?.method).toBe("POST");
    expect(mock.calls[1]?.url).toContain(`/messages/${MSG_ID}/star`);
    expect(result.saved).toBe(true);
  });

  it("listSavedMessages defaults limit=50 offset=0", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ messages: [], pagination: { total: 0, has_more: false } });
    const client = makeClient(mock);
    await client.listSavedMessages();
    expect(mock.calls[1]?.url).toContain("/messages/saved?limit=50&offset=0");
  });

  it("listSavedMessages accepts custom pagination", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ messages: [], pagination: { total: 0, has_more: false } });
    const client = makeClient(mock);
    await client.listSavedMessages({ limit: 20, offset: 40 });
    expect(mock.calls[1]?.url).toContain("limit=20");
    expect(mock.calls[1]?.url).toContain("offset=40");
  });

  it("forwardMessage threads recipient_username + comment as query params", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ id: "fwd" });
    const client = makeClient(mock);
    await client.forwardMessage(MSG_ID, "carol", { comment: "FYI" });
    expect(mock.calls[1]?.method).toBe("POST");
    const url = mock.calls[1]?.url ?? "";
    expect(url).toContain(`/messages/${MSG_ID}/forward?`);
    expect(url).toContain("recipient_username=carol");
    expect(url).toContain("comment=FYI");
  });

  it("forwardMessage defaults comment to empty string on the wire", async () => {
    // The comment query param always appears, so the server doesn't
    // have to special-case missing — pinned to catch a future change
    // that started omitting it.
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ id: "fwd" });
    const client = makeClient(mock);
    await client.forwardMessage(MSG_ID, "carol");
    expect(mock.calls[1]?.url).toContain("comment=");
  });
});

describe("attachments + group avatar (multipart)", () => {
  const GROUP_ID = "11111111-2222-3333-4444-555555555555";
  const ATTACHMENT_ID = "33333333-4444-5555-6666-777777777777";
  const PNG_HEADER = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

  it("uploadMessageAttachment builds a multipart/form-data POST with the file", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({
      id: ATTACHMENT_ID,
      mime_type: "image/png",
      size_bytes: 4,
      deduped: false,
    });
    const client = makeClient(mock);
    const result = await client.uploadMessageAttachment("screenshot.png", PNG_HEADER, "image/png");
    expect(mock.calls[1]?.method).toBe("POST");
    expect(mock.calls[1]?.url).toContain("/messages/attachments/upload");
    // The SDK must NOT pre-set Content-Type — fetch derives it from
    // the FormData body (including the boundary token) at serialize
    // time. If the SDK set it, the boundary would be missing and the
    // server would reject the envelope.
    expect(mock.calls[1]?.headers["content-type"]).toBeUndefined();
    expect(result.id).toBe(ATTACHMENT_ID);
  });

  it("uploadMessageAttachment accepts ArrayBuffer as input", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ id: ATTACHMENT_ID });
    const client = makeClient(mock);
    const buf = new ArrayBuffer(8);
    await client.uploadMessageAttachment("x.png", buf, "image/png");
    // Same Content-Type-not-set contract as the Uint8Array variant.
    expect(mock.calls[1]?.headers["content-type"]).toBeUndefined();
  });

  it("deleteMessageAttachment DELETEs /messages/attachments/{id}", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({});
    const client = makeClient(mock);
    await client.deleteMessageAttachment(ATTACHMENT_ID);
    expect(mock.calls[1]?.method).toBe("DELETE");
    expect(mock.calls[1]?.url).toContain(`/messages/attachments/${ATTACHMENT_ID}`);
  });

  it("getMessageAttachment GETs /full by default and returns raw bytes", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.respond(
      () => new Response(PNG_HEADER, { status: 200, headers: { "Content-Type": "image/png" } }),
    );
    const client = makeClient(mock);
    const bytes = await client.getMessageAttachment(ATTACHMENT_ID);
    expect(mock.calls[1]?.method).toBe("GET");
    expect(mock.calls[1]?.url).toContain(`/messages/attachments/${ATTACHMENT_ID}/full`);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(Array.from(bytes)).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it("getMessageAttachment respects the variant option", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.respond(() => new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    const client = makeClient(mock);
    await client.getMessageAttachment(ATTACHMENT_ID, { variant: "thumb" });
    expect(mock.calls[1]?.url).toContain(`/messages/attachments/${ATTACHMENT_ID}/thumb`);
  });

  it("getMessageAttachment surfaces 403 as ColonyAuthError", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ detail: { message: "Not a participant", code: "FORBIDDEN" } }, 403);
    const client = makeClient(mock);
    const { ColonyAuthError } = await import("../src/errors.js");
    await expect(client.getMessageAttachment(ATTACHMENT_ID)).rejects.toBeInstanceOf(
      ColonyAuthError,
    );
  });

  it("uploadMessageAttachment surfaces 413 as ColonyAPIError with status=413", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ detail: { message: "Too big", code: "LIMIT_EXCEEDED" } }, 413);
    const client = makeClient(mock);
    const { ColonyAPIError } = await import("../src/errors.js");
    await expect(
      client.uploadMessageAttachment("huge.png", PNG_HEADER, "image/png"),
    ).rejects.toMatchObject({ status: 413 });
    // Re-issue with a fresh handler to assert it's the right error class.
    mock.json({ detail: { message: "Too big", code: "LIMIT_EXCEEDED" } }, 413);
    await expect(
      client.uploadMessageAttachment("huge.png", PNG_HEADER, "image/png"),
    ).rejects.toBeInstanceOf(ColonyAPIError);
  });

  it("uploadGroupAvatar POSTs multipart to /messages/groups/{id}/avatar", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ avatar_url: `/messages/groups/${GROUP_ID}/avatar?v=2` });
    const client = makeClient(mock);
    const result = await client.uploadGroupAvatar(GROUP_ID, "team.png", PNG_HEADER, "image/png");
    expect(mock.calls[1]?.method).toBe("POST");
    expect(mock.calls[1]?.url).toContain(`/messages/groups/${GROUP_ID}/avatar`);
    // SDK doesn't pre-set Content-Type (fetch derives it from FormData).
    expect(mock.calls[1]?.headers["content-type"]).toBeUndefined();
    expect(result.avatar_url).toContain(GROUP_ID);
  });

  it("getGroupAvatar returns raw bytes", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    const avatarBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
    mock.respond(() => new Response(avatarBytes, { status: 200 }));
    const client = makeClient(mock);
    const bytes = await client.getGroupAvatar(GROUP_ID);
    expect(mock.calls[1]?.method).toBe("GET");
    expect(mock.calls[1]?.url).toContain(`/messages/groups/${GROUP_ID}/avatar`);
    expect(Array.from(bytes)).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
  });

  it("uploadMessageAttachment wraps network errors as ColonyNetworkError", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    // Hand the upload a handler that throws — simulates DNS/connect fail.
    mock.respond(() => {
      throw new Error("connection refused");
    });
    const client = makeClient(mock);
    const { ColonyNetworkError } = await import("../src/errors.js");
    await expect(
      client.uploadMessageAttachment("x.png", PNG_HEADER, "image/png"),
    ).rejects.toBeInstanceOf(ColonyNetworkError);
  });

  it("getMessageAttachment wraps network errors as ColonyNetworkError", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.respond(() => {
      throw new Error("dns failure");
    });
    const client = makeClient(mock);
    const { ColonyNetworkError } = await import("../src/errors.js");
    await expect(client.getMessageAttachment(ATTACHMENT_ID)).rejects.toBeInstanceOf(
      ColonyNetworkError,
    );
  });

  it("uploadMessageAttachment returns {} on empty 200 body", async () => {
    // Some endpoints respond with a 200 and an empty body; the
    // multipart helper should fall through to an empty object rather
    // than throw a JSON parse error.
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.respond(() => new Response("", { status: 200 }));
    const client = makeClient(mock);
    const result = await client.uploadMessageAttachment("x.png", PNG_HEADER, "image/png");
    expect(result).toEqual({});
  });

  it("uploadMessageAttachment falls through to {} on non-JSON 200 body", async () => {
    // Defensive parse — if the server returns malformed JSON, the
    // helper should return an empty object rather than propagating
    // a SyntaxError up the call stack.
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.respond(
      () =>
        new Response("not json at all", {
          status: 200,
          headers: { "Content-Type": "text/plain" },
        }),
    );
    const client = makeClient(mock);
    const result = await client.uploadMessageAttachment("x.png", PNG_HEADER, "image/png");
    expect(result).toEqual({});
  });

  it("uploadMessageAttachment forwards Retry-After on 429", async () => {
    // 429 + numeric Retry-After header should round-trip as the
    // retryAfter field on ColonyRateLimitError. Pinned to catch a
    // regression in either the header regex or the conditional
    // assignment.
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.respond(
      () =>
        new Response(JSON.stringify({ detail: "slow down" }), {
          status: 429,
          headers: { "Retry-After": "42" },
        }),
    );
    const client = makeClient(mock);
    const { ColonyRateLimitError } = await import("../src/errors.js");
    await expect(
      client.uploadMessageAttachment("x.png", PNG_HEADER, "image/png"),
    ).rejects.toMatchObject({ status: 429, retryAfter: 42 });
    // And confirm the class for completeness.
    mock.respond(
      () =>
        new Response(JSON.stringify({ detail: "slow down" }), {
          status: 429,
          headers: { "Retry-After": "42" },
        }),
    );
    await expect(
      client.uploadMessageAttachment("x.png", PNG_HEADER, "image/png"),
    ).rejects.toBeInstanceOf(ColonyRateLimitError);
  });

  it("uploadMessageAttachment forwards a caller-supplied AbortSignal", async () => {
    // Hits the `signal ? AbortSignal.any([...]) : timeoutSignal`
    // branch — without this test only the no-caller-signal arm is
    // exercised.
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ id: ATTACHMENT_ID });
    const client = makeClient(mock);
    const controller = new AbortController();
    await client.uploadMessageAttachment("x.png", PNG_HEADER, "image/png", {
      signal: controller.signal,
    });
    // No assertion needed beyond "didn't throw" — the goal is to
    // exercise the conditional. The combined signal is built before
    // fetch is called.
    expect(mock.calls[1]?.method).toBe("POST");
  });

  it("getMessageAttachment forwards a caller-supplied AbortSignal", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.respond(() => new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    const client = makeClient(mock);
    const controller = new AbortController();
    await client.getMessageAttachment(ATTACHMENT_ID, { signal: controller.signal });
    expect(mock.calls[1]?.method).toBe("GET");
  });

  it("uploadMessageAttachment stringifies non-Error throws from fetch", async () => {
    // If something throws a non-Error (string, number, plain object),
    // the helper must fall through to String(err) rather than crash
    // trying to read `.message`. Covers the `err instanceof Error`
    // ternary's false branch.
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.respond(() => {
      throw "raw string thrown by transport";
    });
    const client = makeClient(mock);
    const { ColonyNetworkError } = await import("../src/errors.js");
    await expect(
      client.uploadMessageAttachment("x.png", PNG_HEADER, "image/png"),
    ).rejects.toBeInstanceOf(ColonyNetworkError);
  });

  it("getMessageAttachment stringifies non-Error throws from fetch", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.respond(() => {
      throw "raw string thrown by transport";
    });
    const client = makeClient(mock);
    const { ColonyNetworkError } = await import("../src/errors.js");
    await expect(client.getMessageAttachment(ATTACHMENT_ID)).rejects.toBeInstanceOf(
      ColonyNetworkError,
    );
  });

  it("uploadMessageAttachment skips Authorization header when token is empty", async () => {
    // If /auth/token returns an empty access_token, this.token is
    // assigned "" which is falsy. The helper's `if (this.token)`
    // guard then correctly omits the Authorization header rather
    // than sending "Bearer ".  This covers the false-branch of the
    // token guard inside rawMultipartUpload.
    const mock = new MockFetch();
    mock.json({ access_token: "" }); // empty auth response
    mock.json({ id: ATTACHMENT_ID });
    const client = makeClient(mock);
    await client.uploadMessageAttachment("x.png", PNG_HEADER, "image/png");
    expect(mock.calls[1]?.headers["authorization"]).toBeUndefined();
  });

  it("getMessageAttachment skips Authorization header when token is empty", async () => {
    // Same false-branch coverage for rawRequestBytes.
    const mock = new MockFetch();
    mock.json({ access_token: "" });
    mock.respond(() => new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    const client = makeClient(mock);
    await client.getMessageAttachment(ATTACHMENT_ID);
    expect(mock.calls[1]?.headers["authorization"]).toBeUndefined();
  });
});

describe("trending + reports (v0.2.0)", () => {
  it("getRisingPosts hits /trending/posts/rising with no params by default", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ items: [{ id: "p1" }], total: 1 });
    const client = makeClient(mock);
    const result = await client.getRisingPosts();
    expect(mock.calls[1]?.method).toBe("GET");
    expect(mock.calls[1]?.url).toContain("/trending/posts/rising");
    expect(mock.calls[1]?.url).not.toContain("?");
    expect(result.items).toHaveLength(1);
  });

  it("getRisingPosts forwards limit + offset", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ items: [], total: 0 });
    const client = makeClient(mock);
    await client.getRisingPosts({ limit: 5, offset: 10 });
    expect(mock.calls[1]?.url).toContain("limit=5");
    expect(mock.calls[1]?.url).toContain("offset=10");
  });

  it("getForYouFeed hits /feed/for-you with default limit", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ items: [], personalised: false, count: 0 });
    const client = makeClient(mock);
    const result = await client.getForYouFeed();
    expect(mock.calls[1]?.method).toBe("GET");
    expect(mock.calls[1]?.url).toContain("/feed/for-you?");
    expect(mock.calls[1]?.url).toContain("limit=25");
    expect(mock.calls[1]?.url).not.toContain("offset");
    expect(result.personalised).toBe(false);
  });

  it("getForYouFeed forwards limit + offset", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ items: [], personalised: true, count: 0 });
    const client = makeClient(mock);
    await client.getForYouFeed({ limit: 10, offset: 20 });
    expect(mock.calls[1]?.url).toContain("limit=10");
    expect(mock.calls[1]?.url).toContain("offset=20");
  });

  it("getSystemNotifications hits /system/notifications unauthenticated", async () => {
    const mock = new MockFetch();
    // No withAuthToken(): the endpoint is public, so there must be no
    // /auth/token call and no Authorization header on the request itself.
    mock.json([
      {
        id: "n1",
        level: "maintenance",
        title: "Downtime",
        body: "...",
        published_at: "2026-07-01T12:00:00Z",
      },
    ]);
    const client = makeClient(mock);
    const result = await client.getSystemNotifications();
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]?.method).toBe("GET");
    expect(mock.calls[0]?.url).toContain("/system/notifications");
    expect(mock.calls[0]?.headers["authorization"]).toBeUndefined();
    expect(result[0]?.level).toBe("maintenance");
  });

  it("getSystemNotifications returns [] when there are none", async () => {
    const mock = new MockFetch();
    mock.json([]);
    const client = makeClient(mock);
    expect(await client.getSystemNotifications()).toEqual([]);
  });

  it("getTrendingTags hits /trending/tags with no params by default", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ tags: [] });
    const client = makeClient(mock);
    await client.getTrendingTags();
    expect(mock.calls[1]?.url).toContain("/trending/tags");
    expect(mock.calls[1]?.url).not.toContain("?");
  });

  it("getTrendingTags forwards window + limit + offset", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ tags: [] });
    const client = makeClient(mock);
    await client.getTrendingTags({ window: "day", limit: 20, offset: 0 });
    expect(mock.calls[1]?.url).toContain("window=day");
    expect(mock.calls[1]?.url).toContain("limit=20");
    expect(mock.calls[1]?.url).toContain("offset=0");
  });

  it("getUserReport hits /agents/{username}/report", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ username: "alice", toll_stats: {}, facilitation: {} });
    const client = makeClient(mock);
    const report = await client.getUserReport("alice");
    expect(mock.calls[1]?.method).toBe("GET");
    expect(mock.calls[1]?.url).toContain("/agents/alice/report");
    expect(report["username"]).toBe("alice");
  });

  it("getUserReport URL-encodes usernames with special chars", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({});
    const client = makeClient(mock);
    await client.getUserReport("foo bar");
    expect(mock.calls[1]?.url).toContain("/agents/foo%20bar/report");
  });
});

describe("sentinel ops + batch fetch (v0.9.0)", () => {
  it("movePostToColony PUTs to /posts/{id}/colony with colony query", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ post_id: "p1", from_colony_id: "src", to_colony_id: "dst", moved: true });
    const client = makeClient(mock);
    const result = await client.movePostToColony("p1", "test-posts");
    expect(mock.calls[1]?.method).toBe("PUT");
    expect(mock.calls[1]?.url).toContain("/posts/p1/colony?colony=test-posts");
    expect(result["moved"]).toBe(true);
  });

  it("markPostScanned defaults to scanned=true", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ post_id: "p1", sentinel_scanned: true });
    const client = makeClient(mock);
    const result = await client.markPostScanned("p1");
    expect(mock.calls[1]?.method).toBe("PUT");
    expect(mock.calls[1]?.url).toContain("/posts/p1/sentinel-scanned?scanned=true");
    expect(result["sentinel_scanned"]).toBe(true);
  });

  it("markPostScanned passes scanned=false when re-queuing", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ post_id: "p1", sentinel_scanned: false });
    const client = makeClient(mock);
    await client.markPostScanned("p1", false);
    expect(mock.calls[1]?.url).toContain("/posts/p1/sentinel-scanned?scanned=false");
  });

  it("markCommentScanned hits /comments/{id}/sentinel-scanned", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ comment_id: "c1", sentinel_scanned: true });
    const client = makeClient(mock);
    await client.markCommentScanned("c1");
    expect(mock.calls[1]?.method).toBe("PUT");
    expect(mock.calls[1]?.url).toContain("/comments/c1/sentinel-scanned?scanned=true");
  });

  it("markCommentScanned passes scanned=false when re-queuing", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ comment_id: "c1", sentinel_scanned: false });
    const client = makeClient(mock);
    await client.markCommentScanned("c1", false);
    expect(mock.calls[1]?.url).toContain("/comments/c1/sentinel-scanned?scanned=false");
  });

  it("getPostsByIds collects posts and skips 404s", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ id: "p1" });
    mock.respond(() => new Response('{"detail":"missing"}', { status: 404 }));
    mock.json({ id: "p3" });
    const client = makeClient(mock);
    const result = await client.getPostsByIds(["p1", "p2", "p3"]);
    expect(result.map((p) => p["id"])).toEqual(["p1", "p3"]);
  });

  it("getPostsByIds re-throws non-404 errors", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.respond(() => new Response('{"detail":"boom"}', { status: 500 }));
    const client = makeClient(mock);
    await expect(client.getPostsByIds(["p1"])).rejects.toBeInstanceOf(ColonyAPIError);
  });

  it("getUsersByIds collects users and skips 404s", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ id: "u1" });
    mock.respond(() => new Response('{"detail":"missing"}', { status: 404 }));
    mock.json({ id: "u3" });
    const client = makeClient(mock);
    const result = await client.getUsersByIds(["u1", "u2", "u3"]);
    expect(result.map((u) => u["id"])).toEqual(["u1", "u3"]);
  });

  it("getUsersByIds re-throws non-404 errors", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.respond(() => new Response('{"detail":"boom"}', { status: 500 }));
    const client = makeClient(mock);
    await expect(client.getUsersByIds(["u1"])).rejects.toBeInstanceOf(ColonyAPIError);
  });
});

describe("search", () => {
  it("builds query string with all filters", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ items: [], total: 0, users: [] });
    const client = makeClient(mock);
    await client.search("colony", {
      limit: 10,
      offset: 5,
      postType: "finding",
      colony: "general",
      authorType: "agent",
      sort: "newest",
    });
    const url = mock.calls[1]?.url ?? "";
    expect(url).toContain("q=colony");
    expect(url).toContain("limit=10");
    expect(url).toContain("offset=5");
    expect(url).toContain("post_type=finding");
    expect(url).toContain("author_type=agent");
    expect(url).toContain("sort=newest");
  });
});

describe("getUser", () => {
  it("fetches /users/{id}", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ id: "u1", username: "alice" });
    const client = makeClient(mock);
    const user = await client.getUser("u1");
    expect(mock.calls[1]?.url).toContain("/users/u1");
    expect(user.username).toBe("alice");
  });
});

describe("directory", () => {
  it("builds query string correctly", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ items: [], total: 0 });
    const client = makeClient(mock);
    await client.directory({
      query: "test",
      userType: "agent",
      sort: "newest",
      limit: 10,
      offset: 5,
    });
    const url = mock.calls[1]?.url ?? "";
    expect(url).toContain("q=test");
    expect(url).toContain("user_type=agent");
    expect(url).toContain("sort=newest");
    expect(url).toContain("limit=10");
    expect(url).toContain("offset=5");
  });
});

describe("following", () => {
  it("follow posts to /users/{id}/follow", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ ok: true });
    const client = makeClient(mock);
    await client.follow("u1");
    expect(mock.calls[1]?.method).toBe("POST");
    expect(mock.calls[1]?.url).toContain("/users/u1/follow");
  });

  it("unfollow sends DELETE to /users/{id}/follow", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ ok: true });
    const client = makeClient(mock);
    await client.unfollow("u1");
    expect(mock.calls[1]?.method).toBe("DELETE");
    expect(mock.calls[1]?.url).toContain("/users/u1/follow");
  });
});

describe("notifications", () => {
  it("getNotifications builds query with unreadOnly", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json([{ id: "n1", is_read: false }]);
    const client = makeClient(mock);
    await client.getNotifications({ unreadOnly: true, limit: 10 });
    const url = mock.calls[1]?.url ?? "";
    expect(url).toContain("unread_only=true");
    expect(url).toContain("limit=10");
  });

  it("getNotificationCount hits /notifications/count", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ unread_count: 5 });
    const client = makeClient(mock);
    const result = await client.getNotificationCount();
    expect(result.unread_count).toBe(5);
  });

  it("markNotificationsRead posts to /notifications/read-all", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({});
    const client = makeClient(mock);
    await client.markNotificationsRead();
    expect(mock.calls[1]?.method).toBe("POST");
    expect(mock.calls[1]?.url).toContain("/notifications/read-all");
  });

  it("markNotificationRead posts to /notifications/{id}/read", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({});
    const client = makeClient(mock);
    await client.markNotificationRead("n1");
    expect(mock.calls[1]?.url).toContain("/notifications/n1/read");
  });
});

describe("colonies", () => {
  it("getColonies hits /colonies with limit", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json([{ id: "col1", name: "general" }]);
    const client = makeClient(mock);
    const result = await client.getColonies(10);
    expect(mock.calls[1]?.url).toContain("/colonies?limit=10");
    expect(Array.isArray(result)).toBe(true);
  });

  it("joinColony resolves name to UUID", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ ok: true });
    const client = makeClient(mock);
    await client.joinColony("general");
    expect(mock.calls[1]?.url).toContain("/colonies/2e549d01");
    expect(mock.calls[1]?.method).toBe("POST");
  });

  it("leaveColony resolves name to UUID", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ ok: true });
    const client = makeClient(mock);
    await client.leaveColony("general");
    expect(mock.calls[1]?.url).toContain("/colonies/2e549d01");
    expect(mock.calls[1]?.method).toBe("POST");
  });
});

describe("webhooks", () => {
  it("createWebhook sends url, events, secret", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ id: "wh1", url: "https://x.com", events: ["post_created"], is_active: true });
    const client = makeClient(mock);
    const wh = await client.createWebhook("https://x.com", ["post_created"], "secret1234567890");
    expect(mock.calls[1]?.method).toBe("POST");
    const sent = JSON.parse(mock.calls[1]?.body ?? "{}");
    expect(sent.url).toBe("https://x.com");
    expect(sent.events).toEqual(["post_created"]);
    expect(sent.secret).toBe("secret1234567890");
    expect(wh.is_active).toBe(true);
  });

  it("getWebhooks returns an array", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json([{ id: "wh1" }]);
    const client = makeClient(mock);
    const result = await client.getWebhooks();
    expect(Array.isArray(result)).toBe(true);
  });

  it("deleteWebhook sends DELETE", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ ok: true });
    const client = makeClient(mock);
    await client.deleteWebhook("wh1");
    expect(mock.calls[1]?.method).toBe("DELETE");
    expect(mock.calls[1]?.url).toContain("/webhooks/wh1");
  });
});

describe("register network error", () => {
  it("throws ColonyNetworkError on fetch failure", async () => {
    const mock = new MockFetch();
    mock.respond(() => {
      throw new TypeError("fetch failed");
    });
    await expect(
      ColonyClient.register({
        username: "x",
        displayName: "x",
        bio: "x",
        fetch: mock.fetch,
      }),
    ).rejects.toBeInstanceOf(ColonyNetworkError);
  });
});

describe("optional parameter branches", () => {
  it("getPosts with offset, tag, and search params", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ items: [], total: 0 });
    const client = makeClient(mock);
    await client.getPosts({ offset: 10, tag: "ai", search: "colony" });
    const url = mock.calls[1]?.url ?? "";
    expect(url).toContain("offset=10");
    expect(url).toContain("tag=ai");
    expect(url).toContain("search=colony");
  });

  it("createPost without metadata does not include metadata key", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ id: "p1" });
    const client = makeClient(mock);
    await client.createPost("t", "b");
    const sent = JSON.parse(mock.calls[1]?.body ?? "{}");
    expect(sent.metadata).toBeUndefined();
    expect(sent.colony_id).toBeDefined();
    expect(sent.post_type).toBe("discussion");
  });

  it("createComment without parentId omits parent_id", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ id: "c1" });
    const client = makeClient(mock);
    await client.createComment("p1", "text");
    const sent = JSON.parse(mock.calls[1]?.body ?? "{}");
    expect(sent.parent_id).toBeUndefined();
  });

  it("search with no optional filters uses defaults", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ items: [], total: 0, users: [] });
    const client = makeClient(mock);
    await client.search("test");
    const url = mock.calls[1]?.url ?? "";
    expect(url).toContain("q=test");
    expect(url).toContain("limit=20");
    expect(url).not.toContain("offset");
    expect(url).not.toContain("post_type");
  });

  it("directory with defaults only sends user_type, sort, limit", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ items: [], total: 0 });
    const client = makeClient(mock);
    await client.directory();
    const url = mock.calls[1]?.url ?? "";
    expect(url).toContain("user_type=all");
    expect(url).toContain("sort=karma");
    expect(url).toContain("limit=20");
    expect(url).not.toContain("q=");
  });

  it("getNotifications with defaults", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json([]);
    const client = makeClient(mock);
    await client.getNotifications();
    const url = mock.calls[1]?.url ?? "";
    expect(url).toContain("limit=50");
    expect(url).not.toContain("unread_only");
  });

  it("updatePost with only body field", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ id: "p1" });
    const client = makeClient(mock);
    await client.updatePost("p1", { body: "new body" });
    const sent = JSON.parse(mock.calls[1]?.body ?? "{}");
    expect(sent).toEqual({ body: "new body" });
    expect(sent.title).toBeUndefined();
  });

  it("updateProfile with displayName and capabilities", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ id: "me" });
    const client = makeClient(mock);
    await client.updateProfile({
      displayName: "New Name",
      capabilities: { skills: ["ts"] },
    });
    const sent = JSON.parse(mock.calls[1]?.body ?? "{}");
    expect(sent.display_name).toBe("New Name");
    expect(sent.capabilities).toEqual({ skills: ["ts"] });
  });

  it("updateWebhook with url, secret, events, and isActive", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ id: "wh1" });
    const client = makeClient(mock);
    await client.updateWebhook("wh1", {
      url: "https://x.com",
      secret: "new-secret-1234567",
      events: ["post_created"],
      isActive: false,
    });
    const sent = JSON.parse(mock.calls[1]?.body ?? "{}");
    expect(sent.url).toBe("https://x.com");
    expect(sent.secret).toBe("new-secret-1234567");
    expect(sent.events).toEqual(["post_created"]);
    expect(sent.is_active).toBe(false);
  });

  it("rotateKey when server returns no api_key field", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ status: "ok" }); // no api_key field
    const client = makeClient(mock);
    const result = await client.rotateKey();
    expect(result.status).toBe("ok");
  });
});

describe("rawRequest edge cases", () => {
  it("returns empty object when response body is unparseable", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.respond(() => new Response("not json", { status: 200 }));
    const client = makeClient(mock);
    const result = await client.getMe();
    expect(result).toEqual({});
  });

  it("returns empty object when response body is empty (204-style)", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.respond(() => new Response("", { status: 200 }));
    const client = makeClient(mock);
    const result = await client.getMe();
    expect(result).toEqual({});
  });

  it("handles non-Error thrown from fetch", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.respond(() => {
      throw "string error";
    });
    const client = makeClient(mock);
    await expect(client.getMe()).rejects.toBeInstanceOf(ColonyNetworkError);
  });

  it("rotateKey with signal and cache enabled", async () => {
    const cache = new Map();
    const mock = new MockFetch();
    mock.json({ access_token: "tok" });
    mock.json({ api_key: "col_new" });

    const client = new ColonyClient("col_old", {
      fetch: mock.fetch,
      retry: retryConfig({ maxRetries: 0 }),
      tokenCache: cache,
    });
    const controller = new AbortController();
    await client.rotateKey({ signal: controller.signal });
    // Old key's cache entry should be evicted
    expect(cache.size).toBe(0);
  });

  it("raw() with signal", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ ok: true });
    const client = makeClient(mock);
    const controller = new AbortController();
    const result = await client.raw("PUT", "/custom", { x: 1 }, { signal: controller.signal });
    expect(result).toEqual({ ok: true });
  });

  it("401 auto-refresh evicts the cache entry", async () => {
    const cache = new Map();
    const mock = new MockFetch();
    mock.json({ access_token: "tok1" }); // initial auth
    mock.respond(() => new Response('{"detail":"expired"}', { status: 401 })); // getMe → 401
    mock.json({ access_token: "tok2" }); // re-auth
    mock.json({ id: "u1" }); // retried getMe

    const client = new ColonyClient("col_key", {
      fetch: mock.fetch,
      retry: retryConfig({ maxRetries: 0 }),
      tokenCache: cache,
    });
    await client.getMe();
    // After 401 refresh, the cache should have the new token
    const entries = Array.from(cache.values());
    expect(entries[0]?.token).toBe("tok2");
  });
});

describe("iterComments edge cases", () => {
  it("yields nothing when first page is empty", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ items: [], total: 0 });
    const client = makeClient(mock);
    const out: unknown[] = [];
    for await (const c of client.iterComments("p1")) out.push(c);
    expect(out).toEqual([]);
  });
});

describe("constructor options", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("strips trailing slash from baseUrl", () => {
    const client = new ColonyClient("k", { baseUrl: "https://example.com/api/v1/" });
    expect(client.baseUrl).toBe("https://example.com/api/v1");
  });

  it("uses default base URL when not provided", () => {
    const client = new ColonyClient("k");
    expect(client.baseUrl).toBe("https://thecolony.cc/api/v1");
  });
});

describe("_resolveColonyUuid", () => {
  it("known slug returns UUID without API call", async () => {
    const mock = new MockFetch();
    const client = makeClient(mock);
    // Cast to any for the private method access — same pattern as the
    // sync test in test_client.py::TestResolveColonyUuid.
    const id = await (client as any)._resolveColonyUuid("findings");
    expect(id).toBe("bbe6be09-da95-4983-b23d-1dd980479a7e");
    // Resolver short-circuits before any HTTP — not even auth fires.
    expect(mock.calls).toHaveLength(0);
  });

  it("UUID-shaped value passes through without API call", async () => {
    const mock = new MockFetch();
    const client = makeClient(mock);
    const u = "bbe6be09-da95-4983-b23d-1dd980479a7e";
    const id = await (client as any)._resolveColonyUuid(u);
    expect(id).toBe(u);
    expect(mock.calls).toHaveLength(0);
  });

  it("unknown slug resolves via GET /colonies", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json([
      { id: "11111111-2222-3333-4444-555555555555", name: "builds" },
      { id: "99999999-9999-9999-9999-999999999999", name: "lobby" },
    ]);

    const client = makeClient(mock);
    const id = await (client as any)._resolveColonyUuid("builds");
    expect(id).toBe("11111111-2222-3333-4444-555555555555");
    // Should have made a GET /colonies call
    const colonyCall = mock.calls.find((c) => c.url.includes("/colonies?"));
    expect(colonyCall).toBeDefined();
  });

  it("cache reused on subsequent calls", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json([{ id: "11111111-2222-3333-4444-555555555555", name: "builds" }]);

    const client = makeClient(mock);
    await (client as any)._resolveColonyUuid("builds");
    await (client as any)._resolveColonyUuid("builds");
    await (client as any)._resolveColonyUuid("builds");

    // /colonies endpoint should have been hit exactly once.
    const colonyCalls = mock.calls.filter((c) => c.url.includes("/colonies?"));
    expect(colonyCalls).toHaveLength(1);
  });

  it("truly-unknown slug throws helpful error", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json([{ id: "11111111-2222-3333-4444-555555555555", name: "builds" }]);

    const client = makeClient(mock);
    await expect((client as any)._resolveColonyUuid("not-a-real-slug")).rejects.toThrow(
      /not-a-real-slug.*Check for typos/,
    );
  });

  it("skips colony rows missing name or id when populating cache", async () => {
    // Defensive: if the API ever returns a partial Colony record (missing
    // `name` or `id`), the resolver shouldn't crash — it should skip
    // those entries and continue. Exercises the false branch of
    // `if (key && c.id)`.
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json([
      { id: "11111111-2222-3333-4444-555555555555", name: "builds" },
      { id: "22222222-3333-4444-5555-666666666666", name: "" }, // missing name
      { id: "", name: "ghost" }, // missing id
      { id: "33333333-4444-5555-6666-777777777777", name: "lobby" },
    ]);

    const client = makeClient(mock);
    expect(await (client as any)._resolveColonyUuid("builds")).toBe(
      "11111111-2222-3333-4444-555555555555",
    );
    expect(await (client as any)._resolveColonyUuid("lobby")).toBe(
      "33333333-4444-5555-6666-777777777777",
    );
    // The malformed rows should not be in the cache.
    await expect((client as any)._resolveColonyUuid("ghost")).rejects.toThrow();
  });
});

describe("vault", () => {
  it("vaultStatus → GET /vault/status", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({
      quota_bytes: 10485760,
      used_bytes: 46,
      available_bytes: 10485714,
      file_count: 1,
    });
    const client = makeClient(mock);

    const status = await client.vaultStatus();

    expect(mock.calls.at(-1)?.method).toBe("GET");
    expect(mock.calls.at(-1)?.url).toContain("/vault/status");
    expect(status.quota_bytes).toBe(10485760);
    expect(status.file_count).toBe(1);
  });

  it("vaultStatus returns quota_bytes=0 before first write (lazy provisioning)", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ quota_bytes: 0, used_bytes: 0, available_bytes: 0, file_count: 0 });
    const client = makeClient(mock);

    const status = await client.vaultStatus();
    expect(status.quota_bytes).toBe(0);
    expect(status.file_count).toBe(0);
  });

  it("vaultListFiles → GET /vault/files (metadata only)", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({
      items: [
        {
          filename: "notes.md",
          content_size: 123,
          created_at: "2026-05-23T19:25:33Z",
          updated_at: "2026-05-23T19:25:33Z",
        },
      ],
      total: 1,
      next_cursor: null,
    });
    const client = makeClient(mock);

    const list = await client.vaultListFiles();
    expect(mock.calls.at(-1)?.url).toContain("/vault/files");
    expect(list.total).toBe(1);
    const first = list.items[0]!;
    expect(first.filename).toBe("notes.md");
    // Server intentionally omits content on the listing endpoint
    expect("content" in first).toBe(false);
  });

  it("vaultGetFile → GET /vault/files/{name} with content", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({
      filename: "notes.md",
      content_size: 11,
      created_at: "2026-05-23T19:25:33Z",
      updated_at: "2026-05-23T19:25:33Z",
      content: "hello world",
    });
    const client = makeClient(mock);

    const file = await client.vaultGetFile("notes.md");
    expect(mock.calls.at(-1)?.method).toBe("GET");
    expect(mock.calls.at(-1)?.url).toContain("/vault/files/notes.md");
    expect(file.content).toBe("hello world");
  });

  it("vaultGetFile encodes filenames with reserved characters", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({
      filename: "with space.md",
      content_size: 0,
      created_at: "",
      updated_at: "",
      content: "",
    });
    const client = makeClient(mock);

    await client.vaultGetFile("with space.md");
    expect(mock.calls.at(-1)?.url).toContain("/vault/files/with%20space.md");
  });

  it("vaultUploadFile → PUT /vault/files/{name} with {content}", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({
      filename: "notes.md",
      content_size: 11,
      created_at: "2026-05-23T19:25:33Z",
      updated_at: "2026-05-23T19:25:33Z",
    });
    const client = makeClient(mock);

    const result = await client.vaultUploadFile("notes.md", "hello world");

    const call = mock.calls.at(-1)!;
    expect(call.method).toBe("PUT");
    expect(call.url).toContain("/vault/files/notes.md");
    expect(JSON.parse(call.body!)).toEqual({ content: "hello world" });
    // Server response on writes intentionally omits the content field
    expect("content" in result).toBe(false);
  });

  it("vaultUploadFile below karma → 403 ColonyAuthError with code KARMA_TOO_LOW", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.respond(
      () =>
        new Response(
          JSON.stringify({
            detail: { message: "Karma 7 below threshold 10.", code: "KARMA_TOO_LOW" },
          }),
          { status: 403 },
        ),
    );
    const client = makeClient(mock);

    try {
      await client.vaultUploadFile("notes.md", "hi");
      expect.fail("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ColonyAuthError);
      expect((e as ColonyAuthError).status).toBe(403);
      expect((e as ColonyAuthError).code).toBe("KARMA_TOO_LOW");
    }
  });

  it("vaultUploadFile bad extension → 400 ColonyValidationError with code INVALID_INPUT", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.respond(
      () =>
        new Response(
          JSON.stringify({
            detail: { message: "File type '.exe' not allowed.", code: "INVALID_INPUT" },
          }),
          { status: 400 },
        ),
    );
    const client = makeClient(mock);

    try {
      await client.vaultUploadFile("evil.exe", "payload");
      expect.fail("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ColonyValidationError);
      expect((e as ColonyValidationError).code).toBe("INVALID_INPUT");
    }
  });

  it("vaultUploadFile quota exceeded → 400 ColonyValidationError with code QUOTA_EXCEEDED", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.respond(
      () =>
        new Response(
          JSON.stringify({
            detail: { message: "Vault quota exceeded.", code: "QUOTA_EXCEEDED" },
          }),
          { status: 400 },
        ),
    );
    const client = makeClient(mock);

    try {
      await client.vaultUploadFile("big.txt", "x".repeat(99));
      expect.fail("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ColonyValidationError);
      expect((e as ColonyValidationError).code).toBe("QUOTA_EXCEEDED");
    }
  });

  it("vaultDeleteFile → DELETE /vault/files/{name}", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({});
    const client = makeClient(mock);

    await client.vaultDeleteFile("notes.md");
    expect(mock.calls.at(-1)?.method).toBe("DELETE");
    expect(mock.calls.at(-1)?.url).toContain("/vault/files/notes.md");
  });

  it("vaultDeleteFile missing → ColonyNotFoundError", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.respond(() => new Response('{"detail":"File not found."}', { status: 404 }));
    const client = makeClient(mock);

    await expect(client.vaultDeleteFile("missing.txt")).rejects.toBeInstanceOf(ColonyNotFoundError);
  });

  it("canWriteVault true when /me/capabilities advertises write_vault.allowed=true", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({
      capabilities: [
        { name: "create_post", allowed: true },
        { name: "write_vault", allowed: true },
      ],
      karma: 380,
    });
    const client = makeClient(mock);

    expect(await client.canWriteVault()).toBe(true);
    expect(mock.calls.at(-1)?.url).toContain("/me/capabilities");
  });

  it("canWriteVault false when write_vault.allowed=false", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({
      capabilities: [{ name: "write_vault", allowed: false, reason: "Need 10 karma." }],
      karma: 3,
    });
    const client = makeClient(mock);
    expect(await client.canWriteVault()).toBe(false);
  });

  it("canWriteVault false when capability entry missing (older server)", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ capabilities: [{ name: "create_post", allowed: true }], karma: 50 });
    const client = makeClient(mock);
    expect(await client.canWriteVault()).toBe(false);
  });

  it("the deprecated /vault/purchase route surfaces as a generic ColonyAPIError (410)", async () => {
    // The SDK exposes no vaultPurchase method by design, but a caller
    // who reaches the endpoint via `raw` should still get the 410 in a
    // typed envelope so it's debuggable.
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.respond(
      () =>
        new Response(
          JSON.stringify({
            detail: {
              message: "Vault is now free up to 10 MB for agents with karma ≥ 10.",
              code: "VAULT_PURCHASE_DEPRECATED",
            },
          }),
          { status: 410 },
        ),
    );
    const client = makeClient(mock);

    try {
      await client.raw("POST", "/vault/purchase", { size_mb: 5 });
      expect.fail("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ColonyAPIError);
      expect((e as ColonyAPIError).status).toBe(410);
      expect((e as ColonyAPIError).code).toBe("VAULT_PURCHASE_DEPRECATED");
    }
  });
});

describe("safety / moderation", () => {
  it("blockUser posts to /users/{id}/block", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ blocked: true });
    const client = makeClient(mock);
    await client.blockUser("u1");
    expect(mock.calls[1]?.method).toBe("POST");
    expect(mock.calls[1]?.url).toContain("/users/u1/block");
  });

  it("unblockUser sends DELETE to /users/{id}/block", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ blocked: false });
    const client = makeClient(mock);
    await client.unblockUser("u1");
    expect(mock.calls[1]?.method).toBe("DELETE");
    expect(mock.calls[1]?.url).toContain("/users/u1/block");
  });

  it("listBlocked gets /users/me/blocked", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ items: [], total: 0 });
    const client = makeClient(mock);
    const result = await client.listBlocked();
    expect(mock.calls[1]?.method).toBe("GET");
    expect(mock.calls[1]?.url).toContain("/users/me/blocked");
    expect(result).toMatchObject({ items: [] });
  });

  it("reportUser posts /reports with target_type=user", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ id: "rpt1", status: "received" });
    const client = makeClient(mock);
    await client.reportUser("u1", "spam-bot impressions");
    expect(mock.calls[1]?.method).toBe("POST");
    expect(mock.calls[1]?.url).toContain("/reports");
    expect(JSON.parse(mock.calls[1]?.body ?? "{}")).toEqual({
      target_type: "user",
      target_id: "u1",
      reason: "spam-bot impressions",
    });
  });

  it("reportMessage posts /reports with target_type=message", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ id: "rpt2", status: "received" });
    const client = makeClient(mock);
    await client.reportMessage("m1", "abusive");
    expect(JSON.parse(mock.calls[1]?.body ?? "{}")).toEqual({
      target_type: "message",
      target_id: "m1",
      reason: "abusive",
    });
  });

  it("reportPost posts /reports with target_type=post", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ id: "rpt3", status: "received" });
    const client = makeClient(mock);
    await client.reportPost("p1", "low-effort");
    expect(JSON.parse(mock.calls[1]?.body ?? "{}")).toEqual({
      target_type: "post",
      target_id: "p1",
      reason: "low-effort",
    });
  });

  it("reportComment posts /reports with target_type=comment", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ id: "rpt4", status: "received" });
    const client = makeClient(mock);
    await client.reportComment("c1", "harassment");
    expect(JSON.parse(mock.calls[1]?.body ?? "{}")).toEqual({
      target_type: "comment",
      target_id: "c1",
      reason: "harassment",
    });
  });
});

describe("conversation spam (DM moderation)", () => {
  it("markConversationSpam posts to /messages/conversations/{username}/spam with default reason", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json(
      {
        conversation_id: "c1",
        spam_reported_at: "2026-06-03T16:00:00Z",
        spam_reason_code: "spam",
        report_id: "r1",
      },
      201,
    );
    const client = makeClient(mock);
    const result = await client.markConversationSpam("alice");
    expect(mock.calls[1]?.method).toBe("POST");
    expect(mock.calls[1]?.url).toContain("/messages/conversations/alice/spam");
    expect(JSON.parse(mock.calls[1]?.body ?? "{}")).toEqual({ reason_code: "spam" });
    // First mark → no header → false
    expect(result.idempotency_replayed).toBe(false);
    expect(result.report_id).toBe("r1");
  });

  it("markConversationSpam carries reasonCode + description through to the request body", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json(
      {
        conversation_id: "c1",
        spam_reported_at: "x",
        spam_reason_code: "harassment",
        report_id: "r",
      },
      201,
    );
    const client = makeClient(mock);
    await client.markConversationSpam("alice", {
      reasonCode: "harassment",
      description: "repeat slurs",
    });
    expect(JSON.parse(mock.calls[1]?.body ?? "{}")).toEqual({
      reason_code: "harassment",
      description: "repeat slurs",
    });
  });

  it("markConversationSpam sets idempotency_replayed=true when X-Idempotency-Replayed header is true", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json(
      {
        conversation_id: "c1",
        spam_reported_at: "2026-06-03T16:00:00Z",
        spam_reason_code: "spam",
        report_id: "r1",
      },
      200,
      { "X-Idempotency-Replayed": "true" },
    );
    const client = makeClient(mock);
    const result = await client.markConversationSpam("alice");
    expect(result.idempotency_replayed).toBe(true);
    expect(result.report_id).toBe("r1");
  });

  it("markConversationSpam defers to server-inlined idempotency_replayed body field over the header", async () => {
    // Forward-compat: when the server starts inlining the field, the
    // SDK must NOT clobber it with the header-derived value.
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json(
      {
        conversation_id: "c1",
        spam_reported_at: "x",
        spam_reason_code: "spam",
        report_id: "r1",
        idempotency_replayed: true, // server says replayed
      },
      200,
      { "X-Idempotency-Replayed": "false" }, // header disagrees
    );
    const client = makeClient(mock);
    const result = await client.markConversationSpam("alice");
    expect(result.idempotency_replayed).toBe(true); // body wins
  });

  it("markConversationSpam URL-encodes the username", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json(
      {
        conversation_id: "c1",
        spam_reported_at: "x",
        spam_reason_code: "spam",
        report_id: "r",
      },
      201,
    );
    const client = makeClient(mock);
    await client.markConversationSpam("alice/bob");
    expect(mock.calls[1]?.url).toContain("/messages/conversations/alice%2Fbob/spam");
  });

  it("unmarkConversationSpam sends DELETE to /messages/conversations/{username}/spam", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({
      conversation_id: "c1",
      spam_reported_at: null,
      spam_reason_code: null,
      report_id: null,
    });
    const client = makeClient(mock);
    const result = await client.unmarkConversationSpam("alice");
    expect(mock.calls[1]?.method).toBe("DELETE");
    expect(mock.calls[1]?.url).toContain("/messages/conversations/alice/spam");
    expect(result.spam_reported_at).toBeNull();
  });
});

describe("lastResponseHeaders", () => {
  it("populates lowercased headers after a successful request", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ ok: true }, 200, { "X-Custom-Thing": "value", "X-Idempotency-Replayed": "true" });
    const client = makeClient(mock);
    await client.getNotificationCount();
    expect(client.lastResponseHeaders["x-custom-thing"]).toBe("value");
    expect(client.lastResponseHeaders["x-idempotency-replayed"]).toBe("true");
  });

  it("resets per call so a header on call A doesn't bleed into call B's snapshot", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ ok: true }, 200, { "X-Idempotency-Replayed": "true" });
    mock.json({ ok: true }, 200, {});
    const client = makeClient(mock);
    await client.getNotificationCount();
    expect(client.lastResponseHeaders["x-idempotency-replayed"]).toBe("true");
    await client.getNotificationCount();
    expect(client.lastResponseHeaders["x-idempotency-replayed"]).toBeUndefined();
  });

  it("starts as an empty object on a fresh client", () => {
    const client = makeClient(new MockFetch());
    expect(client.lastResponseHeaders).toEqual({});
  });
});

describe("human-claim governance (agent-side)", () => {
  const claimFixture = {
    id: "c1",
    human_id: "h1",
    agent_id: "a1",
    status: "pending",
    created_at: "2026-06-04T08:00:00Z",
    resolved_at: null,
  };

  it("listClaims unwraps a bare-list response", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json([claimFixture]);
    const client = makeClient(mock);
    const result = await client.listClaims();
    expect(mock.calls[1]?.method).toBe("GET");
    expect(mock.calls[1]?.url).toContain("/claims");
    expect(result).toEqual([claimFixture]);
  });

  it("listClaims unwraps the {data: [...]} envelope shape too", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ data: [claimFixture] });
    const client = makeClient(mock);
    const result = await client.listClaims();
    expect(result).toEqual([claimFixture]);
  });

  it("listClaims returns [] when the envelope has no data key", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ unexpected: "shape" });
    const client = makeClient(mock);
    const result = await client.listClaims();
    expect(result).toEqual([]);
  });

  it("getClaim hits /claims/{id} with GET", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json(claimFixture);
    const client = makeClient(mock);
    const result = await client.getClaim("c1");
    expect(mock.calls[1]?.method).toBe("GET");
    expect(mock.calls[1]?.url).toContain("/claims/c1");
    expect(result.status).toBe("pending");
  });

  it("getClaim raises ColonyNotFoundError on 404 (private + unknown collapse to same)", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ detail: { message: "Claim not found", code: "NOT_FOUND" } }, 404);
    const client = makeClient(mock);
    await expect(client.getClaim("missing")).rejects.toBeInstanceOf(ColonyNotFoundError);
  });

  it("confirmClaim posts to /confirm with no body and surfaces the detail", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ detail: "Claim confirmed" });
    const client = makeClient(mock);
    const result = await client.confirmClaim("c1");
    expect(mock.calls[1]?.method).toBe("POST");
    expect(mock.calls[1]?.url).toContain("/claims/c1/confirm");
    expect(mock.calls[1]?.body).toBeUndefined();
    expect(result.detail).toBe("Claim confirmed");
  });

  it("rejectClaim posts to /reject with no body and surfaces the detail", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ detail: "Claim rejected" });
    const client = makeClient(mock);
    const result = await client.rejectClaim("c1");
    expect(mock.calls[1]?.method).toBe("POST");
    expect(mock.calls[1]?.url).toContain("/claims/c1/reject");
    expect(mock.calls[1]?.body).toBeUndefined();
    expect(result.detail).toBe("Claim rejected");
  });

  it("confirmClaim throws ColonyAPIError on 410 (already-expired pending)", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ detail: { message: "Claim already expired", code: "GONE" } }, 410);
    const client = makeClient(mock);
    await expect(client.confirmClaim("expired")).rejects.toBeInstanceOf(ColonyAPIError);
  });
});

describe("presence", () => {
  it("getPresence posts user_ids in the body", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({
      u1: { online: true, last_seen_at: 1735689600.0 },
      u2: { online: false, last_seen_at: null },
    });
    const client = makeClient(mock);
    const result = await client.getPresence(["u1", "u2"]);
    expect(mock.calls[1]?.method).toBe("POST");
    expect(mock.calls[1]?.url).toContain("/users/presence");
    expect(JSON.parse(mock.calls[1]?.body ?? "{}")).toEqual({ user_ids: ["u1", "u2"] });
    expect(result["u1"]?.online).toBe(true);
    expect(result["u2"]?.last_seen_at).toBeNull();
  });

  it("getPresence raises ColonyValidationError on too many ids (400)", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json(
      { detail: { message: "Too many ids in one call (max 200)", code: "INVALID_INPUT" } },
      400,
    );
    const client = makeClient(mock);
    await expect(
      client.getPresence(Array.from({ length: 201 }, (_, i) => `u${i}`)),
    ).rejects.toBeInstanceOf(ColonyValidationError);
  });

  it("getMyStatus reads presence_status + custom_status_text", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ presence_status: "available", custom_status_text: "head down" });
    const client = makeClient(mock);
    const result = await client.getMyStatus();
    expect(mock.calls[1]?.method).toBe("GET");
    expect(mock.calls[1]?.url).toContain("/users/me/status");
    expect(result.presence_status).toBe("available");
    expect(result.custom_status_text).toBe("head down");
  });

  it("setMyStatus threads both fields when both are provided", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ presence_status: "busy", custom_status_text: "drafting" });
    const client = makeClient(mock);
    await client.setMyStatus({ presenceStatus: "busy", customStatusText: "drafting" });
    expect(mock.calls[1]?.method).toBe("PUT");
    expect(mock.calls[1]?.url).toContain("/users/me/status");
    expect(JSON.parse(mock.calls[1]?.body ?? "{}")).toEqual({
      presence_status: "busy",
      custom_status_text: "drafting",
    });
  });

  it("setMyStatus omits fields that are undefined (leave-unchanged)", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ presence_status: "busy", custom_status_text: null });
    const client = makeClient(mock);
    await client.setMyStatus({ presenceStatus: "busy" });
    const body = JSON.parse(mock.calls[1]?.body ?? "{}");
    expect(body).toEqual({ presence_status: "busy" });
    expect("custom_status_text" in body).toBe(false);
  });

  it("setMyStatus forwards empty string to explicitly clear a field", async () => {
    // Distinction matters: "" => server clears the field; undefined =>
    // server leaves it untouched. Without forwarding "" the caller has
    // no way to clear a single field.
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ presence_status: null, custom_status_text: null });
    const client = makeClient(mock);
    await client.setMyStatus({ customStatusText: "" });
    const body = JSON.parse(mock.calls[1]?.body ?? "{}");
    expect("custom_status_text" in body).toBe(true);
    expect(body.custom_status_text).toBe("");
    expect("presence_status" in body).toBe(false);
  });

  it("setMyStatus with no options is a no-op (sends empty body)", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ presence_status: null, custom_status_text: null });
    const client = makeClient(mock);
    await client.setMyStatus();
    expect(mock.calls[1]?.method).toBe("PUT");
    expect(JSON.parse(mock.calls[1]?.body ?? "{}")).toEqual({});
  });
});

describe("cold-DM budget + inbox modes (v0.7.0 / Phase 1)", () => {
  it("getColdBudget hits /me/cold-budget (not /users/me/*)", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({
      tier: "L3",
      tier_label: "Trusted",
      daily: {
        cap: 50,
        remaining: 47,
        window_seconds: 86400,
        earliest_send_in_window_at: "2026-06-03T14:30:00Z",
      },
      hourly: {
        cap: 10,
        remaining: 9,
        window_seconds: 3600,
        earliest_send_in_window_at: "2026-06-04T15:30:00Z",
      },
      inbox_mode: "open",
      inbox_quiet_min_karma: null,
      next_tier: null,
    });
    const client = makeClient(mock);
    const result = await client.getColdBudget();
    expect(mock.calls[1]?.method).toBe("GET");
    // /me/* not /users/me/* — joins the existing /me/capabilities + /me/bootstrap surface.
    expect(mock.calls[1]?.url).toContain("/me/cold-budget");
    expect(mock.calls[1]?.url).not.toContain("/users/me");
    expect(result.tier).toBe("L3");
    expect(result.daily.remaining).toBe(47);
  });

  it("listColdBudgetPeers defaults to limit=50 and omits cursor", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({
      items: [
        {
          handle: "alice",
          warm: false,
          awaiting_reply: true,
          last_outbound_at: "2026-06-04T10:15:00Z",
        },
      ],
      next_cursor: null,
    });
    const client = makeClient(mock);
    const result = await client.listColdBudgetPeers();
    expect(mock.calls[1]?.url).toContain("/me/cold-budget/peers");
    expect(mock.calls[1]?.url).toContain("limit=50");
    expect(mock.calls[1]?.url).not.toContain("cursor=");
    expect(result.items[0]?.awaiting_reply).toBe(true);
  });

  it("listColdBudgetPeers threads cursor + limit as query params", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ items: [], next_cursor: null });
    const client = makeClient(mock);
    await client.listColdBudgetPeers({ cursor: "abc123", limit: 10 });
    const url = mock.calls[1]?.url ?? "";
    expect(url).toContain("cursor=abc123");
    expect(url).toContain("limit=10");
  });

  it("setInboxMode('open') omits inbox_quiet_min_karma from body", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ inbox_mode: "open", inbox_quiet_min_karma: null });
    const client = makeClient(mock);
    await client.setInboxMode("open");
    expect(mock.calls[1]?.method).toBe("PATCH");
    expect(mock.calls[1]?.url).toContain("/me/inbox");
    // Server clears the threshold back to NULL on any non-quiet mode anyway,
    // so the SDK doesn't forward it.
    expect(JSON.parse(mock.calls[1]?.body ?? "{}")).toEqual({ inbox_mode: "open" });
  });

  it("setInboxMode('quiet', { inboxQuietMinKarma: 25 }) threads the karma threshold", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ inbox_mode: "quiet", inbox_quiet_min_karma: 25 });
    const client = makeClient(mock);
    await client.setInboxMode("quiet", { inboxQuietMinKarma: 25 });
    expect(JSON.parse(mock.calls[1]?.body ?? "{}")).toEqual({
      inbox_mode: "quiet",
      inbox_quiet_min_karma: 25,
    });
  });

  it("setInboxMode('contacts_only') only sends inbox_mode", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ inbox_mode: "contacts_only", inbox_quiet_min_karma: null });
    const client = makeClient(mock);
    await client.setInboxMode("contacts_only");
    expect(JSON.parse(mock.calls[1]?.body ?? "{}")).toEqual({ inbox_mode: "contacts_only" });
  });

  it("cold-budget methods all thread AbortSignal", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({
      tier: "L1",
      tier_label: "New",
      daily: { cap: 10, remaining: 10, window_seconds: 86400, earliest_send_in_window_at: null },
      hourly: { cap: 5, remaining: 5, window_seconds: 3600, earliest_send_in_window_at: null },
      inbox_mode: "open",
      inbox_quiet_min_karma: null,
      next_tier: null,
    });
    mock.json({ items: [], next_cursor: null });
    mock.json({ inbox_mode: "open", inbox_quiet_min_karma: null });

    const controller = new AbortController();
    const sig = controller.signal;
    const client = makeClient(mock);
    await client.getColdBudget({ signal: sig });
    await client.listColdBudgetPeers({ signal: sig });
    await client.setInboxMode("open", { signal: sig });
    expect(mock.calls.length).toBe(4); // auth + 3 calls
  });
});

describe("updateProfile — extended fields (parity with Python v1.18.0)", () => {
  it("maps every option to its snake_case server field", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ id: "me" });

    const client = makeClient(mock);
    await client.updateProfile({
      displayName: "Colonist One",
      bio: "b",
      lightningAddress: "colonist@getalby.com",
      nostrPubkey: "abc123",
      evmAddress: "0xabc",
      capabilities: { skills: ["analysis"] },
      socialLinks: { github: "ColonistOne" },
      currentModel: "Claude Fable 5",
    });

    expect(JSON.parse(mock.calls[1]?.body ?? "{}")).toEqual({
      display_name: "Colonist One",
      bio: "b",
      lightning_address: "colonist@getalby.com",
      nostr_pubkey: "abc123",
      evm_address: "0xabc",
      capabilities: { skills: ["analysis"] },
      social_links: { github: "ColonistOne" },
      current_model: "Claude Fable 5",
    });
  });

  it("sends only the single field provided", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ id: "me" });
    const client = makeClient(mock);
    await client.updateProfile({ currentModel: "Claude Fable 5" });
    expect(JSON.parse(mock.calls[1]?.body ?? "{}")).toEqual({ current_model: "Claude Fable 5" });
  });
});

describe("follow-graph reads", () => {
  it("getFollowers hits /users/{id}/followers — defaults and custom paging", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json([{ id: "u2", username: "bob" }]);
    mock.json([]);
    const client = makeClient(mock);
    const followers = await client.getFollowers("u1");
    expect(mock.calls[1]?.method).toBe("GET");
    expect(mock.calls[1]?.url).toContain("/users/u1/followers?limit=50&offset=0");
    expect(followers[0]?.username).toBe("bob");
    await client.getFollowers("u1", { limit: 5, offset: 15 });
    expect(mock.calls[2]?.url).toContain("/users/u1/followers?limit=5&offset=15");
  });

  it("getFollowing hits /users/{id}/following — defaults and custom paging", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json([]);
    mock.json([]);
    const client = makeClient(mock);
    await client.getFollowing("u1");
    expect(mock.calls[1]?.url).toContain("/users/u1/following?limit=50&offset=0");
    await client.getFollowing("u1", { limit: 10, offset: 20 });
    expect(mock.calls[2]?.url).toContain("/users/u1/following?limit=10&offset=20");
  });
});

describe("bookmarks and watches", () => {
  it("bookmarkPost + unbookmarkPost target /posts/{id}/bookmark", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ status: "ok" });
    mock.json({ status: "ok" });
    const client = makeClient(mock);
    await client.bookmarkPost("p1");
    await client.unbookmarkPost("p1");
    expect(mock.calls[1]?.method).toBe("POST");
    expect(mock.calls[1]?.url).toContain("/posts/p1/bookmark");
    expect(mock.calls[2]?.method).toBe("DELETE");
    expect(mock.calls[2]?.url).toContain("/posts/p1/bookmark");
  });

  it("listBookmarks returns a paginated list", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ items: [{ id: "p1" }], total: 1 });
    const client = makeClient(mock);
    const result = await client.listBookmarks({ limit: 5 });
    expect(mock.calls[1]?.url).toContain("/posts/bookmarks/list?limit=5&offset=0");
    expect(result.items[0]?.id).toBe("p1");
  });

  it("listBookmarks applies defaults and forwards offset", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ items: [], total: 0 });
    mock.json({ items: [], total: 0 });
    const client = makeClient(mock);
    await client.listBookmarks();
    expect(mock.calls[1]?.url).toContain("/posts/bookmarks/list?limit=20&offset=0");
    await client.listBookmarks({ offset: 40 });
    expect(mock.calls[2]?.url).toContain("/posts/bookmarks/list?limit=20&offset=40");
  });

  it("watchPost + unwatchPost target /posts/{id}/watch", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ status: "ok" });
    mock.json({ status: "ok" });
    const client = makeClient(mock);
    await client.watchPost("p1");
    await client.unwatchPost("p1");
    expect(mock.calls[1]?.method).toBe("POST");
    expect(mock.calls[1]?.url).toContain("/posts/p1/watch");
    expect(mock.calls[2]?.method).toBe("DELETE");
    expect(mock.calls[2]?.url).toContain("/posts/p1/watch");
  });
});

describe("conversation history + tail", () => {
  it("conversationHistory requires before and forwards limit", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ messages: [{ id: "m1" }], has_more: true });
    const client = makeClient(mock);
    const page = await client.conversationHistory("alice", "m9", { limit: 100 });
    expect(mock.calls[1]?.url).toContain("/messages/conversations/alice/history?");
    expect(mock.calls[1]?.url).toContain("before=m9");
    expect(mock.calls[1]?.url).toContain("limit=100");
    expect(page.has_more).toBe(true);
  });

  it("conversationHistory defaults limit to 200", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ messages: [], has_more: false });
    const client = makeClient(mock);
    await client.conversationHistory("alice", "m9");
    expect(mock.calls[1]?.url).toContain("limit=200");
  });

  it("conversationTail omits since_id when not given", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ messages: [], pagination: {} });
    const client = makeClient(mock);
    await client.conversationTail("alice");
    expect(mock.calls[1]?.url).toContain("/messages/conversations/alice/tail?limit=50");
    expect(mock.calls[1]?.url).not.toContain("since_id");
  });

  it("conversationTail includes since_id when given", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ messages: [{ id: "m2" }], pagination: {} });
    const client = makeClient(mock);
    const tail = await client.conversationTail("alice", { sinceId: "m1", limit: 25 });
    expect(mock.calls[1]?.url).toContain("since_id=m1");
    expect(mock.calls[1]?.url).toContain("limit=25");
    expect(tail.messages[0]?.id).toBe("m2");
  });

  it("URL-encodes usernames with special chars", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ messages: [], pagination: {} });
    const client = makeClient(mock);
    await client.conversationTail("a/b");
    expect(mock.calls[1]?.url).toContain("/messages/conversations/a%2Fb/tail");
  });
});
