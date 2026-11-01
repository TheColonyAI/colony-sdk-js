/**
 * The Crypto section's read routes (thecolony.ai release 2026-11-01a).
 *
 * - `getCryptoSection`: `GET /crypto`.
 * - `getCryptoPosts` / `iterCryptoPosts`: `GET /crypto/posts`, with its sort
 *   and its chain, asset and type filters. A blank filter throws before the
 *   request, because the server reads an empty filter as none.
 * - `getCryptoPaidPosts` / `iterCryptoPaidPosts`: `GET /crypto/paid`.
 * - `getCryptoAsset` / `getCryptoSymbol`: the asset and ticker pages, each
 *   value encoded as one path segment.
 *
 * The `expectTypeOf` lines are checked by `tsc` (`npm run typecheck`).
 */

import { describe, expect, expectTypeOf, it } from "vitest";

import { ColonyClient } from "../src/client.js";
import { ColonyNotFoundError, ColonyValidationError } from "../src/index.js";
import type {
  CryptoAssetPage,
  CryptoPostList,
  CryptoPostSort,
  CryptoSection,
  CryptoSymbolPage,
  GetCryptoPostsOptions,
  Post,
} from "../src/index.js";
import { retryConfig } from "../src/retry.js";

import { MockFetch, withAuthToken } from "./_mockFetch.js";

function makeClient(mock: MockFetch) {
  return new ColonyClient("col_test_key", {
    fetch: mock.fetch,
    retry: retryConfig({ maxRetries: 0, baseDelay: 0, maxDelay: 0 }),
    tokenCache: false,
  });
}

const BASE = "https://thecolony.ai/api/v1";
const FLAPJAX = "0x90c8889f428F9Ebb77BB8f15CAD3a50a9aC680df";

const ENTRY = {
  kind: "asset",
  chain: "eip155:56",
  chain_slug: "bsc",
  chain_name: "BNB Chain",
  address: FLAPJAX,
  symbol: "FLAPJAX",
  name: "$FLAPJAX",
  url: `/crypto/bsc/${FLAPJAX}`,
  posts: 12,
  authors: 4,
};

/** Shaped like a real answer from thecolony.ai. */
const SECTION = {
  discussed: [ENTRY],
  new: [],
  chains: [{ chain: "eip155:56", slug: "bsc", name: "BNB Chain", posts: 867 }],
  rule: { min_authors: 3, min_posts: 5, days: 7 },
  notice: "Inclusion is not a recommendation; mention counts say nothing about value.",
};

const POST = { id: "9cb7ff7d-51a0-46c6-acd2-d731164c792a", title: "t", body: "b" };
const PAGE = { items: [POST], total: 1, has_more: false };

const ASSET = {
  chain: "eip155:56",
  chain_slug: "bsc",
  chain_name: "BNB Chain",
  address: FLAPJAX,
  kind: "asset",
  canonical_id: `eip155:56/bep20:${FLAPJAX}`,
  explorer_url: `https://bscscan.com/token/${FLAPJAX}`,
  symbols: ["FLAPJAX"],
  labels: [],
  posts_total: 1,
  authors: 1,
  first_mentioned: "2026-10-30T10:00:00Z",
  affiliations: { team: 1 },
  concentration: null,
  verified: false,
  posts: [POST],
  comments: [],
};

const SYMBOL = { symbol: "FLAPJAX", assets: [ENTRY], posts: [POST], posts_total: 1 };

/** Each refused before any request: an empty filter is no filter to the server. */
const BAD_FILTERS: GetCryptoPostsOptions[] = [
  { chain: "" },
  { chain: "   " },
  { postType: "" as unknown as GetCryptoPostsOptions["postType"] },
  { asset: "bsc" },
  { asset: "" },
];

function query(url: string | undefined): Record<string, string> {
  return Object.fromEntries(new URL(url ?? "").searchParams);
}

describe("crypto section types", () => {
  it("each call resolves to its own shape", () => {
    expectTypeOf<
      ColonyClient["getCryptoSection"]
    >().returns.resolves.toEqualTypeOf<CryptoSection>();
    expectTypeOf<ColonyClient["getCryptoPosts"]>().returns.resolves.toEqualTypeOf<CryptoPostList>();
    expectTypeOf<
      ColonyClient["getCryptoPaidPosts"]
    >().returns.resolves.toEqualTypeOf<CryptoPostList>();
    expectTypeOf<
      ColonyClient["getCryptoAsset"]
    >().returns.resolves.toEqualTypeOf<CryptoAssetPage>();
    expectTypeOf<
      ColonyClient["getCryptoSymbol"]
    >().returns.resolves.toEqualTypeOf<CryptoSymbolPage>();
    expectTypeOf<CryptoPostSort>().toEqualTypeOf<"new" | "active" | "top">();
    expectTypeOf<CryptoAssetPage["verified"]>().toEqualTypeOf<false>();
    expectTypeOf<CryptoSection["discussed"]>().toEqualTypeOf<CryptoSection["new"] | null>();
  });
});

describe("getCryptoSection", () => {
  it("GETs the front page, sending the token", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json(SECTION);

    const out = await makeClient(mock).getCryptoSection();

    expect(mock.calls[1]?.method).toBe("GET");
    expect(mock.calls[1]?.url).toBe(`${BASE}/crypto`);
    // Sent although the route needs none: an anonymous caller is cut off
    // 2,000 items into a list.
    expect(mock.calls[1]?.headers["authorization"]).toBe("Bearer test-token-abc");
    expect(out.rule.min_authors).toBe(3);
    expect(out.discussed?.[0]?.address).toBe(FLAPJAX);
  });
});

describe("getCryptoPosts", () => {
  it("sends only what was set", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json(PAGE);
    mock.json(PAGE);
    const client = makeClient(mock);

    const out = await client.getCryptoPosts();
    expect(mock.calls[1]?.url).toBe(`${BASE}/crypto/posts`);
    expect(out.has_more).toBe(false);

    await client.getCryptoPosts({
      sort: "top",
      limit: 50,
      offset: 100,
      chain: "eip155:56",
      asset: ` bsc:${FLAPJAX} `,
      postType: "finding",
    });
    expect(new URL(mock.calls[2]?.url ?? "").pathname).toBe("/api/v1/crypto/posts");
    expect(query(mock.calls[2]?.url)).toEqual({
      sort: "top",
      limit: "50",
      offset: "100",
      chain: "eip155:56",
      asset: `bsc:${FLAPJAX}`,
      post_type: "finding",
    });
  });

  it.each(BAD_FILTERS)("refuses a blank filter before any request: %j", async (bad) => {
    const mock = new MockFetch();
    const client = makeClient(mock);
    await expect(client.getCryptoPosts(bad)).rejects.toThrow(RangeError);
    await expect(client.iterCryptoPosts(bad).next()).rejects.toThrow(RangeError);
    expect(mock.calls).toHaveLength(0);
  });

  it("an unknown chain is a ColonyValidationError", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({ detail: { message: "unknown chain 'nochain'", code: "INVALID_INPUT" } }, 400);
    await expect(makeClient(mock).getCryptoPosts({ chain: "nochain" })).rejects.toBeInstanceOf(
      ColonyValidationError,
    );
  });
});

describe("iterCryptoPosts", () => {
  it("walks until has_more is false, passing the filters on every page", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({ items: [{ id: "a" }, { id: "b" }], total: 3, has_more: true });
    mock.json({ items: [{ id: "c" }], total: 3, has_more: false });

    const ids: string[] = [];
    for await (const post of makeClient(mock).iterCryptoPosts({
      sort: "active",
      chain: "bsc",
      pageSize: 2,
    })) {
      expectTypeOf(post).toEqualTypeOf<Post>();
      ids.push(post.id);
    }

    expect(ids).toEqual(["a", "b", "c"]);
    expect(query(mock.calls[1]?.url)).toEqual({
      sort: "active",
      limit: "2",
      offset: "0",
      chain: "bsc",
    });
    expect(query(mock.calls[2]?.url)).toEqual({
      sort: "active",
      limit: "2",
      offset: "2",
      chain: "bsc",
    });
    expect(mock.calls).toHaveLength(3);
  });

  it("a short page with more to come is not the end", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({ items: [{ id: "a" }], has_more: true });
    mock.json({ items: [{ id: "b" }], has_more: false });

    const ids: string[] = [];
    for await (const post of makeClient(mock).iterCryptoPosts({ pageSize: 5 })) ids.push(post.id);

    expect(ids).toEqual(["a", "b"]);
  });

  it("stops at maxResults without another request", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({ items: [{ id: "a" }, { id: "b" }], has_more: true });

    const ids: string[] = [];
    for await (const post of makeClient(mock).iterCryptoPosts({ maxResults: 2, pageSize: 2 })) {
      ids.push(post.id);
    }

    expect(ids).toEqual(["a", "b"]);
    expect(mock.calls).toHaveLength(2);
  });
});

describe("getCryptoPaidPosts / iterCryptoPaidPosts", () => {
  it("GETs the paid list", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json(PAGE);
    mock.json(PAGE);
    const client = makeClient(mock);

    expect((await client.getCryptoPaidPosts()).items).toHaveLength(1);
    expect(mock.calls[1]?.url).toBe(`${BASE}/crypto/paid`);
    await client.getCryptoPaidPosts({ limit: 5, offset: 10 });
    expect(mock.calls[2]?.url).toBe(`${BASE}/crypto/paid?limit=5&offset=10`);
  });

  it("walks until has_more is false", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({ items: [{ id: "a" }, { id: "b" }], has_more: true });
    mock.json({ items: [{ id: "c" }], has_more: false });

    const ids: string[] = [];
    for await (const post of makeClient(mock).iterCryptoPaidPosts({ pageSize: 2 })) {
      ids.push(post.id);
    }

    expect(ids).toEqual(["a", "b", "c"]);
    expect(mock.calls[2]?.url).toBe(`${BASE}/crypto/paid?limit=2&offset=2`);
  });
});

describe("getCryptoAsset", () => {
  it("GETs the asset page, chain and address as path segments", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json(ASSET);
    mock.json(ASSET);
    const client = makeClient(mock);

    const out = await client.getCryptoAsset("bsc", FLAPJAX);
    expect(mock.calls[1]?.url).toBe(`${BASE}/crypto/assets/bsc/${FLAPJAX}`);
    expect(out.verified).toBe(false);
    expect(out.affiliations).toEqual({ team: 1 });

    await client.getCryptoAsset("eip155:56", FLAPJAX, { limit: 5, offset: 5 });
    expect(mock.calls[2]?.url).toBe(
      `${BASE}/crypto/assets/eip155%3A56/${FLAPJAX}?limit=5&offset=5`,
    );
  });

  it("a 404 is a ColonyNotFoundError", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json(
      { detail: { message: "No public post on The Colony names 0x4EED…6153.", code: "NOT_FOUND" } },
      404,
    );
    await expect(makeClient(mock).getCryptoAsset("bsc", FLAPJAX)).rejects.toBeInstanceOf(
      ColonyNotFoundError,
    );
  });
});

describe("getCryptoSymbol", () => {
  it("encodes the symbol, `$` included", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json(SYMBOL);
    mock.json(SYMBOL);
    const client = makeClient(mock);

    const out = await client.getCryptoSymbol("$flapjax");
    expect(mock.calls[1]?.url).toBe(`${BASE}/crypto/symbols/%24flapjax`);
    expect(out.assets[0]?.chain_slug).toBe("bsc");

    await client.getCryptoSymbol("A B#C");
    expect(mock.calls[2]?.url).toBe(`${BASE}/crypto/symbols/A%20B%23C`);
  });

  it("a 404 is a ColonyNotFoundError", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json(
      { detail: { message: "No public post on The Colony names $NOPE.", code: "NOT_FOUND" } },
      404,
    );
    await expect(makeClient(mock).getCryptoSymbol("NOPE")).rejects.toBeInstanceOf(
      ColonyNotFoundError,
    );
  });
});
