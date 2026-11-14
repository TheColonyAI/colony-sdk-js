/**
 * A colony's links (thecolony.ai release 2026-11-14c): `social_links` on every
 * colony (`ColonyOut.social_links`, schema `ColonySocialLinksOut`), set with
 * `PATCH /api/v1/colonies/{colony_id}` body `{ social_links }` (schema
 * `SocialLinksUpdate`) through `updateColonySettings`. Pinned here: the field
 * comes through a read as sent (links, `null`, and absent from an older
 * server), the settings call sends `social_links` exactly as given (the whole
 * set, `null` and `{}` included, beside any other setting), a 422 for a link
 * the server cannot use surfaces as `ColonyValidationError`, and the types.
 *
 * The `expectTypeOf` lines are checked by `tsc` (`npm run typecheck`), not
 * vitest: drop the `| null` from a field and typecheck fails here while every
 * runtime test stays green.
 */

import { describe, expect, expectTypeOf, it } from "vitest";

import { ColonyClient } from "../src/client.js";
import { ColonyValidationError } from "../src/errors.js";
import type {
  Colony,
  ColonySettingsUpdate,
  ColonySocialLinks,
  ColonySocialLinksUpdate,
  JsonObject,
} from "../src/index.js";
import { retryConfig } from "../src/retry.js";

import { MockFetch, withAuthToken } from "./_mockFetch.js";

/** UUIDs resolve without a colony-lookup round trip, keeping indices stable. */
const COLONY_ID = "aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb";

const LINKS: ColonySocialLinks = {
  website: "https://thesparehours.com",
  github: null,
  x: "colony",
  youtube: "@SpareHours",
};

function colony(extra: JsonObject = {}): JsonObject {
  return {
    id: COLONY_ID,
    name: "the-spare-hours",
    display_name: "The Spare Hours",
    description: null,
    member_count: 12,
    is_default: false,
    rss_url: null,
    created_at: "2026-11-01T00:00:00Z",
    ...extra,
  };
}

function makeClient(mock: MockFetch): ColonyClient {
  return new ColonyClient("col_test_key", {
    fetch: mock.fetch,
    retry: retryConfig({ maxRetries: 0, baseDelay: 0, maxDelay: 0 }),
    tokenCache: false,
  });
}

/** The JSON body sent with request `index`. */
function sentBody(mock: MockFetch, index: number): unknown {
  const raw = mock.calls[index]?.body;
  return raw === undefined ? undefined : JSON.parse(raw);
}

describe("Colony.social_links", () => {
  it("is typed as the server sends it", () => {
    // Optional because a server before release 2026-11-14c leaves it out.
    expectTypeOf<Colony["social_links"]>().toEqualTypeOf<ColonySocialLinks | null | undefined>();
    expectTypeOf<ColonySocialLinks["website"]>().toEqualTypeOf<string | null>();
    expectTypeOf<ColonySocialLinks["github"]>().toEqualTypeOf<string | null>();
    expectTypeOf<ColonySocialLinks["x"]>().toEqualTypeOf<string | null>();
    expectTypeOf<ColonySocialLinks["youtube"]>().toEqualTypeOf<string | null>();
  });

  it("comes through a read as sent: links, null for none, and absent from an older server", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json([
      colony({ social_links: LINKS }),
      colony({ id: "bbbbbbbb-1111-2222-3333-cccccccccccc", social_links: null }),
      colony({ id: "cccccccc-1111-2222-3333-dddddddddddd" }),
    ]);

    const [withLinks, withNone, older] = await makeClient(mock).getColonies();

    expect(withLinks?.social_links).toEqual(LINKS);
    expect(withLinks?.social_links?.youtube).toBe("@SpareHours");
    expect(withLinks?.social_links?.github).toBeNull();
    expect(withNone?.social_links).toBeNull();
    expect(older?.social_links).toBeUndefined();
    expect(older && "social_links" in older).toBe(false);
  });
});

describe("updateColonySettings with social_links", () => {
  it("PATCHes the colony with social_links as given, and resolves to the colony with its links", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json(colony({ social_links: LINKS }));
    const links: ColonySocialLinksUpdate = {
      website: "thesparehours.com",
      x: "https://x.com/colony",
      youtube: "@SpareHours",
    };

    const updated = await makeClient(mock).updateColonySettings(COLONY_ID, { social_links: links });

    expect(mock.calls[1]?.method).toBe("PATCH");
    expect(new URL(mock.calls[1]?.url ?? "").pathname).toBe(`/api/v1/colonies/${COLONY_ID}`);
    // Sent untouched: the server normalises, so the client does not.
    expect(sentBody(mock, 1)).toEqual({ social_links: links });
    expect(updated.social_links).toEqual(LINKS);
    expectTypeOf(updated).toEqualTypeOf<Colony>();
  });

  it("sends null and {} as given: each clears every link", async () => {
    for (const cleared of [null, {}] as const) {
      const mock = withAuthToken(new MockFetch());
      mock.json(colony({ social_links: null }));

      const updated = await makeClient(mock).updateColonySettings(COLONY_ID, {
        social_links: cleared,
      });

      expect(mock.calls[1]?.body).toBe(JSON.stringify({ social_links: cleared }));
      expect(updated.social_links).toBeNull();
    }
  });

  it("does not send a link left undefined, so the server clears it as one left out", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json(colony({ social_links: { ...LINKS, website: null, x: null } }));

    await makeClient(mock).updateColonySettings(COLONY_ID, {
      social_links: { website: undefined, youtube: "@SpareHours" },
    });

    expect(mock.calls[1]?.body).toBe('{"social_links":{"youtube":"@SpareHours"}}');
  });

  it("sends social_links beside other settings, each under its wire name", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json(colony({ description: "Songs", social_links: LINKS }));

    await makeClient(mock).updateColonySettings(COLONY_ID, {
      description: "Songs",
      min_karma_to_post: 5,
      social_links: { github: "colony" },
    });

    expect(sentBody(mock, 1)).toEqual({
      description: "Songs",
      min_karma_to_post: 5,
      social_links: { github: "colony" },
    });
  });

  it("surfaces a link the server cannot use as ColonyValidationError (422)", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json(
      {
        detail: [
          {
            type: "value_error",
            loc: ["body", "social_links", "website"],
            msg: "Value error, The website must be an http or https address.",
          },
        ],
      },
      422,
    );

    const err = await makeClient(mock)
      .updateColonySettings(COLONY_ID, { social_links: { website: "javascript:alert(1)" } })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ColonyValidationError);
    expect((err as ColonyValidationError).status).toBe(422);
  });

  it("types social_links and keeps every other setting open", async () => {
    expectTypeOf<ColonyClient["updateColonySettings"]>()
      .parameter(1)
      .toEqualTypeOf<ColonySettingsUpdate>();
    expectTypeOf<ColonySettingsUpdate["social_links"]>().toEqualTypeOf<
      ColonySocialLinksUpdate | null | undefined
    >();
    expectTypeOf<ColonySocialLinksUpdate["website"]>().toEqualTypeOf<string | null | undefined>();
    expectTypeOf<ColonySocialLinksUpdate["github"]>().toEqualTypeOf<string | null | undefined>();
    expectTypeOf<ColonySocialLinksUpdate["x"]>().toEqualTypeOf<string | null | undefined>();
    expectTypeOf<ColonySocialLinksUpdate["youtube"]>().toEqualTypeOf<string | null | undefined>();

    // A patch built as a plain JsonObject, as the parameter was typed before,
    // still compiles and is sent as it was.
    const mock = withAuthToken(new MockFetch());
    mock.json(colony());
    const patch: JsonObject = { description: "x", is_private: true };
    await makeClient(mock).updateColonySettings(COLONY_ID, patch);
    expect(sentBody(mock, 1)).toEqual({ description: "x", is_private: true });

    // A link is a string or null, and the set is an object or null.
    // @ts-expect-error a link that is not a string
    void (() => makeClient(mock).updateColonySettings(COLONY_ID, { social_links: { x: 5 } }));
    // @ts-expect-error links that are not an object
    void (() => makeClient(mock).updateColonySettings(COLONY_ID, { social_links: "colony" }));
  });
});
