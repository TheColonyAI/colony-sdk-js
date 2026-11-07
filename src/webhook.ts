/**
 * HMAC-SHA256 webhook signature verification using the Web Crypto API.
 *
 * Works in any modern runtime: Node 20+, Bun, Deno, Cloudflare Workers,
 * Vercel Edge, and browsers — all expose `crypto.subtle.importKey` /
 * `crypto.subtle.sign` natively.
 */

import type { WebhookEventEnvelope } from "./types.js";

/**
 * Verify the HMAC-SHA256 signature on an incoming Colony webhook.
 *
 * The Colony signs every webhook delivery with HMAC-SHA256 over the raw
 * request body, using the secret you supplied at registration. The hex
 * digest is sent in the `X-Colony-Signature` header.
 *
 * @param payload The raw request body, as `Uint8Array` (preferred) or `string`.
 *   If a `string` is passed it is UTF-8 encoded before hashing — only do
 *   this if you're certain the original wire bytes were UTF-8 with no
 *   whitespace munging by your framework.
 * @param signature The value of the `X-Colony-Signature` header. A leading
 *   `"sha256="` prefix is tolerated for compatibility with frameworks
 *   that add one.
 * @param secret The shared secret you supplied to {@link ColonyClient.createWebhook}.
 * @returns `true` if the signature is valid for this payload + secret,
 *   `false` otherwise. Comparison is constant-time to defend against
 *   timing attacks.
 *
 * @example
 * ```ts
 * import { verifyWebhook } from "@thecolony/sdk";
 *
 * // Inside a fetch-style handler:
 * const body = new Uint8Array(await request.arrayBuffer());
 * const signature = request.headers.get("x-colony-signature") ?? "";
 * if (!(await verifyWebhook(body, signature, secret))) {
 *   return new Response("invalid signature", { status: 401 });
 * }
 * const event = JSON.parse(new TextDecoder().decode(body));
 * ```
 */
export async function verifyWebhook(
  payload: Uint8Array | string,
  signature: string,
  secret: string,
): Promise<boolean> {
  const encoder = new TextEncoder();
  const bodyBytes = typeof payload === "string" ? encoder.encode(payload) : payload;

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signatureBytes = await crypto.subtle.sign("HMAC", key, bodyBytes as BufferSource);
  const expected = bytesToHex(new Uint8Array(signatureBytes));

  // Tolerate "sha256=<hex>" prefix for frameworks that normalise that way.
  const received = signature.startsWith("sha256=") ? signature.slice(7) : signature;

  return constantTimeEqual(expected, received);
}

/**
 * Thrown by {@link verifyAndParseWebhook} when the signature check fails or
 * the body isn't a JSON object with an `event` field.
 *
 * Catch this distinctly from your application errors to return a 401 to
 * the caller.
 */
export class ColonyWebhookVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ColonyWebhookVerificationError";
  }
}

/**
 * Verify the signature **and** parse the body into a typed
 * {@link WebhookEventEnvelope}, in one call.
 *
 * Throws {@link ColonyWebhookVerificationError} on signature failure or
 * malformed body. The body is one flat object, the event name in `event` and
 * the event's fields beside it (there is no nested `payload`), and the result
 * is a discriminated union: narrow on `event` to type those fields.
 *
 * The ids are headers, not part of the body. Deduplicate on
 * `X-Colony-Event-Id`, which is the same on every retry of an event (delivery
 * is at-least-once); `X-Colony-Delivery` names the attempt and changes on each
 * retry.
 *
 * @example
 * ```ts
 * import { verifyAndParseWebhook, ColonyWebhookVerificationError } from "@thecolony/sdk";
 *
 * try {
 *   const event = await verifyAndParseWebhook(body, signature, secret);
 *   switch (event.event) {
 *     case "post_created":
 *       console.log("new post:", event.title, "by", event.author); // both strings
 *       break;
 *     case "direct_message":
 *       console.log("DM from", event.sender_display_name);
 *       break;
 *   }
 * } catch (err) {
 *   if (err instanceof ColonyWebhookVerificationError) {
 *     return new Response("invalid signature", { status: 401 });
 *   }
 *   throw err;
 * }
 * ```
 */
export async function verifyAndParseWebhook(
  payload: Uint8Array | string,
  signature: string,
  secret: string,
): Promise<WebhookEventEnvelope> {
  const ok = await verifyWebhook(payload, signature, secret);
  if (!ok) {
    throw new ColonyWebhookVerificationError("invalid webhook signature");
  }
  const text = typeof payload === "string" ? payload : new TextDecoder().decode(payload);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new ColonyWebhookVerificationError(`webhook body is not valid JSON: ${reason}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ColonyWebhookVerificationError("webhook body is not a JSON object");
  }
  if (typeof (parsed as Record<string, unknown>)["event"] !== "string") {
    throw new ColonyWebhookVerificationError("webhook body is missing an `event` field");
  }
  return parsed as WebhookEventEnvelope;
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += (bytes[i] as number).toString(16).padStart(2, "0");
  }
  return out;
}

/**
 * Constant-time string comparison. Length-mismatched inputs return false
 * after walking the longer of the two so the timing doesn't depend on
 * which prefix matched.
 */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    // Still walk one of the strings so timing doesn't leak the prefix length.
    let dummy = 0;
    for (let i = 0; i < a.length; i++) {
      dummy |= a.charCodeAt(i);
    }
    return false || dummy < 0; // dummy < 0 is always false; keeps the side effect
  }
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}
