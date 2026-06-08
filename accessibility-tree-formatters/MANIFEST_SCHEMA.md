# Formatter Manifest Schema

This document describes the standardized manifest schema used by every
WebPilot accessibility-tree formatter — both the remote auto-updated
formatters bundled in this directory and user-side custom formatters
under `%LOCALAPPDATA%/WebPilot/custom-formatters/` (or the equivalent
on macOS/Linux).

The schema is consumed by `formatter-manager.js`, surfaced to agents
via `webpilot_get_formatter_info`, and rendered to humans by the Web UI
Formatters tab.

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
  "workflows": [
    {
      "name": "send_message",
      "description": "Compose a message in the active Discord channel and send it.",
      "parameters": {
        "text": { "type": "string", "description": "The message text to send." }
      }
    }
  ]
}
```

### Fields

| Field | Required | Type | Description |
| --- | --- | --- | --- |
| `name` | yes | string | Must match the directory name. |
| `version` | yes | semver string | Per-formatter version. Informational metadata only — displayed in the Web UI and agent responses. **Does NOT trigger auto-updates.** |
| `match` | yes | string | Hostname pattern. Substring match against `URL.hostname`. v1 keeps this simple — no regex, no path matching. |
| `source` | yes | enum | One of `"remote"` (auto-downloaded from this repo), `"custom"` (user-written, lives in custom-formatters dir), `"local"` (bundled with the binary). |
| `description` | yes | short string | One-line description of the formatter's purpose. Surfaced to agents and the Web UI. |
| `notes` | no | freeform string | Agent-facing hints — what elements look like, edge cases, useful semantics. Multi-sentence is fine. |
| `errorHandling` | no | object | `{ fallbackToRawTree: boolean }` — when `true`, the manager returns the raw CDP tree if the formatter throws. Defaults to `true` if absent. |
| `workflows` | no | array | Workflow declarations consumed by `webpilot_run_workflow`. Each entry: `{ name, description, parameters }`. Implementations live in a sibling `workflows.js`. See "Workflows" below. Default `[]`. |

> **Note on `version`**: This per-formatter `version` field is **informational only**. Auto-updates are triggered exclusively by the TOP-LEVEL `accessibility-tree-formatters/manifest.json` `version` bump. Bump that (and regenerate `signed-manifest.json` via `node scripts/sign-formatters.js`) when any formatter file changes. Bumping a per-formatter `version` alone does nothing — the auto-updater never reads it.

### `source` semantics

- **`remote`**: Lives in the auto-updated formatters dir
  (`getFormatterDir()`). Files listed in the signed manifest are
  re-downloaded on each version bump. Users should not edit these —
  changes are clobbered.
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

## Workflows

The `workflows` array declares named composite operations exposed by the
formatter and callable via the `webpilot_run_workflow` MCP tool. Each
entry pairs metadata (declared in `manifest.json`) with an implementation
(exported from a sibling `workflows.js`). The manager loads both, cross-
checks them, and only registers workflows whose implementation matches
the manifest declaration.

### Contract

1. `manifest.json` declares the workflow shape under `workflows[]`:

   ```json
   {
     "name": "send_message",
     "description": "Compose a message in the active Discord channel and send it.",
     "parameters": {
       "text": { "type": "string", "description": "The message text to send." }
     }
   }
   ```

   `parameters` is an object map of `{ paramName: { type, description } }`.
   Supported `type` values: `"string"`, `"number"`, `"boolean"`, `"object"`,
   `"array"`. The schema is intentionally flatter than full JSON Schema —
   the workflow's `run()` is responsible for asserting required fields.

2. A sibling `workflows.js` exports an object map with one key per
   declared workflow:

   ```js
   // accessibility-tree-formatters/discord/workflows.js
   module.exports = {
     send_message: {
       description: 'Compose a message in the active Discord channel and send it.',
       parameters: {
         text: { type: 'string', description: 'The message text to send.' }
       },
       async run({ params, browser, tabId, findInTree }) {
         const tree = await browser.getAccessibilityTree({ tab_id: tabId });
         const composer = findInTree(tree, { name: 'Message textbox' });
         if (!composer) throw new Error('Composer textbox not found.');
         await browser.click({ ref: composer.ref, tab_id: tabId });
         await browser.type({
           ref: composer.ref,
           text: params.text,
           tab_id: tabId,
           pressEnter: true
         });
         return { sent: true, composerRef: composer.ref };
       }
     }
   };
   ```

   The `run()` function receives:

   - `params` — the validated params object (type-checked against the
     manifest declaration).
   - `browser` — primitive object with `getAccessibilityTree`, `click`,
     `type`, `scroll`, `getTabs`, `createTab`. These resolve the agent's
     bound Chrome profile from the API key and execute server-side
     against the extension WS (no MCP/SSE round-trip).
   - `tabId` — the browser tab to run against.
   - `findInTree` — a text-based query helper (see
     `packages/server-for-chrome-extension/src/lib/tree-query.js`).

3. The manager registers a workflow only if all of these hold:

   - The manifest declares it under `workflows[]`.
   - `workflows.js` exports an object of the same name.
   - The export has `description: string`, `parameters: object`, and
     `run: function`.

   Mismatches log a warning and the workflow is skipped (the formatter
   continues to load and serve `formatTree()` calls normally).

4. Agents discover available workflows via `webpilot_get_formatter_info`
   — each entry in `platforms[name].workflows[]` carries an
   `implemented: boolean` flag.

### Validation

- The manager rejects workflows missing `run`, `description`, or
  `parameters`.
- It logs (but does not fail) when a manifest declares a workflow that
  has no matching `workflows.js` implementation, and when `workflows.js`
  exports a workflow that the manifest does not declare.
- Runtime errors thrown by `run()` are recorded to
  `formatter-logs.js` under the formatter's name with
  `phase: 'workflow'` and surface in the Web UI Formatters tab.

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
  source: "<dir-based hint: 'remote' for auto-updated, 'custom' for user dir>",
  description: "(no manifest.json — synthesized)",
  notes: "",
  errorHandling: { fallbackToRawTree: true },
  workflows: [],
  _synthesized: true
}
```

A malformed `manifest.json` (invalid JSON, missing required field) is
treated the same way: warning logged, synthesized manifest used,
`source` forced to `"custom"`.
