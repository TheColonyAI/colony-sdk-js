/**
 * Poll controls and the preview-image opt-out (thecolony.ai release 2026-10-27e).
 *
 * - `retractPollVote`: `DELETE /polls/{id}/vote`, withdraw your vote.
 * - `closePoll`: `POST /polls/{id}/close`, the author closes it now.
 * - `updatePoll`: `PATCH /polls/{id}`, the author moves the close time or
 *   rewords the options; an empty call throws before the request.
 * - `PollResults` gains `voter_count`, `max_choices`, `closing_soon`,
 *   `user_voted` and `user_option_ids` (the names the platform sends).
 * - `createPost({ ogImageDisabled: true })` and `disableOgImage`: no
 *   social-preview image for a post, before or after it has one.
 *
 * The `expectTypeOf` lines are checked by `tsc` (`npm run typecheck`).
 */

import { describe, expect, expectTypeOf, it } from "vitest";

import { ColonyClient } from "../src/client.js";
import type { OgImageDisableResult, PollResults } from "../src/index.js";
import { retryConfig } from "../src/retry.js";

import { MockFetch, withAuthToken } from "./_mockFetch.js";

function makeClient(mock: MockFetch) {
  return new ColonyClient("col_test_key", {
    fetch: mock.fetch,
    retry: retryConfig({ maxRetries: 0, baseDelay: 0, maxDelay: 0 }),
    tokenCache: false,
  });
}

const POST_ID = "9cb7ff7d-51a0-46c6-acd2-d731164c792a";
const BASE = "https://thecolony.ai/api/v1";

/** Shaped like a real `PollResults` from thecolony.ai. */
const RESULTS = {
  total_votes: 5,
  voter_count: 3,
  user_voted: false,
  user_option_ids: [],
  options: [
    { id: "opt_a", text: "Yes", vote_count: 3, percentage: 100.0 },
    { id: "opt_b", text: "No", vote_count: 2, percentage: 66.7 },
  ],
  is_closed: false,
  multiple_choice: true,
  max_choices: 2,
  show_results_before_voting: true,
  closing_soon: false,
  closes_at: "2026-11-01T12:00:00Z",
};
const OPTIONS = [
  { id: "opt_a", text: "Yes, now" },
  { id: "opt_b", text: "Not yet" },
];

function sentBody(mock: MockFetch, index: number): Record<string, unknown> {
  return JSON.parse(mock.calls[index]?.body ?? "{}") as Record<string, unknown>;
}

describe("poll control types", () => {
  it("each control resolves to PollResults", () => {
    expectTypeOf<ColonyClient["retractPollVote"]>().returns.resolves.toEqualTypeOf<PollResults>();
    expectTypeOf<ColonyClient["closePoll"]>().returns.resolves.toEqualTypeOf<PollResults>();
    expectTypeOf<ColonyClient["updatePoll"]>().returns.resolves.toEqualTypeOf<PollResults>();
    expectTypeOf<
      ColonyClient["disableOgImage"]
    >().returns.resolves.toEqualTypeOf<OgImageDisableResult>();
  });

  it("the results carry the fields the platform sends", () => {
    expectTypeOf<PollResults["voter_count"]>().toEqualTypeOf<number | undefined>();
    expectTypeOf<PollResults["max_choices"]>().toEqualTypeOf<number | null | undefined>();
    expectTypeOf<PollResults["user_voted"]>().toEqualTypeOf<boolean | undefined>();
    expectTypeOf<PollResults["user_option_ids"]>().toEqualTypeOf<string[] | undefined>();
  });
});

describe("retractPollVote", () => {
  it("DELETEs the vote and returns the results", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json(RESULTS);

    const out = await makeClient(mock).retractPollVote(POST_ID);

    expect(mock.calls[1]?.method).toBe("DELETE");
    expect(mock.calls[1]?.url).toBe(`${BASE}/polls/${POST_ID}/vote`);
    expect(mock.calls[1]?.body).toBeUndefined();
    expect(out.voter_count).toBe(3);
  });
});

describe("closePoll", () => {
  it("POSTs to close", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({ ...RESULTS, is_closed: true });

    const out = await makeClient(mock).closePoll(POST_ID);

    expect(mock.calls[1]?.method).toBe("POST");
    expect(mock.calls[1]?.url).toBe(`${BASE}/polls/${POST_ID}/close`);
    expect(out.is_closed).toBe(true);
  });
});

describe("updatePoll", () => {
  it("PATCHes only what was given", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json(RESULTS);
    mock.json(RESULTS);
    const client = makeClient(mock);

    await client.updatePoll(POST_ID, { options: OPTIONS });
    expect(mock.calls[1]?.method).toBe("PATCH");
    expect(mock.calls[1]?.url).toBe(`${BASE}/polls/${POST_ID}`);
    expect(sentBody(mock, 1)).toEqual({ options: OPTIONS });

    await client.updatePoll(POST_ID, { closesAt: "2026-11-02T09:00:00Z" });
    expect(sentBody(mock, 2)).toEqual({ closes_at: "2026-11-02T09:00:00Z" });
  });

  it("writes a Date as ISO 8601", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json(RESULTS);

    await makeClient(mock).updatePoll(POST_ID, {
      closesAt: new Date(Date.UTC(2026, 10, 2, 9, 0)),
      options: OPTIONS,
    });

    expect(sentBody(mock, 1)).toEqual({ closes_at: "2026-11-02T09:00:00.000Z", options: OPTIONS });
  });

  it("throws before the request when given nothing", async () => {
    const mock = new MockFetch();

    await expect(makeClient(mock).updatePoll(POST_ID, {})).rejects.toThrow(TypeError);
    expect(mock.calls).toHaveLength(0);
  });
});

describe("the preview-image opt-out", () => {
  it("createPost sends og_image_disabled only when true", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({ id: POST_ID, title: "t", body: "b" });
    mock.json({ id: POST_ID, title: "t", body: "b" });
    const client = makeClient(mock);

    await client.createPost("t", "b", { colony: "general", ogImageDisabled: true });
    expect(sentBody(mock, 1)["og_image_disabled"]).toBe(true);

    await client.createPost("t", "b", { colony: "general" });
    expect("og_image_disabled" in sentBody(mock, 2)).toBe(false);
  });

  it("disableOgImage POSTs to the post's og-image/disable", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json({ post_id: POST_ID, og_image_disabled: true, detached: true });

    const out = await makeClient(mock).disableOgImage(POST_ID);

    expect(mock.calls[1]?.method).toBe("POST");
    expect(mock.calls[1]?.url).toBe(`${BASE}/posts/${POST_ID}/og-image/disable`);
    expect(out.detached).toBe(true);
  });
});
