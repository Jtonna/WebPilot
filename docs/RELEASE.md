# WebPilot Release Guide

This document explains the two release channels, how to trigger each workflow,
and how channel-aware formatter publishing works under the hood.

---

## Release Channels

### Stable

Stable releases are versioned `vX.Y.Z` and are intended for production use.

- Triggered manually from **Actions → Release (stable)**.
- Input: `bump` — `patch`, `minor`, or `major`.
- The workflow computes the new version, commits the version bump to `main`,
  creates an annotated tag, builds the Windows installer, and publishes a
  non-prerelease GitHub Release.
- Artifact: `WebPilot-X.Y.Z-windows.exe`.

### Nightly

Nightly releases are versioned `vX.Y.Z-nightly.YYYYMMDD[.N]` and are intended
for testing unreleased features. Not for production use.

- Triggered manually from **Actions → Release (nightly)**.
- Optional input: `base_version` (override the base semver `X.Y.Z`). If left
  empty, the workflow auto-computes it by finding the latest `vX.Y.Z` stable
  tag and patch-bumping it.
- The version bump is applied **in-memory only** (no commit). The annotated tag
  points at the unmodified source SHA.
- If another nightly already ran on the same calendar day, a `.N` suffix is
  appended (e.g., `v2.0.4-nightly.20260530.2`).
- Published as a prerelease GitHub Release.
- Artifact: `WebPilot-X.Y.Z-nightly.YYYYMMDD[.N]-windows.exe`.

---

## Triggering a Release

Both workflows are triggered via **Actions → workflow → Run workflow** in the
GitHub UI. They require no local setup.

### Stable

1. Go to **Actions → Release (stable)**.
2. Click **Run workflow**.
3. Choose `bump` (patch / minor / major).
4. Click **Run workflow**.

The workflow will:
- Compute and validate the new version.
- Sync all `package.json` / `manifest.json` / lockfiles via `scripts/bump-version.js`.
- Re-sign formatter + blocklist manifests with the `WEBPILOT_SIGNING_KEY_BASE64` secret.
- Write `packages/server-for-chrome-extension/release-info.json`.
- Build the Windows installer (`npm run dist:win`).
- Commit the bump + release-info.json to `main`.
- Push the annotated tag.
- Publish a non-prerelease GitHub Release with categorised release notes.

### Nightly

1. Go to **Actions → Release (nightly)**.
2. Click **Run workflow**.
3. Optionally fill in `base_version` (e.g., `2.1.0`). Leave empty for auto.
4. Click **Run workflow**.

The workflow will:
- Compute the nightly version string.
- Bump version in-memory (not committed).
- Re-sign manifests (soft-fail if secret absent — ships whatever is on HEAD).
- Write `release-info.json` in-memory (not committed).
- Build the Windows installer.
- Tag the unmodified source SHA and push.
- Publish a prerelease GitHub Release.

---

## Channel-Aware Formatter Auto-Update

### How It Works

Each installed WebPilot binary embeds a `release-info.json` file (bundled via
`@yao-pkg/pkg` assets) written by the CI build step:

```json
{
  "ref": "v2.0.4",
  "channel": "stable",
  "version": "2.0.4",
  "builtAt": "2026-05-30T12:00:00.000Z"
}
```

On startup, `packages/server-for-chrome-extension/src/formatter-updater.js`
reads this file and constructs the GitHub raw content base URL used for
formatter manifest fetches:

```
https://raw.githubusercontent.com/Jtonna/WebPilot/<ref>/accessibility-tree-formatters
```

For a stable build (`ref = "v2.0.4"`), formatters are fetched from the
`v2.0.4` tag — they are frozen at that stable release.

For a nightly build (`ref = "v2.0.4-nightly.20260530"`), formatters are
fetched from the nightly tag — frozen at the nightly snapshot.

### Fallback Behaviour

If `release-info.json` is absent or contains malformed JSON, the updater
logs a one-line warning and falls back to `main`:

```
[formatter-updater] release-info.json missing or malformed — falling back to main
```

This covers:
- **Development checkouts** — the file is never written in dev mode.
- **Legacy builds** — binaries built before this feature shipped do not have
  the file and continue fetching from `main` without breakage.
- **Parse errors** — any JSON corruption falls back safely.

ENOENT (file absent) is silent — it is the expected state in development and
is not a warning-worthy condition.

### Supply-Chain Integrity

The formatter auto-updater does not blindly trust remote content. Every update
is gated on an Ed25519 signature check:

1. The CI `sign-formatters.js` step signs the formatter bundle at release time,
   producing `signed-manifest.json` + `.sig`.
2. The updater fetches these at runtime and verifies the signature against the
   `PUBKEY.pem` bundled in the binary.
3. Only files whose SHA-256 hashes are listed in the verified signed manifest
   are written to disk.

See `SECURITY.md` and `CONTRIBUTING.md` for the full threat model.

---

## Backwards Compatibility

Builds predating this feature (before issue #67) do not include
`release-info.json`. They fall back to fetching formatters from `main` — the
same behaviour as before. No user action is required on existing installs.

---

## Required Secrets

| Secret | Required for | Description |
|--------|-------------|-------------|
| `WEBPILOT_SIGNING_KEY_BASE64` | Stable (hard-fail), Nightly (soft-skip) | Base64-encoded Ed25519 private key for signing formatter manifests. |
| `GITHUB_TOKEN` | Both | Automatically provided by GitHub Actions. |

See `CONTRIBUTING.md > Signing formatter releases` for key generation instructions.
