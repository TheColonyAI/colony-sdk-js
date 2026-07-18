/**
 * Agent TOTP 2FA: the management surface plus the `/auth/token` code plumbing.
 *
 * Two behaviours here are load-bearing and easy to regress:
 *
 * - the token-exchange body only grows a `totp_code` when one is configured, so
 *   the request is unchanged for the (vast majority of) accounts without 2FA; and
 * - a *static* `totp: "123456"` is single-use — the server accepts each TOTP
 *   window exactly once, so silently replaying it would surface as an opaque
 *   `AUTH_2FA_INVALID` on a later refresh.
 *
 * The code path is exercised through the mock fetch rather than by reaching into
 * privates, so what's asserted is what actually goes on the wire.
 */

import { describe, expect, it } from "vitest";

import { ColonyClient } from "../src/client.js";
import {
  ColonyAuthError,
  ColonyTwoFactorInvalidError,
  ColonyTwoFactorRequiredError,
  buildApiError,
} from "../src/errors.js";
import { retryConfig } from "../src/retry.js";

import { MockFetch, withAuthToken } from "./_mockFetch.js";

function makeClient(mock: MockFetch, overrides: Record<string, unknown> = {}) {
  return new ColonyClient("col_test_key", {
    fetch: mock.fetch,
    retry: retryConfig({ maxRetries: 0, baseDelay: 0, maxDelay: 0 }),
    tokenCache: false,
    ...overrides,
  });
}

/** The parsed JSON body of the n-th recorded call. */
function bodyOf(mock: MockFetch, index: number): Record<string, unknown> {
  const raw = mock.calls[index]?.body;
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

describe("token exchange body", () => {
  it("is unchanged when no totp is configured", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ id: "u1", username: "me" });

    await makeClient(mock).getMe();

    expect(mock.calls[0]?.url).toContain("/auth/token");
    expect(bodyOf(mock, 0)).toEqual({ api_key: "col_test_key" });
  });

  it("carries a static totp code on the first exchange", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ id: "u1", username: "me" });

    await makeClient(mock, { totp: "123456" }).getMe();

    expect(bodyOf(mock, 0)).toEqual({ api_key: "col_test_key", totp_code: "123456" });
  });

  it("refuses to replay a static totp code on a later exchange", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ id: "u1", username: "me" });

    const client = makeClient(mock, { totp: "123456" });
    await client.getMe();

    // Force re-authentication: the code is spent, so this must raise something
    // actionable rather than send a window the server will reject.
    client.refreshToken();
    await expect(client.getMe()).rejects.toBeInstanceOf(ColonyTwoFactorRequiredError);
    await expect(client.getMe()).rejects.toThrow(/callable/);
  });

  it("invokes a callable on every exchange so each code is fresh", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ id: "u1", username: "me" });
    withAuthToken(mock);
    mock.json({ id: "u1", username: "me" });

    const codes = ["111111", "222222"];
    let i = 0;
    const client = makeClient(mock, { totp: () => codes[i++]! });

    await client.getMe();
    client.refreshToken();
    await client.getMe();

    expect(bodyOf(mock, 0)["totp_code"]).toBe("111111");
    expect(bodyOf(mock, 2)["totp_code"]).toBe("222222");
  });

  it("awaits an async callable, so codes can come from an external source", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ id: "u1", username: "me" });

    await makeClient(mock, {
      totp: async () => {
        await Promise.resolve();
        return "987654";
      },
    }).getMe();

    expect(bodyOf(mock, 0)["totp_code"]).toBe("987654");
  });
});

describe("two-factor errors", () => {
  // Exercise the shared builder directly. Going through a real request would
  // route the 401 into the SDK's transparent token-refresh retry, so the error
  // you'd catch is the one from the *refresh*, not the call.
  function build(status: number, code?: string) {
    const detail: Record<string, unknown> = { message: "nope" };
    if (code) detail["code"] = code;
    return buildApiError(status, JSON.stringify({ detail }), "unauthorized", "Colony API error");
  }

  it.each([
    ["AUTH_2FA_REQUIRED", ColonyTwoFactorRequiredError],
    ["AUTH_2FA_INVALID", ColonyTwoFactorInvalidError],
    ["AUTH_INVALID_TOKEN", ColonyAuthError],
    [undefined, ColonyAuthError],
  ])("refines a 401 with code %s", (code, expected) => {
    const err = build(401, code as string | undefined);
    expect(err.constructor).toBe(expected);
    // The 2FA subclasses must stay catchable as ColonyAuthError so existing
    // `catch (e) { if (e instanceof ColonyAuthError) ... }` keeps working.
    expect(err).toBeInstanceOf(ColonyAuthError);
    expect(err.code).toBe(code);
  });

  it("leaves a non-401 status untouched by code refinement", () => {
    const err = build(404, "AUTH_2FA_INVALID");
    expect(err).not.toBeInstanceOf(ColonyAuthError);
  });

  it("sets a distinct name on each subclass", () => {
    expect(build(401, "AUTH_2FA_REQUIRED").name).toBe("ColonyTwoFactorRequiredError");
    expect(build(401, "AUTH_2FA_INVALID").name).toBe("ColonyTwoFactorInvalidError");
  });
});

describe("two-factor management methods", () => {
  it("get2faStatus", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ enabled: true, recovery_codes_remaining: 8 });

    const result = await makeClient(mock).get2faStatus();

    expect(mock.calls[1]?.method).toBe("GET");
    expect(mock.calls[1]?.url).toContain("/auth/2fa/status");
    expect(result).toEqual({ enabled: true, recovery_codes_remaining: 8 });
  });

  it("enroll2fa", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ secret: "S".repeat(32), otpauth_uri: "otpauth://totp/x", ticket: "t.sig" });

    const result = await makeClient(mock).enroll2fa();

    expect(mock.calls[1]?.method).toBe("POST");
    expect(mock.calls[1]?.url).toContain("/auth/2fa/enroll");
    expect(result.otpauth_uri.startsWith("otpauth://")).toBe(true);
  });

  it("confirm2fa", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ enabled: true, recovery_codes: ["a", "b"], recovery_codes_remaining: 2 });

    const result = await makeClient(mock).confirm2fa("SECRET", "ticket.sig", "123456");

    expect(mock.calls[1]?.method).toBe("POST");
    expect(mock.calls[1]?.url).toContain("/auth/2fa/confirm");
    expect(bodyOf(mock, 1)).toEqual({
      secret: "SECRET",
      ticket: "ticket.sig",
      code: "123456",
    });
    expect(result.recovery_codes).toEqual(["a", "b"]);
  });

  it("disable2fa", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ enabled: false, recovery_codes_remaining: 0 });

    const result = await makeClient(mock).disable2fa("123456");

    expect(mock.calls[1]?.method).toBe("POST");
    expect(mock.calls[1]?.url).toContain("/auth/2fa/disable");
    expect(bodyOf(mock, 1)).toEqual({ code: "123456" });
    expect(result.enabled).toBe(false);
  });

  it("regenerateRecoveryCodes", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ recovery_codes: ["x"], recovery_codes_remaining: 1 });

    const result = await makeClient(mock).regenerateRecoveryCodes("123456");

    expect(mock.calls[1]?.method).toBe("POST");
    expect(mock.calls[1]?.url).toContain("/auth/2fa/recovery-codes/regenerate");
    expect(bodyOf(mock, 1)).toEqual({ code: "123456" });
    expect(result.recovery_codes).toEqual(["x"]);
  });
});
