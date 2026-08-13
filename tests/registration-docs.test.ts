import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The registration examples must confirm from the key read back off storage,
 * never from the one still in memory.
 *
 * `registerConfirm` exists to prove the API key survived the write. An example
 * that passes `begun.api_key` succeeds identically whether or not that write
 * landed, so it silently teaches every reader to bypass the guarantee the
 * sentence above it describes.
 *
 * That defect was live here, in colony-sdk-python and in colony-sdk-go at the
 * same time, in near-identical prose. It survived because a documentation
 * example is executed by nobody: no test pointed at it in any of the three
 * languages. This is that test, and it is deliberately crude — a scan over the
 * docs — because the failure it guards against is crude.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const TARGETS = ["README.md", "src/client.ts"] as const;

/** A confirm whose fingerprint comes straight off the begin response. */
const FROM_MEMORY = /keyFingerprint:\s*begun\.api_key/;

describe("registration documentation", () => {
  it.each(TARGETS)("%s never confirms from the in-memory key", (rel) => {
    const text = readFileSync(join(ROOT, rel), "utf8");
    const match = FROM_MEMORY.exec(text);
    const where = match
      ? `${rel}:${text.slice(0, match.index).split("\n").length}: ${match[0]}`
      : "";
    expect(
      where,
      "A registration example takes the confirm fingerprint from the key still " +
        "in memory. Persist it, read it BACK, and confirm from what you read — " +
        "otherwise the example passes whether or not the write succeeded.",
    ).toBe("");
  });

  it.each(TARGETS)("%s reads the key back before confirming", (rel) => {
    const text = readFileSync(join(ROOT, rel), "utf8");
    if (!text.includes("registerConfirm")) return;
    expect(
      text.includes("readFile("),
      `${rel} documents registerConfirm but never reads the key back from ` +
        "storage; the example cannot be demonstrating the confirm gate. " +
        "Absence of the anti-pattern is also satisfied by deleting the example, " +
        "which is why this positive arm exists.",
    ).toBe(true);
  });

  it("the detector can actually fire", () => {
    // Control. A regex over prose is exactly the kind of scanner that quietly
    // stops matching, and one that cannot go red certifies nothing.
    expect(FROM_MEMORY.test("keyFingerprint: begun.api_key.slice(-6),")).toBe(true);
    expect(FROM_MEMORY.test("keyFingerprint: apiKey.slice(-6),")).toBe(false);
  });

  it("the one-shot register is gone from the public surface", () => {
    const client = readFileSync(join(ROOT, "src/client.ts"), "utf8");
    const index = readFileSync(join(ROOT, "src/index.ts"), "utf8");
    expect(client).not.toContain("static async register(");
    expect(client).not.toContain("RegisterResponse");
    expect(index).not.toContain("RegisterResponse");
    // Control: the two-step pair must still be there, or this passes trivially
    // on an empty file.
    expect(client).toContain("static async registerBegin(");
    expect(client).toContain("static async registerConfirm(");
  });
});
