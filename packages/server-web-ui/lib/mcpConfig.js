// MIRROR OF packages/server-{web-ui,for-chrome-extension}/.../mcpConfig.{js,js}
// Keep these two files in sync. The web UI ships the static build; the
// server emits the same template at runtime in request_pairing responses.
// Changes here must be reflected in both files.
//
// Single source of truth for the `.mcp.json` snippet WebPilot tells agents
// to paste. Exposed as both an object builder (`buildMcpServerEntry`) and a
// pre-stringified helper (`buildMcpConfigJson`) so callers can compose either
// a structured config or a ready-to-display JSON string.
//
// Self-check: ensures both packages emit identical JSON for identical inputs.
// If you edit this template, re-run by importing in a node REPL and comparing
// outputs. (Once a test framework is in place, replace with a snapshot test.)

export const MCP_CLIENT_TYPE = 'sse';

export function buildMcpServerEntry({ port, apiKey }) {
  const entry = {
    type: MCP_CLIENT_TYPE,
    url: `http://localhost:${port}/sse`,
  };
  if (apiKey) {
    entry.headers = { 'X-API-Key': apiKey };
  }
  return entry;
}

export function buildMcpConfigJson({ port, apiKey, indent = 2 }) {
  return JSON.stringify(
    { mcpServers: { webpilot: buildMcpServerEntry({ port, apiKey }) } },
    null,
    indent,
  );
}
