# Formatter & Workflow Dev Guide

This guide describes the inner loop for building or fixing an accessibility-tree
formatter or workflow — both for humans editing files in this directory and for
AI agents working on the user's behalf via WebPilot's MCP tools.

The schema for the `manifest.json` files referenced below is documented in
[MANIFEST_SCHEMA.md](./MANIFEST_SCHEMA.md). This doc focuses on the iteration
loop, not the data shape.

---

## The inner loop (TL;DR)

```
edit → reload → test on a real page → check logs if it broke → repeat
```

Each step has an MCP tool. None of them require restarting the WebPilot server.

| Step | Tool | What it does |
|---|---|---|
| Discover | `webpilot_get_formatter_info` | Lists every loaded formatter, versions, manifest notes, and the path to drop custom files (`customFormatterDir`). |
| Reload formatters | `webpilot_reload_formatters` | Re-reads every formatter from disk into memory. Returns the updated state; **verify the version bumped** in the response to confirm your edit took effect. |
| Test (read) | `browser_get_accessibility_tree` | Runs the formatter against a live tab and returns the formatted tree + any structured extras (postCount, recipientUsername, etc.). |
| Test (action) | `webpilot_run_workflow` | Runs a workflow declared in the formatter's `workflows.js`, with typed params. |
| Inspect failures | `webpilot_dev_get_formatter_logs` | Returns the recent error ring buffer (max 50) + a health summary for one platform. Successful invocations are NOT stored as rows — they only update `successCount` and `lastSuccessAt` on the health summary. |
| Reload extension | `webpilot_dev_reload_extension` | `chrome.runtime.reload()` inside the Chrome extension. **Required after editing files under `packages/chrome-extension-unpacked/`** — Chrome's service worker does not auto-pick-up source changes. |

---

## File layout for a custom formatter

Custom formatters live under `<dataDir>/custom-formatters/` (on Windows, that's
`%LOCALAPPDATA%\WebPilot\custom-formatters\`). The exact path is reported in
the `customFormatterDir` field of `webpilot_get_formatter_info`'s response.

```
custom-formatters/
  manifest.json           <- top-level registry (lists platforms)
  <platform>/
    manifest.json         <- per-formatter metadata + workflow declarations
    <platform>.js         <- formatter entry (CommonJS, exports a function)
    workflows.js          <- (optional) workflow implementations
    <helpers>.js          <- (optional)
```

The top-level `manifest.json` ties the platform name to its entry file:

```json
{
  "version": "1",
  "platforms": {
    "myplatform": {
      "match": "example.com",
      "entry": "myplatform/myplatform.js"
    }
  },
  "files": ["myplatform/myplatform.js"]
}
```

The per-formatter `manifest.json` carries the metadata that `webpilot_get_formatter_info`
returns to agents. **Bump its `version` field every time you edit the formatter** — that
makes "did my reload take effect?" checkable in a single response field.

See `discord/manifest.json` in this repo for a worked example with workflows.

---

## Iterating on a formatter

1. **Find the platform.** Call `webpilot_get_formatter_info` (no auth required).
   Note the `customFormatterDir` and the current version of the formatter you're
   editing.

2. **Edit the formatter file.** The formatter is a CommonJS module exporting a
   function `(nodes) => { tree, elementCount, refs, ...extras }`. For multi-page
   sites, the entry can route on `nodes[0].url` to per-page sub-formatters
   (Discord, Threads, and Zillow all do this).

3. **Bump `manifest.json#version`.** Even a patch bump is fine; it just lets
   you confirm the reload picked up your file.

4. **`webpilot_reload_formatters`.** The response includes a `platforms` map
   with each formatter's version. Confirm yours matches what you wrote.

5. **Test on a live tab.** Navigate the user's browser to a matching URL (or
   open one with `browser_create_tab`), then call
   `browser_get_accessibility_tree({tab_id})`. The response will include any
   structured fields your formatter returned alongside the canonical `tree`
   string.

6. **If it errored,** the call returns the raw tree as fallback (per the
   `errorHandling.fallbackToRawTree` manifest flag) — your formatter's error is
   captured in the log ring buffer. Pull it out:

   ```
   webpilot_dev_get_formatter_logs({ platform: 'myplatform' })
   ```

   The response's `entries[]` is the most-recent-first error ring buffer (max
   50 entries; success invocations are not stored as rows). Each entry has
   `timestamp`, `phase` (`format` for formatter errors, `workflow` for workflow
   errors), `message`, `stack` (truncated to 1024 chars), and for workflow
   entries also `workflow`, `params`, `tabId`. The `health` field summarizes
   overall activity: `{ health, lastError, successCount, errorCount,
   lastSuccessAt, lastErrorAt }`. If your formatter is rendering fine but
   `successCount` isn't bumping, that's a clue your matcher isn't activating
   for the URL — re-check the `match` field in the manifest.

7. **Iterate.** Edit → reload → test → check logs. The server stays up the
   whole time.

---

## Iterating on a workflow

Workflows are server-side functions co-located with a formatter, declared in
the formatter's `manifest.json` and implemented in a sibling `workflows.js`.
They receive `{ params, browser, tabId, findInTree }` and use the `browser`
primitive to call back into the same handlers that MCP tools use — so the
visual cursor, per-agent profile routing, etc., all work without an HTTP
round-trip per step.

The dev loop matches formatters:

1. Edit `workflows.js`.
2. Call `webpilot_reload_formatters` (this re-loads both the formatter and its
   workflows).
3. Call `webpilot_run_workflow({ platform, workflow, params, tab_id, intent? })`.
4. On error, `webpilot_dev_get_formatter_logs({ platform })` — workflow errors
   are recorded with `phase: 'workflow'` and include `workflow`, `params`, and
   `tabId` fields you can use to reproduce.
5. Successful runs do NOT show up as rows in the ring buffer (only
   `successCount` and `lastSuccessAt` on the health summary). If you want to
   confirm a workflow actually ran, check the response of `webpilot_run_workflow`
   (it returns the workflow's own return value) or re-fetch the page tree.

The element-targeting selectors that workflows use (`findInTree`) operate on
the **formatted tree string**, not the raw CDP node list — so write your
workflow against the strings your formatter actually emits. The Discord
formatter does this with `name_starts_with: 'Message '` to match composer
textboxes whose accessible name varies per channel / recipient. See
`discord/workflows.js` for the pattern.

---

## When you also need to edit the Chrome extension

Anything under `packages/chrome-extension-unpacked/` (the `click.js`,
`keyboard.js`, `background.js`, etc.) is service-worker code in the user's
Chrome. It does NOT auto-reload when you edit the files. Two options:

- **Tell the user to reload.** Manual: chrome://extensions/ → click the reload
  icon on WebPilot.
- **Call `webpilot_dev_reload_extension`.** The extension acknowledges the
  command, schedules a `chrome.runtime.reload()` ~100ms later, then dies and
  restarts. The WebSocket reconnects in 1-3 seconds. The paired API key
  persists across reload (no re-pair). After calling, wait ~2-3 seconds before
  issuing more `browser_*` tools — they will error with "no extension
  connected" during the gap.

**Per-profile scope (important if WebPilot is paired across multiple Chrome
profiles).** Extension reloads are per-profile — neither path is global:

- The manual `chrome://extensions/` reload icon only affects the Chrome profile
  whose window is currently in front. If you have WebPilot loaded into multiple
  profiles, you have to switch to each profile's window and click reload there
  too — otherwise the other profiles keep running the old code.
- `webpilot_dev_reload_extension` only reloads the *calling agent's* paired
  profile (the server routes the `reload_extension` command to the single
  profile bound to that API key). To reload across all paired profiles in a
  single iteration, either have each paired agent call the tool from its own
  profile, or fall back to the manual `chrome://extensions/` reload in every
  profile.

This is the most common "I edited the extension and my fix isn't live" gotcha
when you're testing the same change against more than one profile at once.

If you bump `manifest.json#version` in the extension too, you can read the
current version off `webpilot_get_formatter_info` (extension version is
included in some responses) or by inspecting `chrome://extensions/` manually.

---

## Common pitfalls

- **Source vs deployed extension copy.** WebPilot ships the extension twice:
  once under `packages/chrome-extension-unpacked/` (source) and once under
  `dist/win-unpacked/resources/chrome-extension/` (built by the Electron
  pipeline). Chrome loads whichever path the user originally pointed at via
  "Load unpacked". If your source edits aren't taking effect even after
  `webpilot_dev_reload_extension`, the loaded path is probably the deployed
  copy — the user needs to repoint Chrome at the source directory.

- **The `error` field in `webpilot_dev_get_formatter_logs` is per-entry.**
  Each entry's `phase` tells you whether it came from the formatter
  (`'format'`) or a workflow (`'workflow'`). The health summary's
  `lastError` is the most recent error of *either* kind.

- **`webpilot_reload_formatters` does NOT call the auto-updater.** It just
  re-reads from disk. If you want the latest formatters from the WebPilot
  GitHub repo, the auto-updater runs hourly on its own — there isn't a manual
  "fetch from remote" tool right now.

- **Workflow declarations must match between manifest and implementation.**
  If `manifest.json#workflows[]` lists `send_message` but `workflows.js`
  doesn't export a `send_message` key (or vice versa), the formatter manager
  logs a warning and skips it. The mismatch shows up in
  `webpilot_dev_get_formatter_logs` as a `phase: 'load'` entry (if the loader
  errored) or simply as "workflow not found" when an agent tries to call it.
