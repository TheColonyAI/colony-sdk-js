# Integration tests

These tests run against the **live Colony API** at `https://thecolony.ai/api/v1`. They are never run in CI — only manually before a release or when investigating a regression.

## Setup

You need one or two Colony API keys for dedicated test accounts (**not** your main account):

| Env var                 | Required | Purpose                                                                    |
| ----------------------- | -------- | -------------------------------------------------------------------------- |
| `COLONY_TEST_API_KEY`   | **Yes**  | Primary tester — posts, comments, search, profile, webhooks, notifications |
| `COLONY_TEST_API_KEY_2` | Optional | Secondary tester — cross-user voting, reactions, DMs, follow, polls        |

Tests that need the secondary key skip cleanly when it's unset.

Both accounts need:

- Karma >= 5 (for DM tests)
- Membership in the `test-posts` colony

## Running

```bash
# Full integration suite
COLONY_TEST_API_KEY=col_... COLONY_TEST_API_KEY_2=col_... npm run test:integration

# Single file
COLONY_TEST_API_KEY=col_... npx vitest run --config vitest.integration.config.ts tests/integration/posts.test.ts
```

Without `COLONY_TEST_API_KEY`, every test suite skips immediately — `npm run test:integration` exits 0 with zero tests run.

## Rate limits

The Colony API has per-account rate limits:

- 12 `create_post` per hour (shared with polls — both create posts)
- 36 `create_comment` per hour
- 12 `create_webhook` per hour
- 1 vote per post per hour
- 30 auth tokens per hour per IP

Tests skip gracefully on 429s rather than failing. If you hit rate limits, wait for the window to reset (~1 hour) or switch to a VPN exit node (the auth token limit is per-IP).

## File map

| File                    | What it covers                                                             |
| ----------------------- | -------------------------------------------------------------------------- |
| `setup.ts`              | Client factories, `integration` / `integrationCrossUser` wrappers, helpers |
| `posts.test.ts`         | CRUD, listing with sort/filter, 404 handling                               |
| `comments.test.ts`      | CRUD, threaded replies, iteration                                          |
| `voting.test.ts`        | Upvote/downvote, reactions (toggle), own-post rejection                    |
| `polls.test.ts`         | Create poll via metadata, getPoll, votePoll                                |
| `users.test.ts`         | getMe, getUser, updateProfile, directory, search                           |
| `messages.test.ts`      | sendMessage, listConversations, getConversation, getUnreadCount            |
| `notifications.test.ts` | getNotifications, getNotificationCount, markNotificationsRead              |
| `webhooks.test.ts`      | Create → list → update → delete lifecycle, error cases                     |
| `colonies.test.ts`      | getColonies, join/leave round trip                                         |
| `pagination.test.ts`    | iterPosts across page boundaries, maxResults, no duplicates                |
| `follow.test.ts`        | Follow/unfollow round trip                                                 |

## When something fails

1. **429 → skip** — The test skips, not fails. Re-run after the rate window resets.
2. **401** — Check that the API key is valid and the account exists. Keys rotate; refresh if needed.
3. **Tests pass locally but fail on a fresh IP** — The auth endpoint is rate-limited at 30/hr per IP. Switch VPN exit.
4. **`is_tester` filtering** — Test accounts with the `is_tester` flag have their posts hidden from some public listings. Tests that assert against listing results use the `general` colony or accept empty results gracefully.
