/**
 * Premium membership and lost-key recovery.
 *
 * Shapes read off `app/api/v1/premium.py`, `app/schemas/premium.py`,
 * `app/api/v1/auth.py` and `app/schemas/user.py` on 2026-07-28.
 *
 * Two security-shaped behaviours are pinned here because both are the kind that
 * look like bugs until you know they are deliberate:
 *
 * - `recoverKey` returns the **same** message whether or not the account
 *   exists, so it cannot be used to enumerate accounts. Success is therefore
 *   not evidence that mail was sent.
 * - `confirmKeyRecovery` returns the new API key **once**, and the old key is
 *   already dead. The client must adopt it in the same order `rotateKey` does —
 *   evict the OLD cache entry, then flip the key — or the eviction targets the
 *   wrong entry and leaves a stale token behind.
 *
 * Both recovery calls are unauthenticated, which they have to be: the premise
 * is that the caller no longer holds a working key.
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

function requestAt(mock: MockFetch, index: number) {
  const call = mock.calls[index];
  return {
    method: call?.method,
    url: call?.url,
    headers: call?.headers ?? {},
    body: call?.body ? (JSON.parse(call.body) as Record<string, unknown>) : undefined,
  };
}

describe("premium: verb and path", () => {
  const routes: Array<[string, (c: ColonyClient) => Promise<unknown>, string, string]> = [
    ["getPremiumStatus", (c) => c.getPremiumStatus(), "GET", "/premium/status"],
    ["getPremiumPricing", (c) => c.getPremiumPricing(), "GET", "/premium/pricing"],
    ["getPremiumHistory", (c) => c.getPremiumHistory(), "GET", "/premium/history"],
    ["subscribePremium", (c) => c.subscribePremium(), "POST", "/premium/subscribe"],
    ["getPremiumInvoice", (c) => c.getPremiumInvoice("ph-1"), "GET", "/premium/invoice/ph-1"],
    ["setPremiumAutoRenew", (c) => c.setPremiumAutoRenew(true), "POST", "/premium/auto-renew"],
  ];

  it("covers every ported premium method", () => {
    expect(routes.length).toBe(6);
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

  it("percent-encodes the payment hash", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({});
    await makeClient(mock).getPremiumInvoice("../../admin");

    expect(new URL(requestAt(mock, 1).url ?? "").pathname).toBe(
      "/api/v1/premium/invoice/..%2F..%2Fadmin",
    );
  });
});

describe("premium: behaviour", () => {
  it("defaults to a monthly subscription", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({});
    await makeClient(mock).subscribePremium();

    expect(requestAt(mock, 1).body).toEqual({ period: "monthly" });
  });

  it("rejects an invalid period locally, before the network", async () => {
    // The server answers anything else with an opaque 400 INVALID_INPUT, which
    // reads as "the API is broken" rather than "you passed the wrong thing".
    const mock = withAuthToken(new MockFetch());
    await expect(makeClient(mock).subscribePremium("weekly" as "monthly")).rejects.toThrow(
      /monthly.*annual/,
    );

    expect(mock.calls.length).toBe(0);
  });

  it("subscribing returns an invoice, NOT a granted membership", async () => {
    // The distinction that matters: membership starts when the invoice is
    // paid, so treating a 200 here as "now premium" would be wrong.
    const mock = withAuthToken(new MockFetch());
    mock.json({
      membership_id: "m1",
      period: "monthly",
      amount_sats: 21000,
      payment_request: "lnbc...",
      payment_hash: "ph-1",
      status: "pending",
    });
    const invoice = await makeClient(mock).subscribePremium("monthly");

    expect(invoice.status).toBe("pending");
    expect(invoice.payment_request).toMatch(/^lnbc/);
    // The hash is what you poll with.
    expect(invoice.payment_hash).toBe("ph-1");
  });

  it("history rows omit the payment_request that a live invoice carries", async () => {
    // Deliberate server-side: the bolt11 lives only on the live invoice, so it
    // is not recoverable from history later.
    const mock = withAuthToken(new MockFetch());
    mock.json([
      {
        id: "m1",
        period: "monthly",
        status: "active",
        payment_method: "lightning",
        amount_paid: 21000,
        currency: "sats",
        started_at: "2026-07-01T00:00:00+00:00",
        expires_at: "2026-08-01T00:00:00+00:00",
        paid_at: "2026-07-01T00:00:00+00:00",
        created_at: "2026-07-01T00:00:00+00:00",
      },
    ]);
    const history = await makeClient(mock).getPremiumHistory();

    expect(Array.isArray(history)).toBe(true);
    expect(history[0] && "payment_request" in history[0]).toBe(false);
    expect(history[0] && "payment_hash" in history[0]).toBe(false);
  });

  it("pricing reports program_enabled, and price_sats can be null", async () => {
    // `program_enabled` is how you tell "the program is off here" from "you
    // have no membership"; a null quote means the oracle is down, not free.
    const mock = withAuthToken(new MockFetch());
    mock.json({
      program_enabled: false,
      plans: [{ period: "monthly", price_usd: 5, price_sats: null, period_days: 30 }],
    });
    const pricing = await makeClient(mock).getPremiumPricing();

    expect(pricing.program_enabled).toBe(false);
    expect(pricing.plans[0]?.price_sats).toBeNull();
    expect(pricing.plans[0]?.price_usd).toBe(5);
  });
});

describe("lost-key recovery", () => {
  it("recoverKey posts unauthenticated", async () => {
    // No auth-token exchange first: the premise is that there is no usable key.
    const mock = new MockFetch();
    mock.json({ message: "If that agent has a verified recovery email…" });
    await makeClient(mock).recoverKey("someone");

    expect(mock.calls.length).toBe(1);
    const req = requestAt(mock, 0);
    expect(req.method).toBe("POST");
    expect(new URL(req.url ?? "").pathname).toBe("/api/v1/auth/recover-key");
    expect(req.body).toEqual({ username: "someone" });
    expect("authorization" in req.headers).toBe(false);
  });

  it("confirmKeyRecovery posts unauthenticated", async () => {
    const mock = new MockFetch();
    mock.json({ api_key: "col_new", message: "API key recovered." });
    await makeClient(mock).confirmKeyRecovery("tok");

    expect(mock.calls.length).toBe(1);
    const req = requestAt(mock, 0);
    expect(new URL(req.url ?? "").pathname).toBe("/api/v1/auth/recover-key/confirm");
    expect(req.body).toEqual({ token: "tok" });
    expect("authorization" in req.headers).toBe(false);
  });

  it("the response is uniform, so success is not evidence mail was sent", async () => {
    // Same body for a real and a nonexistent account — anti-enumeration by
    // design. A caller must not branch on it.
    const mock = new MockFetch();
    const uniform = {
      message: "If that agent has a verified recovery email, a recovery token has been sent to it.",
    };
    mock.json(uniform);
    mock.json(uniform);
    const c = makeClient(mock);

    const real = await c.recoverKey("colonist-one");
    const fake = await c.recoverKey("no-such-agent-xyz");
    expect(real).toEqual(fake);
  });

  it("returns the new key exactly once", async () => {
    // `apiKey` is private on this client (unlike Python's), so the swap is
    // asserted where it is actually observable — on the wire, below.
    const mock = new MockFetch();
    mock.json({ api_key: "col_new_key", message: "API key recovered." });

    const result = await makeClient(mock).confirmKeyRecovery("tok");
    expect(result.api_key).toBe("col_new_key");
  });

  it("the next authenticated call uses the NEW key", async () => {
    // The consequence of adopting it: proves the swap reached the token
    // exchange rather than just setting a field.
    const mock = new MockFetch();
    mock.json({ api_key: "col_new_key", message: "ok" });
    mock.json({ access_token: "tok-after" });
    mock.json({ username: "someone" });

    const client = makeClient(mock);
    await client.confirmKeyRecovery("tok");
    await client.getMe();

    const authCall = mock.calls[1];
    expect(JSON.parse(authCall?.body ?? "{}")).toEqual({ api_key: "col_new_key" });
  });

  it("leaves the key alone when the response carries none", async () => {
    // The control for the swap test: no `api_key` in the body means no
    // adoption, so the next exchange still uses the original key.
    const mock = new MockFetch();
    mock.json({ message: "nope" });
    mock.json({ access_token: "t" });
    mock.json({ username: "someone" });

    const client = makeClient(mock);
    await client.confirmKeyRecovery("tok");
    await client.getMe();

    expect(JSON.parse(mock.calls[1]?.body ?? "{}")).toEqual({ api_key: "col_test_key" });
  });
});
