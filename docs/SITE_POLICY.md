# Site Policy

Site policy is enforced on the server only, in `isAllowed(agentId, url)` (`site-policy.js:249-292`). The Chrome extension only executes commands and makes no policy decisions. The MCP gate that calls `isAllowed` lives in `mcp-handler.js`.

Citations are `file:line` relative to `packages/server-for-chrome-extension/src/` unless a full path is given.

## Precedence

| Tier | Table | Decisions | Applies when | `policySource` |
|---|---|---|---|---|
| 1. Agent rule | `agent_site_rules` | allow \| block | `agentId` is truthy. Named rows are walked from the most to the least specific suffix, then the agent's `*` row is checked (`site-policy.js:263-271`) | `agent_rule` |
| 2. Global user rule | `global_user_site_rules` | allow \| block | Global tier is on | `global_user` |
| 3. Signed global blocklist | `global_site_blocklist_rules` | block only | Global tier is on | `global_site_blocklist` |
| 4. Default | none | allow | Nothing above matched | `default` |

- The first match wins. Tier beats specificity, so a higher-tier rule wins over a more specific rule in a lower tier. Within the agent tier, a named rule beats that agent's `*` row whatever its decision.
- A caller without a valid key gets no agent tier. The popup always calls `isAllowed(null, …)` (`popup-routes.js:103`, `:158`).
- Return contract (`site-policy.js:47-52`): `{ allowed, decision, source, domain, matchedDomain }`. `matchedDomain` is the stored domain of the matching rule: `'*'` for a wildcard match and `null` for default.

## Domain matching

- **Normalization** (`normalizeDomain`, `site-policy.js:112-123`): the host is lowercased, and the scheme, port and a leading `www.` are removed. `https://www.chase.com/login` becomes `chase.com`.
- **Suffix walk** (`_suffixCandidates`, `site-policy.js:163-185`): the walk uses the public suffix list through `psl` and stops at the registrable domain. A rule on `chase.com` covers `secure.chase.com`. A rule on `secure.chase.com` covers only that host and its descendants.
- **IP literals, `localhost` and other dotless hosts**: `normalizeDomain` rejects these hosts. When the URL uses http, https, ws or wss, or has no scheme, only the agent's `*` row can match it (`site-policy.js:253-260`, `_networkHost` `:147-153`). Named rules and global tiers never match these hosts.
- **Non-network schemes** (`about:`, `chrome:`, `data:`, `file:`) are never managed by policy and are always allowed by default.
- A host that contains `*` never matches anything, including `*` rows (`site-policy.js:117`, `:151`).
- **`*` is per-agent only.** The global write path rejects it (`global-user-rules.js:20-29`), and the schema forbids it in both global tables (`db/schema.sql:49`, `:56`).

## Global tier toggle

- Stored in `config.global_tier_enabled`. A missing key means on, and a read error also means on. Only the values `'false'` and `'0'` turn it off (`isGlobalTierEnabled`, `site-policy.js:212-224`). Written by `setGlobalTierEnabled` (`site-policy.js:226-236`).
- Turning it off disables tiers 2 and 3 together (`site-policy.js:273`). Agent rules are unaffected. No rows are deleted.
- The updater keeps fetching and writing the signed tier while the toggle is off (`global-site-blocklist-updater.js:49-54`, `:498-504`), so the data is current as soon as the tier is re-enabled.
- Route: `POST /api/ui/sites/global-tier/toggle` (`server.js:1403-1419`) broadcasts `sites_changed` with reason `global_tier_toggle`.
- The popup disables its Block/Allow toggle while the tier is off (`packages/chrome-extension-unpacked/popup/popup.js:220`). A rule written to the popup route anyway is stored but has no effect until the tier is back on.

## Worked examples

Source: `packages/server-for-chrome-extension/test/site-policy.test.js:76-180`.

| Example | Setup | Agent | Result | Deciding tier |
|---|---|---|---|---|
| Coinbase (`:82-101`) | signed block + global user allow on `coinbase.com`; agent 2 has a block rule | 1 | allow | `global_user` |
| | | 2 | block | `agent_rule` |
| | | null | allow | `global_user` |
| Amex (`:103-124`) | signed block on `americanexpress.com`; agent 1 has an allow rule | 1 (also `www.`) | allow | `agent_rule` |
| | | 2, 3, null | block | `global_site_blocklist` |
| LinkedIn (`:126-163`) | toggle off; signed `linkedin.com`; agent 1 has `*` block and a `linkedin.com` allow | 1 → `linkedin.com`, `www.linkedin.com` | allow | `agent_rule` (named) |
| | | 1 → `example.com`, `chase.com`, `192.168.1.1`, `localhost:3000` | block | `agent_rule` (`*`) |
| | | 2 → `example.com` | allow | `default` |
| example.com (`:165-179`) | global user block on `example.com` | 1, toggle off | allow | `default` |
| | | 1, toggle on | block | `global_user` |

Invariants:
- Removing a global user rule restores the signed block immediately. No version bump or re-fetch is needed because the signed row was never touched (`test/site-policy.test.js:188-215`).
- Turning the toggle off disables both global tiers (`test/site-policy.test.js:217-231`).

## Where the gate runs

The gate `_enforceSitePolicy` (`mcp-handler.js:1412-1472`) runs after auth and before dispatch (`mcp-handler.js:928-935`).

- **Checkpoint A**: `browser_create_tab` is gated on `args.url` (`mcp-handler.js:1424-1438`). A blocked URL is never opened.
- **Checkpoint B**: tools in `TAB_ID_TOOLS` (`mcp-handler.js:14-22`) are gated on the tab's current URL, which is resolved through the extension's `get_tabs` command (`_resolveTabUrl`, `:1374-1394`). A block schedules `close_tab` after `AUTO_CLOSE_DELAY_MS` = 5000 ms (`:27`, `:1440-1467`).
- **Chains**: each `browser_request_chain` step goes through the gate again (`mcp-handler.js:2123-2138`). A blocked step returns the blocked response in place of its result, and the chain **continues** with the next step without throwing (`:2130-2161`). A blocked step that takes a `tab_id` still triggers the auto-close.

### Checked and exempt tools

| Tool | Checked? | How |
|---|---|---|
| `browser_create_tab` | yes | Checkpoint A |
| `browser_click`, `browser_type`, `browser_scroll`, `browser_get_accessibility_tree`, `browser_inject_script`, `browser_execute_js`, `webpilot_run_workflow` | yes | Checkpoint B |
| Each step inside `browser_request_chain` | yes | Gated again as its own tool |
| `browser_get_tabs`, `browser_close_tab`, the outer `browser_request_chain` call | no | Explicitly exempt (`mcp-handler.js:1414-1419`) |
| `request_pairing`, `check_pairing_status`, `webpilot_get_formatter_info`, `webpilot_reload_formatters`, `webpilot_dev_get_formatter_logs`, `webpilot_dev_reload_extension` | no | Not listed, so they fall through the gate (`mcp-handler.js:1469-1471`) |

A new tool that takes `tab_id` must be added to `TAB_ID_TOOLS`. If it is not, the gate skips it without any warning.

### Blocked response

Built by `_buildBlockedResponse` (`mcp-handler.js:1324-1340`) and returned with `isError: true`:

```json
{ "ok": false, "error": "site blocked by policy", "domain": "chase.com", "policySource": "global_site_blocklist" }
```

Checkpoint B adds `tabId`, `tabWillCloseAt` (an ISO timestamp) and `tabCloseInSeconds: 5`. Checkpoint A has none of these fields because the tab was never opened.

### Fail-open cases

This is current behavior, tracked in #100. In each case below, the call proceeds as if it were allowed:

| Case | Where |
|---|---|
| Any exception thrown by the gate | `mcp-handler.js:927-935` |
| Any exception thrown by the gate for a chain step | `mcp-handler.js:2136-2138` |
| Checkpoint A with a missing or empty `url` | `mcp-handler.js:1427` |
| Checkpoint B when `tab_id` is not a number | `mcp-handler.js:1443` |
| Checkpoint B when the extension is disconnected | `mcp-handler.js:1445-1449` |
| Checkpoint B when the tab URL can't be resolved (tab not found, or `get_tabs` failed) | `mcp-handler.js:1451` |

## Storage

All tables are in the shared SQLite DB, defined in `db/schema.sql`.

| Table / key | Defined at | Contents | Written by |
|---|---|---|---|
| `global_user_site_rules` | `schema.sql:48` | `domain` (no `*`), `decision`, timestamps | `global-user-rules.js`, which is the single path shared by the Sites page and the popup |
| `global_site_blocklist_rules` | `schema.sql:55` | `domain`, `created_at` (block only) | Only the blocklist updater (`_applySignedTier`) |
| `agent_site_rules` | `schema.sql:60` | `agent_id`, `domain` or `*`, `decision`; unique per (agent, domain) | `sitePolicy.setAgentRule` (`site-policy.js:393-407`) |
| `global_site_blocklist_meta` | `schema.sql:69` | Single row: `version`, `last_fetched_at`, `source_url`, `domain_count` | Only the blocklist updater |
| `site_policy_events` | `schema.sql:82-96` | Event log (see [Event log](#event-log)) | `site-policy-events.js` |
| `config.global_tier_enabled` | `site-policy.js:62` | `'true'` / `'false'` | `setGlobalTierEnabled` |

### Migrations

- **001**: renames the `baseline` identifiers to `global_site_blocklist` (config key, meta table, source literal, cache directory).
- **002**: splits `global_site_rules` into one table per tier. Wildcard rows and signed-allow rows are skipped. The config key is renamed to `global_tier_enabled`. If any user rows were migrated, the stored blocklist version gets a `pre-002:` prefix so that the next updater run re-syncs (`db/schema-migrations/002-split-site-rules-per-tier.js:156-162`).
- **003**: renames `agent_site_overrides` to `agent_site_rules` and rebuilds `site_policy_events` so its source CHECK uses `agent_rule`.

Runner and ledger details: [SCHEMA_MIGRATIONS.md](SCHEMA_MIGRATIONS.md#migration-history).

## Event log

Each site-policy check made for a known agent is recorded in `site_policy_events` by `site-policy-events.js`. This covers checkpoint A, checkpoint B and every `browser_request_chain` step.

- **One row per (agent, domain).** Only the checked domain is stored, never the full URL.
- **Repeat check**: increments `hit_count`, bumps `last_seen_at` and overwrites `decision` / `source` / `matched_domain` in place.
- **Decision flip** (allow ↔ block): the row is updated in place and `decision_changed_at` is set. No history rows are kept.
- **Allows are logged**, including default allows.
- **Retention**: rows older than 30 days are removed first, then the table is cut to the newest 5000 rows (`DEFAULT_MAX_AGE_DAYS` / `DEFAULT_MAX_ROWS`, `site-policy-events.js:31-32`; `cleanup`, `:148-181`).
- **Not recorded**:
  - checks with no agent or no domain (`_recordPolicyEvent`, `mcp-handler.js:1396-1400`), such as popup lookups or calls without a valid key;
  - non-network URLs (`chrome://`, `file://`, …), which resolve to a null domain;
  - checks the gate skipped (see [Fail-open cases](#fail-open-cases)).
- **IP literals and single-label hosts** such as `localhost` are stored under their raw lowercased host. Only the agent's `*` rule covers them, and the events API marks them `actionable: false` (`site-policy-events.js:265`).
- **Allow / Revoke actions** (`POST /api/ui/agents/:agentId/site-events/{allow,revoke}`) create per-agent rules for the exact domain. Revoke always writes `block` and never deletes (`site-policy-events-routes.js:79-117`).
- A failure to record is logged and never blocks or changes the tool call.

## Admin surfaces and live events

- **Sites page** (`/ui/sites/`): the main place to manage global user rules, per-agent rules, the global tier toggle and the event log.
- **Popup**: a single Block/Allow toggle that writes a global user rule for the current tab's domain. See [CHROME_EXTENSION.md](CHROME_EXTENSION.md#popup-ui).
- **REST routes**: see [MCP_SERVER.md](MCP_SERVER.md#site-policy-admin-endpoints).
- `/api/ui/status` includes `globalSiteBlocklist` (`server.js:583-589`), which is the updater's `getStatus()` result.

Live UI WebSocket events:

| Type | Reasons | Source |
|---|---|---|
| `sites_changed` | `global_rule_upsert`, `global_rule_delete`, `global_tier_toggle`, `agent_rule_upsert`, `agent_rule_delete` | `server.js:1227-1231` and callers |
| `sites_changed` | `site_event_allow`, `site_event_revoke` | `site-policy-events-routes.js:102` |
| `sites_changed` | `popup_toggle` | `popup-routes.js:163` |
| `site_policy_events_changed` | `created`, `decision_changed`, `verdict_changed`, `retention` | Bridge at `server.js:1885-1898`. A plain hit bump emits nothing (`site-policy-events.js:128-134`) |

## Signed global blocklist updater

`global-site-blocklist-updater.js`.

- **Not bundled.** The list is fetched from `https://raw.githubusercontent.com/Jtonna/WebPilot/main/global-site-blocklists` (`:68-69`). It always comes from `main`, whatever the release channel. Only `PUBKEY.pem` ships with the install (`packages/server-for-chrome-extension/package.json:21-28`, `packages/electron/electron-builder.yml:20-24`). The key file is `accessibility-tree-formatters/PUBKEY.pem`, and the same key verifies both the formatter and blocklist bundles.
- **Schedule**: runs 5 s after boot and then every 24 h (`server.js:1927-1937`). Formatters update hourly (`server.js:1913-1916`); the blocklist does not.
- **Cache**: `<dataDir>/global-site-blocklists/` (`:104-107`). The signature and every file hash are checked again each time the cache is read (`_readLocalCache`, `:150-208`).
- **Verifier**: `lib/manifest-verifier.js`. It looks for the pubkey in this order: `WEBPILOT_PUBKEY_PATH`, repo/snapshot-relative paths, `process.resourcesPath`, then the executable's directory (`_pubkeyCandidates`, `:64-84`). Fetches time out after 10 s (`:169`). It does not check the signed manifest's `kind` field (`parseSignedManifest`, `:142-162`).
- **Apply rule**: a manifest is applied when its version string **differs** from the stored one, not only when it is higher (`:463-469`).
- **Apply**: `_applySignedTier` (`:273-303`) deletes every row, inserts the new domains and upserts the meta row in one transaction.
- **Status**: `getStatus()` (`:532-555`) returns `{ enabled, version, lastFetchedAt, domainCount }`. `lastFetchedAt` is the time of the last **apply**, not the last check. `version` may read `pre-002:<v>` until the first successful sync after migration 002.

### Failure modes

| Condition | Result |
|---|---|
| Hash mismatch on a remote `manifest.json` or list file after the signature verified | The run is aborted and the DB is unchanged (`:361-363`, `:388-391`) |
| Signature failure, network error or missing list file | Falls back to the verified local cache (`:340-345`, `:416-432`) |
| Signed manifest returns 404, no usable cache, meta row exists | Skipped with `no-signed-manifest`; the DB is unchanged (`:441-443`) |
| No remote and no cache | An empty placeholder with version `'0'` is written, which **empties the signed tier** (`:445-454`). Current behavior, tracked in #101 |
| `signed-manifest.json` edited by hand | CI passes because it checks hashes only. Daemons reject the bundle at signature verification and keep what they have |

## Updating the blocklist

Files in `global-site-blocklists/`: `financial-institutions.txt`, `manifest.json`, `signed-manifest.json`, `signed-manifest.json.sig`.

Common steps:
1. Edit `financial-institutions.txt` (hosts.txt style: `0.0.0.0 domain`).
2. Bump `version` in `manifest.json`. This step is mandatory: if the version does not change, daemons log "already up to date" and skip the apply.

Constraints:
- **CI**: `check-signed-manifest.yml` runs on PRs and on pushes to `main` that touch `global-site-blocklists/**` (`.github/workflows/check-signed-manifest.yml:3-12`). It compares SHA-256 hashes only (`:51-75`) and does not verify the signature. `manifest.json` is itself hashed (`scripts/sign-formatters.js:135`).
- `scripts/sign-formatters.js` has **no keyless mode**. It aborts when the key file is missing (`:154-160`).

See also [CONTRIBUTING.md](../CONTRIBUTING.md#signing-and-updating-the-signed-bundles) and [CONTRIBUTING.md](../CONTRIBUTING.md#updating-the-global-site-blocklist).

### Procedure A: sign locally

1. Make the common edits above.
2. Run `node scripts/sign-formatters.js` with `WEBPILOT_SIGNING_KEY` pointing at the private key (default `~/.webpilot-signing-key`, `scripts/sign-formatters.js:41-46`). The script re-signs **both** bundles on every run (`:192-196`) and hashes files with LF line endings (`:69-73`).
3. Commit all four blocklist files (plus any formatter signed-manifest changes) and open the PR. `check-signed-manifest` passes.
4. After merge, each install picks up the new list at its next boot or within 24 h. No release is needed.

### Procedure B: merge unsigned and let release-stable re-sign

1. Make the common edits above and open the PR without re-signing.
2. `check-signed-manifest` **fails** with a hash mismatch on the PR, and fails again on `main` after merge. Merging requires overriding the red check.
3. Daemons reject the unsigned change with `manifest.json hash mismatch — refusing update` (`global-site-blocklist-updater.js:361-363`, `:389-390`) and keep the last good list.
4. `release-stable.yml` re-signs and commits the result to `main` (`.github/workflows/release-stable.yml:113-129`, `:158-166`). `release-nightly.yml` re-signs only inside the runner and never commits (`.github/workflows/release-nightly.yml:129-144`).
5. The list goes live within 24 h of the next **stable** release.

### Maintainer decision pending

`SECURITY.md:63` says the signing key "never lives on a developer machine that pushes to `main`". Procedure A needs the key on exactly that kind of machine. Procedure B keeps the key in CI, but it needs a failing-check override and ties every list change to a stable release. Maintainer decision pending; until decided, both procedures are documented.

## Known gaps and follow-ups

| Gap | Tracking |
|---|---|
| Fail-open cases in the gate | #100 |
| No remote and no cache writes an empty placeholder that empties the signed tier | #101 |
| Popup routes are not loopback-gated in network mode; `SECURITY.md:43` ("grants zero agent power") is stale | #110 |
| Stale `financial-institutions.txt` header (names `blocklist-updater.js`, uses "overrides" wording, has an unparsed `# version: 1`); stale code comments (`mcp-handler.js:1312-1315`, the updater header's "if newer", `global-user-rules.js:74-75`, `scripts/sign-formatters.js:23`, `popup.js:209`, storybook strings); `release-stable.yml:121` points to an old CONTRIBUTING heading | #112 |
| The verifier ignores the signed manifest's `kind`; CI checks hashes but not signatures | untracked |
