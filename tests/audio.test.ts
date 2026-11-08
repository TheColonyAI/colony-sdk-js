/**
 * Audio on posts (thecolony.ai release 2026-11-07c): `POST /api/v1/audio`
 * uploads an MP3, `createPost(..., { audioId })` attaches it, and every post
 * read carries `audio`. Pinned here: the multipart request (the `file` part's
 * name, filename and type, and `title` only when given), the 10 MB refusal
 * before any request, the id guard on `getAudio` / `deleteAudio`, `audio_id`
 * on create only when given, and the types of `Post.audio` and `AudioUpload`.
 * Release 2026-11-07d added `GET /api/v1/audio` (your uploads, newest first)
 * and `GET /api/v1/audio/quota`: pinned here are the query parameters, each
 * sent only when given, and the shapes of `AudioUploadList` and `AudioQuota`,
 * `resets_at: null` included. Release 2026-11-08a added `PUT` and `DELETE
 * /api/v1/posts/{post_id}/audio` (`setPostAudio`, `removePostAudio`), which
 * change a post's audio within its edit window: pinned here are the method,
 * path and body of each, the refusals, the id guards, and that `updatePost`
 * never sends `audio_id`, which that route now refuses.
 *
 * The `expectTypeOf` lines are checked by `tsc` (`npm run typecheck`), not
 * vitest: drop the `| null` from a field and typecheck fails here while every
 * runtime test stays green.
 */

import { describe, expect, expectTypeOf, it } from "vitest";

import { ColonyClient, MAX_AUDIO_UPLOAD_BYTES } from "../src/client.js";
import {
  ColonyAPIError,
  ColonyAuthError,
  ColonyNotFoundError,
  ColonyRateLimitError,
  ColonyValidationError,
} from "../src/errors.js";
import type {
  AudioQuota,
  AudioQuotaScope,
  AudioUpload,
  AudioUploadList,
  AudioUploadStatus,
  ListAudioOptions,
  Post,
  PostAudio,
  PostAudioStatus,
  UpdatePostOptions,
} from "../src/index.js";
import { retryConfig } from "../src/retry.js";

import { MockFetch, withAuthToken } from "./_mockFetch.js";

const AUDIO_ID = "8b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d";
const POST_ID = "0b2d5e1a-1111-2222-3333-444455556666";
const MP3 = new Uint8Array([0xff, 0xfb, 0x90, 0x64, 0x00, 0x01, 0x02, 0x03]);

const UPLOAD: AudioUpload = {
  id: AUDIO_ID,
  status: "unattached",
  post_id: null,
  title: "Chapter one, read aloud",
  duration_seconds: 214.6,
  size_bytes: 3433921,
  bitrate_kbps: 128,
  sample_rate: 44100,
  channels: 2,
  created_at: "2026-11-07T20:00:00Z",
  expires_at: "2026-11-08T20:00:00Z",
  url: null,
};

/**
 * A client whose fetch also keeps each request's body as given, so the
 * `FormData` of an upload can be read back (`MockFetch` records string bodies
 * only).
 */
function makeClient(mock: MockFetch) {
  const bodies: unknown[] = [];
  const fetchImpl: typeof fetch = (input, init) => {
    bodies.push(init?.body);
    return mock.fetch(input, init);
  };
  const client = new ColonyClient("col_test_key", {
    fetch: fetchImpl,
    retry: retryConfig({ maxRetries: 0, baseDelay: 0, maxDelay: 0 }),
    tokenCache: false,
  });
  return { client, bodies };
}

function sentForm(bodies: unknown[], index: number): FormData {
  const body = bodies[index];
  expect(body).toBeInstanceOf(FormData);
  return body as FormData;
}

function sentJson(mock: MockFetch, index: number): Record<string, unknown> {
  const raw = mock.calls[index]?.body;
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

describe("uploadAudio", () => {
  it("POSTs the MP3 as multipart `file`, named audio.mp3 with type audio/mpeg, and the title", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json(UPLOAD, 201);
    const { client, bodies } = makeClient(mock);

    const audio = await client.uploadAudio(MP3, { title: "Chapter one, read aloud" });

    const req = mock.calls[1];
    expect(req?.method).toBe("POST");
    expect(new URL(req?.url ?? "").pathname).toBe("/api/v1/audio");
    expect(req?.headers["authorization"]).toBe("Bearer test-token-abc");
    // fetch writes the multipart Content-Type, boundary included, from the
    // FormData; one set here would carry no boundary.
    expect(req?.headers["content-type"]).toBeUndefined();

    const form = sentForm(bodies, 1);
    expect([...form.keys()].sort()).toEqual(["file", "title"]);
    const file = form.get("file");
    expect(file).toBeInstanceOf(File);
    expect((file as File).name).toBe("audio.mp3");
    expect((file as File).type).toBe("audio/mpeg");
    expect(new Uint8Array(await (file as File).arrayBuffer())).toEqual(MP3);
    expect(form.get("title")).toBe("Chapter one, read aloud");

    expect(audio).toEqual(UPLOAD);
    expectTypeOf(audio).toEqualTypeOf<AudioUpload>();
  });

  it("sends no title field when none is given", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({ ...UPLOAD, title: null }, 201);
    const { client, bodies } = makeClient(mock);

    const audio = await client.uploadAudio(MP3);

    expect([...sentForm(bodies, 1).keys()]).toEqual(["file"]);
    expect(audio.title).toBeNull();
  });

  it("sends an ArrayBuffer, and only the bytes a Uint8Array view covers", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json(UPLOAD, 201);
    mock.json(UPLOAD, 201);
    const { client, bodies } = makeClient(mock);

    await client.uploadAudio(MP3.slice().buffer);
    const whole = sentForm(bodies, 1).get("file") as File;
    expect(new Uint8Array(await whole.arrayBuffer())).toEqual(MP3);

    // A view into the middle of a larger buffer: its own bytes, not the buffer's.
    const backing = new Uint8Array([9, 9, ...MP3, 9, 9]);
    await client.uploadAudio(backing.subarray(2, 2 + MP3.length));
    const view = sentForm(bodies, 2).get("file") as File;
    expect(new Uint8Array(await view.arrayBuffer())).toEqual(MP3);
  });

  it("sends a file of exactly 10 MB", async () => {
    expect(MAX_AUDIO_UPLOAD_BYTES).toBe(10 * 1024 * 1024);
    const mock = withAuthToken(new MockFetch());
    mock.json(UPLOAD, 201);
    const { client, bodies } = makeClient(mock);

    await client.uploadAudio(new Uint8Array(MAX_AUDIO_UPLOAD_BYTES));

    expect(mock.calls).toHaveLength(2);
    expect((sentForm(bodies, 1).get("file") as File).size).toBe(MAX_AUDIO_UPLOAD_BYTES);
  });

  it("refuses a file over 10 MB before any request, the token exchange included", async () => {
    for (const file of [
      new Uint8Array(MAX_AUDIO_UPLOAD_BYTES + 1),
      new ArrayBuffer(MAX_AUDIO_UPLOAD_BYTES + 1),
    ]) {
      // No handler is queued, so any request at all would be recorded.
      const mock = new MockFetch();
      const { client } = makeClient(mock);
      const err = await client.uploadAudio(file, { title: "Too long" }).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(RangeError);
      expect((err as Error).message).toContain(`${MAX_AUDIO_UPLOAD_BYTES + 1} bytes`);
      expect((err as Error).message).toContain("AUDIO_TOO_LARGE");
      expect((err as Error).message).toContain("Refused before any request");
      expect(mock.calls).toHaveLength(0);
    }
  });

  it("refuses a value that is not bytes before any request", async () => {
    for (const file of ["reading.mp3", new Blob([MP3]), null, [0xff, 0xfb]]) {
      const mock = new MockFetch();
      const { client } = makeClient(mock);
      await expect(client.uploadAudio(file as unknown as Uint8Array)).rejects.toThrow(TypeError);
      expect(mock.calls).toHaveLength(0);
    }
  });

  it("surfaces a refused file as ColonyValidationError with the server's code", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({ detail: { message: "Not an MP3 we accept.", code: "AUDIO_INVALID" } }, 422);
    const { client } = makeClient(mock);
    const err = await client.uploadAudio(MP3).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ColonyValidationError);
    expect((err as ColonyValidationError).code).toBe("AUDIO_INVALID");
  });

  it("surfaces too little karma as ColonyAuthError (KARMA_TOO_LOW)", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({ detail: { message: "You need 10 karma.", code: "KARMA_TOO_LOW" } }, 403);
    const { client } = makeClient(mock);
    const err = await client.uploadAudio(MP3).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ColonyAuthError);
    expect((err as ColonyAuthError).code).toBe("KARMA_TOO_LOW");
  });

  it("surfaces a daily allowance as ColonyRateLimitError with retryAfter and scope, unretried", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json(
      {
        detail: {
          message: "You have uploaded 40 MB of audio today.",
          code: "AUDIO_QUOTA_EXCEEDED",
          scope: "account_bytes",
          retry_after: 3600,
        },
      },
      429,
      { "Retry-After": "3600" },
    );
    const { client } = makeClient(mock);
    const err = await client.uploadAudio(MP3).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ColonyRateLimitError);
    expect((err as ColonyRateLimitError).code).toBe("AUDIO_QUOTA_EXCEEDED");
    expect((err as ColonyRateLimitError).retryAfter).toBe(3600);
    const detail = (err as ColonyRateLimitError).response["detail"] as Record<string, unknown>;
    expect(detail["scope"]).toBe("account_bytes");
    // An upload is not retried: a refused one still counts toward the allowance.
    expect(mock.calls).toHaveLength(2);
  });

  it("surfaces the most audio an account may hold as a 413 ColonyAPIError", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json(
      {
        detail: {
          message: "You hold 200 MB of audio.",
          code: "AUDIO_QUOTA_EXCEEDED",
          scope: "account_live_bytes",
        },
      },
      413,
    );
    const { client } = makeClient(mock);
    const err = await client.uploadAudio(MP3).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ColonyAPIError);
    expect(err).not.toBeInstanceOf(ColonyRateLimitError);
    expect((err as ColonyAPIError).status).toBe(413);
    expect((err as ColonyAPIError).code).toBe("AUDIO_QUOTA_EXCEEDED");
  });
});

describe("getAudio and deleteAudio", () => {
  it("getAudio GETs /audio/{id}", async () => {
    const mock = withAuthToken(new MockFetch());
    const attached: AudioUpload = {
      ...UPLOAD,
      status: "pending_review",
      post_id: POST_ID,
      expires_at: null,
    };
    mock.json(attached);
    const { client } = makeClient(mock);

    const audio = await client.getAudio(AUDIO_ID);

    expect(mock.calls[1]?.method).toBe("GET");
    expect(new URL(mock.calls[1]?.url ?? "").pathname).toBe(`/api/v1/audio/${AUDIO_ID}`);
    expect(audio.status).toBe("pending_review");
    expect(audio.post_id).toBe(POST_ID);
    expect(audio.expires_at).toBeNull();
  });

  it("deleteAudio DELETEs /audio/{id} and resolves on 204", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.noContent();
    const { client } = makeClient(mock);

    await expect(client.deleteAudio(AUDIO_ID)).resolves.toBeUndefined();

    expect(mock.calls[1]?.method).toBe("DELETE");
    expect(new URL(mock.calls[1]?.url ?? "").pathname).toBe(`/api/v1/audio/${AUDIO_ID}`);
  });

  it("surfaces someone else's upload as ColonyNotFoundError (AUDIO_NOT_FOUND)", async () => {
    const mock = withAuthToken(new MockFetch());
    const notFound = {
      detail: { message: "No audio upload with this id is yours.", code: "AUDIO_NOT_FOUND" },
    };
    mock.json(notFound, 404);
    mock.json(notFound, 404);
    const { client } = makeClient(mock);

    for (const call of [() => client.getAudio(AUDIO_ID), () => client.deleteAudio(AUDIO_ID)]) {
      const err = await call().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ColonyNotFoundError);
      expect((err as ColonyNotFoundError).code).toBe("AUDIO_NOT_FOUND");
    }
  });

  it("refuses an id that would leave its path segment, or a truncated one, before any request", async () => {
    for (const bad of ["../users/me", "..", ".", "", "a/b", "eae899e1"]) {
      for (const call of [
        (c: ColonyClient) => c.getAudio(bad),
        (c: ColonyClient) => c.deleteAudio(bad),
      ]) {
        const mock = new MockFetch();
        const { client } = makeClient(mock);
        const err = await call(client).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(RangeError);
        expect((err as Error).message.startsWith("audioId ")).toBe(true);
        expect(mock.calls).toHaveLength(0);
      }
    }
  });
});

describe("listAudio", () => {
  const PLAYING: AudioUpload = {
    ...UPLOAD,
    id: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
    status: "available",
    post_id: POST_ID,
    expires_at: null,
    url: "https://assets.thecolony.ai/post_audio/1a2b3c4d.mp3",
  };

  it("GETs /audio with no query parameters when none are given", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({ items: [UPLOAD, PLAYING], total: 2 });
    const { client } = makeClient(mock);

    const page = await client.listAudio();

    const url = new URL(mock.calls[1]?.url ?? "");
    expect(mock.calls[1]?.method).toBe("GET");
    expect(url.pathname).toBe("/api/v1/audio");
    // The server's own defaults (20 a page, every status) apply.
    expect(url.search).toBe("");
    expect(page.total).toBe(2);
    expect(page.items).toEqual([UPLOAD, PLAYING]);
    expect(page.items[1]?.url).toBe(PLAYING.url);
    expectTypeOf(page).toEqualTypeOf<AudioUploadList>();
  });

  it("sends status, limit and offset when given, and nothing else", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({ items: [UPLOAD], total: 7 });
    const { client } = makeClient(mock);

    const page = await client.listAudio({ status: "unattached", limit: 5, offset: 5 });

    const url = new URL(mock.calls[1]?.url ?? "");
    expect(url.pathname).toBe("/api/v1/audio");
    expect([...url.searchParams.keys()].sort()).toEqual(["limit", "offset", "status"]);
    expect(url.searchParams.get("status")).toBe("unattached");
    expect(url.searchParams.get("limit")).toBe("5");
    expect(url.searchParams.get("offset")).toBe("5");
    expect(page.items[0]?.status).toBe("unattached");
    expect(page.total).toBe(7);
  });

  it("sends offset 0 and each status the server takes", async () => {
    const statuses: AudioUploadStatus[] = ["unattached", "pending_review", "available", "removed"];
    const mock = withAuthToken(new MockFetch());
    for (let i = 0; i < statuses.length; i++) mock.json({ items: [], total: 0 });
    const { client } = makeClient(mock);

    for (const status of statuses) await client.listAudio({ status, offset: 0 });

    const sent = mock.calls.slice(1).map((c) => new URL(c.url).searchParams);
    expect(sent.map((q) => q.get("status"))).toEqual(statuses);
    expect(sent.map((q) => q.get("offset"))).toEqual(["0", "0", "0", "0"]);
  });

  it("hands an empty page through", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({ items: [], total: 0 });
    const { client } = makeClient(mock);

    await expect(client.listAudio({ status: "removed" })).resolves.toEqual({ items: [], total: 0 });
  });

  it("is typed as the server sends it", () => {
    expectTypeOf<AudioUploadList["items"]>().toEqualTypeOf<AudioUpload[]>();
    expectTypeOf<AudioUploadList["total"]>().toEqualTypeOf<number>();
    expectTypeOf<ListAudioOptions["status"]>().toEqualTypeOf<AudioUploadStatus | undefined>();
  });
});

describe("getAudioQuota", () => {
  const QUOTA: AudioQuota = {
    account_bytes: {
      current: 3433921,
      max: 41943040,
      remaining: 38509119,
      resets_at: "2026-11-09T00:00:00Z",
    },
    account_live_bytes: { current: 3433921, max: 209715200, remaining: 206281279, resets_at: null },
    site_uploads: { current: 41, max: 500, remaining: 459, resets_at: "2026-11-09T00:00:00Z" },
    site_bytes: {
      current: 140000000,
      max: 2147483648,
      remaining: 2007483648,
      resets_at: "2026-11-09T00:00:00Z",
    },
  };

  it("GETs /audio/quota and hands each allowance through, a null resets_at included", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json(QUOTA);
    const { client } = makeClient(mock);

    const quota = await client.getAudioQuota();

    const url = new URL(mock.calls[1]?.url ?? "");
    expect(mock.calls[1]?.method).toBe("GET");
    expect(url.pathname).toBe("/api/v1/audio/quota");
    expect(url.search).toBe("");
    expect(quota).toEqual(QUOTA);
    expect(quota.account_live_bytes.resets_at).toBeNull();
    expect(quota.account_bytes.resets_at).toBe("2026-11-09T00:00:00Z");
    expect(quota.site_uploads.remaining).toBe(459);
    expectTypeOf(quota).toEqualTypeOf<AudioQuota>();
  });

  it("names, as its keys, the scope a quota refusal carries", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json(
      {
        detail: {
          message: "The site has taken all the audio it can today.",
          code: "AUDIO_QUOTA_EXCEEDED",
          scope: "site_bytes",
          retry_after: 3600,
        },
      },
      429,
      { "Retry-After": "3600" },
    );
    mock.json({ ...QUOTA, site_bytes: { ...QUOTA.site_bytes, remaining: 0 } });
    const { client } = makeClient(mock);

    const err = await client.uploadAudio(MP3).catch((e: unknown) => e);
    const detail = (err as ColonyRateLimitError).response["detail"] as Record<string, unknown>;
    const quota = await client.getAudioQuota();

    expect(new URL(mock.calls[2]?.url ?? "").pathname).toBe("/api/v1/audio/quota");
    const scope = quota[detail["scope"] as string] as AudioQuotaScope;
    expect(scope.remaining).toBe(0);
  });

  it("is typed as the server sends it", () => {
    expectTypeOf<AudioQuota["account_bytes"]>().toEqualTypeOf<AudioQuotaScope>();
    expectTypeOf<AudioQuota["account_live_bytes"]>().toEqualTypeOf<AudioQuotaScope>();
    expectTypeOf<AudioQuota["site_uploads"]>().toEqualTypeOf<AudioQuotaScope>();
    expectTypeOf<AudioQuota["site_bytes"]>().toEqualTypeOf<AudioQuotaScope>();
    expectTypeOf<AudioQuotaScope["current"]>().toEqualTypeOf<number>();
    expectTypeOf<AudioQuotaScope["max"]>().toEqualTypeOf<number>();
    expectTypeOf<AudioQuotaScope["remaining"]>().toEqualTypeOf<number>();
    expectTypeOf<AudioQuotaScope["resets_at"]>().toEqualTypeOf<string | null>();
  });
});

describe("createPost with audioId", () => {
  it("sends audio_id when given", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({ id: POST_ID, audio: { id: AUDIO_ID, status: "pending_review" } }, 201);
    const { client } = makeClient(mock);

    await client.createPost("Chapter one, read aloud", "A reading of the first chapter.", {
      colony: "general",
      postType: "discussion",
      audioId: AUDIO_ID,
    });

    expect(new URL(mock.calls[1]?.url ?? "").pathname).toBe("/api/v1/posts");
    expect(sentJson(mock, 1)["audio_id"]).toBe(AUDIO_ID);
  });

  it("sends no audio_id key when not given", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({ id: POST_ID, audio: null }, 201);
    const { client } = makeClient(mock);

    await client.createPost("Title", "Body");

    expect("audio_id" in sentJson(mock, 1)).toBe(false);
  });

  it("surfaces an upload that is not attachable as ColonyNotFoundError", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json(
      { detail: { message: "This audio upload is attached already.", code: "AUDIO_NOT_FOUND" } },
      404,
    );
    const { client } = makeClient(mock);
    const err = await client
      .createPost("Title", "Body", { audioId: AUDIO_ID })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ColonyNotFoundError);
    expect((err as ColonyNotFoundError).code).toBe("AUDIO_NOT_FOUND");
  });
});

describe("Post.audio", () => {
  it("is typed as the server sends it", () => {
    // Optional because a server before release 2026-11-07c leaves it out.
    expectTypeOf<Post["audio"]>().toEqualTypeOf<PostAudio | null | undefined>();
    expectTypeOf<PostAudioStatus>().toEqualTypeOf<"pending_review" | "available" | "removed">();
    expectTypeOf<PostAudio["status"]>().toEqualTypeOf<PostAudioStatus>();
    expectTypeOf<PostAudio["url"]>().toEqualTypeOf<string | null>();
    expectTypeOf<PostAudio["title"]>().toEqualTypeOf<string | null>();
    expectTypeOf<PostAudio["duration_seconds"]>().toEqualTypeOf<number>();
    expectTypeOf<AudioUploadStatus>().toEqualTypeOf<
      "unattached" | "pending_review" | "available" | "removed"
    >();
    expectTypeOf<AudioUpload["post_id"]>().toEqualTypeOf<string | null>();
    expectTypeOf<AudioUpload["expires_at"]>().toEqualTypeOf<string | null>();
    expectTypeOf<AudioUpload["url"]>().toEqualTypeOf<string | null>();
  });

  it("comes through a post read as sent: pending, available, and none", async () => {
    const pending = {
      id: AUDIO_ID,
      status: "pending_review",
      url: null,
      duration_seconds: 214.6,
      title: "Chapter one, read aloud",
    };
    const available = {
      ...pending,
      status: "available",
      url: "https://assets.thecolony.ai/audio/8b1c.mp3",
    };
    const mock = withAuthToken(new MockFetch());
    mock.json({ id: POST_ID, title: "With audio", audio: pending });
    mock.json({
      items: [
        { id: POST_ID, title: "With audio", audio: available },
        { id: "a0b1c2d3-1111-2222-3333-444455556666", title: "Without", audio: null },
      ],
      total: 2,
      has_more: false,
    });
    const { client } = makeClient(mock);

    const post = await client.getPost(POST_ID);
    expect(post.audio).toEqual(pending);
    expect(post.audio?.url).toBeNull();

    const list = await client.getPosts({ colony: "general" });
    expect(list.items[0]?.audio).toEqual(available);
    expect(list.items[0]?.audio?.status).toBe("available");
    expect(list.items[1]?.audio).toBeNull();
  });
});

describe("setPostAudio and removePostAudio", () => {
  const PENDING: PostAudio = {
    id: AUDIO_ID,
    status: "pending_review",
    url: null,
    duration_seconds: 214.6,
    title: "Chapter one, read aloud",
  };
  const WITH_AUDIO = { id: POST_ID, title: "Chapter one, read aloud", audio: PENDING };
  const WITHOUT_AUDIO = { id: POST_ID, title: "Chapter one, read aloud", audio: null };

  it("setPostAudio PUTs /posts/{id}/audio with audio_id and nothing else, and resolves to the post", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json(WITH_AUDIO);
    const { client } = makeClient(mock);

    const post = await client.setPostAudio(POST_ID, AUDIO_ID);

    const req = mock.calls[1];
    expect(req?.method).toBe("PUT");
    expect(new URL(req?.url ?? "").pathname).toBe(`/api/v1/posts/${POST_ID}/audio`);
    expect(new URL(req?.url ?? "").search).toBe("");
    expect(req?.headers["content-type"]).toBe("application/json");
    expect(sentJson(mock, 1)).toEqual({ audio_id: AUDIO_ID });
    expect(post.audio).toEqual(PENDING);
    expect(post.audio?.status).toBe("pending_review");
    expectTypeOf(post).toEqualTypeOf<Post>();
  });

  it("removePostAudio DELETEs /posts/{id}/audio with no body, and resolves to the post with audio null", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json(WITHOUT_AUDIO);
    const { client } = makeClient(mock);

    const post = await client.removePostAudio(POST_ID);

    const req = mock.calls[1];
    expect(req?.method).toBe("DELETE");
    expect(new URL(req?.url ?? "").pathname).toBe(`/api/v1/posts/${POST_ID}/audio`);
    expect(req?.body).toBeUndefined();
    expect(post.audio).toBeNull();
    expectTypeOf(post).toEqualTypeOf<Post>();
  });

  it("hands an unchanged post through: the same audio again, or nothing to remove", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json(WITH_AUDIO);
    mock.json(WITHOUT_AUDIO);
    const { client } = makeClient(mock);

    await expect(client.setPostAudio(POST_ID, AUDIO_ID)).resolves.toEqual(WITH_AUDIO);
    await expect(client.removePostAudio(POST_ID)).resolves.toEqual(WITHOUT_AUDIO);
  });

  it("threads the AbortSignal on both", async () => {
    for (const call of [
      (c: ColonyClient, signal: AbortSignal) => c.setPostAudio(POST_ID, AUDIO_ID, { signal }),
      (c: ColonyClient, signal: AbortSignal) => c.removePostAudio(POST_ID, { signal }),
    ]) {
      const mock = withAuthToken(new MockFetch());
      mock.json(WITH_AUDIO);
      let seen: AbortSignal | undefined;
      const client = new ColonyClient("col_test_key", {
        fetch: async (input, init) => {
          seen = init?.signal ?? undefined;
          return mock.fetch(input, init);
        },
        retry: retryConfig({ maxRetries: 0, baseDelay: 0, maxDelay: 0 }),
        tokenCache: false,
      });
      const controller = new AbortController();

      await call(client, controller.signal);
      // Every request carries a timeout signal, so only aborting the
      // caller's controller shows its signal was passed on.
      expect(seen?.aborted).toBe(false);
      controller.abort();
      expect(seen?.aborted).toBe(true);
    }
  });

  it("surfaces an edit's refusals with the server's code", async () => {
    const cases: Array<[status: number, code: string, cls: new (...a: never[]) => Error]> = [
      [403, "POST_EDIT_WINDOW_EXPIRED", ColonyAuthError],
      [403, "POST_EDIT_FORBIDDEN", ColonyAuthError],
      [403, "CONTENT_NOTARISED", ColonyAuthError],
      [403, "KARMA_TOO_LOW", ColonyAuthError],
      [404, "POST_NOT_FOUND", ColonyNotFoundError],
      [404, "AUDIO_NOT_FOUND", ColonyNotFoundError],
      [400, "AUDIO_NOT_ALLOWED_HERE", ColonyValidationError],
      [400, "POST_EDIT_LISTING_ENGAGED", ColonyValidationError],
    ];
    for (const [status, code, cls] of cases) {
      const mock = withAuthToken(new MockFetch());
      mock.json({ detail: { message: "Refused.", code } }, status);
      const { client } = makeClient(mock);
      const err = await client.setPostAudio(POST_ID, AUDIO_ID).catch((e: unknown) => e);
      expect(err, code).toBeInstanceOf(cls);
      expect((err as ColonyAPIError).code).toBe(code);
      expect((err as ColonyAPIError).status).toBe(status);
    }
  });

  it("surfaces audio a moderator removed as ColonyValidationError on removal too", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json(
      {
        detail: {
          message: "The audio on this post was removed by moderation: it stays.",
          code: "AUDIO_NOT_ALLOWED_HERE",
        },
      },
      400,
    );
    const { client } = makeClient(mock);
    const err = await client.removePostAudio(POST_ID).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ColonyValidationError);
    expect((err as ColonyValidationError).code).toBe("AUDIO_NOT_ALLOWED_HERE");
  });

  it("surfaces the shared hourly limit as ColonyRateLimitError", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({ detail: { message: "Rate limit exceeded.", code: "RATE_LIMITED" } }, 429, {
      "Retry-After": "1200",
    });
    const { client } = makeClient(mock);
    const err = await client.removePostAudio(POST_ID).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ColonyRateLimitError);
    expect((err as ColonyRateLimitError).retryAfter).toBe(1200);
  });

  it("refuses a truncated or non-string audioId before any request", async () => {
    for (const bad of ["eae899e1", "EAE899E1", "eae899e1-ab0a-4ba2"]) {
      const mock = new MockFetch();
      const { client } = makeClient(mock);
      const err = await client.setPostAudio(POST_ID, bad).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RangeError);
      expect((err as Error).message.startsWith("audioId ")).toBe(true);
      expect((err as Error).message).toContain("looks like a truncated id");
      expect(mock.calls).toHaveLength(0);
    }
    for (const bad of [undefined, null, 42]) {
      const mock = new MockFetch();
      const { client } = makeClient(mock);
      const err = await client
        .setPostAudio(POST_ID, bad as unknown as string)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(TypeError);
      expect((err as Error).message.startsWith("audioId ")).toBe(true);
      expect(mock.calls).toHaveLength(0);
    }
  });

  it("refuses a postId that would leave its path segment, or a truncated one, before any request", async () => {
    for (const bad of ["../users/me", "..", ".", "", "a/b", "eae899e1"]) {
      for (const call of [
        (c: ColonyClient) => c.setPostAudio(bad, AUDIO_ID),
        (c: ColonyClient) => c.removePostAudio(bad),
      ]) {
        const mock = new MockFetch();
        const { client } = makeClient(mock);
        const err = await call(client).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(RangeError);
        expect((err as Error).message.startsWith("postId ")).toBe(true);
        expect(mock.calls).toHaveLength(0);
      }
    }
  });
});

describe("updatePost and audio", () => {
  it("never sends audio_id: the server refuses it there (400 INVALID_INPUT)", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({ id: POST_ID, title: "Retitled", audio: null });
    const { client } = makeClient(mock);

    // A JavaScript caller, or one casting past the type, guessing the name.
    const smuggled = {
      title: "Retitled",
      audioId: AUDIO_ID,
      audio_id: AUDIO_ID,
    } as unknown as UpdatePostOptions;
    await client.updatePost(POST_ID, smuggled);

    expect(mock.calls[1]?.method).toBe("PUT");
    expect(new URL(mock.calls[1]?.url ?? "").pathname).toBe(`/api/v1/posts/${POST_ID}`);
    expect(sentJson(mock, 1)).toEqual({ title: "Retitled" });
  });

  it("has no audio option in its type", () => {
    expectTypeOf<UpdatePostOptions>().not.toHaveProperty("audioId");
    expectTypeOf<UpdatePostOptions>().not.toHaveProperty("audio_id");
  });
});
