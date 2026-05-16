# Formatters Overhaul — Tracking

Work scoped for the QOL-Features overnight push. Update statuses as items
ship; delete the file when the PR description absorbs the relevant items.

## Done

- Discord formatter migrated from local custom-formatters - repo
- Standardized formatter manifest schema defined (MANIFEST_SCHEMA.md)
- Existing formatters migrated to new schema (threads, zillow, discord)
- formatter-manager.js parses new schema with backward compat

## In progress (Wave B)

- Workflow execution engine + `webpilot_run_workflow` MCP tool
- Discord `send_message` workflow as proof-of-concept
- Error wrapper around formatter + workflow execution
- Log storage (in-memory ring buffer + disk persistence)
- `/api/ui/formatters` + `/api/ui/formatters/:name/logs` endpoints

## Queued (Wave C)

- Web UI Formatters tab page (`/ui/formatters/`)
- Per-formatter status indicator (healthy / unhealthy)
- Logs placeholder page (`/ui/formatters/<name>/logs/`)

## Independent quick wins (parallel)

- One-command dev mode (concurrently at repo root, server proxies /ui/ to next dev)
- `intent` parameter on navigational MCP tools (optional)
- `browser_execute_js` description update — forbid navigation/click/type
