# Contributing to WebPilot

Thanks for your interest in WebPilot! This document covers how to set up a dev environment, the PR workflow, and the release process.

## Getting started

Requires Node 20+ and a local Chrome install (any channel).

```bash
git clone https://github.com/Jtonna/WebPilot.git
cd WebPilot
npm install
npm run dev
```

`npm run dev` runs the MCP server (with `node --watch` hot-reload) and the Next.js web UI concurrently. The dashboard is at <http://localhost:3456/ui/>.

To exercise the Chrome side, load `packages/chrome-extension-unpacked/` as an unpacked extension in `chrome://extensions` for at least one Chrome profile.

Build the installer locally:

```bash
npm run dist:win    # or :mac / :linux
```

See [`docs/INDEX.md`](docs/INDEX.md) for the full architecture index and [`docs/ADDING_NEW_FEATURES.md`](docs/ADDING_NEW_FEATURES.md) for step-by-step guides on adding MCP tools, extension handlers, and site formatters.

## Pull request workflow

1. **Branch from `main`.** Use a descriptive branch name (e.g. `fix/popup-localhost-pill`, `feat/site-rules-export`).
2. **Open a PR against `main`.** The CI build must pass before merge — it builds the Electron installer on Windows, macOS, and Linux.
3. **Add a `release:*` label.** Exactly one of:
   - `release:major` — breaking changes (incompatible API/config/protocol changes).
   - `release:minor` — new user-visible features, backwards-compatible.
   - `release:patch` — bug fixes, internal refactors, security fixes.
   - `release:none` — docs-only or repo-meta changes that should not trigger a release.

   **PRs without a `release:*` label cannot be merged.** The version-bump workflow reads this label on merge to decide whether to tag a new release.
4. **Write a clear PR description.** Explain the *why* — the *what* is in the diff. Link any related issues.

### What happens on merge

On every merge to `main`:

1. A GitHub Action reads the merged PR's `release:*` label.
2. If `release:none`: nothing else happens.
3. Otherwise: it bumps the version in `package.json` per the label, commits the bump, tags `v<new-version>`, and pushes the tag.
4. The tag push triggers `release.yml`, which builds Win/Mac/Linux installers in parallel and publishes them to a GitHub Release.

## Commit messages

A loose conventional-commits style is preferred but not enforced:

- `feat(scope): short summary` — new feature
- `fix(scope): short summary` — bug fix
- `docs(scope): ...`, `refactor(scope): ...`, `chore(scope): ...`

The `release:*` PR label is the source of truth for versioning — commit prefixes are advisory.

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
- Relevant log output (`%LOCALAPPDATA%\WebPilot\logs\server.log` on Windows; equivalent paths on macOS/Linux)

## Security

Security issues should NOT be reported in public GitHub issues. See [`SECURITY.md`](SECURITY.md) for the disclosure process.

## Code of Conduct

By participating you agree to abide by the [Code of Conduct](CODE_OF_CONDUCT.md).

## Questions?

Open a [Discussion](https://github.com/Jtonna/WebPilot/discussions) for anything that isn't a bug or a feature request.
