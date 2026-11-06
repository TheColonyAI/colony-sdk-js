/**
 * The types say what the server sends.
 *
 * Every interface in `src/types.ts` is a claim about the API's responses, and
 * nothing checked those claims. This SDK hands the parsed JSON through as it
 * came, typed with these interfaces, so a field named differently from the
 * server's is `undefined` on every response while the compiler promises a
 * value. The Go SDK found four such bugs in one week before it checked its
 * structs against the server's OpenAPI document (`schema_conformance_test.go`),
 * and the Python SDK runs the same check (`tests/test_schema_conformance.py`);
 * this is the TypeScript one.
 *
 * Each binding in `tests/schema-bindings.ts` ties a type to the schema it
 * mirrors, by name or by the endpoint it comes off. The type's properties are
 * read with the TypeScript compiler, the schema's from
 * `tests/fixtures/openapi-schemas.json`, and then:
 *
 * - a property the schema does not have is a **phantom**: it can never be
 *   filled, so it fails, unless the binding says another endpoint fills it
 *   (`elsewhere`), this package fills it (`client`), or it is a name the
 *   server never sent, kept and marked `@deprecated` so code that reads it
 *   still compiles (`retired`);
 * - a property whose TypeScript type cannot hold what the schema sends (a
 *   `string` where the server sends an integer) is the **wrong type** and
 *   fails, unless the binding says the type is narrower on the server's own
 *   word (`narrowed`);
 * - a property the schema marks as the deprecated name of another
 *   (`x-deprecated-alias-of`) fails unless that other name is modelled too:
 *   the deprecated name is the one that goes away;
 * - a schema property no type models is **unmodelled**: still reachable,
 *   since the parsed JSON is handed through whole, but not typed. These are
 *   counted against a ratchet, so the number can only fall, unless the
 *   binding names the property as `optional` with a reason.
 *
 * Every exported interface in `src/types.ts` and `src/crypto.ts` must be bound
 * or listed in `UNBOUND` with a reason, so a new type cannot go unchecked by
 * being left out. Call-options bags (anything with a `signal`) are client-side
 * by construction and need no entry.
 *
 * Regenerate the snapshot with `node scripts/gen-openapi-snapshot.mjs` when the
 * server changes; this test then says what moved.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { beforeAll, describe, expect, it } from "vitest";

import { SCHEMA_BINDINGS, UNBOUND, type SchemaBinding } from "./schema-bindings.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SNAPSHOT = join(ROOT, "tests", "fixtures", "openapi-schemas.json");
const REF = "#/components/schemas/";

/** Where the wire types live; the census covers these files. */
const MODULES = ["src/types.ts", "src/crypto.ts"];

/**
 * Schema properties no type models. A ratchet: it may only fall, and must be
 * lowered when it does.
 */
const UNMODELLED_BASELINE = 90;

// ── The snapshot ─────────────────────────────────────────────────────

interface SchemaNode {
  $ref?: string;
  type?: string | string[];
  properties?: Record<string, SchemaNode>;
  additionalProperties?: boolean | SchemaNode;
  anyOf?: SchemaNode[];
  oneOf?: SchemaNode[];
  allOf?: SchemaNode[];
  items?: SchemaNode;
  enum?: unknown[];
  deprecated?: boolean;
  "x-deprecated-alias-of"?: string;
}

interface Snapshot {
  fetched_at: string;
  source: string;
  schemas: Record<string, SchemaNode>;
  operations: Record<string, string>;
}

function loadSnapshot(): Snapshot {
  return JSON.parse(readFileSync(SNAPSHOT, "utf8")) as Snapshot;
}

function schemaName(b: SchemaBinding, snap: Snapshot): string {
  if (b.op) {
    const name = snap.operations[b.op];
    if (!name)
      throw new Error(`${b.op} is not in the snapshot: run scripts/gen-openapi-snapshot.mjs`);
    return name;
  }
  if (!b.schema) throw new Error(`${b.type}: a binding needs a schema or an op`);
  return b.schema;
}

function resolve(node: SchemaNode, schemas: Record<string, SchemaNode>): SchemaNode {
  let n = node;
  while (n.$ref) {
    const target = schemas[n.$ref.slice(REF.length)];
    if (!target) throw new Error(`unresolved ${n.$ref}: regenerate the snapshot`);
    n = target;
  }
  return n;
}

/** The alternatives a property may be: anyOf/oneOf flattened, refs resolved. */
function variants(node: SchemaNode, schemas: Record<string, SchemaNode>): SchemaNode[] {
  const n = resolve(node, schemas);
  for (const alts of [n.anyOf, n.oneOf]) {
    if (alts) return alts.flatMap((a) => variants(a, schemas));
  }
  if (n.allOf && n.allOf.length === 1 && n.allOf[0]) return variants(n.allOf[0], schemas);
  return [n];
}

/** The JSON types the server may send for a property, `"null"` included. */
function sentKinds(node: SchemaNode, schemas: Record<string, SchemaNode>): Set<string> {
  const out = new Set<string>();
  for (const v of variants(node, schemas)) {
    if (Array.isArray(v.type)) v.type.forEach((t) => out.add(t));
    else if (typeof v.type === "string") out.add(v.type);
    else if (v.properties || v.additionalProperties) out.add("object");
  }
  return out;
}

/** Every schema name `node` references, at any depth. */
function refsOf(node: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(node)) {
    for (const v of node) refsOf(v, out);
  } else if (node && typeof node === "object") {
    const ref = (node as { $ref?: unknown }).$ref;
    if (typeof ref === "string" && ref.startsWith(REF)) out.add(ref.slice(REF.length));
    for (const v of Object.values(node)) refsOf(v, out);
  }
  return out;
}

// ── The types, read with the compiler ────────────────────────────────

interface Prop {
  /** JSON types the property can hold, or null for `unknown` / `any`. */
  accepts: Set<string> | null;
  deprecated: boolean;
}

interface CensusEntry {
  name: string;
  file: string;
  /** A call-options bag: it carries `signal`, so it never comes off the wire. */
  callOptions: boolean;
}

function compilerOptions(): ts.CompilerOptions {
  const cfg = ts.readConfigFile(join(ROOT, "tsconfig.json"), (p) => ts.sys.readFile(p));
  const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, ROOT);
  return { ...parsed.options, noEmit: true, declaration: false, declarationMap: false };
}

function acceptedKinds(t: ts.Type, checker: ts.TypeChecker): Set<string> | null {
  const F = ts.TypeFlags;
  if (t.flags & (F.Any | F.Unknown)) return null;
  if (t.isUnion()) {
    const out = new Set<string>();
    for (const member of t.types) {
      const k = acceptedKinds(member, checker);
      if (k === null) return null;
      k.forEach((x) => out.add(x));
    }
    return out;
  }
  if (t.flags & F.StringLike) return new Set(["string"]);
  if (t.flags & F.NumberLike) return new Set(["number", "integer"]);
  if (t.flags & F.BooleanLike) return new Set(["boolean"]);
  if (t.flags & F.Null) return new Set(["null"]);
  if (t.flags & (F.Undefined | F.Void | F.Never)) return new Set();
  if (checker.isArrayType(t) || checker.isTupleType(t)) return new Set(["array"]);
  if (t.flags & (F.Object | F.Intersection | F.NonPrimitive)) return new Set(["object"]);
  return null;
}

/**
 * The properties of TypeScript type expressions, `"Post"` or
 * `"PaginatedList<Post>"`, resolved against the exports of `modules`.
 */
class TypeReader {
  readonly census: CensusEntry[] = [];
  readonly errors: string[] = [];
  private readonly props = new Map<string, Map<string, Prop>>();

  constructor(exprs: string[], modules: string[], sources: Record<string, string> = {}) {
    const options = compilerOptions();
    const files = modules.map((m) => join(ROOT, m));
    const virtual = join(ROOT, "tests", "__schema_bindings__.ts");
    const inMemory = new Map<string, string>(
      Object.entries(sources).map(([p, text]) => [join(ROOT, p), text]),
    );
    const host = ts.createCompilerHost(options);
    const baseGet = host.getSourceFile.bind(host);
    const baseExists = host.fileExists.bind(host);
    const baseRead = host.readFile.bind(host);
    host.fileExists = (p) => inMemory.has(p) || baseExists(p);
    host.readFile = (p) => inMemory.get(p) ?? baseRead(p);
    host.getSourceFile = (p, lang, onError, create) => {
      const text = inMemory.get(p);
      return text !== undefined
        ? ts.createSourceFile(p, text, lang, true)
        : baseGet(p, lang, onError, create);
    };

    // First pass: what each module exports, for the census and for the
    // names a binding's type expression may use.
    const first = ts.createProgram({ rootNames: files, options, host });
    const firstChecker = first.getTypeChecker();
    const owner = new Map<string, number>();
    files.forEach((file, i) => {
      const sf = first.getSourceFile(file);
      const sym = sf && firstChecker.getSymbolAtLocation(sf);
      if (!sf || !sym) throw new Error(`cannot read ${file}`);
      for (const exp of firstChecker.getExportsOfModule(sym)) {
        if (!owner.has(exp.name)) owner.set(exp.name, i);
        const decl = exp.declarations?.[0];
        const isObject =
          decl !== undefined &&
          (ts.isInterfaceDeclaration(decl) ||
            (ts.isTypeAliasDeclaration(decl) && ts.isTypeLiteralNode(decl.type)));
        if (!isObject || decl.getSourceFile() !== sf) continue;
        const type = firstChecker.getDeclaredTypeOfSymbol(exp);
        const callOptions = firstChecker.getPropertiesOfType(type).some((p) => p.name === "signal");
        this.census.push({ name: exp.name, file: modules[i] ?? file, callOptions });
      }
    });

    // Second pass: one type alias per expression, in a file of our own.
    const imports = files
      .map((f, i) => {
        const rel = "../" + (modules[i] ?? f).replace(/\.ts$/, "");
        return `import type * as m${i} from ${JSON.stringify(rel)};`;
      })
      .join("\n");
    const qualify = (expr: string) =>
      expr.replace(/\b[A-Za-z_][A-Za-z0-9_]*\b/g, (id) =>
        owner.has(id) ? `m${owner.get(id)}.${id}` : id,
      );
    const aliases = exprs.map((e, i) => `export type B${i} = ${qualify(e)};`).join("\n");
    inMemory.set(virtual, `${imports}\n${aliases}\n`);
    const program = ts.createProgram({
      rootNames: [virtual, ...files],
      options,
      host,
      oldProgram: first,
    });
    const checker = program.getTypeChecker();
    const vsf = program.getSourceFile(virtual);
    if (!vsf) throw new Error("the bindings file did not load");
    for (const d of program.getSemanticDiagnostics(vsf)) {
      this.errors.push(ts.flattenDiagnosticMessageText(d.messageText, "\n"));
    }
    vsf.statements.filter(ts.isTypeAliasDeclaration).forEach((decl, i) => {
      const type = checker.getTypeFromTypeNode(decl.type);
      const props = new Map<string, Prop>();
      for (const sym of checker.getPropertiesOfType(type)) {
        props.set(sym.name, {
          accepts: acceptedKinds(checker.getTypeOfSymbol(sym), checker),
          deprecated: sym.getJsDocTags(checker).some((t) => t.name === "deprecated"),
        });
      }
      this.props.set(exprs[i] ?? "", props);
    });
  }

  propsOf(expr: string): Map<string, Prop> {
    const p = this.props.get(expr);
    if (!p) throw new Error(`no type read for ${expr}`);
    return p;
  }
}

// ── The check ────────────────────────────────────────────────────────

interface Result {
  phantoms: string[];
  wrongTypes: string[];
  deprecatedOnly: string[];
  unmodelled: string[];
  stale: string[];
}

function check(
  b: SchemaBinding,
  props: Map<string, Prop>,
  schema: SchemaNode,
  schemas: Record<string, SchemaNode>,
): Result {
  const sprops = schema.properties ?? {};
  const optional = new Set(b.optional ?? []);
  const absent = new Map<string, string>(); // a phantom allowed, by the entry that allows it
  for (const e of b.elsewhere ?? []) absent.set(e, "elsewhere");
  for (const e of b.retired ?? []) absent.set(e, "retired");
  for (const e of b.client ?? []) absent.set(e, "client");
  const narrowed = new Set(b.narrowed ?? []);
  const r: Result = { phantoms: [], wrongTypes: [], deprecatedOnly: [], unmodelled: [], stale: [] };

  for (const [name, prop] of [...props].sort(([a], [c]) => (a < c ? -1 : 1))) {
    const sprop = sprops[name];
    if (!sprop) {
      const allowed = absent.get(name);
      if (!allowed) r.phantoms.push(name);
      else if (allowed === "retired" && !prop.deprecated) {
        r.stale.push(`retired ${name} is not marked @deprecated`);
      }
      continue;
    }
    const sent = sentKinds(sprop, schemas);
    sent.delete("null");
    const holds = prop.accepts;
    const wrong = holds !== null && sent.size > 0 && ![...sent].every((k) => holds.has(k));
    if (wrong && !narrowed.has(name)) {
      r.wrongTypes.push(
        `${name}: the server sends ${[...sent].sort().join(" | ")}, ` +
          `the type holds ${[...holds].sort().join(" | ") || "nothing"}`,
      );
    }
    if (!wrong && narrowed.has(name)) r.stale.push(`narrowed ${name} holds what the server sends`);
    const current = sprop["x-deprecated-alias-of"];
    if (current && !props.has(current)) {
      r.deprecatedOnly.push(`${name} (the server's name is ${current})`);
    }
  }
  for (const name of Object.keys(sprops).sort()) {
    if (!props.has(name) && !optional.has(name)) r.unmodelled.push(name);
  }
  for (const o of optional) {
    if (!(o in sprops)) r.stale.push(`optional ${o} is not in the schema`);
    else if (props.has(o)) r.stale.push(`optional ${o} is modelled`);
  }
  for (const [e, kind] of absent) {
    if (e in sprops) r.stale.push(`${kind} ${e} is in this schema`);
    else if (!props.has(e)) r.stale.push(`${kind} ${e} is not a property of the type`);
  }
  for (const n of narrowed) {
    if (!(n in sprops)) r.stale.push(`narrowed ${n} is not in the schema`);
  }
  return r;
}

/** The type a binding's expression is named after: `PaginatedList<Post>` binds PaginatedList. */
function baseName(expr: string): string {
  return expr.split("<", 1)[0]?.trim() ?? expr;
}

// ── The gates ────────────────────────────────────────────────────────

describe("schema conformance", () => {
  let snap: Snapshot;
  let reader: TypeReader;

  beforeAll(() => {
    snap = loadSnapshot();
    reader = new TypeReader([...new Set(SCHEMA_BINDINGS.map((b) => b.type))], MODULES);
  }, 120_000);

  const label = (b: SchemaBinding) => `${b.type} ⇐ ${b.op ?? b.schema}`;

  it("every binding names a type this package exports", () => {
    expect(reader.errors).toEqual([]);
  });

  it.each(SCHEMA_BINDINGS.map((b) => [label(b), b] as const))(
    "%s: every property is sent, with a type that can hold it",
    (_label, b) => {
      const name = schemaName(b, snap);
      const schema = snap.schemas[name];
      expect(schema, `${name} is not in the snapshot: regenerate it`).toBeDefined();
      const r = check(b, reader.propsOf(b.type), resolve(schema ?? {}, snap.schemas), snap.schemas);
      const problems = [
        ...r.phantoms.map((p) => `${p} is not sent by ${name}, so it is never filled`),
        ...r.wrongTypes,
        ...r.deprecatedOnly.map(
          (p) => `${p} is a deprecated name, modelled without the current one`,
        ),
        ...r.stale,
      ];
      expect(
        problems,
        `${b.type}: fix the type, or, when the server is right not to send a property, ` +
          "say why in the binding (elsewhere, retired, client or narrowed)",
      ).toEqual([]);
    },
  );

  it("the unmodelled ratchet holds", () => {
    const gaps = SCHEMA_BINDINGS.flatMap((b) => {
      const schema = resolve(snap.schemas[schemaName(b, snap)] ?? {}, snap.schemas);
      return check(b, reader.propsOf(b.type), schema, snap.schemas).unmodelled.map(
        (p) => `${label(b)}: ${p}`,
      );
    });
    expect(
      gaps.length,
      `${gaps.length} server fields no type models, baseline ${UNMODELLED_BASELINE}. ` +
        "Above it: model them, or mark them optional with a reason. Below it: lower " +
        "UNMODELLED_BASELINE so the ratchet keeps holding.\n  " +
        gaps.join("\n  "),
    ).toBe(UNMODELLED_BASELINE);
  });

  it("every wire type is bound or has a reason not to be", () => {
    const bound = new Set(SCHEMA_BINDINGS.map((b) => baseName(b.type)));
    const unbound = new Map(UNBOUND.map((u) => [u.type, u.why]));
    const census = new Map(reader.census.map((c) => [c.name, c]));
    const missing = reader.census
      .filter((c) => !c.callOptions && !bound.has(c.name) && !unbound.has(c.name))
      .map((c) => `${c.name} (${c.file})`);
    expect(
      missing,
      "bind these in tests/schema-bindings.ts, or list them in UNBOUND with why",
    ).toEqual([]);
    const stale = UNBOUND.filter((u) => bound.has(u.type) || !census.has(u.type)).map((u) =>
      bound.has(u.type) ? `${u.type} is bound` : `${u.type} is not an exported interface`,
    );
    expect(stale, "UNBOUND entries that no longer apply").toEqual([]);
    expect(UNBOUND.filter((u) => u.why.trim().length < 20).map((u) => u.type)).toEqual([]);
  });

  it("the snapshot holds exactly what the bindings need", () => {
    const names = new Set(SCHEMA_BINDINGS.map((b) => schemaName(b, snap)));
    const missing = [...names].filter((n) => !(n in snap.schemas)).sort();
    expect(missing, "bound schemas missing from the snapshot (regenerate it)").toEqual([]);
    const needed = new Set<string>();
    const todo = [...names];
    while (todo.length > 0) {
      const n = todo.pop() ?? "";
      if (needed.has(n)) continue;
      needed.add(n);
      for (const r of refsOf(snap.schemas[n])) if (!needed.has(r)) todo.push(r);
    }
    const orphans = Object.keys(snap.schemas)
      .filter((n) => !needed.has(n))
      .sort();
    expect(orphans, "snapshot schemas nothing binds or references (regenerate it)").toEqual([]);
    const ops = new Set(SCHEMA_BINDINGS.flatMap((b) => (b.op ? [b.op] : [])));
    expect(Object.keys(snap.operations).sort()).toEqual([...ops].sort());
  });

  it("no binding is listed twice", () => {
    const keys = SCHEMA_BINDINGS.map(label);
    expect(keys.filter((k, i) => keys.indexOf(k) !== i)).toEqual([]);
  });
});

// ── The checker finds each shape of bug ──────────────────────────────

describe("the checker", () => {
  const TOY_SCHEMAS: Record<string, SchemaNode> = {
    ToyOut: {
      type: "object",
      properties: {
        id: { type: "string" },
        difficulty: { type: "integer" },
        invite_status: { type: "string" },
        author: { $ref: "#/components/schemas/ToyAuthor" },
        tags: { anyOf: [{ type: "array", items: { type: "string" } }, { type: "null" }] },
        metadata: { anyOf: [{ type: "object", additionalProperties: true }, { type: "null" }] },
        metadata_: {
          anyOf: [{ type: "object", additionalProperties: true }, { type: "null" }],
          deprecated: true,
          "x-deprecated-alias-of": "metadata",
        },
      },
    },
    ToyAuthor: { type: "object", properties: { id: { type: "string" } } },
  };
  const TOY = `
    export interface Author { id: string }
    /** Every bug at once. */
    export interface Buggy {
      id: string;
      difficulty: string;
      status: string;
      author: string;
      tags: string[] | null;
      metadata_: Record<string, unknown> | null;
    }
    /** What Buggy should have been. */
    export interface Clean {
      id: string;
      difficulty: number;
      invite_status: string;
      author: Author;
      tags: string[] | null;
      metadata: Record<string, unknown> | null;
      /** @deprecated */
      metadata_?: Record<string, unknown> | null;
      [key: string]: unknown;
    }
    export interface Loose { id: string; difficulty: unknown; tags: any }
    /** Phantoms with a reason, and a type narrower than the schema's. */
    export interface Kept {
      id: string;
      /** @deprecated Never sent; read id. */
      gone?: string;
      not_marked?: string;
      from_header: boolean;
      difficulty: null;
    }
  `;

  let toy: TypeReader;
  beforeAll(() => {
    toy = new TypeReader(["Buggy", "Clean", "Loose", "Kept"], ["tests/__toy__.ts"], {
      "tests/__toy__.ts": TOY,
    });
  }, 120_000);
  const run = (type: string, extra: Partial<SchemaBinding> = {}) =>
    check(
      { type, schema: "ToyOut", ...extra },
      toy.propsOf(type),
      TOY_SCHEMAS.ToyOut ?? {},
      TOY_SCHEMAS,
    );

  it("finds a wrong name, a wrong type, a deprecated name and a gap", () => {
    const r = run("Buggy");
    expect(r.phantoms).toEqual(["status"]);
    expect(r.wrongTypes).toEqual([
      "author: the server sends object, the type holds string",
      "difficulty: the server sends integer, the type holds string",
    ]);
    expect(r.deprecatedOnly).toEqual(["metadata_ (the server's name is metadata)"]);
    expect(r.unmodelled).toEqual(["invite_status", "metadata"]);
  });

  it("passes a type that models the schema, deprecated name and all", () => {
    expect(run("Clean")).toEqual({
      phantoms: [],
      wrongTypes: [],
      deprecatedOnly: [],
      unmodelled: [],
      stale: [],
    });
  });

  it("reads the deprecated tag", () => {
    expect(toy.propsOf("Clean").get("metadata_")?.deprecated).toBe(true);
    expect(toy.propsOf("Clean").get("metadata")?.deprecated).toBe(false);
  });

  it("says nothing about the type of unknown and any", () => {
    expect(run("Loose").wrongTypes).toEqual([]);
  });

  it("an elsewhere and an optional entry silence exactly their name, and go stale", () => {
    const r = run("Buggy", { elsewhere: ["status"], optional: ["invite_status"] });
    expect(r.phantoms).toEqual([]);
    expect(r.unmodelled).toEqual(["metadata"]);
    expect(r.stale).toEqual([]);
    const s = run("Clean", { elsewhere: ["id"], optional: ["difficulty", "nope"] });
    expect(s.stale).toEqual([
      "optional difficulty is modelled",
      "optional nope is not in the schema",
      "elsewhere id is in this schema",
    ]);
  });

  it("allows a retired, a client-filled and a narrowed property only when the binding says so", () => {
    const bare = run("Kept");
    expect(bare.phantoms).toEqual(["from_header", "gone", "not_marked"]);
    expect(bare.wrongTypes).toEqual(["difficulty: the server sends integer, the type holds null"]);
    const r = run("Kept", {
      retired: ["gone", "not_marked"],
      client: ["from_header"],
      narrowed: ["difficulty"],
    });
    expect(r.phantoms).toEqual([]);
    expect(r.wrongTypes).toEqual([]);
    // A retired name must say it is deprecated, so an editor strikes it out.
    expect(r.stale).toEqual(["retired not_marked is not marked @deprecated"]);
    expect(run("Clean", { narrowed: ["difficulty"], retired: ["id"] }).stale).toEqual([
      "narrowed difficulty holds what the server sends",
      "retired id is in this schema",
    ]);
  });

  it("reports a binding that names no exported type", () => {
    const r = new TypeReader(["NoSuchType"], ["tests/__toy__.ts"], { "tests/__toy__.ts": TOY });
    expect(r.errors.join("\n")).toContain("NoSuchType");
  }, 120_000);

  it("takes call-options bags out of the census", () => {
    const r = new TypeReader([], ["tests/__toy__.ts"], {
      "tests/__toy__.ts": `${TOY}\nexport interface ListOptions { limit?: number; signal?: AbortSignal }`,
    });
    const opts = r.census.find((c) => c.name === "ListOptions");
    expect(opts?.callOptions).toBe(true);
    expect(r.census.find((c) => c.name === "Clean")?.callOptions).toBe(false);
  }, 120_000);
});
