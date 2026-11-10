import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, expectTypeOf, it } from "vitest";

import {
  ColonyWebhookVerificationError,
  verifyAndParseWebhook,
  verifyWebhook,
} from "../src/webhook.js";
import type {
  PostAudioAvailableEvent,
  WebhookEvent,
  WebhookEventByName,
  WebhookEventEnvelope,
} from "../src/types.js";

const SECRET = "this-is-a-test-secret-1234";
// HMAC-SHA256("hello", SECRET) computed once and pinned for cross-runtime stability.
async function sign(payload: string, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
  const bytes = new Uint8Array(sig);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += (bytes[i] as number).toString(16).padStart(2, "0");
  }
  return hex;
}

/*
 * Delivery bodies exactly as the server writes them: `_make_payload` builds one
 * flat dict, the event name beside the event's fields, and the outbox handler
 * sends `json.dumps(payload, default=str)` (Python's ", " and ": " separators).
 * There is no `payload` key and no id in the body; the ids are headers.
 */
const POST_CREATED_BODY =
  '{"event": "post_created", "post_id": "3f2b6c1e-8a4d-4f7e-9b1a-2c5d8e7f6a90", ' +
  '"author": "Arch", "title": "Hello", "colony": "general", "post_type": "discussion"}';
const DIRECT_MESSAGE_BODY = '{"event": "direct_message", "sender_display_name": "Alice"}';
const TIP_RECEIVED_BODY =
  '{"event": "tip_received", "tip_id": "9c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f", ' +
  '"tipper": "Bob", "amount_sats": 210, "post_id": null, ' +
  '"comment_id": "7e6d5c4b-3a29-4180-9f8e-7d6c5b4a3928"}';
const POST_AUDIO_AVAILABLE_BODY =
  '{"event": "post_audio_available", "post_id": "0b2d5e1a-1111-2222-3333-444455556666", ' +
  '"title": "Chapter one, read aloud", "audio_id": "8b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d", ' +
  '"url": "https://assets.thecolony.ai/post_audio/8b1c2d3e.mp3", "duration_seconds": 214.6}';
// Since release 2026-11-08b every delivery names `comment_id`: null for audio
// on the post itself, the comment's id for audio on a comment (whose post is
// then `post_id`).
const POST_AUDIO_ON_POST_BODY =
  '{"event": "post_audio_available", "post_id": "0b2d5e1a-1111-2222-3333-444455556666", ' +
  '"title": "Chapter one, read aloud", "audio_id": "8b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d", ' +
  '"url": "https://assets.thecolony.ai/post_audio/8b1c2d3e.mp3", "duration_seconds": 214.6, ' +
  '"comment_id": null}';
const POST_AUDIO_ON_COMMENT_BODY =
  '{"event": "post_audio_available", "post_id": "0b2d5e1a-1111-2222-3333-444455556666", ' +
  '"title": "Chapter one, read aloud", "audio_id": "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d", ' +
  '"url": "https://assets.thecolony.ai/post_audio/1a2b3c4d.mp3", "duration_seconds": 42.5, ' +
  '"comment_id": "5c4b3a29-1807-4f6e-9d5c-4b3a29180706"}';
// Since release 2026-11-09d every delivery names `album_id` too: null for a
// single file, the album's id for a track of the album on the post.
const POST_AUDIO_ALBUM_TRACK_BODY =
  '{"event": "post_audio_available", "post_id": "0b2d5e1a-1111-2222-3333-444455556666", ' +
  '"title": "The Copper Errand", "audio_id": "41fe0a9b-8c7d-4e6f-9a5b-4c3d2e1f0a9b", ' +
  '"url": "https://assets.thecolony.ai/post_audio/41fe0a9b.mp3", "duration_seconds": 176.6, ' +
  '"comment_id": null, "album_id": "6e5d4c3b-2a19-4f08-9e7d-6c5b4a392817"}';

describe("verifyWebhook", () => {
  it("accepts a valid signature on a string payload", async () => {
    const payload = POST_CREATED_BODY;
    const sig = await sign(payload, SECRET);
    expect(await verifyWebhook(payload, sig, SECRET)).toBe(true);
  });

  it("accepts a valid signature on a Uint8Array payload", async () => {
    const payload = '{"event":"post_created"}';
    const sig = await sign(payload, SECRET);
    const bytes = new TextEncoder().encode(payload);
    expect(await verifyWebhook(bytes, sig, SECRET)).toBe(true);
  });

  it("rejects a signature signed with the wrong secret", async () => {
    const payload = "x";
    const sig = await sign(payload, "wrong-secret");
    expect(await verifyWebhook(payload, sig, SECRET)).toBe(false);
  });

  it("rejects a signature for a different payload", async () => {
    const sig = await sign("first", SECRET);
    expect(await verifyWebhook("second", sig, SECRET)).toBe(false);
  });

  it("tolerates a leading 'sha256=' prefix", async () => {
    const payload = "hello";
    const sig = await sign(payload, SECRET);
    expect(await verifyWebhook(payload, `sha256=${sig}`, SECRET)).toBe(true);
  });

  it("rejects empty / garbage signatures without throwing", async () => {
    expect(await verifyWebhook("hello", "", SECRET)).toBe(false);
    expect(await verifyWebhook("hello", "deadbeef", SECRET)).toBe(false);
  });

  it("rejects when signature length differs from expected", async () => {
    expect(await verifyWebhook("hello", "abc", SECRET)).toBe(false);
  });
});

describe("verifyAndParseWebhook", () => {
  it("reads a post_created delivery's fields on the event itself", async () => {
    const sig = await sign(POST_CREATED_BODY, SECRET);
    const event: WebhookEventEnvelope = await verifyAndParseWebhook(POST_CREATED_BODY, sig, SECRET);
    expect(event.event).toBe("post_created");
    if (event.event !== "post_created") throw new Error("not narrowed");
    const postId: string = event.post_id;
    const author: string = event.author;
    const colony: string | null = event.colony;
    expect(postId).toBe("3f2b6c1e-8a4d-4f7e-9b1a-2c5d8e7f6a90");
    expect(author).toBe("Arch");
    expect(event.title).toBe("Hello");
    expect(colony).toBe("general");
    expect(event.post_type).toBe("discussion");
    expect("payload" in event).toBe(false);
  });

  it("reads a direct_message delivery, which names only the sender", async () => {
    const sig = await sign(DIRECT_MESSAGE_BODY, SECRET);
    const event = await verifyAndParseWebhook(DIRECT_MESSAGE_BODY, sig, SECRET);
    if (event.event !== "direct_message") throw new Error("not narrowed");
    const sender: string = event.sender_display_name;
    expect(sender).toBe("Alice");
  });

  it("reads a tip on a comment, whose post_id is null", async () => {
    const sig = await sign(TIP_RECEIVED_BODY, SECRET);
    const event = await verifyAndParseWebhook(TIP_RECEIVED_BODY, sig, SECRET);
    if (event.event !== "tip_received") throw new Error("not narrowed");
    const amount: number = event.amount_sats;
    expect(amount).toBe(210);
    expect(event.post_id).toBeNull();
    expect(event.comment_id).toBe("7e6d5c4b-3a29-4180-9f8e-7d6c5b4a3928");
  });

  it("reads a post_audio_available delivery: the post, the upload and the MP3", async () => {
    const sig = await sign(POST_AUDIO_AVAILABLE_BODY, SECRET);
    const event = await verifyAndParseWebhook(POST_AUDIO_AVAILABLE_BODY, sig, SECRET);
    expect(event.event).toBe("post_audio_available");
    if (event.event !== "post_audio_available") throw new Error("not narrowed");
    expectTypeOf(event).toEqualTypeOf<PostAudioAvailableEvent>();
    const url: string = event.url;
    const seconds: number = event.duration_seconds;
    expect(event.post_id).toBe("0b2d5e1a-1111-2222-3333-444455556666");
    expect(event.title).toBe("Chapter one, read aloud");
    expect(event.audio_id).toBe("8b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d");
    expect(url).toBe("https://assets.thecolony.ai/post_audio/8b1c2d3e.mp3");
    expect(seconds).toBe(214.6);
    // A delivery from before release 2026-11-08b names no comment.
    expect(event.comment_id).toBeUndefined();
  });

  it("reads comment_id on post_audio_available: null on a post, the comment's id on a comment", async () => {
    const onPost = await verifyAndParseWebhook(
      POST_AUDIO_ON_POST_BODY,
      await sign(POST_AUDIO_ON_POST_BODY, SECRET),
      SECRET,
    );
    if (onPost.event !== "post_audio_available") throw new Error("not narrowed");
    expect(onPost.comment_id).toBeNull();
    expect(onPost.post_id).toBe("0b2d5e1a-1111-2222-3333-444455556666");

    const onComment = await verifyAndParseWebhook(
      POST_AUDIO_ON_COMMENT_BODY,
      await sign(POST_AUDIO_ON_COMMENT_BODY, SECRET),
      SECRET,
    );
    if (onComment.event !== "post_audio_available") throw new Error("not narrowed");
    expect(onComment.comment_id).toBe("5c4b3a29-1807-4f6e-9d5c-4b3a29180706");
    // The post the comment is on.
    expect(onComment.post_id).toBe("0b2d5e1a-1111-2222-3333-444455556666");
    expect(onComment.audio_id).toBe("1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d");
    expect(onComment.duration_seconds).toBe(42.5);
    expectTypeOf(onComment.comment_id).toEqualTypeOf<string | null | undefined>();
  });

  it("reads album_id on post_audio_available: the album a cleared track plays in", async () => {
    const track = await verifyAndParseWebhook(
      POST_AUDIO_ALBUM_TRACK_BODY,
      await sign(POST_AUDIO_ALBUM_TRACK_BODY, SECRET),
      SECRET,
    );
    if (track.event !== "post_audio_available") throw new Error("not narrowed");
    expect(track.album_id).toBe("6e5d4c3b-2a19-4f08-9e7d-6c5b4a392817");
    expect(track.comment_id).toBeNull();
    // The post the album is on, and the track's own upload.
    expect(track.post_id).toBe("0b2d5e1a-1111-2222-3333-444455556666");
    expect(track.audio_id).toBe("41fe0a9b-8c7d-4e6f-9a5b-4c3d2e1f0a9b");
    expectTypeOf(track.album_id).toEqualTypeOf<string | null | undefined>();

    // A delivery from before release 2026-11-09d names no album.
    const older = await verifyAndParseWebhook(
      POST_AUDIO_ON_COMMENT_BODY,
      await sign(POST_AUDIO_ON_COMMENT_BODY, SECRET),
      SECRET,
    );
    if (older.event !== "post_audio_available") throw new Error("not narrowed");
    expect(older.album_id).toBeUndefined();
  });

  it("throws ColonyWebhookVerificationError on bad signature", async () => {
    await expect(
      verifyAndParseWebhook(POST_CREATED_BODY, "deadbeef", SECRET),
    ).rejects.toBeInstanceOf(ColonyWebhookVerificationError);
  });

  it("throws on non-JSON body even when signature is valid", async () => {
    const body = "not json";
    const sig = await sign(body, SECRET);
    await expect(verifyAndParseWebhook(body, sig, SECRET)).rejects.toBeInstanceOf(
      ColonyWebhookVerificationError,
    );
  });

  it("throws when body is a JSON array (not an object)", async () => {
    const body = "[1,2,3]";
    const sig = await sign(body, SECRET);
    await expect(verifyAndParseWebhook(body, sig, SECRET)).rejects.toThrow(/not a JSON object/);
  });

  it("throws when body is missing the `event` field", async () => {
    const body = JSON.stringify({ post_id: "p1" });
    const sig = await sign(body, SECRET);
    await expect(verifyAndParseWebhook(body, sig, SECRET)).rejects.toThrow(
      /missing an `event` field/,
    );
  });

  it("works with Uint8Array payloads as well as strings", async () => {
    const sig = await sign(POST_CREATED_BODY, SECRET);
    const bytes = new TextEncoder().encode(POST_CREATED_BODY);
    const event = await verifyAndParseWebhook(bytes, sig, SECRET);
    expect(event.event).toBe("post_created");
  });
});

/*
 * The types, read by the compiler the way a handler reads them. These ran
 * green for months against `{ event, payload }`, because the tests built that
 * shape themselves: the SDK both wrote and read a body the server never sent.
 * So this compiles handler code against src/types.ts and checks the outcome,
 * rather than trusting a body the test made up.
 */
describe("webhook delivery types", () => {
  function diagnostics(handler: string): string[] {
    const root = join(dirname(fileURLToPath(import.meta.url)), "..");
    const file = join(root, "tests", "__webhook_handler__.ts");
    const source =
      `import type { WebhookEventEnvelope } from "../src/types";\n` +
      `declare const e: WebhookEventEnvelope;\n${handler}\n`;
    const options: ts.CompilerOptions = {
      strict: true,
      noEmit: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      skipLibCheck: true,
      types: [],
    };
    const host = ts.createCompilerHost(options);
    const baseGet = host.getSourceFile.bind(host);
    host.getSourceFile = (name, lang, ...rest) =>
      name === file ? ts.createSourceFile(name, source, lang) : baseGet(name, lang, ...rest);
    const program = ts.createProgram({ rootNames: [file], options, host });
    return ts
      .getPreEmitDiagnostics(program, program.getSourceFile(file))
      .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
  }

  it("types each event's fields flat, as the server sends them", () => {
    expect(
      diagnostics(`
        if (e.event === "post_created") {
          const id: string = e.post_id;
          const author: string = e.author;
          const colony: string | null = e.colony;
        }
        if (e.event === "comment_created") { const c: string = e.comment_id; }
        if (e.event === "direct_message") { const s: string = e.sender_display_name; }
        if (e.event === "tip_received") { const p: string | null = e.post_id; }
        if (e.event === "post_audio_available") {
          const audio: string = e.audio_id;
          const url: string = e.url;
          const seconds: number = e.duration_seconds;
        }
      `),
    ).toEqual([]);
  }, 30_000);

  it("subscribes to and maps post_audio_available like the other events", () => {
    expectTypeOf<"post_audio_available">().toExtend<WebhookEvent>();
    expectTypeOf<
      WebhookEventByName<"post_audio_available">
    >().toEqualTypeOf<PostAudioAvailableEvent>();
    // The audio's url is the MP3 the post plays, never null: the event is
    // sent only once a review has cleared it.
    expectTypeOf<PostAudioAvailableEvent["url"]>().toEqualTypeOf<string>();
    expect(diagnostics(`if (e.event === "post_audio_available") { e.status; }`)).not.toEqual([]);
  }, 30_000);

  it("has no nested payload and no delivery_id in the body", () => {
    expect(diagnostics(`if (e.event === "post_created") { e.payload; }`)).not.toEqual([]);
    expect(diagnostics(`e.delivery_id;`)).not.toEqual([]);
  }, 30_000);
});
