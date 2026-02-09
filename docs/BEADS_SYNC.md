# Beads → GitHub Sync

WebPilot uses [beads](https://github.com/steveyegge/beads), a git-backed issue tracker, to manage work items locally. Issues live in `.beads/issues.jsonl` and are automatically synced to GitHub Issues and the GitHub Projects kanban board when merged to `main`.

## How It Works

1. **Work locally** -- create and update beads tickets while developing on a feature branch.
2. **Commit together** -- beads issue changes are committed alongside code changes.
3. **Merge to main** -- when the PR merges, the GitHub Action triggers.
4. **Sync runs** -- the action reads `issues.jsonl`, creates or updates GitHub Issues, and moves cards on the Project board.

This is a **one-way sync** (beads → GitHub). The local `.beads/issues.jsonl` is the source of truth.

## File Layout

```
.beads/
  metadata.json       # Project prefix ("wp") and config
  issues.jsonl        # All beads issues (one JSON object per line)

.github/
  scripts/
    beads-sync.sh     # Sync script (reads JSONL, calls gh CLI)
  workflows/
    beads-sync.yml    # GitHub Action that runs the sync on push to main
```

## Status Mapping

| Beads Status | Project Column |
|---|---|
| `open`, `pending` | Todo |
| `in_progress`, `hooked` | In Progress |
| `blocked` | Blocked |
| `closed`, `completed` | Done |

## Setup

Works out of the box for GitHub Issues (no config needed). For Project board sync, create a GitHub Project, add a Status field with options `Todo` / `In Progress` / `Blocked` / `Done`, then set `PROJECT_NUMBER` in `.github/workflows/beads-sync.yml`.
