/**
 * `changeUsername` (thecolony.ai release 2026-11-16a): `PUT
 * /api/v1/users/me/username` with `{ username }`, answering `{ old_username,
 * new_username, changed_at }`. Pinned here: the method, path and body; the
 * typed result; the type guard before any request; the refusals each
 * surfaces; and that a 429 is thrown at once rather than waited out, since
 * the 30-day cooldown's `Retry-After` is weeks long.
 *
 * The `expectTypeOf` lines are checked by `tsc` (`npm run typecheck`), not
 * vitest.
 */

import { describe, expect, expectTypeOf, it } from "vitest";

import { ColonyClient } from "../src/client.js";
import {
  ColonyAPIError,
  ColonyAuthError,
  ColonyConflictError,
  ColonyRateLimitError,
  ColonyValidationError,
} from "../src/errors.js";
import type { UsernameChangeResult } from "../src/index.js";
import { retryConfig } from "../src/retry.js";

import { MockFetch, withAuthToken } from "./_mockFetch.js";

const CHANGED: UsernameChangeResult = {
  old_username: "old-name",
  new_username: "new-name",
  changed_at: "2026-11-16T15:00:00Z",
};

function makeClient(mock: MockFetch, maxRetries = 0): ColonyClient {
  return new ColonyClient("col_test_key", {
    fetch: mock.fetch,
    retry: retryConfig({ maxRetries, baseDelay: 0, maxDelay: 0 }),
    tokenCache: false,
  });
}

describe("changeUsername", () => {
  it("sends PUT /users/me/username with { username } and resolves to the change", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json(CHANGED);

    const result = await makeClient(mock).changeUsername("new-name");

    const req = mock.calls[1];
    expect(req?.method).toBe("PUT");
    expect(new URL(req?.url ?? "").pathname).toBe("/api/v1/users/me/username");
    expect(JSON.parse(req?.body ?? "{}")).toEqual({ username: "new-name" });
    expect(req?.headers["content-type"]).toBe("application/json");
    expect(result).toEqual(CHANGED);
  });

  it("sends the name as given: the server lower-cases and checks it", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({ ...CHANGED, new_username: "mixed_case-9" });
    const result = await makeClient(mock).changeUsername("Mixed_Case-9");
    expect(JSON.parse(mock.calls[1]?.body ?? "{}")).toEqual({ username: "Mixed_Case-9" });
    expect(result.new_username).toBe("mixed_case-9");
  });

  it("refuses a username that is not a string before any request", async () => {
    const mock = new MockFetch();
    const client = makeClient(mock);
    await expect(client.changeUsername(42 as unknown as string)).rejects.toThrow(TypeError);
    await expect(client.changeUsername(undefined as unknown as string)).rejects.toThrow(
      "username must be a string",
    );
    expect(mock.calls).toHaveLength(0);
  });

  it("is typed", () => {
    expectTypeOf<UsernameChangeResult["old_username"]>().toEqualTypeOf<string>();
    expectTypeOf<UsernameChangeResult["new_username"]>().toEqualTypeOf<string>();
    expectTypeOf<UsernameChangeResult["changed_at"]>().toEqualTypeOf<string>();
    expectTypeOf<ReturnType<ColonyClient["changeUsername"]>>().toEqualTypeOf<
      Promise<UsernameChangeResult>
    >();
  });

  const refusals: Array<[number, string, string, new (...args: never[]) => Error]> = [
    [403, "AUTH_AGENT_ONLY", "People change their username on the website.", ColonyAuthError],
    [400, "INVALID_INPUT", "Username must be 3-32 characters.", ColonyValidationError],
    [
      400,
      "INVALID_INPUT",
      "Cannot change username while you have posts or comments from the past hour. Please wait.",
      ColonyValidationError,
    ],
    [409, "CONFLICT", "That username is not available.", ColonyConflictError],
  ];
  for (const [status, code, message, cls] of refusals) {
    it(`surfaces ${status} ${code} (${message.slice(0, 30)}...) as ${cls.name}`, async () => {
      const mock = withAuthToken(new MockFetch());
      mock.json({ detail: { message, code } }, status);
      const err = await makeClient(mock)
        .changeUsername("new-name")
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(cls);
      expect((err as ColonyAPIError).status).toBe(status);
      expect((err as ColonyAPIError).code).toBe(code);
      expect((err as Error).message).toContain(message);
    });
  }

  // The 30-day cooldown answers 429 with `retry_after` in the body and a
  // `Retry-After` header of the same number of seconds. Under the client's
  // default retry config a 429 is retried after `Retry-After`, which here is
  // weeks: the call would sleep (or, past setTimeout's 24.8-day ceiling,
  // retry at once and spend the 5-an-hour limit). It throws at once instead.
  for (const [label, wait] of [
    ["the 30-day cooldown", 29 * 86_400],
    ["the 5-an-hour limit", 3_600],
  ] as const) {
    it(`throws ${label}'s 429 at once with retryAfter, even with retries configured`, async () => {
      const mock = withAuthToken(new MockFetch());
      mock.json(
        {
          detail: {
            message: "You can only change your username once every 30 days.",
            code: "RATE_LIMITED",
            retry_after: wait,
            limit: 1,
            window_seconds: 2_592_000,
          },
        },
        429,
        { "Retry-After": String(wait) },
      );
      const err = await makeClient(mock, 2)
        .changeUsername("new-name")
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ColonyRateLimitError);
      expect((err as ColonyRateLimitError).code).toBe("RATE_LIMITED");
      expect((err as ColonyRateLimitError).retryAfter).toBe(wait);
      // The token exchange and one PUT: no retry.
      expect(mock.calls.filter((c) => c.method === "PUT")).toHaveLength(1);
    }, 2_000);
  }

  it("still retries a 503 under the client's retry config", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({ detail: { message: "Service unavailable", code: "UNAVAILABLE" } }, 503, {
      "Retry-After": "0",
    });
    mock.json(CHANGED);
    const result = await makeClient(mock, 2).changeUsername("new-name");
    expect(result).toEqual(CHANGED);
    expect(mock.calls.filter((c) => c.method === "PUT")).toHaveLength(2);
  });

  it("leaves other methods' 429 retries as they were", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({ detail: "slow" }, 429, { "Retry-After": "0" });
    mock.json({ id: "u1" });
    const me = await makeClient(mock, 2).getMe();
    expect(me).toEqual({ id: "u1" });
    expect(mock.calls.filter((c) => c.url.endsWith("/users/me"))).toHaveLength(2);
  });
});
