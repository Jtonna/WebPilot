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

## Signing formatter releases

WebPilot daemons fetch formatter and global-site-blocklist updates from this repo at runtime. To stop a compromised maintainer GitHub account from pushing arbitrary JavaScript that gets executed inside every user's daemon process, every release ships a cryptographically signed manifest.

### Threat model

The daemon refuses to apply a formatter / blocklist update unless:

1. A `signed-manifest.json` is present alongside the regular `manifest.json` on the served branch.
2. Its detached signature (`signed-manifest.json.sig`) verifies against the bundled `PUBKEY.pem` using Ed25519.
3. The SHA-256 of every downloaded file matches the hash recorded in the signed manifest.

The trust anchor (`PUBKEY.pem`) is committed to the repo AND bundled into the daemon binary via `pkg.assets` + Electron `extraResources`, so the verifier never has to fetch the pubkey from the network.

Verification failure is logged and the update is skipped; the previously-installed formatters keep running.

### Generating a signing key for local testing

```bash
node scripts/generate-signing-key.js
```

This produces:

- `~/.webpilot-signing-key` (PKCS#8 PEM, mode `0o600`) — keep private.
- `accessibility-tree-formatters/PUBKEY.pem` (SPKI PEM) — committed to the repo.

The script refuses to overwrite an existing private key — delete it explicitly if you really mean to rotate.

To produce signed manifests locally:

```bash
node scripts/sign-formatters.js
```

That writes `signed-manifest.json` + `signed-manifest.json.sig` next to each top-level manifest. Idempotent — re-running with no file changes produces byte-identical output.

### Production signing

Production signing happens inside the release workflow. The signing key lives in the `WEBPILOT_SIGNING_KEY_BASE64` repo secret (Ed25519 PKCS#8 PEM, base64-encoded). `release-stable.yml` decodes it to a temp file with mode `0o600`, runs `scripts/sign-formatters.js`, and commits the regenerated `signed-manifest.json` + `.sig` files alongside the version bump before tagging and pushing. The signing step runs before the build leg so the signed manifests bundled into the binary match the formatter sources at the tagged ref.

### Key rotation

When the signing key needs to be rotated (founder turnover, suspected compromise, scheduled hygiene):

1. On a clean workstation, delete `~/.webpilot-signing-key` and run `node scripts/generate-signing-key.js`.
2. Base64-encode the new private key and update the `WEBPILOT_SIGNING_KEY_BASE64` repo secret in **Settings → Secrets and variables → Actions**.
3. Commit the regenerated `accessibility-tree-formatters/PUBKEY.pem`.
4. Cut a new release via one of the dispatcher workflows. The next daemon update tick will fetch the new signed manifest, verify it against the new bundled pubkey, and apply normally.

Old released installers continue to verify against the *old* pubkey they shipped with — the rotation does not invalidate previously installed daemons until they receive a new installer that ships the new pubkey. Plan rotation to coincide with a normal release.

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
