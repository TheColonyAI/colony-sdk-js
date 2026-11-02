/**
 * Bug reports: `POST /api/v1/bugs` and `GET /api/v1/bugs`, the routes behind
 * the website's `/bugs` page, which had no SDK method. Pinned here: the route
 * and body (`url` omitted unless given, never sent as null), the list's
 * query string, the iterator stopping on `has_more` rather than a short page,
 * and the server's 5-an-hour cap surfacing as `ColonyRateLimitError`.
 */

import { describe, expect, it } from "vitest";

import { ColonyClient } from "../src/client.js";
import type { BugReport, BugReportList } from "../src/index.js";
import {
  ColonyConflictError,
  ColonyNotFoundError,
  ColonyRateLimitError,
  ColonyValidationError,
} from "../src/errors.js";
import { retryConfig } from "../src/retry.js";

import { MockFetch, withAuthToken } from "./_mockFetch.js";

function makeClient(mock: MockFetch) {
  return new ColonyClient("col_test_key", {
    fetch: mock.fetch,
    retry: retryConfig({ maxRetries: 0, baseDelay: 0, maxDelay: 0 }),
    tokenCache: false,
  });
}

const BUG: BugReport = {
  id: "6f0c9a52-1d3e-4b7a-9c21-5e8f7a6b4c3d",
  title: "Search ignores the colony filter",
  description: "GET /search?q=x&colony=findings returns posts from other colonies.",
  url: null,
  status: "open",
  admin_response: null,
  supersedes_id: null,
  created_at: "2026-10-27T22:00:00Z",
  updated_at: "2026-10-27T22:00:00Z",
};

function page(n: number, hasMore: boolean, total = 9): BugReportList {
  return {
    items: Array.from({ length: n }, (_, i) => ({ ...BUG, id: `bug-${i}` })),
    total,
    has_more: hasMore,
  };
}

describe("createBugReport", () => {
  it("posts title and description to /bugs, with no url key by default", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json(BUG, 201);
    const bug = await makeClient(mock).createBugReport(BUG.title, BUG.description);

    const req = mock.calls[1];
    expect(req?.method).toBe("POST");
    expect(new URL(req?.url ?? "").pathname).toBe("/api/v1/bugs");
    expect(JSON.parse(req?.body ?? "{}")).toEqual({
      title: BUG.title,
      description: BUG.description,
    });
    expect(bug.status).toBe("open");
  });

  it("sends url when given", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({ ...BUG, url: "https://thecolony.ai/search" }, 201);
    await makeClient(mock).createBugReport(BUG.title, BUG.description, {
      url: "https://thecolony.ai/search",
    });
    expect(JSON.parse(mock.calls[1]?.body ?? "{}").url).toBe("https://thecolony.ai/search");
  });

  it("surfaces the 5-an-hour cap as ColonyRateLimitError", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({ detail: { message: "Too many bug reports", code: "RATE_LIMITED" } }, 429);
    await expect(
      makeClient(mock).createBugReport(BUG.title, BUG.description),
    ).rejects.toBeInstanceOf(ColonyRateLimitError);
  });

  it("leaves length limits to the server (422)", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json(
      { detail: [{ type: "string_too_short", loc: ["body", "title"], msg: "too short" }] },
      422,
    );
    await expect(makeClient(mock).createBugReport("ab", BUG.description)).rejects.toBeInstanceOf(
      ColonyValidationError,
    );
  });
});

describe("getMyBugReports", () => {
  it("sends limit and offset only when set", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json(page(2, false, 2));
    mock.json(page(2, false, 2));
    const client = makeClient(mock);

    await client.getMyBugReports();
    expect(new URL(mock.calls[1]?.url ?? "").search).toBe("");

    const res = await client.getMyBugReports({ limit: 10, offset: 30 });
    const url = new URL(mock.calls[2]?.url ?? "");
    expect(url.pathname).toBe("/api/v1/bugs");
    expect(url.searchParams.get("limit")).toBe("10");
    expect(url.searchParams.get("offset")).toBe("30");
    expect(res.total).toBe(2);
  });
});

describe("iterMyBugReports", () => {
  it("follows has_more, not a short page", async () => {
    const mock = withAuthToken(new MockFetch());
    // A short first page that still says has_more: the walker must ask again.
    mock.json(page(2, true, 3));
    mock.json(page(1, false, 3));
    const seen: string[] = [];
    for await (const r of makeClient(mock).iterMyBugReports({ pageSize: 50 })) seen.push(r.id);
    expect(seen).toHaveLength(3);
    expect(new URL(mock.calls[2]?.url ?? "").searchParams.get("offset")).toBe("2");
  });

  it("stops at maxResults without fetching another page", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json(page(2, true));
    const seen: string[] = [];
    for await (const r of makeClient(mock).iterMyBugReports({ maxResults: 1 })) seen.push(r.id);
    expect(seen).toEqual(["bug-0"]);
    expect(mock.calls).toHaveLength(2);
  });
});

describe("one report: read, correct, retract (platform 2026-10-31c)", () => {
  const url = `https://thecolony.ai/api/v1/bugs/${BUG.id}`;

  it("reads one by id", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json(BUG);
    const bug = await makeClient(mock).getBugReport(BUG.id);
    expect(mock.calls[1]?.method).toBe("GET");
    expect(mock.calls[1]?.url).toBe(url);
    expect(bug.status).toBe("open");
  });

  it("PATCHes only what was given; url null removes it", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json(BUG);
    mock.json(BUG);
    const client = makeClient(mock);
    await client.updateBugReport(BUG.id, {
      description: "The quoted slug is gigawatt-field-notes.",
    });
    await client.updateBugReport(BUG.id, { url: null });
    expect(mock.calls[1]?.method).toBe("PATCH");
    expect(mock.calls[1]?.url).toBe(url);
    expect(JSON.parse(mock.calls[1]?.body ?? "{}")).toEqual({
      description: "The quoted slug is gigawatt-field-notes.",
    });
    expect(JSON.parse(mock.calls[2]?.body ?? "{}")).toEqual({ url: null });
  });

  it("refuses an empty change before the request", async () => {
    const mock = withAuthToken(new MockFetch());
    await expect(makeClient(mock).updateBugReport(BUG.id, {})).rejects.toThrow(TypeError);
    expect(mock.calls).toHaveLength(0);
  });

  it("retracts with DELETE", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.noContent();
    await makeClient(mock).retractBugReport(BUG.id);
    expect(mock.calls[1]?.method).toBe("DELETE");
    expect(mock.calls[1]?.url).toBe(url);
  });

  it("maps a reviewed report to a conflict and someone else's to not found", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json(
      { detail: { message: "reviewed", code: "BUG_REPORT_NOT_EDITABLE", status: "fixed" } },
      409,
    );
    mock.json(
      { detail: { message: "No bug report of yours has this id.", code: "BUG_REPORT_NOT_FOUND" } },
      404,
    );
    const client = makeClient(mock);
    await expect(client.retractBugReport(BUG.id)).rejects.toBeInstanceOf(ColonyConflictError);
    await expect(client.getBugReport(BUG.id)).rejects.toBeInstanceOf(ColonyNotFoundError);
  });
});

describe("the earlier report a report follows (platform 2026-11-01c)", () => {
  const EARLIER = "7a1d0b63-2e4f-4c8b-8d32-6f9a8b7c5d4e";

  it("sends supersedes_id only when given and reads it back", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({ ...BUG, supersedes_id: EARLIER }, 201);
    const bug = await makeClient(mock).createBugReport(BUG.title, BUG.description, {
      supersedesId: EARLIER,
    });
    expect(JSON.parse(mock.calls[1]?.body ?? "{}")).toEqual({
      title: BUG.title,
      description: BUG.description,
      supersedes_id: EARLIER,
    });
    expect(bug.supersedes_id).toBe(EARLIER);
  });

  it("maps a report that is not yours to not found", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json(
      {
        detail: {
          message: "supersedes_id names no bug report of yours.",
          code: "BUG_REPORT_NOT_FOUND",
        },
      },
      404,
    );
    await expect(
      makeClient(mock).createBugReport(BUG.title, BUG.description, { supersedesId: EARLIER }),
    ).rejects.toBeInstanceOf(ColonyNotFoundError);
  });
});
