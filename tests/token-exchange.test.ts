/**
 * Agent SSO — `getAuthToken()` and `exchangeToken()` (RFC 8693).
 *
 * `exchangeToken` is the only method in this SDK that does not go through
 * `rawRequest`, and it differs on three axes that `rawRequest` hard-codes the
 * other way. Each one is asserted below, because each is invisible in the
 * return value and would only surface as a confusing server error:
 *
 * 1. **Form-encoded**, not JSON;
 * 2. mounted at the **site root**, not under `baseUrl`'s `/api/v1`; and
 * 3. errors in RFC 6749 §5.2 shape (`{error, error_description}`), not the
 *    JSON API's `{detail: {message, code}}` — so the normal error builder
 *    would surface these with an empty message.
 *
 * It also sends **no** `Authorization` header: the caller authenticates with
 * the `subject_token` in the body, not as a confidential client.
 */

import { describe, expect, it } from "vitest";

import { ColonyClient } from "../src/client.js";
import { ColonyAPIError, ColonyAuthError, ColonyValidationError } from "../src/errors.js";
import { retryConfig } from "../src/retry.js";

import { MockFetch, withAuthToken } from "./_mockFetch.js";

function makeClient(mock: MockFetch, baseUrl?: string) {
  return new ColonyClient("col_test_key", {
    fetch: mock.fetch,
    retry: retryConfig({ maxRetries: 0, baseDelay: 0, maxDelay: 0 }),
    tokenCache: false,
    ...(baseUrl ? { baseUrl } : {}),
  });
}

const OK = {
  access_token: "at-1",
  id_token: "eyJhbGciOi.fake.jwt",
  issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
  token_type: "Bearer",
  expires_in: 300,
  scope: "openid",
};

describe("getAuthToken", () => {
  it("returns the client's JWT without a Bearer prefix", async () => {
    const mock = withAuthToken(new MockFetch());
    const token = await makeClient(mock).getAuthToken();

    expect(token).toBe("test-token-abc");
    expect(token).not.toMatch(/^Bearer /);
  });

  it("does NOT mint a new token on each call", async () => {
    // One `/auth/token` exchange, two reads. A regression here would be
    // invisible in the return value and only show up as rate-limiting.
    const mock = withAuthToken(new MockFetch());
    const client = makeClient(mock);
    await client.getAuthToken();
    await client.getAuthToken();

    expect(mock.calls.length).toBe(1);
  });
});

describe("transport", () => {
  it("posts form-encoded, not JSON", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json(OK);
    await makeClient(mock).exchangeToken("acme-rp");

    const call = mock.calls[1];
    expect(call?.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    const form = new URLSearchParams(call?.body ?? "");
    expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:token-exchange");
    expect(form.get("subject_token_type")).toBe("urn:ietf:params:oauth:token-type:access_token");
    expect(form.get("audience")).toBe("acme-rp");
    // The default subject is the client's own JWT, not the API key.
    expect(form.get("subject_token")).toBe("test-token-abc");
  });

  it("hits the SITE root, not /api/v1", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json(OK);
    await makeClient(mock).exchangeToken("acme-rp");

    expect(mock.calls[1]?.url).toBe("https://thecolony.ai/oauth/token");
  });

  it("keeps a sub-path deployment working when stripping /api/v1", async () => {
    // Naively taking scheme+host would break this, which is why the helper
    // strips the suffix rather than reaching for `origin` first.
    const mock = withAuthToken(new MockFetch());
    mock.json(OK);
    await makeClient(mock, "https://host.example/colony/api/v1").exchangeToken("acme-rp");

    expect(mock.calls[1]?.url).toBe("https://host.example/colony/oauth/token");
  });

  it("sends no Authorization header", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json(OK);
    await makeClient(mock).exchangeToken("acme-rp");

    const headers = mock.calls[1]?.headers ?? {};
    expect("authorization" in headers).toBe(false);
  });

  it("omits scope when unset and sends it when given", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json(OK);
    mock.json(OK);
    const client = makeClient(mock);

    await client.exchangeToken("acme-rp");
    expect(new URLSearchParams(mock.calls[1]?.body ?? "").has("scope")).toBe(false);

    await client.exchangeToken("acme-rp", { scope: "openid profile" });
    expect(new URLSearchParams(mock.calls[2]?.body ?? "").get("scope")).toBe("openid profile");
  });
});

describe("subjectToken validation", () => {
  it("rejects a col_ API key locally, naming the mistake", async () => {
    // The single error this endpoint traces back to. The server catches it too,
    // but only as `invalid_grant` after a round-trip, with wording that is easy
    // to miss.
    const mock = new MockFetch();
    await expect(
      makeClient(mock).exchangeToken("acme-rp", { subjectToken: "col_abc123" }),
    ).rejects.toThrow(/API key/);

    // Rejected before anything went on the wire at all.
    expect(mock.calls.length).toBe(0);
  });

  it("rejects an empty subjectToken", async () => {
    const mock = new MockFetch();
    await expect(makeClient(mock).exchangeToken("acme-rp", { subjectToken: "  " })).rejects.toThrow(
      /empty/,
    );
    expect(mock.calls.length).toBe(0);
  });

  it("passes an opaque non-col_ token straight through", async () => {
    // Deliberately narrow: it does not parse JWT structure, because a stricter
    // check could reject a token the server would accept.
    const mock = new MockFetch();
    mock.json(OK);
    await makeClient(mock).exchangeToken("acme-rp", { subjectToken: "opaque-thing" });

    expect(new URLSearchParams(mock.calls[0]?.body ?? "").get("subject_token")).toBe(
      "opaque-thing",
    );
  });

  it("an explicit subjectToken means the client never mints its own JWT", async () => {
    // Worth pinning: `exchangeToken` with a caller-supplied token should not
    // drag a `/auth/token` exchange along behind it. The only evidence is the
    // absence of a request, which no return value reveals.
    const mock = new MockFetch();
    mock.json(OK);
    await makeClient(mock).exchangeToken("acme-rp", { subjectToken: "someone-elses-jwt" });

    expect(mock.calls.length).toBe(1);
    expect(mock.calls[0]?.url).toBe("https://thecolony.ai/oauth/token");
  });

  it("requires an audience before touching the network", async () => {
    const mock = new MockFetch();
    await expect(makeClient(mock).exchangeToken("   ")).rejects.toThrow(/audience/);
    expect(mock.calls.length).toBe(0);
  });

  it("requires a non-empty audience", async () => {
    const mock = withAuthToken(new MockFetch());
    await expect(makeClient(mock).exchangeToken("   ")).rejects.toThrow(/audience/);
  });
});

describe("RFC 6749 §5.2 error mapping", () => {
  const cases: Array<[string, number, new (...args: never[]) => Error]> = [
    ["invalid_grant", 400, ColonyAuthError],
    ["invalid_target", 400, ColonyValidationError],
    ["invalid_request", 400, ColonyValidationError],
    ["invalid_scope", 400, ColonyValidationError],
    ["unsupported_grant_type", 400, ColonyAPIError],
  ];

  for (const [err, status, type] of cases) {
    it(`maps ${err} to ${type.name}`, async () => {
      const mock = withAuthToken(new MockFetch());
      mock.json({ error: err, error_description: "nope" }, status);

      await expect(makeClient(mock).exchangeToken("acme-rp")).rejects.toBeInstanceOf(type);
    });
  }

  it("carries `error` through as .code and does not swallow the description", async () => {
    // The failure this guards against: the JSON-API error builder reads
    // `detail.message`, which an OAuth body does not have, so the error would
    // surface with an empty message and no code.
    const mock = withAuthToken(new MockFetch());
    mock.json({ error: "invalid_target", error_description: "Unknown audience." }, 400);

    await expect(makeClient(mock).exchangeToken("acme-rp")).rejects.toMatchObject({
      code: "invalid_target",
      message: "invalid_target: Unknown audience.",
    });
  });

  it("falls back to a usable message when the body is empty", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.respond(() => new Response("", { status: 400 }));

    await expect(makeClient(mock).exchangeToken("acme-rp")).rejects.toThrow(/OAuth error/);
  });
});
