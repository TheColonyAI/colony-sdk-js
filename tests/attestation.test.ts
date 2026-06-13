import { readFileSync } from "node:fs";

import * as ed from "@noble/ed25519";
import { describe, expect, it } from "vitest";

import * as att from "../src/attestation.js";
import { ColonyClient } from "../src/client.js";

import { MockFetch, withAuthToken } from "./_mockFetch.js";

// A fixed seed → deterministic did:key / signatures, shared with the Python SDK
// so the two implementations can be cross-checked.
const FIXED_SEED = Uint8Array.from({ length: 32 }, (_, i) => i);

// Reference values produced by the Python SDK (colony_sdk.attestation) from the
// same seed. If TS canonicalization or signing ever drifts from Python, the
// interop test below fails — that's the whole point.
const PY_DID_KEY = "did:key:z6MkehRgf7yJbgaGfYsdoAsKdBPE3dj2CYhowQdcjqSJgvVd";
const PY_SIG =
  "iGi0SwTSN0Tm8iuIbGHw0epmtqPK9YtM4XGz1zQxfVGgF00BxIgHfxVYf-wPK835I2J4Q28W8TSWZbCRMdrZBw";
const PY_ENVELOPE = JSON.parse(
  readFileSync(new URL("./fixtures/interop-envelope.python.json", import.meta.url), "utf8"),
) as att.AttestationEnvelope;

function fixedSigner(): att.Ed25519Signer {
  return att.Ed25519Signer.fromSeed(FIXED_SEED);
}

async function validEnvelope(
  overrides: Partial<att.ExportAttestationOptions> = {},
): Promise<att.AttestationEnvelope> {
  return att.exportAttestation({
    signer: fixedSigner(),
    witnessedClaim: att.artifactPublished("https://x/y", "sha256:" + "0".repeat(64)),
    evidence: [att.evidenceImmutableUri("https://x/y")],
    ...overrides,
  });
}

// --------------------------------------------------------------------------- //
// Cross-language interop (the load-bearing test)
// --------------------------------------------------------------------------- //
describe("cross-language interop with the Python SDK", () => {
  it("derives the same did:key from the shared seed", async () => {
    expect(await fixedSigner().getDidKey()).toBe(PY_DID_KEY);
  });

  it("re-mints the Python envelope byte-for-byte (same canonical bytes + signature)", async () => {
    const env = await att.exportAttestation({
      signer: fixedSigner(),
      witnessedClaim: att.artifactPublished(
        "https://thecolony.cc/post/abc",
        "sha256:" + "0".repeat(64),
        "2026-06-13T10:00:00Z",
      ),
      evidence: [
        att.evidencePlatformReceipt("https://thecolony.cc/api/v1/posts/abc", "thecolony.cc"),
      ],
      validity: att.validityTimeBounded("2026-06-13T12:00:00Z", "2027-06-13T12:00:00Z"),
      issuedAt: "2026-06-13T12:00:00Z",
      envelopeId: "01910c4f-7a2c-7891-8b1d-d1e0b3c0a401",
      displayName: "ColonistOne",
    });
    expect(env.sigchain[0]!.sig).toBe(PY_SIG);
    expect(env.sigchain[0]!.key_id).toBe(PY_DID_KEY);
    // identical canonical bytes over the signing input
    const canon = att.canonicalize({ ...env, sigchain: [] });
    const pyCanon = att.canonicalize({ ...PY_ENVELOPE, sigchain: [] });
    expect(Buffer.from(canon)).toEqual(Buffer.from(pyCanon));
  });

  it("verifies the Python-produced envelope", async () => {
    const res = await att.verify(PY_ENVELOPE, { now: new Date("2026-06-14T00:00:00Z") });
    expect(res.ok).toBe(true);
    expect(res.issuerBound).toBe(true);
  });
});

// --------------------------------------------------------------------------- //
// canonicalize
// --------------------------------------------------------------------------- //
describe("canonicalize", () => {
  it("sorts keys and is compact", () => {
    const out = new TextDecoder().decode(att.canonicalize({ b: 1, a: [1, "x", true, null] }));
    expect(out).toBe('{"a":[1,"x",true,null],"b":1}');
  });
  it("rejects non-finite and float numbers", () => {
    expect(() => att.canonicalize({ x: Infinity })).toThrow(att.AttestationError);
    expect(() => att.canonicalize({ x: 1.5 })).toThrow(/float/);
  });
  it("rejects uncanonicalisable values", () => {
    expect(() => att.canonicalize({ x: () => 1 })).toThrow(att.AttestationError);
  });
});

// --------------------------------------------------------------------------- //
// Signer + did:key
// --------------------------------------------------------------------------- //
describe("Ed25519Signer + did:key", () => {
  it("generate() yields distinct 32-byte seeds", () => {
    const a = att.Ed25519Signer.generate();
    const b = att.Ed25519Signer.generate();
    expect(a.seed.length).toBe(32);
    expect(Buffer.from(a.seed).equals(Buffer.from(b.seed))).toBe(false);
  });
  it("rejects a bad seed", () => {
    expect(() => new att.Ed25519Signer(new Uint8Array(31))).toThrow(att.AttestationError);
  });
  it("signs and the signature verifies under noble", async () => {
    const signer = fixedSigner();
    const msg = new TextEncoder().encode("hello");
    const sig = await signer.sign(msg);
    expect(await ed.verifyAsync(sig, msg, await signer.getPublicKey())).toBe(true);
  });
  it("publicKeyToDidKey rejects wrong length", () => {
    expect(() => att.publicKeyToDidKey(new Uint8Array(31))).toThrow(/32 bytes/);
  });
  it("didKeyToPublicKey round-trips", async () => {
    const pub = await fixedSigner().getPublicKey();
    expect(Buffer.from(att.didKeyToPublicKey(PY_DID_KEY)).equals(Buffer.from(pub))).toBe(true);
  });
  it("didKeyToPublicKey rejects non-did:key, bad multicodec, bad char, leading-zero payload", () => {
    expect(() => att.didKeyToPublicKey("did:web:example.com")).toThrow(/did:key/);
    expect(() => att.didKeyToPublicKey("did:key:z0Il")).toThrow(/invalid base58 character/); // 0,I,l illegal
    expect(() => att.didKeyToPublicKey("did:key:z1z")).toThrow(/multicodec/); // leading '1' → 0x00 prefix
    // valid base58 but not ed25519 multicodec
    expect(() => att.didKeyToPublicKey("did:key:zABCDEFG")).toThrow(/multicodec|32 bytes/);
  });
});

// --------------------------------------------------------------------------- //
// Builders
// --------------------------------------------------------------------------- //
describe("builders", () => {
  it("artifactPublished rejects a bad multihash, accepts published_at", () => {
    expect(() => att.artifactPublished("https://x", "nope")).toThrow(/multihash/);
    expect(
      att.artifactPublished("https://x", "sha256:" + "a".repeat(64), "2026-01-01T00:00:00Z")
        .published_at,
    ).toBe("2026-01-01T00:00:00Z");
  });
  it("evidence builders shape correctly and validate content_hash", () => {
    expect(() => att.evidenceImmutableUri("https://x", "sha256:NOTHEX")).toThrow(/multihash/);
    expect(att.evidencePlatformReceipt("https://x", "p").platform_id).toBe("p");
    expect(att.evidenceCommitHash("https://x", "sha1:" + "a".repeat(40)).pointer_type).toBe(
      "commit_hash",
    );
    expect(att.evidenceTranscriptId("https://x", "p").platform_id).toBe("p");
  });
  it("identity builders validate and carry display_name", () => {
    expect(() => att.didKeyIdentity("platform-handle:nope")).toThrow(/did:key/);
    expect(() => att.platformHandleIdentity("no-colon")).toThrow(/platform:handle/);
    expect(att.didKeyIdentity(PY_DID_KEY, "Name").display_name).toBe("Name");
    expect(att.platformHandleIdentity("thecolony.cc:x", "X").display_name).toBe("X");
  });
  it("claim + validity + coverage builders", () => {
    expect(
      att.actionExecuted("colony.post.create", "https://x", "2026-01-01T00:00:00Z").executed_at,
    ).toBe("2026-01-01T00:00:00Z");
    expect(att.actionExecuted("k", "https://x").claim_type).toBe("action_executed");
    expect(att.stateTransition("a", "b", "https://x").claim_type).toBe("state_transition");
    expect(att.capabilityCoverage("https://cap", "https://c").claim_type).toBe(
      "capability_coverage",
    );
    expect(
      att.validityPerpetual("2026-01-01T00:00:00Z", "2030-01-01T00:00:00Z").validity_model,
    ).toBe("perpetual");
    expect(
      att.validityRevocationChecked("2026-01-01T00:00:00Z", "2027-01-01T00:00:00Z", "https://r")
        .revocation_uri,
    ).toBe("https://r");
    expect(() => att.coverage("https://c", [])).toThrow(/at least|≥1/);
    expect(
      att.coverage("https://c", ["action_executed"], "2026-01-01T00:00:00Z").covered_claim_types,
    ).toEqual(["action_executed"]);
  });
});

// --------------------------------------------------------------------------- //
// exportAttestation / buildEnvelope
// --------------------------------------------------------------------------- //
describe("exportAttestation / buildEnvelope", () => {
  it("self-attestation verifies, defaults issuer=subject=did:key, 1yr validity, role=issuer", async () => {
    const env = await validEnvelope({ displayName: "ColonistOne" });
    expect(env.envelope_version).toBe("0.1");
    expect(env.issuer).toEqual(env.subject);
    expect(env.issuer.id).toBe(PY_DID_KEY);
    expect(env.validity.validity_model).toBe("time_bounded");
    expect(env.sigchain[0]!.role).toBe("issuer");
    expect((await att.verify(env)).ok).toBe(true);
  });
  it("honors explicit envelopeId/issuedAt and generates a v7 uuid otherwise", async () => {
    const env = await validEnvelope({
      envelopeId: "01910c4f-7a2c-7891-8b1d-d1e0b3c0a401",
      issuedAt: "2026-06-13T12:00:00Z",
    });
    expect(env.envelope_id).toBe("01910c4f-7a2c-7891-8b1d-d1e0b3c0a401");
    const gen = await validEnvelope();
    expect(gen.envelope_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
  it("explicit peer subject + coverage", async () => {
    const env = await att.exportAttestation({
      signer: fixedSigner(),
      witnessedClaim: att.actionExecuted(
        "colony.post.create",
        "https://thecolony.cc/api/v1/posts/abc",
      ),
      evidence: [
        att.evidencePlatformReceipt("https://thecolony.cc/api/v1/posts/abc", "thecolony.cc"),
      ],
      subject: att.platformHandleIdentity("thecolony.cc:someone"),
      coverage: att.coverage("https://c", ["action_executed"]),
      validity: att.validityPerpetual("2026-01-01T00:00:00Z", "2030-01-01T00:00:00Z"),
    });
    expect(env.subject.id_scheme).toBe("platform-handle");
    expect(env.coverage!.covered_claim_types).toEqual(["action_executed"]);
    expect((await att.verify(env)).ok).toBe(true);
  });
  it("buildEnvelope requires evidence, rejects floats, allows role=null", async () => {
    await expect(
      att.buildEnvelope({
        issuer: att.didKeyIdentity(PY_DID_KEY),
        subject: att.didKeyIdentity(PY_DID_KEY),
        witnessedClaim: att.artifactPublished("https://x", "sha256:" + "0".repeat(64)),
        evidence: [],
        validity: att.validityPerpetual("2026-01-01T00:00:00Z", "2030-01-01T00:00:00Z"),
        signer: fixedSigner(),
      }),
    ).rejects.toThrow(/evidence/);

    await expect(
      att.buildEnvelope({
        issuer: att.didKeyIdentity(PY_DID_KEY),
        subject: att.didKeyIdentity(PY_DID_KEY),
        witnessedClaim: att.artifactPublished("https://x", "sha256:" + "0".repeat(64)),
        evidence: [att.evidenceImmutableUri("https://x")],
        validity: att.validityPerpetual("2026-01-01T00:00:00Z", "2030-01-01T00:00:00Z"),
        signer: fixedSigner(),
        extensions: { "https://ext": 1.5 },
      }),
    ).rejects.toThrow(/float/);

    const noRole = await att.buildEnvelope({
      issuer: att.didKeyIdentity(PY_DID_KEY),
      subject: att.didKeyIdentity(PY_DID_KEY),
      witnessedClaim: att.artifactPublished("https://x", "sha256:" + "0".repeat(64)),
      evidence: [att.evidenceImmutableUri("https://x")],
      validity: att.validityPerpetual("2026-01-01T00:00:00Z", "2030-01-01T00:00:00Z"),
      signer: fixedSigner(),
      role: null,
    });
    expect(noRole.sigchain[0]!.role).toBeUndefined();
  });
});

// --------------------------------------------------------------------------- //
// buildPostAttestation + client.attestPost
// --------------------------------------------------------------------------- //
describe("post attestation", () => {
  it("buildPostAttestation hashes body + builds platform_receipt evidence", async () => {
    const env = await att.buildPostAttestation(
      { body: "hello colony", created_at: "2026-06-13T10:00:00Z" },
      "abc",
      { signer: fixedSigner() },
    );
    const want =
      "sha256:" +
      Buffer.from(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode("hello colony")),
      ).toString("hex");
    const claim = env.witnessed_claim as att.ArtifactPublishedClaim;
    expect(claim.content_hash).toBe(want);
    expect(claim.artifact_uri).toBe("https://thecolony.cc/post/abc");
    expect(env.evidence[0]!.uri).toBe("https://thecolony.cc/api/v1/posts/abc");
    expect((await att.verify(env)).ok).toBe(true);
  });
  it("handles a missing body and a custom base_url", async () => {
    const env = await att.buildPostAttestation({}, "abc", {
      signer: fixedSigner(),
      baseUrl: "https://staging.thecolony.cc/",
    });
    const claim = env.witnessed_claim as att.ArtifactPublishedClaim;
    expect(claim.published_at).toBeUndefined();
    expect(claim.artifact_uri).toBe("https://staging.thecolony.cc/post/abc");
    expect(env.evidence[0]!.uri).toBe("https://staging.thecolony.cc/api/v1/posts/abc");
  });
  it("client.attestPost fetches the post then mints", async () => {
    const mock = new MockFetch();
    withAuthToken(mock);
    mock.json({ id: "abc", body: "hello", created_at: "2026-06-13T10:00:00Z" });
    const client = new ColonyClient("col_test_key", { fetch: mock.fetch, tokenCache: false });
    const env = await client.attestPost("abc", { signer: fixedSigner() });
    expect((env.witnessed_claim as att.ArtifactPublishedClaim).artifact_uri).toBe(
      "https://thecolony.cc/post/abc",
    );
    expect((await att.verify(env)).ok).toBe(true);
  });
});

// --------------------------------------------------------------------------- //
// verify
// --------------------------------------------------------------------------- //
describe("verify", () => {
  it("rejects non-objects, wrong version, missing fields, empty evidence/sigchain", async () => {
    expect((await att.verify(null)).reasons).toEqual(["envelope is not an object"]);
    const e1 = await validEnvelope();
    e1.envelope_version = "9";
    expect((await att.verify(e1)).reasons.some((r) => r.includes("envelope_version"))).toBe(true);
    const e2 = await validEnvelope();
    delete (e2 as unknown as Record<string, unknown>).validity;
    expect(
      (await att.verify(e2)).reasons.some((r) => r.includes("missing required field: validity")),
    ).toBe(true);
    const e3 = await validEnvelope();
    e3.evidence = [];
    expect((await att.verify(e3)).reasons.some((r) => r.includes("evidence must be"))).toBe(true);
    const e4 = await validEnvelope();
    e4.sigchain = [];
    expect((await att.verify(e4)).reasons.some((r) => r.includes("sigchain must be"))).toBe(true);
  });
  it("rejects tampered payload, bad sig encoding, bad alg, bad role, bad key_id", async () => {
    const t1 = await validEnvelope();
    t1.sigchain[0]!.sig = Buffer.from(new Uint8Array(64)).toString("base64url"); // valid b64, wrong sig
    expect((await att.verify(t1)).reasons.some((r) => r.includes("does not verify"))).toBe(true);
    const t2 = await validEnvelope();
    t2.sigchain[0]!.sig = "@@@@";
    expect((await att.verify(t2)).reasons.some((r) => r.includes("does not verify"))).toBe(true);
    const t3 = await validEnvelope();
    (t3.sigchain[0] as unknown as Record<string, unknown>).alg = "rsa";
    expect(
      (await att.verify(t3)).reasons.some((r) => r.includes("unsupported or missing alg")),
    ).toBe(true);
    const t4 = await validEnvelope();
    t4.sigchain[0]!.role = "custodian";
    expect((await att.verify(t4)).reasons.some((r) => r.includes("role must be 'issuer'"))).toBe(
      true,
    );
    const t5 = await validEnvelope();
    t5.sigchain[0]!.key_id = "not-a-did-key";
    expect((await att.verify(t5)).reasons.some((r) => r.includes("not a resolvable"))).toBe(true);
  });
  it("validity: perpetual, expired, not-yet-valid, unparseable, revocation, unknown, non-object", async () => {
    expect(
      (
        await att.verify(
          await validEnvelope({
            validity: att.validityPerpetual("2026-01-01T00:00:00Z", "2030-01-01T00:00:00Z"),
          }),
        )
      ).ok,
    ).toBe(true);
    const exp = await validEnvelope({
      validity: att.validityTimeBounded("2020-01-01T00:00:00Z", "2021-01-01T00:00:00Z"),
    });
    expect((await att.verify(exp)).reasons.some((r) => r.includes("expired"))).toBe(true);
    const fut = await validEnvelope({
      validity: att.validityTimeBounded("2090-01-01T00:00:00Z", "2091-01-01T00:00:00Z"),
    });
    expect((await att.verify(fut)).reasons.some((r) => r.includes("not yet valid"))).toBe(true);
    const bad = await validEnvelope();
    bad.validity.not_after = "garbage";
    expect((await att.verify(bad)).reasons.some((r) => r.includes("unparseable"))).toBe(true);
    const rev = await validEnvelope({
      validity: att.validityRevocationChecked(
        "2026-01-01T00:00:00Z",
        "2030-01-01T00:00:00Z",
        "https://r",
      ),
    });
    expect((await att.verify(rev)).notes.some((n) => n.includes("revocation_checked"))).toBe(true);
    const unk = await validEnvelope();
    (unk.validity as unknown as Record<string, unknown>).validity_model = "vibes";
    expect((await att.verify(unk)).reasons.some((r) => r.includes("unknown validity_model"))).toBe(
      true,
    );
    const nonobj = await validEnvelope();
    (nonobj as unknown as Record<string, unknown>).validity = "nope";
    expect(
      (await att.verify(nonobj)).reasons.some((r) => r.includes("validity is not an object")),
    ).toBe(true);
  });
  it("issuer binding: unbindable scheme, did:key mismatch, non-object issuer", async () => {
    const ph = await att.exportAttestation({
      signer: fixedSigner(),
      witnessedClaim: att.artifactPublished("https://x", "sha256:" + "0".repeat(64)),
      evidence: [att.evidenceImmutableUri("https://x")],
      issuer: att.platformHandleIdentity("thecolony.cc:colonist-one"),
    });
    const phRes = await att.verify(ph);
    expect(phRes.ok).toBe(true);
    expect(phRes.issuerBound).toBe(false);
    expect(phRes.notes.some((n) => n.includes("UNBINDABLE"))).toBe(true);

    const other = att.Ed25519Signer.fromSeed(Uint8Array.from({ length: 32 }, (_, i) => i + 1));
    const mm = await att.exportAttestation({
      signer: fixedSigner(),
      witnessedClaim: att.artifactPublished("https://x", "sha256:" + "0".repeat(64)),
      evidence: [att.evidenceImmutableUri("https://x")],
      issuer: att.didKeyIdentity(await other.getDidKey()),
    });
    const mmRes = await att.verify(mm);
    expect(mmRes.ok).toBe(true);
    expect(mmRes.issuerBound).toBe(false);
    expect(mmRes.notes.some((n) => n.includes("key_id != issuer.id"))).toBe(true);

    const nio = await validEnvelope();
    (nio as unknown as Record<string, unknown>).issuer = "thecolony.cc:x";
    const nioRes = await att.verify(nio);
    expect(nioRes.issuerBound).toBe(false);
    expect(nioRes.notes.some((n) => n.includes("issuer is not an object"))).toBe(true);
  });
});
