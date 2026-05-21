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

## Releasing

Releases are cut by a maintainer from the GitHub Actions tab. Pick the workflow that matches the impact of the changes being shipped:

- **Release (patch)** — `.github/workflows/release-patch.yml` — bug fixes, internal refactors, security fixes (`X.Y.Z` → `X.Y.(Z+1)`).
- **Release (minor)** — `.github/workflows/release-minor.yml` — new user-visible features, backwards-compatible (`X.Y.Z` → `X.(Y+1).0`).
- **Release (major)** — `.github/workflows/release-major.yml` — breaking changes, incompatible API/config/protocol changes (`X.Y.Z` → `(X+1).0.0`).

Each dispatcher reads the current version from root `package.json`, runs `scripts/bump-version.js` to sync the new version across the monorepo, commits the bump to `main` as `github-actions[bot]`, tags `v<new-version>`, pushes both, and then invokes `release.yml` to build the Windows installer and publish the GitHub Release.

If you need to release a specific version without auto-bumping (e.g. rebuilding an existing tag, or shipping a hotfix tagged locally), push a `v*` tag to `origin` and `release.yml` will fire on the tag push.

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
- WebPilot version (visible in the dashboard footer)
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
