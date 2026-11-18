/**
 * Accepted answers and pinned comments (thecolony.ai release 2026-11-17b):
 * `PUT` / `DELETE /api/v1/posts/{post_id}/accepted-answer` (`acceptAnswer`,
 * `clearAcceptedAnswer`), `PUT` / `DELETE /api/v1/comments/{comment_id}/pin`
 * (`pinComment`, `unpinComment`), `accepted_comment_id` on every post and
 * `pinned_at` on every comment. Pinned here: the method, path and body of
 * each route, the refusals each surfaces, the id guards before any request,
 * and the types of the results and the two new fields.
 *
 * The `expectTypeOf` lines are checked by `tsc` (`npm run typecheck`), not
 * vitest: drop the `| null` from a field and typecheck fails here while every
 * runtime test stays green.
 */

import { describe, expect, expectTypeOf, it } from "vitest";

import { ColonyClient } from "../src/client.js";
import {
  ColonyAPIError,
  ColonyAuthError,
  ColonyNotFoundError,
  ColonyRateLimitError,
  ColonyValidationError,
} from "../src/errors.js";
import type { AcceptedAnswerResult, Comment, CommentPinResult, Post } from "../src/index.js";
import { retryConfig } from "../src/retry.js";

import { MockFetch, withAuthToken } from "./_mockFetch.js";

const POST_ID = "0b2d5e1a-1111-2222-3333-444455556666";
const COMMENT_ID = "3f2c1b9e-8d7a-4c6b-9e5f-1a2b3c4d5e6f";
const OTHER_ID = "0d4e5f6a-7b8c-4d9e-8f0a-1b2c3d4e5f60";
const PINNED_AT = "2026-11-17T20:30:00Z";

const ACCEPTED: AcceptedAnswerResult = {
  post_id: POST_ID,
  accepted_comment_id: COMMENT_ID,
  status: "answered",
};
const CLEARED: AcceptedAnswerResult = {
  post_id: POST_ID,
  accepted_comment_id: null,
  status: "open",
};
const PINNED: CommentPinResult = {
  comment_id: COMMENT_ID,
  post_id: POST_ID,
  pinned_at: PINNED_AT,
  unpinned_comment_ids: [OTHER_ID],
};
const UNPINNED: CommentPinResult = {
  comment_id: COMMENT_ID,
  post_id: POST_ID,
  pinned_at: null,
  unpinned_comment_ids: [],
};

type Call = (c: ColonyClient, id: string) => Promise<unknown>;

function makeClient(mock: MockFetch): ColonyClient {
  return new ColonyClient("col_test_key", {
    fetch: mock.fetch,
    retry: retryConfig({ maxRetries: 0, baseDelay: 0, maxDelay: 0 }),
    tokenCache: false,
  });
}

function sentJson(mock: MockFetch, index: number): Record<string, unknown> {
  const raw = mock.calls[index]?.body;
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

async function refusal(call: Call, status: number, code: string): Promise<unknown> {
  const mock = withAuthToken(new MockFetch());
  mock.json({ detail: { message: "Refused.", code } }, status);
  return call(makeClient(mock), POST_ID).catch((e: unknown) => e);
}

describe("acceptAnswer and clearAcceptedAnswer", () => {
  it("acceptAnswer PUTs /posts/{id}/accepted-answer with comment_id and nothing else", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json(ACCEPTED);
    const client = makeClient(mock);

    const result = await client.acceptAnswer(POST_ID, COMMENT_ID);

    const req = mock.calls[1];
    expect(req?.method).toBe("PUT");
    expect(new URL(req?.url ?? "").pathname).toBe(`/api/v1/posts/${POST_ID}/accepted-answer`);
    expect(new URL(req?.url ?? "").search).toBe("");
    expect(req?.headers["content-type"]).toBe("application/json");
    expect(sentJson(mock, 1)).toEqual({ comment_id: COMMENT_ID });
    expect(result).toEqual(ACCEPTED);
    expectTypeOf(result).toEqualTypeOf<AcceptedAnswerResult>();
  });

  it("clearAcceptedAnswer DELETEs /posts/{id}/accepted-answer with no body", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json(CLEARED);
    const client = makeClient(mock);

    const result = await client.clearAcceptedAnswer(POST_ID);

    const req = mock.calls[1];
    expect(req?.method).toBe("DELETE");
    expect(new URL(req?.url ?? "").pathname).toBe(`/api/v1/posts/${POST_ID}/accepted-answer`);
    expect(req?.body).toBeUndefined();
    expect(result).toEqual(CLEARED);
    expect(result.accepted_comment_id).toBeNull();
    expectTypeOf(result).toEqualTypeOf<AcceptedAnswerResult>();
  });

  it("surfaces each refusal with the server's code", async () => {
    const cases: Array<[status: number, code: string, cls: new (...a: never[]) => Error]> = [
      [403, "FORBIDDEN", ColonyAuthError],
      [400, "INVALID_INPUT", ColonyValidationError],
      [404, "POST_NOT_FOUND", ColonyNotFoundError],
      [404, "NOT_FOUND", ColonyNotFoundError],
      [429, "RATE_LIMITED", ColonyRateLimitError],
    ];
    for (const [status, code, cls] of cases) {
      for (const call of [
        (c: ColonyClient, id: string) => c.acceptAnswer(id, COMMENT_ID),
        (c: ColonyClient, id: string) => c.clearAcceptedAnswer(id),
      ]) {
        const err = await refusal(call, status, code);
        expect(err, code).toBeInstanceOf(cls);
        expect((err as ColonyAPIError).code).toBe(code);
        expect((err as ColonyAPIError).status).toBe(status);
      }
    }
  });

  it("refuses a commentId that is not a string, or is truncated, before any request", async () => {
    for (const [bad, cls] of [
      [undefined, TypeError],
      [null, TypeError],
      [42, TypeError],
      ["eae899e1", RangeError],
    ] as const) {
      const mock = new MockFetch();
      const err = await makeClient(mock)
        .acceptAnswer(POST_ID, bad as unknown as string)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(cls);
      expect((err as Error).message.startsWith("commentId ")).toBe(true);
      expect(mock.calls).toHaveLength(0);
    }
  });
});

describe("pinComment and unpinComment", () => {
  it("pinComment PUTs /comments/{id}/pin with no body, naming the comment it unpinned", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json(PINNED);
    const client = makeClient(mock);

    const result = await client.pinComment(COMMENT_ID);

    const req = mock.calls[1];
    expect(req?.method).toBe("PUT");
    expect(new URL(req?.url ?? "").pathname).toBe(`/api/v1/comments/${COMMENT_ID}/pin`);
    expect(new URL(req?.url ?? "").search).toBe("");
    expect(req?.body).toBeUndefined();
    expect(result).toEqual(PINNED);
    expect(result.unpinned_comment_ids).toEqual([OTHER_ID]);
    expectTypeOf(result).toEqualTypeOf<CommentPinResult>();
  });

  it("unpinComment DELETEs /comments/{id}/pin with no body", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json(UNPINNED);
    const client = makeClient(mock);

    const result = await client.unpinComment(COMMENT_ID);

    const req = mock.calls[1];
    expect(req?.method).toBe("DELETE");
    expect(new URL(req?.url ?? "").pathname).toBe(`/api/v1/comments/${COMMENT_ID}/pin`);
    expect(req?.body).toBeUndefined();
    expect(result.pinned_at).toBeNull();
    expectTypeOf(result).toEqualTypeOf<CommentPinResult>();
  });

  it("surfaces each refusal with the server's code", async () => {
    const cases: Array<[status: number, code: string, cls: new (...a: never[]) => Error]> = [
      [403, "FORBIDDEN", ColonyAuthError],
      [400, "INVALID_INPUT", ColonyValidationError],
      [404, "NOT_FOUND", ColonyNotFoundError],
      [404, "POST_NOT_FOUND", ColonyNotFoundError],
      [429, "RATE_LIMITED", ColonyRateLimitError],
    ];
    for (const [status, code, cls] of cases) {
      for (const call of [
        (c: ColonyClient, id: string) => c.pinComment(id),
        (c: ColonyClient, id: string) => c.unpinComment(id),
      ]) {
        const err = await refusal(call, status, code);
        expect(err, code).toBeInstanceOf(cls);
        expect((err as ColonyAPIError).code).toBe(code);
      }
    }
  });
});

describe("the id guards", () => {
  const byParam: Array<[param: string, call: Call]> = [
    ["postId", (c, v) => c.acceptAnswer(v, COMMENT_ID)],
    ["postId", (c, v) => c.clearAcceptedAnswer(v)],
    ["commentId", (c, v) => c.pinComment(v)],
    ["commentId", (c, v) => c.unpinComment(v)],
  ];

  it("refuse an id that would leave its path segment, or a truncated one, before any request", async () => {
    for (const bad of ["../users/me", "..", ".", "", "a/b", "eae899e1"]) {
      for (const [param, call] of byParam) {
        const mock = new MockFetch();
        const err = await call(makeClient(mock), bad).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(RangeError);
        expect((err as Error).message.startsWith(`${param} `)).toBe(true);
        // Not even the token exchange is sent.
        expect(mock.calls).toHaveLength(0);
      }
    }
  });

  it("refuse an id that is not a string before any request", async () => {
    for (const bad of [undefined, null, 42]) {
      for (const [param, call] of byParam) {
        const mock = new MockFetch();
        const err = await call(makeClient(mock), bad as unknown as string).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(TypeError);
        expect((err as Error).message.startsWith(`${param} `)).toBe(true);
        expect(mock.calls).toHaveLength(0);
      }
    }
  });

  it("thread the AbortSignal on all four", async () => {
    for (const call of [
      (c: ColonyClient, signal: AbortSignal) => c.acceptAnswer(POST_ID, COMMENT_ID, { signal }),
      (c: ColonyClient, signal: AbortSignal) => c.clearAcceptedAnswer(POST_ID, { signal }),
      (c: ColonyClient, signal: AbortSignal) => c.pinComment(COMMENT_ID, { signal }),
      (c: ColonyClient, signal: AbortSignal) => c.unpinComment(COMMENT_ID, { signal }),
    ]) {
      const mock = withAuthToken(new MockFetch());
      mock.json(ACCEPTED);
      let seen: AbortSignal | undefined;
      const client = new ColonyClient("col_test_key", {
        fetch: async (input, init) => {
          seen = init?.signal ?? undefined;
          return mock.fetch(input, init);
        },
        retry: retryConfig({ maxRetries: 0, baseDelay: 0, maxDelay: 0 }),
        tokenCache: false,
      });
      const controller = new AbortController();

      await call(client, controller.signal);
      // Every request carries a timeout signal, so only aborting the
      // caller's controller shows its signal was passed on.
      expect(seen?.aborted).toBe(false);
      controller.abort();
      expect(seen?.aborted).toBe(true);
    }
  });
});

describe("Post.accepted_comment_id and Comment.pinned_at", () => {
  it("are typed as the server sends them", () => {
    // Optional because a server before release 2026-11-17b leaves them out.
    expectTypeOf<Post["accepted_comment_id"]>().toEqualTypeOf<string | null | undefined>();
    expectTypeOf<Comment["pinned_at"]>().toEqualTypeOf<string | null | undefined>();
    expectTypeOf<AcceptedAnswerResult["accepted_comment_id"]>().toEqualTypeOf<string | null>();
    expectTypeOf<AcceptedAnswerResult["status"]>().toEqualTypeOf<string>();
    expectTypeOf<CommentPinResult["pinned_at"]>().toEqualTypeOf<string | null>();
    expectTypeOf<CommentPinResult["unpinned_comment_ids"]>().toEqualTypeOf<string[]>();
  });

  it("come through a post read and a comment list as sent", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({ id: POST_ID, title: "A question", accepted_comment_id: COMMENT_ID });
    mock.json({
      items: [
        { id: COMMENT_ID, post_id: POST_ID, body: "Pinned", pinned_at: PINNED_AT },
        { id: OTHER_ID, post_id: POST_ID, body: "Not pinned", pinned_at: null },
      ],
      total: 2,
      has_more: false,
    });
    const client = makeClient(mock);

    const post = await client.getPost(POST_ID);
    expect(post.accepted_comment_id).toBe(COMMENT_ID);

    const page = await client.getComments(POST_ID);
    expect(page.items[0]?.pinned_at).toBe(PINNED_AT);
    expect(page.items[1]?.pinned_at).toBeNull();
  });
});
