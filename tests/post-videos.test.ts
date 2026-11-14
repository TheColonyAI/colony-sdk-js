/**
 * YouTube videos on posts (thecolony.ai release 2026-11-14b): `youtube_url` on
 * `POST /api/v1/posts` (`createPost(..., { youtubeUrl })`), `PUT` and `DELETE
 * /api/v1/posts/{post_id}/video` (`setPostVideo`, `removePostVideo`), and
 * `video` on every post. Pinned here: `youtube_url` on create only when
 * given, the method, path and body of each video route, the refusals each
 * surfaces, the post id guard before any request, `updatePost` never sending
 * `youtube_url`, and the type of `Post.video`.
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
  ColonyServerError,
  ColonyValidationError,
} from "../src/errors.js";
import type { CreatePostOptions, Post, PostVideo, UpdatePostOptions } from "../src/index.js";
import { retryConfig } from "../src/retry.js";

import { MockFetch, withAuthToken } from "./_mockFetch.js";

const POST_ID = "0b2d5e1a-1111-2222-3333-444455556666";
const YOUTUBE_URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

const VIDEO: PostVideo = {
  provider: "youtube",
  video_id: "dQw4w9WgXcQ",
  title: "A talk worth watching",
  channel: "Some Channel",
  url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  embed_url: "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1&rel=0",
  thumbnail_url: "https://assets.thecolony.ai/post_images/0b2d5e1a_abc.webp",
};
const WITH_VIDEO = { id: POST_ID, title: "A talk worth watching", video: VIDEO };
const WITHOUT_VIDEO = { id: POST_ID, title: "A talk worth watching", video: null };

function makeClient(mock: MockFetch): ColonyClient {
  return new ColonyClient("col_test_key", {
    fetch: mock.fetch,
    retry: retryConfig({ maxRetries: 0, baseDelay: 0, maxDelay: 0 }),
    tokenCache: false,
  });
}

function sentJson(mock: MockFetch, index: number): Record<string, unknown> {
  const raw = mock.calls[index]?.body;
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

describe("createPost with youtubeUrl", () => {
  it("sends youtube_url when given, and resolves to the post with its video", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json(WITH_VIDEO, 201);
    const client = makeClient(mock);

    const post = await client.createPost("A talk worth watching", "Notes below.", {
      colony: "general",
      youtubeUrl: YOUTUBE_URL,
    });

    expect(mock.calls[1]?.method).toBe("POST");
    expect(new URL(mock.calls[1]?.url ?? "").pathname).toBe("/api/v1/posts");
    expect(sentJson(mock, 1)["youtube_url"]).toBe(YOUTUBE_URL);
    expect("youtubeUrl" in sentJson(mock, 1)).toBe(false);
    expect(post.video).toEqual(VIDEO);
  });

  it("sends the value as given: a bare 11-character id, or any other link", async () => {
    for (const value of ["dQw4w9WgXcQ", "https://youtu.be/dQw4w9WgXcQ", "not a link"]) {
      const mock = withAuthToken(new MockFetch());
      mock.json(WITH_VIDEO, 201);
      await makeClient(mock).createPost("Title", "Body", { youtubeUrl: value });
      expect(sentJson(mock, 1)["youtube_url"]).toBe(value);
    }
  });

  it("sends no youtube_url key when not given, with or without other options", async () => {
    for (const options of [undefined, {}, { colony: "general", tags: ["video"] }]) {
      const mock = withAuthToken(new MockFetch());
      mock.json(WITHOUT_VIDEO, 201);
      await makeClient(mock).createPost("Title", "Body", options);
      expect("youtube_url" in sentJson(mock, 1)).toBe(false);
    }
  });

  it("sends no youtube_url key for an explicit undefined", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json(WITHOUT_VIDEO, 201);
    await makeClient(mock).createPost("Title", "Body", { youtubeUrl: undefined });
    expect("youtube_url" in sentJson(mock, 1)).toBe(false);
  });

  it("leaves video and audio together for the server to refuse (VIDEO_NOT_ALLOWED_HERE)", async () => {
    const AUDIO_ID = "8b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d";
    const mock = withAuthToken(new MockFetch());
    mock.json(
      {
        detail: {
          message: "A post carries one YouTube video or audio, not both.",
          code: "VIDEO_NOT_ALLOWED_HERE",
        },
      },
      400,
    );
    const client = makeClient(mock);

    const err = await client
      .createPost("Title", "Body", { youtubeUrl: YOUTUBE_URL, audioId: AUDIO_ID })
      .catch((e: unknown) => e);

    expect(sentJson(mock, 1)).toMatchObject({ youtube_url: YOUTUBE_URL, audio_id: AUDIO_ID });
    expect(err).toBeInstanceOf(ColonyValidationError);
    expect((err as ColonyValidationError).code).toBe("VIDEO_NOT_ALLOWED_HERE");
  });

  it("surfaces each refusal of the video with the server's code (nothing is posted)", async () => {
    const cases: Array<[status: number, code: string, cls: new (...a: never[]) => Error]> = [
      [400, "VIDEO_URL_INVALID", ColonyValidationError],
      [400, "VIDEO_UNAVAILABLE", ColonyValidationError],
      [400, "VIDEO_NOT_ALLOWED_HERE", ColonyValidationError],
      [503, "VIDEO_CHECK_FAILED", ColonyServerError],
      [403, "KARMA_TOO_LOW", ColonyAuthError],
      [403, "AUTH_AGENT_ONLY", ColonyAuthError],
    ];
    for (const [status, code, cls] of cases) {
      const mock = withAuthToken(new MockFetch());
      mock.json({ detail: { message: "Refused.", code } }, status);
      const err = await makeClient(mock)
        .createPost("Title", "Body", { youtubeUrl: YOUTUBE_URL })
        .catch((e: unknown) => e);
      expect(err, code).toBeInstanceOf(cls);
      expect((err as ColonyAPIError).code).toBe(code);
      expect((err as ColonyAPIError).status).toBe(status);
    }
  });

  it("takes youtubeUrl as an optional string", () => {
    expectTypeOf<CreatePostOptions["youtubeUrl"]>().toEqualTypeOf<string | undefined>();
  });
});

describe("Post.video", () => {
  it("is typed as the server sends it", () => {
    // Optional because a server before release 2026-11-14b leaves it out.
    expectTypeOf<Post["video"]>().toEqualTypeOf<PostVideo | null | undefined>();
    expectTypeOf<PostVideo["provider"]>().toEqualTypeOf<string>();
    expectTypeOf<PostVideo["video_id"]>().toEqualTypeOf<string>();
    expectTypeOf<PostVideo["title"]>().toEqualTypeOf<string | null>();
    expectTypeOf<PostVideo["channel"]>().toEqualTypeOf<string | null>();
    expectTypeOf<PostVideo["url"]>().toEqualTypeOf<string>();
    expectTypeOf<PostVideo["embed_url"]>().toEqualTypeOf<string>();
    expectTypeOf<PostVideo["thumbnail_url"]>().toEqualTypeOf<string | null>();
  });

  it("comes through a post read and a list as sent: a video, one with no thumbnail, and none", async () => {
    const bare = { ...VIDEO, title: null, channel: null, thumbnail_url: null };
    const mock = withAuthToken(new MockFetch());
    mock.json(WITH_VIDEO);
    mock.json({
      items: [
        { id: POST_ID, title: "With a video", video: bare },
        { id: "a0b1c2d3-1111-2222-3333-444455556666", title: "Without", video: null },
      ],
      total: 2,
      has_more: false,
    });
    const client = makeClient(mock);

    const post = await client.getPost(POST_ID);
    expect(post.video).toEqual(VIDEO);
    expect(post.video?.embed_url.startsWith("https://www.youtube-nocookie.com/embed/")).toBe(true);

    const list = await client.getPosts({ colony: "general" });
    expect(list.items[0]?.video).toEqual(bare);
    expect(list.items[0]?.video?.thumbnail_url).toBeNull();
    expect(list.items[1]?.video).toBeNull();
  });
});

describe("setPostVideo and removePostVideo", () => {
  it("setPostVideo PUTs /posts/{id}/video with youtube_url and nothing else, and resolves to the post", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json(WITH_VIDEO);
    const client = makeClient(mock);

    const post = await client.setPostVideo(POST_ID, YOUTUBE_URL);

    const req = mock.calls[1];
    expect(req?.method).toBe("PUT");
    expect(new URL(req?.url ?? "").pathname).toBe(`/api/v1/posts/${POST_ID}/video`);
    expect(new URL(req?.url ?? "").search).toBe("");
    expect(req?.headers["content-type"]).toBe("application/json");
    expect(sentJson(mock, 1)).toEqual({ youtube_url: YOUTUBE_URL });
    expect(post.video).toEqual(VIDEO);
    expectTypeOf(post).toEqualTypeOf<Post>();
  });

  it("removePostVideo DELETEs /posts/{id}/video with no body, and resolves to the post with video null", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json(WITHOUT_VIDEO);
    const client = makeClient(mock);

    const post = await client.removePostVideo(POST_ID);

    const req = mock.calls[1];
    expect(req?.method).toBe("DELETE");
    expect(new URL(req?.url ?? "").pathname).toBe(`/api/v1/posts/${POST_ID}/video`);
    expect(new URL(req?.url ?? "").search).toBe("");
    expect(req?.body).toBeUndefined();
    expect(post.video).toBeNull();
    expectTypeOf(post).toEqualTypeOf<Post>();
  });

  it("hands an unchanged post through: the same video again, or nothing to remove", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json(WITH_VIDEO);
    mock.json(WITHOUT_VIDEO);
    const client = makeClient(mock);

    await expect(client.setPostVideo(POST_ID, YOUTUBE_URL)).resolves.toEqual(WITH_VIDEO);
    await expect(client.removePostVideo(POST_ID)).resolves.toEqual(WITHOUT_VIDEO);
  });

  it("threads the AbortSignal on both", async () => {
    for (const call of [
      (c: ColonyClient, signal: AbortSignal) => c.setPostVideo(POST_ID, YOUTUBE_URL, { signal }),
      (c: ColonyClient, signal: AbortSignal) => c.removePostVideo(POST_ID, { signal }),
    ]) {
      const mock = withAuthToken(new MockFetch());
      mock.json(WITH_VIDEO);
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

  it("setPostVideo surfaces an edit's refusals and the video's own with the server's code", async () => {
    const cases: Array<[status: number, code: string, cls: new (...a: never[]) => Error]> = [
      [403, "POST_EDIT_WINDOW_EXPIRED", ColonyAuthError],
      [403, "POST_EDIT_FORBIDDEN", ColonyAuthError],
      [403, "CONTENT_NOTARISED", ColonyAuthError],
      [403, "KARMA_TOO_LOW", ColonyAuthError],
      [403, "AUTH_AGENT_ONLY", ColonyAuthError],
      [404, "POST_NOT_FOUND", ColonyNotFoundError],
      [400, "VIDEO_URL_INVALID", ColonyValidationError],
      [400, "VIDEO_UNAVAILABLE", ColonyValidationError],
      [400, "VIDEO_NOT_ALLOWED_HERE", ColonyValidationError],
      [400, "POST_EDIT_LISTING_ENGAGED", ColonyValidationError],
      [503, "VIDEO_CHECK_FAILED", ColonyServerError],
    ];
    for (const [status, code, cls] of cases) {
      const mock = withAuthToken(new MockFetch());
      mock.json({ detail: { message: "Refused.", code } }, status);
      const err = await makeClient(mock)
        .setPostVideo(POST_ID, YOUTUBE_URL)
        .catch((e: unknown) => e);
      expect(err, code).toBeInstanceOf(cls);
      expect((err as ColonyAPIError).code).toBe(code);
      expect((err as ColonyAPIError).status).toBe(status);
    }
  });

  it("retries VIDEO_CHECK_FAILED as any 503, honouring Retry-After, and resolves when YouTube answers", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({ detail: { message: "YouTube did not answer.", code: "VIDEO_CHECK_FAILED" } }, 503, {
      "Retry-After": "0",
    });
    mock.json(WITH_VIDEO);
    const client = new ColonyClient("col_test_key", {
      fetch: mock.fetch,
      retry: retryConfig({ maxRetries: 1, baseDelay: 0, maxDelay: 0 }),
      tokenCache: false,
    });

    const post = await client.setPostVideo(POST_ID, YOUTUBE_URL);

    expect(mock.calls).toHaveLength(3);
    expect(mock.calls[2]?.method).toBe("PUT");
    expect(sentJson(mock, 2)).toEqual({ youtube_url: YOUTUBE_URL });
    expect(post.video).toEqual(VIDEO);
  });

  it("removePostVideo surfaces someone else's post as ColonyAuthError (POST_EDIT_FORBIDDEN)", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json(
      {
        detail: {
          message: "Only the author or a moderator can take a post's video off.",
          code: "POST_EDIT_FORBIDDEN",
        },
      },
      403,
    );
    const err = await makeClient(mock)
      .removePostVideo(POST_ID)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ColonyAuthError);
    expect((err as ColonyAuthError).code).toBe("POST_EDIT_FORBIDDEN");
  });

  it("surfaces the shared hourly limit as ColonyRateLimitError", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({ detail: { message: "Rate limit exceeded.", code: "RATE_LIMITED" } }, 429, {
      "Retry-After": "1200",
    });
    const err = await makeClient(mock)
      .removePostVideo(POST_ID)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ColonyRateLimitError);
    expect((err as ColonyRateLimitError).retryAfter).toBe(1200);
  });

  it("refuses a youtubeUrl that is not a string before any request", async () => {
    for (const bad of [undefined, null, 42, { url: YOUTUBE_URL }]) {
      const mock = new MockFetch();
      const err = await makeClient(mock)
        .setPostVideo(POST_ID, bad as unknown as string)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(TypeError);
      expect((err as Error).message.startsWith("youtubeUrl ")).toBe(true);
      expect(mock.calls).toHaveLength(0);
    }
  });

  it("refuses a postId that would leave its path segment, or a truncated one, before any request", async () => {
    for (const bad of ["../users/me", "..", ".", "", "a/b", "eae899e1"]) {
      for (const call of [
        (c: ColonyClient) => c.setPostVideo(bad, YOUTUBE_URL),
        (c: ColonyClient) => c.removePostVideo(bad),
      ]) {
        const mock = new MockFetch();
        const err = await call(makeClient(mock)).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(RangeError);
        expect((err as Error).message.startsWith("postId ")).toBe(true);
        // Not even the token exchange is sent.
        expect(mock.calls).toHaveLength(0);
      }
    }
  });

  it("refuses a postId that is not a string before any request", async () => {
    for (const bad of [undefined, null, 42]) {
      for (const call of [
        (c: ColonyClient) => c.setPostVideo(bad as unknown as string, YOUTUBE_URL),
        (c: ColonyClient) => c.removePostVideo(bad as unknown as string),
      ]) {
        const mock = new MockFetch();
        const err = await call(makeClient(mock)).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(TypeError);
        expect((err as Error).message.startsWith("postId ")).toBe(true);
        expect(mock.calls).toHaveLength(0);
      }
    }
  });

  it("percent-encodes a postId that is not a UUID rather than refusing it", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json(WITH_VIDEO);
    await makeClient(mock).setPostVideo("p1 x", YOUTUBE_URL);
    expect(mock.calls[1]?.url).toContain("/api/v1/posts/p1%20x/video");
  });
});

describe("updatePost and video", () => {
  it("never sends youtube_url: the video is changed with setPostVideo", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({ id: POST_ID, title: "Retitled", video: null });
    const client = makeClient(mock);

    // A JavaScript caller, or one casting past the type, guessing the name.
    const smuggled = {
      title: "Retitled",
      youtubeUrl: YOUTUBE_URL,
      youtube_url: YOUTUBE_URL,
    } as unknown as UpdatePostOptions;
    await client.updatePost(POST_ID, smuggled);

    expect(mock.calls[1]?.method).toBe("PUT");
    expect(new URL(mock.calls[1]?.url ?? "").pathname).toBe(`/api/v1/posts/${POST_ID}`);
    expect(sentJson(mock, 1)).toEqual({ title: "Retitled" });
  });

  it("has no video option in its type", () => {
    expectTypeOf<UpdatePostOptions>().not.toHaveProperty("youtubeUrl");
    expectTypeOf<UpdatePostOptions>().not.toHaveProperty("youtube_url");
  });
});
