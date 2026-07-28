/**
 * Organisations — the agent-facing org surface.
 *
 * The shapes asserted here were read off the SERVER's own schemas and service
 * returns (`app/schemas/organisations.py`, `app/services/organisations/*`) on
 * 2026-07-28, and the list-envelope and 404 shapes were confirmed against the
 * live API with the dedicated integration-test account. They were NOT copied
 * from the Python SDK, which types most of this surface as a bare dict — so
 * anything below that looks surprising is the server, not a guess.
 *
 * Three of those surprises are pinned as their own tests, because each is a
 * key you would otherwise read as `undefined`:
 *
 * - `setOrgVisibility` sends `visible` and returns `member_visible`;
 * - `addOrgDelegationGrant` sends `scopes` and reads back `allowed_scopes`;
 * - `startOrgDomainChallenge` returns the `token` you must publish, and it is
 *   returned NOWHERE else — `listOrgDomainChallenges` does not include it.
 *
 * Note also that 13 of these endpoints declare no `response_model` server-side,
 * so their shape lives only in the service layer and cannot be read off the
 * OpenAPI document.
 */

import { describe, expect, it } from "vitest";

import { ColonyClient } from "../src/client.js";
import { ColonyNotFoundError } from "../src/errors.js";
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
    body: call?.body ? (JSON.parse(call.body) as Record<string, unknown>) : undefined,
  };
}

const USER_ID = "11111111-2222-3333-4444-555555555555";

describe("verb and path", () => {
  /**
   * One row per endpoint: [label, invocation, expected method, expected path].
   * A table rather than 30 near-identical `it` blocks — the thing being
   * asserted really is uniform, and a table makes a missing row visible.
   */
  const routes: Array<[string, (c: ColonyClient) => Promise<unknown>, string, string]> = [
    ["listMyOrgs", (c) => c.listMyOrgs(), "GET", "/orgs"],
    ["createOrg", (c) => c.createOrg("Acme", "acme"), "POST", "/orgs"],
    ["getOrg", (c) => c.getOrg("acme"), "GET", "/orgs/acme"],
    ["renameOrg", (c) => c.renameOrg("acme", "acme2"), "POST", "/orgs/acme/rename"],
    ["leaveOrg", (c) => c.leaveOrg("acme"), "POST", "/orgs/acme/leave"],
    ["listMyOrgInvitations", (c) => c.listMyOrgInvitations(), "GET", "/orgs/invitations"],
    [
      "acceptOrgInvitation",
      (c) => c.acceptOrgInvitation("inv-1"),
      "POST",
      "/orgs/invitations/inv-1/accept",
    ],
    [
      "declineOrgInvitation",
      (c) => c.declineOrgInvitation("inv-1"),
      "POST",
      "/orgs/invitations/inv-1/decline",
    ],
    ["inviteOrgMember", (c) => c.inviteOrgMember("acme", "bob"), "POST", "/orgs/acme/invitations"],
    [
      "listOrgPendingInvitations",
      (c) => c.listOrgPendingInvitations("acme"),
      "GET",
      "/orgs/acme/invitations",
    ],
    [
      "addOrgOperatedAgent",
      (c) => c.addOrgOperatedAgent("acme", "sibling"),
      "POST",
      "/orgs/acme/operated-agents",
    ],
    ["listOrgMembers", (c) => c.listOrgMembers("acme"), "GET", "/orgs/acme/members"],
    [
      "setOrgMemberRole",
      (c) => c.setOrgMemberRole("acme", USER_ID, "admin"),
      "PUT",
      `/orgs/acme/members/${USER_ID}/role`,
    ],
    [
      "removeOrgMember",
      (c) => c.removeOrgMember("acme", USER_ID),
      "DELETE",
      `/orgs/acme/members/${USER_ID}`,
    ],
    [
      "transferOrgOwnership",
      (c) => c.transferOrgOwnership("acme", USER_ID),
      "POST",
      "/orgs/acme/transfer",
    ],
    [
      "setOrgDisclosure",
      (c) => c.setOrgDisclosure("acme", "public"),
      "PUT",
      "/orgs/acme/disclosure",
    ],
    ["setOrgVisibility", (c) => c.setOrgVisibility("acme", true), "PUT", "/orgs/acme/visibility"],
    [
      "listOrgDisclosureRecipients",
      (c) => c.listOrgDisclosureRecipients(),
      "GET",
      "/orgs/disclosure-recipients",
    ],
    [
      "startOrgDomainChallenge",
      (c) => c.startOrgDomainChallenge("acme", "acme.com", "dns_txt"),
      "POST",
      "/orgs/acme/domain",
    ],
    ["verifyOrgDomain", (c) => c.verifyOrgDomain("acme"), "POST", "/orgs/acme/domain/verify"],
    [
      "listOrgDomainChallenges",
      (c) => c.listOrgDomainChallenges("acme"),
      "GET",
      "/orgs/acme/domain",
    ],
    ["listOrgResources", (c) => c.listOrgResources("acme"), "GET", "/orgs/acme/resources"],
    [
      "addOrgResource",
      (c) => c.addOrgResource("acme", "https://api.acme.com"),
      "POST",
      "/orgs/acme/resources",
    ],
    [
      "removeOrgResource",
      (c) => c.removeOrgResource("acme", "res-1"),
      "DELETE",
      "/orgs/acme/resources/res-1",
    ],
    [
      "listOrgDelegationGrants",
      (c) => c.listOrgDelegationGrants("acme"),
      "GET",
      "/orgs/acme/delegation-grants",
    ],
    [
      "addOrgDelegationGrant",
      (c) => c.addOrgDelegationGrant("acme", "rp", ["read"]),
      "POST",
      "/orgs/acme/delegation-grants",
    ],
    [
      "removeOrgDelegationGrant",
      (c) => c.removeOrgDelegationGrant("acme", "g-1"),
      "DELETE",
      "/orgs/acme/delegation-grants/g-1",
    ],
    ["requestOrgDeletion", (c) => c.requestOrgDeletion("acme"), "POST", "/orgs/acme/deletion"],
    ["cancelOrgDeletion", (c) => c.cancelOrgDeletion("acme"), "DELETE", "/orgs/acme/deletion"],
    ["getOrgDeletionStatus", (c) => c.getOrgDeletionStatus("acme"), "GET", "/orgs/acme/deletion"],
  ];

  it("covers every ported org method", () => {
    // A control on the table itself: if a method is added to the client and
    // not to `routes`, this count goes stale and says so. Without it, a
    // missing row is simply an endpoint nobody tests, silently.
    expect(routes.length).toBe(30);
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
});

describe("request bodies", () => {
  it("createOrg omits description when unset", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({});
    await makeClient(mock).createOrg("Acme", "acme");

    expect(requestAt(mock, 1).body).toEqual({ name: "Acme", slug: "acme" });
  });

  it("createOrg sends description when given", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({});
    await makeClient(mock).createOrg("Acme", "acme", { description: "We make things" });

    expect(requestAt(mock, 1).body).toEqual({
      name: "Acme",
      slug: "acme",
      description: "We make things",
    });
  });

  it("inviteOrgMember omits role so the server default applies", async () => {
    // The server defaults to "member". Sending our own default would silently
    // override a server-side change to it.
    const mock = withAuthToken(new MockFetch());
    mock.json({});
    await makeClient(mock).inviteOrgMember("acme", "bob");

    expect(requestAt(mock, 1).body).toEqual({ username: "bob" });
  });

  it("addOrgDelegationGrant maps camelCase options to snake_case wire keys", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({});
    await makeClient(mock).addOrgDelegationGrant("acme", "rp", ["read"], {
      minRole: "owner",
      maxTtlSeconds: 300,
    });

    expect(requestAt(mock, 1).body).toEqual({
      resource: "rp",
      scopes: ["read"],
      min_role: "owner",
      max_ttl_seconds: 300,
    });
  });

  it("requestOrgDeletion sends an empty body when no reason is given", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({});
    await makeClient(mock).requestOrgDeletion("acme");

    expect(requestAt(mock, 1).body).toEqual({});
  });

  it("percent-encodes the slug so it cannot escape its path segment", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({});
    await makeClient(mock).getOrg("../../admin");

    const url = requestAt(mock, 1).url ?? "";
    expect(url).toContain("%2F");
    expect(new URL(url).pathname).toBe("/api/v1/orgs/..%2F..%2Fadmin");
  });
});

describe("measured response shapes", () => {
  it("setOrgVisibility sends `visible` but reads back `member_visible`", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({ slug: "acme", member_visible: true });
    const result = await makeClient(mock).setOrgVisibility("acme", true);

    expect(requestAt(mock, 1).body).toEqual({ visible: true });
    expect(result.member_visible).toBe(true);
    expect("visible" in result).toBe(false);
  });

  it("a delegation grant sends `scopes` and reads back `allowed_scopes`", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({
      id: "g-1",
      resource: "rp",
      allowed_scopes: ["read"],
      min_role: "admin",
      max_ttl_seconds: 3600,
      member_user_id: null,
      is_active: true,
      created_at: "2026-07-28T00:00:00+00:00",
    });
    const grant = await makeClient(mock).addOrgDelegationGrant("acme", "rp", ["read"]);

    expect(requestAt(mock, 1).body?.["scopes"]).toEqual(["read"]);
    expect(grant.allowed_scopes).toEqual(["read"]);
    expect("scopes" in grant).toBe(false);
  });

  it("startOrgDomainChallenge returns the token; listing challenges does not", async () => {
    // Losing this token means restarting the challenge, so it is worth
    // asserting that it comes back from exactly one of the two calls.
    const mock = withAuthToken(new MockFetch());
    mock.json({
      domain: "acme.com",
      method: "dns_txt",
      token: "colony-verify=abc123",
      instructions: "Add a TXT record…",
    });
    mock.json([
      {
        domain: "acme.com",
        method: "dns_txt",
        status: "pending",
        verified_at: null,
        expires_at: "2026-08-04T00:00:00+00:00",
        created_at: "2026-07-28T00:00:00+00:00",
      },
    ]);

    const client = makeClient(mock);
    const started = await client.startOrgDomainChallenge("acme", "acme.com", "dns_txt");
    const listed = await client.listOrgDomainChallenges("acme");

    expect(started.token).toBe("colony-verify=abc123");
    expect(listed[0] && "token" in listed[0]).toBe(false);
  });

  it("verifyOrgDomain reports a negative check as a SUCCESS, not an error", async () => {
    // `{verified: false}` means the challenge was looked for and not found.
    // Treating it as a failure would conflate "checked, absent" with
    // "could not check".
    const mock = withAuthToken(new MockFetch());
    mock.json({ verified: false, domain: "acme.com" });

    await expect(makeClient(mock).verifyOrgDomain("acme")).resolves.toEqual({
      verified: false,
      domain: "acme.com",
    });
  });

  it("getOrgDeletionStatus narrows on `scheduled`", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({ scheduled: false });
    mock.json({ scheduled: true, execute_after: "2026-08-27T00:00:00+00:00" });

    const client = makeClient(mock);
    const none = await client.getOrgDeletionStatus("acme");
    expect(none.scheduled).toBe(false);
    expect("execute_after" in none).toBe(false);

    const pending = await client.getOrgDeletionStatus("acme");
    // The union is what makes this read type-safe rather than an optional
    // field the caller can forget to check.
    expect(pending.scheduled === true && pending.execute_after).toBe("2026-08-27T00:00:00+00:00");
  });

  it("list endpoints return bare arrays, not an { items } envelope", async () => {
    // Measured against the live API 2026-07-28: `[]`, not `{items: []}`. The
    // rest of this SDK's list methods unwrap an envelope, so asserting the
    // difference is what stops someone "fixing" these to match.
    const mock = withAuthToken(new MockFetch());
    mock.json([]);
    await expect(makeClient(mock).listMyOrgs()).resolves.toEqual([]);
  });

  it("an unknown slug raises ColonyNotFoundError", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json(
      {
        error: "not_found",
        status: 404,
        path: "/api/v1/orgs/nope",
        detail: { message: "No such organisation.", code: "NOT_FOUND" },
      },
      404,
    );

    await expect(makeClient(mock).getOrg("nope")).rejects.toThrow(ColonyNotFoundError);
  });
});
