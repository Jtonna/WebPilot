const { v4: uuidv4 } = require('uuid');

async function fetchScriptFromUrl(url) {
  const parsedUrl = new URL(url);
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    throw new Error(`Unsupported protocol: ${parsedUrl.protocol}`);
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }

    const content = await response.text();
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

function createMcpHandler(extensionBridge, apiKey, pairedKeys, formatterManager, isPairingRequired, options = {}) {
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
   * Per-agent routing (Wave 7 J2): each paired-keys entry carries a `profileId`
   * field (added in Wave 5 G2). When the API key resolves to an entry with a
   * string `profileId`, route to that profile. Legacy entries (pre-G2) have
   * `profileId: null` and fall back to the server-wide `managedProfile`.
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
      description: 'Execute JavaScript code in page context and return the result. Return value must be JSON-serializable. Use for actions that require JS execution (form manipulation, custom interactions) — for page data extraction, prefer browser_get_accessibility_tree which already provides pre-filtered, structured content.',
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
      description: 'Initiate pairing. **Skip this tool if you already have a valid API key** (sent via the X-API-Key header or the api_key argument) — calling it in that case will short-circuit and tell you so. Just call browser tools directly; the server resolves your bound profile from the key. **Asynchronous flow** (only used by un-paired callers): returns immediately with a `pairing_id` and current `status` (\'pending\', \'approved\', \'denied\', or \'expired\'). If \'pending\', the user has not yet approved — tell the human to approve in the WebPilot UI (a system notification will fire pointing at the UI), then on a later turn call `check_pairing_status` with the `pairing_id` to get your `api_key`. Idempotent: if you call this twice with the same `agent_name`, you get the same `pairing_id` back, **unless** the existing pending entry has expired (pending pairings expire after 24 hours of inactivity), in which case a fresh `pairing_id` is minted. Do NOT keep calling browser tools while waiting — surface the approval URL to the human, stop, and resume after they confirm. `agent_name` is optional; if omitted, the server uses "Unknown Agent" as a placeholder the human can rename after approval.',
      inputSchema: {
        type: 'object',
        properties: {
          agent_name: {
            type: 'string',
            description: 'Optional human-readable name to identify this agent in the approval UI (e.g. "Claude Code", "Cursor", "My Script"). Not required — omit if you do not have one.'
          }
        }
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
      description: 'Reload all formatters (both auto-updated and custom) without restarting the server. Use this after adding or modifying custom formatter files in the custom-formatters directory. Returns the updated formatter state.',
      inputSchema: {
        type: 'object',
        properties: {}
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

  const AUTH_ERROR_MESSAGE = 'Authentication required. Include your API key as the X-API-Key header or apiKey query parameter in requests. If you do not have a key, call the request_pairing tool to initiate pairing. If you have previously paired, check your working directory for a webpilot.key file.';

  async function processMessage(message, session) {
    const { method, id, params } = message;

    if (method === 'initialize') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'webpilot-browser', version: '1.0.0' },
          instructions: `WebPilot is an MCP server that controls a real Chrome browser via a paired Chrome extension. All browser interactions happen in the user's actual browser, not a headless instance.

**Authentication — read this first.** Every browser_* tool requires a paired API key. If you do NOT already have one for this server (i.e., your client config has no X-API-Key header / api_key parameter): your FIRST action must be to call \`request_pairing\` with a memorable agent_name. That tool returns immediately with a pairing_id and status — read its description and follow the async flow (surface the approval URL to the human, stop calling browser_* tools, poll \`check_pairing_status\` later). Skipping this step means every browser tool call will fail with an authentication error. The tools \`request_pairing\`, \`check_pairing_status\`, \`webpilot_get_formatter_info\`, and \`webpilot_reload_formatters\` do NOT require a key.

Tool workflow: Use browser_get_tabs to find open tabs, then browser_get_accessibility_tree to read page content, then use the refs returned (e1, e2, etc.) with browser_click, browser_scroll, and browser_type for precise element targeting. Chain these operations to navigate and interact with pages.

Accessibility tree: The tree from browser_get_accessibility_tree is already heavily pre-filtered and optimized for LLM consumption — roughly 97% smaller than raw CDP output. Do not use browser_execute_js to filter or extract data from pages. The tree already contains what you need.

Platform formatters: Supported sites (e.g., Threads, Zillow) automatically activate platform-specific formatters that return structured JSON with extra fields like postCount and listingCount. Check the response object for these additional fields. Use webpilot_get_formatter_info to discover which platforms have built-in formatters and to learn how to write custom platform optimizers for sites without built-in support.

Refs: Element identifiers (e1, e2, etc.) are returned in the accessibility tree. Pass them to click, scroll, and type tools for precise targeting. Refs are scoped to the most recent tree fetch for a given tab.

browser_request_chain: Batches sequential tool calls (e.g., click then get tree) into a single round-trip when you do not need intermediate LLM reasoning between steps. Steps can reference prior results using $N.path.to.value syntax.

browser_execute_js: Reserve for actions that genuinely require JavaScript execution, such as form manipulation or custom interactions. Do not use it to extract or filter page data — the accessibility tree already handles that.`
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
      // Auth gate: exempt request_pairing and webpilot_get_formatter_info, require valid API key for all other tools
      const noAuthRequired =
        params.name === 'request_pairing' ||
        params.name === 'check_pairing_status' ||
        params.name === 'webpilot_get_formatter_info' ||
        params.name === 'webpilot_reload_formatters';
      // Resolved API key for the call. Used for both auth and per-agent
      // profile routing (Wave 7 J2). For auth-exempt tools that don't carry a
      // key, this stays null and resolveTargetProfile() falls back gracefully.
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
        // Honor user preferences (Phase 3 B). If systemNotifications is off,
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
            `(key=${key.slice(0, 8)}...)`
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
                `{\n  "mcpServers": {\n    "webpilot": {\n      "url": "http://localhost:${serverPort}/sse",\n      "headers": {\n        "X-API-Key": "${key}"\n      }\n    }\n  }\n}`,
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
            `(key=${key ? key.slice(0, 8) + '...' : 'MISSING'})`
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
                `{\n  "mcpServers": {\n    "webpilot": {\n      "url": "http://localhost:${serverPort}/sse",\n      "headers": {\n        "X-API-Key": "${key}"\n      }\n    }\n  }\n}`,
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

    // From here down all tools require a connected extension for the target profile.
    const targetProfile = resolveTargetProfile(apiKey);
    const keyDisplay = apiKey ? apiKey.slice(0, 8) : '(none)';
    console.log(
      `[mcp:routing] tool=${name} apiKey=${keyDisplay}... profileId=${targetProfile}`
    );

    // browser_create_tab is the readiness gate: it may launch/restart Chrome.
    if (name === 'browser_create_tab') {
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

        // If Chrome was restarted or freshly launched, wait for the extension to (re)connect.
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

      const result = await extensionBridge.sendCommand(targetProfile, 'create_tab', { url: args.url });
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

      case 'browser_close_tab':
        commandType = 'close_tab';
        commandParams = { tab_id: args.tab_id };
        break;

      case 'browser_get_tabs':
        commandType = 'get_tabs';
        commandParams = {};
        break;

      case 'browser_get_accessibility_tree': {
        const a11yParams = {
          tab_id: args.tab_id,
          usePlatformOptimizer: args.usePlatformOptimizer ?? true
        };
        const rawResult = await extensionBridge.sendCommand(targetProfile, 'get_accessibility_tree', a11yParams);
        const { nodes, url, tabId, usePlatformOptimizer } = rawResult;

        // Determine URL for formatter: if usePlatformOptimizer is explicitly false, pass null to force default
        const formatterUrl = usePlatformOptimizer === false ? null : url;

        // Format the tree server-side
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

            // Build nodeMap from raw nodes
            const nodeMap = new Map();
            for (const node of nodes) {
              nodeMap.set(node.nodeId, node);
            }

            // Build backendDOMNodeId -> node lookup for ref resolution
            const backendNodeMap = new Map();
            for (const node of nodes) {
              if (node.backendDOMNodeId) {
                backendNodeMap.set(node.backendDOMNodeId, node);
              }
            }

            // Build refContexts: { ref: ancestryContext }
            const refContexts = {};
            for (const [ref, backendDOMNodeId] of Object.entries(refs)) {
              const node = backendNodeMap.get(backendDOMNodeId);
              if (node) {
                refContexts[ref] = extractAncestryContext(node, nodeMap);
              }
            }

            // Send ref mappings and contexts to extension
            extensionBridge.notify(targetProfile, {
              type: 'store_refs',
              tabId,
              refs,
              refContexts
            });
          } catch (err) {
            console.warn('[mcp-handler] Failed to build ref contexts:', err.message);
            // Still send refs without contexts
            extensionBridge.notify(targetProfile, {
              type: 'store_refs',
              tabId,
              refs,
              refContexts: null
            });
          }
        }

        // Build response with tree, elementCount, and any extras (postCount, listingCount, platform, etc.)
        const responseData = { tree, elementCount, ...extras };

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

      case 'browser_click':
        commandType = 'click';
        commandParams = {
          tab_id: args.tab_id,
          ref: args.ref,
          selector: args.selector,
          x: args.x,
          y: args.y,
          button: args.button || 'left',
          clickCount: args.clickCount || 1,
          delay: args.delay,
          showCursor: args.showCursor ?? true
        };
        break;

      case 'browser_scroll':
        commandType = 'scroll';
        commandParams = {
          tab_id: args.tab_id,
          ref: args.ref,
          selector: args.selector,
          pixels: args.pixels
        };
        break;

      case 'browser_type':
        commandType = 'type';
        commandParams = {
          tab_id: args.tab_id,
          text: args.text,
          ref: args.ref,
          selector: args.selector,
          delay: args.delay || 50,
          pressEnter: args.pressEnter || false
        };
        break;

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
            const result = await handleToolCall(
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
