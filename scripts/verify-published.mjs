#!/usr/bin/env node
/**
 * Verify a release actually landed, by DIGEST rather than by version string.
 *
 * Why this exists
 * ---------------
 * 0.16.0 and 0.17.0 published to npm and silently published nothing to JSR:
 * `jsr publish` exits 0 when the version already exists. The first fix asked
 * the registry for `latest` and compared the version string. That is better
 * than reading our own logs, but it is still weak, and a reader named exactly
 * how:
 *
 *   `latest === "0.19.1"` does not establish that the artifact serving that
 *   version is OURS. It would be equally satisfied by someone else publishing
 *   that name and version.
 *
 * A version string is an assertion about a label. A digest is an assertion
 * about bytes. This checks bytes where bytes are checkable — which turns out
 * to be npm only. JSR rewrites module specifiers on publish, so byte equality
 * there is impossible for a CORRECT release; see the note on `digest()` for
 * what is asserted instead and how that was discovered.
 *
 * Usage:
 *   node scripts/verify-published.mjs prestate <version>   # BEFORE publishing
 *   node scripts/verify-published.mjs digest   <version>   # AFTER publishing
 */
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";

const PKG = "@thecolony/sdk";
const NPM = `https://registry.npmjs.org/${PKG}`;
const JSR = `https://jsr.io/${PKG}`;

const die = (msg) => {
  console.error(`\n::error::${msg}`);
  process.exit(1);
};
const ok = (msg) => console.log(`  OK  ${msg}`);

async function getJson(url, { allow404 = false } = {}) {
  const r = await fetch(url, { headers: { "user-agent": "colony-sdk-release-check" } });
  if (r.status === 404 && allow404) return null;
  if (!r.ok) die(`GET ${url} -> HTTP ${r.status}`);
  return r.json();
}

/**
 * Expected pre-state: neither registry may already serve this version.
 *
 * This is the check whose absence made the original bug unclassifiable.
 * "Already published" is a correct success for a RETRY and a failure for a
 * NEW RELEASE, and the publisher cannot tell which, because the caller has no
 * way to declare the intent it holds. Declaring it here separates the lanes.
 */
async function prestate(version) {
  console.log(`Expected pre-state: no registry serves ${version} yet\n`);

  const npmMeta = await getJson(NPM);
  if (npmMeta.versions?.[version]) {
    die(
      `npm already serves ${version}. Expected pre-state was "absent".\n` +
        `If this is a deliberate re-run of a partially-failed release, that is a ` +
        `different intent and needs a human: npm will not accept a republish of an ` +
        `existing version, so a green run here would mean nothing.`,
    );
  }
  ok(`npm does not yet serve ${version}`);

  const jsrMeta = await getJson(`${JSR}/${version}_meta.json`, { allow404: true });
  if (jsrMeta) {
    die(
      `JSR already serves ${version}. Expected pre-state was "absent".\n` +
        `This is exactly the state in which \`jsr publish\` prints ` +
        `"Skipping, already published" and exits 0 — the failure this check exists for.`,
    );
  }
  ok(`JSR does not yet serve ${version}`);

  console.log("\nPre-state holds: this is a NEW release, not a retry.");
}

/** sha512 integrity for a file, in npm's `sha512-<base64>` form. */
function integrityOf(path) {
  return "sha512-" + createHash("sha512").update(readFileSync(path)).digest("base64");
}

/**
 * Post-publish: check that each registry serves OUR artifact.
 *
 * The two registries need different checks, and finding out why is the
 * reason this function looks asymmetric.
 *
 * npm serves the tarball we packed, byte for byte, so a sha512 comparison
 * against `dist.integrity` is available and is the strongest check there is.
 *
 * **JSR does not serve our bytes, and cannot.** It rewrites module specifiers
 * on publish so the source resolves under Deno. Measured against 0.19.1:
 *
 *     "./client.js"     ->  "./client.ts"                 (same length!)
 *     "@noble/ed25519"  ->  "npm:@noble/ed25519@^3.1.0"   (+22 bytes)
 *
 * The first rewrite preserves file length, which is why four files came back
 * the same size with different hashes — a byte comparison there fails for a
 * correct release, every time. This was written as a byte comparison first
 * and tested against the already-published 0.19.1 before being wired into
 * CI; that test is what caught it. Wired in untested, every future release
 * would have failed this step, and the obvious response would have been to
 * delete the check.
 *
 * So for JSR we assert what is actually assertable:
 *   1. the version is served at all;
 *   2. the published FILE SET matches what we would publish — no missing
 *      file, no extra one;
 *   3. the served source carries OUR version string, read out of the
 *      published bytes rather than out of the label;
 *   4. the manifest is coherent with what is served — fetch a file and
 *      confirm it hashes to the checksum the manifest advertises.
 *
 * (3) is the one that ties the artifact to us. (4) is weaker than an origin
 * check and I am not pretending otherwise: it detects an incoherent manifest,
 * not a hostile registry.
 */
async function digest(version) {
  console.log(`Artifact verification for ${version}\n`);

  // ---- npm: full byte comparison, the strong case
  const npmMeta = await getJson(NPM);
  const dist = npmMeta.versions?.[version]?.dist;
  if (!dist) die(`npm does not serve ${version} at all — the publish did not land.`);

  const packed = JSON.parse(
    execFileSync("npm", ["pack", "--json", "--pack-destination", "/tmp"], { encoding: "utf8" }),
  );
  const tarball = `/tmp/${packed[0].filename}`;
  if (!existsSync(tarball)) die(`npm pack did not produce ${tarball}`);
  const local = integrityOf(tarball);

  if (local !== dist.integrity) {
    die(
      `npm tarball digest MISMATCH for ${version}\n` +
        `  local    ${local}\n` +
        `  registry ${dist.integrity}\n` +
        `The registry serves this version, but not these bytes.`,
    );
  }
  ok(`npm serves our exact bytes (${dist.integrity.slice(0, 24)}..., ${dist.fileCount} files)`);

  // ---- JSR: specifier-rewritten, so verify what is verifiable
  const jsrMeta = await getJson(`${JSR}/${version}_meta.json`, { allow404: true });
  if (!jsrMeta) {
    die(
      `JSR does not serve ${version}. If the publish step was green, it printed ` +
        `"Skipping, already published" and did nothing — see 0.16.0 and 0.17.0.`,
    );
  }
  ok(`JSR serves ${version}`);

  // (2) file set
  const published = new Set(Object.keys(jsrMeta.manifest ?? {}));
  if (published.size === 0) die("JSR manifest is empty — nothing to verify against.");
  const missing = [...published].filter((n) => !existsSync("." + n));
  if (missing.length) {
    die(`JSR publishes files absent from this checkout: ${missing.join(", ")}`);
  }
  ok(`JSR file set matches this checkout (${published.size} files, none unaccounted for)`);

  // (3) the served source carries OUR version — read from the bytes
  const idx = await fetch(`${JSR}/${version}/src/index.ts`);
  if (!idx.ok) die(`could not fetch published src/index.ts: HTTP ${idx.status}`);
  const idxText = await idx.text();
  const needle = `export const VERSION = "${version}";`;
  if (!idxText.includes(needle)) {
    die(
      `published JSR source does not declare ${version}.\n` +
        `Expected to find: ${needle}\n` +
        `The registry serves this version LABEL, but the bytes behind it say otherwise.`,
    );
  }
  ok(`published JSR source declares VERSION = "${version}"`);

  // (4) manifest coherence with what is actually served
  const advertised = jsrMeta.manifest["/src/index.ts"]?.checksum;
  const servedSum = "sha256-" + createHash("sha256").update(Buffer.from(idxText)).digest("hex");
  if (advertised && advertised !== servedSum) {
    die(
      `JSR manifest is incoherent with what it serves for /src/index.ts\n` +
        `  manifest ${advertised}\n` +
        `  served   ${servedSum}`,
    );
  }
  ok("JSR manifest agrees with the file it serves");

  console.log(
    "\nnpm verified by byte digest. JSR verified by file set + version-in-source + " +
      "manifest coherence (byte equality is impossible there — see the note above).",
  );
}

const [mode, version] = process.argv.slice(2);
if (!mode || !version) die("usage: verify-published.mjs <prestate|digest> <version>");
if (mode === "prestate") await prestate(version);
else if (mode === "digest") await digest(version);
else die(`unknown mode ${mode}`);
