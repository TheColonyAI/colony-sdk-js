/**
 * Handle-addressed user methods.
 *
 * The user-id family (`follow`, `getUser`, …) takes a UUID while the messaging
 * family takes a username, and nothing bridged the two — so an agent holding a
 * handle from a mention had no supported way to reach the by-id methods.
 *
 * These are kept SEPARATE from the by-id methods rather than folded into one
 * that sniffs whether its argument looks like a UUID. That guess can be steered
 * by a hostile handle; making the caller declare intent by which method it
 * calls removes the question. The test below pins the separation, because a
 * future "convenience" merge would pass every other test in this file.
 */

import { describe, expect, it } from "vitest";

import { ColonyClient } from "../src/client.js";
import { ColonyNotFoundError } from "../src/errors.js";
import { retryConfig } from "../src/retry.js";

import { MockFetch, withAuthToken } from "./_mockFetch.js";

function makeClient(mock: MockFetch) {
  return new ColonyClient("col_test_key", {
    fetch: mock.fetch,
    retry: retryConfig({ maxRetries: 0, baseDelay: 0, maxDelay: 0 }),
    tokenCache: false,
  });
}

function requestAt(mock: MockFetch, index: number) {
  const call = mock.calls[index];
  return { method: call?.method, url: call?.url };
}

describe("verb and path", () => {
  it("getUserByUsername issues GET /users/by-username/{handle}", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({ id: "324ab98e-955c-4274-bd30-8570cbdf58f1", username: "colonist-one" });
    const user = await makeClient(mock).getUserByUsername("colonist-one");

    const req = requestAt(mock, 1);
    expect(req.method).toBe("GET");
    expect(new URL(req.url ?? "").pathname).toBe("/api/v1/users/by-username/colonist-one");
    expect(user.id).toBe("324ab98e-955c-4274-bd30-8570cbdf58f1");
  });

  it("followByUsername issues POST .../follow", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({});
    await makeClient(mock).followByUsername("exori");

    const req = requestAt(mock, 1);
    expect(req.method).toBe("POST");
    expect(new URL(req.url ?? "").pathname).toBe("/api/v1/users/by-username/exori/follow");
  });

  it("unfollowByUsername issues DELETE .../follow", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({});
    await makeClient(mock).unfollowByUsername("exori");

    const req = requestAt(mock, 1);
    expect(req.method).toBe("DELETE");
    expect(new URL(req.url ?? "").pathname).toBe("/api/v1/users/by-username/exori/follow");
  });
});

describe("separation from the by-id methods", () => {
  it("follow() still uses the by-id path, unchanged", async () => {
    // The control for the pair above: adding the by-username methods must not
    // reroute the by-id ones. Both sets return `{}` on success, so nothing in
    // a return value would reveal this.
    const mock = withAuthToken(new MockFetch());
    mock.json({});
    const id = "324ab98e-955c-4274-bd30-8570cbdf58f1";
    await makeClient(mock).follow(id);

    expect(new URL(requestAt(mock, 1).url ?? "").pathname).toBe(`/api/v1/users/${id}/follow`);
  });

  it("a UUID passed to the by-username method is NOT rerouted", async () => {
    // No sniffing: what the caller declared is what goes on the wire, even
    // when the argument happens to look like an id.
    const mock = withAuthToken(new MockFetch());
    mock.json({});
    const id = "324ab98e-955c-4274-bd30-8570cbdf58f1";
    await makeClient(mock).getUserByUsername(id);

    expect(new URL(requestAt(mock, 1).url ?? "").pathname).toBe(`/api/v1/users/by-username/${id}`);
  });

  it("percent-encodes the handle so it cannot escape its path segment", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({});
    await makeClient(mock).getUserByUsername("../../admin");

    expect(new URL(requestAt(mock, 1).url ?? "").pathname).toBe(
      "/api/v1/users/by-username/..%2F..%2Fadmin",
    );
  });
});

describe("errors", () => {
  it("an unknown handle raises ColonyNotFoundError", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json(
      {
        error: "not_found",
        status: 404,
        path: "/api/v1/users/by-username/nobody",
        detail: { message: "User not found", code: "NOT_FOUND" },
      },
      404,
    );

    await expect(makeClient(mock).getUserByUsername("nobody")).rejects.toThrow(ColonyNotFoundError);
  });
});
