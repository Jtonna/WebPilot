# Security Policy

## Supported versions

WebPilot is pre-1.0; only the **latest released version** receives security fixes. Older tags are not patched. Please update before reporting.

## Reporting a vulnerability

Please **do not** open a public GitHub issue for security vulnerabilities. Report privately via either:

- **Email:** jtonna@proton.me — please put `[WebPilot security]` in the subject line.
- **GitHub private advisory:** <https://github.com/Jtonna/WebPilot/security/advisories/new>

Include:

- A description of the issue and its impact (what an attacker could do).
- Reproduction steps or a proof of concept.
- The affected version (visible in the dashboard under Settings → General → About) and your platform/Chrome version.
- Optionally, a suggested fix.

You will receive an acknowledgement within **3 business days**. A fix-or-mitigation plan will follow within **14 days** depending on complexity. You will be credited in the release notes for the fix unless you prefer to remain anonymous.

## Scope

In scope:

- The MCP server (`packages/server-for-chrome-extension/`) — auth bypasses, command injection, path traversal, privilege escalation.
- The Chrome extension (`packages/chrome-extension-unpacked/`) — message-passing exploits, content-script injection, cross-profile leakage.
- The Electron installer (`packages/electron/`) — auto-start hijacking, deployment-path tampering.
- The web UI (`packages/server-web-ui/`) — XSS, CSRF on the localhost surface, auth bypass on `/api/popup/*` or `/api/ui/*`.

Out of scope:

- Issues that require physical access to an already-unlocked machine.
- Reports against third-party dependencies (please report upstream first).
- Social-engineering attacks on the human operator (e.g. tricking them into approving a pairing).
- Findings that depend on the operator disabling explicit security controls (e.g. running as administrator, disabling SmartScreen, granting Full Disk Access).

## Trust boundaries

For context when assessing reports, the WebPilot trust model is:

- **Extension = identity, loopback-only** — each Chrome profile is identified by a per-install UUID (`installId`). The extension WebSocket is **loopback-only** and is never LAN-reachable, even in network mode. An installId is an identity, not a credential, and it is only ever presented from the local machine; it carries no agent power. The only gate on MCP tools is agent-layer API-key auth.
- **Server = security boundary** — all authorization decisions happen server-side. In network mode, only the API-key-gated MCP surface (`/sse`, `/message`) is reachable over the LAN; the extension WebSocket, `/api/popup/*`, `/connect`, `/ui`, and `/health` stay loopback-only (enforced by `src/loopback.js`).
- **Agents = power** — every agent has a distinct API key obtained via an explicit human approval handshake in the dashboard. Only the plaintext key authenticates; a stored key hash is never a credential (see below).

### Agent key handling

The plaintext API key is shown exactly **once** — at pairing approval, or when an agent's key is regenerated — and is never persisted. The server stores only an HMAC hash (`api_key_hash`) of the key; that hash never leaves the server, is never sent to any client, and authenticates nothing on its own. Authentication hashes the presented plaintext and compares it against the stored hash, so a leaked hash cannot be replayed as a credential.

See [`docs/MCP_SERVER.md`](docs/MCP_SERVER.md) §Authentication & authorization for the detailed model.

## Protecting your MCP client config

The MCP transport that AI agents use to reach the WebPilot server requires an `X-API-Key` value, and most clients (Claude Desktop, Cursor, etc.) store that key **in plaintext** inside a per-repo `.mcp.json`. Treat that file like a credential:

- **Do not commit `.mcp.json` to a public repository.** Anyone who reads the repo can copy the key and impersonate the paired agent against any WebPilot server they can reach.
- Add `.mcp.json` to your repo's `.gitignore` (or your global `~/.gitignore_global`). If you need to share an example config with collaborators, commit a sanitized `.mcp.json.example` with the key field stubbed.
- **If you've already pushed a `.mcp.json` with a real key**, treat the key as compromised: open the WebPilot dashboard, revoke the paired agent, and re-pair to mint a fresh key. Removing the file from `HEAD` is not enough — the value is still in the repo's history and on every fork/clone.

The same advice applies to any other client config that embeds the WebPilot API key (Cursor `mcp.json`, Continue config, custom shell scripts, etc.).

### Migration (breaking)

Earlier builds exposed a per-agent "Copy config" button that populated the generated `.mcp.json` with the agent's stored `api_key_hash` as `X-API-Key`. That value is a hash, not a plaintext key, and it **no longer authenticates** — a leaked or copied hash is accepted by nothing. Any client config produced by that old button will now be rejected.

To recover, each existing agent must either be **re-paired** (run the pairing handshake again) or have its key **regenerated** via the dashboard's per-agent "Regenerate key" action (a one-time plaintext reveal), then have its client config updated with the new plaintext key. The signing pepper (`<dataDir>/secret/api-key.pepper`) is unaffected and does not need rotation.

## Supply chain integrity

WebPilot's daemon fetches accessibility-tree formatters and the global site blocklist from this repo at runtime. To stop an attacker who compromises a maintainer's GitHub account from pushing malicious JavaScript that gets executed inside every user's daemon process, every released formatter + blocklist update is cryptographically signed.

- **Signing key.** A single Ed25519 keypair signs all formatter / blocklist releases. The private key is held offline by the maintainer and configured in GitHub Actions as the `WEBPILOT_SIGNING_KEY_BASE64` repo secret; it never lives on a developer machine that pushes to `main`.
- **Pubkey distribution.** `accessibility-tree-formatters/PUBKEY.pem` is committed to the repo AND bundled into the daemon binary (via `pkg.assets`) and the Electron installer (via `extraResources`). The verifier reads the pubkey from disk — it never trusts a key fetched over the network.
- **What's signed.** Each top-level bundle (formatters + blocklists) ships a `signed-manifest.json` carrying the manifest version plus a SHA-256 of every referenced file, with a detached Ed25519 signature in `signed-manifest.json.sig`.
- **What the verifier does.** On every update tick the daemon fetches the signed manifest + signature, verifies them against the bundled pubkey, then hashes every file it downloads and compares against the signed manifest. **Any mismatch — bad signature, missing file, wrong hash — aborts the entire update.** Files already on disk are not touched.
- **Fail-skip, not fail-close.** If the remote does not yet serve a `signed-manifest.json` (pre-signing release, mid-deploy branch), the daemon logs a warning and skips the update rather than applying unsigned files. Users keep running whatever they already have.
- **Logging.** Every update tick logs the verification result (success with pubkey path + manifest version, or failure with the specific reason). See `server.log` under the platform data dir.

### Reporting a compromised signing key

If you have credible evidence that the formatter signing key has been compromised — leaked from the maintainer's machine, exfiltrated from GitHub Actions, etc. — report it immediately via the channels at the top of this document and include any indicators you have (commits, signatures, logs). On confirmation the maintainer will rotate the key (`CONTRIBUTING.md` → "Key rotation"), publish a new release containing the new pubkey, and document the incident in the release notes.

## Disclosure timeline

Default coordinated disclosure window is **90 days** from the acknowledgement date, or until a fix ships — whichever comes first. We're happy to negotiate that timeline on a case-by-case basis for issues that need more time to remediate safely.
