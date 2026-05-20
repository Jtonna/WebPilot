#!/usr/bin/env bash
# One-time bootstrap of the four release:* labels used by the PR validation
# and Release workflows. Re-running is safe — `gh label create --force`
# updates an existing label instead of failing.
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

echo "Creating/updating release:* labels..."

gh label create release:major \
  --color 'B60205' \
  --description 'Breaking change — incompatible API/config/protocol change.' \
  --force

gh label create release:minor \
  --color '0E8A16' \
  --description 'New user-visible feature, backwards-compatible.' \
  --force

gh label create release:patch \
  --color 'FBCA04' \
  --description 'Bug fix, refactor, or internal change.' \
  --force

gh label create release:none \
  --color 'C5DEF5' \
  --description 'Docs-only or repo-meta change. No release on merge.' \
  --force

echo
echo "Done. Labels are now available on PRs."
