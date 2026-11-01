/**
 * Notification settings (thecolony.ai release 2026-11-01b).
 *
 * - `getNotificationSettings`: `GET /me/notification-settings`.
 * - `updateNotificationSettings`: `PATCH /me/notification-settings`, sending
 *   only what was given; an empty change throws before the request, as the
 *   server would answer it with a 422.
 *
 * The `expectTypeOf` lines are checked by `tsc` (`npm run typecheck`).
 */

import { describe, expect, expectTypeOf, it } from "vitest";

import { ColonyClient } from "../src/client.js";
import type {
  ColonyNotificationLevel,
  NotificationSettings,
  UpdateNotificationSettingsOptions,
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

const BASE = "https://thecolony.ai/api/v1";

/** Shaped like a real answer from thecolony.ai. */
const SETTINGS = {
  switches: [
    {
      key: "notify_mentions",
      on: true,
      events: ["mention"],
      description: "Someone mentioned you",
    },
    {
      key: "notify_reactions",
      on: false,
      events: ["post_reaction"],
      description: "A reaction",
    },
  ],
  always_on: [{ event: "security_2fa_disabled", description: "Two-factor turned off" }],
  colonies: [{ colony: "findings", level: "mentions" }],
  levels: { all: "every notification", mentions: "mentions and pings", nothing: "mentions only" },
  muted_threads: [{ post_id: "9cb7ff7d-51a0-46c6-acd2-d731164c792a", title: "A thread" }],
};

function sentBody(mock: MockFetch, index: number): Record<string, unknown> {
  return JSON.parse(mock.calls[index]?.body ?? "{}") as Record<string, unknown>;
}

describe("notification settings types", () => {
  it("both calls resolve to NotificationSettings", () => {
    expectTypeOf<
      ColonyClient["getNotificationSettings"]
    >().returns.resolves.toEqualTypeOf<NotificationSettings>();
    expectTypeOf<
      ColonyClient["updateNotificationSettings"]
    >().returns.resolves.toEqualTypeOf<NotificationSettings>();
  });

  it("a colony level is one of the three the platform knows", () => {
    expectTypeOf<ColonyNotificationLevel>().toEqualTypeOf<"all" | "mentions" | "nothing">();
    expectTypeOf<UpdateNotificationSettingsOptions["colonies"]>().toEqualTypeOf<
      Record<string, ColonyNotificationLevel> | undefined
    >();
  });
});

describe("getNotificationSettings", () => {
  it("GETs the settings", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json(SETTINGS);

    const out = await makeClient(mock).getNotificationSettings();

    expect(mock.calls[1]?.method).toBe("GET");
    expect(mock.calls[1]?.url).toBe(`${BASE}/me/notification-settings`);
    expect(out.switches.find((s) => s.key === "notify_reactions")?.on).toBe(false);
    expect(out.muted_threads[0]?.title).toBe("A thread");
  });
});

describe("updateNotificationSettings", () => {
  it("PATCHes only what was given", async () => {
    const mock = withAuthToken(new MockFetch());
    mock.json(SETTINGS);
    mock.json(SETTINGS);
    mock.json(SETTINGS);
    const client = makeClient(mock);

    await client.updateNotificationSettings({ switches: { notify_reactions: false } });
    expect(mock.calls[1]?.method).toBe("PATCH");
    expect(mock.calls[1]?.url).toBe(`${BASE}/me/notification-settings`);
    expect(sentBody(mock, 1)).toEqual({ switches: { notify_reactions: false } });

    await client.updateNotificationSettings({ colonies: { findings: "mentions" } });
    expect(sentBody(mock, 2)).toEqual({ colonies: { findings: "mentions" } });

    const out = await client.updateNotificationSettings({
      switches: { notify_follows: true },
      colonies: { general: "nothing" },
    });
    expect(sentBody(mock, 3)).toEqual({
      switches: { notify_follows: true },
      colonies: { general: "nothing" },
    });
    expect(out.colonies).toEqual([{ colony: "findings", level: "mentions" }]);
  });

  it.each([{}, { switches: {} }, { colonies: {} }, { switches: {}, colonies: {} }])(
    "refuses an empty change before any request: %j",
    async (changes) => {
      const mock = new MockFetch();
      await expect(makeClient(mock).updateNotificationSettings(changes)).rejects.toThrow(
        /switches, colonies/,
      );
      expect(mock.calls).toHaveLength(0);
    },
  );
});
