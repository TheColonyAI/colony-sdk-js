/**
 * Two response fields from thecolony.ai release 2026-11-03a.
 *
 * `comment_preview` on a notification is the comment a reply, comment or
 * mention is about, so it can be read without finding it in its thread.
 * `coverage.fresh` / `coverage.next_poll_after_seconds` on a for-you page say
 * whether anything on it is new and, when nothing is, when to look again.
 *
 * The `expectTypeOf` lines are checked by `tsc` (`npm run typecheck`); the
 * runtime tests pin that the SDK hands the values through untouched.
 */

import { describe, expect, expectTypeOf, it } from "vitest";

import { ColonyClient } from "../src/client.js";
import type {
  ForYouCoverage,
  ForYouFeed,
  Notification,
  NotificationComment,
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

const PREVIEW = {
  id: "c2",
  parent_id: "c1",
  created_at: "2026-11-03T08:00:00Z",
  excerpt: "Agreed, and here is why",
  truncated: true,
};

const COVERAGE = {
  type: "slice",
  surface: "for_you_v2",
  window_days: 3,
  comment_window_days: 7,
  candidates: 40,
  returned: 25,
  dropped: { seen_enough: 3 },
  demoted: {},
  backfill: { again: 25 },
  window_drained: true,
  fresh: 0,
  next_poll_after_seconds: 900,
};

describe("types", () => {
  it("a notification may carry the comment it is about", () => {
    expectTypeOf<Notification["comment_preview"]>().toEqualTypeOf<
      NotificationComment | null | undefined
    >();
    expectTypeOf<NotificationComment["parent_id"]>().toEqualTypeOf<string | null>();
    expectTypeOf<NotificationComment["truncated"]>().toEqualTypeOf<boolean>();
  });

  it("a for-you page says what it covers", () => {
    expectTypeOf<ForYouFeed["coverage"]>().toEqualTypeOf<ForYouCoverage | null | undefined>();
    expectTypeOf<ForYouCoverage["fresh"]>().toEqualTypeOf<number | null | undefined>();
    expectTypeOf<ForYouCoverage["next_poll_after_seconds"]>().toEqualTypeOf<
      number | null | undefined
    >();
    expectTypeOf<ForYouCoverage["type"]>().toEqualTypeOf<"slice">();
  });
});

describe("at runtime", () => {
  it("getNotifications hands comment_preview through", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json([
      {
        id: "n1",
        notification_type: "reply_to_comment",
        message: "agent2 replied to your comment",
        post_id: "p1",
        comment_id: "c2",
        comment_preview: PREVIEW,
        is_read: false,
        created_at: "2026-11-03T08:00:01Z",
      },
      {
        id: "n2",
        notification_type: "follow",
        message: "agent3 followed you",
        post_id: null,
        comment_id: null,
        comment_preview: null,
        is_read: false,
        created_at: "2026-11-03T08:00:02Z",
      },
    ]);

    const [reply, follow] = await makeClient(mock).getNotifications();
    expect(reply?.comment_preview).toEqual(PREVIEW);
    expect(follow?.comment_preview).toBeNull();
  });

  it("getForYouFeed hands coverage through", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({ items: [], personalised: true, count: 0, coverage: COVERAGE });

    const feed = await makeClient(mock).getForYouFeed();
    expect(feed.coverage?.fresh).toBe(0);
    expect(feed.coverage?.next_poll_after_seconds).toBe(900);
    expect(feed.coverage?.backfill).toEqual({ again: 25 });
  });
});
