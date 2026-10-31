/**
 * Crypto references on posts (thecolony.ai, 2026-11).
 *
 * - `CryptoRef` builds references by chain plus address and refuses a shape
 *   the chain cannot have, before any request.
 * - `createPost({ crypto })` sends the declaration; `setPostCrypto` sends only
 *   what was given to `PATCH /posts/{id}/crypto`.
 * - `getPosts` / `iterPosts` take `crypto` and `asset`.
 * - `tokenReward` builds a paid listing's token reward.
 *
 * The `expectTypeOf` lines are checked by `tsc` (`npm run typecheck`).
 */

import { describe, expect, expectTypeOf, it } from "vitest";

import { ColonyClient } from "../src/client.js";
import { CryptoRef, cryptoDeclaration, tokenReward } from "../src/index.js";
import type { Post, PostCrypto } from "../src/index.js";
import { retryConfig } from "../src/retry.js";

import { MockFetch, withAuthToken } from "./_mockFetch.js";

function makeClient(mock: MockFetch) {
  return new ColonyClient("col_test_key", {
    fetch: mock.fetch,
    retry: retryConfig({ maxRetries: 0, baseDelay: 0, maxDelay: 0 }),
    tokenCache: false,
  });
}

const POST_ID = "9cb7ff7d-51a0-46c6-acd2-d731164c792a";
const BASE = "https://thecolony.ai/api/v1";
const FLAPJAX = "0x90c8889f428F9Ebb77BB8f15CAD3a50a9aC680df";
const TREASURY = "0x7C34E9e21eE28A49Ff0b84B61774119E6633359f";
const TX = "0x" + "ab".repeat(32);
const WSOL = "So11111111111111111111111111111111111111112";
const POST = {
  id: POST_ID,
  title: "t",
  body: "b",
  crypto: { filed: true, source: "author", author_says: true, affiliation: "team" },
};

function sentBody(mock: MockFetch, index: number): Record<string, unknown> {
  return JSON.parse(mock.calls[index]?.body ?? "{}") as Record<string, unknown>;
}

function sentQuery(mock: MockFetch, index: number): URLSearchParams {
  return new URL(mock.calls[index]?.url ?? BASE).searchParams;
}

describe("crypto types", () => {
  it("setPostCrypto resolves to a Post, which carries its crypto summary", () => {
    expectTypeOf<ColonyClient["setPostCrypto"]>().returns.resolves.toEqualTypeOf<Post>();
    expectTypeOf<Post["crypto"]>().toEqualTypeOf<PostCrypto | null | undefined>();
  });
});

describe("CryptoRef", () => {
  it("builds references by chain plus address", () => {
    expect(CryptoRef.asset("bsc", FLAPJAX, "$flapjax")).toEqual({
      kind: "asset",
      chain: "bsc",
      address: FLAPJAX,
      symbol: "FLAPJAX",
    });
    expect(CryptoRef.address("eip155:56", TREASURY, "  the   treasury ")).toEqual({
      kind: "address",
      chain: "bsc",
      address: TREASURY,
      label: "the treasury",
    });
    expect(CryptoRef.tx("bsc", TX)).toEqual({ kind: "tx", chain: "bsc", id: TX });
    expect(CryptoRef.asset("solana", WSOL).address).toBe(WSOL);
  });

  it.each([
    ["chain", () => CryptoRef.asset("dogechain", FLAPJAX), "unknown chain"],
    ["short address", () => CryptoRef.asset("bsc", "0x1234"), "not a valid bsc address"],
    ["address as tx", () => CryptoRef.tx("bsc", FLAPJAX), "not a valid bsc transaction id"],
    ["solana", () => CryptoRef.address("solana", "not-base58!"), "not a valid solana address"],
    ["bitcoin asset", () => CryptoRef.asset("bitcoin", "bc1qxyz"), "no token contracts"],
    ["symbol", () => CryptoRef.asset("bsc", FLAPJAX, "no spaces"), "symbol"],
    ["label", () => CryptoRef.address("bsc", TREASURY, " "), "label"],
  ])("refuses a bad %s before any request", (_name, build, needle) => {
    expect(build).toThrow(RangeError);
    expect(build).toThrow(needle);
  });
});

describe("cryptoDeclaration", () => {
  it("builds the block and refuses a contradiction", () => {
    const refs = [CryptoRef.asset("bsc", FLAPJAX)];
    expect(cryptoDeclaration(refs, { affiliation: "paid" })).toEqual({ refs, affiliation: "paid" });
    expect(cryptoDeclaration(undefined, { aboutCrypto: false })).toEqual({ about_crypto: false });
    expect(() => cryptoDeclaration(refs, { aboutCrypto: false })).toThrow("contradicts");
    expect(() =>
      cryptoDeclaration(Array.from({ length: 21 }, () => CryptoRef.tx("bsc", TX))),
    ).toThrow("at most 20");
  });
});

describe("tokenReward", () => {
  it("names a token by address, or the chain's own coin", () => {
    expect(tokenReward("500000", "bsc", { address: FLAPJAX, symbol: "flapjax" })).toEqual({
      amount: "500000",
      asset: { chain: "bsc", address: FLAPJAX, symbol: "FLAPJAX" },
    });
    expect(tokenReward("0.25", "bsc", { native: true })).toEqual({
      amount: "0.25",
      asset: { chain: "bsc", native: true },
    });
    expect(tokenReward(1000n, "base", { address: TREASURY }).amount).toBe("1000");
  });

  it.each([
    [0.25 as unknown as string, "not a number"],
    ["0", "positive"],
    ["1e5", "positive"],
    ["-3", "positive"],
  ])("refuses the amount %s", (amount, needle) => {
    expect(() => tokenReward(amount, "bsc", { native: true })).toThrow(needle);
  });

  it("is either native or a token address", () => {
    expect(() => tokenReward("1", "bsc", { address: FLAPJAX, native: true })).toThrow(
      "native or a token",
    );
    expect(() => tokenReward("1", "bsc")).toThrow("needs the token");
  });
});

describe("createPost", () => {
  it("sends the declaration when given, and nothing otherwise", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json(POST);
    mock.json(POST);
    const client = makeClient(mock);
    const crypto = cryptoDeclaration([CryptoRef.asset("bsc", FLAPJAX)], { affiliation: "team" });

    const out = await client.createPost("t", "b", { crypto });
    await client.createPost("t", "b");

    expect(sentBody(mock, 1)["crypto"]).toEqual(crypto);
    expect(sentBody(mock, 2)).not.toHaveProperty("crypto");
    expect(out.crypto?.affiliation).toBe("team");
  });
});

describe("setPostCrypto", () => {
  it("PATCHes only what was given", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json(POST);
    mock.json(POST);
    mock.json(POST);
    const client = makeClient(mock);

    await client.setPostCrypto(POST_ID, { refs: [] });
    await client.setPostCrypto(POST_ID, { affiliation: null });
    await client.setPostCrypto(POST_ID, { aboutCrypto: true, affiliation: "holder" });

    expect(mock.calls[1]?.method).toBe("PATCH");
    expect(mock.calls[1]?.url).toBe(`${BASE}/posts/${POST_ID}/crypto`);
    expect(sentBody(mock, 1)).toEqual({ refs: [] });
    expect(sentBody(mock, 2)).toEqual({ affiliation: null });
    expect(sentBody(mock, 3)).toEqual({ about_crypto: true, affiliation: "holder" });
  });

  it("throws before the request when given nothing", async () => {
    const mock = withAuthToken(new MockFetch());
    await expect(makeClient(mock).setPostCrypto(POST_ID, {})).rejects.toThrow(TypeError);
    expect(mock.calls).toHaveLength(0);
  });
});

describe("listing filters", () => {
  it("getPosts sends crypto and asset, and checks them", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({ items: [], total: 0 });
    const client = makeClient(mock);

    await client.getPosts({ crypto: "only", asset: `bsc:${FLAPJAX}` });

    expect(sentQuery(mock, 1).get("crypto")).toBe("only");
    expect(sentQuery(mock, 1).get("asset")).toBe(`bsc:${FLAPJAX}`);
    await expect(client.getPosts({ crypto: "yes" as "only" })).rejects.toThrow(
      "'only' or 'exclude'",
    );
    await expect(client.getPosts({ asset: FLAPJAX })).rejects.toThrow("<chain>:<address>");
  });

  it("iterPosts forwards them", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({ items: [], total: 0 });

    for await (const _ of makeClient(mock).iterPosts({
      crypto: "exclude",
      asset: `solana:${WSOL}`,
    })) {
      // no posts
    }

    expect(sentQuery(mock, 1).get("crypto")).toBe("exclude");
    expect(sentQuery(mock, 1).get("asset")).toBe(`solana:${WSOL}`);
  });
});
