'use strict';

const fs = require('fs');
const path = require('path');
const { getFormatterDir, getDataDir } = require('./service/paths');
const formatterLogs = require('./formatter-logs');

let manifest = null;
let formatterCache = {}; // path -> loaded module
let customPlatforms = new Set(); // platform names that came from custom manifest
let perFormatterManifests = {}; // platformName -> normalized per-formatter manifest
let workflowsByFormatter = {};   // platformName -> { workflowName -> { description, parameters, run } }

// --- per-formatter manifest schema ---
//
// Each formatter may ship a manifest.json alongside its entry file
// describing name/version/match/source/description/notes/etc. See
// accessibility-tree-formatters/MANIFEST_SCHEMA.md for the full schema.
//
// This loader is intentionally forgiving: a missing or malformed
// per-formatter manifest never breaks formatter loading. We log a
// warning and synthesize a minimal manifest so downstream consumers
// (getFormatterInfo, future Web UI) always see a consistent shape.

const REQUIRED_MANIFEST_FIELDS = ['name', 'version', 'match', 'source', 'description'];

function synthesizeMinimalManifest(platformName, matchHint, sourceHint) {
  return {
    name: platformName,
    version: '0.0.0',
    match: matchHint || '',
    source: sourceHint || 'custom',
    description: '(no manifest.json — synthesized)',
    notes: '',
    errorHandling: { fallbackToRawTree: true },
    workflows: [],
    _synthesized: true
  };
}

function loadPerFormatterManifest(platformName, baseDir, entryRelPath, matchHint, sourceHint) {
  // The per-formatter manifest sits next to the entry file:
  //   <baseDir>/<entryDir>/manifest.json
  const entryDir = path.dirname(path.join(baseDir, entryRelPath));
  const manifestPath = path.join(entryDir, 'manifest.json');

  if (!fs.existsSync(manifestPath)) {
    return synthesizeMinimalManifest(platformName, matchHint, sourceHint);
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    console.warn(`[formatter-manager] manifest.json for "${platformName}" failed to parse: ${err.message}. Falling back to synthesized manifest (source forced to "custom").`);
    const synth = synthesizeMinimalManifest(platformName, matchHint, sourceHint);
    synth.source = 'custom';
    return synth;
  }

  const missing = REQUIRED_MANIFEST_FIELDS.filter(f => !parsed[f]);
  if (missing.length > 0) {
    console.warn(`[formatter-manager] manifest.json for "${platformName}" is missing required field(s): ${missing.join(', ')}. Falling back to synthesized manifest (source forced to "custom").`);
    const synth = synthesizeMinimalManifest(platformName, matchHint, sourceHint);
    synth.source = 'custom';
    return synth;
  }

  // Override declared source based on where the file actually lives —
  // a custom-formatters manifest can't claim to be "remote".
  const effectiveSource = sourceHint || parsed.source;

  return {
    name: parsed.name,
    version: parsed.version,
    match: parsed.match,
    source: effectiveSource,
    description: parsed.description,
    notes: parsed.notes || '',
    errorHandling: parsed.errorHandling || { fallbackToRawTree: true },
    workflows: Array.isArray(parsed.workflows) ? parsed.workflows : []
  };
}

function loadAllPerFormatterManifests() {
  perFormatterManifests = {};
  workflowsByFormatter = {};
  if (!manifest || !manifest.platforms) return;

  const formatterDir = getFormatterDir();
  const customFormatterDir = getCustomFormatterDir();

  for (const [platformName, platformConfig] of Object.entries(manifest.platforms)) {
    const isCustom = customPlatforms.has(platformName);
    const baseDir = isCustom ? customFormatterDir : formatterDir;
    const sourceHint = isCustom ? 'custom' : 'remote';
    if (!platformConfig.entry) continue;
    perFormatterManifests[platformName] = loadPerFormatterManifest(
      platformName,
      baseDir,
      platformConfig.entry,
      platformConfig.match,
      sourceHint
    );
    loadWorkflowsForFormatter(platformName, baseDir, platformConfig.entry);
  }
}

/**
 * Load the sibling `workflows.js` (if present) and cross-check it against
 * the per-formatter manifest's `workflows` array. Each declared workflow
 * must have a matching entry in workflows.js with a valid shape:
 *   { description: string, parameters: object, run: function }
 * Mismatches log a warning and the broken workflow is skipped.
 */
function loadWorkflowsForFormatter(platformName, baseDir, entryRelPath) {
  const entryDir = path.dirname(path.join(baseDir, entryRelPath));
  const workflowsPath = path.join(entryDir, 'workflows.js');
  if (!fs.existsSync(workflowsPath)) return;

  let mod;
  try {
    // Bust the require cache so reload() picks up edits.
    try { delete require.cache[require.resolve(workflowsPath)]; } catch (e) { /* not in cache yet */ }
    mod = require(workflowsPath);
  } catch (err) {
    console.warn(`[formatter-manager] workflows.js for "${platformName}" failed to load: ${err.message}. Skipping workflows.`);
    return;
  }

  if (!mod || typeof mod !== 'object') {
    console.warn(`[formatter-manager] workflows.js for "${platformName}" must export an object map of workflows. Got ${typeof mod}.`);
    return;
  }

  const manifestWorkflows = (perFormatterManifests[platformName] && perFormatterManifests[platformName].workflows) || [];
  const declaredNames = new Set(manifestWorkflows.map((w) => w && w.name).filter(Boolean));

  const valid = {};
  for (const [wfName, wf] of Object.entries(mod)) {
    if (!declaredNames.has(wfName)) {
      console.warn(`[formatter-manager] workflow "${platformName}/${wfName}" is implemented in workflows.js but not declared in manifest.json — skipping. Add it to manifest.workflows[] to enable.`);
      continue;
    }
    if (!wf || typeof wf !== 'object') {
      console.warn(`[formatter-manager] workflow "${platformName}/${wfName}" must be an object — skipping.`);
      continue;
    }
    if (typeof wf.run !== 'function') {
      console.warn(`[formatter-manager] workflow "${platformName}/${wfName}" missing run() function — skipping.`);
      continue;
    }
    if (typeof wf.description !== 'string' || wf.description.length === 0) {
      console.warn(`[formatter-manager] workflow "${platformName}/${wfName}" missing description — skipping.`);
      continue;
    }
    if (!wf.parameters || typeof wf.parameters !== 'object') {
      console.warn(`[formatter-manager] workflow "${platformName}/${wfName}" missing parameters object — skipping.`);
      continue;
    }
    valid[wfName] = {
      description: wf.description,
      parameters: wf.parameters,
      run: wf.run
    };
  }

  // Warn (don't fail) when manifest declares a workflow with no implementation.
  for (const declaredName of declaredNames) {
    if (!valid[declaredName]) {
      console.warn(`[formatter-manager] workflow "${platformName}/${declaredName}" declared in manifest.json but has no valid implementation in workflows.js.`);
    }
  }

  if (Object.keys(valid).length > 0) {
    workflowsByFormatter[platformName] = valid;
    console.log(`[formatter-manager] loaded ${Object.keys(valid).length} workflow(s) for "${platformName}": ${Object.keys(valid).join(', ')}`);
  }
}

function getWorkflow(formatterName, workflowName) {
  const formatterWorkflows = workflowsByFormatter[formatterName];
  if (!formatterWorkflows) return null;
  return formatterWorkflows[workflowName] || null;
}

function listWorkflows() {
  const out = [];
  for (const [formatterName, formatterWorkflows] of Object.entries(workflowsByFormatter)) {
    for (const [wfName, wf] of Object.entries(formatterWorkflows)) {
      out.push({
        formatter: formatterName,
        name: wfName,
        description: wf.description,
        parameters: wf.parameters
      });
    }
  }
  return out;
}

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
    loadAllPerFormatterManifests();
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

  loadAllPerFormatterManifests();
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
            formatterLogs.recordSuccess(platformName);
            return result;
          } catch (err) {
            console.warn(`[formatter-manager] Platform formatter ${platformName} failed:`, err.message);
            formatterLogs.recordError(platformName, { error: err, phase: 'format' });

            // Honor per-formatter `errorHandling.fallbackToRawTree` (defaults
            // to true if the per-formatter manifest is missing or did not
            // override it). When false, re-raise so the caller can decide.
            const pm = perFormatterManifests[platformName];
            const fallback = !pm || !pm.errorHandling || pm.errorHandling.fallbackToRawTree !== false;
            if (!fallback) {
              throw err;
            }
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

  loadAllPerFormatterManifests();
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
    const perManifest = perFormatterManifests[name];
    const fallbackSource = customPlatforms.has(name) ? 'custom' : 'remote';
    const declaredWorkflows = (perManifest && perManifest.workflows) || [];
    const implMap = workflowsByFormatter[name] || {};
    // Annotate each manifest-declared workflow with whether a matching
    // implementation is actually loaded (workflows.js export shape valid).
    // Agents call webpilot_run_workflow only on `implemented: true` rows.
    const workflows = declaredWorkflows.map((wf) => ({
      name: wf.name,
      description: wf.description,
      parameters: wf.parameters || {},
      implemented: !!(wf.name && implMap[wf.name])
    }));
    platforms[name] = {
      name,
      match: (perManifest && perManifest.match) || config.match,
      description: (perManifest && perManifest.description)
        || config.description
        || `Platform-specific formatter for sites matching hostname "${config.match}"`,
      notes: (perManifest && perManifest.notes) || '',
      version: (perManifest && perManifest.version) || '0.0.0',
      source: (perManifest && perManifest.source) || fallbackSource,
      errorHandling: (perManifest && perManifest.errorHandling) || { fallbackToRawTree: true },
      workflows
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

// Expose per-formatter manifests so the Web UI Formatters tab (Wave C) and
// downstream consumers can render version/description/notes/workflows
// without re-reading from disk.
function getPerFormatterManifests() {
  return { ...perFormatterManifests };
}

module.exports = {
  init,
  formatTree,
  reload,
  getFormatterInfo,
  getCustomFormatterDir,
  getPerFormatterManifests,
  getWorkflow,
  listWorkflows
};
