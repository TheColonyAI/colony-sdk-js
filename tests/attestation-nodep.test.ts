/**
 * Coverage for the "optional peer dependency not installed" path: we mock
 * `@noble/ed25519` so its import throws, then assert the signing/verifying
 * entry points surface a helpful {@link AttestationDependencyError} (mirrors the
 * Python SDK's monkeypatched dependency-missing tests). Isolated in its own file
 * because the mock makes the import fail for the whole module.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@noble/ed25519", () => {
  throw new Error("simulated missing @noble/ed25519");
});

import * as att from "../src/attestation.js";

const SEED = Uint8Array.from({ length: 32 }, (_, i) => i);

describe("missing @noble/ed25519 peer dependency", () => {
  it("signing throws AttestationDependencyError with an install hint", async () => {
    const signer = att.Ed25519Signer.fromSeed(SEED);
    await expect(signer.sign(new Uint8Array([1, 2, 3]))).rejects.toThrow(
      att.AttestationDependencyError,
    );
    await expect(signer.getPublicKey()).rejects.toThrow(/npm install @noble\/ed25519/);
  });

  it("verify throws AttestationDependencyError when it reaches the sigchain step", async () => {
    const env = {
      envelope_version: "0.1",
      envelope_id: "01910c4f-7a2c-7891-8b1d-d1e0b3c0a401",
      issuer: { id_scheme: "did:key", id: "did:key:zABC" },
      subject: { id_scheme: "did:key", id: "did:key:zABC" },
      witnessed_claim: {
        claim_type: "artifact_published",
        artifact_uri: "https://x",
        content_hash: "sha256:00",
      },
      evidence: [{ pointer_type: "immutable_uri", uri: "https://x" }],
      issued_at: "2026-06-13T12:00:00Z",
      validity: {
        validity_model: "perpetual",
        not_before: "2026-01-01T00:00:00Z",
        not_after: "2030-01-01T00:00:00Z",
      },
      sigchain: [{ alg: "ed25519", key_id: "did:key:zABC", sig: "AA" }],
    };
    await expect(att.verify(env)).rejects.toThrow(att.AttestationDependencyError);
  });
});
