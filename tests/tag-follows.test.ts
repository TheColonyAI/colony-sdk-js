/**
 * Tag follows.
 *
 * The shapes asserted here were read off the LIVE API on 2026-07-28 by running
 * the whole loop against the dedicated integration-test account — follow, list,
 * re-follow, unfollow, unfollow-again, and a mixed-case follow — rather than
 * copied from the Python SDK, which types all three of these as bare dicts.
 *
 * Two things that measurement turned up are pinned below because nothing in
 * either SDK's documentation says them:
 *
 * - `followTag` returns `{ tag, following }` but `getFollowedTags` returns
 *   rows keyed `tag_name`. The two endpoints genuinely disagree on the key for
 *   the same value, and the SDK deliberately does not paper over it.
 * - follow is idempotent (200 + `message: "Already following"`), unfollow is
 *   not (404 on a tag you do not follow). The asymmetry is real.
 *
 * Everything goes through the mock fetch, so what is asserted is what actually
 * goes on the wire.
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

/** The request the SDK made, after the auth-token exchange at index 0. */
function requestAt(mock: MockFetch, index: number) {
  const call = mock.calls[index];
  return {
    method: call?.method,
    url: call?.url,
    body: call?.body ? (JSON.parse(call.body) as Record<string, unknown>) : undefined,
  };
}

describe("verb and path", () => {
  it("followTag issues POST /tags/{tag}/follow with no body", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({ tag: "rust", following: true });
    const result = await makeClient(mock).followTag("rust");

    const req = requestAt(mock, 1);
    expect(req.method).toBe("POST");
    expect(req.url).toContain("/tags/rust/follow");
    expect(req.body).toBeUndefined();
    expect(result.following).toBe(true);
  });

  it("getFollowedTags issues GET /tags/following", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json([{ tag_name: "rust", created_at: "2026-07-28T11:34:31.617506+00:00" }]);
    const result = await makeClient(mock).getFollowedTags();

    const req = requestAt(mock, 1);
    expect(req.method).toBe("GET");
    expect(req.url).toContain("/tags/following");
    expect(result[0]?.tag_name).toBe("rust");
  });

  it("unfollowTag issues DELETE /tags/{tag}/follow", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({ tag: "rust", following: false });
    const result = await makeClient(mock).unfollowTag("rust");

    const req = requestAt(mock, 1);
    expect(req.method).toBe("DELETE");
    expect(req.url).toContain("/tags/rust/follow");
    expect(result.following).toBe(false);
  });

  it("percent-encodes a tag so it cannot escape its path segment", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({ tag: "c++", following: true });
    await makeClient(mock).followTag("c++/../../admin");

    // The slashes and the plus must be encoded, or the tag would be able to
    // redirect the request to a different endpoint entirely.
    const url = requestAt(mock, 1).url ?? "";
    expect(url).toContain("/tags/c%2B%2B%2F..%2F..%2Fadmin/follow");
    expect(url).not.toContain("/admin/follow");
  });
});

describe("measured server behaviour", () => {
  it("the follow response and the list rows use DIFFERENT keys", async () => {
    // Measured 2026-07-28: this is the trap the types exist to make visible.
    // Anyone who assumed one shape and reused it would read `undefined`.
    const mock = withAuthToken(new MockFetch());
    mock.json({ tag: "rust", following: true });
    mock.json([{ tag_name: "rust", created_at: "2026-07-28T11:34:31.617506+00:00" }]);

    const client = makeClient(mock);
    const followed = await client.followTag("rust");
    const listed = await client.getFollowedTags();

    expect(followed.tag).toBe("rust");
    expect(listed[0]?.tag_name).toBe("rust");
    // The negative half is the point: neither shape carries the other's key.
    expect("tag_name" in followed).toBe(false);
    expect(listed[0] && "tag" in listed[0]).toBe(false);
  });

  it("a repeat follow is a 200 no-op carrying `message`, not a conflict", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({ tag: "rust", following: true, message: "Already following" });
    const result = await makeClient(mock).followTag("rust");

    expect(result.following).toBe(true);
    expect(result.message).toBe("Already following");
  });

  it("unfollowing a tag you do not follow raises ColonyNotFoundError", async () => {
    // The asymmetry with follow is measured, not assumed: follow is
    // idempotent, unfollow is not.
    const mock = withAuthToken(new MockFetch());
    mock.json(
      {
        error: "not_found",
        status: 404,
        path: "/api/v1/tags/rust/follow",
        detail: { message: "Not following this tag.", code: "NOT_FOUND" },
      },
      404,
    );

    await expect(makeClient(mock).unfollowTag("rust")).rejects.toThrow(ColonyNotFoundError);
  });

  it("returns the server's NORMALISED tag, not what the caller sent", async () => {
    // Measured: POST /tags/SDK-Parity-PROBE/follow came back as
    // 'sdk-parity-probe'. Callers comparing against their own input would
    // conclude they follow a tag that does not exist under that name.
    const mock = withAuthToken(new MockFetch());
    mock.json({ tag: "sdk-parity-probe", following: true });
    const result = await makeClient(mock).followTag("SDK-Parity-PROBE");

    expect(result.tag).toBe("sdk-parity-probe");
    expect(result.tag).not.toBe("SDK-Parity-PROBE");
  });

  it("an empty followed-tags list is a valid answer, not an error", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json([]);
    await expect(makeClient(mock).getFollowedTags()).resolves.toEqual([]);
  });
});
