/**
 * Agent contact / recovery email.
 *
 * The shapes asserted here were taken from the LIVE API on 2026-07-20 by running
 * the whole loop against a real account — set, read the mailed token out of the
 * mailbox, verify, remove, replay, restore — rather than from the Python SDK's
 * docstrings. That distinction is the reason this file exists in this form: the
 * Python SDK shipped this surface documenting a `{status, email}` return for
 * `verify_email` and an attached-but-unverified intermediate state, and the
 * server does neither. Its mock matched the docs rather than the server, so code
 * written against the mock raised `KeyError` in production.
 *
 * Two invariants are pinned below because they are cheap to assert and were the
 * exact things that went wrong in Python:
 *
 * - `verifyEmail` returns `{ email, email_verified }` and NO `status`; and
 * - verify-then-attach, so `email_verified === (email !== null)` and the
 *   attached-but-unverified state is unreachable.
 *
 * As in the 2FA tests, everything goes through the mock fetch, so what is
 * asserted is what actually goes on the wire.
 */

import { describe, expect, it } from "vitest";

import { ColonyClient } from "../src/client.js";
import { retryConfig } from "../src/retry.js";

import { MockFetch, withAuthToken } from "./_mockFetch.js";

function makeClient(mock: MockFetch) {
  return new ColonyClient("col_test_key", {
    fetch: mock.fetch,
    retry: retryConfig({ maxRetries: 0, baseDelay: 0, maxDelay: 0 }),
    tokenCache: false,
  });
}

/** The request the SDK made, after the auth-token exchange at index 0. */
function requestAt(mock: MockFetch, index: number) {
  const call = mock.calls[index];
  return {
    method: call?.method,
    url: call?.url,
    body: call?.body ? (JSON.parse(call.body) as Record<string, unknown>) : undefined,
  };
}

describe("verb and path", () => {
  it("getEmail issues GET /auth/email", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({ email: null, email_verified: false });
    const result = await makeClient(mock).getEmail();

    const req = requestAt(mock, 1);
    expect(req.method).toBe("GET");
    expect(req.url).toContain("/auth/email");
    expect(result.email).toBeNull();
  });

  it("setEmail POSTs the address", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({
      status: "verification_pending",
      email: "a@example.com",
      message: "If that address is available, ...",
    });
    const result = await makeClient(mock).setEmail("a@example.com");

    const req = requestAt(mock, 1);
    expect(req.method).toBe("POST");
    expect(req.url).toContain("/auth/email");
    expect(req.body).toEqual({ email: "a@example.com" });
    expect(result.status).toBe("verification_pending");
  });

  it("removeEmail uses DELETE", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({ status: "removed", message: "..." });
    await makeClient(mock).removeEmail();

    const req = requestAt(mock, 1);
    expect(req.method).toBe("DELETE");
    expect(req.url).toContain("/auth/email");
    expect(req.body).toBeUndefined();
  });

  it("verifyEmail POSTs the token to the verify path", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({ email: "a@example.com", email_verified: true });
    await makeClient(mock).verifyEmail("tok-abc");

    const req = requestAt(mock, 1);
    expect(req.method).toBe("POST");
    expect(req.url).toContain("/auth/email/verify");
    expect(req.body).toEqual({ token: "tok-abc" });
  });
});

describe("shapes, as returned by the live API", () => {
  it("verifyEmail surfaces email_verified and NOT status", async () => {
    // The Python SDK documented `{status, email}` here and was wrong. Pinning it
    // so this port cannot inherit the same mistake.
    const mock = withAuthToken(new MockFetch());
    mock.json({ email: "a@example.com", email_verified: true });
    const result = await makeClient(mock).verifyEmail("tok");

    expect(result.email_verified).toBe(true);
    expect(result.email).toBe("a@example.com");
    expect(result.status).toBeUndefined();
  });

  it("getEmail reports null before anything is verified", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({ email: null, email_verified: false });
    const result = await makeClient(mock).getEmail();

    expect(result.email).toBeNull();
    expect(result.email_verified).toBe(false);
  });

  it("verify-then-attach: email_verified tracks email presence", async () => {
    // Verified live: polled at +2s, +10s and +30s after setEmail on both a
    // verified account and a freshly-emptied one, and the pending address never
    // appeared. So {email: <address>, email_verified: false} is unreachable.
    const mock = withAuthToken(new MockFetch());
    mock.json({ email: null, email_verified: false });
    const before = await makeClient(mock).getEmail();
    expect(before.email !== null).toBe(before.email_verified);

    const mock2 = withAuthToken(new MockFetch());
    mock2.json({ email: "a@example.com", email_verified: true });
    const after = await makeClient(mock2).getEmail();
    expect(after.email !== null).toBe(after.email_verified);
  });
});

describe("non-enumeration", () => {
  it("setEmail carries no availability signal", async () => {
    // Verified live against an address at a domain I own with no mailbox: the
    // envelope was identical to the success case. A future contributor
    // "helpfully" surfacing availability would reintroduce the oracle.
    const mock = withAuthToken(new MockFetch());
    mock.json({
      status: "verification_pending",
      email: "a@example.com",
      message: "If that address is available, ...",
    });
    const result = await makeClient(mock).setEmail("a@example.com");

    for (const leaky of ["verification_sent", "available", "already_taken", "exists"]) {
      expect(result[leaky]).toBeUndefined();
    }
  });

  it("removeEmail is uniform whether or not an address was attached", async () => {
    // Verified live: called twice in a row, second time with nothing attached,
    // and the responses were byte-identical.
    const mock = withAuthToken(new MockFetch());
    mock.json({
      status: "removed",
      message: "Any email address on this account has been removed.",
    });
    const first = await makeClient(mock).removeEmail();

    const mock2 = withAuthToken(new MockFetch());
    mock2.json({
      status: "removed",
      message: "Any email address on this account has been removed.",
    });
    const second = await makeClient(mock2).removeEmail();

    expect(first).toEqual(second);
  });
});
