'use strict';

const fs = require('fs');
const path = require('path');
const { getFormatterDir, getDataDir } = require('./service/paths');

let manifest = null;
let formatterCache = {}; // path -> loaded module
let customPlatforms = new Set(); // platform names that came from custom manifest

function getCustomFormatterDir() {
  return path.join(getDataDir(), 'custom-formatters');
}

function init() {
  const formatterDir = getFormatterDir();
  const manifestPath = path.join(formatterDir, 'manifest.json');

  // Ensure custom-formatters directory exists
  const customFormatterDir = getCustomFormatterDir();
  fs.mkdirSync(customFormatterDir, { recursive: true });

  // Create empty custom manifest if none exists
  const customManifestPath = path.join(customFormatterDir, 'manifest.json');
  if (!fs.existsSync(customManifestPath)) {
    fs.writeFileSync(customManifestPath, JSON.stringify({ version: '1', platforms: {}, files: [] }, null, 2), 'utf8');
  }

  // If no auto-updated manifest exists, the updater will download from GitHub on startup
  if (!fs.existsSync(manifestPath)) {
    console.log('[formatter-manager] No local formatters found — waiting for updater to download from GitHub');
    // Still load custom manifest so custom formatters work even before auto-updated ones arrive
    const customManifest = JSON.parse(fs.readFileSync(customManifestPath, 'utf8'));
    customPlatforms = new Set(Object.keys(customManifest.platforms || {}));
    manifest = customManifest;
    if (customPlatforms.size > 0) {
      console.log('[formatter-manager] Loaded custom manifest with platforms:', [...customPlatforms].join(', '));
    }
    return;
  }

  // Load and merge manifests: auto-updated base, custom overlays on top
  const autoManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const customManifest = JSON.parse(fs.readFileSync(customManifestPath, 'utf8'));

  customPlatforms = new Set(Object.keys(customManifest.platforms || {}));

  manifest = {
    ...autoManifest,
    platforms: {
      ...autoManifest.platforms,
      ...customManifest.platforms
    }
  };

  console.log('[formatter-manager] Loaded manifest version', autoManifest.version);
  if (customPlatforms.size > 0) {
    console.log('[formatter-manager] Custom platforms loaded:', [...customPlatforms].join(', '));
  }
}

function formatTree(url, rawNodes) {
  if (!manifest) {
    console.warn('[formatter-manager] No manifest loaded — returning raw nodes');
    return { tree: JSON.stringify(rawNodes), elementCount: rawNodes.length };
  }

  const formatterDir = getFormatterDir();
  const customFormatterDir = getCustomFormatterDir();

  // Match URL to platform
  if (url) {
    try {
      const hostname = new URL(url).hostname;
      for (const [platformName, platformConfig] of Object.entries(manifest.platforms)) {
        if (hostname.includes(platformConfig.match)) {
          const baseDir = customPlatforms.has(platformName) ? customFormatterDir : formatterDir;
          const entryPath = path.join(baseDir, platformConfig.entry);
          try {
            const formatter = loadFormatter(entryPath);
            // Support both export styles: module.exports = fn OR module.exports = { fn }
            const formatFn = typeof formatter === 'function' ? formatter : Object.values(formatter)[0];
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

  // Default formatter always comes from the auto-updated directory
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
  customPlatforms = new Set();

  // Re-read and re-merge both manifests
  const manifestPath = path.join(getFormatterDir(), 'manifest.json');
  const customManifestPath = path.join(getCustomFormatterDir(), 'manifest.json');

  const autoManifestExists = fs.existsSync(manifestPath);
  const customManifestExists = fs.existsSync(customManifestPath);

  if (!autoManifestExists && !customManifestExists) {
    manifest = null;
    return;
  }

  const autoManifest = autoManifestExists ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : null;
  const customManifest = customManifestExists ? JSON.parse(fs.readFileSync(customManifestPath, 'utf8')) : { platforms: {} };

  customPlatforms = new Set(Object.keys(customManifest.platforms || {}));

  if (autoManifest) {
    manifest = {
      ...autoManifest,
      platforms: {
        ...autoManifest.platforms,
        ...customManifest.platforms
      }
    };
    console.log('[formatter-manager] Reloaded manifest version', autoManifest.version);
  } else {
    manifest = customManifest;
  }

  if (customPlatforms.size > 0) {
    console.log('[formatter-manager] Custom platforms reloaded:', [...customPlatforms].join(', '));
  }
}

function getFormatterInfo(platform) {
  // Trigger a reload so agents can use this call to pick up changes
  reload();

  const customFormatterDir = getCustomFormatterDir();

  if (!manifest) {
    return {
      version: null,
      status: 'No manifest loaded — formatters have not been downloaded yet. They will be fetched from GitHub on next startup.',
      platforms: {},
      default: null,
      customFormatterDir,
      formatterApiContract: getFormatterApiContract(),
      howToCreateCustomFormatter: getHowToCreateCustomFormatter()
    };
  }

  let platforms = {};
  for (const [name, config] of Object.entries(manifest.platforms || {})) {
    platforms[name] = {
      name,
      match: config.match,
      description: config.description || `Platform-specific formatter for sites matching hostname "${config.match}"`,
      source: customPlatforms.has(name) ? 'custom' : 'auto-updated'
    };
  }

  if (platform) {
    if (!platforms[platform]) {
      return {
        version: manifest.version,
        platforms: null,
        message: `Platform "${platform}" not found. Available platforms: ${Object.keys(platforms).join(', ') || 'none'}`,
        default: { entry: manifest.default },
        customFormatterDir,
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
    customFormatterDir,
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
    customFormatters: {
      step1: 'Drop your formatter files into the custom-formatters directory (path shown in the customFormatterDir field of this response)',
      step2: 'Edit custom-formatters/manifest.json to add your platform entry under "platforms": { "myplatform": { "match": "hostname-substring", "entry": "my-formatter.js" } }',
      step3: 'Custom formatters are never overwritten by auto-updates — they persist across server updates',
      step4: 'Restart the server or call webpilot_get_formatter_info to trigger a reload'
    },
    autoUpdatedFormatters: {
      step1: 'Add an entry to manifest.json under "platforms" with: "match" (hostname substring to match), "entry" (relative path to your formatter file), and "files" (array of ALL files included in your formatter)',
      step2: 'List every file your formatter depends on in the "files" array so the auto-updater downloads them all',
      step3: 'Bump the top-level "version" in manifest.json to trigger auto-updates on connected clients',
      hosting: 'Formatters are hosted on GitHub and auto-update hourly. Bump "version" in manifest.json to push updates to all clients.'
    },
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

module.exports = { init, formatTree, reload, getFormatterInfo, getCustomFormatterDir };
