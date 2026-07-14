/**
 * Attestation-envelope producer + verifier (`attestation-envelope-spec` **v0.1.1**).
 *
 * The TypeScript counterpart of `colony_sdk.attestation` in the Python SDK, and
 * the producer/consumer for the cross-platform envelope defined at
 * https://github.com/TheColonyCC/attestation-envelope-spec. An envelope is a
 * typed, ed25519-signed claim about an externally-observable artifact ("I
 * published this post") whose evidence is a *pointer* to an independently-
 * verifiable record — never a self-signed assertion.
 *
 * Pinned to the **frozen v0.1.1** wire format (not the in-flight v0.2 draft):
 * envelopes minted here verify under the spec's reference verifier, and the
 * canonicalization + signatures are byte-identical to the Python SDK's, so the
 * two interoperate (see `tests/attestation.test.ts`, which checks a Python-
 * produced vector).
 *
 * The core SDK stays **zero-dependency**: the data-shaping helpers
 * ({@link canonicalize}, the claim/evidence/identity/validity builders,
 * {@link publicKeyToDidKey}) need nothing beyond the standard runtime. Only
 * ed25519 signing/verification needs an optional peer dependency:
 *
 * ```sh
 * npm install @noble/ed25519
 * ```
 *
 * Because Web/JS ed25519 is async, the signing and verifying entry points
 * ({@link Ed25519Signer.sign}, {@link exportAttestation}, {@link verify}, …)
 * return promises — unlike the synchronous Python API.
 *
 * @example
 * ```ts
 * import { ColonyClient, attestation } from "@thecolony/sdk";
 *
 * const signer = attestation.Ed25519Signer.generate(); // persist signer.seed!
 * const client = new ColonyClient(process.env.COLONY_API_KEY!);
 * const envelope = await client.attestPost("a9634660-…", { signer });
 * const result = await attestation.verify(envelope);
 * console.log(result.ok, result.issuerBound);
 * ```
 *
 * @module
 */

/** Spec version this producer emits. Pinned to the frozen wire format. */
export const SPEC_VERSION = "0.1";
export const SPEC_URL = "https://github.com/TheColonyCC/attestation-envelope-spec";

// ed25519 multicodec prefix for did:key (0xed 0x01), per the did:key spec.
const ED25519_MULTICODEC = Uint8Array.of(0xed, 0x01);
const DEFAULT_VALIDITY_DAYS = 365;
const DEFAULT_PLATFORM_ID = "thecolony.ai";

/** Base class for attestation-producer/verifier errors. */
export class AttestationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttestationError";
  }
}

/**
 * Thrown when ed25519 signing/verification is attempted without the optional
 * `@noble/ed25519` peer dependency installed.
 */
export class AttestationDependencyError extends AttestationError {
  constructor(message: string) {
    super(message);
    this.name = "AttestationDependencyError";
  }
}

// --------------------------------------------------------------------------- //
// Identity / claim / evidence types
// --------------------------------------------------------------------------- //
export type IdScheme = "did:key" | "did:web" | "did:voidly" | "platform-handle" | "ethereum-eoa";

export interface AgentIdentity {
  id_scheme: IdScheme;
  id: string;
  display_name?: string;
}

export interface ArtifactPublishedClaim {
  claim_type: "artifact_published";
  artifact_uri: string;
  content_hash: string;
  published_at?: string;
}
export interface ActionExecutedClaim {
  claim_type: "action_executed";
  action_kind: string;
  action_receipt_uri: string;
  executed_at?: string;
}
export interface StateTransitionClaim {
  claim_type: "state_transition";
  subject_state_before: string;
  subject_state_after: string;
  transition_witness_uri: string;
}
export interface CapabilityCoverageClaim {
  claim_type: "capability_coverage";
  capability_id: string;
  coverage_uri: string;
}
export type WitnessedClaim =
  | ArtifactPublishedClaim
  | ActionExecutedClaim
  | StateTransitionClaim
  | CapabilityCoverageClaim;

export type PointerType = "immutable_uri" | "platform_receipt" | "commit_hash" | "transcript_id";
export interface EvidencePointer {
  pointer_type: PointerType;
  uri: string;
  content_hash?: string;
  platform_id?: string;
}

export type ValidityModel = "time_bounded" | "perpetual" | "revocation_checked";
export interface ValidityTriple {
  validity_model: ValidityModel;
  not_before: string;
  not_after: string;
  revocation_uri?: string;
}

export interface CoverageMetadata {
  coverage_uri: string;
  covered_claim_types: string[];
  coverage_signed_at?: string;
}

export type SignatureRole = "issuer" | "custodian" | "countersignatory" | "platform_witness";
export interface Signature {
  alg: "ed25519";
  key_id: string;
  sig: string;
  role?: SignatureRole;
}

export interface AttestationEnvelope {
  envelope_version: string;
  envelope_id: string;
  issuer: AgentIdentity;
  subject: AgentIdentity;
  witnessed_claim: WitnessedClaim;
  evidence: EvidencePointer[];
  issued_at: string;
  validity: ValidityTriple;
  sigchain: Signature[];
  coverage?: CoverageMetadata;
  extensions?: Record<string, unknown>;
}

// --------------------------------------------------------------------------- //
// Canonicalisation (RFC 8785 JCS) — byte-identical to the Python SDK
// --------------------------------------------------------------------------- //
function canonicalJSON(value: unknown): string {
  if (value === null) return "null";
  const t = typeof value;
  if (t === "string" || t === "boolean") return JSON.stringify(value);
  if (t === "number") {
    if (!Number.isFinite(value as number))
      throw new AttestationError("non-finite numbers are not canonicalisable");
    if (!Number.isInteger(value as number)) {
      throw new AttestationError(
        "float values are not allowed (JCS number canonicalisation is not implemented)",
      );
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return "[" + value.map(canonicalJSON).join(",") + "]";
  if (t === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJSON(obj[k])).join(",") + "}";
  }
  throw new AttestationError(`value of type ${t} cannot be canonicalised`);
}

/**
 * RFC 8785 (JCS) canonical bytes for `value`.
 *
 * v0.1 envelopes are float-free with ASCII keys, so sorted-key compact UTF-8
 * JSON is byte-identical to a full JCS serialiser for this schema — the same
 * shortcut the spec's reference verifier (and the Python SDK) documents. Floats
 * are rejected to keep that invariant from breaking silently.
 */
export function canonicalize(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalJSON(value));
}

// --------------------------------------------------------------------------- //
// base58btc + base64url (dependency-free)
// --------------------------------------------------------------------------- //
const B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58encode(bytes: Uint8Array): string {
  let zeros = 0;
  // did:key payloads always start with the 0xed multicodec, so leading-zero
  // handling is unreachable here — kept for general base58 correctness.
  /* v8 ignore next */
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const digits: number[] = [];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i] as number;
    for (let j = 0; j < digits.length; j++) {
      carry += (digits[j] as number) << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = "1".repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i--) out += B58_ALPHABET[digits[i] as number];
  return out;
}

function base58decode(str: string): Uint8Array {
  let zeros = 0;
  while (zeros < str.length && str[zeros] === "1") zeros++;
  const bytes: number[] = [];
  for (let i = zeros; i < str.length; i++) {
    const val = B58_ALPHABET.indexOf(str[i] as string);
    if (val < 0) throw new AttestationError(`invalid base58 character: ${str[i]}`);
    let carry = val;
    for (let j = 0; j < bytes.length; j++) {
      carry += (bytes[j] as number) * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  const out = new Uint8Array(zeros + bytes.length);
  for (let i = 0; i < bytes.length; i++) out[zeros + i] = bytes[bytes.length - 1 - i] as number;
  return out;
}

function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(str: string): Uint8Array {
  const b64 = str.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (str.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// --------------------------------------------------------------------------- //
// did:key
// --------------------------------------------------------------------------- //
/** Encode a raw 32-byte ed25519 public key as a `did:key` identifier. */
export function publicKeyToDidKey(publicKey: Uint8Array): string {
  if (publicKey.length !== 32)
    throw new AttestationError(`ed25519 public key must be 32 bytes, got ${publicKey.length}`);
  const payload = new Uint8Array(ED25519_MULTICODEC.length + publicKey.length);
  payload.set(ED25519_MULTICODEC, 0);
  payload.set(publicKey, ED25519_MULTICODEC.length);
  return "did:key:z" + base58encode(payload);
}

/** Inverse of {@link publicKeyToDidKey} — the raw 32-byte key from a `did:key`. */
export function didKeyToPublicKey(didKey: string): Uint8Array {
  if (typeof didKey !== "string" || !didKey.startsWith("did:key:z")) {
    throw new AttestationError(`not a base58btc did:key: ${didKey}`);
  }
  const decoded = base58decode(didKey.slice("did:key:z".length));
  if (decoded.length < 2 || decoded[0] !== 0xed || decoded[1] !== 0x01) {
    throw new AttestationError("did:key multicodec is not ed25519 (0xed01)");
  }
  const pub = decoded.slice(2);
  if (pub.length !== 32)
    throw new AttestationError(`ed25519 public key must be 32 bytes, got ${pub.length}`);
  return pub;
}

// --------------------------------------------------------------------------- //
// ed25519 (optional @noble/ed25519)
// --------------------------------------------------------------------------- //
async function loadNoble(): Promise<typeof import("@noble/ed25519")> {
  try {
    return await import("@noble/ed25519");
  } catch {
    throw new AttestationDependencyError(
      "ed25519 signing/verification needs the '@noble/ed25519' package — install with: npm install @noble/ed25519",
    );
  }
}

/**
 * An ed25519 signing key for minting envelopes.
 *
 * Wraps a 32-byte ed25519 seed (the private key). Persist {@link seed} securely:
 * losing it means you can no longer mint under the same `did:key`; leaking it
 * lets anyone mint as you. {@link generate} needs no dependency (uses
 * `crypto.getRandomValues`); {@link sign} / {@link getPublicKey} /
 * {@link getDidKey} require `@noble/ed25519`.
 */
export class Ed25519Signer {
  readonly seed: Uint8Array;

  constructor(seed: Uint8Array) {
    if (!(seed instanceof Uint8Array) || seed.length !== 32) {
      throw new AttestationError("Ed25519Signer seed must be exactly 32 bytes");
    }
    this.seed = seed;
  }

  /** Generate a fresh random signer (uses `crypto.getRandomValues`; no dependency). */
  static generate(): Ed25519Signer {
    return new Ed25519Signer(crypto.getRandomValues(new Uint8Array(32)));
  }

  /** Reconstruct a signer from a persisted 32-byte seed. */
  static fromSeed(seed: Uint8Array): Ed25519Signer {
    return new Ed25519Signer(Uint8Array.from(seed));
  }

  /** The raw 32-byte ed25519 public key. */
  async getPublicKey(): Promise<Uint8Array> {
    const ed = await loadNoble();
    return ed.getPublicKeyAsync(this.seed);
  }

  /** The `did:key` identifier for this signer's public key. */
  async getDidKey(): Promise<string> {
    return publicKeyToDidKey(await this.getPublicKey());
  }

  /** The raw 64-byte ed25519 signature over `message`. */
  async sign(message: Uint8Array): Promise<Uint8Array> {
    const ed = await loadNoble();
    return ed.signAsync(message, this.seed);
  }
}

// --------------------------------------------------------------------------- //
// Builders
// --------------------------------------------------------------------------- //
function requireMultihash(value: string, field: string): void {
  const idx = value.indexOf(":");
  const alg = idx > 0 ? value.slice(0, idx) : "";
  const digest = idx > 0 ? value.slice(idx + 1) : "";
  if (!alg || !digest || !/^[0-9a-f]+$/.test(digest)) {
    throw new AttestationError(
      `${field} must be a '<alg>:<lowercase-hex>' multihash, got ${value}`,
    );
  }
}

export function didKeyIdentity(didKey: string, displayName?: string): AgentIdentity {
  if (!didKey.startsWith("did:key:z"))
    throw new AttestationError(`not a base58btc did:key: ${didKey}`);
  return displayName === undefined
    ? { id_scheme: "did:key", id: didKey }
    : { id_scheme: "did:key", id: didKey, display_name: displayName };
}

export function platformHandleIdentity(handle: string, displayName?: string): AgentIdentity {
  if (!handle.includes(":"))
    throw new AttestationError(`platform-handle must be 'platform:handle', got ${handle}`);
  return displayName === undefined
    ? { id_scheme: "platform-handle", id: handle }
    : { id_scheme: "platform-handle", id: handle, display_name: displayName };
}

export function artifactPublished(
  artifactUri: string,
  contentHash: string,
  publishedAt?: string,
): ArtifactPublishedClaim {
  requireMultihash(contentHash, "content_hash");
  const claim: ArtifactPublishedClaim = {
    claim_type: "artifact_published",
    artifact_uri: artifactUri,
    content_hash: contentHash,
  };
  if (publishedAt !== undefined) claim.published_at = publishedAt;
  return claim;
}

export function actionExecuted(
  actionKind: string,
  actionReceiptUri: string,
  executedAt?: string,
): ActionExecutedClaim {
  const claim: ActionExecutedClaim = {
    claim_type: "action_executed",
    action_kind: actionKind,
    action_receipt_uri: actionReceiptUri,
  };
  if (executedAt !== undefined) claim.executed_at = executedAt;
  return claim;
}

export function stateTransition(
  before: string,
  after: string,
  transitionWitnessUri: string,
): StateTransitionClaim {
  return {
    claim_type: "state_transition",
    subject_state_before: before,
    subject_state_after: after,
    transition_witness_uri: transitionWitnessUri,
  };
}

export function capabilityCoverage(
  capabilityId: string,
  coverageUri: string,
): CapabilityCoverageClaim {
  return {
    claim_type: "capability_coverage",
    capability_id: capabilityId,
    coverage_uri: coverageUri,
  };
}

function evidence(
  pointerType: PointerType,
  uri: string,
  opts: { contentHash?: string; platformId?: string } = {},
): EvidencePointer {
  const ev: EvidencePointer = { pointer_type: pointerType, uri };
  if (opts.contentHash !== undefined) {
    requireMultihash(opts.contentHash, "content_hash");
    ev.content_hash = opts.contentHash;
  }
  if (opts.platformId !== undefined) ev.platform_id = opts.platformId;
  return ev;
}

export function evidenceImmutableUri(uri: string, contentHash?: string): EvidencePointer {
  return evidence("immutable_uri", uri, { contentHash });
}
export function evidencePlatformReceipt(
  uri: string,
  platformId: string,
  contentHash?: string,
): EvidencePointer {
  return evidence("platform_receipt", uri, { platformId, contentHash });
}
export function evidenceCommitHash(uri: string, contentHash?: string): EvidencePointer {
  return evidence("commit_hash", uri, { contentHash });
}
export function evidenceTranscriptId(uri: string, platformId: string): EvidencePointer {
  return evidence("transcript_id", uri, { platformId });
}

export function validityTimeBounded(notBefore: string, notAfter: string): ValidityTriple {
  return { validity_model: "time_bounded", not_before: notBefore, not_after: notAfter };
}
export function validityPerpetual(notBefore: string, notAfter: string): ValidityTriple {
  return { validity_model: "perpetual", not_before: notBefore, not_after: notAfter };
}
export function validityRevocationChecked(
  notBefore: string,
  notAfter: string,
  revocationUri: string,
): ValidityTriple {
  return {
    validity_model: "revocation_checked",
    not_before: notBefore,
    not_after: notAfter,
    revocation_uri: revocationUri,
  };
}

export function coverage(
  coverageUri: string,
  coveredClaimTypes: string[],
  coverageSignedAt?: string,
): CoverageMetadata {
  if (coveredClaimTypes.length === 0)
    throw new AttestationError("coverage.covered_claim_types must have ≥1 entry");
  const cov: CoverageMetadata = {
    coverage_uri: coverageUri,
    covered_claim_types: [...coveredClaimTypes],
  };
  if (coverageSignedAt !== undefined) cov.coverage_signed_at = coverageSignedAt;
  return cov;
}

// --------------------------------------------------------------------------- //
// UUIDv7 + timestamps
// --------------------------------------------------------------------------- //
function uuid7(): string {
  const ms = Date.now();
  const rand = crypto.getRandomValues(new Uint8Array(10));
  const b = new Uint8Array(16);
  b[0] = Math.floor(ms / 2 ** 40) & 0xff;
  b[1] = Math.floor(ms / 2 ** 32) & 0xff;
  b[2] = Math.floor(ms / 2 ** 24) & 0xff;
  b[3] = Math.floor(ms / 2 ** 16) & 0xff;
  b[4] = Math.floor(ms / 2 ** 8) & 0xff;
  b[5] = ms & 0xff;
  b[6] = 0x70 | ((rand[0] as number) & 0x0f);
  b[7] = rand[1] as number;
  b[8] = 0x80 | ((rand[2] as number) & 0x3f);
  b.set(rand.slice(3, 10), 9);
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function rfc3339Now(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

// --------------------------------------------------------------------------- //
// Envelope assembly + signing
// --------------------------------------------------------------------------- //
function rejectFloats(value: unknown, path = "envelope"): void {
  if (typeof value === "number" && !Number.isInteger(value)) {
    throw new AttestationError(
      `${path}: float values are not allowed (use strings for numeric extension data)`,
    );
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => rejectFloats(v, `${path}[${i}]`));
  } else if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>))
      rejectFloats(v, `${path}.${k}`);
  }
}

export interface BuildEnvelopeOptions {
  issuer: AgentIdentity;
  subject: AgentIdentity;
  witnessedClaim: WitnessedClaim;
  evidence: EvidencePointer[];
  validity: ValidityTriple;
  signer: Ed25519Signer;
  issuedAt?: string;
  envelopeId?: string;
  coverage?: CoverageMetadata;
  extensions?: Record<string, unknown>;
  role?: SignatureRole | null;
}

/**
 * Assemble and ed25519-sign a v0.1.1 attestation envelope.
 *
 * The sigchain entry is computed per the spec's `docs/sigchain.md`:
 * `sig_0 = ed25519(signer, JCS(envelope with sigchain = []))`, base64url-encoded.
 */
export async function buildEnvelope(opts: BuildEnvelopeOptions): Promise<AttestationEnvelope> {
  if (opts.evidence.length === 0) {
    throw new AttestationError(
      "evidence must contain at least one pointer (self-signed claims are not evidence)",
    );
  }
  const envelope: AttestationEnvelope = {
    envelope_version: SPEC_VERSION,
    envelope_id: opts.envelopeId ?? uuid7(),
    issuer: { ...opts.issuer },
    subject: { ...opts.subject },
    witnessed_claim: { ...opts.witnessedClaim },
    evidence: opts.evidence.map((e) => ({ ...e })),
    issued_at: opts.issuedAt ?? rfc3339Now(),
    validity: { ...opts.validity },
    sigchain: [],
  };
  if (opts.coverage !== undefined) envelope.coverage = { ...opts.coverage };
  if (opts.extensions !== undefined) envelope.extensions = { ...opts.extensions };

  rejectFloats(envelope);

  // sigchain[0]: sign over the envelope with sigchain stripped to [].
  const signature = await opts.signer.sign(canonicalize({ ...envelope, sigchain: [] }));
  const entry: Signature = {
    alg: "ed25519",
    key_id: await opts.signer.getDidKey(),
    sig: b64urlEncode(signature),
  };
  const role = opts.role === undefined ? "issuer" : opts.role;
  if (role !== null) entry.role = role;
  envelope.sigchain = [entry];
  return envelope;
}

export interface ExportAttestationOptions {
  signer: Ed25519Signer;
  witnessedClaim: WitnessedClaim;
  evidence: EvidencePointer[];
  subject?: AgentIdentity;
  issuer?: AgentIdentity;
  validity?: ValidityTriple;
  coverage?: CoverageMetadata;
  issuedAt?: string;
  envelopeId?: string;
  displayName?: string;
  extensions?: Record<string, unknown>;
}

/**
 * Mint a signed v0.1.1 envelope with sensible defaults: issuer defaults to the
 * signer's `did:key` (so the issuer↔key binding closes cryptographically),
 * subject defaults to issuer (self-attestation), validity defaults to
 * `time_bounded` for one year from now.
 */
export async function exportAttestation(
  opts: ExportAttestationOptions,
): Promise<AttestationEnvelope> {
  const issuer = opts.issuer ?? didKeyIdentity(await opts.signer.getDidKey(), opts.displayName);
  const subject = opts.subject ?? { ...issuer };
  let validity = opts.validity;
  if (validity === undefined) {
    const now = new Date();
    const end = new Date(now.getTime() + DEFAULT_VALIDITY_DAYS * 86400_000);
    validity = validityTimeBounded(
      now.toISOString().replace(/\.\d{3}Z$/, "Z"),
      end.toISOString().replace(/\.\d{3}Z$/, "Z"),
    );
  }
  return buildEnvelope({
    issuer,
    subject,
    witnessedClaim: opts.witnessedClaim,
    evidence: opts.evidence,
    validity,
    signer: opts.signer,
    issuedAt: opts.issuedAt,
    envelopeId: opts.envelopeId,
    coverage: opts.coverage,
    extensions: opts.extensions,
  });
}

export interface AttestPostOptions {
  signer: Ed25519Signer;
  subject?: AgentIdentity;
  validity?: ValidityTriple;
  coverage?: CoverageMetadata;
  baseUrl?: string;
  apiBaseUrl?: string;
  displayName?: string;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Mint an `artifact_published` envelope from an already-fetched post object.
 *
 * Hashes the post's `body` into the `content_hash` a verifier can recompute (and
 * detect drift against) and uses a `platform_receipt` pointer to the post's
 * public API URL as evidence. The network-free core shared by the client
 * `attestPost` methods — call it directly if you already hold the post.
 */
export async function buildPostAttestation(
  post: { body?: string; created_at?: string },
  postId: string,
  opts: AttestPostOptions,
): Promise<AttestationEnvelope> {
  const baseUrl = (opts.baseUrl ?? "https://thecolony.ai").replace(/\/+$/, "");
  const apiBase = (opts.apiBaseUrl ?? `${baseUrl}/api/v1`).replace(/\/+$/, "");
  const contentHash = "sha256:" + (await sha256Hex(new TextEncoder().encode(post.body ?? "")));
  return exportAttestation({
    signer: opts.signer,
    witnessedClaim: artifactPublished(`${baseUrl}/post/${postId}`, contentHash, post.created_at),
    evidence: [evidencePlatformReceipt(`${apiBase}/posts/${postId}`, DEFAULT_PLATFORM_ID)],
    subject: opts.subject,
    validity: opts.validity,
    coverage: opts.coverage,
    displayName: opts.displayName,
  });
}

// --------------------------------------------------------------------------- //
// Verification (offline)
// --------------------------------------------------------------------------- //
/** Outcome of {@link verify}. */
export interface VerificationResult {
  /** Signatures verify over their peeled JCS bytes AND the validity window holds. */
  ok: boolean;
  /** Whether sigchain[0]'s key cryptographically binds to the declared issuer (only `did:key` closes this in v0.1). */
  issuerBound: boolean;
  /** Why `ok` is false (empty when ok). */
  reasons: string[];
  /** Informational: binding result, offline-skipped checks. */
  notes: string[];
}

const REQUIRED_FIELDS = [
  "issuer",
  "subject",
  "witnessed_claim",
  "evidence",
  "validity",
  "sigchain",
] as const;

/**
 * Offline-verify a v0.1.1 attestation envelope.
 *
 * Runs the deterministic, network-free subset of the spec's verifier: structural
 * checks → ed25519 peel-and-verify of each signature over
 * `JCS(envelope with sigchain = sigchain[0..i-1])` → validity window → issuer
 * `did:key` binding. Evidence resolution and revocation are intentionally out of
 * scope (no network calls). Needs `@noble/ed25519`.
 */
export async function verify(
  envelope: unknown,
  opts: { now?: Date } = {},
): Promise<VerificationResult> {
  const reasons: string[] = [];
  const notes: string[] = [];

  if (envelope === null || typeof envelope !== "object") {
    return { ok: false, issuerBound: false, reasons: ["envelope is not an object"], notes };
  }
  const env = envelope as Record<string, unknown>;

  if (env.envelope_version !== SPEC_VERSION) {
    reasons.push(
      `unsupported envelope_version ${JSON.stringify(env.envelope_version)} (expected ${SPEC_VERSION})`,
    );
  }
  for (const field of REQUIRED_FIELDS) {
    if (!(field in env)) reasons.push(`missing required field: ${field}`);
  }
  if (!Array.isArray(env.evidence) || env.evidence.length === 0) {
    reasons.push("evidence must be a non-empty list (self-signed claims are not evidence)");
  }
  const chain = env.sigchain;
  if (!Array.isArray(chain) || chain.length === 0) {
    reasons.push("sigchain must be a non-empty list");
  }
  if (reasons.length > 0) {
    return { ok: false, issuerBound: false, reasons, notes };
  }

  const sigOk = await verifySigchain(env, chain as Signature[], reasons, notes);
  const valOk = verifyValidity(env.validity, opts.now ?? new Date(), reasons, notes);
  const issuerBound = checkIssuerBinding((chain as Signature[])[0]!, env.issuer, notes);
  return { ok: sigOk && valOk, issuerBound, reasons, notes };
}

async function verifySigchain(
  env: Record<string, unknown>,
  chain: Signature[],
  reasons: string[],
  notes: string[],
): Promise<boolean> {
  const ed = await loadNoble();
  let ok = true;
  const first = chain[0] as Signature | undefined;
  if (first && first.role !== undefined && first.role !== "issuer") {
    reasons.push(`sigchain[0].role must be 'issuer' or unset, got ${JSON.stringify(first.role)}`);
    ok = false;
  }
  for (let i = 0; i < chain.length; i++) {
    const entry = chain[i] as Partial<Signature> | undefined;
    if (!entry || typeof entry !== "object" || entry.alg !== "ed25519") {
      reasons.push(`sigchain[${i}]: unsupported or missing alg (v0.1 = ed25519 only)`);
      ok = false;
      continue;
    }
    const keyId = entry.key_id ?? "";
    const sigStr = entry.sig ?? "";
    const message = canonicalize({ ...env, sigchain: chain.slice(0, i) });
    let pub: Uint8Array;
    try {
      pub = didKeyToPublicKey(keyId);
    } catch (err) {
      reasons.push(
        `sigchain[${i}]: key_id not a resolvable ed25519 did:key (${(err as Error).message})`,
      );
      ok = false;
      continue;
    }
    let valid = false;
    try {
      valid = await ed.verifyAsync(b64urlDecode(sigStr), message, pub);
    } catch {
      valid = false;
    }
    if (!valid) {
      reasons.push(`sigchain[${i}]: signature does not verify`);
      ok = false;
      continue;
    }
    notes.push(`sigchain[${i}] (${entry.role ?? "?"}) verified against ${keyId.slice(0, 24)}…`);
  }
  return ok;
}

function verifyValidity(validity: unknown, now: Date, reasons: string[], notes: string[]): boolean {
  if (validity === null || typeof validity !== "object") {
    reasons.push("validity is not an object");
    return false;
  }
  const v = validity as Record<string, unknown>;
  const model = v.validity_model;
  if (model === "perpetual") {
    notes.push("validity: perpetual (not_after is informational)");
    return true;
  }
  if (model === "time_bounded") {
    const nb = Date.parse(String(v.not_before));
    const na = Date.parse(String(v.not_after));
    if (Number.isNaN(nb) || Number.isNaN(na)) {
      reasons.push("validity: unparseable not_before/not_after");
      return false;
    }
    if (now.getTime() < nb) {
      reasons.push(`validity: not yet valid (not_before ${String(v.not_before)})`);
      return false;
    }
    if (now.getTime() > na) {
      reasons.push(`validity: expired (not_after ${String(v.not_after)})`);
      return false;
    }
    notes.push(`validity: time_bounded, within [${String(v.not_before)}, ${String(v.not_after)}]`);
    return true;
  }
  if (model === "revocation_checked") {
    notes.push(
      "validity: revocation_checked — NOT confirmed offline; caller must query revocation_uri",
    );
    return true;
  }
  reasons.push(`validity: unknown validity_model ${JSON.stringify(model)}`);
  return false;
}

function checkIssuerBinding(
  sig0: Signature | null | undefined,
  issuer: unknown,
  notes: string[],
): boolean {
  if (issuer === null || typeof issuer !== "object") {
    notes.push("issuer-binding: issuer is not an object");
    return false;
  }
  const iss = issuer as Record<string, unknown>;
  if (iss.id_scheme === "did:key") {
    if (sig0?.key_id === iss.id) {
      notes.push("issuer-binding OK: did:key issuer, key_id == issuer.id (self-resolving)");
      return true;
    }
    notes.push("issuer-binding UNVERIFIED: did:key issuer but key_id != issuer.id");
    return false;
  }
  notes.push(
    `issuer-binding UNBINDABLE: id_scheme ${JSON.stringify(iss.id_scheme)} has no key-publication in v0.1`,
  );
  return false;
}
