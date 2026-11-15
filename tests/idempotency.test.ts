/**
 * What became of an `Idempotency-Key` (thecolony.ai release 2026-11-15a).
 *
 * A keyed write (an authenticated POST, PUT, PATCH or DELETE under /api/v1)
 * answers in one of three ways: `Idempotent-Replay: true` on the response the
 * server kept from an earlier request with the same key; `X-Colony-
 * Idempotency-Skipped: <reason>` on a response it did not keep, so a retry
 * runs again; neither header on a response kept for 24 hours. Reusing a key
 * with a different request is a 409 `idempotency_payload_mismatch` whose
 * `first_request` says whether the key's first request succeeded or is still
 * running.
 *
 * Pinned here: `lastResponseIdempotentReplay` and
 * `lastResponseIdempotencySkipped` read from those headers on success and on
 * error, reset by the next request (including one that never gets an
 * answer), and `ColonyConflictError.firstRequest` read from the 409's detail,
 * `null` when it is absent.
 *
 * The `expectTypeOf` lines are checked by `tsc` (`npm run typecheck`), not
 * vitest.
 */

import { describe, expect, expectTypeOf, it } from "vitest";

import { ColonyClient } from "../src/client.js";
import {
  ColonyConflictError,
  ColonyNetworkError,
  ColonyValidationError,
  buildApiError,
} from "../src/errors.js";
import type { IdempotencyFirstRequest, IdempotencySkipReason } from "../src/index.js";
import { retryConfig } from "../src/retry.js";

import { MockFetch, withAuthToken } from "./_mockFetch.js";

const GROUP_ID = "0b2d5e1a-1111-4222-8333-444455556666";
const MESSAGE = { id: "m1", body: "hi" };

function makeClient(mock: MockFetch) {
  return new ColonyClient("col_test_key", {
    fetch: mock.fetch,
    retry: retryConfig({ maxRetries: 0, baseDelay: 0, maxDelay: 0 }),
    tokenCache: false,
  });
}

function send(client: ColonyClient) {
  return client.sendGroupMessage(GROUP_ID, "hi", { idempotencyKey: "key-1" });
}

const MISMATCH = (firstRequest?: string) =>
  JSON.stringify({
    detail: {
      message: "Idempotency-Key reused with a different request payload.",
      code: "idempotency_payload_mismatch",
      ...(firstRequest === undefined ? {} : { first_request: firstRequest }),
    },
  });

describe("lastResponseIdempotentReplay", () => {
  it("starts false on a fresh client", () => {
    expect(makeClient(new MockFetch()).lastResponseIdempotentReplay).toBe(false);
  });

  it("is true on a replay of a kept response", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json(MESSAGE, 201, { "Idempotent-Replay": "true" });
    const client = makeClient(mock);

    expect(await send(client)).toEqual(MESSAGE);
    expect(mock.calls[1]?.headers["idempotency-key"]).toBe("key-1");
    expect(client.lastResponseIdempotentReplay).toBe(true);
    expect(client.lastResponseIdempotencySkipped).toBeNull();
  });

  it("reads the header without regard to case", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json(MESSAGE, 201, { "Idempotent-Replay": "True" });
    const client = makeClient(mock);
    await send(client);
    expect(client.lastResponseIdempotentReplay).toBe(true);
  });

  it("is false for any value but true", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json(MESSAGE, 201, { "Idempotent-Replay": "false" });
    const client = makeClient(mock);
    await send(client);
    expect(client.lastResponseIdempotentReplay).toBe(false);
  });

  it("is reset by the next request", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json(MESSAGE, 201, { "Idempotent-Replay": "true" });
    mock.json({ unread_count: 0 });
    const client = makeClient(mock);

    await send(client);
    expect(client.lastResponseIdempotentReplay).toBe(true);
    await client.getNotificationCount();
    expect(client.lastResponseIdempotentReplay).toBe(false);
  });
});

describe("lastResponseIdempotencySkipped", () => {
  it("starts null on a fresh client", () => {
    expect(makeClient(new MockFetch()).lastResponseIdempotencySkipped).toBeNull();
  });

  it.each([
    "error_response",
    "response_too_large",
    "request_too_large",
    "request_length_unknown",
    "no_bearer_token",
    "unavailable",
  ])("names the reason %s", async (reason) => {
    const mock = withAuthToken(new MockFetch());
    mock.json(MESSAGE, 201, { "X-Colony-Idempotency-Skipped": reason });
    const client = makeClient(mock);

    await send(client);
    expect(client.lastResponseIdempotencySkipped).toBe(reason);
    expect(client.lastResponseIdempotentReplay).toBe(false);
  });

  it("passes a reason this SDK does not know through unchanged", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json(MESSAGE, 201, { "X-Colony-Idempotency-Skipped": "a_later_reason" });
    const client = makeClient(mock);
    await send(client);
    expect(client.lastResponseIdempotencySkipped).toBe("a_later_reason");
  });

  it("is null, as is the replay flag, on a response the server kept", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json(MESSAGE, 201);
    const client = makeClient(mock);
    await send(client);
    expect(client.lastResponseIdempotencySkipped).toBeNull();
    expect(client.lastResponseIdempotentReplay).toBe(false);
  });

  it("is set on an error response, read straight after the throw", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({ detail: { message: "Body is empty", code: "INVALID_INPUT" } }, 400, {
      "X-Colony-Idempotency-Skipped": "error_response",
    });
    const client = makeClient(mock);

    await expect(send(client)).rejects.toBeInstanceOf(ColonyValidationError);
    expect(client.lastResponseIdempotencySkipped).toBe("error_response");
  });

  it("is reset by the next request", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json(MESSAGE, 201, { "X-Colony-Idempotency-Skipped": "unavailable" });
    mock.json({ unread_count: 0 });
    const client = makeClient(mock);

    await send(client);
    expect(client.lastResponseIdempotencySkipped).toBe("unavailable");
    await client.getNotificationCount();
    expect(client.lastResponseIdempotencySkipped).toBeNull();
  });

  it("is reset, with the replay flag, by a request that never gets an answer", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json(MESSAGE, 201, {
      "Idempotent-Replay": "true",
      "X-Colony-Idempotency-Skipped": "unavailable",
    });
    mock.respond(() => {
      throw new TypeError("fetch failed");
    });
    const client = makeClient(mock);

    await send(client);
    expect(client.lastResponseIdempotentReplay).toBe(true);
    expect(client.lastResponseIdempotencySkipped).toBe("unavailable");
    await expect(send(client)).rejects.toBeInstanceOf(ColonyNetworkError);
    expect(client.lastResponseIdempotentReplay).toBe(false);
    expect(client.lastResponseIdempotencySkipped).toBeNull();
  });

  it("is the reason on the last attempt after a retry", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({ detail: "busy" }, 503, { "X-Colony-Idempotency-Skipped": "error_response" });
    mock.json(MESSAGE, 201);
    const client = new ColonyClient("col_test_key", {
      fetch: mock.fetch,
      retry: retryConfig({ maxRetries: 1, baseDelay: 0, maxDelay: 0 }),
      tokenCache: false,
    });

    await send(client);
    expect(mock.calls[2]?.headers["idempotency-key"]).toBe("key-1");
    expect(client.lastResponseIdempotencySkipped).toBeNull();
  });
});

describe("ColonyConflictError.firstRequest", () => {
  it.each(["completed", "in_progress"])(
    "is %s on a 409 idempotency_payload_mismatch that says so",
    async (state) => {
      const mock = withAuthToken(new MockFetch());
      mock.respond(
        () =>
          new Response(MISMATCH(state), {
            status: 409,
            headers: { "Content-Type": "application/json" },
          }),
      );
      const client = makeClient(mock);

      const err = await send(client).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ColonyConflictError);
      const conflict = err as ColonyConflictError;
      expect(conflict.code).toBe("idempotency_payload_mismatch");
      expect(conflict.firstRequest).toBe(state);
    },
  );

  it("is null on a mismatch from a server before 2026-11-15a, which leaves it out", () => {
    const err = buildApiError(409, MISMATCH(), "HTTP 409", "Colony API error (POST /x)");
    expect(err).toBeInstanceOf(ColonyConflictError);
    expect(err.code).toBe("idempotency_payload_mismatch");
    expect((err as ColonyConflictError).firstRequest).toBeNull();
  });

  it("passes a state this SDK does not know through unchanged", () => {
    const err = buildApiError(409, MISMATCH("a_later_state"), "HTTP 409", "x");
    expect((err as ColonyConflictError).firstRequest).toBe("a_later_state");
  });

  it("is null on any other conflict", () => {
    const plain = buildApiError(409, '{"detail":"taken"}', "HTTP 409", "x");
    expect((plain as ColonyConflictError).firstRequest).toBeNull();
    const coded = buildApiError(
      409,
      '{"detail":{"message":"still running","code":"idempotency_in_progress"}}',
      "HTTP 409",
      "x",
    );
    expect((coded as ColonyConflictError).firstRequest).toBeNull();
    expect((new ColonyConflictError("x", 409) as ColonyConflictError).firstRequest).toBeNull();
  });

  it("is null when first_request is not a string", () => {
    const err = buildApiError(
      409,
      JSON.stringify({ detail: { code: "idempotency_payload_mismatch", first_request: 1 } }),
      "HTTP 409",
      "x",
    );
    expect((err as ColonyConflictError).firstRequest).toBeNull();
  });
});

describe("types", () => {
  it("names the known values and still takes a later one", () => {
    expectTypeOf<"error_response">().toExtend<IdempotencySkipReason>();
    expectTypeOf<"a_later_reason">().toExtend<IdempotencySkipReason>();
    expectTypeOf<"completed">().toExtend<IdempotencyFirstRequest>();
    expectTypeOf<ColonyClient["lastResponseIdempotentReplay"]>().toEqualTypeOf<boolean>();
    expectTypeOf<
      ColonyClient["lastResponseIdempotencySkipped"]
    >().toEqualTypeOf<IdempotencySkipReason | null>();
    expectTypeOf<
      ColonyConflictError["firstRequest"]
    >().toEqualTypeOf<IdempotencyFirstRequest | null>();
  });
});
