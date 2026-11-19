/**
 * Notifications can be read past the first page.
 *
 * `GET /api/v1/notifications` takes `limit` (1-100, default 50) and `offset`,
 * and answers a bare array with no total or cursor. `getNotifications()` sent
 * only `limit` (and `unread_only`), so an inbox of more than 50 could not be
 * read past its first page.
 *
 * Pinned here: the unchanged request of a call without `offset`, each option's
 * exact query string, and `iterNotifications` walking pages to a short page,
 * stopping at `maxResults`, yielding each id once when the list shifts
 * mid-walk, and throwing rather than loop when the server ignores `offset`.
 */

import { describe, expect, expectTypeOf, it } from "vitest";

import { ColonyClient } from "../src/client.js";
import { ColonyAPIError } from "../src/errors.js";
import type {
  GetNotificationsOptions,
  IterNotificationsOptions,
  Notification,
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

function row(i: number): Notification {
  return {
    id: `notif-${i}`,
    notification_type: "reply_to_comment",
    message: "replied to your comment",
    is_read: false,
    created_at: "2026-11-19T12:00:00Z",
  } as Notification;
}

function rows(start: number, stop: number): Notification[] {
  return Array.from({ length: stop - start }, (_, k) => row(start + k));
}

/** The path and query of every request after the auth exchange. */
function sent(mock: MockFetch): string[] {
  return mock.calls.slice(1).map((c) => {
    const u = new URL(c.url);
    return u.pathname + u.search;
  });
}

const PATH = "/api/v1/notifications";

describe("getNotifications", () => {
  it("sends exactly the old request without offset", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json([]);
    mock.json([]);
    const client = makeClient(mock);
    await client.getNotifications();
    await client.getNotifications({ unreadOnly: true });
    expect(sent(mock)).toEqual([`${PATH}?limit=50`, `${PATH}?limit=50&unread_only=true`]);
  });

  it.each<[GetNotificationsOptions, string]>([
    [{ offset: 50 }, "?limit=50&offset=50"],
    [{ offset: 0 }, "?limit=50&offset=0"],
    [{ limit: 100, offset: 200, unreadOnly: true }, "?limit=100&offset=200&unread_only=true"],
  ])("sends %j as %s", async (options, query) => {
    const mock = withAuthToken(new MockFetch());
    mock.json([]);
    await makeClient(mock).getNotifications(options);
    expect(sent(mock)).toEqual([PATH + query]);
  });

  it("still takes a bare CallOptions", () => {
    expectTypeOf<{ signal: AbortSignal }>().toMatchTypeOf<GetNotificationsOptions>();
  });
});

describe("iterNotifications", () => {
  async function collect(mock: MockFetch, options?: IterNotificationsOptions): Promise<string[]> {
    const ids: string[] = [];
    for await (const n of makeClient(mock).iterNotifications(options)) ids.push(n.id);
    return ids;
  }

  it("walks limit/offset pages of 50 until a short page", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json(rows(0, 50));
    mock.json(rows(50, 100));
    mock.json(rows(100, 120));
    expect(await collect(mock)).toEqual(rows(0, 120).map((r) => r.id));
    expect(sent(mock)).toEqual([
      `${PATH}?limit=50&offset=0`,
      `${PATH}?limit=50&offset=50`,
      `${PATH}?limit=50&offset=100`,
    ]);
  });

  it("passes pageSize and unreadOnly, and stops at maxResults", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json(rows(0, 10));
    mock.json(rows(10, 20));
    expect(await collect(mock, { pageSize: 10, maxResults: 15, unreadOnly: true })).toEqual(
      rows(0, 15).map((r) => r.id),
    );
    expect(sent(mock)).toEqual([
      `${PATH}?limit=10&offset=0&unread_only=true`,
      `${PATH}?limit=10&offset=10&unread_only=true`,
    ]);
  });

  it("yields a notification once when a new one shifts the list mid-walk", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json(rows(0, 3));
    mock.json([row(2), ...rows(3, 4)]);
    expect(await collect(mock, { pageSize: 3 })).toEqual(rows(0, 4).map((r) => r.id));
  });

  it("throws rather than loop when the server ignores offset", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json(rows(0, 3));
    mock.json(rows(0, 3));
    const err = await collect(mock, { pageSize: 3 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ColonyAPIError);
    expect(String((err as Error).message)).toContain("not honouring offset");
  });

  it("throws on an answer that is not an array", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({ items: rows(0, 3) });
    const err = await collect(mock).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ColonyAPIError);
  });
});
