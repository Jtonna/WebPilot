# Formatters Overhaul — Tracking

Work scoped for the QOL-Features overnight push. Update statuses as items
ship; delete the file when the PR description absorbs the relevant items.

## Done

### Wave A — schema + per-formatter manifests

- Discord formatter migrated from local custom-formatters → repo
- Standardized formatter manifest schema defined (MANIFEST_SCHEMA.md)
- Existing formatters migrated to new schema (threads, zillow, discord)
- formatter-manager.js parses new schema with backward compat
- Per-formatter manifest.json files alongside each entry

### Wave B — workflows + observability

- Workflow execution engine + `webpilot_run_workflow` MCP tool
- Discord `send_message` workflow as proof-of-concept
- Error wrapper around formatter + workflow execution
- Log storage (in-memory ring buffer + disk persistence, 50/formatter, 7-day TTL)
- `/api/ui/formatters` + `/api/ui/formatters/:name/logs` endpoints
- `lib/tree-query.js` `findInTree` helper for workflow ref lookup

### Wave C — Web UI surfaces

- Web UI Formatters tab page (`/ui/formatters/`)
- Per-formatter status indicator (healthy / unhealthy / unknown), promoted
  to shared `HealthPill` component
- Per-formatter logs page (`/ui/formatters/logs/?name=<name>`)
- Sidebar entry under Workspace

### Independent quick wins (parallel) — all shipped

- One-command dev mode (`npm run dev` at repo root — concurrently +
  WEBPILOT_DEV=1 proxy /ui/ to next dev on 3100)
- `intent` parameter on navigational MCP tools (optional debug trace)
- `browser_execute_js` description update — forbid navigation/click/type
  with explicit pointers at the dedicated tools

### Documentation pass (post-overnight)

- README: Platform formatters / Workflows / Development mode sections
- MCP_SERVER: formatter-logs.js, lib/tree-query.js, webpilot_run_workflow,
  /api/ui/formatters endpoints, dev-mode proxy
- MCP_INTEGRATION: webpilot_run_workflow section + intent convention
- BUILD_ARCHITECTURE: per-formatter subdirectory layout, formatter-logs.js
- MANIFEST_SCHEMA: active Workflows contract + Discord worked example

## Still open

- **Live human end-to-end test of Discord `send_message` workflow.** All
  unit-shaped wiring is in; the missing piece is a real-browser run with
  the user logged into Discord. Slated for the next user session.
- **Auto-updater push of new manifests to GitHub for `threads` and
  `zillow`.** The repo carries the new schema, but installed clients
  will only pick up the per-formatter manifest.json files (and Discord)
  after the PR merges to main and the auto-updater fetches them on its
  next hourly tick. Discord is the only platform shipping workflows in
  v1 — threads/zillow ship the new metadata but no workflows yet.
