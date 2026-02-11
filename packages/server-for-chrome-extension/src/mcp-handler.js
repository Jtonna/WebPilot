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
          serverInfo: { name: 'webpilot-browser', version: '0.2.0' }
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
