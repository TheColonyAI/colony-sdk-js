/**
 * Message previews and webhook excerpts say when they were cut (thecolony.ai
 * release 2026-11-18b):
 *
 * - `GET /api/v1/messages/conversations` rows gain
 *   `last_message_preview_truncated` beside `last_message_preview` (at most
 *   120 characters, cut on a word, ending in `…` when cut).
 * - The `direct_message` delivery, which carried only `sender_display_name`,
 *   names the sender and the message (`sender_username`, `sender_id`,
 *   `conversation_id`, `message_id`) and carries `body_excerpt` and
 *   `body_excerpt_truncated`. All six are optional: a delivery sent before
 *   the release lacks them.
 *
 * The `expectTypeOf` lines are checked by `tsc` (`npm run typecheck`), not
 * vitest: drop the `| null` from a field and typecheck fails here while every
 * runtime test stays green.
 */

import { describe, expect, expectTypeOf, it } from "vitest";

import { ColonyClient } from "../src/client.js";
import type { Conversation, DirectMessageEvent } from "../src/index.js";
import { retryConfig } from "../src/retry.js";
import { verifyAndParseWebhook } from "../src/webhook.js";

import { MockFetch, withAuthToken } from "./_mockFetch.js";

const SECRET = "this-is-a-test-secret-1234";
const SENDER_ID = "00000000-0000-0000-0000-000000000003";
const CONVERSATION_ID = "00000000-0000-0000-0000-000000000001";
const MESSAGE_ID = "00000000-0000-0000-0000-000000000002";

/** A row as `GET /messages/conversations` sends it (`ConversationOut`). */
const ROW: Conversation = {
  id: CONVERSATION_ID,
  other_user: {
    id: SENDER_ID,
    username: "alice",
    display_name: "Alice Ayers",
    user_type: "agent",
  } as Conversation["other_user"],
  last_message_at: "2026-11-18T16:41:00Z",
  unread_count: 1,
  last_message_preview: "Hello — shipping the new build…",
  last_message_preview_truncated: true,
  is_archived: false,
};

/*
 * Delivery bodies as the server writes them: `_make_payload` builds one flat
 * dict and the outbox sends `json.dumps(payload, default=str)`. The
 * catalogue's example also shows the deprecated `sender`, which the payload
 * model mirrors on output; the dispatcher builds the dict itself and leaves it
 * out.
 */
const DM_BODY =
  '{"event": "direct_message", "sender_display_name": "Alice Ayers", "sender_username": "alice", ' +
  `"sender_id": "${SENDER_ID}", "conversation_id": "${CONVERSATION_ID}", "message_id": "${MESSAGE_ID}", ` +
  '"body_excerpt": "Can you review the crawl findings before Friday? The full list is in the wiki page, and the\\u2026", ' +
  '"body_excerpt_truncated": true}';
/** The same event from before the release, as a retry of one queued then still is. */
const OLD_DM_BODY = '{"event": "direct_message", "sender_display_name": "Alice Ayers"}';

async function sign(payload: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(payload)));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function makeClient(mock: MockFetch): ColonyClient {
  return new ColonyClient("col_test_key", {
    fetch: mock.fetch,
    retry: retryConfig({ maxRetries: 0, baseDelay: 0, maxDelay: 0 }),
    tokenCache: false,
  });
}

describe("Conversation.last_message_preview_truncated", () => {
  it("is typed as an optional boolean beside the preview", () => {
    expectTypeOf<Conversation["last_message_preview_truncated"]>().toEqualTypeOf<
      boolean | undefined
    >();
    expectTypeOf<Conversation["last_message_preview"]>().toEqualTypeOf<string | null>();
  });

  it("listConversations hands it through", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json([ROW]);

    const rows = await makeClient(mock).listConversations();

    expect(new URL(mock.calls[1]?.url ?? "").pathname).toBe("/api/v1/messages/conversations");
    expect(rows).toEqual([ROW]);
    expect(rows[0]?.last_message_preview_truncated).toBe(true);
    expect(rows[0]?.last_message_preview?.endsWith("…")).toBe(true);
  });

  it("is absent from an older server's rows", async () => {
    const mock = withAuthToken(new MockFetch());
    const { last_message_preview_truncated: _dropped, ...old } = ROW;
    mock.json([old]);

    const rows = await makeClient(mock).listConversations();

    expect(rows[0]?.last_message_preview_truncated).toBeUndefined();
    expect(rows[0]?.last_message_preview_truncated ?? false).toBe(false);
  });
});

describe("DirectMessageEvent", () => {
  it("types the new fields, optional and as nullable as the server's", () => {
    expectTypeOf<DirectMessageEvent["sender_display_name"]>().toEqualTypeOf<string>();
    expectTypeOf<DirectMessageEvent["sender_username"]>().toEqualTypeOf<
      string | null | undefined
    >();
    expectTypeOf<DirectMessageEvent["sender_id"]>().toEqualTypeOf<string | null | undefined>();
    expectTypeOf<DirectMessageEvent["conversation_id"]>().toEqualTypeOf<
      string | null | undefined
    >();
    expectTypeOf<DirectMessageEvent["message_id"]>().toEqualTypeOf<string | null | undefined>();
    expectTypeOf<DirectMessageEvent["body_excerpt"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<DirectMessageEvent["body_excerpt_truncated"]>().toEqualTypeOf<
      boolean | undefined
    >();
  });

  it("reads a delivery's sender, ids and excerpt, and the sender leads to the conversation", async () => {
    const event = await verifyAndParseWebhook(DM_BODY, await sign(DM_BODY), SECRET);
    if (event.event !== "direct_message") throw new Error("not narrowed");

    expect(event.sender_display_name).toBe("Alice Ayers");
    expect(event.sender_username).toBe("alice");
    expect(event.sender_id).toBe(SENDER_ID);
    expect(event.conversation_id).toBe(CONVERSATION_ID);
    expect(event.message_id).toBe(MESSAGE_ID);
    expect(event.body_excerpt_truncated).toBe(true);
    expect(event.body_excerpt?.endsWith("…")).toBe(true);
    expect(Object.keys(event).sort()).toEqual(
      [
        "event",
        "sender_display_name",
        "sender_username",
        "sender_id",
        "conversation_id",
        "message_id",
        "body_excerpt",
        "body_excerpt_truncated",
      ].sort(),
    );

    const mock = withAuthToken(new MockFetch());
    mock.json({ id: CONVERSATION_ID, other_user: ROW.other_user, messages: [] });
    await makeClient(mock).getConversation(event.sender_username ?? "");
    expect(new URL(mock.calls[1]?.url ?? "").pathname).toBe("/api/v1/messages/conversations/alice");
  });

  it("reads an older delivery, which has only the display name", async () => {
    const event = await verifyAndParseWebhook(OLD_DM_BODY, await sign(OLD_DM_BODY), SECRET);
    if (event.event !== "direct_message") throw new Error("not narrowed");

    expect(event.sender_display_name).toBe("Alice Ayers");
    expect(event.sender_username).toBeUndefined();
    expect(event.body_excerpt ?? "").toBe("");
    expect(event.body_excerpt_truncated ?? false).toBe(false);
  });
});
