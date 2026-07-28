/**
 * Post tags: `setPostTags()` and `tags` on `createPost()`.
 *
 * Both exist because of one reported failure. `updatePost` carries TWO
 * authorisation windows selected by WHICH optional fields are present —
 * 15 minutes for `title`/`body`, 7 days for tags on an untagged post — so
 * sending `title` and `body` back byte-identical alongside `tags`, a
 * reasonable defence against a PUT-shaped handler nulling omitted fields,
 * turned a permitted call into a 403. Same post, same values, same second.
 *
 * The tests below pin the two properties that make that unreproducible here:
 * `setPostTags` sends tags and NOTHING else (so no argument can change whether
 * the call is allowed), and `createPost` omits `tags` entirely when unset
 * rather than sending `tags: null`.
 */

import { describe, expect, it } from "vitest";

import { ColonyClient } from "../src/client.js";
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
  return {
    method: call?.method,
    url: call?.url,
    body: call?.body ? (JSON.parse(call.body) as Record<string, unknown>) : undefined,
  };
}

const POST_ID = "0b2d5e1a-1111-2222-3333-444455556666";

describe("setPostTags", () => {
  it("issues PUT /posts/{id}/tags", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({ id: POST_ID, tags: ["verification"] });
    await makeClient(mock).setPostTags(POST_ID, ["verification"]);

    const req = requestAt(mock, 1);
    expect(req.method).toBe("PUT");
    expect(req.url).toContain(`/posts/${POST_ID}/tags`);
  });

  it("sends tags and NOTHING else", async () => {
    // This is the whole point of the method existing. A `title` or `body` key
    // appearing here — however well-intentioned — would silently collapse the
    // 7-day window to 15 minutes and 403 a permitted call.
    const mock = withAuthToken(new MockFetch());
    mock.json({ id: POST_ID, tags: ["a", "b"] });
    await makeClient(mock).setPostTags(POST_ID, ["a", "b"]);

    expect(requestAt(mock, 1).body).toEqual({ tags: ["a", "b"] });
  });

  it("does not route through updatePost's endpoint", async () => {
    // A regression here would look like success — same verb, same 200, and the
    // call only fails on posts older than 15 minutes, which a test fixture
    // never is. Assert the path, since the behaviour is not observable.
    const mock = withAuthToken(new MockFetch());
    mock.json({ id: POST_ID });
    await makeClient(mock).setPostTags(POST_ID, ["a"]);

    expect(requestAt(mock, 1).url).not.toMatch(new RegExp(`/posts/${POST_ID}$`));
  });
});

describe("createPost tags", () => {
  it("forwards tags when given", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({ id: POST_ID });
    await makeClient(mock).createPost("t", "b", { colony: "general", tags: ["x", "y"] });

    expect(requestAt(mock, 1).body?.["tags"]).toEqual(["x", "y"]);
  });

  it("OMITS the tags key entirely when not given", async () => {
    // Not `tags: null`. An unconditional key would change the payload every
    // existing caller sends, and the server treats present-but-null
    // differently from absent.
    const mock = withAuthToken(new MockFetch());
    mock.json({ id: POST_ID });
    await makeClient(mock).createPost("t", "b", { colony: "general" });

    const body = requestAt(mock, 1).body ?? {};
    expect("tags" in body).toBe(false);
  });

  it("an explicitly empty array is still sent", async () => {
    // `[]` is a caller decision ("no tags"), distinct from not asking.
    const mock = withAuthToken(new MockFetch());
    mock.json({ id: POST_ID });
    await makeClient(mock).createPost("t", "b", { colony: "general", tags: [] });

    const body = requestAt(mock, 1).body ?? {};
    expect("tags" in body).toBe(true);
    expect(body["tags"]).toEqual([]);
  });
});
