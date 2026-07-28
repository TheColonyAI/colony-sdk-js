/**
 * Colony moderation — membership, bans, appeals, strikes, the mod queue,
 * automod, modmail, and the two governance flows.
 *
 * Shapes read off the server on 2026-07-28: `app/api/v1/colonies.py`,
 * `app/api/v1/colony_governance.py`, `app/api/v1/colony_moderation/*` and
 * `app/schemas/colony.py`. The Python SDK types all 35 of these as bare dicts,
 * so nothing below was inherited from it.
 *
 * The things worth asserting here are mostly *distinctions* — places where two
 * neighbouring endpoints look alike and are not:
 *
 * - `/appeal` (your own ban status) vs `/appeals` (the moderator queue). One
 *   character apart, different audiences, different shapes.
 * - Six endpoints reply `204` and resolve to `{}`; the rest return a body.
 * - `listColonyMembers` and `listColonyBans` return **bare arrays**, while
 *   every other list in this cohort is enveloped.
 * - `modQueueBulkAction` reports partial success in its result rather than
 *   throwing, so a caller who only handles rejection silently drops failures.
 *
 * Everything goes through the mock fetch, so what is asserted is what actually
 * goes on the wire.
 */

import { describe, expect, it } from "vitest";

import { ColonyClient } from "../src/client.js";
import type { ModQueueSource } from "../src/types.js";
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

/** UUIDs resolve without a colony-lookup round trip, keeping indices stable. */
const COLONY = "aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb";
const USER = "cccccccc-4444-5555-6666-dddddddddddd";
const TRANSFER = "eeeeeeee-7777-8888-9999-ffffffffffff";

describe("verb and path", () => {
  const routes: Array<[string, (c: ColonyClient) => Promise<unknown>, string, string]> = [
    [
      "updateColonySettings",
      (c) => c.updateColonySettings(COLONY, { description: "x" }),
      "PATCH",
      `/colonies/${COLONY}`,
    ],
    ["listColonyMembers", (c) => c.listColonyMembers(COLONY), "GET", `/colonies/${COLONY}/members`],
    [
      "promoteColonyMember",
      (c) => c.promoteColonyMember(COLONY, USER),
      "POST",
      `/colonies/${COLONY}/members/${USER}/promote`,
    ],
    [
      "demoteColonyMember",
      (c) => c.demoteColonyMember(COLONY, USER),
      "POST",
      `/colonies/${COLONY}/members/${USER}/demote`,
    ],
    [
      "removeColonyMember",
      (c) => c.removeColonyMember(COLONY, USER),
      "DELETE",
      `/colonies/${COLONY}/members/${USER}`,
    ],
    [
      "banColonyMember",
      (c) => c.banColonyMember(COLONY, USER),
      "POST",
      `/colonies/${COLONY}/bans/${USER}`,
    ],
    [
      "unbanColonyMember",
      (c) => c.unbanColonyMember(COLONY, USER),
      "DELETE",
      `/colonies/${COLONY}/bans/${USER}`,
    ],
    ["listColonyBans", (c) => c.listColonyBans(COLONY), "GET", `/colonies/${COLONY}/bans`],
    ["getMyBanStatus", (c) => c.getMyBanStatus(COLONY), "GET", `/colonies/${COLONY}/appeal`],
    [
      "submitBanAppeal",
      (c) => c.submitBanAppeal(COLONY, "please"),
      "POST",
      `/colonies/${COLONY}/appeal`,
    ],
    ["listBanAppeals", (c) => c.listBanAppeals(COLONY), "GET", `/colonies/${COLONY}/appeals`],
    [
      "resolveBanAppeal",
      (c) => c.resolveBanAppeal(COLONY, "ap-1", true),
      "POST",
      `/colonies/${COLONY}/appeals/ap-1/resolve`,
    ],
    [
      "listMemberStrikes",
      (c) => c.listMemberStrikes(COLONY, USER),
      "GET",
      `/colonies/${COLONY}/members/${USER}/strikes`,
    ],
    [
      "issueMemberStrike",
      (c) => c.issueMemberStrike(COLONY, USER, "spam"),
      "POST",
      `/colonies/${COLONY}/members/${USER}/strikes`,
    ],
    ["getModQueue", (c) => c.getModQueue(COLONY), "GET", `/colonies/${COLONY}/queue`],
    [
      "modQueueAction",
      (c) => c.modQueueAction(COLONY, "open_report", "s-1", "dismiss"),
      "POST",
      `/colonies/${COLONY}/queue/action`,
    ],
    [
      "modQueueBulkAction",
      (c) => c.modQueueBulkAction(COLONY, []),
      "POST",
      `/colonies/${COLONY}/queue/bulk-action`,
    ],
    ["getModActivity", (c) => c.getModActivity(COLONY), "GET", `/colonies/${COLONY}/mod-activity`],
    [
      "listAutomodRules",
      (c) => c.listAutomodRules(COLONY),
      "GET",
      `/colonies/${COLONY}/automod-rules`,
    ],
    [
      "createAutomodRule",
      (c) => c.createAutomodRule(COLONY, "r", {}, {}),
      "POST",
      `/colonies/${COLONY}/automod-rules`,
    ],
    [
      "updateAutomodRule",
      (c) => c.updateAutomodRule(COLONY, "ru-1", { enabled: false }),
      "PATCH",
      `/colonies/${COLONY}/automod-rules/ru-1`,
    ],
    [
      "deleteAutomodRule",
      (c) => c.deleteAutomodRule(COLONY, "ru-1"),
      "DELETE",
      `/colonies/${COLONY}/automod-rules/ru-1`,
    ],
    [
      "reorderAutomodRules",
      (c) => c.reorderAutomodRules(COLONY, ["a", "b"]),
      "PUT",
      `/colonies/${COLONY}/automod-rules/order`,
    ],
    [
      "dryRunAutomodRule",
      (c) => c.dryRunAutomodRule(COLONY, "r", {}, {}),
      "POST",
      `/colonies/${COLONY}/automod-rules/dry-run`,
    ],
    ["listModmail", (c) => c.listModmail(COLONY), "GET", `/colonies/${COLONY}/modmail`],
    ["openModmail", (c) => c.openModmail(COLONY, "hello"), "POST", `/colonies/${COLONY}/modmail`],
    [
      "joinModmail",
      (c) => c.joinModmail(COLONY, "cv-1"),
      "POST",
      `/colonies/${COLONY}/modmail/cv-1/join`,
    ],
    [
      "proposeOwnershipTransfer",
      (c) => c.proposeOwnershipTransfer(COLONY, "someone"),
      "POST",
      `/colonies/${COLONY}/ownership-transfers`,
    ],
    [
      "getPendingOwnershipTransfer",
      (c) => c.getPendingOwnershipTransfer(COLONY),
      "GET",
      `/colonies/${COLONY}/ownership-transfers`,
    ],
    [
      "acceptOwnershipTransfer",
      (c) => c.acceptOwnershipTransfer(TRANSFER),
      "POST",
      `/colonies/ownership-transfers/${TRANSFER}/accept`,
    ],
    [
      "declineOwnershipTransfer",
      (c) => c.declineOwnershipTransfer(TRANSFER),
      "POST",
      `/colonies/ownership-transfers/${TRANSFER}/decline`,
    ],
    [
      "cancelOwnershipTransfer",
      (c) => c.cancelOwnershipTransfer(TRANSFER),
      "POST",
      `/colonies/ownership-transfers/${TRANSFER}/cancel`,
    ],
    [
      "fileColonyDeletionRequest",
      (c) => c.fileColonyDeletionRequest(COLONY, "why"),
      "POST",
      `/colonies/${COLONY}/deletion-request`,
    ],
    [
      "cancelColonyDeletionRequest",
      (c) => c.cancelColonyDeletionRequest(COLONY),
      "DELETE",
      `/colonies/${COLONY}/deletion-request`,
    ],
    [
      "getColonyDeletionRequest",
      (c) => c.getColonyDeletionRequest(COLONY),
      "GET",
      `/colonies/${COLONY}/deletion-request`,
    ],
  ];

  it("covers every ported method", () => {
    // A control on the table: a method added to the client but not here would
    // otherwise be an endpoint nobody tests, silently.
    expect(routes.length).toBe(35);
  });

  for (const [label, call, method, path] of routes) {
    it(`${label} issues ${method} ${path}`, async () => {
      const mock = withAuthToken(new MockFetch());
      mock.json({});
      await call(makeClient(mock));

      const req = requestAt(mock, 1);
      expect(req.method).toBe(method);
      expect(new URL(req.url ?? "").pathname).toBe(`/api/v1${path}`);
    });
  }

  it("keeps /appeal and /appeals distinct", async () => {
    // One character apart, and they answer different questions for different
    // audiences. A typo here would return a plausible-looking wrong shape.
    const mock = withAuthToken(new MockFetch());
    mock.json({ banned: false, ban: null, appeal: null });
    mock.json({ appeals: [] });

    const c = makeClient(mock);
    await c.getMyBanStatus(COLONY);
    await c.listBanAppeals(COLONY);

    expect(new URL(mock.calls[1]?.url ?? "").pathname).toMatch(/\/appeal$/);
    expect(new URL(mock.calls[2]?.url ?? "").pathname).toMatch(/\/appeals$/);
  });
});

describe("query parameters", () => {
  it("getModQueue sends the documented defaults", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({});
    await makeClient(mock).getModQueue(COLONY);

    const q = new URL(requestAt(mock, 1).url ?? "").searchParams;
    expect(q.get("page")).toBe("1");
    expect(q.get("page_size")).toBe("25");
    expect(q.get("sort")).toBe("newest");
    expect(q.get("queue_status")).toBe("open");
    // `source` is a filter; absent means all kinds, so it must not be sent.
    expect(q.has("source")).toBe(false);
  });

  it("getModQueue maps camelCase options to snake_case params", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({});
    await makeClient(mock).getModQueue(COLONY, {
      source: "open_report",
      page: 2,
      pageSize: 50,
      sort: "oldest",
      queueStatus: "resolved",
    });

    const q = new URL(requestAt(mock, 1).url ?? "").searchParams;
    expect(q.get("source")).toBe("open_report");
    expect(q.get("page_size")).toBe("50");
    expect(q.get("queue_status")).toBe("resolved");
    expect(q.get("sort")).toBe("oldest");
  });

  it("listColonyMembers omits role unless filtering", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json([]);
    mock.json([]);
    const c = makeClient(mock);

    await c.listColonyMembers(COLONY);
    expect(new URL(mock.calls[1]?.url ?? "").searchParams.has("role")).toBe(false);

    await c.listColonyMembers(COLONY, { role: "moderator" });
    expect(new URL(mock.calls[2]?.url ?? "").searchParams.get("role")).toBe("moderator");
  });

  it("getModActivity defaults the window to 30 days", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({});
    await makeClient(mock).getModActivity(COLONY);

    expect(new URL(requestAt(mock, 1).url ?? "").searchParams.get("window_days")).toBe("30");
  });
});

describe("request bodies", () => {
  it("banColonyMember sends an empty body for a permanent ban", async () => {
    // Omitting duration is what makes it permanent; sending a default would
    // quietly make every ban temporary.
    const mock = withAuthToken(new MockFetch());
    mock.json({ status: "banned", expires_at: null });
    await makeClient(mock).banColonyMember(COLONY, USER);

    expect(requestAt(mock, 1).body).toEqual({});
  });

  it("banColonyMember maps durationDays and reason", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({});
    await makeClient(mock).banColonyMember(COLONY, USER, { durationDays: 7, reason: "spam" });

    expect(requestAt(mock, 1).body).toEqual({ duration_days: 7, reason: "spam" });
  });

  it("resolveBanAppeal sends accept, and note only when given", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({});
    mock.json({});
    const c = makeClient(mock);

    await c.resolveBanAppeal(COLONY, "ap-1", false);
    expect(requestAt(mock, 1).body).toEqual({ accept: false });

    await c.resolveBanAppeal(COLONY, "ap-1", true, { note: "ok" });
    expect(requestAt(mock, 2).body).toEqual({ accept: true, note: "ok" });
  });

  it("issueMemberStrike omits severity so the server default applies", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({});
    await makeClient(mock).issueMemberStrike(COLONY, USER, "spam");

    expect(requestAt(mock, 1).body).toEqual({ reason: "spam" });
  });

  it("modQueueAction sends the required triple and maps the optionals", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({});
    await makeClient(mock).modQueueAction(COLONY, "open_report", "s-1", "ban_author", {
      reasonId: "r-1",
      banDurationDays: 3,
    });

    expect(requestAt(mock, 1).body).toEqual({
      source_kind: "open_report",
      source_id: "s-1",
      action: "ban_author",
      reason_id: "r-1",
      ban_duration_days: 3,
    });
  });

  it("updateAutomodRule sends only the fields given", async () => {
    // Omitted fields are unchanged server-side; sending undefined keys would
    // turn a partial update into a full overwrite.
    const mock = withAuthToken(new MockFetch());
    mock.json({});
    await makeClient(mock).updateAutomodRule(COLONY, "ru-1", { enabled: false, orderIndex: 2 });

    expect(requestAt(mock, 1).body).toEqual({ enabled: false, order_index: 2 });
  });

  it("createAutomodRule and dryRunAutomodRule send identical bodies", async () => {
    // The dry run is only useful if it tests the rule you are about to create.
    const mock = withAuthToken(new MockFetch());
    mock.json({});
    mock.json({});
    const c = makeClient(mock);
    const triggers = { keywords: ["spam"] };
    const actions = { remove: true };

    await c.createAutomodRule(COLONY, "r", triggers, actions, { scope: "post" });
    await c.dryRunAutomodRule(COLONY, "r", triggers, actions, { scope: "post" });

    expect(requestAt(mock, 1).body).toEqual(requestAt(mock, 2).body);
    expect(requestAt(mock, 1).body).toEqual({
      name: "r",
      triggers,
      actions,
      scope: "post",
    });
  });

  it("reorderAutomodRules nests ids under rule_ids", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({});
    await makeClient(mock).reorderAutomodRules(COLONY, ["a", "b"]);

    expect(requestAt(mock, 1).body).toEqual({ rule_ids: ["a", "b"] });
  });

  it("proposeOwnershipTransfer sends a username, not a user id", async () => {
    // The one place in this cohort addressed by handle. Sending a UUID here
    // would be accepted as a username and fail to resolve.
    const mock = withAuthToken(new MockFetch());
    mock.json({});
    await makeClient(mock).proposeOwnershipTransfer(COLONY, "someone");

    expect(requestAt(mock, 1).body).toEqual({ recipient_username: "someone" });
  });

  it("updateColonySettings passes the patch through untouched", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({});
    await makeClient(mock).updateColonySettings(COLONY, { description: "x", is_private: true });

    expect(requestAt(mock, 1).body).toEqual({ description: "x", is_private: true });
  });
});

describe("mod-queue source vocabulary", () => {
  /**
   * Measured against the live API on 2026-07-28 with the is_tester account:
   * every one of the eight `chip_counts` keys is accepted as `?source=`
   * (200), and a bogus value is rejected (422). 0.19.0 shipped a union of
   * only six.
   *
   * The root cause is worth recording because no test would have caught it:
   * the server enum was read through a `grep -A10` window that ended one line
   * before `unmoderated` and `edited_post`, and its docstring — "Closed v1 set
   * of source kinds" — described v1, after two more had been added. A
   * truncated read plus a stale docstring produced a confident, complete-
   * looking answer.
   */
  const ALL_SOURCES: ModQueueSource[] = [
    "pending_post",
    "open_report",
    "automod_removed_post",
    "automod_removed_comment",
    "automod_filtered_post",
    "xss_probe_quarantined",
    "unmoderated",
    "edited_post",
  ];

  it("covers all eight kinds the server accepts", () => {
    // Guards the count itself: the previous union had six and nothing said so.
    expect(ALL_SOURCES.length).toBe(8);
  });

  for (const src of ALL_SOURCES) {
    it(`sends source=${src} through unchanged`, async () => {
      const mock = withAuthToken(new MockFetch());
      mock.json({});
      await makeClient(mock).getModQueue(COLONY, { source: src });

      expect(new URL(requestAt(mock, 1).url ?? "").searchParams.get("source")).toBe(src);
    });
  }

  it("total:0 with a non-zero unmoderated chip is a valid state, not a contradiction", async () => {
    // The filter-only rule: `unmoderated` and `edited_post` are excluded from
    // the default view because they are the whole live-content surface. This
    // exact shape came back from the live API, and reading it as "the queue is
    // empty" would be wrong.
    const mock = withAuthToken(new MockFetch());
    mock.json({
      items: [],
      total: 0,
      page: 1,
      page_size: 25,
      pending_appeal_count: 0,
      chip_counts: {
        pending_post: 0,
        open_report: 0,
        automod_filtered_post: 0,
        automod_removed_post: 0,
        automod_removed_comment: 0,
        xss_probe_quarantined: 0,
        unmoderated: 3,
        edited_post: 0,
      },
    });
    const q = await makeClient(mock).getModQueue(COLONY);

    expect(q.total).toBe(0);
    expect(q.items).toEqual([]);
    expect(q.chip_counts["unmoderated"]).toBe(3);
  });
});

describe("measured response shapes", () => {
  it("members and bans are bare arrays; everything else is enveloped", async () => {
    // This cohort is not internally consistent, and factoring these into one
    // list helper would read `undefined` for two of them.
    const mock = withAuthToken(new MockFetch());
    mock.json([{ user_id: USER, username: "a", approved: true }]);
    mock.json([{ user_id: USER, username: "a", is_active: true }]);
    mock.json({ rules: [] });
    mock.json({ threads: [] });
    mock.json({ appeals: [] });

    const c = makeClient(mock);
    expect(Array.isArray(await c.listColonyMembers(COLONY))).toBe(true);
    expect(Array.isArray(await c.listColonyBans(COLONY))).toBe(true);
    expect((await c.listAutomodRules(COLONY)).rules).toEqual([]);
    expect((await c.listModmail(COLONY)).threads).toEqual([]);
    expect((await c.listBanAppeals(COLONY)).appeals).toEqual([]);
  });

  it("all six 204 endpoints resolve to {} rather than throwing", async () => {
    const mock = withAuthToken(new MockFetch());
    for (let i = 0; i < 6; i++) mock.noContent();

    const c = makeClient(mock);
    await expect(c.promoteColonyMember(COLONY, USER)).resolves.toEqual({});
    await expect(c.demoteColonyMember(COLONY, USER)).resolves.toEqual({});
    await expect(c.removeColonyMember(COLONY, USER)).resolves.toEqual({});
    await expect(c.unbanColonyMember(COLONY, USER)).resolves.toEqual({});
    await expect(c.deleteAutomodRule(COLONY, "ru-1")).resolves.toEqual({});
    await expect(c.cancelColonyDeletionRequest(COLONY)).resolves.toEqual({});
  });

  it("bulk action reports partial success in the result, not by throwing", async () => {
    // The failure mode this guards: a caller who only handles rejection would
    // treat a half-failed bulk action as a complete success.
    const mock = withAuthToken(new MockFetch());
    mock.json({
      succeeded: [
        {
          modlog_id: "m1",
          source_kind: "open_report",
          source_id: "s1",
          action: "dismiss",
          target_kind: "post",
          target_id: "t1",
          cascaded_report_ids: [],
          reason_id: null,
        },
      ],
      failed: [
        {
          source_kind: "pending_post",
          source_id: "s2",
          action: "approve",
          message: "not admissible",
        },
      ],
    });

    const result = await makeClient(mock).modQueueBulkAction(COLONY, [
      { source_kind: "open_report", source_id: "s1", action: "dismiss" },
      { source_kind: "pending_post", source_id: "s2", action: "approve" },
    ]);

    expect(result.succeeded).toHaveLength(1);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.message).toBe("not admissible");
  });

  it("a permanent ban comes back with expires_at null", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({ status: "banned", expires_at: null });
    const result = await makeClient(mock).banColonyMember(COLONY, USER);

    expect(result.status).toBe("banned");
    expect(result.expires_at).toBeNull();
  });

  it("ban status: an appeal can outlive the ban that prompted it", async () => {
    // `ban` and `appeal` are independently nullable, so `banned` is the only
    // field that answers the question. Inferring it from `ban !== null` is
    // wrong in exactly this state.
    const mock = withAuthToken(new MockFetch());
    mock.json({
      banned: false,
      ban: null,
      appeal: {
        appeal_id: "ap1",
        status: "pending",
        created_at: "2026-07-28T00:00:00+00:00",
        resolution_note: null,
        resolved_at: null,
      },
    });
    const status = await makeClient(mock).getMyBanStatus(COLONY);

    expect(status.banned).toBe(false);
    expect(status.ban).toBeNull();
    expect(status.appeal).not.toBeNull();
  });

  it("resolving an appeal reports whether a ban was actually lifted", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({ appeal_id: "ap1", status: "accepted", unbanned: false });
    const result = await makeClient(mock).resolveBanAppeal(COLONY, "ap1", true);

    // Accepted, but nothing was lifted — the ban had already lapsed.
    expect(result.status).toBe("accepted");
    expect(result.unbanned).toBe(false);
  });

  it("issuing a strike can fire the threshold action as a side effect", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({
      strike: {
        strike_id: "s1",
        reason: "spam",
        severity: "major",
        issued_by: USER,
        created_at: "2026-07-28T00:00:00+00:00",
        expires_at: null,
      },
      active_count: 3,
      threshold: 3,
      fired_action: "ban",
    });
    const result = await makeClient(mock).issueMemberStrike(COLONY, USER, "spam", {
      severity: "major",
    });

    expect(result.fired_action).toBe("ban");
    expect(result.active_count).toBe(result.threshold);
  });

  it("active_count is not strikes.length", async () => {
    // Expired strikes stay in the list but do not count toward the threshold.
    const mock = withAuthToken(new MockFetch());
    mock.json({
      strikes: [
        {
          strike_id: "s1",
          reason: "a",
          severity: "minor",
          issued_by: null,
          created_at: "2026-01-01T00:00:00+00:00",
          expires_at: "2026-02-01T00:00:00+00:00",
        },
        {
          strike_id: "s2",
          reason: "b",
          severity: "minor",
          issued_by: null,
          created_at: "2026-07-01T00:00:00+00:00",
          expires_at: null,
        },
      ],
      active_count: 1,
      threshold: 3,
      strike_action: "ban",
    });
    const result = await makeClient(mock).listMemberStrikes(COLONY, USER);

    expect(result.strikes).toHaveLength(2);
    expect(result.active_count).toBe(1);
  });

  it("the queue carries the appeal backlog so polling mods need one request", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({
      items: [],
      chip_counts: { open_report: 2 },
      total: 0,
      page: 1,
      page_size: 25,
      pending_appeal_count: 4,
    });
    const queue = await makeClient(mock).getModQueue(COLONY);

    expect(queue.pending_appeal_count).toBe(4);
    expect(queue.chip_counts["open_report"]).toBe(2);
  });

  it("openModmail distinguishes opened from found", async () => {
    // `created: false` means an existing thread was reused — closer to
    // find-or-create than create.
    const mock = withAuthToken(new MockFetch());
    mock.json({ conversation_id: "cv1", created: false });
    const result = await makeClient(mock).openModmail(COLONY, "hello");

    expect(result.created).toBe(false);
    expect(result.conversation_id).toBe("cv1");
  });

  it("pending ownership transfer and deletion request wrap their null case", async () => {
    // Both answer "none" with a successful body rather than a 404, so absence
    // is readable without catching.
    const mock = withAuthToken(new MockFetch());
    mock.json({ pending: null });
    mock.json({ open_request: null });

    const c = makeClient(mock);
    await expect(c.getPendingOwnershipTransfer(COLONY)).resolves.toEqual({ pending: null });
    await expect(c.getColonyDeletionRequest(COLONY)).resolves.toEqual({ open_request: null });
  });

  it("dry run reports matches without creating anything", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({
      scanned_posts: 100,
      scanned_comments: 250,
      total_scanned: 350,
      match_count: 1,
      matches: [
        {
          item_type: "post",
          item_id: "p1",
          title: "t",
          body_excerpt: "e",
          author_username: "a",
          created_at: "2026-07-28T00:00:00+00:00",
          matched_keys: ["keywords"],
        },
      ],
    });
    const result = await makeClient(mock).dryRunAutomodRule(COLONY, "r", {}, {});

    expect(result.total_scanned).toBe(350);
    expect(result.matches[0]?.matched_keys).toEqual(["keywords"]);
    // Exactly one request beyond auth: a dry run must not also create the rule.
    expect(mock.calls.length).toBe(2);
  });
});
