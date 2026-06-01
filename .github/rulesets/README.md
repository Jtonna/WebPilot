# Branch Rulesets

This folder contains version-controlled JSON specs for GitHub branch rulesets applied to this repo.

Changes to rulesets go through code review here, then get applied via `gh api`.

---

## main.json

Enforces the following on the `main` branch:

- **Require pull request** — 1 approval required; stale reviews dismissed on push; last-push approval required; all threads must be resolved before merge
- **Allowed merge methods** — squash or rebase only (no merge commits)
- **Require linear history** — no merge commits in main history
- **Require signed commits** — all commits must be GPG/SSH signed
- **Block force pushes** (`non_fast_forward`)
- **Block deletions**
- **Required status checks** (must pass before merge):
  - `Build (windows)` — from `.github/workflows/pr.yml` (runs on every PR to main)
  - `check` — from `.github/workflows/check-starterpack.yml` (runs on every PR to main)

### Bypass actors

| Actor | Type | ID | Reason |
|-------|------|----|--------|
| Repository admin (Jtonna) | `RepositoryRole` | `5` | Hotfix access without ceremony |
| `github-actions[bot]` | `User` | `41898282` | `release-stable.yml` pushes version-bump commit directly to main |

> Note: The original spec called for `actor_type: "Integration"` with the GitHub Actions app ID (15368), but GitHub's API rejects that for personal (non-org) repos — the Integration actor type requires org-level app installation. Using `actor_type: "User"` with the bot's user ID (41898282) achieves the same result.

---

## Applying changes

### First time (create)

```sh
gh api -X POST repos/Jtonna/WebPilot/rulesets --input .github/rulesets/main.json
```

### Updates (edit existing ruleset)

Replace `<ID>` with the live ruleset ID listed below.

```sh
gh api -X PUT repos/Jtonna/WebPilot/rulesets/<ID> --input .github/rulesets/main.json
```

### List current rulesets

```sh
gh api repos/Jtonna/WebPilot/rulesets
```

---

## Live ruleset IDs

| Ruleset | ID |
|---------|-----|
| main | `17100757` |

Update command for `main`:

```sh
gh api -X PUT repos/Jtonna/WebPilot/rulesets/17100757 --input .github/rulesets/main.json
```
