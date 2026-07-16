# Releasing `@thecolony/sdk`

This package is published to **npm** and **JSR** (jsr.io) on every tag push
via short-lived OIDC tokens minted by GitHub Actions — no long-lived tokens
stored anywhere. npm releases ship with provenance attestations; JSR
publishes the TypeScript source directly so Deno users get native TS support.

## One-time setup (npmjs.com side)

Before the first publish, the `@thecolony` org and the `@thecolony/sdk`
package need a Trusted Publisher configured on npmjs.com. This is a manual
browser step — it can't be scripted.

1. Sign in to <https://www.npmjs.com> as an account that owns (or will own)
   the `@thecolony` org. Create the org if it doesn't exist:
   <https://www.npmjs.com/org/create>.
2. Reserve the package name. The simplest path is to do a one-off bootstrap
   publish manually (`npm publish --access public` after `npm login`), then
   add the Trusted Publisher and remove the local credentials. Alternatively,
   npm now supports configuring a Trusted Publisher on a not-yet-published
   package — go to <https://www.npmjs.com/package/@thecolony/sdk/access>
   after the org exists and add the publisher there.
3. On the package's **Settings → Trusted Publishers** page, add a new
   GitHub Actions publisher with:
   - **Repository owner:** `TheColonyAI`
   - **Repository name:** `colony-sdk-js`
   - **Workflow filename:** `release.yml`
   - **Environment name:** _(leave blank — we don't gate publishing through
     a GitHub Environment)_
4. Save. From now on, any `release.yml` run on a `vX.Y.Z` tag push can mint
   an OIDC token that npm will accept.

No GitHub repo secrets are required — `permissions: id-token: write` in the
workflow is enough.

## One-time setup (JSR side)

Before the first JSR publish, the `@thecolony` scope and the package need
to be linked to the GitHub repo. This is a manual browser step.

1. Sign in to <https://jsr.io> (GitHub OAuth).
2. Create the `@thecolony` scope if it doesn't exist:
   <https://jsr.io/new>.
3. Create the `@thecolony/sdk` package under that scope.
4. On the package's **Settings** tab, link the GitHub repository:
   - Enter `TheColonyAI/colony-sdk-js` and click **Link**.
5. That's it — the `publish-jsr` job in `release.yml` uses OIDC
   (`id-token: write`) and `npx jsr publish` to publish automatically.

## Per-release checklist

The release workflow refuses to publish if the tag version doesn't match
`package.json`'s `version`, so the order matters.

1. **Pick the version.** `0.x.y` for new features, `0.x.(y+1)` for fixes.
   Once we ship 1.0.0, semver applies normally.
2. **Bump `version` in `package.json` and `jsr.json`** on a release branch
   (`release-X.Y.Z`). Both must match — npm reads `package.json`, JSR reads
   `jsr.json`.
3. **Promote the `## Unreleased` section in `CHANGELOG.md`** to
   `## X.Y.Z — YYYY-MM-DD`. Add a fresh empty `## Unreleased` if you want
   one.
4. **Run the local pre-release checks:**
   ```bash
   npm ci
   npm run lint
   npm run typecheck
   npm run format:check
   npm run build
   npm test
   ```
   All must pass. The CI matrix runs the same commands on Node 20 and 22 —
   if you can't reproduce a CI failure locally, run with `node --version`
   pinned to one of those.
5. **(Optional) Smoke-test the build artefacts:**
   ```bash
   npm pack --dry-run
   ```
   Check that `dist/` contains `index.js`, `index.cjs`, and `.d.ts` /
   `.d.cts`, and that `package.json`, `README.md`, `LICENSE` are included.
6. **Open a PR with the version bump + changelog promotion**, get it merged
   to `master`. **Do not** tag before the PR is merged — the tag must point
   at the merged commit so consumers can `git checkout vX.Y.Z` and see the
   exact published source.
7. **Tag and push from `master`:**
   ```bash
   git checkout master
   git pull
   git tag -a vX.Y.Z -m "Release X.Y.Z"
   git push origin vX.Y.Z
   ```
8. **Watch the release workflow.** It runs four jobs sequentially:
   `verify-tag` → `test (20, 22)` → `publish` → `github-release`. The
   `publish` job is the one that requires `id-token: write`. If npm rejects
   the OIDC token, double-check that the Trusted Publisher on npmjs.com
   matches the workflow filename (`release.yml`) exactly.
9. **Verify after the workflow finishes:**
   - <https://www.npmjs.com/package/@thecolony/sdk> shows the new version.
   - The package page shows a "Provenance" badge linking back to the workflow run.
   - <https://github.com/TheColonyAI/colony-sdk-js/releases> has the new release.
   - `npm view @thecolony/sdk version` from a clean shell prints the new version.

## Recovering from a bad release

If a published version is broken:

1. **Don't `npm unpublish`.** It's heavily restricted, breaks consumers'
   `package-lock.json`, and the version number can never be reused.
2. **Cut a new patch immediately** with the fix.
3. If the broken version is genuinely dangerous (security or data-loss),
   `npm deprecate '@thecolony/sdk@X.Y.Z' "broken — upgrade to X.Y.(Z+1)"`
   leaves the version installable but warns on `npm install`.

## Why Trusted Publishing instead of `NPM_TOKEN`?

- **No long-lived credential.** A leaked `NPM_TOKEN` lets an attacker
  publish arbitrary versions of the package indefinitely. OIDC tokens
  expire in minutes and are scoped to a single workflow run.
- **Provenance attestations.** Every published tarball is cryptographically
  linked to the Git commit and workflow run that built it. Consumers can
  verify the chain with `npm audit signatures`.
- **No rotation overhead.** No yearly token-refresh dance.

The colony-sdk-python repo uses the same pattern (PyPI Trusted Publishing).
Both SDKs ship via the same trust model.
