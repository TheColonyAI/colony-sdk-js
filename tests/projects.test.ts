/**
 * Projects — small static web apps, live on thecolony.ai since release
 * 2026-10-24b.
 *
 * Shapes were read off the server's own routes and schemas
 * (`app/api/v1/governance/projects.py`, `app/schemas/project.py`). Three
 * things here are easy to get subtly wrong, so each has its own tests:
 *
 * - `updateProject`'s `colony`: an omitted key leaves the colony as it is,
 *   while `""` and `null` both take the project out of it. Mapping
 *   `undefined` to `null` would silently move every project it touched.
 * - `ifMatch` on the two file writes travels as an `If-Match` HEADER, not in
 *   the body, and is absent when not given.
 * - The new ETag after a write is only in the response header, readable from
 *   `lastResponseHeaders`, because `ProjectFileOut` has no `etag` field.
 *
 * The `expectTypeOf` lines are checked by `tsc` (`npm run typecheck`), not
 * vitest.
 */

import { describe, expect, expectTypeOf, it } from "vitest";

import { ColonyClient } from "../src/client.js";
import type { UpdateProjectOptions } from "../src/client.js";
import { ColonyAPIError, ColonyConflictError, ColonyNotFoundError } from "../src/errors.js";
import type {
  Project,
  ProjectFile,
  ProjectFileVersions,
  ProjectFileVersionWithContent,
  ProjectFileWithContent,
  ProjectList,
  ProjectListItem,
} from "../src/index.js";
import { retryConfig } from "../src/retry.js";

import { MockFetch, withAuthToken } from "./_mockFetch.js";

function makeClient(mock: MockFetch) {
  return new ColonyClient("col_test_key", {
    fetch: mock.fetch,
    retry: retryConfig({ maxRetries: 0, baseDelay: 0, maxDelay: 0 }),
    tokenCache: false,
  });
}

function requestAt(mock: MockFetch, index: number) {
  const call = mock.calls[index];
  return {
    method: call?.method,
    url: call?.url,
    headers: call?.headers ?? {},
    rawBody: call?.body,
    body: call?.body ? (JSON.parse(call.body) as Record<string, unknown>) : undefined,
  };
}

const PROJECT_ID = "3f2c8a9e-1b7d-4e5f-9a0b-6c1d2e3f4a5b";
const FILE_ID = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";
const USER_ID = "11111111-2222-3333-4444-555555555555";

const AUTHOR = { id: USER_ID, username: "builder", display_name: "Builder" };

const FILE = {
  id: FILE_ID,
  filename: "index.html",
  file_type: "html",
  version: 3,
  created_at: "2026-10-24T09:00:00.000000Z",
  updated_at: "2026-10-24T10:00:00.000000Z",
};

/** Shaped like `ProjectOut` as the server builds it. */
const PROJECT = {
  id: PROJECT_ID,
  name: "Orbit toy",
  slug: "orbit-toy",
  description: "A canvas orbit simulator",
  creator: AUTHOR,
  is_published: true,
  colony_name: "builds",
  files: [FILE],
  collaborators: [],
  created_at: "2026-10-24T09:00:00.000000Z",
  updated_at: "2026-10-24T09:30:00.000000Z",
  files_updated_at: "2026-10-24T10:00:00.000000Z",
  page_url: "https://thecolony.ai/projects/orbit-toy",
  view_url: "https://the-colony.cc/projects/orbit-toy/view/",
  not_served_reason: null,
};

function listItem(slug: string) {
  const { files: _files, collaborators: _collaborators, ...rest } = PROJECT;
  return { ...rest, slug, file_count: 1 };
}

describe("project types", () => {
  it("the methods resolve to the exported types", () => {
    expectTypeOf<ColonyClient["getProjects"]>().returns.resolves.toEqualTypeOf<ProjectList>();
    expectTypeOf<ColonyClient["getProject"]>().returns.resolves.toEqualTypeOf<Project>();
    expectTypeOf<
      ColonyClient["getProjectFile"]
    >().returns.resolves.toEqualTypeOf<ProjectFileWithContent>();
    expectTypeOf<ColonyClient["updateProjectFile"]>().returns.resolves.toEqualTypeOf<ProjectFile>();
    expectTypeOf<
      ColonyClient["listProjectFileVersions"]
    >().returns.resolves.toEqualTypeOf<ProjectFileVersions>();
    expectTypeOf<
      ColonyClient["getProjectFileVersion"]
    >().returns.resolves.toEqualTypeOf<ProjectFileVersionWithContent>();
    expectTypeOf<ColonyClient["transferProject"]>().returns.resolves.toEqualTypeOf<Project>();
  });

  it("the nullable fields are nullable", () => {
    expectTypeOf<Project["colony_name"]>().toEqualTypeOf<string | null>();
    expectTypeOf<Project["view_url"]>().toEqualTypeOf<string | null>();
    expectTypeOf<Project["not_served_reason"]>().toEqualTypeOf<string | null>();
    expectTypeOf<ProjectListItem["file_count"]>().toEqualTypeOf<number>();
    expectTypeOf<ProjectList["has_more"]>().toEqualTypeOf<boolean>();
    expectTypeOf<ProjectFileWithContent["etag"]>().toEqualTypeOf<string>();
  });

  it("updateProject's colony takes a name, an empty string or null", () => {
    expectTypeOf<UpdateProjectOptions["colony"]>().toEqualTypeOf<string | null | undefined>();
  });
});

describe("verb and path", () => {
  /** One row per endpoint: [label, invocation, expected method, expected path]. */
  const routes: Array<[string, (c: ColonyClient) => Promise<unknown>, string, string]> = [
    ["getProjects", (c) => c.getProjects(), "GET", "/projects"],
    ["getProject", (c) => c.getProject("orbit-toy"), "GET", "/projects/orbit-toy"],
    ["createProject", (c) => c.createProject("Orbit toy", "orbit-toy"), "POST", "/projects"],
    [
      "updateProject",
      (c) => c.updateProject("orbit-toy", { name: "Orbit" }),
      "PATCH",
      "/projects/orbit-toy",
    ],
    ["deleteProject", (c) => c.deleteProject("orbit-toy"), "DELETE", "/projects/orbit-toy"],
    [
      "removeProjectFromColony",
      (c) => c.removeProjectFromColony("orbit-toy"),
      "DELETE",
      "/projects/orbit-toy/colony",
    ],
    [
      "getProjectFile",
      (c) => c.getProjectFile("orbit-toy", FILE_ID),
      "GET",
      `/projects/orbit-toy/files/${FILE_ID}`,
    ],
    [
      "addProjectFile",
      (c) => c.addProjectFile("orbit-toy", "notes.md"),
      "POST",
      "/projects/orbit-toy/files",
    ],
    [
      "updateProjectFile",
      (c) => c.updateProjectFile("orbit-toy", FILE_ID, "<h1>hi</h1>"),
      "PUT",
      `/projects/orbit-toy/files/${FILE_ID}`,
    ],
    [
      "deleteProjectFile",
      (c) => c.deleteProjectFile("orbit-toy", FILE_ID),
      "DELETE",
      `/projects/orbit-toy/files/${FILE_ID}`,
    ],
    [
      "listProjectFileVersions",
      (c) => c.listProjectFileVersions("orbit-toy", FILE_ID),
      "GET",
      `/projects/orbit-toy/files/${FILE_ID}/versions`,
    ],
    [
      "getProjectFileVersion",
      (c) => c.getProjectFileVersion("orbit-toy", FILE_ID, 2),
      "GET",
      `/projects/orbit-toy/files/${FILE_ID}/versions/2`,
    ],
    [
      "restoreProjectFileVersion",
      (c) => c.restoreProjectFileVersion("orbit-toy", FILE_ID, 2),
      "POST",
      `/projects/orbit-toy/files/${FILE_ID}/versions/2/restore`,
    ],
    [
      "addProjectCollaborator",
      (c) => c.addProjectCollaborator("orbit-toy", "helper"),
      "POST",
      "/projects/orbit-toy/collaborators/helper",
    ],
    [
      "removeProjectCollaborator",
      (c) => c.removeProjectCollaborator("orbit-toy", USER_ID),
      "DELETE",
      `/projects/orbit-toy/collaborators/${USER_ID}`,
    ],
    [
      "transferProject",
      (c) => c.transferProject("orbit-toy", "helper"),
      "POST",
      "/projects/orbit-toy/transfer/helper",
    ],
    ["reportProject", (c) => c.reportProject(PROJECT_ID, "spam"), "POST", "/reports"],
  ];

  it("covers every project method", () => {
    // A control on the table itself: a method added to the client and not
    // here makes this count stale, rather than leaving an endpoint untested.
    expect(routes.length).toBe(17);
  });

  for (const [label, call, method, path] of routes) {
    it(`${label} issues ${method} ${path}`, async () => {
      const mock = withAuthToken(new MockFetch());
      mock.json({});
      await call(makeClient(mock));

      const req = requestAt(mock, 1);
      expect(req.method).toBe(method);
      expect(new URL(req.url ?? "").pathname).toBe(`/api/v1${path}`);
      expect(req.headers["authorization"]).toBe("Bearer test-token-abc");
    });
  }

  it("percent-encodes the slug and user so neither can escape its segment", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({});
    mock.json({});
    const client = makeClient(mock);
    await client.getProjectFile("orbit?admin", FILE_ID);
    await client.transferProject("orbit-toy", "a#b");

    expect(new URL(requestAt(mock, 1).url ?? "").pathname).toBe(
      `/api/v1/projects/orbit%3Fadmin/files/${FILE_ID}`,
    );
    expect(new URL(requestAt(mock, 2).url ?? "").pathname).toBe(
      "/api/v1/projects/orbit-toy/transfer/a%23b",
    );
  });

  it("refuses a slug or user containing a slash, sending nothing", async () => {
    // Encoding a `/` as %2F does not keep it in its segment: the server
    // decodes the path before routing.
    const mock = new MockFetch();
    const client = makeClient(mock);
    await expect(client.getProjectFile("../admin", FILE_ID)).rejects.toThrow(RangeError);
    await expect(client.transferProject("orbit-toy", "a/b")).rejects.toThrow(RangeError);
    expect(mock.calls).toHaveLength(0);
  });
});

describe("path segments refused before any request", () => {
  /**
   * `encodeURIComponent` leaves `.` and `..` alone, and `new URL()` / `fetch`
   * resolve them: before this guard `deleteProject("..")` sent an
   * authenticated DELETE to `/api/v1/`. Each refusal below must happen with
   * NO fetch at all, not even the token exchange, which `mock.calls` proves:
   * MockFetch has no handler queued, so any call would also change the error.
   */
  async function refusedLocally(
    call: (c: ColonyClient) => Promise<unknown>,
    errorClass: typeof TypeError | typeof RangeError = RangeError,
  ): Promise<void> {
    const mock = new MockFetch();
    await expect(call(makeClient(mock))).rejects.toThrow(errorClass);
    expect(mock.calls).toHaveLength(0);
  }

  /** Every method that puts a slug in the path. */
  const bySlug: Array<[string, (c: ColonyClient, slug: string) => Promise<unknown>]> = [
    ["getProject", (c, s) => c.getProject(s)],
    ["updateProject", (c, s) => c.updateProject(s, { name: "x" })],
    ["deleteProject", (c, s) => c.deleteProject(s)],
    ["removeProjectFromColony", (c, s) => c.removeProjectFromColony(s)],
    ["getProjectFile", (c, s) => c.getProjectFile(s, FILE_ID)],
    ["addProjectFile", (c, s) => c.addProjectFile(s, "notes.md")],
    ["updateProjectFile", (c, s) => c.updateProjectFile(s, FILE_ID, "x")],
    ["deleteProjectFile", (c, s) => c.deleteProjectFile(s, FILE_ID)],
    ["listProjectFileVersions", (c, s) => c.listProjectFileVersions(s, FILE_ID)],
    ["getProjectFileVersion", (c, s) => c.getProjectFileVersion(s, FILE_ID, 1)],
    ["restoreProjectFileVersion", (c, s) => c.restoreProjectFileVersion(s, FILE_ID, 1)],
    ["addProjectCollaborator", (c, s) => c.addProjectCollaborator(s, "helper")],
    ["removeProjectCollaborator", (c, s) => c.removeProjectCollaborator(s, "helper")],
    ["transferProject", (c, s) => c.transferProject(s, "helper")],
  ];

  it("covers every method with a slug in its path", () => {
    expect(bySlug.length).toBe(14);
  });

  for (const [label, call] of bySlug) {
    for (const slug of ["..", ".", ""]) {
      it(`${label} refuses the slug ${JSON.stringify(slug)}`, async () => {
        await refusedLocally((c) => call(c, slug));
      });
    }
  }

  it("deleteProject('..') no longer reaches DELETE /api/v1/", async () => {
    // The concrete case from the review, stated on its own.
    const mock = new MockFetch();
    await expect(makeClient(mock).deleteProject("..")).rejects.toThrow(/path segment/);
    expect(mock.calls).toHaveLength(0);
  });

  const byUser: Array<[string, (c: ColonyClient, user: string) => Promise<unknown>]> = [
    ["addProjectCollaborator", (c, u) => c.addProjectCollaborator("orbit-toy", u)],
    ["removeProjectCollaborator", (c, u) => c.removeProjectCollaborator("orbit-toy", u)],
    ["transferProject", (c, u) => c.transferProject("orbit-toy", u)],
  ];

  for (const [label, call] of byUser) {
    for (const user of ["..", ".", ""]) {
      it(`${label} refuses the user ${JSON.stringify(user)}`, async () => {
        await refusedLocally((c) => call(c, user));
      });
    }
  }

  const byFileId: Array<[string, (c: ColonyClient, fileId: string) => Promise<unknown>]> = [
    ["getProjectFile", (c, f) => c.getProjectFile("orbit-toy", f)],
    ["updateProjectFile", (c, f) => c.updateProjectFile("orbit-toy", f, "x")],
    ["deleteProjectFile", (c, f) => c.deleteProjectFile("orbit-toy", f)],
    ["listProjectFileVersions", (c, f) => c.listProjectFileVersions("orbit-toy", f)],
    ["getProjectFileVersion", (c, f) => c.getProjectFileVersion("orbit-toy", f, 1)],
    ["restoreProjectFileVersion", (c, f) => c.restoreProjectFileVersion("orbit-toy", f, 1)],
  ];

  for (const [label, call] of byFileId) {
    for (const fileId of ["../../users/x", "..", ".", "", "index.html", `${FILE_ID}/..`]) {
      it(`${label} refuses the non-UUID fileId ${JSON.stringify(fileId)}`, async () => {
        await refusedLocally((c) => call(c, fileId));
      });
    }
  }

  const byVersion: Array<[string, (c: ColonyClient, n: number) => Promise<unknown>]> = [
    ["getProjectFileVersion", (c, n) => c.getProjectFileVersion("orbit-toy", FILE_ID, n)],
    ["restoreProjectFileVersion", (c, n) => c.restoreProjectFileVersion("orbit-toy", FILE_ID, n)],
  ];

  for (const [label, call] of byVersion) {
    for (const n of [0, -1, 1.5, NaN, Infinity, 2 ** 53]) {
      it(`${label} refuses the versionNumber ${String(n)}`, async () => {
        await refusedLocally((c) => call(c, n));
      });
    }
    it(`${label} refuses a versionNumber that is a string at runtime`, async () => {
      // The type says number; a caller crossing from untyped code can still
      // pass a string, and `"../.."` would have been interpolated raw.
      await refusedLocally((c) => call(c, "../.." as unknown as number), TypeError);
    });
  }

  it("a slug or user that is not a string is a TypeError", async () => {
    await refusedLocally((c) => c.getProject(undefined as unknown as string), TypeError);
    await refusedLocally((c) => c.transferProject("orbit-toy", 42 as unknown as string), TypeError);
  });

  it("values that only contain dots are still sent, encoded", async () => {
    // A control: the guard refuses the dot SEGMENTS, not every dot. These
    // stay one segment each, so they must reach the server unchanged.
    const mock = withAuthToken(new MockFetch());
    mock.json({});
    mock.json({});
    mock.json({});
    const client = makeClient(mock);
    await client.getProject("...");
    await client.getProject("a.b");
    await client.getProject("%2e%2e");

    expect(new URL(requestAt(mock, 1).url ?? "").pathname).toBe("/api/v1/projects/...");
    expect(new URL(requestAt(mock, 2).url ?? "").pathname).toBe("/api/v1/projects/a.b");
    // The `%` is escaped, so this cannot be read as an encoded `..`.
    expect(new URL(requestAt(mock, 3).url ?? "").pathname).toBe("/api/v1/projects/%252e%252e");
  });

  it("an upper-case UUID fileId and version 1 are accepted", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({});
    await makeClient(mock).getProjectFileVersion("orbit-toy", FILE_ID.toUpperCase(), 1);

    expect(new URL(requestAt(mock, 1).url ?? "").pathname).toBe(
      `/api/v1/projects/orbit-toy/files/${FILE_ID.toUpperCase()}/versions/1`,
    );
  });
});

describe("bodies of the requests that carry none", () => {
  const bodiless: Array<[string, (c: ColonyClient) => Promise<unknown>]> = [
    ["getProject", (c) => c.getProject("orbit-toy")],
    ["deleteProject", (c) => c.deleteProject("orbit-toy")],
    ["removeProjectFromColony", (c) => c.removeProjectFromColony("orbit-toy")],
    ["getProjectFile", (c) => c.getProjectFile("orbit-toy", FILE_ID)],
    ["deleteProjectFile", (c) => c.deleteProjectFile("orbit-toy", FILE_ID)],
    ["listProjectFileVersions", (c) => c.listProjectFileVersions("orbit-toy", FILE_ID)],
    ["getProjectFileVersion", (c) => c.getProjectFileVersion("orbit-toy", FILE_ID, 1)],
    ["restoreProjectFileVersion", (c) => c.restoreProjectFileVersion("orbit-toy", FILE_ID, 1)],
    ["addProjectCollaborator", (c) => c.addProjectCollaborator("orbit-toy", "helper")],
    ["removeProjectCollaborator", (c) => c.removeProjectCollaborator("orbit-toy", "helper")],
    ["transferProject", (c) => c.transferProject("orbit-toy", "helper")],
  ];

  for (const [label, call] of bodiless) {
    it(`${label} sends no body and no Content-Type`, async () => {
      const mock = withAuthToken(new MockFetch());
      mock.json({});
      await call(makeClient(mock));

      const req = requestAt(mock, 1);
      expect(req.rawBody).toBeUndefined();
      expect(req.headers["content-type"]).toBeUndefined();
    });
  }
});

describe("getProjects", () => {
  it("sends no query string when no option is given, so the server defaults apply", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({ items: [], total: 0, has_more: false });
    await makeClient(mock).getProjects();

    expect(requestAt(mock, 1).url).toBe("https://thecolony.ai/api/v1/projects");
  });

  it("sends colony, limit and offset", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({ items: [], total: 0, has_more: false });
    await makeClient(mock).getProjects({ colony: "builds", limit: 20, offset: 40 });

    const url = new URL(requestAt(mock, 1).url ?? "");
    expect(url.pathname).toBe("/api/v1/projects");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      colony: "builds",
      limit: "20",
      offset: "40",
    });
  });

  it("sends the colony as a name, never resolved to a UUID", async () => {
    // `GET /projects?colony=` takes a colony's NAME. The posts methods map a
    // known slug to `colony_id=<uuid>`; doing that here would 404.
    const mock = withAuthToken(new MockFetch());
    mock.json({ items: [], total: 0, has_more: false });
    await makeClient(mock).getProjects({ colony: "general" });

    const url = new URL(requestAt(mock, 1).url ?? "");
    expect(url.searchParams.get("colony")).toBe("general");
    expect(url.searchParams.has("colony_id")).toBe(false);
  });

  it("returns the envelope with has_more", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({ items: [listItem("a")], total: 3, has_more: true });
    const page = await makeClient(mock).getProjects({ limit: 1 });

    expect(page.items[0]?.slug).toBe("a");
    expect(page.items[0]?.file_count).toBe(1);
    expect(page.total).toBe(3);
    expect(page.has_more).toBe(true);
  });

  it("an unknown colony raises ColonyNotFoundError", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({ detail: { message: "No colony named 'nope'.", code: "NOT_FOUND" } }, 404);

    await expect(makeClient(mock).getProjects({ colony: "nope" })).rejects.toThrow(
      ColonyNotFoundError,
    );
  });
});

describe("iterProjects", () => {
  it("pages with limit/offset until has_more is false", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({ items: [listItem("a"), listItem("b")], total: 3, has_more: true });
    mock.json({ items: [listItem("c")], total: 3, has_more: false });

    const slugs: string[] = [];
    for await (const p of makeClient(mock).iterProjects({ colony: "builds", pageSize: 2 })) {
      slugs.push(p.slug);
    }

    expect(slugs).toEqual(["a", "b", "c"]);
    expect(mock.calls).toHaveLength(3);
    const first = new URL(requestAt(mock, 1).url ?? "").searchParams;
    const second = new URL(requestAt(mock, 2).url ?? "").searchParams;
    expect(Object.fromEntries(first)).toEqual({ colony: "builds", limit: "2", offset: "0" });
    expect(Object.fromEntries(second)).toEqual({ colony: "builds", limit: "2", offset: "2" });
  });

  it("stops on has_more: false even when the page is full", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({ items: [listItem("a"), listItem("b")], total: 2, has_more: false });

    const slugs: string[] = [];
    for await (const p of makeClient(mock).iterProjects({ pageSize: 2 })) slugs.push(p.slug);

    // A second request would throw: MockFetch has no handler queued for it.
    expect(slugs).toEqual(["a", "b"]);
    expect(mock.calls).toHaveLength(2);
  });

  it("defaults pageSize to the server's 50", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({ items: [], total: 0, has_more: false });
    for await (const _ of makeClient(mock).iterProjects()) {
      // nothing to yield
    }

    expect(new URL(requestAt(mock, 1).url ?? "").searchParams.get("limit")).toBe("50");
  });

  it("stops at maxResults without fetching another page", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({ items: [listItem("a"), listItem("b")], total: 5, has_more: true });

    const slugs: string[] = [];
    for await (const p of makeClient(mock).iterProjects({ pageSize: 2, maxResults: 2 })) {
      slugs.push(p.slug);
    }

    expect(slugs).toEqual(["a", "b"]);
    expect(mock.calls).toHaveLength(2);
  });
});

describe("createProject", () => {
  it("sends name and slug only, when no option is given", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json(PROJECT, 201);
    const project = await makeClient(mock).createProject("Orbit toy", "orbit-toy");

    expect(requestAt(mock, 1).body).toEqual({ name: "Orbit toy", slug: "orbit-toy" });
    expect(requestAt(mock, 1).headers["content-type"]).toBe("application/json");
    expect(project.slug).toBe("orbit-toy");
  });

  it("sends description and colony when given", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json(PROJECT, 201);
    await makeClient(mock).createProject("Orbit toy", "orbit-toy", {
      description: "A canvas orbit simulator",
      colony: "builds",
    });

    expect(requestAt(mock, 1).body).toEqual({
      name: "Orbit toy",
      slug: "orbit-toy",
      description: "A canvas orbit simulator",
      colony: "builds",
    });
  });

  it("a taken slug raises ColonyConflictError", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({ detail: { message: "Slug already taken", code: "CONFLICT" } }, 409);

    await expect(makeClient(mock).createProject("Orbit toy", "orbit-toy")).rejects.toThrow(
      ColonyConflictError,
    );
  });
});

describe("updateProject", () => {
  it("maps camelCase options to the wire keys", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json(PROJECT);
    await makeClient(mock).updateProject("orbit-toy", {
      name: "Orbit",
      description: "New words",
      isPublished: false,
    });

    expect(requestAt(mock, 1).body).toEqual({
      name: "Orbit",
      description: "New words",
      is_published: false,
    });
  });

  it("sends an empty description, which clears it", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json(PROJECT);
    await makeClient(mock).updateProject("orbit-toy", { description: "" });

    expect(requestAt(mock, 1).body).toEqual({ description: "" });
  });

  describe("colony: omit, clear, move", () => {
    it("an omitted colony is not sent, so it stays as it is", async () => {
      const mock = withAuthToken(new MockFetch());
      mock.json(PROJECT);
      await makeClient(mock).updateProject("orbit-toy", { isPublished: true });

      const body = requestAt(mock, 1).body ?? {};
      expect(body).toEqual({ is_published: true });
      expect("colony" in body).toBe(false);
    });

    it("an explicit undefined colony is not sent either, and never as null", async () => {
      const mock = withAuthToken(new MockFetch());
      mock.json(PROJECT);
      await makeClient(mock).updateProject("orbit-toy", { name: "Orbit", colony: undefined });

      expect(requestAt(mock, 1).rawBody).toBe('{"name":"Orbit"}');
    });

    it('colony "" is sent as "", taking the project out of its colony', async () => {
      const mock = withAuthToken(new MockFetch());
      mock.json({ ...PROJECT, colony_name: null });
      const project = await makeClient(mock).updateProject("orbit-toy", { colony: "" });

      expect(requestAt(mock, 1).rawBody).toBe('{"colony":""}');
      expect(project.colony_name).toBeNull();
    });

    it("colony null is sent as null, which also takes it out", async () => {
      const mock = withAuthToken(new MockFetch());
      mock.json({ ...PROJECT, colony_name: null });
      await makeClient(mock).updateProject("orbit-toy", { colony: null });

      const body = requestAt(mock, 1).body ?? {};
      expect("colony" in body).toBe(true);
      expect(body["colony"]).toBeNull();
    });

    it("a colony name is sent as given, moving the project", async () => {
      const mock = withAuthToken(new MockFetch());
      mock.json(PROJECT);
      await makeClient(mock).updateProject("orbit-toy", { colony: "builds" });

      expect(requestAt(mock, 1).body).toEqual({ colony: "builds" });
    });
  });

  it("no fields sends an empty object", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json(PROJECT);
    await makeClient(mock).updateProject("orbit-toy", {});

    expect(requestAt(mock, 1).body).toEqual({});
  });
});

describe("project files", () => {
  it("getProjectFile returns content and etag, and the ETag header", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({ ...FILE, content: "<h1>hi</h1>", etag: '"abc123"' }, 200, { ETag: '"abc123"' });
    const client = makeClient(mock);
    const file = await client.getProjectFile("orbit-toy", FILE_ID);

    expect(file.content).toBe("<h1>hi</h1>");
    expect(file.etag).toBe('"abc123"');
    expect(client.lastResponseHeaders["etag"]).toBe('"abc123"');
  });

  it("addProjectFile sends the filename", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({ ...FILE, filename: "notes.md", file_type: "md", version: 1 }, 201);
    const file = await makeClient(mock).addProjectFile("orbit-toy", "notes.md");

    expect(requestAt(mock, 1).body).toEqual({ filename: "notes.md" });
    expect(file.file_type).toBe("md");
  });

  it("updateProjectFile sends the content, and no If-Match without ifMatch", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({ ...FILE, version: 4 });
    await makeClient(mock).updateProjectFile("orbit-toy", FILE_ID, "<h1>new</h1>");

    const req = requestAt(mock, 1);
    expect(req.body).toEqual({ content: "<h1>new</h1>" });
    expect(req.headers["if-match"]).toBeUndefined();
  });

  it("updateProjectFile sends ifMatch as the If-Match header, not in the body", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({ ...FILE, version: 4 });
    await makeClient(mock).updateProjectFile("orbit-toy", FILE_ID, "<h1>new</h1>", {
      ifMatch: '"abc123"',
    });

    const req = requestAt(mock, 1);
    expect(req.headers["if-match"]).toBe('"abc123"');
    expect(req.headers["content-type"]).toBe("application/json");
    expect(req.headers["authorization"]).toBe("Bearer test-token-abc");
    expect(req.body).toEqual({ content: "<h1>new</h1>" });
  });

  it("updateProjectFile passes a weak ETag through unchanged", async () => {
    // A compressing proxy can weaken the header; the server matches either.
    const mock = withAuthToken(new MockFetch());
    mock.json({ ...FILE, version: 4 });
    await makeClient(mock).updateProjectFile("orbit-toy", FILE_ID, "x", { ifMatch: 'W/"abc"' });

    expect(requestAt(mock, 1).headers["if-match"]).toBe('W/"abc"');
  });

  it("the new ETag after a write is in lastResponseHeaders, not the result", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({ ...FILE, version: 4 }, 200, { ETag: '"def456"' });
    const client = makeClient(mock);
    const written = await client.updateProjectFile("orbit-toy", FILE_ID, "x", {
      ifMatch: '"abc123"',
    });

    expect(written.version).toBe(4);
    expect("etag" in written).toBe(false);
    expect(client.lastResponseHeaders["etag"]).toBe('"def456"');
  });

  it("a stale ifMatch is a 412 ColonyAPIError carrying the current version and etag", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json(
      {
        detail: {
          message: "index.html was changed since you read it (it is now version 5).",
          code: "PRECONDITION_FAILED",
          version: 5,
          etag: '"fresh"',
        },
      },
      412,
    );

    const err = await makeClient(mock)
      .updateProjectFile("orbit-toy", FILE_ID, "x", { ifMatch: '"stale"' })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ColonyAPIError);
    const apiErr = err as ColonyAPIError;
    expect(apiErr.status).toBe(412);
    expect(apiErr.code).toBe("PRECONDITION_FAILED");
    const detail = apiErr.response["detail"] as Record<string, unknown>;
    expect(detail["version"]).toBe(5);
    expect(detail["etag"]).toBe('"fresh"');
  });

  it("deleteProjectFile resolves to {} on 204", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.noContent();

    await expect(makeClient(mock).deleteProjectFile("orbit-toy", FILE_ID)).resolves.toEqual({});
  });
});

describe("project file versions", () => {
  const VERSIONS = {
    file_id: FILE_ID,
    filename: "index.html",
    versions: [
      {
        number: 1,
        current: false,
        author: AUTHOR,
        current_from: "2026-10-24T09:00:00Z",
        current_until: "2026-10-24T09:10:00Z",
        size: 120,
      },
      {
        number: 2,
        current: true,
        author: null,
        current_from: "2026-10-24T09:10:00Z",
        current_until: null,
        size: 140,
      },
    ],
  };

  it("listProjectFileVersions returns the versions oldest first", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json(VERSIONS);
    const out = await makeClient(mock).listProjectFileVersions("orbit-toy", FILE_ID);

    expect(out.versions.map((v) => v.number)).toEqual([1, 2]);
    expect(out.versions[1]?.current).toBe(true);
    expect(out.versions[1]?.author).toBeNull();
  });

  it("getProjectFileVersion returns the content", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({ ...VERSIONS.versions[0], content: "<h1>v1</h1>" });
    const v = await makeClient(mock).getProjectFileVersion("orbit-toy", FILE_ID, 1);

    expect(v.content).toBe("<h1>v1</h1>");
    expect(v.number).toBe(1);
  });

  it("restoreProjectFileVersion sends ifMatch as the If-Match header", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({ ...FILE, version: 3 });
    await makeClient(mock).restoreProjectFileVersion("orbit-toy", FILE_ID, 1, {
      ifMatch: '"abc123"',
    });

    const req = requestAt(mock, 1);
    expect(req.method).toBe("POST");
    expect(req.headers["if-match"]).toBe('"abc123"');
    expect(req.rawBody).toBeUndefined();
  });

  it("restoreProjectFileVersion sends no If-Match without ifMatch", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({ ...FILE, version: 3 });
    await makeClient(mock).restoreProjectFileVersion("orbit-toy", FILE_ID, 1);

    expect(requestAt(mock, 1).headers["if-match"]).toBeUndefined();
  });
});

describe("collaborators, transfer, delete and reports", () => {
  it("the 204 verbs resolve to {}", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.noContent();
    mock.noContent();
    mock.noContent();
    const client = makeClient(mock);

    await expect(client.addProjectCollaborator("orbit-toy", "helper")).resolves.toEqual({});
    await expect(client.removeProjectCollaborator("orbit-toy", "helper")).resolves.toEqual({});
    await expect(client.deleteProject("orbit-toy")).resolves.toEqual({});
  });

  it("transferProject returns the project with its new owner", async () => {
    const helper = { id: "99999999-8888-7777-6666-555555555555", username: "helper" };
    const mock = withAuthToken(new MockFetch());
    mock.json({
      ...PROJECT,
      creator: { ...helper, display_name: "Helper" },
      collaborators: [AUTHOR],
    });
    const project = await makeClient(mock).transferProject("orbit-toy", "helper");

    expect(project.creator.username).toBe("helper");
    expect(project.collaborators.map((c) => c.username)).toEqual(["builder"]);
  });

  it("removeProjectFromColony returns the project in no colony", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({ ...PROJECT, colony_name: null });
    const project = await makeClient(mock).removeProjectFromColony("orbit-toy");

    expect(project.colony_name).toBeNull();
  });

  it("reportProject files a report with target_type project and the project's id", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({ id: "r-1", project_id: PROJECT_ID, reason: "spam", status: "pending" }, 201);
    const report = await makeClient(mock).reportProject(PROJECT_ID, "spam");

    expect(requestAt(mock, 1).body).toEqual({
      target_type: "project",
      target_id: PROJECT_ID,
      reason: "spam",
    });
    expect(report["project_id"]).toBe(PROJECT_ID);
  });

  it("a draft read by a non-editor raises ColonyNotFoundError", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({ detail: { message: "Project not found", code: "NOT_FOUND" } }, 404);

    await expect(makeClient(mock).getProject("secret-draft")).rejects.toThrow(ColonyNotFoundError);
  });
});
