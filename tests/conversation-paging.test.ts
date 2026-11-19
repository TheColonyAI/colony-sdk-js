/**
 * DM conversations can be read past the first page.
 *
 * `GET /api/v1/messages/conversations` takes `limit` (1-100, default 50),
 * `offset` and `include_archived` (default false), and answers a bare array
 * with no total, cursor or `has_more`. `listConversations()` sent none of
 * them, so an account with more than 50 conversations got the newest 50,
 * archived ones never, and nothing said there were more.
 *
 * Pinned here: each option's exact query string, the unchanged request of a
 * call with no options, and `iterConversations` walking pages to a short page,
 * stopping at `maxResults`, yielding each id once when the list shifts
 * mid-walk, and throwing rather than loop when the server ignores `offset`.
 */

import { describe, expect, expectTypeOf, it } from "vitest";

import { ColonyClient } from "../src/client.js";
import { ColonyAPIError, ColonyValidationError } from "../src/errors.js";
import type {
  Conversation,
  IterConversationsOptions,
  ListConversationsOptions,
} from "../src/index.js";
import { retryConfig } from "../src/retry.js";

import { MockFetch, withAuthToken } from "./_mockFetch.js";

function makeClient(mock: MockFetch): ColonyClient {
  return new ColonyClient("col_test_key", {
    fetch: mock.fetch,
    retry: retryConfig({ maxRetries: 0, baseDelay: 0, maxDelay: 0 }),
    tokenCache: false,
  });
}

function row(i: number): Conversation {
  return {
    id: `conv-${i}`,
    other_user: { id: `user-${i}`, username: `agent-${i}` } as Conversation["other_user"],
    last_message_at: "2026-11-18T12:00:00Z",
    unread_count: 0,
    last_message_preview: "hi",
    is_archived: false,
  };
}

function rows(start: number, stop: number): Conversation[] {
  return Array.from({ length: stop - start }, (_, k) => row(start + k));
}

/** The path and query of every request after the auth exchange. */
function sent(mock: MockFetch): string[] {
  return mock.calls.slice(1).map((c) => {
    const u = new URL(c.url);
    return u.pathname + u.search;
  });
}

const PATH = "/api/v1/messages/conversations";

describe("listConversations", () => {
  it("sends exactly the old request when called with no options", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json([]);
    await makeClient(mock).listConversations();
    expect(sent(mock)).toEqual([PATH]);
    expect(mock.calls[1]?.method).toBe("GET");
  });

  it("sends nothing for an empty options object or includeArchived: false", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json([]);
    mock.json([]);
    const client = makeClient(mock);
    await client.listConversations({});
    await client.listConversations({ includeArchived: false });
    expect(sent(mock)).toEqual([PATH, PATH]);
  });

  it.each<[ListConversationsOptions, string]>([
    [{ limit: 100 }, "?limit=100"],
    [{ offset: 50 }, "?offset=50"],
    [{ offset: 0 }, "?offset=0"],
    [{ includeArchived: true }, "?include_archived=true"],
    [
      { limit: 100, offset: 50, includeArchived: true },
      "?limit=100&offset=50&include_archived=true",
    ],
  ])("sends %j as %s", async (options, query) => {
    const mock = withAuthToken(new MockFetch());
    mock.json([]);
    await makeClient(mock).listConversations(options);
    expect(sent(mock)).toEqual([PATH + query]);
  });

  it("returns the page as the server sent it", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json(rows(0, 3));
    const page = await makeClient(mock).listConversations({ limit: 3 });
    expect(page).toEqual(rows(0, 3));
    expectTypeOf(page).toEqualTypeOf<Conversation[]>();
  });

  it("surfaces the server's 422 for a limit above 100", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json(
      { detail: [{ loc: ["query", "limit"], msg: "Input should be less than or equal to 100" }] },
      422,
    );
    const err = await makeClient(mock)
      .listConversations({ limit: 101 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ColonyValidationError);
    expect(sent(mock)).toEqual([`${PATH}?limit=101`]);
  });

  it("still takes a bare CallOptions", () => {
    expectTypeOf<{ signal: AbortSignal }>().toMatchTypeOf<ListConversationsOptions>();
  });
});

describe("iterConversations", () => {
  async function collect(mock: MockFetch, options?: IterConversationsOptions): Promise<string[]> {
    const ids: string[] = [];
    for await (const c of makeClient(mock).iterConversations(options)) ids.push(c.id);
    return ids;
  }

  it("walks limit/offset pages of 50 until a short page", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json(rows(0, 50));
    mock.json(rows(50, 100));
    mock.json(rows(100, 120));
    const ids = await collect(mock);
    expect(ids).toEqual(rows(0, 120).map((r) => r.id));
    expect(sent(mock)).toEqual([
      `${PATH}?limit=50&offset=0`,
      `${PATH}?limit=50&offset=50`,
      `${PATH}?limit=50&offset=100`,
    ]);
  });

  it("stops after an empty page when the last full page ended the list", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json(rows(0, 2));
    mock.json([]);
    const ids = await collect(mock, { pageSize: 2 });
    expect(ids).toEqual(["conv-0", "conv-1"]);
    expect(sent(mock)).toEqual([`${PATH}?limit=2&offset=0`, `${PATH}?limit=2&offset=2`]);
  });

  it("sends pageSize and includeArchived on every page", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json(rows(0, 100));
    mock.json(rows(100, 101));
    await collect(mock, { pageSize: 100, includeArchived: true });
    expect(sent(mock)).toEqual([
      `${PATH}?limit=100&offset=0&include_archived=true`,
      `${PATH}?limit=100&offset=100&include_archived=true`,
    ]);
  });

  it("stops at maxResults without fetching another page", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json(rows(0, 3));
    mock.json(rows(3, 6));
    const ids = await collect(mock, { pageSize: 3, maxResults: 4 });
    expect(ids).toEqual(["conv-0", "conv-1", "conv-2", "conv-3"]);
    expect(sent(mock)).toHaveLength(2);
  });

  it("makes no request for maxResults: 0", async () => {
    const mock = withAuthToken(new MockFetch());
    expect(await collect(mock, { maxResults: 0 })).toEqual([]);
    expect(mock.calls).toHaveLength(0);
  });

  it("yields each id once when a new DM shifts the list mid-walk", async () => {
    // A DM to conv-9 between the pages moves it to the top: page two then
    // starts with conv-2, the last row of page one.
    const mock = withAuthToken(new MockFetch());
    mock.json([row(0), row(1), row(2)]);
    mock.json([row(2), row(3), row(4)]);
    mock.json([row(5)]);
    const ids = await collect(mock, { pageSize: 3 });
    expect(ids).toEqual(["conv-0", "conv-1", "conv-2", "conv-3", "conv-4", "conv-5"]);
  });

  it("throws rather than loop when the server ignores offset", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json(rows(0, 2));
    mock.json(rows(0, 2));
    const client = makeClient(mock);
    const ids: string[] = [];
    const err = await (async () => {
      for await (const c of client.iterConversations({ pageSize: 2 })) ids.push(c.id);
    })().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ColonyAPIError);
    expect(String((err as Error).message)).toMatch(/not honouring offset/);
    expect(ids).toEqual(["conv-0", "conv-1"]);
  });

  it("throws on a response that is not an array instead of ending the walk", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({ conversations: rows(0, 2) });
    const err = await collect(mock).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ColonyAPIError);
    expect(String((err as Error).message)).toMatch(/expected a JSON array/);
  });
});
