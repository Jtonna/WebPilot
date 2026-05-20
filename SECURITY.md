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
- The affected version (visible in the dashboard footer) and your platform/Chrome version.
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

- **Extension = identity** — each Chrome profile is identified by a per-install UUID. Claiming an installId grants zero agent power.
- **Server = security boundary** — all authorization decisions happen server-side.
- **Agents = power** — every agent has a distinct API key obtained via an explicit human approval handshake in the dashboard.

See [`docs/MCP_SERVER.md`](docs/MCP_SERVER.md) §Authentication & authorization for the detailed model.

## Disclosure timeline

Default coordinated disclosure window is **90 days** from the acknowledgement date, or until a fix ships — whichever comes first. We're happy to negotiate that timeline on a case-by-case basis for issues that need more time to remediate safely.
