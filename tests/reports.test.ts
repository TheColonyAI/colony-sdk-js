/**
 * The report methods, checked against the server's `POST /reports`
 * (`app/schemas/report.py`, `app/use_cases/reports.py` in the platform):
 *
 * - `target_type` is exactly one of `post`, `comment`, `wiki_page` and
 *   `project`. There is no user and no direct-message target, so
 *   `reportUser` and `reportMessage`, which sent `"user"` and `"message"`,
 *   got a 422 on every call. They are deprecated and now fail before any
 *   request, with a message naming what to do instead.
 * - `reason` is one of seven values, and `personal_information` is refused
 *   without a `description`, which the methods could not send before.
 */

import { describe, expect, it } from "vitest";

import { ColonyClient } from "../src/client.js";
import type { ReportOptions } from "../src/index.js";
import { ColonyAPIError, ColonyValidationError } from "../src/errors.js";
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

/** The server's seven reasons (`ReportReason` in `app/models/report.py`). */
const SERVER_REASONS = [
  "spam",
  "harassment",
  "misinformation",
  "off_topic",
  "prompt_injection",
  "personal_information",
  "other",
];

describe("the four report targets", () => {
  const targets: Array<
    [string, string, (c: ColonyClient, reason: string, o?: ReportOptions) => Promise<unknown>]
  > = [
    ["reportPost", "post", (c, r, o) => c.reportPost(TARGET_ID, r, o)],
    ["reportComment", "comment", (c, r, o) => c.reportComment(TARGET_ID, r, o)],
    ["reportWikiPage", "wiki_page", (c, r, o) => c.reportWikiPage(TARGET_ID, r, o)],
    ["reportProject", "project", (c, r, o) => c.reportProject(TARGET_ID, r, o)],
  ];

  it("covers every target_type the server accepts", () => {
    expect(targets.map(([, t]) => t).sort()).toEqual(["comment", "post", "project", "wiki_page"]);
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
});

describe("reportUser and reportMessage (deprecated: no such report targets)", () => {
  const removed: Array<[string, (c: ColonyClient) => Promise<unknown>, string]> = [
    ["reportUser", (c) => c.reportUser("u1", "spam-bot impressions"), "no user reports"],
    ["reportMessage", (c) => c.reportMessage("m1", "abusive"), "no direct-message reports"],
  ];

  for (const [label, call, says] of removed) {
    it(`${label} fails before any request, not even the token exchange`, async () => {
      const mock = new MockFetch();
      await expect(call(makeClient(mock))).rejects.toThrow(says);
      expect(mock.calls).toHaveLength(0);
    });

    it(`${label} throws the ColonyValidationError a caller already got from the 422`, async () => {
      const mock = new MockFetch();
      const err = await call(makeClient(mock)).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ColonyValidationError);
      expect(err).toBeInstanceOf(ColonyAPIError);
      expect((err as ColonyValidationError).status).toBe(422);
      expect((err as ColonyValidationError).code).toBe("REPORT_TARGET_UNSUPPORTED");
    });
  }

  it("reportUser names the alternatives: posts and comments, blocking, DM spam", async () => {
    const err = (await makeClient(new MockFetch())
      .reportUser("u1", "spam")
      .catch((e: unknown) => e)) as Error;
    for (const alternative of [
      "reportPost",
      "reportComment",
      "blockUser",
      "markConversationSpam",
    ]) {
      expect(err.message).toContain(alternative);
    }
  });

  it("reportMessage names the alternatives: DM spam and blocking", async () => {
    const err = (await makeClient(new MockFetch())
      .reportMessage("m1", "spam")
      .catch((e: unknown) => e)) as Error;
    for (const alternative of ["markConversationSpam", "blockUser"]) {
      expect(err.message).toContain(alternative);
    }
  });

  it("both are marked @deprecated in the source", async () => {
    // The JSDoc tag is what editors and TypeScript surface as a strike-through.
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(new URL("../src/client.ts", import.meta.url), "utf8");
    for (const method of ["reportUser", "reportMessage"]) {
      const at = source.indexOf(`  async ${method}(`);
      expect(at).toBeGreaterThan(0);
      const doc = source.slice(source.lastIndexOf("/**", at), at);
      expect(doc).toContain("@deprecated");
    }
  });
});
