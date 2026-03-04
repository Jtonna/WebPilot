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

function createMcpHandler(extensionBridge, apiKey) {
  const sessions = new Map();  // session_id -> { res, queue }

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
        properties: {}
      }
    },
    {
      name: 'browser_get_accessibility_tree',
      description: 'Get the accessibility tree (a11y DOM) of a browser tab. Returns a structured representation of the page content.',
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
          }
        },
        required: ['tab_id', 'script_url']
      }
    },
    {
      name: 'browser_execute_js',
      description: 'Execute JavaScript code in page context and return the result. Return value must be JSON-serializable.',
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
          }
        },
        required: ['tab_id', 'text']
      }
    },
    {
      name: 'browser_request_chain',
      description: 'Execute multiple tool calls sequentially and return combined results. Each step can reference results from prior steps using $N.path.to.value syntax (e.g., $0.tab_id references the tab_id field from step 0). Validates all tool names before execution begins.',
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
          }
        },
        required: ['steps']
      }
    }
  ];

  function handleSSE(req, res) {
    const sessionId = uuidv4();

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    // Store session with queue (matching backend pattern)
    sessions.set(sessionId, { res, queue: [] });

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

    const message = req.body;
    const response = await processMessage(message);

    if (response) {
      session.queue.push(response);
    }

    // Return 202 Accepted (matching backend pattern)
    res.status(202).send('');
  }

  async function processMessage(message) {
    const { method, id, params } = message;

    if (method === 'initialize') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'webpilot-browser', version: '0.3.0' }
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
      try {
        const result = await handleToolCall(params);
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

  async function handleToolCall(params) {
    const { name, arguments: args } = params;

    if (!extensionBridge.isConnected()) {
      throw new Error('Browser extension not connected');
    }

    let commandType;
    let commandParams;

    switch (name) {
      case 'browser_create_tab':
        commandType = 'create_tab';
        commandParams = { url: args.url };
        break;

      case 'browser_close_tab':
        commandType = 'close_tab';
        commandParams = { tab_id: args.tab_id };
        break;

      case 'browser_get_tabs':
        commandType = 'get_tabs';
        commandParams = {};
        break;

      case 'browser_get_accessibility_tree':
        commandType = 'get_accessibility_tree';
        commandParams = {
          tab_id: args.tab_id,
          usePlatformOptimizer: args.usePlatformOptimizer ?? true
        };
        break;

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
            const result = await handleToolCall({ name: step.tool, arguments: resolvedArgs });
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

    const result = await extensionBridge.sendCommand(commandType, commandParams);

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
