'use strict';

const fs = require('fs');
const path = require('path');
const { getFormatterDir } = require('./service/paths');

let manifest = null;
let formatterCache = {}; // path -> loaded module

function init() {
  const formatterDir = getFormatterDir();
  const manifestPath = path.join(formatterDir, 'manifest.json');

  // If no local cache exists, the updater will download from GitHub on startup
  if (!fs.existsSync(manifestPath)) {
    console.log('[formatter-manager] No local formatters found — waiting for updater to download from GitHub');
    return;
  }

  // Load manifest
  manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  console.log('[formatter-manager] Loaded manifest version', manifest.version);
}

function formatTree(url, rawNodes) {
  if (!manifest) {
    console.warn('[formatter-manager] No manifest loaded — returning raw nodes');
    return { tree: JSON.stringify(rawNodes), elementCount: rawNodes.length };
  }

  const formatterDir = getFormatterDir();

  // Match URL to platform
  if (url) {
    try {
      const hostname = new URL(url).hostname;
      for (const [platformName, platformConfig] of Object.entries(manifest.platforms)) {
        if (hostname.includes(platformConfig.match)) {
          const entryPath = path.join(formatterDir, platformConfig.entry);
          try {
            const formatter = loadFormatter(entryPath);
            // Platform formatters export a single format function (the main exported function)
            const formatFn = Object.values(formatter)[0]; // Get the first exported function
            const result = formatFn(rawNodes);
            return result;
          } catch (err) {
            console.warn(`[formatter-manager] Platform formatter ${platformName} failed:`, err.message);
            // Fall through to default
          }
        }
      }
    } catch (err) {
      console.warn('[formatter-manager] URL parsing failed:', err.message);
    }
  }

  // Default formatter
  const defaultPath = path.join(formatterDir, manifest.default);
  const defaultFormatter = loadFormatter(defaultPath);
  return defaultFormatter.formatAccessibilityTree(rawNodes);
}

function loadFormatter(filePath) {
  if (!formatterCache[filePath]) {
    formatterCache[filePath] = require(filePath);
  }
  return formatterCache[filePath];
}

function reload() {
  // Clear require cache for all loaded formatter files
  for (const filePath of Object.keys(formatterCache)) {
    const resolved = require.resolve(filePath);
    delete require.cache[resolved];
  }
  formatterCache = {};

  // Re-read manifest
  const manifestPath = path.join(getFormatterDir(), 'manifest.json');
  if (fs.existsSync(manifestPath)) {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    console.log('[formatter-manager] Reloaded manifest version', manifest.version);
  }
}

function getFormatterInfo(platform) {
  if (!manifest) {
    return {
      version: null,
      status: 'No manifest loaded — formatters have not been downloaded yet. They will be fetched from GitHub on next startup.',
      platforms: {},
      default: null,
      formatterApiContract: getFormatterApiContract(),
      howToCreateCustomFormatter: getHowToCreateCustomFormatter()
    };
  }

  let platforms = {};
  for (const [name, config] of Object.entries(manifest.platforms || {})) {
    platforms[name] = {
      name,
      match: config.match,
      description: config.description || `Platform-specific formatter for sites matching hostname "${config.match}"`
    };
  }

  if (platform) {
    if (!platforms[platform]) {
      return {
        version: manifest.version,
        platforms: null,
        message: `Platform "${platform}" not found. Available platforms: ${Object.keys(platforms).join(', ') || 'none'}`,
        default: { entry: manifest.default },
        formatterApiContract: getFormatterApiContract(),
        howToCreateCustomFormatter: getHowToCreateCustomFormatter()
      };
    }
    platforms = { [platform]: platforms[platform] };
  }

  return {
    version: manifest.version,
    platforms,
    default: { entry: manifest.default },
    formatterApiContract: getFormatterApiContract(),
    howToCreateCustomFormatter: getHowToCreateCustomFormatter()
  };
}

function getFormatterApiContract() {
  return {
    input: 'Array of raw CDP accessibility nodes',
    nodeShape: {
      nodeId: 'number — unique node identifier',
      role: '{ value: string } — ARIA role (e.g., "button", "link", "StaticText")',
      name: '{ value: string } — accessible name/label',
      parentId: 'number — parent nodeId',
      childIds: 'number[] — child nodeIds',
      backendDOMNodeId: 'number — DOM node identifier used for click/scroll/type targeting via refs',
      properties: 'array of { name, value } pairs — ARIA properties and states',
      ignored: 'boolean — whether the node is hidden from accessibility tree'
    },
    output: {
      tree: 'string — human-readable formatted accessibility tree',
      elementCount: 'number — total number of interactive/visible elements',
      refs: 'object — maps ref strings (e.g., "e1", "e2") to backendDOMNodeId values for click/scroll/type targeting',
      extras: 'any additional fields returned by the formatter (e.g., postCount, listingCount, platform)'
    }
  };
}

function getHowToCreateCustomFormatter() {
  return {
    modulePattern: 'CommonJS module exporting a single function',
    functionSignature: 'function formatSiteName(nodes) — receives array of raw CDP accessibility nodes',
    outputRequirements: 'Must return { tree: string, elementCount: number, refs: { e1: backendDOMNodeId, e2: ... }, ...optionalExtras }',
    refsExplanation: 'The refs object maps ref strings to backendDOMNodeId values. These refs enable the agent to target elements with browser_click, browser_scroll, and browser_type tools.',
    routerPattern: 'For multi-page sites, export a router function that detects the page type from the URL and delegates to page-specific sub-formatters.',
    registration: {
      step1: 'Add an entry to manifest.json under "platforms" with: "match" (hostname substring to match), "entry" (relative path to your formatter file), and "files" (array of ALL files included in your formatter)',
      step2: 'List every file your formatter depends on in the "files" array so the auto-updater downloads them all',
      step3: 'Bump the top-level "version" in manifest.json to trigger auto-updates on connected clients'
    },
    hosting: 'Formatters are hosted on GitHub and auto-update hourly. Bump "version" in manifest.json to push updates to all clients.',
    example: [
      "'use strict';",
      "module.exports = function formatMysite(nodes) {",
      "  const refs = {};",
      "  let refCounter = 1;",
      "  let tree = '';",
      "  for (const node of nodes) {",
      "    if (node.ignored) continue;",
      "    const ref = 'e' + refCounter++;",
      "    refs[ref] = node.backendDOMNodeId;",
      "    tree += `[${ref}] ${node.role.value}: ${node.name?.value || ''}\\n`;",
      "  }",
      "  return { tree, elementCount: Object.keys(refs).length, refs };",
      "};"
    ]
  };
}

module.exports = { init, formatTree, reload, getFormatterInfo };
