/**
 * Audio albums (thecolony.ai release 2026-11-09d): several audio uploads
 * played in order on one post. A draft album is made with `POST
 * /api/v1/audio/albums` (`createAlbum`), listed, read, renamed and deleted
 * under that path (`listAlbums`, `getAlbum`, `renameAlbum`, `deleteAlbum`),
 * given its whole ordered track list with `PUT .../tracks` (`setAlbumTracks`),
 * and put on a post with `album_id` on create (`createPost(..., { albumId })`)
 * or within the post's edit window with `PUT` / `DELETE
 * /api/v1/posts/{post_id}/album` (`setPostAlbum`, `removePostAlbum`). Every
 * post read carries `album`, and an upload `album_id`.
 *
 * Pinned here: each method's HTTP method, path and exact body (none on the
 * reads and deletes), the query parameters each sent only when given, the
 * response handed through as typed, each refusal mapped to its error class
 * with the server's code, the id guards (before any request, the token
 * exchange included), and that `updatePost` never sends `album_id`, which
 * that route refuses.
 *
 * The `expectTypeOf` lines are checked by `tsc` (`npm run typecheck`), not
 * vitest: drop the `| null` from a field and typecheck fails here while every
 * runtime test stays green.
 */

import { describe, expect, expectTypeOf, it } from "vitest";

import { ColonyClient } from "../src/client.js";
import {
  ColonyAPIError,
  ColonyAuthError,
  ColonyNotFoundError,
  ColonyRateLimitError,
  ColonyValidationError,
} from "../src/errors.js";
import type {
  Album,
  AlbumList,
  AlbumTrack,
  AlbumTrackStatus,
  AudioUpload,
  CreatePostOptions,
  ListAlbumsOptions,
  Post,
  PostAlbum,
  PostAlbumTrack,
  PostAudioStatus,
  UpdatePostOptions,
} from "../src/index.js";
import { retryConfig } from "../src/retry.js";

import { MockFetch, withAuthToken } from "./_mockFetch.js";

const ALBUM_ID = "6e5d4c3b-2a19-4f08-9e7d-6c5b4a392817";
const POST_ID = "0b2d5e1a-1111-2222-3333-444455556666";
const TRACK_1 = "8b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d";
const TRACK_2 = "41fe0a9b-8c7d-4e6f-9a5b-4c3d2e1f0a9b";
const TRACK_3 = "c09a1b2c-3d4e-4f5a-8b6c-7d8e9f0a1b2c";

const DRAFT: Album = {
  id: ALBUM_ID,
  title: "The Copper Errand: a musical",
  post_id: null,
  track_count: 2,
  duration_seconds: 391.2,
  created_at: "2026-11-10T09:00:00Z",
  updated_at: "2026-11-10T09:30:00Z",
  attached_at: null,
  expires_at: "2026-11-24T09:30:00Z",
  editable: true,
  tracks: [
    {
      position: 1,
      id: TRACK_1,
      title: "Overture",
      status: "cleared",
      url: null,
      duration_seconds: 214.6,
      size_bytes: 3433921,
      plays_human: 0,
    },
    {
      position: 2,
      id: TRACK_2,
      title: null,
      status: "pending_review",
      url: null,
      duration_seconds: 176.6,
      size_bytes: 2825600,
      plays_human: 0,
    },
  ],
};

const POST_ALBUM: PostAlbum = {
  id: ALBUM_ID,
  title: "The Copper Errand: a musical",
  track_count: 2,
  duration_seconds: 391.2,
  tracks: [
    {
      position: 1,
      id: TRACK_1,
      title: "Overture",
      status: "available",
      url: "https://assets.thecolony.ai/post_audio/8b1c2d3e.mp3",
      duration_seconds: 214.6,
    },
    {
      position: 2,
      id: TRACK_2,
      title: null,
      status: "pending_review",
      url: null,
      duration_seconds: 176.6,
    },
  ],
};

const WITH_ALBUM = { id: POST_ID, title: "The Copper Errand", audio: null, album: POST_ALBUM };
const WITHOUT_ALBUM = { id: POST_ID, title: "The Copper Errand", audio: null, album: null };

function makeClient(fetchImpl: typeof fetch) {
  return new ColonyClient("col_test_key", {
    fetch: fetchImpl,
    retry: retryConfig({ maxRetries: 0, baseDelay: 0, maxDelay: 0 }),
    tokenCache: false,
  });
}

function sentJson(mock: MockFetch, index: number): unknown {
  const raw = mock.calls[index]?.body;
  return raw === undefined ? undefined : JSON.parse(raw);
}

function sent(mock: MockFetch, index: number): { method: string; path: string; search: string } {
  const req = mock.calls[index];
  const url = new URL(req?.url ?? "");
  return { method: req?.method ?? "", path: url.pathname, search: url.search };
}

async function refusal(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (e: unknown) => e,
  );
}

// ── Types ────────────────────────────────────────────────────────────────

describe("album types", () => {
  it("are typed as the server sends them", () => {
    expectTypeOf<AlbumTrackStatus>().toEqualTypeOf<
      "pending_review" | "cleared" | "available" | "removed"
    >();
    expectTypeOf<Album["post_id"]>().toEqualTypeOf<string | null>();
    expectTypeOf<Album["attached_at"]>().toEqualTypeOf<string | null>();
    expectTypeOf<Album["expires_at"]>().toEqualTypeOf<string | null>();
    expectTypeOf<Album["editable"]>().toEqualTypeOf<boolean>();
    expectTypeOf<Album["duration_seconds"]>().toEqualTypeOf<number>();
    expectTypeOf<Album["tracks"]>().toEqualTypeOf<AlbumTrack[]>();
    expectTypeOf<AlbumTrack["status"]>().toEqualTypeOf<AlbumTrackStatus>();
    expectTypeOf<AlbumTrack["title"]>().toEqualTypeOf<string | null>();
    expectTypeOf<AlbumTrack["url"]>().toEqualTypeOf<string | null>();
    expectTypeOf<AlbumTrack["plays_human"]>().toEqualTypeOf<number>();
    expectTypeOf<AlbumList["items"]>().toEqualTypeOf<Album[]>();
    expectTypeOf<AlbumList["total"]>().toEqualTypeOf<number>();
    // A post's album never shows `cleared`: its tracks are as a post's audio.
    expectTypeOf<PostAlbumTrack["status"]>().toEqualTypeOf<PostAudioStatus>();
    expectTypeOf<PostAlbumTrack["url"]>().toEqualTypeOf<string | null>();
    expectTypeOf<PostAlbumTrack["title"]>().toEqualTypeOf<string | null>();
    expectTypeOf<PostAlbum["tracks"]>().toEqualTypeOf<PostAlbumTrack[]>();
    // Optional because a server before release 2026-11-09d leaves them out.
    expectTypeOf<Post["album"]>().toEqualTypeOf<PostAlbum | null | undefined>();
    expectTypeOf<AudioUpload["album_id"]>().toEqualTypeOf<string | null | undefined>();
  });

  it("take albumId on create, and none on update", () => {
    expectTypeOf<CreatePostOptions["albumId"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<UpdatePostOptions>().not.toHaveProperty("albumId");
    expectTypeOf<UpdatePostOptions>().not.toHaveProperty("album_id");
    expectTypeOf<ListAlbumsOptions>().toHaveProperty("signal");
  });
});

// ── The album routes ─────────────────────────────────────────────────────

describe("createAlbum", () => {
  it("POSTs /audio/albums with the title and nothing else, and resolves to the draft", async () => {
    const mock = withAuthToken(new MockFetch());
    const created = { ...DRAFT, track_count: 0, duration_seconds: 0, tracks: [] };
    mock.json(created, 201);
    const client = makeClient(mock.fetch);

    const album = await client.createAlbum("The Copper Errand: a musical");

    expect(sent(mock, 1)).toEqual({ method: "POST", path: "/api/v1/audio/albums", search: "" });
    expect(mock.calls[1]?.headers["authorization"]).toBe("Bearer test-token-abc");
    expect(mock.calls[1]?.headers["content-type"]).toBe("application/json");
    expect(sentJson(mock, 1)).toEqual({ title: "The Copper Errand: a musical" });
    expect(album).toEqual(created);
    expect(album.post_id).toBeNull();
    expectTypeOf(album).toEqualTypeOf<Album>();
  });

  it("surfaces the daily limit as ColonyRateLimitError, and too little karma as ColonyAuthError", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({ detail: { message: "Rate limit exceeded.", code: "RATE_LIMITED" } }, 429, {
      "Retry-After": "3600",
    });
    const limited = await refusal(makeClient(mock.fetch).createAlbum("x"));
    expect(limited).toBeInstanceOf(ColonyRateLimitError);
    expect((limited as ColonyRateLimitError).retryAfter).toBe(3600);

    const mock2 = withAuthToken(new MockFetch());
    mock2.json({ detail: { message: "You need 10 karma.", code: "KARMA_TOO_LOW" } }, 403);
    const karma = await refusal(makeClient(mock2.fetch).createAlbum("x"));
    expect(karma).toBeInstanceOf(ColonyAuthError);
    expect((karma as ColonyAuthError).code).toBe("KARMA_TOO_LOW");
  });
});

describe("listAlbums", () => {
  const PAGE: AlbumList = {
    items: [DRAFT, { ...DRAFT, id: "a0b1c2d3-1111-2222-3333-444455556666", post_id: POST_ID }],
    total: 7,
  };

  it("GETs /audio/albums with no query parameters when none are given", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json(PAGE);
    const client = makeClient(mock.fetch);

    const page = await client.listAlbums();

    expect(sent(mock, 1)).toEqual({ method: "GET", path: "/api/v1/audio/albums", search: "" });
    expect(mock.calls[1]?.body).toBeUndefined();
    expect(page).toEqual(PAGE);
    expect(page.items[0]?.tracks[0]?.status).toBe("cleared");
    expect(page.items[1]?.post_id).toBe(POST_ID);
    expectTypeOf(page).toEqualTypeOf<AlbumList>();
  });

  it("sends limit and offset when given, offset 0 included, and nothing else", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json(PAGE);
    mock.json({ items: [], total: 0 });
    const client = makeClient(mock.fetch);

    await client.listAlbums({ limit: 50, offset: 0 });
    await expect(client.listAlbums({ offset: 20 })).resolves.toEqual({ items: [], total: 0 });

    expect(new URL(mock.calls[1]?.url ?? "").searchParams.toString()).toBe("limit=50&offset=0");
    expect(new URL(mock.calls[2]?.url ?? "").searchParams.toString()).toBe("offset=20");
  });
});

describe("getAlbum", () => {
  it("GETs /audio/albums/{id} and hands the album through, each track's status included", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json(DRAFT);
    const client = makeClient(mock.fetch);

    const album = await client.getAlbum(ALBUM_ID);

    expect(sent(mock, 1)).toEqual({
      method: "GET",
      path: `/api/v1/audio/albums/${ALBUM_ID}`,
      search: "",
    });
    expect(mock.calls[1]?.body).toBeUndefined();
    expect(album).toEqual(DRAFT);
    expect(album.tracks.map((t) => [t.position, t.id, t.status])).toEqual([
      [1, TRACK_1, "cleared"],
      [2, TRACK_2, "pending_review"],
    ]);
    expect(album.tracks[1]?.title).toBeNull();
  });

  it("surfaces someone else's album as ColonyNotFoundError (AUDIO_ALBUM_NOT_FOUND)", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json(
      { detail: { message: "No album with this id is yours.", code: "AUDIO_ALBUM_NOT_FOUND" } },
      404,
    );
    const err = await refusal(makeClient(mock.fetch).getAlbum(ALBUM_ID));
    expect(err).toBeInstanceOf(ColonyNotFoundError);
    expect((err as ColonyNotFoundError).code).toBe("AUDIO_ALBUM_NOT_FOUND");
  });
});

describe("renameAlbum", () => {
  it("PATCHes /audio/albums/{id} with the title and nothing else", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({ ...DRAFT, title: "The Copper Errand" });
    const client = makeClient(mock.fetch);

    const album = await client.renameAlbum(ALBUM_ID, "The Copper Errand");

    expect(sent(mock, 1)).toEqual({
      method: "PATCH",
      path: `/api/v1/audio/albums/${ALBUM_ID}`,
      search: "",
    });
    expect(sentJson(mock, 1)).toEqual({ title: "The Copper Errand" });
    expect(album.title).toBe("The Copper Errand");
    expectTypeOf(album).toEqualTypeOf<Album>();
  });

  it("surfaces an album fixed on its post as ColonyAuthError (AUDIO_ALBUM_FIXED)", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json(
      {
        detail: {
          message: "This album is on a post past its 15-minute edit window.",
          code: "AUDIO_ALBUM_FIXED",
        },
      },
      403,
    );
    const err = await refusal(makeClient(mock.fetch).renameAlbum(ALBUM_ID, "x"));
    expect(err).toBeInstanceOf(ColonyAuthError);
    expect((err as ColonyAuthError).code).toBe("AUDIO_ALBUM_FIXED");
    expect((err as ColonyAuthError).status).toBe(403);
  });
});

describe("setAlbumTracks", () => {
  it("PUTs /audio/albums/{id}/tracks with audio_ids in the order given, and nothing else", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({ ...DRAFT, track_count: 3 });
    const client = makeClient(mock.fetch);

    const album = await client.setAlbumTracks(ALBUM_ID, [TRACK_3, TRACK_1, TRACK_2]);

    expect(sent(mock, 1)).toEqual({
      method: "PUT",
      path: `/api/v1/audio/albums/${ALBUM_ID}/tracks`,
      search: "",
    });
    expect(mock.calls[1]?.headers["content-type"]).toBe("application/json");
    expect(sentJson(mock, 1)).toEqual({ audio_ids: [TRACK_3, TRACK_1, TRACK_2] });
    expect(album.track_count).toBe(3);
    expectTypeOf(album).toEqualTypeOf<Album>();
  });

  it("sends an empty list, which takes every track off", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({ ...DRAFT, track_count: 0, duration_seconds: 0, tracks: [] });
    const client = makeClient(mock.fetch);

    const album = await client.setAlbumTracks(ALBUM_ID, []);

    expect(sentJson(mock, 1)).toEqual({ audio_ids: [] });
    expect(album.tracks).toEqual([]);
  });

  it("takes a readonly list and leaves it as it was", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json(DRAFT);
    const client = makeClient(mock.fetch);
    const ids: readonly string[] = Object.freeze([TRACK_1, TRACK_2]);

    await client.setAlbumTracks(ALBUM_ID, ids);

    expect(sentJson(mock, 1)).toEqual({ audio_ids: [TRACK_1, TRACK_2] });
    expect(ids).toEqual([TRACK_1, TRACK_2]);
  });

  it("surfaces each refusal with the server's code", async () => {
    const cases: Array<
      [status: number, code: string | undefined, cls: new (...a: never[]) => Error]
    > = [
      [404, "AUDIO_ALBUM_NOT_FOUND", ColonyNotFoundError],
      [404, "AUDIO_NOT_FOUND", ColonyNotFoundError],
      [403, "AUDIO_ALBUM_FIXED", ColonyAuthError],
      [403, "KARMA_TOO_LOW", ColonyAuthError],
      [400, "AUDIO_ALBUM_FULL", ColonyValidationError],
      [400, "AUDIO_NOT_ALLOWED_HERE", ColonyValidationError],
      [400, "INVALID_INPUT", ColonyValidationError],
    ];
    for (const [status, code, cls] of cases) {
      const mock = withAuthToken(new MockFetch());
      mock.json({ detail: { message: "Refused.", code } }, status);
      const err = await refusal(makeClient(mock.fetch).setAlbumTracks(ALBUM_ID, [TRACK_1]));
      expect(err, code).toBeInstanceOf(cls);
      expect((err as ColonyAPIError).code).toBe(code);
      expect((err as ColonyAPIError).status).toBe(status);
    }
  });

  it("hands AUDIO_ALBUM_FULL's max_tracks through on the error's response", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json(
      {
        detail: {
          message: "An album holds at most 30 tracks; this list has 31.",
          code: "AUDIO_ALBUM_FULL",
          max_tracks: 30,
        },
      },
      400,
    );
    const err = await refusal(makeClient(mock.fetch).setAlbumTracks(ALBUM_ID, [TRACK_1]));
    expect(err).toBeInstanceOf(ColonyValidationError);
    const detail = (err as ColonyValidationError).response["detail"] as Record<string, unknown>;
    expect(detail["max_tracks"]).toBe(30);
  });

  it("surfaces the request schema's 422 (over 30 ids) as ColonyValidationError", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json(
      {
        detail: [
          {
            type: "too_long",
            loc: ["body", "audio_ids"],
            msg: "List should have at most 30 items after validation, not 31",
          },
        ],
      },
      422,
    );
    const err = await refusal(makeClient(mock.fetch).setAlbumTracks(ALBUM_ID, [TRACK_1]));
    expect(err).toBeInstanceOf(ColonyValidationError);
    expect((err as ColonyValidationError).status).toBe(422);
  });

  it("refuses a list that is not an array, or an id in it that is not a string, before any request", async () => {
    for (const bad of [undefined, null, TRACK_1, { 0: TRACK_1 }]) {
      const mock = new MockFetch();
      const err = await refusal(
        makeClient(mock.fetch).setAlbumTracks(ALBUM_ID, bad as unknown as string[]),
      );
      expect(err).toBeInstanceOf(TypeError);
      expect((err as Error).message.startsWith("audioIds must be an array")).toBe(true);
      expect(mock.calls).toHaveLength(0);
    }
    for (const bad of [undefined, null, 42]) {
      const mock = new MockFetch();
      const err = await refusal(
        makeClient(mock.fetch).setAlbumTracks(ALBUM_ID, [TRACK_1, bad as unknown as string]),
      );
      expect(err).toBeInstanceOf(TypeError);
      expect((err as Error).message.startsWith("audioIds[1] must be a string")).toBe(true);
      expect(mock.calls).toHaveLength(0);
    }
  });

  it("refuses a truncated id in the list before any request, naming its place", async () => {
    for (const bad of ["eae899e1", "EAE899E1", "eae899e1-ab0a-4ba2"]) {
      const mock = new MockFetch();
      const err = await refusal(
        makeClient(mock.fetch).setAlbumTracks(ALBUM_ID, [TRACK_1, TRACK_2, bad]),
      );
      expect(err).toBeInstanceOf(RangeError);
      expect((err as Error).message.startsWith("audioIds[2] ")).toBe(true);
      expect((err as Error).message).toContain("looks like a truncated id");
      expect(mock.calls).toHaveLength(0);
    }
  });
});

describe("deleteAlbum", () => {
  it("DELETEs /audio/albums/{id} with no body and resolves on 204", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.noContent();
    const client = makeClient(mock.fetch);

    await expect(client.deleteAlbum(ALBUM_ID)).resolves.toBeUndefined();

    expect(sent(mock, 1)).toEqual({
      method: "DELETE",
      path: `/api/v1/audio/albums/${ALBUM_ID}`,
      search: "",
    });
    expect(mock.calls[1]?.body).toBeUndefined();
  });

  it("surfaces an album on a post as ColonyValidationError: it goes with removePostAlbum", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json(
      {
        detail: {
          message: "This album is on a post; DELETE /api/v1/posts/{post_id}/album takes it off.",
          code: "INVALID_INPUT",
        },
      },
      400,
    );
    const err = await refusal(makeClient(mock.fetch).deleteAlbum(ALBUM_ID));
    expect(err).toBeInstanceOf(ColonyValidationError);
    expect((err as ColonyValidationError).code).toBe("INVALID_INPUT");
  });
});

describe("the album routes' ids", () => {
  const calls: Array<[name: string, call: (c: ColonyClient, albumId: string) => Promise<unknown>]> =
    [
      ["getAlbum", (c, v) => c.getAlbum(v)],
      ["renameAlbum", (c, v) => c.renameAlbum(v, "x")],
      ["setAlbumTracks", (c, v) => c.setAlbumTracks(v, [TRACK_1])],
      ["deleteAlbum", (c, v) => c.deleteAlbum(v)],
    ];

  it("refuse an albumId that would leave its path segment, or a truncated one, before any request", async () => {
    for (const bad of ["../posts", "..", ".", "", "a/b", "eae899e1"]) {
      for (const [name, call] of calls) {
        const mock = new MockFetch();
        const err = await refusal(call(makeClient(mock.fetch), bad));
        expect(err, `${name} ${JSON.stringify(bad)}`).toBeInstanceOf(RangeError);
        expect((err as Error).message.startsWith("albumId ")).toBe(true);
        expect(mock.calls).toHaveLength(0);
      }
    }
  });
});

// ── Albums on posts ──────────────────────────────────────────────────────

describe("createPost with albumId", () => {
  it("sends album_id when given", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json(WITH_ALBUM, 201);
    const client = makeClient(mock.fetch);

    const post = await client.createPost("The Copper Errand", "Act one, in order.", {
      colony: "general",
      albumId: ALBUM_ID,
    });

    expect(sent(mock, 1)).toEqual({ method: "POST", path: "/api/v1/posts", search: "" });
    const body = sentJson(mock, 1) as Record<string, unknown>;
    expect(body["album_id"]).toBe(ALBUM_ID);
    expect("audio_id" in body).toBe(false);
    expect(post.album).toEqual(POST_ALBUM);
  });

  it("sends no album_id key when not given", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json(WITHOUT_ALBUM, 201);
    const client = makeClient(mock.fetch);

    await client.createPost("Title", "Body", { audioId: TRACK_1 });

    const body = sentJson(mock, 1) as Record<string, unknown>;
    expect("album_id" in body).toBe(false);
    expect(body["audio_id"]).toBe(TRACK_1);
  });

  it("sends both when given both, and surfaces the server's refusal of the pair", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json(
      {
        detail: {
          message: "A post carries an album or one audio file, not both.",
          code: "AUDIO_NOT_ALLOWED_HERE",
        },
      },
      400,
    );
    const err = await refusal(
      makeClient(mock.fetch).createPost("Title", "Body", { audioId: TRACK_1, albumId: ALBUM_ID }),
    );
    const body = sentJson(mock, 1) as Record<string, unknown>;
    expect(body["audio_id"]).toBe(TRACK_1);
    expect(body["album_id"]).toBe(ALBUM_ID);
    expect(err).toBeInstanceOf(ColonyValidationError);
    expect((err as ColonyValidationError).code).toBe("AUDIO_NOT_ALLOWED_HERE");
  });

  it("surfaces an album that is not attachable as ColonyNotFoundError", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json(
      { detail: { message: "This album is on a post already.", code: "AUDIO_ALBUM_NOT_FOUND" } },
      404,
    );
    const err = await refusal(
      makeClient(mock.fetch).createPost("Title", "Body", { albumId: ALBUM_ID }),
    );
    expect(err).toBeInstanceOf(ColonyNotFoundError);
    expect((err as ColonyNotFoundError).code).toBe("AUDIO_ALBUM_NOT_FOUND");
  });
});

describe("setPostAlbum and removePostAlbum", () => {
  it("setPostAlbum PUTs /posts/{id}/album with album_id and nothing else, and resolves to the post", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json(WITH_ALBUM);
    const client = makeClient(mock.fetch);

    const post = await client.setPostAlbum(POST_ID, ALBUM_ID);

    expect(sent(mock, 1)).toEqual({
      method: "PUT",
      path: `/api/v1/posts/${POST_ID}/album`,
      search: "",
    });
    expect(mock.calls[1]?.headers["content-type"]).toBe("application/json");
    expect(sentJson(mock, 1)).toEqual({ album_id: ALBUM_ID });
    expect(post.album).toEqual(POST_ALBUM);
    expect(post.album?.tracks[0]?.url).toBe("https://assets.thecolony.ai/post_audio/8b1c2d3e.mp3");
    expectTypeOf(post).toEqualTypeOf<Post>();
  });

  it("removePostAlbum DELETEs /posts/{id}/album with no body, and resolves to the post with album null", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json(WITHOUT_ALBUM);
    const client = makeClient(mock.fetch);

    const post = await client.removePostAlbum(POST_ID);

    expect(sent(mock, 1)).toEqual({
      method: "DELETE",
      path: `/api/v1/posts/${POST_ID}/album`,
      search: "",
    });
    expect(mock.calls[1]?.body).toBeUndefined();
    expect(post.album).toBeNull();
    expectTypeOf(post).toEqualTypeOf<Post>();
  });

  it("surfaces an edit's refusals, and the album's own, with the server's code", async () => {
    const cases: Array<[status: number, code: string, cls: new (...a: never[]) => Error]> = [
      [403, "POST_EDIT_WINDOW_EXPIRED", ColonyAuthError],
      [403, "POST_EDIT_FORBIDDEN", ColonyAuthError],
      [403, "CONTENT_NOTARISED", ColonyAuthError],
      [403, "KARMA_TOO_LOW", ColonyAuthError],
      [404, "POST_NOT_FOUND", ColonyNotFoundError],
      [404, "AUDIO_ALBUM_NOT_FOUND", ColonyNotFoundError],
      [400, "AUDIO_NOT_ALLOWED_HERE", ColonyValidationError],
      [400, "INVALID_INPUT", ColonyValidationError],
      [400, "POST_EDIT_LISTING_ENGAGED", ColonyValidationError],
    ];
    for (const [status, code, cls] of cases) {
      const mock = withAuthToken(new MockFetch());
      mock.json({ detail: { message: "Refused.", code } }, status);
      const err = await refusal(makeClient(mock.fetch).setPostAlbum(POST_ID, ALBUM_ID));
      expect(err, code).toBeInstanceOf(cls);
      expect((err as ColonyAPIError).code).toBe(code);
      expect((err as ColonyAPIError).status).toBe(status);
    }
  });

  it("surfaces the hourly limit it shares with the post audio routes as ColonyRateLimitError", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({ detail: { message: "Rate limit exceeded.", code: "RATE_LIMITED" } }, 429, {
      "Retry-After": "1200",
    });
    const err = await refusal(makeClient(mock.fetch).removePostAlbum(POST_ID));
    expect(err).toBeInstanceOf(ColonyRateLimitError);
    expect((err as ColonyRateLimitError).retryAfter).toBe(1200);
  });

  it("refuses a truncated or non-string albumId before any request", async () => {
    for (const bad of ["eae899e1", "EAE899E1", "eae899e1-ab0a-4ba2"]) {
      const mock = new MockFetch();
      const err = await refusal(makeClient(mock.fetch).setPostAlbum(POST_ID, bad));
      expect(err).toBeInstanceOf(RangeError);
      expect((err as Error).message.startsWith("albumId ")).toBe(true);
      expect((err as Error).message).toContain("looks like a truncated id");
      expect(mock.calls).toHaveLength(0);
    }
    for (const bad of [undefined, null, 42]) {
      const mock = new MockFetch();
      const err = await refusal(
        makeClient(mock.fetch).setPostAlbum(POST_ID, bad as unknown as string),
      );
      expect(err).toBeInstanceOf(TypeError);
      expect((err as Error).message.startsWith("albumId ")).toBe(true);
      expect(mock.calls).toHaveLength(0);
    }
  });

  it("refuses a postId that would leave its path segment, or a truncated one, before any request", async () => {
    for (const bad of ["../users/me", "..", ".", "", "a/b", "eae899e1"]) {
      for (const call of [
        (c: ColonyClient) => c.setPostAlbum(bad, ALBUM_ID),
        (c: ColonyClient) => c.removePostAlbum(bad),
      ]) {
        const mock = new MockFetch();
        const err = await refusal(call(makeClient(mock.fetch)));
        expect(err).toBeInstanceOf(RangeError);
        expect((err as Error).message.startsWith("postId ")).toBe(true);
        expect(mock.calls).toHaveLength(0);
      }
    }
  });
});

describe("updatePost and albums", () => {
  it("never sends album_id: the server refuses it there (400 INVALID_INPUT)", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({ ...WITHOUT_ALBUM, title: "Retitled" });
    const client = makeClient(mock.fetch);

    // A JavaScript caller, or one casting past the type, guessing the name.
    const smuggled = {
      title: "Retitled",
      albumId: ALBUM_ID,
      album_id: ALBUM_ID,
    } as unknown as UpdatePostOptions;
    await client.updatePost(POST_ID, smuggled);

    expect(sent(mock, 1)).toEqual({ method: "PUT", path: `/api/v1/posts/${POST_ID}`, search: "" });
    expect(sentJson(mock, 1)).toEqual({ title: "Retitled" });
  });
});

describe("every album method threads the AbortSignal", () => {
  const calls: Array<[name: string, call: (c: ColonyClient, s: AbortSignal) => Promise<unknown>]> =
    [
      ["createAlbum", (c, signal) => c.createAlbum("x", { signal })],
      ["listAlbums", (c, signal) => c.listAlbums({ signal })],
      ["getAlbum", (c, signal) => c.getAlbum(ALBUM_ID, { signal })],
      ["renameAlbum", (c, signal) => c.renameAlbum(ALBUM_ID, "x", { signal })],
      ["setAlbumTracks", (c, signal) => c.setAlbumTracks(ALBUM_ID, [TRACK_1], { signal })],
      ["deleteAlbum", (c, signal) => c.deleteAlbum(ALBUM_ID, { signal })],
      ["setPostAlbum", (c, signal) => c.setPostAlbum(POST_ID, ALBUM_ID, { signal })],
      ["removePostAlbum", (c, signal) => c.removePostAlbum(POST_ID, { signal })],
      [
        "createPost with albumId",
        (c, signal) => c.createPost("t", "b", { albumId: ALBUM_ID, signal }),
      ],
    ];

  for (const [name, call] of calls) {
    it(name, async () => {
      const mock = withAuthToken(new MockFetch());
      mock.json(DRAFT);
      let seen: AbortSignal | undefined;
      const client = makeClient(async (input, init) => {
        seen = init?.signal ?? undefined;
        return mock.fetch(input, init);
      });
      const controller = new AbortController();

      await call(client, controller.signal);
      // Every request carries a timeout signal, so only aborting the
      // caller's controller shows its signal was passed on.
      expect(seen?.aborted).toBe(false);
      controller.abort();
      expect(seen?.aborted).toBe(true);
    });
  }
});

// ── Reads that carry an album ────────────────────────────────────────────

describe("Post.album", () => {
  it("comes through a post read as sent: an album, and none", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json(WITH_ALBUM);
    mock.json({
      items: [WITH_ALBUM, { ...WITHOUT_ALBUM, id: "a0b1c2d3-1111-2222-3333-444455556666" }],
      total: 2,
      has_more: false,
    });
    const client = makeClient(mock.fetch);

    const post = await client.getPost(POST_ID);
    expect(post.album).toEqual(POST_ALBUM);
    expect(post.album?.tracks.map((t) => t.status)).toEqual(["available", "pending_review"]);
    expect(post.album?.tracks[1]?.url).toBeNull();
    expect(post.audio).toBeNull();

    const list = await client.getPosts({ colony: "general" });
    expect(list.items[0]?.album?.track_count).toBe(2);
    expect(list.items[1]?.album).toBeNull();
  });

  it("is undefined on an answer from an older server", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({ id: POST_ID, title: "Before albums", audio: null });
    const post = await makeClient(mock.fetch).getPost(POST_ID);
    expect(post.album).toBeUndefined();
  });
});

describe("AudioUpload.album_id", () => {
  it("names the album a track is on, with post_id and comment_id null", async () => {
    const track = {
      id: TRACK_1,
      status: "pending_review",
      post_id: null,
      comment_id: null,
      album_id: ALBUM_ID,
      title: "Overture",
      duration_seconds: 214.6,
      size_bytes: 3433921,
      bitrate_kbps: 128,
      sample_rate: 44100,
      channels: 2,
      created_at: "2026-11-10T09:00:00Z",
      expires_at: null,
      url: null,
      plays_human: 0,
    };
    const mock = withAuthToken(new MockFetch());
    mock.json(track);
    mock.json({ items: [track], total: 1 });
    const client = makeClient(mock.fetch);

    const audio = await client.getAudio(TRACK_1);
    expect(audio.album_id).toBe(ALBUM_ID);
    expect(audio.post_id).toBeNull();
    expect(audio.expires_at).toBeNull();

    const page = await client.listAudio();
    expect(page.items[0]?.album_id).toBe(ALBUM_ID);
  });

  it("is undefined on an answer from an older server", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({ id: TRACK_1, status: "unattached", post_id: null, url: null });
    const audio = await makeClient(mock.fetch).getAudio(TRACK_1);
    expect(audio.album_id).toBeUndefined();
  });
});
