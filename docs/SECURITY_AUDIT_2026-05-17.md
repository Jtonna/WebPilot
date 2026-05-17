# WebPilot Security Audit — Auth & Authorization Model

Author: design review pass, 2026-05-17.
Scope: server↔extension transport, MCP tool-call auth, popup endpoints, web-UI admin endpoints.
Status: design document. **Implementation status: Phases A + B + D shipped as a single hard cutover on `QOL-Features` (2026-05-17). Phase C was dropped per user — the architectural goal (extension as identity, agents as power layer) is achieved without auto-provisioning per-profile paired keys; the popup operates in profile-context using installId rather than minting a synthetic agent per profile.** See the commit body for the threat-model summary and the wire-protocol changes.

---

## 0. TL;DR

WebPilot today has three independent credentials with overlapping jobs and one
of them — the "server-wide transport key" — is doing too much. It is handed
out unauthenticated to anyone who can reach `GET /connect`, it is shared by
every extension install on the same server, and after commit `7dc391d` it also
authenticates the popup admin endpoints when no paired agent is available.
Compromise of *one* Chrome profile's `chrome.storage.local` today yields full
WS-driven browser control over *every* paired profile on that server.

The user's stated mental model is the right one: **installId is the
per-profile identity, the server is the policy decision point, and the
extension is a thin client.** Today's code only partially matches that model —
installId is used for telemetry / WS-bind resolution but not as a
credential, and the shared transport key is doing both the "identify yourself"
job and the "authenticate" job, poorly.

The recommendation is a four-phase migration to a per-profile paired-agent
key minted automatically on first connect via installId, retiring the shared
transport key entirely. Phase A (retire the popup-auth transport-key
fallback) is a small follow-up to the architectural fix; the architectural
work lives in Phase B–D.

---

## 1. Today's auth model

### 1.1 The three credentials

| # | Name | Lifetime / Storage | Issued by | What it unlocks |
|---|------|--------------------|-----------|-----------------|
| 1 | **Server-wide transport key** (`apiKey`) | server.json (or env, or `'dev-123-test'` default) on the server; mirrored into every extension's `chrome.storage.local.apiKey` | Read on every server boot in `index.js:49` via `getApiKey()`; handed out via `GET /connect` to anyone | Extension WS handshake (`?apiKey=…` on upgrade); after `7dc391d`, also popup endpoints (`/api/popup/state`, `/api/popup/site-toggle`) when no paired agent matches. NOT a valid `X-API-Key` for MCP `tools/call`. |
| 2 | **Paired-agent key** | `agents.api_key_hash` in SQLite (HMAC-SHA-256 with server-side pepper); plaintext returned to the agent once at issue time | `pairedKeys.addKey()` / `approvePairing()` / `createPairedAgent()` | All `tools/call` MCP requests when `pairing_required` is true; popup endpoints; per-agent profile routing via `agents.profile_id` |
| 3 | **InstallId** | `webpilot.installId` in extension's `chrome.storage.local`; mirrored server-side in `extension_installs.install_id → profile_id` | Extension: `crypto.randomUUID()` in `ensureInstallId()` at install time | Nothing today as a credential. Used only as a hint to resolve `installId → profileId` during the WS `hello` handshake (`server.js:1581`). |

### 1.2 Where they live in code

**Server-wide transport key**
- Default + lookup: `packages/server-for-chrome-extension/src/service/paths.js:11` (`DEFAULT_API_KEY = 'dev-123-test'`), `paths.js:101` (`getApiKey()` reads `config.apiKey || env.API_KEY || DEFAULT_API_KEY`).
- Loaded at server boot: `packages/server-for-chrome-extension/index.js:49` (`const API_KEY = getApiKey()`) → passed to `createServer({ apiKey })` at `index.js:107`.
- Closed over by `createServer`: `packages/server-for-chrome-extension/src/server.js:1429`.
- WS handshake compare: `server.js:1505-1510` (`pairedKeys.constantTimeEqual(clientApiKey, apiKey)`).
- Popup-auth fallback: `server.js:2033` (`if (pairedKeys.constantTimeEqual(key, apiKey)) return { key, entry: null, agentId: null }`).
- Handed out at `GET /connect`: `server.js:2185-2192`.

**Paired-agent keys**
- Storage & hashing: `packages/server-for-chrome-extension/src/paired-keys.js:76-106` (`getOrCreateApiKeyPepper`, `hashApiKey`). HMAC-SHA-256 with a 32-byte random pepper persisted in `config.api_key_pepper`.
- Insert: `paired-keys.js:276-291` (`addKey`).
- Validate: `paired-keys.js:325-329` (`validateKey`).
- MCP gate: `packages/server-for-chrome-extension/src/mcp-handler.js:685-713`. The auth-exempt list is exactly `request_pairing`, `check_pairing_status`, `webpilot_get_formatter_info`, `webpilot_dev_get_formatter_logs`.
- Per-agent profile routing: `mcp-handler.js:87-121` (`resolveTargetProfile`) reads `entry.profileId`.

**InstallId**
- Mint: `packages/chrome-extension-unpacked/background.js:96-116` (`ensureInstallId`).
- Sent in WS hello: `background.js:520-525`.
- Server resolution: `server.js:1577-1604` (looks up `extension_installs` for an `installId → profileId` mapping; validates the profile still exists; falls back to other resolution paths if not).
- Persist: `server.js:1683-1689` (`extensionInstalls.setProfileForInstall(installId, profileId)` after every successful hello).
- Schema: `db/schema.sql:88-93` (`extension_installs` table).

### 1.3 The five auth gates

1. **Extension WS upgrade** — `server.js:1505`. Constant-time compare of `?apiKey=…` query against the server's transport key. No installId check, no per-profile distinction. Same key for every extension.
2. **Web UI HTTP** — `server.js:370-417` (`makeUiAuth`, `makeMutatingUiAuth`). **Localhost-only** (`127.0.0.1`/`::1`). No key. Bypassed in `IS_DEV_MODE`.
3. **Web UI events WS** — `server.js:1481-1499`. Localhost-only check on the upgrade socket. No key.
4. **Popup endpoints** — `server.js:2016-2037` (`_authPopup`). Header `X-API-Key` or `?apiKey=…` → tries paired-agent first, falls back to constant-time compare against the server transport key (post-`7dc391d`). On localhost only? No — these are reachable in network mode.
5. **MCP `tools/call`** — `mcp-handler.js:685-713`. Validates against `agents.api_key_hash`. Auth-exempt list listed above. Transport key is **not** accepted here.

### 1.4 The /connect handshake

`server.js:2185-2192`:

```js
app.get('/connect', (req, res) => {
  res.json({
    apiKey,
    serverUrl: `ws://${publicHost}:${port}`,
    sseUrl: `http://${publicHost}:${port}/sse`,
    networkMode: host === '0.0.0.0'
  });
});
```

- No auth at all.
- Returns the transport key in clear text.
- In `network` mode (`host === '0.0.0.0'`) this is **reachable from any host on the LAN**.
- The extension consumes it at `background.js:162-189` (`doAutoConnectFetch`) and writes the key into `chrome.storage.local`.

### 1.5 Critique

- **The transport key has no business being a credential.** It is shared across every extension install, every profile, every agent. It is handed out unauthenticated. It is not rotated. It is mirrored into every Chrome profile's storage. It serves a single useful purpose — letting the daemon refuse strangers on the WS upgrade — but it accomplishes nothing more than the localhost network filter would on its own.
- **`/connect` is the weakest link.** It is the boot-strap for new extension installs and it gives the keys to anyone who can hit the port. In network mode this is a LAN-wide credential dispensary.
- **InstallId is a wasted asset.** It is exactly the right per-install identifier the server needs, but it is *only* used to recover the `profileId` mapping. It is not used for auth, not used for routing decisions on the WS, not bound to any per-profile key.
- **The popup-auth fallback in `7dc391d` is a load-bearing hack.** It makes the popup work on first-boot profiles that haven't paired yet, but it does so by elevating the transport key from "transport-only" to "admin credential for global site rules". Any holder of the transport key can now toggle global site policy.
- **No audit attribution on popup writes via the transport-key path.** `_authPopup` returns `{ entry: null, agentId: null }` in that case; `site-policy.setGlobalRule` logs the change but cannot attribute it to a profile or agent. See `server.js:2102-2130`.

---

## 2. Threat model

### T1. Lateral movement after one profile is compromised

An attacker who exfiltrates a single Chrome profile's `chrome.storage.local`
gets the transport key. With that key they can:

- Open a WS upgrade against the server and execute the full
  extension-bridge command surface as some profile — they pick the profile
  via `installId` / `gaiaEmail` / `identify_required` picker. The server has
  no machinery to refuse based on which install the key originated from.
- Hit popup endpoints from any host the server is bound on (in network mode
  this is the LAN).
- Authenticate to `/api/popup/site-toggle` and globally allow or block any
  domain.

The MCP `tools/call` surface is NOT directly reachable with the transport
key (it requires a paired-agent key). But the WS-bridge surface — which the
MCP handler routes commands through anyway — IS reachable, by spoofing a
hello with any plausible profileId. The attacker bypasses the MCP layer and
talks straight to the bridge.

Severity: **high**. One profile compromise = whole-server browser control.

### T2. Audit attribution loss on popup writes

`/api/popup/site-toggle` accepted via the transport-key path:
`auth.entry === null`, `auth.agentId === null`. The route sets a global rule.
Server log shows the event but not "who did it." There is no way to determine
after the fact whether a global site toggle came from the user, from a paired
agent, or from a stranger who phished the transport key.

Severity: **medium**. Compounds T1.

### T3. First-boot bootstrap has no identity

A fresh Chrome profile has the extension installed but no paired agent.
After commit `7dc391d`, the popup works in that state by riding the
transport key. This is *useful* (the user can toggle site policy from the
popup the moment the extension is installed) but it means the popup is
operating without an agent identity — site rule writes can't be tied back to
this profile, only to "someone holding the transport key".

The right fix isn't to remove the fallback; it's to mint a per-profile
identity automatically on first connect so the popup has something to
attribute writes to.

Severity: **medium** (functional today, architectural problem).

### T4. /connect is a credential dispensary

`GET /connect` returns the transport key unauthenticated. In default
(localhost-only) mode the realistic threat is local-user separation, which
is mostly moot — anything on the local machine reading the port is already
running as the user. In network mode it is **LAN-wide credential
disclosure** with no rate limit, no log, and no rotation.

Severity: **high in network mode, low on localhost**.

### T5. Key rotation is destructive

Rotating the transport key requires:
1. Editing `server.json` (or env) and restarting the server.
2. Every extension install that has the old key in `chrome.storage` then
   fails its WS handshake with 1008.
3. The extension's auto-recovery (`background.js:443-452`) clears stored
   credentials and re-fetches via `/connect`.

So rotation is technically self-healing — but it relies on `/connect` still
being open and unauthenticated, which is the exact thing T4 says is wrong.
Replacing `/connect` requires solving rotation first.

Severity: **medium**. Mostly a deployment-hygiene smell.

### T6. No per-profile isolation

Two profiles paired to two different agents share the transport key. If
profile A's storage is dumped (extension dev tools, a malicious site that
exploits an extension bug, support bundle, backup), the attacker can speak
the bridge protocol *as profile B*. The agents' paired keys remain
uncompromised, but the lower-level bridge does not check them.

Severity: **high**, same root as T1.

### T7. Transport key in default builds is `dev-123-test`

`paths.js:11` defines `DEFAULT_API_KEY = 'dev-123-test'`. If `server.json`
doesn't exist and `API_KEY` is unset, this is the live key. There's no
"first-boot mint a random key" code path. A user who runs the daemon
without ever opening the dashboard or hitting `/connect` is running with a
publicly-documented credential.

Severity: **medium**. Mitigated in practice by the Electron installer / pkg
build path, which writes a fresh `server.json`, but the failure mode for
people running from source is bad.

### T8. Extension content-script vs background isolation

Out of scope of this audit — but worth flagging: the transport key lives in
`chrome.storage.local` which is accessible to extension code only, not to
content scripts. So a malicious page cannot directly read it. The realistic
exposure surface remains: (a) extension dev tools, (b) profile directory
filesystem access, (c) a vulnerability in another extension that escalates
to `chrome.storage` read.

---

## 3. Gaps vs. user intent

| User intent | Today's reality |
|---|---|
| installId identifies "this is profile X on this machine" | True for *routing* (server can resolve installId → profileId via `extension_installs`), but NOT for *auth*. The WS upgrade checks transport key, not installId. |
| Server is the security boundary | Mostly true at the MCP layer (paired keys), false at the WS-bridge layer (transport key only). |
| Extension only needs to identify itself + connect + be useful to whoever paired with it | Today the extension also has to *hold* the transport key as a credential. If the extension were truly thin, it would only need to present its installId. |
| Each agent has its own paired key, mapped to a profile binding | True at the MCP layer. The webapp at `/ui/agents` administers `agents.profile_id`. The MCP handler routes by it. The bridge layer ignores it. |

The structural gap: **the WS bridge auth and the MCP tools/call auth are
two different security layers, and they have inconsistent threat models.**
The MCP layer believes the user's mental model (per-agent paired keys with
profile bindings). The WS bridge layer is still using the legacy
single-shared-secret model. Closing this gap is what Phases B–D do.

---

## 4. Recommendations — phased

### Phase A — Retire the popup-auth transport-key fallback (small, safe) ✓ Shipped

**SHIPPED 2026-05-17 (hard cutover, single commit).** The transport-key
branch in `_authPopup` is gone. Popup auth is now `X-Install-Id` only —
the popup operates in profile-context (no agent identity required), so
the "needs a fallback when no paired agent exists" problem disappears.
See server's `_authPopup` in `server.js` and the matching extension
changes in `popup.js`.

**Prerequisite:** Phase B must ship first, so that every profile that
*could* hit the popup endpoints has a per-profile paired-agent key. Until
that's true, removing the fallback re-introduces the 401 that `7dc391d`
fixed.

**What ships:**
- Revert the transport-key branch in `_authPopup` (`server.js:2029-2035`).
- Restore strict `pairedKeys.validateKey`-only auth on `/api/popup/state`
  and `/api/popup/site-toggle`.
- Add a one-line log when the popup gets a 401 so the migration to
  per-profile keys is observable.

**Files touched:** `packages/server-for-chrome-extension/src/server.js`
(reverting ~50 lines of `7dc391d`).

**User-facing impact:** none if Phase B is live (every profile already has
a paired-agent key). The popup re-enters its agent-aware mode for every
profile.

**Migration:** Phase B's auto-provision step is exactly what guarantees no
profile is left in the "transport-key only" state.

---

### Phase B — Wire installId as the WS handshake identifier (medium) ✓ Shipped (as hard cutover, not gradual)

**SHIPPED 2026-05-17.** The extension WS upgrade now requires
`?installId=<uuid>` — the transport-key compare is gone entirely (the
gradual two-key transition described below was replaced with a one-shot
cutover per user direction; existing extensions need a one-time reload
per profile). `bound_at` tracking was deferred — the existing
`extension_installs.first_seen_at` covers the same TOFU role; revisit
if/when we add explicit lateral-movement defense.

**Goal:** the server's WS upgrade decision stops trusting the transport
key and starts trusting installId + a server-side resolution table.

**What ships:**
1. Extension sends installId on the WS upgrade as a query param (in
   addition to or instead of `apiKey`):
   `ws://host:port/?installId=<uuid>&apiKey=<transport-or-paired-key>`.
2. Server, in `server.js:1476`-1515, checks installId first:
   - If installId resolves via `extension_installs` to a known profile AND
     that profile has at least one active paired-agent in `agents`, accept
     the upgrade. The `apiKey` query param becomes optional (legacy
     fallback for transition).
   - If installId resolves but no paired agent exists yet, fall through to
     Phase C's auto-provision flow.
   - If installId is missing or unknown, fall back to the legacy
     transport-key check (read-only deprecation window).
3. New table or column: `extension_installs.bound_at` (timestamp of first
   successful hello-ack) so we have a TOFU-style record of when a given
   installId was first seen against a given profileId. Required so the
   server can refuse a different installId claiming the same profileId
   later (lateral-movement defense).

**Files touched:**
- `packages/server-for-chrome-extension/src/server.js` (upgrade handler,
  hello handler, popup `_authPopup` to resolve installId → agent).
- `packages/server-for-chrome-extension/src/extension-installs.js` (add
  the bound_at field, expose a `validateInstallId` helper).
- `packages/server-for-chrome-extension/src/db/schema.sql` +
  `db/migration.js` (new column, idempotent backfill).
- `packages/chrome-extension-unpacked/background.js:308` (`connectWebSocket`)
  — append `installId=` to the WS URL.

**Migration:** existing installs already have an installId; the server
already persists the mapping at hello. The only new write is the bound_at
field, which can backfill from `first_seen_at`.

**User-facing impact:** none. The transport key still works during this
phase.

---

### Phase C — Auto-provision a per-profile paired-agent key on first connect (medium) ✗ Dropped

**DROPPED 2026-05-17 per user direction.** This phase was the audit's
proposed mechanism for giving every profile a per-profile paired-agent
key so the popup could keep its agent-shaped auth contract. The
corrected design (locked by user) reframes the popup as
profile-scoped, not agent-scoped — global site rules apply, per-agent
overrides do not. The popup authenticates with installId directly.
Anyone who can reach the server's port can claim any installId, and
that's fine because claiming an installId grants zero agent power
(agent-layer auth via paired keys is unchanged). Auto-provisioning a
synthetic agent per profile would have added a row to `agents` that
the user does not want to see in `/ui/agents` and never get a
plain-text key delivered for. Skipping it.

**Goal:** every Chrome profile that completes a hello handshake ends up
with its own paired-agent row keyed to its installId. The transport key
stops being needed for the popup and for per-agent routing.

**What ships:**
1. On a successful hello where (a) installId resolves to a profileId, (b)
   no active `agents` row is bound to that profileId, server mints one:
   - `agentName = 'profile:<displayName>'` (or `'profile:<profileDir>'`
     if no display name).
   - `profileId = resolvedProfileId`.
   - A `source` field marking it `auto-provisioned-on-install` (requires
     adding the column to `agents` — currently the comment in
     `paired-keys.js:283-289` notes it's not stored).
2. The plaintext key is sent down the WS in the `hello_ack` message as
   `pairedKey`. The extension persists it as `chrome.storage.local.apiKey`
   *overwriting* the transport key (or, less invasive, as a new key
   `webpilot.profileApiKey` while transport key lives parallel for one
   release).
3. The popup begins using the per-profile key for `X-API-Key`.
4. MCP `tools/call` routed via `resolveTargetProfile` continues to work
   for any agent that pairs via `request_pairing` — those agents get their
   own row separate from the auto-provisioned profile row, and their
   `profile_id` is set during `approvePairing` as today.

**Files touched:**
- `server.js:1690` (in the hello handler, post-`hello_ack`, mint + ship).
- `paired-keys.js` (a new `getOrAutoProvisionForProfile(profileId,
  displayName)` helper).
- `db/schema.sql` (`agents.source` column).
- `background.js` (handle the new `pairedKey` field on `hello_ack`; rewrite
  `chrome.storage.local.apiKey` from it).

**Migration:** Existing installs reconnect, the server sees they have no
auto-provisioned agent for their profile, mints one, ships it on
`hello_ack`. The extension rewrites its `apiKey` storage atomically. The
transport key still works for one release as a fallback for installs that
fail to receive a `pairedKey`.

**User-facing impact:** zero re-pairing. The agents page in the webapp
gains one new row per Chrome profile (clearly tagged `auto-provisioned`),
so a power user might see more rows than before — minor UX consideration.

---

### Phase D — Drop the transport key entirely (cleanup) ✓ Shipped

**SHIPPED 2026-05-17.** `getApiKey()` and `DEFAULT_API_KEY` are deleted
from `service/paths.js`. The `API_KEY = getApiKey()` plumb in
`index.js` is gone. `createServer()` and `createMcpHandler()` no
longer accept an `apiKey` parameter. `GET /connect` no longer returns
`apiKey`. The `_authPopup` transport-key fallback from commit
`7dc391d` is removed. The extension purges any legacy `apiKey` from
`chrome.storage.local` on first run after upgrade. Live `server.json`
files that still carry `apiKey` are silently ignored — the field has
no consumer.

**Goal:** delete the single-shared-secret. `/connect` becomes a "claim
installId" handshake. `server.json` no longer contains an apiKey.

**What ships:**
1. Replace `GET /connect` with `POST /connect` that takes an
   `installId` in the body and returns the per-profile paired key
   (auto-provisioning if needed). First-call behavior: the server mints
   the agent row, returns the plaintext key, and never returns plaintext
   for that installId again. Subsequent calls return only the WS URL +
   profile metadata (no key — if the extension lost the key it has to
   `request_pairing` like any other agent).
2. The WS upgrade gate (server.js:1505) no longer compares against any
   transport key. The only valid auth is `installId → bound agent`. An
   unbound installId either auto-provisions (allowed in default mode) or
   is rejected (network mode + admin policy).
3. `getApiKey()` and `DEFAULT_API_KEY` are removed from
   `service/paths.js`. The `apiKey` field in `server.json` is deprecated
   (kept readable for one release for diagnostic logs, then removed).
4. `_authPopup` simplifies to paired-key only (Phase A's revert lands
   here for installs that came up post-Phase-B).

**Files touched:**
- `packages/server-for-chrome-extension/src/service/paths.js` — drop
  `getApiKey`, `DEFAULT_API_KEY`.
- `packages/server-for-chrome-extension/index.js` — drop the
  `API_KEY = getApiKey()` plumb.
- `packages/server-for-chrome-extension/src/server.js` — replace
  `/connect`, drop the `apiKey` param to `createServer`, remove the
  transport-key compare in the upgrade handler.
- `packages/chrome-extension-unpacked/background.js` — `doAutoConnectFetch`
  switches to POST + installId body.
- Docs: `MCP_SERVER.md`, `EXTENSION_REDESIGN_AND_POLICY.md` updated.

**Migration:** the previous releases (Phases B and C) have already moved
every active install to a per-profile paired key. On the cutover the
transport key in storage is dead weight but harmless; it never gets used
again.

**User-facing impact:** none in steady state. A user who manually edits
`server.json` to set `apiKey` will get a deprecation log.

---

## 5. Backward compatibility

The phasing is designed so each step is invisible to the user:

1. **Phase B** is purely additive — adds installId to the WS upgrade
   query, adds a TOFU bound_at field. Transport-key auth still works.
2. **Phase C** introduces the per-profile auto-provisioned key but keeps
   the transport key as a fallback. An extension that misses one
   `hello_ack` (e.g. a server-side mint failure) will continue to function
   via the transport key.
3. **Phase A** ships *after* Phase C. By the time the transport-key
   fallback in `_authPopup` is removed, every profile that connected to a
   Phase-C-or-later server has a per-profile key. A profile that hasn't
   connected since pre-Phase-C will get its key on its next connect.
4. **Phase D** is the cleanup. By the time it ships, no live install
   relies on the transport key for anything. The `apiKey` in
   `chrome.storage` is dead but the daemon ignores it.

**No re-pairing.** Existing `agents` rows are untouched. Existing
`request_pairing` flows continue to work. The auto-provisioned per-profile
agents are *additional* rows; they don't replace user-initiated pairings.

**No data migration.** The only DDL is additive columns (`bound_at`,
`source`). No row rewrites.

---

## 6. Open questions for the user

These are the calls I want you to make before implementation kicks off:

1. **Should the auto-provisioned per-profile key be visible in the
   `/ui/agents` page?** Options: (a) hide them entirely behind a "show
   system agents" toggle; (b) show them with an `auto-provisioned` badge;
   (c) collapse them into the profile row on the dashboard and don't show
   them on the agents page at all. (c) hides the new abstraction from
   users who don't care; (b) is more honest. My recommendation is (b).

2. **In network mode, should an unbound installId be allowed to
   auto-provision over the LAN?** Today the transport key gates this; in
   Phase D, the gate is gone. Two options: (a) auto-provision over LAN
   freely (any LAN host can become a profile binding) — this is the
   "trust the LAN" stance and matches today; (b) require explicit admin
   approval via the webapp for any installId originating from a non-loopback
   address. (b) is safer but introduces a friction the current model
   doesn't have. My recommendation is (b) with a settings toggle for "trust
   LAN" off by default.

3. **Should Phase C's auto-provisioned key be rotatable on demand?**
   Right now paired-agent keys are essentially immutable — you revoke and
   re-pair. For the auto-provisioned profile key, do we want a "rotate"
   action in the popup or the agents page? Useful for "I think my profile
   storage was compromised"; complicated because the new key has to be
   delivered to the extension and the old one revoked atomically.

4. **What's the right behavior when installId is missing from the
   extension?** The migration path in `background.js:87` backfills
   installId on every chrome.runtime.onStartup, but the very first
   handshake after the new extension version installs may not have one
   yet. Should the server: (a) refuse the upgrade, forcing a reload; (b)
   accept the upgrade with transport-key fallback during the deprecation
   window; (c) mint a server-side temp installId and ship it back to the
   extension on hello_ack? My recommendation: (c) is most invisible to the
   user, but the extension already does (a) by minting on its own — so
   refusing is unlikely to be necessary in practice.

5. **Should we keep the transport key as a "service-level admin key" for
   the dashboard?** Today the dashboard is localhost-only and requires no
   key. If we ever want remote admin access (e.g. mobile dashboard), some
   admin-level credential needs to exist. Two options: (a) the dashboard
   stays localhost-only forever and we never need such a key; (b) we
   reintroduce something transport-key-shaped purely for the dashboard,
   bound to a single TOTP-bootstrapped device. (a) is the right answer
   for v1; (b) is a future feature, not a Phase D constraint.

---

## 7. Out of scope for this audit

- Extension content-script vs background isolation. The audit assumes
  `chrome.storage.local` is a sound boundary against page-script reads.
- The MCP `request_pairing` / `check_pairing_status` two-phase flow. That
  flow is sound today: it does not require the transport key, the pending
  pairings have a 24h TTL, and approvals are localhost-gated through the
  webapp. The phased work above does not touch it.
- The `extension_installs` table's privacy properties (it persists a
  per-install UUID + the resolved profileId). The audit treats this as
  fine; it's strictly server-local data.
- The web UI dashboard auth (localhost-only). Unchanged by all phases.

---
