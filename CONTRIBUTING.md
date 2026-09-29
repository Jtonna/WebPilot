# Contributing to WebPilot

Thanks for your interest in WebPilot! This document covers how to set up a dev environment, the PR workflow, and the release process.

## Getting started

Requires Node 22+ and a local Chrome install (any channel).

```bash
git clone https://github.com/Jtonna/WebPilot.git
cd WebPilot
npm install
npm run dev
```

`npm run dev` runs the MCP server and the Next.js web UI concurrently. The web UI has HMR; the server does not auto-reload — restart it after editing server code. The dashboard is at <http://localhost:3456/ui/>.

To exercise the Chrome side, load `packages/chrome-extension-unpacked/` as an unpacked extension in `chrome://extensions` for at least one Chrome profile.

Build the installer locally:

```bash
npm run dist:win    # or :mac / :linux
```

See [`docs/INDEX.md`](docs/INDEX.md) for the full architecture index and [`docs/ADDING_NEW_FEATURES.md`](docs/ADDING_NEW_FEATURES.md) for step-by-step guides on adding MCP tools, extension handlers, and site formatters.

## Pull request workflow

1. **Branch from `main`.** Use a descriptive branch name (e.g. `fix/popup-localhost-pill`, `feat/site-rules-export`).
2. **Open a PR against `main`.** The CI build must pass before merge — it builds the Electron installer on Windows.
3. **Write a clear PR description.** Explain the *why* — the *what* is in the diff. Link any related issues.

Merging a PR does **not** trigger a release. Releases are cut manually from the Actions tab when a maintainer decides a batch of merged PRs is ready to ship.

## Comment style

Comments document **what** a thing is and **how** it works, with the **occasional why** for non-obvious decisions, hidden constraints, or workarounds. The git log carries history; the code carries the present.

Keep:

- Module-level docstrings that explain a file's purpose and how it fits the system.
- *Why*-comments for surprising choices (e.g. `Sleep 800ms — Windows needs this before file ops or RMDir fails when daemon still has handles`).
- Algorithm walkthroughs where the names alone aren't enough.
- TODOs that point at real outstanding work, with enough context to act on them.

Drop:

- Phase / wave / cycle labels (`P2 — phase 1`, `Phase 6`, `Wave B`, `QOL review C1`). The phases are gone, the lifecycle docs that named them are gone, and the labels are illegible to anyone reading the file today.
- References to deleted docs (`see EXTENSION_REDESIGN_AND_POLICY.md`, `per SECURITY_AUDIT_2026-05-17.md`).
- Commit / PR archaeology (`added in 1.1.4`, `per founder review on 2026-04-X`).
- Narration of code that's obvious from the names (`// Increment count` over `count++`).
- Multi-paragraph "history of this function" blocks. Compress to a single paragraph of what + how + occasional why.

When you delete a lore-laden comment, salvage anything that's actually useful and restate it in plain prose. If you're not sure whether something is lore or load-bearing context, leave it for review — better a flagged keep than a wrong delete.

## Releasing

Releases are cut by a maintainer from the GitHub Actions tab via **Release (stable)** (`.github/workflows/release-stable.yml`). The workflow takes a `bump` input:

- `patch` — bug fixes, internal refactors, security fixes (`X.Y.Z` → `X.Y.(Z+1)`).
- `minor` — new user-visible features, backwards-compatible (`X.Y.Z` → `X.(Y+1).0`).
- `major` — breaking changes, incompatible API/config/protocol changes (`X.Y.Z` → `(X+1).0.0`).

The workflow reads the current version from root `package.json`, runs `scripts/bump-version.js` to sync the new version across the monorepo, signs the formatter + blocklist manifests, writes `release-info.json`, builds the Windows installer, commits the version bump to `main` as `github-actions[bot]`, creates and pushes an annotated `v<new-version>` tag, generates categorised release notes, and publishes the GitHub Release.

## Signing and updating the signed bundles

WebPilot ships two signed bundles: `accessibility-tree-formatters/` and `global-site-blocklists/`. Both use the same Ed25519 key. Review the diff before committing: `scripts/sign-formatters.js` re-signs both bundles on every run, even if you only edited one.

|  | Formatters | Global site blocklist |
|---|---|---|
| Fetched from | Channel-aware ref (`main` in dev, the release tag in a built binary; see [`docs/RELEASE.md`](docs/RELEASE.md)) | Always `main`, regardless of channel |
| Refresh cadence | Boot + hourly | 5s after boot, then every 24h |
| Needs a release to reach users | Yes (see [`docs/RELEASE.md`](docs/RELEASE.md)) | No, merging the signed commit to `main` is enough |

Both bundles are signed and hash-verified before the daemon applies an update. This stops a compromised maintainer GitHub account from pushing arbitrary JavaScript into every user's daemon process.

### Threat model

The daemon refuses to apply a formatter / blocklist update unless:

1. A `signed-manifest.json` is present alongside the regular `manifest.json` on the served branch/ref.
2. Its detached signature (`signed-manifest.json.sig`) verifies against the bundled `PUBKEY.pem` using Ed25519.
3. The SHA-256 of every downloaded file matches the hash recorded in the signed manifest.

The trust anchor (`PUBKEY.pem`) is committed to the repo and bundled into the daemon binary via `pkg.assets` + Electron `extraResources`, so the verifier never fetches it over the network. Signed manifests are not bundled; they're fetched at runtime.

Verification failure is logged and the update is skipped:
- Formatters: existing ones keep running.
- Global site blocklist: fallback to the cached copy (verified before use).

A hash mismatch after a valid signature aborts and leaves the DB unchanged. If no verified remote or cache exists, nothing is written: existing data and version persist, and the next check retries. See [Failure modes](docs/SITE_POLICY.md#failure-modes).

CI's `check-signed-manifest.yml` verifies hash consistency: on any PR or push to `main` touching either bundle, it recalculates SHA-256 for every file in `signed-manifest.json` and compares against the committed hash. It does **not** verify the Ed25519 signature, only that hashes match. Because `sign-formatters.js` re-signs both bundles on every run, commit changed blocklist files. Include formatter `signed-manifest.json` changes only when formatter sources changed.

### Generating a signing key for local testing

```bash
node scripts/generate-signing-key.js
```

This produces:

- `~/.webpilot-signing-key` (PKCS#8 PEM, mode `0o600`) — keep private.
- `accessibility-tree-formatters/PUBKEY.pem` (SPKI PEM) — committed to the repo.

The script refuses to overwrite an existing private key — delete it explicitly if you really mean to rotate.

**Warning:** do not commit after running this locally. Generating a test key overwrites `accessibility-tree-formatters/PUBKEY.pem` and re-signs both bundles with it. CI only compares hashes, so committing would pass CI but block all daemon updates. Restore with: `git checkout -- accessibility-tree-formatters/PUBKEY.pem accessibility-tree-formatters/signed-manifest.json accessibility-tree-formatters/signed-manifest.json.sig global-site-blocklists/signed-manifest.json global-site-blocklists/signed-manifest.json.sig`.

To produce signed manifests locally:

```bash
node scripts/sign-formatters.js
```

That writes `signed-manifest.json` + `signed-manifest.json.sig` next to each top-level manifest. Idempotent — re-running with no file changes produces byte-identical output.

### Production signing

Production signing in the release workflow: the signing key lives in `WEBPILOT_SIGNING_KEY_BASE64` (Ed25519 PKCS#8 PEM, base64-encoded). `release-stable.yml` decodes it to a temp file (mode `0o600`), runs `scripts/sign-formatters.js`, and commits regenerated `signed-manifest.json` + `.sig` files alongside the version bump before tagging and pushing. Signing runs before the build so manifests at the tagged ref match formatter sources.

### Updating the global site blocklist

Unlike formatters, blocklist updates don't require a release: the updater always fetches from `main`. Merge a signed commit and it reaches users at the next update tick.

**Procedure A (sign locally):**

1. Edit `global-site-blocklists/financial-institutions.txt`.
2. Bump `version` in `global-site-blocklists/manifest.json` (required; the updater applies bundles only when the version changes).
3. Run `node scripts/sign-formatters.js` with `WEBPILOT_SIGNING_KEY` set to your local private key path.
4. Commit all four files together: `financial-institutions.txt`, `manifest.json`, `signed-manifest.json`, `signed-manifest.json.sig`.

**Procedure B (merge unsigned):**

`check-signed-manifest` fails on the PR and `main`. Daemons keep the last good list until `release-stable.yml` re-signs and commits. The list goes live within 24h of the next stable release. Nightly signing runs only inside the runner. See [Procedure B](docs/SITE_POLICY.md#procedure-b-merge-unsigned-and-let-release-stable-re-sign).

See [docs/SITE_POLICY.md#updating-the-blocklist](docs/SITE_POLICY.md#updating-the-blocklist) for the full procedure, including the two supported signing workflows.

An open question exists about where the signing key may live: see [Maintainer decision pending](docs/SITE_POLICY.md#maintainer-decision-pending).

### Key rotation

When the signing key needs to be rotated (founder turnover, suspected compromise, scheduled hygiene):

1. On a clean workstation, delete `~/.webpilot-signing-key` and run `node scripts/generate-signing-key.js`.
2. Base64-encode the new private key and update the `WEBPILOT_SIGNING_KEY_BASE64` repo secret in **Settings → Secrets and variables → Actions**.
3. Commit the regenerated `accessibility-tree-formatters/PUBKEY.pem`.
4. Run `.github/workflows/release-stable.yml` from **Actions → Release (stable) → Run workflow**. The next daemon update tick fetches the new signed manifest, verifies it against the new bundled pubkey, and applies it normally.

Old released installers continue to verify against the *old* pubkey they shipped with — the rotation does not invalidate previously installed daemons until they receive a new installer that ships the new pubkey. Plan rotation to coincide with a normal release.

Exception: the global blocklist is fetched from `main`, so older installs with the old key stop receiving updates (they keep the last verified list) until they install a release shipping the new key.

### Reporting a compromised signing key

See [`SECURITY.md`](SECURITY.md) — `[WebPilot security]` to `jtonna@proton.me` or a private GitHub advisory.

## Commit messages

A loose conventional-commits style is preferred but not enforced:

- `feat(scope): short summary` — new feature
- `fix(scope): short summary` — bug fix
- `docs(scope): ...`, `refactor(scope): ...`, `chore(scope): ...`

The release type (patch / minor / major) is decided at release time by the maintainer dispatching the workflow — commit prefixes are advisory.

## Code style

- No formatter is enforced today. Match the surrounding code.
- Default to writing no comments. Only comment when *why* is non-obvious (a hidden constraint, a subtle invariant, a workaround for a specific bug). Don't explain *what* — well-named identifiers do that.
- Don't add features, abstractions, or error handling beyond what the task requires. Trust internal code; only validate at system boundaries.
- For UI changes, run `npm run dev` and exercise the change in a browser before opening the PR.

## Reporting bugs

Open a [GitHub issue](https://github.com/Jtonna/WebPilot/issues) using the **Bug report** template. Include:

- Platform + OS version (`win11`, `macOS 14.5`, `Ubuntu 24.04`, etc.)
- Chrome channel + version
- WebPilot version (visible at Settings → General → About in the dashboard)
- Steps to reproduce
- Expected vs. actual behavior
- Relevant log output. Default locations:
  - Windows: `%APPDATA%\@webpilot\onboarding\logs\server.log`
  - macOS: `~/Library/Application Support/WebPilot/logs/server.log`
  - Linux: `${XDG_CONFIG_HOME:-~/.config}/WebPilot/logs/server.log`

## Security

Security issues should NOT be reported in public GitHub issues. See [`SECURITY.md`](SECURITY.md) for the disclosure process.

## Code of Conduct

By participating you agree to abide by the [Code of Conduct](CODE_OF_CONDUCT.md).

## Questions?

Open a [Discussion](https://github.com/Jtonna/WebPilot/discussions) for anything that isn't a bug or a feature request.
