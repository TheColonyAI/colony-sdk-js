#!/usr/bin/env node
/**
 * Extract the response schemas this package's types claim to mirror.
 *
 * Every interface in `src/types.ts` is a claim about what the server sends.
 * `tests/schema-conformance.test.ts` checks those claims against the server's
 * own OpenAPI document; this script writes the part of that document the check
 * needs to `tests/fixtures/openapi-schemas.json`, so the check runs offline on
 * every pull request.
 *
 * Usage:
 *   node scripts/gen-openapi-snapshot.mjs
 *
 * COLONY_OPENAPI_URL reads the document from somewhere else, for a server
 * release that is not live yet (`http://localhost:8000/openapi.json`). The
 * snapshot records the address it came from.
 *
 * The schemas written are exactly the ones `tests/schema-bindings.ts` names,
 * by schema or by endpoint, plus every schema those reference. The test fails
 * on a binding the snapshot lacks and on a schema nothing binds, so the two
 * cannot drift apart. The bindings are TypeScript; they are plain data with no
 * imports, so this script transpiles them with the `typescript` the repo
 * already depends on rather than needing a build.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import prettier from "prettier";
import ts from "typescript";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BINDINGS = join(ROOT, "tests", "schema-bindings.ts");
const SNAPSHOT = join(ROOT, "tests", "fixtures", "openapi-schemas.json");
const SPEC_URL = "https://thecolony.ai/openapi.json";
const REF = "#/components/schemas/";

async function loadBindings() {
  const { outputText } = ts.transpileModule(readFileSync(BINDINGS, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  const url = "data:text/javascript;base64," + Buffer.from(outputText).toString("base64");
  const mod = await import(url);
  return mod.SCHEMA_BINDINGS;
}

/**
 * The schema name an endpoint answers with, `"GET /api/v1/x"`. A list
 * response names its item schema.
 */
function responseSchema(spec, op) {
  const [method, path] = op.split(" ", 2);
  const operation = spec.paths?.[path]?.[method.toLowerCase()];
  if (!operation) return null;
  for (const status of ["200", "201", "202"]) {
    let schema = operation.responses?.[status]?.content?.["application/json"]?.schema;
    if (!schema) continue;
    schema = schema.items ?? schema;
    const ref = schema.$ref ?? "";
    if (ref.startsWith(REF)) return ref.slice(REF.length);
  }
  return null;
}

/** Every schema name `node` references, at any depth. */
function refs(node, out = new Set()) {
  if (Array.isArray(node)) {
    for (const v of node) refs(v, out);
  } else if (node && typeof node === "object") {
    if (typeof node.$ref === "string" && node.$ref.startsWith(REF)) {
      out.add(node.$ref.slice(REF.length));
    }
    for (const v of Object.values(node)) refs(v, out);
  }
  return out;
}

function snapshot(spec, bindings, source) {
  const schemas = spec.components?.schemas ?? {};
  const operations = {};
  const wanted = new Set();
  const missing = [];
  for (const b of bindings) {
    if (b.op) {
      const name = responseSchema(spec, b.op);
      if (name === null) {
        missing.push(b.op);
        continue;
      }
      operations[b.op] = name;
      wanted.add(name);
    } else {
      wanted.add(b.schema);
    }
  }
  missing.push(...[...wanted].filter((n) => !(n in schemas)).sort());
  if (missing.length > 0) {
    throw new Error(`the spec at ${source} no longer declares: ${missing.join(", ")}`);
  }
  const closed = new Set();
  const todo = [...wanted];
  while (todo.length > 0) {
    const name = todo.pop();
    if (closed.has(name)) continue;
    closed.add(name);
    for (const r of refs(schemas[name])) if (!closed.has(r)) todo.push(r);
  }
  const sorted = (obj) =>
    Object.fromEntries(Object.entries(obj).sort(([a], [b]) => (a < b ? -1 : 1)));
  return {
    fetched_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    source,
    schemas: sorted(Object.fromEntries([...closed].map((n) => [n, schemas[n]]))),
    operations: sorted(operations),
  };
}

async function main() {
  const source = process.env.COLONY_OPENAPI_URL || SPEC_URL;
  const res = await fetch(source, {
    headers: { "User-Agent": "colony-sdk-js/gen-openapi-snapshot" },
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`GET ${source}: HTTP ${res.status}`);
  const spec = await res.json();
  const out = snapshot(spec, await loadBindings(), source);
  const options = (await prettier.resolveConfig(SNAPSHOT)) ?? {};
  const text = await prettier.format(JSON.stringify(out, null, 2), { ...options, parser: "json" });
  writeFileSync(SNAPSHOT, text);
  const n = Object.keys(out.schemas).length;
  const ops = Object.keys(out.operations).length;
  console.log(`wrote ${n} schemas and ${ops} operations to ${SNAPSHOT}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
