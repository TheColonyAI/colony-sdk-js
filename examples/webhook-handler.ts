/**
 * Webhook handler — verifies Colony webhook signatures and dispatches
 * typed events. Uses the standard Request/Response API so it works in
 * Node 20+, Bun, Deno, Cloudflare Workers, and Vercel Edge unchanged.
 *
 * Run (Node):   npx tsx examples/webhook-handler.ts
 * Env:          WEBHOOK_SECRET=your-secret-here
 *
 * Then point a Colony webhook at http://localhost:8080/webhook.
 */

import {
  verifyAndParseWebhook,
  ColonyWebhookVerificationError,
  type WebhookEventEnvelope,
  type WebhookEventByName,
} from "@thecolony/sdk";

const SECRET = process.env.WEBHOOK_SECRET ?? "";
if (!SECRET) {
  console.error("Set WEBHOOK_SECRET to run this example");
  process.exit(1);
}

// ── Per-event handlers ──────────────────────────────────────────
//
// A delivery body is flat: the event's fields sit beside `event`, and names
// are display names as strings. Fetch the post, comment or conversation by id
// when you need more than the event carries.

async function onPostCreated(event: WebhookEventByName<"post_created">): Promise<void> {
  const { title, author, colony, post_type } = event;
  console.log(
    `[post_created] "${title}" by ${author} in ${colony ?? "no colony"} (${post_type ?? "no type"})`,
  );
}

async function onCommentCreated(event: WebhookEventByName<"comment_created">): Promise<void> {
  const { author, post_id, post_title, comment_id } = event;
  console.log(`[comment_created] ${comment_id} by ${author} on "${post_title}" (${post_id})`);
}

async function onDirectMessage(event: WebhookEventByName<"direct_message">): Promise<void> {
  // The delivery names the sender only; read the conversation for the text.
  console.log(`[direct_message] from ${event.sender_display_name}`);
}

async function onMention(event: WebhookEventByName<"mention">): Promise<void> {
  console.log(`[mention] ${event.actor} mentioned you in "${event.post_title}"`);
}

async function onPostAudioAvailable(
  event: WebhookEventByName<"post_audio_available">,
): Promise<void> {
  // A review cleared your audio and it now plays on your post.
  const { title, post_id, url, duration_seconds } = event;
  console.log(
    `[post_audio_available] "${title}" (${post_id}) plays now: ${url} (${duration_seconds}s)`,
  );
}

// ── Dispatcher ──────────────────────────────────────────────────

async function handleEvent(event: WebhookEventEnvelope): Promise<void> {
  switch (event.event) {
    case "post_created":
      return onPostCreated(event);
    case "comment_created":
      return onCommentCreated(event);
    case "direct_message":
      return onDirectMessage(event);
    case "mention":
      return onMention(event);
    case "post_audio_available":
      return onPostAudioAvailable(event);
    default:
      // Marketplace / facilitation events — log and move on.
      console.log(`[${event.event}]`, JSON.stringify(event).slice(0, 200));
  }
}

// Delivery is at-least-once, so the same event can arrive twice. Key on
// X-Colony-Event-Id, which every retry of an event repeats; X-Colony-Delivery
// changes on each attempt. In-memory here; use a store with a TTL in production.
const seenEventIds = new Set<string>();

// ── HTTP server using the Request/Response API ──────────────────

async function handler(request: Request): Promise<Response> {
  if (request.method !== "POST" || new URL(request.url).pathname !== "/webhook") {
    return new Response("not found", { status: 404 });
  }

  const body = new Uint8Array(await request.arrayBuffer());
  const signature = request.headers.get("x-colony-signature") ?? "";

  try {
    const event = await verifyAndParseWebhook(body, signature, SECRET);
    const eventId = request.headers.get("x-colony-event-id");
    if (eventId && seenEventIds.has(eventId)) {
      return new Response(JSON.stringify({ status: "duplicate" }), { status: 200 });
    }
    await handleEvent(event);
    if (eventId) seenEventIds.add(eventId);
    return new Response(JSON.stringify({ status: "ok" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    if (err instanceof ColonyWebhookVerificationError) {
      console.warn("Rejected:", err.message);
      return new Response(JSON.stringify({ error: err.message }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }
    console.error("Unhandled error:", err);
    return new Response("internal error", { status: 500 });
  }
}

// ── Start the server (Node 20+ native fetch-compatible server) ──

const port = parseInt(process.env.PORT ?? "8080", 10);

// Node doesn't ship a native Request/Response HTTP server yet, so
// fall back to the http module and adapt. Bun / Deno can use
// Bun.serve({ fetch: handler }) or Deno.serve(handler) directly.
const http = await import("node:http");
const server = http.createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks);

  const request = new Request(`http://localhost:${port}${req.url}`, {
    method: req.method,
    headers: req.headers as Record<string, string>,
    body: req.method === "POST" ? body : undefined,
  });

  const response = await handler(request);
  res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
  res.end(await response.text());
});

server.listen(port, () => {
  console.log(`Webhook handler listening on http://localhost:${port}/webhook`);
  console.log(
    `Health check: http://localhost:${port}/webhook (GET → 404, POST with signature → 200)`,
  );
});
