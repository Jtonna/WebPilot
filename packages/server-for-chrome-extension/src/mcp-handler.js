const { v4: uuidv4 } = require('uuid');
const crypto = require('node:crypto');
const dns = require('node:dns').promises;
const { buildMcpConfigJson } = require('./lib/mcp-config-template');
const { findInTree } = require('./lib/tree-query');
const formatterLogs = require('./formatter-logs');
const sitePolicy = require('./site-policy');

// Tools that operate on an existing tab_id and therefore need a per-call
// current-URL policy check (checkpoint B in the site-policy gate).
const TAB_ID_TOOLS = new Set([
  'browser_click',
  'browser_type',
  'browser_scroll',
  'browser_get_accessibility_tree',
  'browser_inject_script',
  'browser_execute_js',
  'webpilot_run_workflow',
]);

// Auto-close countdown for tabs that hit a blocked-by-policy check on a
// tab_id-bearing tool. The error response carries the deadline so the agent
// knows the tab is going away on its own.
const AUTO_CLOSE_DELAY_MS = 5000;

// Max script body — 5 MB is more than any reasonable injectable bundle and
// keeps a malicious upstream from streaming until the daemon OOMs.
const MAX_SCRIPT_FETCH_BYTES = 5 * 1024 * 1024;

/**
 * SSRF guard for browser_inject_script. The MCP server (running on the
 * user's machine) is about to fetch an arbitrary URL on behalf of a paired
 * agent. Without restrictions, an attacker that controls an agent (paired
 * via the normal flow but later misused) could ask the daemon to fetch
 * private addresses — 127.0.0.1, 10/8, 169.254/16 (cloud metadata
 * endpoints, file shares, internal admin panels). Block them.
 *
 * We defend against DNS rebinding by resolving the hostname ONCE, checking
 * the resolved IP against the private/loopback list, then issuing the
 * fetch against the IP literal (carrying the original hostname in the
 * `Host:` header so virtual-hosted servers still route correctly). A
 * second TOCTOU lookup at the kernel layer can't redirect us to 127.0.0.1
 * because we hand `fetch` an IP, not a hostname. Post-redirect targets get
 * the same treatment.
 */
function _formatIpForUrl(address, family) {
  if (family === 6) return `[${address}]`;
  return address;
}

/**
 * Resolve a hostname and verify the result is not in the private/loopback
 * blocklist. Returns the resolved address + family on safety; throws on
 * unsafe or unresolvable. Distinguishing throw vs. return keeps the error
 * messaging consistent with the literal-hostname guard above.
 */
async function _safeResolveHost(hostname) {
  // If the caller passed an IP literal directly, we still need to validate
  // it (the literal-check already did this, but be defensive).
  const bare = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
  const isIpv4Literal = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(bare);
  const isIpv6Literal = bare.includes(':');
  if (isIpv4Literal || isIpv6Literal) {
    if (_isPrivateOrLoopbackHost(hostname)) {
      throw new Error(
        `Refusing to fetch script from private / loopback host "${hostname}". ` +
          `browser_inject_script may only fetch from public URLs.`
      );
    }
    return { address: bare, family: isIpv6Literal ? 6 : 4 };
  }

  let lookup;
  try {
    lookup = await dns.lookup(hostname, { family: 0 });
  } catch (e) {
    throw new Error(`DNS lookup failed for "${hostname}": ${e && e.message}`);
  }
  const { address, family } = lookup;
  if (_isPrivateOrLoopbackHost(address)) {
    console.log(
      `[mcp:inject_script] refusing fetch — hostname "${hostname}" resolved to private/loopback address ${address}`
    );
    throw new Error(
      `Refusing to fetch script from private / loopback host "${hostname}". ` +
        `browser_inject_script may only fetch from public URLs.`
    );
  }
  return { address, family };
}
function _isPrivateOrLoopbackHost(hostname) {
  if (typeof hostname !== 'string' || hostname.length === 0) return true;
  const h = hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  // Strip IPv6 brackets if present.
  const bare = h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h;
  // IPv4 literal checks.
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(bare);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true; // link-local incl. cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    return false;
  }
  // IPv6 literal checks (best-effort).
  if (bare.includes(':')) {
    if (bare === '::' || bare === '::1') return true;
    if (bare.startsWith('fc') || bare.startsWith('fd')) return true; // ULA
    if (bare.startsWith('fe80:') || bare.startsWith('fe80::')) return true; // link-local
    return false;
  }
  return false;
}

async function fetchScriptFromUrl(url) {
  const parsedUrl = new URL(url);
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    throw new Error(`Unsupported protocol: ${parsedUrl.protocol}`);
  }
  // First-pass literal check — catches IP-literal URLs without spending a
  // DNS lookup, and gives a fast reject for the obvious cases.
  if (_isPrivateOrLoopbackHost(parsedUrl.hostname)) {
    console.log(
      `[mcp:inject_script] refusing fetch to private/loopback host "${parsedUrl.hostname}"`
    );
    throw new Error(
      `Refusing to fetch script from private / loopback host "${parsedUrl.hostname}". ` +
        `browser_inject_script may only fetch from public URLs.`
    );
  }

  // Pinned-DNS fetch: resolve once, validate the IP, then fetch the IP
  // literal so the kernel can't re-resolve to a private range under us.
  // We follow up to 5 redirects manually, re-resolving each hop.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);

  const MAX_REDIRECTS = 5;
  let currentUrl = parsedUrl;
  let response = null;

  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const hostname = currentUrl.hostname;
      const { address, family } = await _safeResolveHost(hostname);
      const ipForUrl = _formatIpForUrl(address, family);

      // Rebuild the URL with the IP literal in the host portion, preserving
      // path / query / hash / port. Keep the original Host header so SNI +
      // virtual hosting work — Node's fetch will use the URL's host for
      // SNI by default; setting the Host header steers the HTTP-layer
      // routing while the connection target is the pinned IP.
      const ipUrl = new URL(currentUrl.toString());
      ipUrl.hostname = ipForUrl;

      response = await fetch(ipUrl.toString(), {
        signal: controller.signal,
        redirect: 'manual',
        headers: { Host: currentUrl.host },
      });

      // 3xx with Location → resolve next hop, re-validate.
      if (response.status >= 300 && response.status < 400) {
        const loc = response.headers.get('location');
        if (!loc) break; // no location header — treat as final
        if (hop === MAX_REDIRECTS) {
          throw new Error('Too many redirects');
        }
        let nextUrl;
        try {
          nextUrl = new URL(loc, currentUrl);
        } catch (_e) {
          throw new Error(`Invalid redirect target: ${loc}`);
        }
        if (!['http:', 'https:'].includes(nextUrl.protocol)) {
          throw new Error(`Unsupported redirect protocol: ${nextUrl.protocol}`);
        }
        // Literal pre-check on the next hop (cheap reject before DNS).
        if (_isPrivateOrLoopbackHost(nextUrl.hostname)) {
          throw new Error(
            `Script fetch followed a redirect into private host "${nextUrl.hostname}"; refusing.`
          );
        }
        currentUrl = nextUrl;
        continue;
      }
      break; // non-3xx — done following
    }

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }

    // Read with a hard byte cap so a malicious server can't stream
    // gigabytes into the daemon.
    const reader = response.body && response.body.getReader ? response.body.getReader() : null;
    if (reader) {
      const decoder = new TextDecoder('utf-8');
      let total = 0;
      let buf = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_SCRIPT_FETCH_BYTES) {
          try { await reader.cancel(); } catch (_e) { /* ignore */ }
          throw new Error(
            `Script exceeded ${MAX_SCRIPT_FETCH_BYTES} bytes — refusing to inject`
          );
        }
        buf += decoder.decode(value, { stream: true });
      }
      buf += decoder.decode();
      if (!buf.trim()) {
        throw new Error('Fetched script is empty');
      }
      return buf;
    }
    // Fallback path (non-streaming fetch impl): read text + check size.
    const content = await response.text();
    if (content.length > MAX_SCRIPT_FETCH_BYTES) {
      throw new Error(
        `Script exceeded ${MAX_SCRIPT_FETCH_BYTES} bytes — refusing to inject`
      );
    }
    if (!content?.trim()) {
      throw new Error('Fetched script is empty');
    }

    return content;
  } catch (error) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') {
      throw new Error('Script fetch timeout');
    }
    throw error;
  }
}

function createMcpHandler(extensionBridge, pairedKeys, formatterManager, isPairingRequired, options = {}) {
  // Resolve the server port for embedding into pairing notifications / responses.
  // Preference order: explicit option → env var → paths config getter → hard fallback.
  let resolvedPort = options.port || process.env.PORT;
  if (!resolvedPort) {
    try {
      const { getPort } = require('./service/paths');
      resolvedPort = getPort();
    } catch (e) {
      resolvedPort = 3456;
    }
  }
  const serverPort = Number(resolvedPort) || 3456;
  const webUiUrl = `http://localhost:${serverPort}/ui`;
  const sessions = new Map();  // session_id -> { res, queue, mcpApiKey }
  const chromeManager = options.chromeManager || null;

  /**
   * Resolve which Chrome profile this tool call should target.
   *
   * Per-agent routing: each paired-keys entry carries a `profileId` field.
   * When the API key resolves to an entry with a string `profileId`, route
   * to that profile. Legacy entries with `profileId: null` fall back to the
   * server-wide `managedProfile`.
   *
   * The caller (handleToolCall) already has `apiKey` available because the auth
   * gate at the top of processMessage resolved it from session/args.
   *
   * @param {string|null|undefined} apiKey
   * @returns {string} Chrome profile directory name
   */
  function resolveTargetProfile(apiKey) {
    function loadManagedProfile() {
      try {
        const { loadConfig } = require('./service/paths');
        const cfg = loadConfig() || {};
        return cfg.managedProfile || 'Default';
      } catch (e) {
        console.log(`[mcp-handler] resolveTargetProfile fallback to "Default" (${e.message})`);
        return 'Default';
      }
    }

    if (!apiKey) {
      // No key on the call (e.g. an auth-exempt tool that still got here).
      // The auth-exempt tools that don't need routing return earlier in
      // handleToolCall, so this path is defensive only.
      return loadManagedProfile();
    }

    let entry = null;
    try {
      entry = pairedKeys.validateKey(apiKey);
    } catch (e) {
      console.log(`[mcp-handler] resolveTargetProfile: validateKey threw ${e.message}`);
    }
    if (entry && typeof entry.profileId === 'string' && entry.profileId.length > 0) {
      return entry.profileId;
    }
    // Legacy entry (profileId: null) — fall back to managedProfile.
    const managed = loadManagedProfile();
    console.log(
      `[mcp:routing] using managedProfile fallback for legacy key ${apiKey.slice(0, 8)}`
    );
    return managed;
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  /**
   * After ChromeManager restarts Chrome, the extension's WebSocket needs a moment
   * to reconnect. Poll until isConnected(profile) or timeout.
   */
  async function waitForExtensionConnection(profileId, timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (extensionBridge.isConnected(profileId)) {
        console.log(
          `[mcp-handler] extension reconnected for profile="${profileId}" ` +
            `after ${Date.now() - start}ms`
        );
        return true;
      }
      await sleep(250);
    }
    console.log(
      `[mcp-handler] timed out waiting for extension reconnect profile="${profileId}" ` +
        `after ${timeoutMs}ms`
    );
    return false;
  }

  const tools = [
    {
      name: 'browser_create_tab',
      description: 'Create a new browser tab with the specified URL',
      inputSchema: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'The URL to open in the new tab'
          },
          intent: {
            type: 'string',
            description: 'Optional. Short human-readable description of WHY you\'re making this call (e.g. \'opening Discord to find #general\', \'clicking Send after typing message text\'). Used for server-side debug logs and the upcoming Formatters/MCP observability surfaces. Not required, but strongly encouraged for non-trivial flows — it makes traces dramatically easier to debug.'
          },
          api_key: {
            type: 'string',
            description: 'Your API key for authentication. Required if not provided via X-API-Key header.'
          }
        },
        required: ['url']
      }
    },
    {
      name: 'browser_close_tab',
      description: 'Close a browser tab by its ID',
      inputSchema: {
        type: 'object',
        properties: {
          tab_id: {
            type: 'number',
            description: 'The ID of the tab to close'
          },
          intent: {
            type: 'string',
            description: 'Optional. Short human-readable description of WHY you\'re making this call (e.g. \'opening Discord to find #general\', \'clicking Send after typing message text\'). Used for server-side debug logs and the upcoming Formatters/MCP observability surfaces. Not required, but strongly encouraged for non-trivial flows — it makes traces dramatically easier to debug.'
          },
          api_key: {
            type: 'string',
            description: 'Your API key for authentication. Required if not provided via X-API-Key header.'
          }
        },
        required: ['tab_id']
      }
    },
    {
      name: 'browser_get_tabs',
      description: 'Get a list of all open browser tabs',
      inputSchema: {
        type: 'object',
        properties: {
          api_key: {
            type: 'string',
            description: 'Your API key for authentication. Required if not provided via X-API-Key header.'
          }
        }
      }
    },
    {
      name: 'browser_get_accessibility_tree',
      description: 'Get the accessibility tree (a11y DOM) of a browser tab. Output is pre-filtered and optimized for LLM consumption (~97% smaller than raw CDP) — use this for page data extraction instead of browser_execute_js. Platform-specific formatters activate automatically for supported sites and return structured JSON with extra fields (e.g., postCount, listingCount); use webpilot_get_formatter_info to discover available formatters.',
      inputSchema: {
        type: 'object',
        properties: {
          tab_id: {
            type: 'number',
            description: 'The ID of the tab to get the accessibility tree from'
          },
          usePlatformOptimizer: {
            type: 'boolean',
            description: 'Use platform-specific formatting if available (e.g., Threads feed parser). Default: true'
          },
          api_key: {
            type: 'string',
            description: 'Your API key for authentication. Required if not provided via X-API-Key header.'
          }
        },
        required: ['tab_id']
      }
    },
    {
      name: 'browser_inject_script',
      description: 'Inject a script from a URL into a browser tab. The MCP server fetches the script content and injects it into the page. Use keep_injected=true to automatically re-inject on page navigation.',
      inputSchema: {
        type: 'object',
        properties: {
          tab_id: {
            type: 'number',
            description: 'The ID of the tab to inject into'
          },
          script_url: {
            type: 'string',
            description: 'URL to fetch script from (localhost or external)'
          },
          keep_injected: {
            type: 'boolean',
            description: 'If true, automatically re-inject script when page navigates (default: false)'
          },
          api_key: {
            type: 'string',
            description: 'Your API key for authentication. Required if not provided via X-API-Key header.'
          }
        },
        required: ['tab_id', 'script_url']
      }
    },
    {
      name: 'browser_execute_js',
      description: 'Execute arbitrary JavaScript in a browser tab and return the result. Return value must be JSON-serializable. Use ONLY for reading values or computing derived data that the accessibility tree does not already expose. **Do NOT use for navigation, clicking, typing, scrolling, or any DOM manipulation** — those have dedicated tools (`browser_create_tab`, `browser_click`, `browser_type`, `browser_scroll`, `browser_close_tab`) that integrate with WebPilot\'s visual cursor, scroll easing, focus management, and refs system. Using browser_execute_js to click/type/navigate bypasses all of those and produces brittle, hard-to-debug interactions. For page data extraction, prefer browser_get_accessibility_tree which already provides pre-filtered, structured content.',
      inputSchema: {
        type: 'object',
        properties: {
          tab_id: {
            type: 'number',
            description: 'The ID of the tab to execute in'
          },
          code: {
            type: 'string',
            description: 'JavaScript code to execute'
          },
          api_key: {
            type: 'string',
            description: 'Your API key for authentication. Required if not provided via X-API-Key header.'
          }
        },
        required: ['tab_id', 'code']
      }
    },
    {
      name: 'browser_click',
      description: 'Click at specific coordinates, CSS selector, or accessibility tree ref. Uses CDP mouse simulation with visual cursor animation.',
      inputSchema: {
        type: 'object',
        properties: {
          tab_id: {
            type: 'number',
            description: 'The ID of the tab to click in'
          },
          ref: {
            type: 'string',
            description: 'Accessibility tree ref (e.g., "e1", "e2"). Requires prior accessibility tree fetch.'
          },
          selector: {
            type: 'string',
            description: 'CSS selector to find and click (e.g., "a[href*=\\"/search\\"]", "#submit-btn"). Element center will be clicked.'
          },
          x: {
            type: 'number',
            description: 'X coordinate to click (use instead of selector)'
          },
          y: {
            type: 'number',
            description: 'Y coordinate to click (use instead of selector)'
          },
          button: {
            type: 'string',
            enum: ['left', 'right', 'middle'],
            description: 'Mouse button to click (default: left)'
          },
          clickCount: {
            type: 'number',
            description: 'Number of clicks, use 2 for double-click (default: 1)'
          },
          delay: {
            type: 'number',
            description: 'Override delay in ms between press and release. If not provided, uses weighted random 10-90ms (favoring longer delays)'
          },
          showCursor: {
            type: 'boolean',
            description: 'Show visual cursor indicator on screen (default: true)'
          },
          intent: {
            type: 'string',
            description: 'Optional. Short human-readable description of WHY you\'re making this call (e.g. \'opening Discord to find #general\', \'clicking Send after typing message text\'). Used for server-side debug logs and the upcoming Formatters/MCP observability surfaces. Not required, but strongly encouraged for non-trivial flows — it makes traces dramatically easier to debug.'
          },
          api_key: {
            type: 'string',
            description: 'Your API key for authentication. Required if not provided via X-API-Key header.'
          }
        },
        required: ['tab_id']
      }
    },
    {
      name: 'browser_scroll',
      description: 'Scroll to element OR by pixel amount. Uses smooth easing (75ms per 50px). Provide EITHER ref/selector OR pixels, not both.',
      inputSchema: {
        type: 'object',
        properties: {
          tab_id: {
            type: 'number',
            description: 'The ID of the tab to scroll in'
          },
          ref: {
            type: 'string',
            description: 'Accessibility tree ref to scroll into view (mutually exclusive with pixels)'
          },
          selector: {
            type: 'string',
            description: 'CSS selector to scroll into view (mutually exclusive with pixels)'
          },
          pixels: {
            type: 'number',
            description: 'Pixels to scroll, positive=down, negative=up (mutually exclusive with ref/selector)'
          },
          intent: {
            type: 'string',
            description: 'Optional. Short human-readable description of WHY you\'re making this call (e.g. \'opening Discord to find #general\', \'clicking Send after typing message text\'). Used for server-side debug logs and the upcoming Formatters/MCP observability surfaces. Not required, but strongly encouraged for non-trivial flows — it makes traces dramatically easier to debug.'
          },
          api_key: {
            type: 'string',
            description: 'Your API key for authentication. Required if not provided via X-API-Key header.'
          }
        },
        required: ['tab_id']
      }
    },
    {
      name: 'browser_type',
      description: 'Type text into the focused element or element specified by ref/selector. Uses CDP keyboard simulation for real keystrokes that work with React and other frameworks.',
      inputSchema: {
        type: 'object',
        properties: {
          tab_id: {
            type: 'number',
            description: 'The ID of the tab to type in'
          },
          text: {
            type: 'string',
            description: 'The text to type'
          },
          ref: {
            type: 'string',
            description: 'Accessibility tree ref to click first to focus (optional)'
          },
          selector: {
            type: 'string',
            description: 'CSS selector to click first to focus (optional)'
          },
          delay: {
            type: 'number',
            description: 'Delay between keystrokes in ms (default: 50)'
          },
          pressEnter: {
            type: 'boolean',
            description: 'Press Enter key after typing (default: false)'
          },
          intent: {
            type: 'string',
            description: 'Optional. Short human-readable description of WHY you\'re making this call (e.g. \'opening Discord to find #general\', \'clicking Send after typing message text\'). Used for server-side debug logs and the upcoming Formatters/MCP observability surfaces. Not required, but strongly encouraged for non-trivial flows — it makes traces dramatically easier to debug.'
          },
          api_key: {
            type: 'string',
            description: 'Your API key for authentication. Required if not provided via X-API-Key header.'
          }
        },
        required: ['tab_id', 'text']
      }
    },
    {
      name: 'request_pairing',
      description: 'Initiate pairing. **Skip this tool if you already have a valid API key** (sent via the X-API-Key header or the api_key argument) — calling it in that case will short-circuit and tell you so. Just call browser tools directly; the server resolves your bound profile from the key. **Asynchronous flow** (only used by un-paired callers): returns immediately with a `pairing_id` and current `status` (\'pending\', \'approved\', \'denied\', or \'expired\'). If \'pending\', the user has not yet approved — tell the human to approve in the WebPilot UI (a system notification will fire pointing at the UI), then on a later turn call `check_pairing_status` with the `pairing_id` to get your `api_key`. Idempotent: if you call this twice with the same `agent_name`, you get the same `pairing_id` back, **unless** the existing pending entry has expired (pending pairings expire after 24 hours of inactivity), in which case a fresh `pairing_id` is minted. Do NOT keep calling browser tools while waiting — surface the approval URL to the human, stop, and resume after they confirm.',
      inputSchema: {
        type: 'object',
        properties: {
          agent_name: {
            type: 'string',
            description: 'A human-readable name to identify this agent in the approval UI (e.g. "Claude Code", "Cursor", "My Script").'
          }
        },
        required: ['agent_name']
      }
    },
    {
      name: 'check_pairing_status',
      description: 'Poll the status of a pending pairing request. Pass the `pairing_id` you received from `request_pairing`. Returns one of: status=\'pending\' (user has not yet approved — wait, then call this tool again on a later turn), status=\'approved\' (response includes your `api_key` — store it and use it for all future tool calls via the X-API-Key header or `api_key` argument), status=\'denied\' (the user rejected this pairing — do not retry automatically; ask the human if they want to try again with a different agent_name), or status=\'expired\' (the pending pairing aged out — pending requests expire after 24 hours of inactivity; call `request_pairing` again with the same `agent_name` to mint a fresh `pairing_id`).',
      inputSchema: {
        type: 'object',
        properties: {
          pairing_id: {
            type: 'string',
            description: 'The pairing_id returned from a previous call to request_pairing.'
          }
        },
        required: ['pairing_id']
      }
    },
    {
      name: 'webpilot_get_formatter_info',
      description: 'Get information about available platform-specific accessibility tree formatters and instructions for writing custom platform optimizers. Use this to discover what sites have optimized formatters and to learn how to create your own.',
      inputSchema: {
        type: 'object',
        properties: {
          platform: {
            type: 'string',
            description: 'Optional: filter to a specific platform (e.g., "threads", "zillow"). Omit to get info on all platforms.'
          }
        }
      }
    },
    {
      name: 'webpilot_reload_formatters',
      description: 'DEVELOPER TOOL. Reload all formatters (both auto-updated and custom) without restarting the server. Use this after adding or modifying custom formatter files in the custom-formatters directory (path is in the response of webpilot_get_formatter_info under customFormatterDir). Returns the updated formatter state including version numbers — verify the version bumped to confirm your edits took effect. This is the formatter dev iteration cycle: edit file → call this → call webpilot_run_workflow or browser_get_accessibility_tree to test → if it broke, call webpilot_dev_get_formatter_logs to see the error.',
      inputSchema: {
        type: 'object',
        properties: {}
      }
    },
    {
      name: 'webpilot_dev_get_formatter_logs',
      description: 'DEVELOPER TOOL. Get health summary + recent error log entries for one platform formatter. Use this when iterating on a formatter or workflow to see why it failed — each entry includes the error message, truncated stack trace, phase (`format` for formatter errors during accessibility-tree rendering, `workflow` for errors raised inside `webpilot_run_workflow`), the workflow name + params + tabId for workflow errors, and an ISO timestamp. The `health` field summarizes overall activity ({ health: "healthy"|"unhealthy"|"unknown", lastError, successCount, errorCount, lastSuccessAt, lastErrorAt }). Note: only error entries are stored in the ring buffer; successful invocations bump counters and update `lastSuccessAt` but produce no log row. Pair with webpilot_reload_formatters to iterate quickly: edit → reload → run → call this if anything broke. Returns { platform, health, entries: [...], totalReturned, requestedLimit }.',
      inputSchema: {
        type: 'object',
        properties: {
          platform: {
            type: 'string',
            description: "Formatter name (e.g. 'discord', 'threads'). See webpilot_get_formatter_info for the list."
          },
          limit: {
            type: 'number',
            description: 'Max number of entries to return (default 20, max 50 — the ring buffer caps at 50 per formatter, newest first).'
          }
        },
        required: ['platform']
      }
    },
    {
      name: 'webpilot_dev_reload_extension',
      description: 'DEVELOPER TOOL. Fully restart the WebPilot Chrome extension service worker via chrome.runtime.reload(). Use this after editing files under packages/chrome-extension-unpacked/ (click.js, keyboard.js, background.js, etc.) — without it, Chrome continues running the previously-loaded service-worker code and your edits are invisible to live tools. **Per-profile scope:** this reload only targets the single Chrome profile bound to the caller\'s API key. Other Chrome profiles that also have WebPilot loaded keep running their previously-loaded code; to reload everywhere, each paired agent must call this tool from its own profile, or the user must manually reload via chrome://extensions/ inside each profile. Note: the extension WebSocket disconnects on reload and reconnects in ~1-3 seconds; the paired API key persists across the reload (no re-pairing needed). The reload command itself is acknowledged BEFORE the worker restarts, so this tool returns success even though the WS will momentarily drop. Wait 2-3 seconds before issuing other browser_* tools.',
      inputSchema: {
        type: 'object',
        properties: {
          api_key: {
            type: 'string',
            description: 'Your API key for authentication. Required if not provided via X-API-Key header.'
          }
        }
      }
    },
    {
      name: 'webpilot_run_workflow',
      description: 'Execute a platform-specific workflow exposed by an accessibility tree formatter. Workflows bundle multiple primitive actions (click, type, scroll, etc.) into a single named operation — much cheaper than multiple tool calls. Use webpilot_get_formatter_info to discover available workflows per platform. Each workflow has typed parameters; pass them via the `params` argument.',
      inputSchema: {
        type: 'object',
        properties: {
          platform: {
            type: 'string',
            description: "Formatter name (e.g. 'discord', 'threads'). See webpilot_get_formatter_info."
          },
          workflow: {
            type: 'string',
            description: "Workflow name (e.g. 'send_message'). See webpilot_get_formatter_info."
          },
          params: {
            type: 'object',
            description: 'Workflow-specific parameters as declared in the workflow definition.'
          },
          tab_id: {
            type: 'number',
            description: 'The browser tab to run the workflow against.'
          },
          intent: {
            type: 'string',
            description: "Optional. Why you are running this workflow (debug log)."
          },
          api_key: {
            type: 'string',
            description: 'Your API key for authentication. Required if not provided via X-API-Key header.'
          }
        },
        required: ['platform', 'workflow', 'tab_id']
      }
    },
    {
      name: 'browser_request_chain',
      description: 'Execute multiple tool calls sequentially and return combined results. Best used for sequential browser operations that do not need intermediate LLM reasoning between steps (e.g., click then get accessibility tree). Each step can reference results from prior steps using $N.path.to.value syntax (e.g., $0.tab_id references the tab_id field from step 0). Validates all tool names before execution begins.',
      inputSchema: {
        type: 'object',
        properties: {
          steps: {
            type: 'array',
            description: 'Array of tool calls to execute in order. Each step specifies a tool name and its arguments.',
            items: {
              type: 'object',
              properties: {
                tool: {
                  type: 'string',
                  description: 'The name of the tool to call (e.g., browser_create_tab). Cannot be browser_request_chain.'
                },
                arguments: {
                  type: 'object',
                  description: 'Arguments to pass to the tool. String values matching $N.path.to.value pattern will be resolved from prior step results.'
                }
              },
              required: ['tool', 'arguments']
            }
          },
          return_mode: {
            type: 'string',
            enum: ['all', 'last'],
            description: 'What to return: "all" returns results from every step (default), "last" returns only the final step result.',
            default: 'all'
          },
          api_key: {
            type: 'string',
            description: 'Your API key for authentication. Required if not provided via X-API-Key header.'
          }
        },
        required: ['steps']
      }
    }
  ];

  function handleSSE(req, res) {
    const sessionId = uuidv4();
    const mcpApiKey = req.headers['x-api-key'] || req.query.apiKey || null;

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    // Store session with queue and MCP client API key
    sessions.set(sessionId, { res, queue: [], mcpApiKey });

    // Send endpoint URL as first event (matching backend pattern exactly)
    res.write(`event: endpoint\ndata: /message?session_id=${sessionId}\n\n`);

    // Keep-alive loop that also flushes queue
    const interval = setInterval(() => {
      const session = sessions.get(sessionId);
      if (session) {
        // Flush any queued messages
        while (session.queue.length > 0) {
          const msg = session.queue.shift();
          res.write(`event: message\ndata: ${JSON.stringify(msg)}\n\n`);
        }
      }
    }, 100);  // Check queue frequently

    // Separate keepalive on longer interval
    const keepAlive = setInterval(() => {
      res.write(': keepalive\n\n');
    }, 30000);

    req.on('close', () => {
      clearInterval(interval);
      clearInterval(keepAlive);
      sessions.delete(sessionId);
      console.log(`Session ${sessionId} closed`);
    });

    console.log(`Session ${sessionId} started`);
  }

  async function handleMessage(req, res) {
    const sessionId = req.query.session_id;
    const session = sessions.get(sessionId);

    if (!session) {
      return res.status(400).json({ error: 'Invalid session' });
    }

    // Update session API key if provided on this request (allows late auth)
    const reqApiKey = req.headers['x-api-key'] || req.query.apiKey || null;
    if (reqApiKey) {
      session.mcpApiKey = reqApiKey;
    }

    const message = req.body;
    const response = await processMessage(message, session);

    if (response) {
      session.queue.push(response);
    }

    // Return 202 Accepted (matching backend pattern)
    res.status(202).send('');
  }

  const AUTH_ERROR_MESSAGE = 'Authentication required. Include your API key as the X-API-Key header or as the api_key argument on the tool call. If you don\'t have a key — or your previous one was revoked — call request_pairing with a memorable agent_name to start a new pairing flow.';

  async function processMessage(message, session) {
    const { method, id, params } = message;

    if (method === 'initialize') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'WebPilot', version: '2.0.1' },
          instructions: `WebPilot is an MCP server that controls a real Chrome browser via a paired Chrome extension. All browser interactions happen in the user's actual browser, not a headless instance.

**Authentication — read this first.** Every browser_* tool requires a paired API key. If you do NOT already have one for this server (i.e., your client config has no X-API-Key header / api_key parameter): your FIRST action must be to call \`request_pairing\` with a memorable agent_name. That tool returns immediately with a pairing_id and status — read its description and follow the async flow (surface the approval URL to the human, stop calling browser_* tools, poll \`check_pairing_status\` later). Skipping this step means every browser tool call will fail with an authentication error. The tools \`request_pairing\`, \`check_pairing_status\`, \`webpilot_get_formatter_info\`, and \`webpilot_dev_get_formatter_logs\` do NOT require a key.

Tool workflow: Use browser_get_tabs to find open tabs, then browser_get_accessibility_tree to read page content, then use the refs returned (e1, e2, etc.) with browser_click, browser_scroll, and browser_type for precise element targeting. Chain these operations to navigate and interact with pages.

Accessibility tree: The tree from browser_get_accessibility_tree is already heavily pre-filtered and optimized for LLM consumption — roughly 97% smaller than raw CDP output. Do not use browser_execute_js to filter or extract data from pages. The tree already contains what you need.

Platform formatters: Supported sites (e.g., Threads, Zillow) automatically activate platform-specific formatters that return structured JSON with extra fields like postCount and listingCount. Check the response object for these additional fields. Use webpilot_get_formatter_info to discover which platforms have built-in formatters and to learn how to write custom platform optimizers for sites without built-in support.

Refs: Element identifiers (e1, e2, etc.) are returned in the accessibility tree. Pass them to click, scroll, and type tools for precise targeting. Refs are scoped to the most recent tree fetch for a given tab.

browser_request_chain: Batches sequential tool calls (e.g., click then get tree) into a single round-trip when you do not need intermediate LLM reasoning between steps. Steps can reference prior results using $N.path.to.value syntax.

browser_execute_js: Reserve for actions that genuinely require JavaScript execution, such as form manipulation or custom interactions. Do not use it to extract or filter page data — the accessibility tree already handles that.

**Developer mode — formatter & workflow iteration.** WebPilot ships dev tools for the inner loop of building/fixing accessibility-tree formatters and workflows. They are always exposed (no flag) so any agent can use them when the user asks you to fix or extend a formatter. The cycle:

1. \`webpilot_get_formatter_info\` — see which platforms have formatters, their versions, and where to drop new ones (\`customFormatterDir\`).
2. Edit files under that directory (or under \`accessibility-tree-formatters/<platform>/\` in the source repo, then ship via the auto-updater).
3. \`webpilot_reload_formatters\` — re-loads from disk into memory. Verify the version in the response bumped.
4. Test by calling \`browser_get_accessibility_tree\` or \`webpilot_run_workflow\` against a real page.
5. If it broke, \`webpilot_dev_get_formatter_logs\` with \`platform: '<name>'\` returns the most recent errors with stack traces, plus a health summary ({ health, lastError, successCount, errorCount, lastSuccess/ErrorAt }). The ring buffer only stores errors — successful invocations bump \`successCount\` and \`lastSuccessAt\` but don't add a row.
6. After editing the Chrome extension itself (handlers/click.js, keyboard.js, background.js, etc.), call \`webpilot_dev_reload_extension\` — chrome.runtime.reload() inside the extension. WS drops + reconnects in 1-3s; the API key persists. Wait ~2-3s before issuing more browser_* tools. **Per-profile scope:** extension reloads are profile-scoped — \`webpilot_dev_reload_extension\` only reloads the calling agent's paired Chrome profile, and the manual chrome://extensions/ reload icon only affects the profile that's currently in front. If WebPilot is paired across multiple profiles and you edited shared extension code, each profile must be reloaded independently (one tool call per paired agent, or one manual chrome://extensions/ reload per profile).

Naming convention: \`webpilot_dev_*\` = developer-iteration tools. \`webpilot_*\` (without dev) = production formatter/workflow inspection/dispatch. \`browser_*\` = direct CDP-backed primitives.`
        }
      };
    }

    if (method === 'notifications/initialized') {
      return null;  // No response needed
    }

    if (method === 'tools/list') {
      return {
        jsonrpc: '2.0',
        id,
        result: { tools }
      };
    }

    if (method === 'tools/call') {
      // Auth gate: exempt the pairing handshake (request_pairing,
      // check_pairing_status) and the strictly read-only formatter inspection
      // tools (webpilot_get_formatter_info, webpilot_dev_get_formatter_logs).
      // Every mutating tool — including webpilot_reload_formatters, which
      // reloads formatter code from disk and therefore mutates server state —
      // requires a valid paired API key. browser_*, webpilot_dev_reload_extension,
      // and webpilot_run_workflow are all auth-gated.
      const noAuthRequired =
        params.name === 'request_pairing' ||
        params.name === 'check_pairing_status' ||
        params.name === 'webpilot_get_formatter_info' ||
        params.name === 'webpilot_dev_get_formatter_logs';
      // Resolved API key for the call. Used for both auth and per-agent
      // profile routing. For auth-exempt tools that don't carry a key, this
      // stays null and resolveTargetProfile() falls back gracefully.
      const effectiveKey = session.mcpApiKey || params.arguments?.api_key || null;
      if (!noAuthRequired && isPairingRequired()) {
        if (!effectiveKey || !pairedKeys.validateKey(effectiveKey)) {
          console.log(`[auth] Rejected unauthenticated tool call: ${params.name}`);
          return {
            jsonrpc: '2.0',
            id,
            error: { code: -32001, message: AUTH_ERROR_MESSAGE }
          };
        }
        console.log(`[auth] Authorized tool call: ${params.name}`);
        pairedKeys.touchKey(effectiveKey);
      }

      // Surface caller-supplied intent for navigational tools into the server
      // log so operators (and the upcoming Formatters/MCP observability
      // surfaces) can see WHY each step was taken. The `intent` arg is purely
      // additive — its presence is optional and is not validated beyond the
      // type check below.
      if (typeof params.arguments?.intent === 'string' && params.arguments.intent.length > 0) {
        console.log(`[mcp:intent] ${params.name}: ${params.arguments.intent}`);
      }

      // Site-policy gate. Runs AFTER auth so we have the agent
      // identity available for per-agent overrides, and BEFORE the tool
      // dispatches so a blocked site never reaches the extension. A null
      // return means "allowed — proceed". A non-null return is the full MCP
      // result envelope and short-circuits the dispatch.
      try {
        const blocked = await _enforceSitePolicy(params.name, params.arguments || {}, effectiveKey);
        if (blocked) {
          return { jsonrpc: '2.0', id, result: blocked };
        }
      } catch (err) {
        console.log(`[policy] enforcement threw: ${err.message} — failing open`);
      }

      try {
        const result = await handleToolCall(params, effectiveKey);
        return {
          jsonrpc: '2.0',
          id,
          result
        };
      } catch (error) {
        return {
          jsonrpc: '2.0',
          id,
          error: { code: -32000, message: error.message }
        };
      }
    }

    return {
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Method not found: ${method}` }
    };
  }

  function resolveReferences(args, previousResults) {
    if (args === null || args === undefined) return args;
    if (typeof args === 'string') {
      const refMatch = args.match(/^\$(\d+)\.(.*)/);
      if (!refMatch) return args;
      const stepIndex = parseInt(refMatch[1], 10);
      const path = refMatch[2];
      if (stepIndex >= previousResults.length) {
        throw new Error(`Reference $${stepIndex}: step ${stepIndex} has not executed yet (only ${previousResults.length} steps completed)`);
      }
      let parsed;
      try {
        parsed = JSON.parse(previousResults[stepIndex].content[0].text);
      } catch (e) {
        throw new Error(`Reference $${stepIndex}: could not parse result from step ${stepIndex}`);
      }
      const segments = path.split('.');
      let value = parsed;
      for (const segment of segments) {
        if (value === null || value === undefined || typeof value !== 'object') {
          throw new Error(`Reference $${stepIndex}.${path}: could not resolve '${segment}' in step ${stepIndex} result`);
        }
        value = value[segment];
      }
      if (value === undefined) {
        throw new Error(`Reference $${stepIndex}.${path}: could not resolve '${segments[segments.length - 1]}' in step ${stepIndex} result`);
      }
      return value;
    }
    if (Array.isArray(args)) {
      return args.map(item => resolveReferences(item, previousResults));
    }
    if (typeof args === 'object') {
      const resolved = {};
      for (const [key, val] of Object.entries(args)) {
        resolved[key] = resolveReferences(val, previousResults);
      }
      return resolved;
    }
    return args; // numbers, booleans, etc. pass through
  }

  // ----------------------------------------------------------------------
  // Internal browser-primitive helpers
  // ----------------------------------------------------------------------
  //
  // The MCP tool dispatch in `handleToolCall` and the workflow primitives
  // exposed to `webpilot_run_workflow` both need the same underlying
  // operations: create a tab, click a ref, fetch + format the a11y tree,
  // etc. To keep the two in step, we factor each one into a small helper
  // here that:
  //   - resolves the target profile from the api_key (per-agent routing)
  //   - guards on extension connection
  //   - sends the command via extensionBridge.sendCommand
  //   - returns the raw result object (NOT the MCP `{ content: [...] }`
  //     envelope) so workflows get plain objects to work with
  //
  // The MCP tool branches wrap each helper in the `{ content: [{ ... }] }`
  // envelope; the workflow primitives return the helper's result directly.
  // ----------------------------------------------------------------------

  /**
   * Ensure the extension is connected for the resolved profile. Throws an
   * Error with a helpful message if not. Returns the resolved profileId.
   */
  function _requireExtensionConnected(apiKey) {
    const targetProfile = resolveTargetProfile(apiKey);
    if (!extensionBridge.isConnected(targetProfile)) {
      throw new Error(
        `No browser instance connected for profile '${targetProfile}'. Call browser_create_tab to launch Chrome.`
      );
    }
    return targetProfile;
  }

  async function _browserCreateTab({ url }, apiKey) {
    const targetProfile = resolveTargetProfile(apiKey);

    if (chromeManager) {
      console.log(`[mcp-handler] browser_create_tab readiness gate for profile="${targetProfile}"`);
      let ensureResult;
      try {
        ensureResult = await chromeManager.ensureReady([targetProfile]);
        console.log(`[mcp-handler] chromeManager.ensureReady result:`, ensureResult);
      } catch (e) {
        console.log(`[mcp-handler] chromeManager.ensureReady threw: ${e.message}`);
        throw new Error(`Failed to ensure Chrome readiness: ${e.message}`);
      }

      if (ensureResult && (ensureResult.action === 'restart' || ensureResult.action === 'launch')) {
        console.log(
          `[mcp-handler] waiting up to 10s for extension WS profile="${targetProfile}" (action=${ensureResult.action})`
        );
        const ok = await waitForExtensionConnection(targetProfile, 10000);
        if (!ok) {
          throw new Error(
            `Chrome was ${ensureResult.action}ed for profile "${targetProfile}" but the WebPilot extension ` +
              `did not (re)connect within 10s. Ensure the extension is installed and loaded in this profile.`
          );
        }
      }
    }

    if (!extensionBridge.isConnected(targetProfile)) {
      throw new Error(
        `No browser instance connected for profile '${targetProfile}'. Call browser_create_tab to launch Chrome.`
      );
    }

    return await extensionBridge.sendCommand(targetProfile, 'create_tab', { url });
  }

  async function _browserCloseTab({ tab_id }, apiKey) {
    const targetProfile = _requireExtensionConnected(apiKey);
    return await extensionBridge.sendCommand(targetProfile, 'close_tab', { tab_id });
  }

  async function _browserGetTabs(_args, apiKey) {
    const targetProfile = _requireExtensionConnected(apiKey);
    return await extensionBridge.sendCommand(targetProfile, 'get_tabs', {});
  }

  async function _browserClick(args, apiKey) {
    const targetProfile = _requireExtensionConnected(apiKey);
    return await extensionBridge.sendCommand(targetProfile, 'click', {
      tab_id: args.tab_id,
      ref: args.ref,
      selector: args.selector,
      x: args.x,
      y: args.y,
      button: args.button || 'left',
      clickCount: args.clickCount || 1,
      delay: args.delay,
      showCursor: args.showCursor ?? true
    });
  }

  async function _browserScroll(args, apiKey) {
    const targetProfile = _requireExtensionConnected(apiKey);
    // The extension command takes { tab_id, ref?, selector?, pixels? } —
    // direction/amount are conveniences for workflow callers that get
    // translated into positive/negative pixel deltas here.
    let pixels = args.pixels;
    if (pixels === undefined && args.direction) {
      const amount = typeof args.amount === 'number' ? args.amount : 300;
      const dir = String(args.direction).toLowerCase();
      if (dir === 'down') pixels = amount;
      else if (dir === 'up') pixels = -amount;
    }
    return await extensionBridge.sendCommand(targetProfile, 'scroll', {
      tab_id: args.tab_id,
      ref: args.ref,
      selector: args.selector,
      pixels
    });
  }

  async function _browserType(args, apiKey) {
    const targetProfile = _requireExtensionConnected(apiKey);
    return await extensionBridge.sendCommand(targetProfile, 'type', {
      tab_id: args.tab_id,
      text: args.text,
      ref: args.ref,
      selector: args.selector,
      delay: args.delay || 50,
      pressEnter: args.pressEnter || false
    });
  }

  /**
   * Fetch the accessibility tree, run it through the formatter, push refs
   * back to the extension (so subsequent click/type/scroll-by-ref work),
   * and return the parsed result object:
   *   { tree, elementCount, refs, ...extras }
   *
   * Returns the parsed object directly — callers in the MCP tool branch
   * wrap it in `{ content: [{ type: 'text', text: JSON.stringify(...) }] }`.
   */
  async function _browserGetAccessibilityTree(args, apiKey) {
    const targetProfile = _requireExtensionConnected(apiKey);
    const a11yParams = {
      tab_id: args.tab_id,
      usePlatformOptimizer: args.usePlatformOptimizer ?? true
    };
    const rawResult = await extensionBridge.sendCommand(targetProfile, 'get_accessibility_tree', a11yParams);
    const { nodes, url, tabId, usePlatformOptimizer } = rawResult;

    const formatterUrl = usePlatformOptimizer === false ? null : url;

    let formatted;
    try {
      formatted = formatterManager.formatTree(formatterUrl, nodes);
    } catch (err) {
      console.warn('[mcp-handler] Formatter error, falling back to default:', err.message);
      formatted = formatterManager.formatTree(null, nodes);
    }

    const { tree, elementCount, refs, ...extras } = formatted;

    // Build ancestry context for each ref using extractAncestryContext from default formatter
    if (refs && Object.keys(refs).length > 0) {
      try {
        const { getFormatterDir } = require('./service/paths');
        const { extractAncestryContext } = require(require('path').join(getFormatterDir(), 'default.js'));

        const nodeMap = new Map();
        for (const node of nodes) {
          nodeMap.set(node.nodeId, node);
        }

        const backendNodeMap = new Map();
        for (const node of nodes) {
          if (node.backendDOMNodeId) {
            backendNodeMap.set(node.backendDOMNodeId, node);
          }
        }

        const refContexts = {};
        for (const [ref, backendDOMNodeId] of Object.entries(refs)) {
          const node = backendNodeMap.get(backendDOMNodeId);
          if (node) {
            refContexts[ref] = extractAncestryContext(node, nodeMap);
          }
        }

        extensionBridge.notify(targetProfile, {
          type: 'store_refs',
          tabId,
          refs,
          refContexts
        });
      } catch (err) {
        console.warn('[mcp-handler] Failed to build ref contexts:', err.message);
        extensionBridge.notify(targetProfile, {
          type: 'store_refs',
          tabId,
          refs,
          refContexts: null
        });
      }
    }

    return { tree, elementCount, refs, ...extras };
  }

  /**
   * Build the `browser` primitives object passed to workflow `run()`
   * implementations. Internally each method calls the same `_browser*`
   * helper used by the MCP tool dispatch, so workflows execute
   * server-side without HTTP/SSE roundtrips.
   *
   * Each primitive resolves the target Chrome profile from the caller's
   * `apiKey` (per-agent routing) and forwards to `extensionBridge.sendCommand`.
   * The shape of the returned object — `{ getAccessibilityTree, click, type,
   * scroll, getTabs, createTab }` — is the public contract that workflow
   * authors rely on. Add fields here in lockstep with new workflow needs;
   * do not remove or rename existing fields without bumping the formatter
   * manifest schema.
   *
   * @param {string|null} apiKey  Resolved API key for the calling agent
   * @returns {{
   *   getAccessibilityTree: Function,
   *   click: Function,
   *   type: Function,
   *   scroll: Function,
   *   getTabs: Function,
   *   createTab: Function
   * }}
   */
  function buildBrowserPrimitives(apiKey) {
    return {
      getAccessibilityTree: ({ tab_id, usePlatformOptimizer } = {}) =>
        _browserGetAccessibilityTree({ tab_id, usePlatformOptimizer }, apiKey),
      click: ({ tab_id, ref, selector, x, y, button, clickCount, delay, showCursor } = {}) =>
        _browserClick({ tab_id, ref, selector, x, y, button, clickCount, delay, showCursor }, apiKey),
      type: ({ tab_id, text, ref, selector, delay, pressEnter } = {}) =>
        _browserType({ tab_id, text, ref, selector, delay, pressEnter }, apiKey),
      scroll: ({ tab_id, ref, selector, pixels, direction, amount } = {}) =>
        _browserScroll({ tab_id, ref, selector, pixels, direction, amount }, apiKey),
      getTabs: () => _browserGetTabs({}, apiKey),
      createTab: ({ url } = {}) => _browserCreateTab({ url }, apiKey)
    };
  }

  /**
   * Validate workflow params against the workflow's `parameters` declaration.
   * Returns null on success or an error message string. Supports basic
   * type checks (string/number/boolean/object/array) — no full JSON Schema
   * library, which matches the format the manifest declares per param.
   */
  function _validateWorkflowParams(declared, provided) {
    if (!declared || typeof declared !== 'object') return null;
    for (const [pname, pdecl] of Object.entries(declared)) {
      const expectedType = pdecl && pdecl.type;
      const value = provided && provided[pname];
      if (value === undefined || value === null) {
        // Treat all declared params as optional unless explicitly marked
        // required (which the v1 schema doesn't carry yet). The workflow
        // implementation is responsible for asserting required fields.
        continue;
      }
      if (!expectedType) continue;
      const actualType = Array.isArray(value) ? 'array' : typeof value;
      const ok =
        (expectedType === 'string'  && actualType === 'string')  ||
        (expectedType === 'number'  && actualType === 'number')  ||
        (expectedType === 'boolean' && actualType === 'boolean') ||
        (expectedType === 'object'  && actualType === 'object' && !Array.isArray(value)) ||
        (expectedType === 'array'   && actualType === 'array');
      if (!ok) {
        return `Parameter "${pname}" expected type ${expectedType}, got ${actualType}.`;
      }
    }
    return null;
  }

  // ----------------------------------------------------------------------
  // Site-policy gate.
  //
  // Two checkpoints:
  //   A. `browser_create_tab` — gate on args.url before the create_tab
  //      command is dispatched.
  //   B. Every other tool taking a `tab_id` (see TAB_ID_TOOLS) — resolve
  //      the tab's current URL via the extension, then gate. If blocked,
  //      schedule a delayed `close_tab` so the agent isn't stuck on a
  //      forbidden page.
  //
  // Always-allowed tools: browser_get_tabs, browser_close_tab,
  // request_pairing, check_pairing_status, every webpilot_* and webpilot_dev_*
  // — they either don't touch a tab, or the agent legitimately needs them
  // to clean up. Auth is enforced separately.
  // ----------------------------------------------------------------------

  /**
   * Wrap a JSON-rpc result-shaped MCP envelope around a "blocked by policy"
   * response. Body shape:
   *   { ok: false, error: 'site blocked by policy', domain, policySource,
   *     [tabId, tabWillCloseAt, tabCloseInSeconds] }
   */
  function _buildBlockedResponse({ verdict, tabId, willCloseAt, closeInSeconds }) {
    const body = {
      ok: false,
      error: 'site blocked by policy',
      domain: verdict.domain,
      policySource: verdict.source,
    };
    if (typeof tabId === 'number') {
      body.tabId = tabId;
      if (willCloseAt) body.tabWillCloseAt = willCloseAt;
      if (typeof closeInSeconds === 'number') body.tabCloseInSeconds = closeInSeconds;
    }
    return {
      content: [{ type: 'text', text: JSON.stringify(body, null, 2) }],
      isError: true,
    };
  }

  /**
   * Schedule the extension to close the offending tab after the standard
   * AUTO_CLOSE_DELAY_MS countdown. Failures are logged but never thrown —
   * the caller has already returned the blocked-error to the agent.
   */
  function _scheduleAutoClose(profileId, tabId) {
    if (!profileId || typeof tabId !== 'number') return;
    setTimeout(() => {
      extensionBridge
        .sendCommand(profileId, 'close_tab', { tab_id: tabId })
        .then(() => {
          console.log(
            `[policy] auto-closed blocked tab tabId=${tabId} profile="${profileId}"`
          );
        })
        .catch((err) => {
          console.log(
            `[policy] auto-close failed for tabId=${tabId} profile="${profileId}": ${err.message}`
          );
        });
    }, AUTO_CLOSE_DELAY_MS);
  }

  /**
   * Look up the current URL for a given tab via `browser_get_tabs`. Returns
   * the URL string or null if the tab isn't present. The extension already
   * publishes a tabs list; we reuse the same RPC rather than introduce a
   * separate "get one tab" command. The call adds a single extra
   * roundtrip per checkpoint-B tool call — acceptable for v1; if it shows
   * up as a hot spot, the extension could cache the active URL on every
   * page state change.
   */
  async function _resolveTabUrl(profileId, tabId) {
    if (!profileId || typeof tabId !== 'number') return null;
    try {
      const tabsResult = await extensionBridge.sendCommand(profileId, 'get_tabs', {});
      const tabs = Array.isArray(tabsResult && tabsResult.tabs)
        ? tabsResult.tabs
        : Array.isArray(tabsResult)
          ? tabsResult
          : [];
      for (const t of tabs) {
        if (t && Number(t.id) === Number(tabId)) {
          return typeof t.url === 'string' ? t.url : null;
        }
      }
    } catch (err) {
      console.log(
        `[policy] _resolveTabUrl failed for tabId=${tabId}: ${err.message}`
      );
    }
    return null;
  }

  /**
   * Apply the site-policy gate for an inbound tool call. Returns null when
   * the call is allowed; otherwise returns the MCP envelope to return to
   * the caller (and, for checkpoint B, schedules the auto-close).
   *
   * @param {string} name      tool name
   * @param {object} args      tool arguments
   * @param {string|null} apiKey
   * @returns {object|null}
   */
  async function _enforceSitePolicy(name, args, apiKey) {
    // Tools that never touch a site — always allowed.
    if (
      name === 'browser_get_tabs' ||
      name === 'browser_close_tab' ||
      name === 'browser_request_chain'
    ) {
      return null;
    }

    const agentId = apiKey ? sitePolicy.resolveAgentIdFromApiKey(apiKey) : null;

    // Checkpoint A: browser_create_tab gates on args.url.
    if (name === 'browser_create_tab') {
      const url = args && args.url;
      if (typeof url !== 'string' || url.length === 0) return null;
      const verdict = sitePolicy.isAllowed(agentId, url);
      if (!verdict.allowed) {
        console.log(
          `[policy] checkpoint-A BLOCK tool=browser_create_tab url=${url} ` +
            `domain=${verdict.domain} source=${verdict.source}`
        );
        return _buildBlockedResponse({ verdict });
      }
      return null;
    }

    // Checkpoint B: tools that operate on an existing tab_id.
    if (TAB_ID_TOOLS.has(name)) {
      const tabId = args && (args.tab_id ?? args.tabId);
      if (typeof tabId !== 'number') return null; // let the regular handler raise the missing-arg error
      const profileId = resolveTargetProfile(apiKey);
      if (!extensionBridge.isConnected(profileId)) {
        // Don't block on a missing extension — the regular handler will
        // surface the "not connected" error which is the more useful one.
        return null;
      }
      const currentUrl = await _resolveTabUrl(profileId, tabId);
      if (!currentUrl) return null; // tab not found / not navigated yet — let it through
      const verdict = sitePolicy.isAllowed(agentId, currentUrl);
      if (verdict.allowed) return null;
      const willCloseAt = new Date(Date.now() + AUTO_CLOSE_DELAY_MS).toISOString();
      console.log(
        `[policy] checkpoint-B BLOCK tool=${name} tabId=${tabId} url=${currentUrl} ` +
          `domain=${verdict.domain} source=${verdict.source} — scheduling auto-close in ${AUTO_CLOSE_DELAY_MS}ms`
      );
      _scheduleAutoClose(profileId, tabId);
      return _buildBlockedResponse({
        verdict,
        tabId,
        willCloseAt,
        closeInSeconds: Math.round(AUTO_CLOSE_DELAY_MS / 1000),
      });
    }

    // Any other tool (request_pairing, webpilot_*, webpilot_dev_*, etc.) —
    // no site involved.
    return null;
  }

  async function handleToolCall(params, apiKey = null) {
    const { name, arguments: args } = params;

    if (name === 'request_pairing') {
      const agentName = params.arguments?.agent_name || 'Unknown Agent';
      console.log(`[pairing] request_pairing tool called for agent: "${agentName}"`);

      // Short-circuit: if the caller already presents a valid API key, they
      // are already paired — no need to mint a new pending entry. Return the
      // existing identity and tell them to just call tools directly. This
      // matters most for Claude Code subagents (and similar) that inherit
      // their parent's .mcp.json (so they carry the parent's X-API-Key) but
      // are prompted to "set up WebPilot first" and reflexively call this
      // tool with a *new* agent_name, triggering an unnecessary approval
      // round-trip for the human. Regular tool calls don't look at
      // agent_name at all — auth + profile routing are keyed by the api_key
      // alone (see auth gate in tools/call above and resolveTargetProfile).
      if (apiKey) {
        const existing = pairedKeys.validateKey(apiKey);
        if (existing) {
          console.log(
            `[pairing] request_pairing short-circuit: caller already paired ` +
            `as "${existing.agentName}" (profileId=${existing.profileId}). ` +
            `Returning existing identity without creating a new pairing.`
          );
          return {
            content: [
              {
                type: 'text',
                text:
                  `You already have a valid API key — no need to pair again.\n\n` +
                  `Paired as: "${existing.agentName}"\n` +
                  `Bound to profile: ${existing.profileId}\n` +
                  `status: approved\n\n` +
                  `Just call browser tools directly with your existing key. ` +
                  `The server resolves your bound profile from the api_key automatically; ` +
                  `agent_name is not needed on tool calls and only matters during initial pairing.\n\n` +
                  `If you intended to register as a *separate* agent identity ` +
                  `(e.g. so the human can see this subagent distinctly in the UI), ` +
                  `ask the human to revoke or rename the current key first, then retry.`,
              },
            ],
          };
        }
      }

      const result = pairedKeys.requestPairing(agentName);
      console.log(
        `[pairing] requestPairing returned pairingId=${result.pairingId} status=${result.status} created=${result.created}`
      );

      // Fire a server-side native notification if a fresh pending entry was just created.
      // Lazy-require so this code keeps working before the notifications module lands.
      if (result.created && result.status === 'pending') {
        // Honor user preferences. If systemNotifications is off,
        // skip the toast entirely; if sound is off, pass sound:false.
        let prefs = { systemNotifications: true, sound: true };
        try {
          const notificationsSettings = require('./notifications-settings');
          prefs = notificationsSettings.getSettings();
        } catch (e) {
          console.log(`[pairing] could not load notifications prefs (${e.message}) — using defaults`);
        }

        if (prefs.systemNotifications === false) {
          console.log(
            `[pairing] skipping native notification for pairingId=${result.pairingId} — disabled by user preference`
          );
        } else {
          try {
            const { notify } = require('./notifications');
            console.log(
              `[pairing] firing native notification for new pairing pairingId=${result.pairingId} sound=${prefs.sound !== false}`
            );
            notify({
              title: 'WebPilot pairing request',
              body: `Agent "${agentName}" is requesting access. Open WebPilot to approve.`,
              url: webUiUrl,
              sound: prefs.sound !== false,
            }).catch((err) => {
              console.log(`[pairing] notify() rejected: ${err && err.message}`);
            });
          } catch (e) {
            console.log(
              `[pairing] notifications module not available yet (${e.message}) — skipping toast`
            );
          }
        }
      }

      if (result.status === 'approved') {
        const key = result.apiKey;
        console.log(
          `[pairing] request_pairing returning already-approved key for "${agentName}" ` +
            `pairingId=${result.pairingId}`
        );
        return {
          content: [
            {
              type: 'text',
              text:
                `Pairing already approved for agent "${agentName}".\n\n` +
                `pairing_id: ${result.pairingId}\n` +
                `status: approved\n` +
                `api_key: ${key}\n\n` +
                `Use this api_key for all subsequent tool calls, either via the X-API-Key ` +
                `header in your MCP client config, or as the api_key argument on each tool call.\n\n` +
                `Example .mcp.json for Claude Code:\n\n` +
                buildMcpConfigJson({ port: serverPort, apiKey: key }),
            },
          ],
        };
      }

      if (result.status === 'denied') {
        console.log(`[pairing] request_pairing returning denied status for "${agentName}"`);
        return {
          content: [
            {
              type: 'text',
              text:
                `Pairing for agent "${agentName}" was previously denied by the user.\n\n` +
                `pairing_id: ${result.pairingId}\n` +
                `status: denied\n\n` +
                `Do not retry automatically. Ask the human whether to try again with a different agent_name.`,
            },
          ],
        };
      }

      // status === 'pending'
      console.log(
        `[pairing] request_pairing returning pending status for "${agentName}" ` +
          `pairingId=${result.pairingId}`
      );
      return {
        content: [
          {
            type: 'text',
            text:
              `Pairing requested for agent "${agentName}".\n\n` +
              `pairing_id: ${result.pairingId}\n` +
              `status: pending\n\n` +
              `ACTION REQUIRED FROM THE HUMAN: open ${webUiUrl} in a browser and approve this pairing. ` +
              `A system notification has been sent.\n\n` +
              `NEXT STEPS FOR THE AGENT:\n` +
              `1. Surface the approval URL to the human and stop making other tool calls.\n` +
              `2. After the human confirms approval, call check_pairing_status with pairing_id="${result.pairingId}" to retrieve your api_key.\n` +
              `3. Calling request_pairing again with the same agent_name is safe — it is idempotent and will return this same pairing_id.`,
          },
        ],
      };
    }

    if (name === 'check_pairing_status') {
      const pairingId = params.arguments?.pairing_id;
      console.log(`[pairing] check_pairing_status tool called for pairingId=${pairingId}`);
      if (!pairingId || typeof pairingId !== 'string') {
        return {
          content: [
            {
              type: 'text',
              text: 'Missing required argument: pairing_id (string).',
            },
          ],
          isError: true,
        };
      }
      const status = pairedKeys.checkPairingStatus(pairingId);
      if (!status) {
        console.log(`[pairing] check_pairing_status: pairingId=${pairingId} not found`);
        return {
          content: [
            {
              type: 'text',
              text:
                `No pairing found for pairing_id="${pairingId}". ` +
                `Either it has never been requested or has been cleaned up. ` +
                `Call request_pairing again to start a new pairing.`,
            },
          ],
          isError: true,
        };
      }

      if (status.status === 'approved') {
        const key = status.apiKey;
        console.log(
          `[pairing] check_pairing_status: returning approved key for pairingId=${pairingId} ` +
            `(key${key ? '=present' : '=MISSING'})`
        );
        return {
          content: [
            {
              type: 'text',
              text:
                `status: approved\n` +
                `api_key: ${key}\n\n` +
                `Store this api_key and use it for all future tool calls. ` +
                `Recommended: update your MCP client config so it is sent via the X-API-Key header.\n\n` +
                `Example .mcp.json for Claude Code:\n\n` +
                buildMcpConfigJson({ port: serverPort, apiKey: key }),
            },
          ],
        };
      }

      if (status.status === 'denied') {
        console.log(`[pairing] check_pairing_status: pairingId=${pairingId} is denied`);
        return {
          content: [
            {
              type: 'text',
              text:
                `status: denied\n\n` +
                `The user denied this pairing request. Do not retry automatically — ` +
                `ask the human if they want to start a new pairing.`,
            },
          ],
        };
      }

      if (status.status === 'expired') {
        console.log(`[pairing] check_pairing_status: pairingId=${pairingId} is expired`);
        return {
          content: [
            {
              type: 'text',
              text:
                `status: expired\n\n` +
                `This pending pairing aged out (pending pairings expire after 24 hours ` +
                `of inactivity). Call request_pairing again with the same agent_name ` +
                `to mint a fresh pairing_id.`,
            },
          ],
        };
      }

      // pending
      console.log(`[pairing] check_pairing_status: pairingId=${pairingId} is still pending`);
      return {
        content: [
          {
            type: 'text',
            text:
              `status: pending\n\n` +
              `The user has not yet approved this pairing. ` +
              `Tell the human to approve it at ${webUiUrl}, then call this tool again on a later turn. ` +
              `Pending pairings expire after 24 hours of inactivity.`,
          },
        ],
      };
    }

    if (name === 'webpilot_get_formatter_info') {
      const info = formatterManager.getFormatterInfo(args.platform);
      return { content: [{ type: 'text', text: JSON.stringify(info, null, 2) }] };
    }

    if (name === 'webpilot_reload_formatters') {
      formatterManager.reload();
      const info = formatterManager.getFormatterInfo();
      return { content: [{ type: 'text', text: JSON.stringify({ reloaded: true, ...info }, null, 2) }] };
    }

    if (name === 'webpilot_dev_get_formatter_logs') {
      const platform = args && args.platform;
      if (!platform || typeof platform !== 'string') {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'Missing required argument: platform (string).' }) }],
          isError: true
        };
      }
      const requestedLimit = Math.max(1, Math.min(50, args.limit || 20));
      const health = formatterLogs.getStatus(platform);
      // getLogs returns the error ring buffer newest-first. Entry shape:
      // { timestamp, phase: 'format'|'workflow', workflow?, message, stack,
      // params?, tabId? }. Success invocations only update counters; they
      // are NOT stored in the ring, so this is implicitly an error log.
      const entries = formatterLogs.getLogs(platform, requestedLimit);
      return {
        content: [{ type: 'text', text: JSON.stringify({
          platform,
          health,
          entries,
          totalReturned: entries.length,
          requestedLimit
        }, null, 2) }]
      };
    }

    if (name === 'webpilot_dev_reload_extension') {
      // Mutates extension state — requires auth (gate above already enforced).
      const targetProfile = _requireExtensionConnected(apiKey);
      // The extension handler ACKs immediately (sendResult) then schedules
      // chrome.runtime.reload() ~100ms later, so this sendCommand resolves
      // before the WS drops. Use a generous-but-bounded timeout in case the
      // worker is slow to ack.
      const result = await extensionBridge.sendCommand(
        targetProfile,
        'reload_extension',
        {},
        { timeout: 5000 }
      );
      return {
        content: [{ type: 'text', text: JSON.stringify({
          reloaded: true,
          profileId: targetProfile,
          note: 'Extension service worker will restart in ~100ms. WS reconnects in 1-3s. The paired API key persists; no re-pair needed.',
          ...result
        }, null, 2) }]
      };
    }

    if (name === 'webpilot_run_workflow') {
      const {
        platform,
        workflow,
        params: workflowParams = {},
        tab_id: workflowTabId
      } = args || {};

      if (!platform || !workflow) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'Missing required argument: platform and workflow.' }) }],
          isError: true
        };
      }

      const wf = formatterManager.getWorkflow(platform, workflow);
      if (!wf) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: `Unknown workflow: ${platform}/${workflow}. See webpilot_get_formatter_info.` }) }],
          isError: true
        };
      }

      const paramError = _validateWorkflowParams(wf.parameters, workflowParams);
      if (paramError) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: paramError }) }],
          isError: true
        };
      }

      console.log(`[mcp:workflow] running ${platform}/${workflow} tabId=${workflowTabId}`);

      try {
        const result = await wf.run({
          params: workflowParams,
          browser: buildBrowserPrimitives(apiKey),
          tabId: workflowTabId,
          findInTree
        });
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, ...(result && typeof result === 'object' ? result : { result }) }) }] };
      } catch (err) {
        formatterLogs.recordError(platform, {
          error: err,
          phase: 'workflow',
          workflow,
          params: workflowParams,
          tabId: workflowTabId
        });
        console.warn(`[mcp:workflow] ${platform}/${workflow} failed: ${err.message}`);
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: err.message }) }],
          isError: true
        };
      }
    }

    // From here down all tools require a connected extension for the target profile.
    const targetProfile = resolveTargetProfile(apiKey);
    // Per-call opaque correlation ID. Random, not derived from the api_key,
    // so log lines can be traced through a session without leaking any
    // prefix of the credential or its hash. Agent name is still logged —
    // it's already user-visible in the UI.
    const corrId = crypto.randomUUID().slice(0, 8);
    const agentEntry = apiKey ? pairedKeys.validateKey(apiKey) : null;
    const agentName = agentEntry ? agentEntry.agentName : '(unauthed)';
    console.log(
      `[mcp:routing] req=${corrId} agent="${agentName}" tool=${name} profileId=${targetProfile}`
    );

    // browser_create_tab is the readiness gate: it may launch/restart Chrome.
    if (name === 'browser_create_tab') {
      const result = await _browserCreateTab({ url: args.url }, apiKey);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
      };
    }

    if (!extensionBridge.isConnected(targetProfile)) {
      throw new Error(
        `No browser instance connected for profile '${targetProfile}'. Call browser_create_tab to launch Chrome.`
      );
    }

    let commandType;
    let commandParams;

    switch (name) {
      // NOTE: browser_create_tab is handled earlier in this function via the
      // ChromeManager readiness path and an early `return`. It must NOT appear
      // in this switch — its presence would be misleading dead code.

      case 'browser_close_tab': {
        const result = await _browserCloseTab({ tab_id: args.tab_id }, apiKey);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      case 'browser_get_tabs': {
        const result = await _browserGetTabs({}, apiKey);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      case 'browser_get_accessibility_tree': {
        const responseData = await _browserGetAccessibilityTree(args, apiKey);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify(responseData, null, 2)
          }]
        };
      }

      case 'browser_inject_script':
        const scriptContent = await fetchScriptFromUrl(args.script_url);
        commandType = 'inject_script';
        commandParams = {
          tab_id: args.tab_id,
          script_content: scriptContent,
          keep_injected: args.keep_injected || false
        };
        break;

      case 'browser_execute_js':
        commandType = 'execute_js';
        commandParams = { tab_id: args.tab_id, code: args.code };
        break;

      case 'browser_click': {
        const result = await _browserClick(args, apiKey);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      case 'browser_scroll': {
        const result = await _browserScroll(args, apiKey);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      case 'browser_type': {
        const result = await _browserType(args, apiKey);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      case 'browser_request_chain': {
        const steps = args.steps;
        const returnMode = args.return_mode || 'all';

        // Pre-validate: empty steps
        if (!steps || steps.length === 0) {
          if (returnMode === 'last') {
            throw new Error('Cannot use return_mode "last" with an empty steps array');
          }
          return { content: [{ type: 'text', text: JSON.stringify({ results: [] }) }] };
        }

        // Pre-validate: all tool names exist and none is browser_request_chain
        const validToolNames = new Set(tools.map(t => t.name).filter(n => n !== 'browser_request_chain'));
        const invalidTools = steps
          .map((step, i) => ({ index: i, tool: step.tool }))
          .filter(s => !validToolNames.has(s.tool));
        if (invalidTools.length > 0) {
          const details = invalidTools.map(s => `step ${s.index}: "${s.tool}"`).join(', ');
          throw new Error(`Unknown tool(s) in chain: ${details}`);
        }

        // Pre-validate: all reference indices are backward-pointing
        for (let i = 0; i < steps.length; i++) {
          const stepArgs = JSON.stringify(steps[i].arguments);
          const refPattern = /"\$(\d+)\./g;
          let match;
          while ((match = refPattern.exec(stepArgs)) !== null) {
            const refIndex = parseInt(match[1], 10);
            if (refIndex >= i) {
              throw new Error(`Step ${i} references $${refIndex} which has not executed yet (forward or self reference)`);
            }
          }
        }

        // Execute steps sequentially
        const previousResults = [];
        for (let i = 0; i < steps.length; i++) {
          const step = steps[i];
          try {
            const resolvedArgs = resolveReferences(step.arguments, previousResults);
            // Re-apply the site-policy gate at every chained step — the gate
            // in tools/call only fires for the outer browser_request_chain
            // call, which is itself site-agnostic. Without this re-check, an
            // agent could bypass policy by hiding a blocked-site step in a
            // chain.
            let stepResult;
            try {
              const blocked = await _enforceSitePolicy(step.tool, resolvedArgs || {}, apiKey);
              if (blocked) {
                stepResult = blocked;
              }
            } catch (e) {
              console.log(`[policy] chain-step enforcement threw: ${e.message}`);
            }
            const result = stepResult || await handleToolCall(
              { name: step.tool, arguments: resolvedArgs },
              apiKey
            );
            previousResults.push(result);
          } catch (error) {
            // Parse previous results for the error response
            const parsedResults = previousResults.map(r => JSON.parse(r.content[0].text));
            return {
              content: [{
                type: 'text',
                text: JSON.stringify({
                  results: parsedResults,
                  error: { step: i, tool: step.tool, message: error.message }
                })
              }]
            };
          }
        }

        // All steps succeeded
        if (returnMode === 'last') {
          return previousResults[previousResults.length - 1];
        }
        const parsedResults = previousResults.map(r => JSON.parse(r.content[0].text));
        return { content: [{ type: 'text', text: JSON.stringify({ results: parsedResults }) }] };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }

    const result = await extensionBridge.sendCommand(targetProfile, commandType, commandParams);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2)
        }
      ]
    };
  }

  function getSessionCount() {
    return sessions.size;
  }

  return {
    handleSSE,
    handleMessage,
    getSessionCount
  };
}

module.exports = { createMcpHandler };
