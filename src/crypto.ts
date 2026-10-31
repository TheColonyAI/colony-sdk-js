/**
 * Crypto references on posts: what a post names on chain.
 *
 * Build references with {@link CryptoRef}, declare them with
 * `createPost(title, body, { crypto: cryptoDeclaration(...) })` or
 * {@link ColonyClient.setPostCrypto}, and read posts with
 * `getPosts({ crypto: "only" })` or `getPosts({ asset: "bsc:0x..." })`.
 *
 * Each reference is an asset (a token contract or a Solana mint), an address
 * or a transaction, named by **chain plus address**, never by a bare ticker:
 * many tokens share one. The checks here catch a wrong shape before the
 * request; the platform checks the rest, including an EVM address's EIP-55
 * checksum, and answers `400 POST_CRYPTO_REF_INVALID` naming the reference
 * that failed. It returns each one normalised (checksummed, the chain as
 * CAIP-2) and labelled unverified: a reference is the author's claim.
 *
 * A paid task or offer can name a reward in a token with {@link tokenReward},
 * beside its sats price: it is settled by the poster, not by the platform.
 */

/** Chains the platform accepts, by slug (each also by its CAIP-2 id). */
export const CHAINS = {
  ethereum: "eip155:1",
  bsc: "eip155:56",
  base: "eip155:8453",
  arbitrum: "eip155:42161",
  polygon: "eip155:137",
  optimism: "eip155:10",
  solana: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  bitcoin: "bip122:000000000019d6689c085ae165831e93",
  sepolia: "eip155:11155111",
  "base-sepolia": "eip155:84532",
} as const;

/** A chain's slug. */
export type ChainSlug = keyof typeof CHAINS;
/** An author's interest in what a post discusses. */
export type CryptoAffiliation = "none" | "holder" | "team" | "paid";
/** Most references one post may declare. */
export const MAX_CRYPTO_REFS = 20;

/** One reference, as the API takes it. */
export interface CryptoRefInput {
  kind: "asset" | "address" | "tx";
  chain: string;
  address?: string;
  id?: string;
  symbol?: string;
  label?: string;
}

/** The `crypto` block on {@link CreatePostOptions}. */
export interface CryptoDeclaration {
  refs?: CryptoRefInput[];
  about_crypto?: boolean;
  affiliation?: CryptoAffiliation;
}

/** A paid listing's reward in a token, for `metadata.reward`. */
export interface TokenReward {
  amount: string;
  asset: { chain: string; address?: string; symbol?: string; native?: true };
}

const BY_CAIP2 = new Map<string, ChainSlug>(
  Object.entries(CHAINS).map(([slug, caip]) => [caip, slug as ChainSlug]),
);
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const EVM_TX = /^0x[0-9a-fA-F]{64}$/;
const BTC_TX = /^[0-9a-fA-F]{64}$/;
const BTC_ADDRESS = /^(?:[13][1-9A-HJ-NP-Za-km-z]{25,34}|bc1[ac-hj-np-z02-9]{11,71})$/i;
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const SYMBOL = /^[A-Z0-9][A-Z0-9._-]{0,31}$/;
const AMOUNT = /^(?:0|[1-9][0-9]{0,29})(?:\.[0-9]{1,18})?$/;
const AFFILIATIONS: readonly CryptoAffiliation[] = ["none", "holder", "team", "paid"];

/** How many bytes a base58 string decodes to, or `null` if it is not base58. */
function base58Length(text: string): number | null {
  let n = 0n;
  for (const ch of text) {
    const i = B58.indexOf(ch);
    if (i < 0) return null;
    n = n * 58n + BigInt(i);
  }
  const leading = text.length - text.replace(/^1+/, "").length;
  const bytes = n === 0n ? 0 : Math.ceil(n.toString(2).length / 8);
  return leading + bytes;
}

function chainSlug(chain: string): ChainSlug {
  const name = chain.trim();
  const lower = name.toLowerCase();
  if (lower in CHAINS) return lower as ChainSlug;
  const slug = BY_CAIP2.get(name);
  if (slug === undefined) {
    throw new RangeError(
      `unknown chain ${JSON.stringify(chain)}; one of: ${Object.keys(CHAINS).join(", ")}`,
    );
  }
  return slug;
}

function checked(kind: CryptoRefInput["kind"], chain: ChainSlug, value: string): string {
  const family = CHAINS[chain].split(":")[0];
  const v = value.trim();
  let ok: boolean;
  if (family === "eip155") {
    ok = (kind === "tx" ? EVM_TX : EVM_ADDRESS).test(v);
  } else if (family === "solana") {
    ok = base58Length(v) === (kind === "tx" ? 64 : 32);
  } else {
    if (kind === "asset") {
      throw new RangeError("Bitcoin has no token contracts: use CryptoRef.address or CryptoRef.tx");
    }
    ok = (kind === "tx" ? BTC_TX : BTC_ADDRESS).test(v);
  }
  if (!ok) {
    const what = kind === "tx" ? "transaction id" : "address";
    throw new RangeError(`${JSON.stringify(v.slice(0, 90))} is not a valid ${chain} ${what}`);
  }
  return v;
}

function normalisedSymbol(symbol: string): string {
  const sym = symbol.trim().replace(/^\$+/, "").toUpperCase();
  if (!SYMBOL.test(sym)) {
    throw new RangeError(
      `symbol ${JSON.stringify(symbol)} must be 1-32 letters, digits, '.', '_' or '-'`,
    );
  }
  return sym;
}

/**
 * Builders for the references a post names, as the API takes them. Each
 * throws a `RangeError` for a shape the chain cannot have. The chain is a slug
 * (`"bsc"`) or a CAIP-2 id (`"eip155:56"`); see {@link CHAINS}.
 *
 * @example
 * const refs = [
 *   CryptoRef.asset("bsc", "0x90c8889f428F9Ebb77BB8f15CAD3a50a9aC680df", "FLAPJAX"),
 *   CryptoRef.address("bsc", "0x7C34E9e21eE28A49Ff0b84B61774119E6633359f", "treasury"),
 * ];
 */
export const CryptoRef = {
  /** A token contract (EVM) or a mint (Solana). `symbol` is display text. */
  asset(chain: string, address: string, symbol?: string): CryptoRefInput {
    const slug = chainSlug(chain);
    const ref: CryptoRefInput = {
      kind: "asset",
      chain: slug,
      address: checked("asset", slug, address),
    };
    if (symbol !== undefined) ref.symbol = normalisedSymbol(symbol);
    return ref;
  },
  /** An account or contract. `label` is your name for it (`"treasury"`). */
  address(chain: string, address: string, label?: string): CryptoRefInput {
    const slug = chainSlug(chain);
    const ref: CryptoRefInput = {
      kind: "address",
      chain: slug,
      address: checked("address", slug, address),
    };
    if (label !== undefined) {
      const text = label.split(/\s+/).filter(Boolean).join(" ");
      if (!text || text.length > 64) throw new RangeError("label must be 1-64 characters");
      ref.label = text;
    }
    return ref;
  },
  /** A transaction, by its id (an EVM hash, a Solana signature, a Bitcoin txid). */
  tx(chain: string, id: string): CryptoRefInput {
    const slug = chainSlug(chain);
    return { kind: "tx", chain: slug, id: checked("tx", slug, id) };
  },
};

/**
 * The `crypto` block for {@link CreatePostOptions}. Naming any reference files
 * the post under Crypto. `aboutCrypto: false` asks for it not to be: the
 * platform's classifier still decides, and a post it files anyway is reviewed.
 */
export function cryptoDeclaration(
  refs?: CryptoRefInput[],
  options: { aboutCrypto?: boolean; affiliation?: CryptoAffiliation } = {},
): CryptoDeclaration {
  const block: CryptoDeclaration = {};
  if (refs !== undefined) {
    if (refs.length > MAX_CRYPTO_REFS)
      throw new RangeError(`at most ${MAX_CRYPTO_REFS} references a post`);
    if (refs.length > 0 && options.aboutCrypto === false) {
      throw new RangeError(
        "references say the post is about crypto; aboutCrypto: false contradicts them",
      );
    }
    block.refs = [...refs];
  }
  if (options.aboutCrypto !== undefined) block.about_crypto = options.aboutCrypto;
  if (options.affiliation !== undefined) {
    if (!AFFILIATIONS.includes(options.affiliation)) {
      throw new RangeError(`affiliation must be one of ${AFFILIATIONS.join(", ")}`);
    }
    block.affiliation = options.affiliation;
  }
  return block;
}

/**
 * A paid task's or offer's reward in a token, for `metadata.reward`, beside
 * its sats fields, never instead of them: the marketplace still settles in
 * sats, and a token reward is settled by the poster, not by the platform.
 * `amount` is a decimal string (`"500000"`, `"0.25"`) or a bigint; a `number`
 * is refused, so nothing rounds it.
 */
export function tokenReward(
  amount: string | bigint,
  chain: string,
  options: { address?: string; symbol?: string; native?: boolean } = {},
): TokenReward {
  if (typeof amount !== "string" && typeof amount !== "bigint") {
    throw new RangeError("amount must be a decimal string or a bigint, not a number");
  }
  const text = typeof amount === "bigint" ? amount.toString() : amount.trim();
  if (!AMOUNT.test(text) || !/[1-9]/.test(text)) {
    throw new RangeError(
      `amount ${JSON.stringify(text.slice(0, 40))} must be a positive decimal, up to 18 places`,
    );
  }
  const slug = chainSlug(chain);
  if (options.native === true) {
    if (options.address !== undefined)
      throw new RangeError("a reward is either native or a token address, not both");
    return { amount: text, asset: { chain: slug, native: true } };
  }
  if (options.address === undefined)
    throw new RangeError("a token reward needs the token's address, or native: true");
  const { kind: _kind, ...asset } = CryptoRef.asset(slug, options.address, options.symbol);
  return { amount: text, asset: asset as TokenReward["asset"] };
}
