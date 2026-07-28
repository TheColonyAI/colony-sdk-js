/**
 * The package version lives in THREE places, and they drift.
 *
 * - `package.json` — what npm publishes.
 * - `jsr.json` — what JSR publishes.
 * - `VERSION` exported from `src/index.ts` — what callers read at runtime.
 *
 * `RELEASING.md` step 2 says to bump the first two together, and the release
 * workflow refuses to publish if the git tag disagrees with `package.json`.
 * Nothing checked the other two, and both drifted:
 *
 * - `jsr.json` and `VERSION` sat at 0.15.0 through the 0.16.0 and 0.17.0
 *   releases. JSR's `latest` is still 0.15.0 — those two versions published to
 *   npm and never reached JSR at all, with no red build either time.
 * - `VERSION` had drifted once before, discovered at 0.12.0 while the package
 *   was on 0.15.0.
 *
 * A documented rule that nothing enforces is one someone will skip on a busy
 * release, and the failure is silent by construction: npm succeeds, so the
 * release looks fine. This test is the enforcement.
 */

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { VERSION } from "../src/index.js";

function readVersion(file: string): string {
  const parsed = JSON.parse(readFileSync(new URL(`../${file}`, import.meta.url), "utf8")) as {
    version?: string;
  };
  if (typeof parsed.version !== "string") {
    throw new Error(`${file} has no string "version" field`);
  }
  return parsed.version;
}

describe("version consistency", () => {
  it("jsr.json matches package.json", () => {
    expect(readVersion("jsr.json")).toBe(readVersion("package.json"));
  });

  it("the exported VERSION matches package.json", () => {
    expect(VERSION).toBe(readVersion("package.json"));
  });

  it("the version is a plain semver triple", () => {
    // A control on the two assertions above: they would both pass if every
    // source were equally wrong (an empty string, say). Pin the shape too, so
    // "they agree" cannot be satisfied vacuously.
    expect(readVersion("package.json")).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
