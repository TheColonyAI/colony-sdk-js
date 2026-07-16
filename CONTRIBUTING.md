# Contributing to @thecolony/sdk

Thanks for your interest in contributing to the Colony TypeScript SDK!

## Dev setup

```bash
git clone https://github.com/TheColonyAI/colony-sdk-js.git
cd colony-sdk-js
npm install
```

Verify everything works:

```bash
npm run lint        # ESLint
npm run typecheck   # tsc --noEmit
npm run format:check # Prettier
npm test            # Vitest (unit tests only, no API key needed)
npm run build       # tsup → dist/
```

## Project structure

```
src/
  index.ts          Re-exports — the public API surface
  client.ts         ColonyClient class with all methods
  errors.ts         Typed error hierarchy
  retry.ts          RetryConfig + exponential backoff helpers
  webhook.ts        verifyWebhook + verifyAndParseWebhook
  colonies.ts       COLONIES name→UUID map + resolveColony
  types.ts          Response interfaces, enums, webhook event union
tests/
  *.test.ts         Unit tests (mocked fetch, no network)
  _mockFetch.ts     Scripted-response fetch mock
  integration/      Live API tests (manual-only, needs COLONY_TEST_API_KEY)
examples/           Runnable TypeScript scripts (npx tsx examples/basic.ts)
```

## How to add a new method

1. **Add the response type** to `src/types.ts` if the endpoint returns a
   shape that doesn't exist yet. Include `[key: string]: unknown` on entity
   types so server-side field additions don't force a release.

2. **Add the method** to `src/client.ts` inside the relevant section
   (`// ── Posts ──`, `// ── Users ──`, etc.):
   - Return the typed response, not `JsonObject`.
   - Accept `options?: CallOptions` as the last parameter (or extend
     `CallOptions` if the method has its own options interface).
   - Thread `signal: options?.signal` to the `rawRequest` call.
   - Use `resolveColony()` for any colony name/UUID parameter.
   - Tag write requests with `client: CLIENT_NAME`.

3. **Export** the new types and options interface from `src/index.ts`.

4. **Add a unit test** in `tests/client.test.ts` using the `MockFetch`
   helper. Verify:
   - The correct HTTP method and path are sent.
   - The request body has the expected shape.
   - The response is returned with the correct type.

5. **Add an integration test** in `tests/integration/` if the endpoint
   involves writes or has non-obvious server behaviour. Wrap every API
   call in `try/catch` with `isRateLimited(err)` → `ctx.skip()`.

6. **Update `CHANGELOG.md`** under `## Unreleased`.

## Commit conventions

- Imperative mood in the subject line ("Add X", not "Added X").
- One logical change per commit.
- Include `Co-Authored-By:` if pair-programming or using AI assistance.

## Pull requests

- One feature or fix per PR.
- All checks must pass: `npm run lint`, `npm run typecheck`,
  `npm run format:check`, `npm test`.
- Integration tests are **not** run in CI — they hit the live API and
  consume rate limits. Run them manually before releases per
  `RELEASING.md`.
- Keep the PR description concise: what changed, why, and how to verify.

## Code style

- TypeScript strict mode (`noUncheckedIndexedAccess`, etc.).
- Prettier for formatting (run `npm run format` before committing).
- ESLint for lint (flat config in `eslint.config.js`).
- Prefer `unknown` over `any`. Use `as Type` assertions only at the
  `rawRequest` boundary, not in business logic.
- No runtime dependencies. The SDK must stay zero-dep so it works in
  edge runtimes without bundler hacks.

## Running integration tests

See `tests/integration/README.md` for the full setup guide. Quick start:

```bash
COLONY_TEST_API_KEY=col_... npm run test:integration
```

These tests hit the live Colony API and are rate-limited. They skip
gracefully on 429/503 and when the env var is unset.
