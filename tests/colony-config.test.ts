/**
 * Colony config — post flair, user flair, removal reasons, member notes.
 *
 * The shapes asserted here were read off the server's own return annotations
 * and schemas (`app/api/v1/colony_config.py`, `app/schemas/colony.py`) on
 * 2026-07-28. That reading was necessary rather than pedantic: **none of these
 * 14 endpoints declares a `response_model=`**, so FastAPI derives the response
 * shape from the handler's return annotation and nothing about it is visible in
 * the router's decorators. The Python SDK types all 14 as a bare dict.
 *
 * Three irregularities are pinned below, because each is a place where
 * generalising from a neighbouring endpoint gives the wrong answer:
 *
 * - **Every list endpoint has a different envelope** — `{flairs}`,
 *   `{user_flair_enabled, templates}`, `{removal_reasons}`, `{user_id, notes}`.
 *   There is no shared shape and no `items` key anywhere.
 * - **DELETE does not mean one thing.** Four deletes are `204 No Content`;
 *   `clearMemberFlair` is a DELETE that returns a body.
 * - **`user_flair_enabled` is independent of `templates`.** Templates can exist
 *   while the feature is off, so an empty array and a disabled colony are
 *   different states.
 *
 * Everything goes through the mock fetch, so what is asserted is what actually
 * goes on the wire.
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
    body: call?.body ? (JSON.parse(call.body) as Record<string, unknown>) : undefined,
  };
}

/** A UUID resolves without a colony-lookup round trip, keeping indices stable. */
const COLONY = "aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb";
const USER = "cccccccc-4444-5555-6666-dddddddddddd";

describe("verb and path", () => {
  const routes: Array<[string, (c: ColonyClient) => Promise<unknown>, string, string]> = [
    ["listPostFlairs", (c) => c.listPostFlairs(COLONY), "GET", `/colonies/${COLONY}/post-flairs`],
    [
      "createPostFlair",
      (c) => c.createPostFlair(COLONY, "Analysis"),
      "POST",
      `/colonies/${COLONY}/post-flairs`,
    ],
    [
      "deletePostFlair",
      (c) => c.deletePostFlair(COLONY, "f-1"),
      "DELETE",
      `/colonies/${COLONY}/post-flairs/f-1`,
    ],
    ["listUserFlairs", (c) => c.listUserFlairs(COLONY), "GET", `/colonies/${COLONY}/user-flairs`],
    [
      "createUserFlair",
      (c) => c.createUserFlair(COLONY, "Veteran"),
      "POST",
      `/colonies/${COLONY}/user-flairs`,
    ],
    [
      "deleteUserFlair",
      (c) => c.deleteUserFlair(COLONY, "t-1"),
      "DELETE",
      `/colonies/${COLONY}/user-flairs/t-1`,
    ],
    [
      "assignMemberFlair",
      (c) => c.assignMemberFlair(COLONY, USER, "t-1"),
      "PUT",
      `/colonies/${COLONY}/members/${USER}/flair`,
    ],
    [
      "clearMemberFlair",
      (c) => c.clearMemberFlair(COLONY, USER),
      "DELETE",
      `/colonies/${COLONY}/members/${USER}/flair`,
    ],
    [
      "listRemovalReasons",
      (c) => c.listRemovalReasons(COLONY),
      "GET",
      `/colonies/${COLONY}/removal-reasons`,
    ],
    [
      "createRemovalReason",
      (c) => c.createRemovalReason(COLONY, "Off topic", "Please post this in c/general."),
      "POST",
      `/colonies/${COLONY}/removal-reasons`,
    ],
    [
      "deleteRemovalReason",
      (c) => c.deleteRemovalReason(COLONY, "r-1"),
      "DELETE",
      `/colonies/${COLONY}/removal-reasons/r-1`,
    ],
    [
      "listMemberNotes",
      (c) => c.listMemberNotes(COLONY, USER),
      "GET",
      `/colonies/${COLONY}/members/${USER}/notes`,
    ],
    [
      "addMemberNote",
      (c) => c.addMemberNote(COLONY, USER, "Repeatedly reposts."),
      "POST",
      `/colonies/${COLONY}/members/${USER}/notes`,
    ],
    [
      "deleteMemberNote",
      (c) => c.deleteMemberNote(COLONY, USER, "n-1"),
      "DELETE",
      `/colonies/${COLONY}/members/${USER}/notes/n-1`,
    ],
  ];

  it("covers every ported method", () => {
    // A control on the table: a method added to the client but not here would
    // otherwise be an endpoint nobody tests, silently.
    expect(routes.length).toBe(14);
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
  it("createPostFlair sends only the label when nothing else is given", async () => {
    // Colours default server-side to "" rather than null; sending our own
    // default would overwrite a server-side change to it.
    const mock = withAuthToken(new MockFetch());
    mock.json({});
    await makeClient(mock).createPostFlair(COLONY, "Analysis");

    expect(requestAt(mock, 1).body).toEqual({ label: "Analysis" });
  });

  it("createPostFlair maps camelCase options to snake_case wire keys", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({});
    await makeClient(mock).createPostFlair(COLONY, "Analysis", {
      backgroundColor: "#2b6cb0",
      textColor: "#ffffff",
      position: 3,
    });

    expect(requestAt(mock, 1).body).toEqual({
      label: "Analysis",
      background_color: "#2b6cb0",
      text_color: "#ffffff",
      position: 3,
    });
  });

  it("createUserFlair sends mod_only, which post flair has no equivalent of", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({});
    await makeClient(mock).createUserFlair(COLONY, "Veteran", { modOnly: true });

    expect(requestAt(mock, 1).body).toEqual({ label: "Veteran", mod_only: true });
  });

  it("createRemovalReason sends label and body positionally", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({});
    await makeClient(mock).createRemovalReason(COLONY, "Off topic", "Post in c/general.");

    expect(requestAt(mock, 1).body).toEqual({
      label: "Off topic",
      body: "Post in c/general.",
    });
  });

  it("addMemberNote nests the note under `body`", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({});
    await makeClient(mock).addMemberNote(COLONY, USER, "Repeatedly reposts.");

    expect(requestAt(mock, 1).body).toEqual({ body: "Repeatedly reposts." });
  });

  it("assignMemberFlair sends template_id", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({});
    await makeClient(mock).assignMemberFlair(COLONY, USER, "t-1");

    expect(requestAt(mock, 1).body).toEqual({ template_id: "t-1" });
  });

  it("clearMemberFlair sends no body at all", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({ user_id: USER, template_id: null, template_label: null });
    await makeClient(mock).clearMemberFlair(COLONY, USER);

    expect(requestAt(mock, 1).body).toBeUndefined();
  });
});

describe("colony resolution", () => {
  it("a known slug resolves from the hardcoded map without a lookup", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({ flairs: [] });
    await makeClient(mock).listPostFlairs("general");

    // Auth token + the call itself. A third request would mean the slug fell
    // through to a live `getColonies` lookup.
    expect(mock.calls.length).toBe(2);
    expect(new URL(mock.calls[1]?.url ?? "").pathname).toMatch(
      /^\/api\/v1\/colonies\/[0-9a-f-]{36}\/post-flairs$/,
    );
  });
});

describe("measured response shapes", () => {
  it("each list endpoint uses its OWN envelope key", async () => {
    // The point of this test is the absence of a shared shape. Anyone who
    // factored these into one generic list helper would read `undefined`.
    const mock = withAuthToken(new MockFetch());
    mock.json({
      flairs: [{ id: "f1", label: "A", background_color: "", text_color: "", position: 0 }],
    });
    mock.json({ user_flair_enabled: true, templates: [] });
    mock.json({ removal_reasons: [] });
    mock.json({ user_id: USER, notes: [] });

    const c = makeClient(mock);
    const posts = await c.listPostFlairs(COLONY);
    const users = await c.listUserFlairs(COLONY);
    const reasons = await c.listRemovalReasons(COLONY);
    const notes = await c.listMemberNotes(COLONY, USER);

    expect(posts.flairs).toHaveLength(1);
    expect(users.templates).toEqual([]);
    expect(reasons.removal_reasons).toEqual([]);
    expect(notes.notes).toEqual([]);
    // No endpoint grew an `items` key, and none borrowed another's.
    expect("items" in posts).toBe(false);
    expect("flairs" in users).toBe(false);
    expect("templates" in posts).toBe(false);
  });

  it("templates present and user flair disabled is a real, distinct state", async () => {
    // Not a hypothetical: `listUserFlairs` carries the switch precisely because
    // an empty array does not mean the feature is off, and vice versa.
    const mock = withAuthToken(new MockFetch());
    mock.json({
      user_flair_enabled: false,
      templates: [
        {
          id: "t1",
          label: "Veteran",
          background_color: "",
          text_color: "",
          mod_only: false,
          position: 0,
        },
      ],
    });
    const result = await makeClient(mock).listUserFlairs(COLONY);

    expect(result.user_flair_enabled).toBe(false);
    expect(result.templates).toHaveLength(1);
  });

  it("flair colours come back as empty strings when unset, not null", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({ id: "f1", label: "A", background_color: "", text_color: "", position: 0 });
    const flair = await makeClient(mock).createPostFlair(COLONY, "A");

    expect(flair.background_color).toBe("");
    expect(flair.background_color).not.toBeNull();
  });

  it("clearMemberFlair returns a body; the template deletes return 204", async () => {
    // The asymmetry is the whole test. Both are DELETEs on the same resource
    // family and they do not answer the same way.
    const mock = withAuthToken(new MockFetch());
    mock.json({ user_id: USER, template_id: null, template_label: null });
    mock.noContent();

    const c = makeClient(mock);
    const cleared = await c.clearMemberFlair(COLONY, USER);
    expect(cleared.user_id).toBe(USER);
    expect(cleared.template_id).toBeNull();
    expect(cleared.template_label).toBeNull();

    await expect(c.deleteUserFlair(COLONY, "t-1")).resolves.toEqual({});
  });

  it("all four 204 deletes resolve to {} rather than throwing on an empty body", async () => {
    const mock = withAuthToken(new MockFetch());
    for (let i = 0; i < 4; i++) mock.noContent();

    const c = makeClient(mock);
    await expect(c.deletePostFlair(COLONY, "f-1")).resolves.toEqual({});
    await expect(c.deleteUserFlair(COLONY, "t-1")).resolves.toEqual({});
    await expect(c.deleteRemovalReason(COLONY, "r-1")).resolves.toEqual({});
    await expect(c.deleteMemberNote(COLONY, USER, "n-1")).resolves.toEqual({});
  });

  it("a member note's author can be null", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({
      user_id: USER,
      notes: [{ id: "n1", body: "note", author: null, created_at: "2026-07-28T00:00:00+00:00" }],
    });
    const result = await makeClient(mock).listMemberNotes(COLONY, USER);

    expect(result.notes[0]?.author).toBeNull();
    expect(result.user_id).toBe(USER);
  });
});
