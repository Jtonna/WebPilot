# Formatter Manifest Schema

This document describes the standardized manifest schema used by every
WebPilot accessibility-tree formatter — both the remote auto-updated
formatters bundled in this directory and user-side custom formatters
under `%LOCALAPPDATA%/WebPilot/custom-formatters/` (or the equivalent
on macOS/Linux).

The schema is consumed by `formatter-manager.js`, surfaced to agents
via `webpilot_get_formatter_info`, and (in the upcoming Web UI
Formatters tab) rendered to humans.

---

## Layout

Each formatter lives in its own subdirectory under
`accessibility-tree-formatters/` and contains:

```
accessibility-tree-formatters/
  <name>/
    manifest.json     <-- per-formatter manifest (source of truth)
    <entry>.js        <-- formatter entry point (router or single-file)
    <…other files>    <-- helpers, sub-formatters, etc.
```

A top-level `accessibility-tree-formatters/manifest.json` continues
to exist as the **download index** for the auto-updater
(`formatter-updater.js`). It lists every file that the updater must
fetch from GitHub on each version bump, including each per-formatter
`manifest.json`. The per-formatter manifest is the source of truth
for the formatter's metadata; the top-level manifest is a slim index
that points at each formatter's entry file and lists files to sync.

---

## Per-formatter `manifest.json`

```json
{
  "name": "discord",
  "version": "1.0.0",
  "match": "discord.com",
  "source": "remote",
  "description": "Discord chat — exposes channels, messages, members, composer",
  "notes": "Use the send_message workflow for compose+send in one call. The composer ref appears in tree as role=textbox with name starting 'Message #'.",
  "errorHandling": {
    "fallbackToRawTree": true
  },
  "workflows": []
}
```

### Fields

| Field | Required | Type | Description |
| --- | --- | --- | --- |
| `name` | yes | string | Must match the directory name. |
| `version` | yes | semver string | Per-formatter version. Bump on behavior changes. |
| `match` | yes | string | Hostname pattern. Substring match against `URL.hostname`. v1 keeps this simple — no regex, no path matching. |
| `source` | yes | enum | One of `"remote"` (auto-downloaded from this repo), `"custom"` (user-written, lives in custom-formatters dir), `"local"` (bundled with the binary). |
| `description` | yes | short string | One-line description of the formatter's purpose. Surfaced to agents and the Web UI. |
| `notes` | no | freeform string | Agent-facing hints — what elements look like, edge cases, useful semantics. Multi-sentence is fine. |
| `errorHandling` | no | object | `{ fallbackToRawTree: boolean }` — when `true`, the manager returns the raw CDP tree if the formatter throws. Defaults to `true` if absent. |
| `workflows` | no | array | Reserved for Wave B. See "Workflows (reserved)" below. Default `[]`. |

### `source` semantics

- **`remote`**: Lives in the auto-updated formatters dir
  (`getFormatterDir()`). Replaced wholesale on each manifest version
  bump. Users should not edit these — changes are clobbered.
- **`custom`**: Lives in the user's custom-formatters dir
  (`getCustomFormatterDir()`). Never touched by the updater. Survives
  server upgrades.
- **`local`**: Bundled with the binary build (pkg snapshot). Falls
  back to this if neither remote nor custom exists. v1 may not ship
  any local formatters but the source value is reserved.

The `formatter-manager` will **override** whatever `source` value the
manifest file declares based on which directory the manifest was
loaded from — a custom-formatters manifest that claims
`"source": "remote"` will be treated as `"custom"`.

---

## Workflows (reserved — Wave B)

The `workflows` array reserves space for a future workflow execution
system. Wave B will populate this with entries that look like:

```json
{
  "name": "send_message",
  "description": "Type and send a Discord message in one call.",
  "parameters": {
    "type": "object",
    "properties": {
      "channel_ref": { "type": "string", "description": "Composer ref, e.g. e42" },
      "text":        { "type": "string", "description": "Message body" }
    },
    "required": ["channel_ref", "text"]
  }
}
```

For now `workflows` MUST be present as an empty array (`[]`). The
manager parses but does not execute these — Wave B introduces a
`webpilot_run_workflow` MCP tool that consumes them.

---

## Top-level `manifest.json` (download index)

The top-level manifest remains and is still consumed by
`formatter-updater.js`. Its `files` array MUST list every file the
updater needs to download from GitHub — including each per-formatter
`manifest.json`. Example shape:

```json
{
  "version": "2",
  "platforms": {
    "discord":  { "match": "discord.com",   "entry": "discord/discord.js" },
    "threads":  { "match": "threads.com",   "entry": "threads/router.js" },
    "zillow":   { "match": "zillow.com",    "entry": "zillow/router.js" }
  },
  "default": "default.js",
  "files": [
    "default.js",
    "discord/manifest.json",
    "discord/discord.js",
    "threads/manifest.json",
    "threads/router.js",
    "...etc"
  ]
}
```

The `platforms` block stays as the at-a-glance routing table; the
per-formatter manifests carry the descriptive metadata.

---

## Backward compatibility

A formatter directory without a `manifest.json` is still loaded. The
manager synthesizes a minimal manifest:

```js
{
  name: "<directory name>",
  version: "0.0.0",
  match: "<from top-level manifest if present, else ''>",
  source: "custom",
  description: "(no manifest.json — synthesized)",
  workflows: []
}
```

A malformed `manifest.json` (invalid JSON, missing required field) is
treated the same way: warning logged, synthesized manifest used,
`source` forced to `"custom"`.
