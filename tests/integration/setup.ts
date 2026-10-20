/**
 * Shared setup for integration tests.
 *
 * Creates ColonyClient instances from env vars, provides helpers for
 * rate-limit-aware skipping, and exports reusable constants.
 *
 * Env vars:
 *   COLONY_TEST_API_KEY    — primary integration-tester account (required)
 *   COLONY_TEST_API_KEY_2  — secondary account for cross-user tests (optional)
 */

import { describe } from "vitest";
import {
  ColonyClient,
  ColonyAPIError,
  ColonyRateLimitError,
  retryConfig,
  type JsonObject,
} from "../../src/index.js";

export const API_KEY = process.env.COLONY_TEST_API_KEY ?? "";
export const API_KEY_2 = process.env.COLONY_TEST_API_KEY_2 ?? "";

export const HAS_KEY = API_KEY.length > 0;
export const HAS_SECOND_KEY = API_KEY_2.length > 0;

/** Colony used for all write traffic — keeps test posts out of the main feed. */
export const TEST_COLONY = "test-posts";

// Clients use maxRetries: 0 so a 429 surfaces immediately instead of
// multiplying into more requests during a rate-limited test run.
const noRetry = retryConfig({ maxRetries: 0 });

/** Primary integration-tester client. */
export function makeClient(): ColonyClient {
  return new ColonyClient(API_KEY, { retry: noRetry });
}

/** Secondary integration-tester client (for cross-user DM, follow, etc). */
export function makeSecondClient(): ColonyClient {
  return new ColonyClient(API_KEY_2, { retry: noRetry });
}

/**
 * Wrapper around `describe` that skips the entire suite when the primary
 * API key is not set. Use this as the top-level block in every integration
 * test file.
 */
export const integration = describe.skipIf(!HAS_KEY);

/**
 * Wrapper that also requires the secondary key.
 */
export const integrationCrossUser = describe.skipIf(!HAS_KEY || !HAS_SECOND_KEY);

/**
 * Generate a unique suffix for test entities so parallel runs don't collide.
 */
export function uniqueSuffix(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Return true if `err` is a transient error that should skip the test
 * rather than fail it. Covers rate limits (429) and transient server
 * errors (502/503/504) — the same status set the SDK retries by default,
 * but test clients use maxRetries: 0 to fail fast.
 */
export function isRateLimited(err: unknown): boolean {
  if (err instanceof ColonyRateLimitError) return true;
  if (err instanceof ColonyAPIError) {
    const transient = new Set([429, 502, 503, 504]);
    return transient.has(err.status);
  }
  return false;
}

/**
 * Try to create a post, skipping the calling test on rate limit.
 * Returns the post object on success.
 */
export async function createTestPost(
  client: ColonyClient,
  suffix: string,
): Promise<JsonObject & { id: string }> {
  const post = await client.createPost(
    `Integration test post ${suffix}`,
    "Safe to delete. Created by colony-sdk-js integration tests.",
    // Named, because a left-out type now publishes a post with NO type, and
    // posts.test.ts asserts `discussion` on the round trip.
    { colony: TEST_COLONY, postType: "discussion" },
  );
  return post as JsonObject & { id: string };
}

/**
 * Silently delete a post, swallowing errors (best-effort cleanup).
 */
export async function deleteTestPost(client: ColonyClient, postId: string): Promise<void> {
  try {
    await client.deletePost(postId);
  } catch {
    // best-effort cleanup
  }
}
