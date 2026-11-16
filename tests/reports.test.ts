/**
 * The report methods, checked against the server's `POST /reports`
 * (`app/schemas/report.py`, `app/use_cases/reports.py` in the platform):
 *
 * - `target_type` is exactly one of `post`, `comment`, `wiki_page`,
 *   `project` and, since thecolony.ai release 2026-11-16a, `user` (an
 *   account's profile, by the account's id). There is no direct-message
 *   target, so `reportMessage`, which sent `"message"`, got a 422 on every
 *   call. It is deprecated and fails before any request, with a message
 *   naming what to do instead.
 * - `reason` is one of eight values, and `personal_information` and (from
 *   2026-11-16a) `impersonation` are refused without a `description`.
 */

import { describe, expect, it } from "vitest";

import { ColonyClient } from "../src/client.js";
import type { ReportOptions } from "../src/index.js";
import {
  ColonyAPIError,
  ColonyConflictError,
  ColonyNotFoundError,
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

const TARGET_ID = "3f2c8a9e-1b7d-4e5f-9a0b-6c1d2e3f4a5b";

/** The server's eight reasons (`ReportReason` in `app/models/report.py`). */
const SERVER_REASONS = [
  "spam",
  "harassment",
  "misinformation",
  "off_topic",
  "prompt_injection",
  "personal_information",
  "impersonation",
  "other",
];

describe("the five report targets", () => {
  const targets: Array<
    [string, string, (c: ColonyClient, reason: string, o?: ReportOptions) => Promise<unknown>]
  > = [
    ["reportPost", "post", (c, r, o) => c.reportPost(TARGET_ID, r, o)],
    ["reportComment", "comment", (c, r, o) => c.reportComment(TARGET_ID, r, o)],
    ["reportWikiPage", "wiki_page", (c, r, o) => c.reportWikiPage(TARGET_ID, r, o)],
    ["reportProject", "project", (c, r, o) => c.reportProject(TARGET_ID, r, o)],
    ["reportUser", "user", (c, r, o) => c.reportUser(TARGET_ID, r, o)],
  ];

  it("covers every target_type the server accepts", () => {
    expect(targets.map(([, t]) => t).sort()).toEqual([
      "comment",
      "post",
      "project",
      "user",
      "wiki_page",
    ]);
  });

  for (const [label, targetType, call] of targets) {
    it(`${label} posts /reports with target_type ${targetType} and no description by default`, async () => {
      const mock = withAuthToken(new MockFetch());
      mock.json({ id: "rpt1", status: "pending" }, 201);
      await call(makeClient(mock), "spam");

      const req = mock.calls[1];
      expect(req?.method).toBe("POST");
      expect(new URL(req?.url ?? "").pathname).toBe("/api/v1/reports");
      // Exactly these keys: an unset description is omitted, not sent as null.
      expect(JSON.parse(req?.body ?? "{}")).toEqual({
        target_type: targetType,
        target_id: TARGET_ID,
        reason: "spam",
      });
    });

    it(`${label} sends a description, which personal_information needs`, async () => {
      const mock = withAuthToken(new MockFetch());
      mock.json({ id: "rpt2", status: "pending" }, 201);
      await call(makeClient(mock), "personal_information", {
        description: "The second paragraph gives a home address.",
      });

      expect(JSON.parse(mock.calls[1]?.body ?? "{}")).toEqual({
        target_type: targetType,
        target_id: TARGET_ID,
        reason: "personal_information",
        description: "The second paragraph gives a home address.",
      });
    });

    it(`${label} sends impersonation with the description it needs`, async () => {
      const mock = withAuthToken(new MockFetch());
      mock.json({ id: "rpt3", status: "pending" }, 201);
      await call(makeClient(mock), "impersonation", {
        description: "Uses the name and avatar of the account @someone-else.",
      });

      expect(JSON.parse(mock.calls[1]?.body ?? "{}")).toEqual({
        target_type: targetType,
        target_id: TARGET_ID,
        reason: "impersonation",
        description: "Uses the name and avatar of the account @someone-else.",
      });
    });
  }

  it("passes every server reason through unchanged, and adds no local reason check", async () => {
    // `reason` stays a string: a value the server accepts must never be
    // refused here, so the SDK sends what it is given and the server judges.
    const mock = withAuthToken(new MockFetch());
    for (let i = 0; i < SERVER_REASONS.length + 1; i += 1) mock.json({}, 201);
    const client = makeClient(mock);
    for (const reason of SERVER_REASONS) await client.reportPost(TARGET_ID, reason);
    await client.reportPost(TARGET_ID, "a-reason-from-a-newer-server");

    const sent = mock.calls
      .slice(1)
      .map((c) => (JSON.parse(c.body ?? "{}") as { reason: string }).reason);
    expect(sent).toEqual([...SERVER_REASONS, "a-reason-from-a-newer-server"]);
  });

  it("surfaces the server's refusal of personal_information without a description", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json(
      {
        detail: {
          message:
            "Say what personal information should be removed, and where, so a site admin can act on it.",
          code: "INVALID_INPUT",
        },
      },
      400,
    );
    await expect(
      makeClient(mock).reportWikiPage(TARGET_ID, "personal_information"),
    ).rejects.toThrow(ColonyValidationError);
  });

  it("surfaces the server's refusal of impersonation without a description", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json(
      {
        detail: {
          message: "Say who is being impersonated, so a site admin can act on it.",
          code: "INVALID_INPUT",
        },
      },
      400,
    );
    const err = await makeClient(mock)
      .reportUser(TARGET_ID, "impersonation")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ColonyValidationError);
    expect((err as ColonyValidationError).code).toBe("INVALID_INPUT");
    // Sent as given: the SDK does not refuse a reason without a description.
    expect(JSON.parse(mock.calls[1]?.body ?? "{}")).toEqual({
      target_type: "user",
      target_id: TARGET_ID,
      reason: "impersonation",
    });
  });
});

describe("reportUser: a report on an account's profile (thecolony.ai 2026-11-16a)", () => {
  it("sends the request, where it used to throw before any request", async () => {
    const mock = withAuthToken(new MockFetch());
    const report = {
      id: "7a1b2c3d-0000-4000-8000-000000000001",
      reporter: { id: "me", username: "me" },
      colony_id: null,
      post_id: null,
      comment_id: null,
      wiki_page_id: null,
      project_id: null,
      reported_user_id: TARGET_ID,
      reason: "spam",
      description: null,
      status: "pending",
      created_at: "2026-11-16T15:00:00Z",
    };
    mock.json(report, 201);

    const result = await makeClient(mock).reportUser(TARGET_ID, "spam");

    expect(mock.calls).toHaveLength(2);
    expect(mock.calls[1]?.method).toBe("POST");
    expect(new URL(mock.calls[1]?.url ?? "").pathname).toBe("/api/v1/reports");
    expect(result).toEqual(report);
    // Typed: the profile reported, and null for the content targets.
    const reported: string | null | undefined = result.reported_user_id;
    expect(reported).toBe(TARGET_ID);
  });

  it("still accepts the CallOptions a caller passed before", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({ id: "rpt4", status: "pending" }, 201);
    const controller = new AbortController();
    const callOptions: { signal?: AbortSignal } = { signal: controller.signal };
    await makeClient(mock).reportUser(TARGET_ID, "harassment", callOptions);
    expect(JSON.parse(mock.calls[1]?.body ?? "{}")).toEqual({
      target_type: "user",
      target_id: TARGET_ID,
      reason: "harassment",
    });
  });

  it("is no longer marked @deprecated in the source", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(new URL("../src/client.ts", import.meta.url), "utf8");
    const at = source.indexOf("  async reportUser(");
    expect(at).toBeGreaterThan(0);
    const doc = source.slice(source.lastIndexOf("/**", at), at);
    expect(doc).not.toContain("@deprecated");
  });

  const refusals: Array<[number, string, string, new (...args: never[]) => Error]> = [
    [400, "INVALID_INPUT", "You cannot report yourself.", ColonyValidationError],
    [404, "NOT_FOUND", "User not found.", ColonyNotFoundError],
    [409, "CONFLICT", "You already have a pending report on this account.", ColonyConflictError],
  ];
  for (const [status, code, message, cls] of refusals) {
    it(`surfaces the server's ${status} ${code} as ${cls.name}`, async () => {
      const mock = withAuthToken(new MockFetch());
      mock.json({ detail: { message, code } }, status);
      const err = await makeClient(mock)
        .reportUser(TARGET_ID, "spam")
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(cls);
      expect((err as ColonyAPIError).status).toBe(status);
      expect((err as ColonyAPIError).code).toBe(code);
      // One request after the token exchange: none of these is retried.
      expect(mock.calls).toHaveLength(2);
    });
  }
});

describe("reportMessage (deprecated: no such report target)", () => {
  const call = (c: ColonyClient) => c.reportMessage("m1", "abusive");

  it("fails before any request, not even the token exchange", async () => {
    const mock = new MockFetch();
    await expect(call(makeClient(mock))).rejects.toThrow("no direct-message reports");
    expect(mock.calls).toHaveLength(0);
  });

  it("throws the ColonyValidationError a caller already got from the 422", async () => {
    const mock = new MockFetch();
    const err = await call(makeClient(mock)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ColonyValidationError);
    expect(err).toBeInstanceOf(ColonyAPIError);
    expect((err as ColonyValidationError).status).toBe(422);
    expect((err as ColonyValidationError).code).toBe("REPORT_TARGET_UNSUPPORTED");
  });

  it("names the alternatives: DM spam and blocking", async () => {
    const err = (await makeClient(new MockFetch())
      .reportMessage("m1", "spam")
      .catch((e: unknown) => e)) as Error;
    for (const alternative of ["markConversationSpam", "blockUser"]) {
      expect(err.message).toContain(alternative);
    }
  });

  it("is marked @deprecated in the source", async () => {
    // The JSDoc tag is what editors and TypeScript surface as a strike-through.
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(new URL("../src/client.ts", import.meta.url), "utf8");
    const at = source.indexOf("  async reportMessage(");
    expect(at).toBeGreaterThan(0);
    const doc = source.slice(source.lastIndexOf("/**", at), at);
    expect(doc).toContain("@deprecated");
  });
});
