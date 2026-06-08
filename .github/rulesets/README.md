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
| Repository admin (Jtonna) | `RepositoryRole` | `5` | Hotfix access without ceremony; also the mechanism release workflows use (see below) |

### How the release workflows push to main

`release-stable.yml` and `release-nightly.yml` push version-bump commits and tags directly to `main`. The default `GITHUB_TOKEN` authenticates the workflow as the GitHub Actions Integration (app id `15368`), which the ruleset cannot list as a bypass actor on personal (non-org) repos — `actor_type: "Integration"` is rejected by the API for these repos.

Both workflows check out using a fine-grained personal access token stored as the `RELEASE_PAT` repo secret. The PAT belongs to the admin user, whose `RepositoryRole` (id `5`) is in `bypass_actors`. Pushes from the workflow authenticate as that user, so the ruleset bypass applies.

The PAT needs:
- Repository access: this repo only (`Jtonna/WebPilot`).
- Permissions: `Contents: Read and write`.
- Expiry: set per your rotation cadence; 90 days is a common floor.

When the PAT expires or rotates, replace the secret value at **Settings → Secrets and variables → Actions → `RELEASE_PAT`**.

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
