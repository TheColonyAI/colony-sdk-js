/**
 * The package version lives in FOUR places, and they drift.
 *
 * - `package.json` — what npm publishes.
 * - `jsr.json` — what JSR publishes.
 * - `package-lock.json` — the root package's own recorded version.
 * - `VERSION` exported from `src/index.ts` — what callers read at runtime.
 *
 * `RELEASING.md` step 2 named the first two, and the release workflow refused
 * to publish only if the git tag disagreed with `package.json`. Nothing checked
 * the rest, and every one of them has drifted:
 *
 * - `jsr.json` and `VERSION` sat at 0.15.0 through the 0.16.0 and 0.17.0
 *   releases. Both published to npm and neither reached JSR, with no red build
 *   either time — `jsr publish` treats an already-published version as success.
 *   JSR's version list still goes 0.15.0 -> 0.18.0.
 * - `package-lock.json` recorded 0.17.0 while `package.json` said 0.18.0,
 *   because the version bump landed without re-running `npm install`. v0.18.0
 *   published with a lockfile claiming to be 0.17.0.
 * - `VERSION` had drifted once before that, discovered at 0.12.0 while the
 *   package was on 0.15.0.
 *
 * Four sources, three separate drifts, none of which turned a build red. A
 * documented rule that nothing enforces is one someone skips on a busy release,
 * and this particular failure is silent by construction: npm succeeds, so the
 * release looks fine. This test is the enforcement at PR time; `verify-tag` in
 * release.yml is the enforcement at publish time.
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

  it("package-lock.json matches package.json", () => {
    // Drifts whenever a version bump lands without re-running `npm install`,
    // which is exactly how v0.18.0 shipped with a lockfile saying 0.17.0.
    expect(readVersion("package-lock.json")).toBe(readVersion("package.json"));
  });

  it("the exported VERSION matches package.json", () => {
    expect(VERSION).toBe(readVersion("package.json"));
  });

  it("the version is a plain semver triple", () => {
    // A control on the assertions above: they would all pass if every source
    // were equally wrong (an empty string, say). Pin the shape too, so "they
    // agree" cannot be satisfied vacuously.
    expect(readVersion("package.json")).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
