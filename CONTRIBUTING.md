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

WebPilot ships two independently-fetched signed bundles: `accessibility-tree-formatters/` and `global-site-blocklists/`. Both are signed with the same Ed25519 key, and a single script — `scripts/sign-formatters.js` — (re-)signs **both** bundles every time it runs, whether or not you touched one of them. Do not assume that running the script only affects the bundle you edited; review the diff before committing.

|  | Formatters | Global site blocklist |
|---|---|---|
| Fetched from | Channel-aware ref (`main` in dev, the release tag in a built binary) — see [`docs/RELEASE.md`](docs/RELEASE.md) | Always `main`, regardless of channel |
| Refresh cadence | Boot + hourly | Boot + every 24h |
| Needs a release to reach users | Yes — see [`docs/RELEASE.md`](docs/RELEASE.md) | No — merging the signed commit to `main` is enough |

To stop a compromised maintainer GitHub account from pushing arbitrary JavaScript that gets executed inside every user's daemon process, both bundles are cryptographically signed and hash-verified before the daemon applies an update.

### Threat model

The daemon refuses to apply a formatter / blocklist update unless:

1. A `signed-manifest.json` is present alongside the regular `manifest.json` on the served branch/ref.
2. Its detached signature (`signed-manifest.json.sig`) verifies against the bundled `PUBKEY.pem` using Ed25519.
3. The SHA-256 of every downloaded file matches the hash recorded in the signed manifest.

The trust anchor (`PUBKEY.pem`) is committed to the repo AND bundled into the daemon binary via `pkg.assets` + Electron `extraResources`, so the verifier never has to fetch the pubkey from the network. Only `PUBKEY.pem` is bundled into the binary this way — the signed manifests themselves are not; they're fetched at runtime.

Verification failure is logged and the update is skipped. For formatters, the previously-installed formatters keep running. For the global site blocklist, the updater falls back to its local on-disk cache (re-verified before use). A hash mismatch after a valid signature aborts the run and leaves the DB unchanged. If neither a verified remote nor a verified cache is available, nothing is written: existing rows and the stored version are kept, and the next check retries. See [Failure modes](docs/SITE_POLICY.md#failure-modes).

CI's `check-signed-manifest.yml` guards against a stale-but-unsigned commit: on any PR or push to `main` touching either bundle, it recomputes the SHA-256 of every file listed in `signed-manifest.json` and compares it against the claimed hash. It does **not** verify the Ed25519 signature — only that the hashes are internally consistent with what's committed. Since `sign-formatters.js` re-signs both bundles on every run, commit the blocklist files you changed; include formatter signed-manifest changes only if the formatter sources changed too.

### Generating a signing key for local testing

```bash
node scripts/generate-signing-key.js
```

This produces:

- `~/.webpilot-signing-key` (PKCS#8 PEM, mode `0o600`) — keep private.
- `accessibility-tree-formatters/PUBKEY.pem` (SPKI PEM) — committed to the repo.

The script refuses to overwrite an existing private key — delete it explicitly if you really mean to rotate.

**Warning:** generating a test key overwrites the production `accessibility-tree-formatters/PUBKEY.pem`, and `sign-formatters.js` then re-signs both bundles with the test key. CI only compares hashes, so committing those files would pass CI and make every installed daemon reject every future update. Never commit them; restore with `git checkout -- accessibility-tree-formatters/PUBKEY.pem accessibility-tree-formatters/signed-manifest.json accessibility-tree-formatters/signed-manifest.json.sig global-site-blocklists/signed-manifest.json global-site-blocklists/signed-manifest.json.sig`.

To produce signed manifests locally:

```bash
node scripts/sign-formatters.js
```

That writes `signed-manifest.json` + `signed-manifest.json.sig` next to each top-level manifest. Idempotent — re-running with no file changes produces byte-identical output.

### Production signing

Production signing happens inside the release workflow. The signing key lives in the `WEBPILOT_SIGNING_KEY_BASE64` repo secret (Ed25519 PKCS#8 PEM, base64-encoded). `release-stable.yml` decodes it to a temp file with mode `0o600`, runs `scripts/sign-formatters.js`, and commits the regenerated `signed-manifest.json` + `.sig` files alongside the version bump before tagging and pushing. The signing step runs before the build leg so the signed manifest sources committed at the tagged ref match the formatter sources — only `PUBKEY.pem`, not the signed manifests themselves, is bundled into the binary.

### Updating the global site blocklist

Unlike formatters, updating the global site blocklist does not require cutting a release — the updater always fetches from `main`, so merging a properly-signed commit is enough for it to reach users on their next update tick. In short (Procedure A, sign locally):

1. Edit `global-site-blocklists/financial-institutions.txt`.
2. Bump `version` in `global-site-blocklists/manifest.json` — **mandatory**; the updater only applies a fetched bundle when its version differs from what's already stored.
3. Run `node scripts/sign-formatters.js` with `WEBPILOT_SIGNING_KEY` set to your local private key path.
4. Commit all four files (`financial-institutions.txt`, `manifest.json`, `signed-manifest.json`, `signed-manifest.json.sig`) together.

Alternatively (Procedure B), merge the edits unsigned. `check-signed-manifest` then fails on the PR and on `main`, and daemons keep the last good list, until `release-stable.yml` re-signs and commits. The list goes live within 24 h of the next stable release. Nightly re-signs only inside the runner. See [Procedure B](docs/SITE_POLICY.md#procedure-b-merge-unsigned-and-let-release-stable-re-sign).

See [docs/SITE_POLICY.md#updating-the-blocklist](docs/SITE_POLICY.md#updating-the-blocklist) for the full procedure, including the two supported signing workflows.

There is an open question about where the signing key may live; see [Maintainer decision pending](docs/SITE_POLICY.md#maintainer-decision-pending).

### Key rotation

When the signing key needs to be rotated (founder turnover, suspected compromise, scheduled hygiene):

1. On a clean workstation, delete `~/.webpilot-signing-key` and run `node scripts/generate-signing-key.js`.
2. Base64-encode the new private key and update the `WEBPILOT_SIGNING_KEY_BASE64` repo secret in **Settings → Secrets and variables → Actions**.
3. Commit the regenerated `accessibility-tree-formatters/PUBKEY.pem`.
4. Run `.github/workflows/release-stable.yml` from **Actions → Release (stable) → Run workflow**. The next daemon update tick fetches the new signed manifest, verifies it against the new bundled pubkey, and applies it normally.

Old released installers continue to verify against the *old* pubkey they shipped with — the rotation does not invalidate previously installed daemons until they receive a new installer that ships the new pubkey. Plan rotation to coincide with a normal release.

Exception: the global blocklist is fetched from `main`, so installs that still have the old public key stop receiving blocklist updates (they keep their last verified list) until they install a release that ships the new key.

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
