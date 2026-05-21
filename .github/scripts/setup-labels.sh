#!/usr/bin/env bash
# Label bootstrap. Currently a no-op — the previous release:* labels were
# retired when the release flow moved from PR-label gating to manually
# dispatched workflows (release-patch.yml / release-minor.yml /
# release-major.yml). See CONTRIBUTING.md.
#
# Re-add `gh label create ... --force` calls here if you want to bootstrap
# other labels on a fresh clone.
#
# Usage:
#   gh auth login          # if you haven't already
#   bash .github/scripts/setup-labels.sh
#
# Requires the `gh` CLI: https://cli.github.com/
set -euo pipefail

if ! command -v gh >/dev/null 2>&1; then
  echo "error: gh CLI is required. Install from https://cli.github.com/" >&2
  exit 1
fi

echo "No labels to bootstrap."
