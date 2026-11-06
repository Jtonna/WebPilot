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
// platformName -> normalized per-formatter manifest of the REMOTE copy that
// is currently being shadowed by a same-named custom formatter. Populated
// only for platforms that exist in BOTH the auto-updated and custom
// manifests. Used by `/api/ui/formatters` so the dashboard can surface the
// fact that a routing-inactive copy exists on disk.
let shadowedPerFormatterManifests = {};
// platformName -> { platformConfig } for the remote copy that is currently
// being shadowed. Kept separate from `manifest` (which always represents
// the routing-effective merged view) so detection survives reload().
let shadowedPlatformConfigs = {};

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

  // For every platform that a custom formatter is shadowing, also load the
  // remote per-formatter manifest from disk so the dashboard can show what
  // would route if the custom override were removed. Workflows are NOT
  // loaded for shadowed copies — they're inactive by definition and can't
  // be invoked.
  for (const [platformName, remoteConfig] of Object.entries(shadowedPlatformConfigs)) {
    if (!remoteConfig.entry) continue;
    shadowedPerFormatterManifests[platformName] = loadPerFormatterManifest(
      platformName,
      formatterDir,
      remoteConfig.entry,
      remoteConfig.match,
      'remote'
    );
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

/**
 * Look up a single workflow implementation by `<formatter>/<workflow>`.
 * Returned shape:
 *   { description: string, parameters: object, run: function }
 * Returns null if either the formatter or the workflow is unknown.
 *
 * @param {string} formatterName  e.g. "discord"
 * @param {string} workflowName   e.g. "send_message"
 * @returns {{ description: string, parameters: object, run: Function } | null}
 */
function getWorkflow(formatterName, workflowName) {
  const formatterWorkflows = workflowsByFormatter[formatterName];
  if (!formatterWorkflows) return null;
  return formatterWorkflows[workflowName] || null;
}

/**
 * Flat list of every loaded workflow across every formatter — used by tests
 * and (eventually) admin surfaces that want to enumerate the whole set
 * without iterating manifests.
 *
 * @returns {Array<{ formatter: string, name: string, description: string, parameters: object }>}
 */
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
    // No remote manifest yet → nothing can be shadowed.
    shadowedPlatformConfigs = {};
    shadowedPerFormatterManifests = {};
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

  // Snapshot remote configs that are about to be shadowed by a same-named
  // custom entry. The merge below collapses them into the winner; this map
  // preserves the loser so we can still inspect it without re-reading disk.
  shadowedPlatformConfigs = {};
  shadowedPerFormatterManifests = {};
  for (const platformName of customPlatforms) {
    if (autoManifest.platforms && autoManifest.platforms[platformName]) {
      shadowedPlatformConfigs[platformName] = autoManifest.platforms[platformName];
    }
  }

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
  const shadowNames = Object.keys(shadowedPlatformConfigs);
  if (shadowNames.length > 0) {
    console.log('[formatter-manager] Custom formatters shadowing remote:', shadowNames.join(', '));
  }

  loadAllPerFormatterManifests();
}

function getFormatterNameForUrl(url) {
  if (!url || !manifest) return null;
  try {
    const hostname = new URL(url).hostname;
    for (const [platformName, platformConfig] of Object.entries(manifest.platforms)) {
      if (hostname.includes(platformConfig.match)) {
        return platformName;
      }
    }
  } catch (_e) {
    // malformed URL
  }
  return null;
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
    let hostname;
    try {
      hostname = new URL(url).hostname;
    } catch (err) {
      console.warn('[formatter-manager] URL parsing failed:', err.message);
    }
    if (hostname) {
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
            const incident = formatterLogs.recordError(platformName, { error: err, phase: 'format' });

            // Honor per-formatter `errorHandling.fallbackToRawTree` (defaults
            // to true if the per-formatter manifest is missing or did not
            // override it). When false, re-raise so the caller can decide.
            const pm = perFormatterManifests[platformName];
            const fallback = !pm || !pm.errorHandling || pm.errorHandling.fallbackToRawTree !== false;
            if (!fallback) {
              err.__formatterIncident = incident;
              err.__platform = platformName;
              throw err;
            }
            // Fall through to default
          }
        }
      }
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

  // Refresh the shadowed-remote map. Recomputed from scratch on every
  // reload so a freshly-deleted custom override stops claiming a shadow.
  shadowedPlatformConfigs = {};
  shadowedPerFormatterManifests = {};
  if (autoManifest && autoManifest.platforms) {
    for (const platformName of customPlatforms) {
      if (autoManifest.platforms[platformName]) {
        shadowedPlatformConfigs[platformName] = autoManifest.platforms[platformName];
      }
    }
  }

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
  const shadowNames = Object.keys(shadowedPlatformConfigs);
  if (shadowNames.length > 0) {
    console.log('[formatter-manager] Custom formatters shadowing remote:', shadowNames.join(', '));
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
    const shadowed = shadowedPerFormatterManifests[name];
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
      workflows,
      // Present only when a same-named custom formatter is currently
      // shadowing a remote one. Routing-inactive — no workflows are loaded
      // for this copy. Delete the custom-formatters/<name>/ directory to
      // restore the remote-signed version.
      shadowedRemote: shadowed
        ? {
            name,
            version: shadowed.version || '0.0.0',
            match: shadowed.match || '',
            description: shadowed.description || '',
            notes: shadowed.notes || '',
            source: 'remote'
          }
        : null
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
      extras: 'any additional fields returned by the formatter (e.g., postCount, listingCount, platform)',
      __resolve: 'OPTIONAL, non-enumerable own property (Object.defineProperty(result, "__resolve", { value, enumerable: false })). Shape: { resolvers: { name: "function source string" }, requests: [{ key, backendNodeId, resolver: name }], apply(resolvedByKey) -> full new result }. Resolver functions run in the page with `this` = the DOM element for backendNodeId; they must be self-contained functions (no closures, no eval) returning JSON-serializable values. Limits: <=1000 requests, 500 ids per call, <=10 calls, source <=32KB, 5s timeout. apply receives only non-null resolved values and must return a new result with a string tree (<= 2x original length + 4KB); refs and elementCount are forced back to the originals. Any failure (old extension, timeout, throw) returns the base result, never an error.'
    }
  };
}

function getHowToCreateCustomFormatter() {
  return {
    overview: 'A formatter is a JS function that turns raw accessibility nodes into a compact tree for agents. A platform may also ship workflows (server-side multi-step actions run via webpilot_run_workflow), a per-platform manifest whose `notes` field is read by other agents, and page-side node resolution for data that is not in the accessibility tree. Build order: formatter + manifest, reload and test, then workflows, then node resolution only if needed.',
    modulePattern: 'CommonJS module exporting a single function',
    functionSignature: 'function formatSiteName(nodes) — receives ONLY the array of raw CDP accessibility nodes (no url argument). To route by page type, read the RootWebArea node\'s `url` property (an entry named "url" in its properties array) and delegate to page-specific sub-formatters.',
    outputRequirements: 'Must return { tree: string, elementCount: number, refs: { e1: backendDOMNodeId, e2: ... }, ...optionalExtras }',
    refsExplanation: 'The refs object maps ref strings to backendDOMNodeId values. These refs enable the agent to target elements with browser_click, browser_scroll, and browser_type tools.',
    routerPattern: 'For multi-page sites, export a router function that detects the page type from the RootWebArea node\'s url and delegates to page-specific sub-formatters.',
    customFormatters: {
      step1: 'Create a directory per platform inside the custom-formatters directory (path shown in the customFormatterDir field of this response), e.g. <customFormatterDir>/myplatform/myplatform.js, plus myplatform/manifest.json (see platformManifest) and optionally myplatform/workflows.js (see workflows).',
      step2: 'Edit <customFormatterDir>/manifest.json to add your platform entry under "platforms": { "myplatform": { "match": "hostname-substring", "entry": "myplatform/myplatform.js" } }. "match" is a substring test against the tab URL hostname; the first matching platform wins.',
      step3: 'Custom formatters are never overwritten by auto-updates — they persist across server updates',
      step4: 'Call webpilot_reload_formatters to load your changes (no server restart needed), then test with browser_get_accessibility_tree or webpilot_run_workflow. If something broke, call webpilot_dev_get_formatter_logs with platform set to your platform name.'
    },
    workflows: {
      purpose: 'A workflow bundles several browser actions into one named operation that agents run with webpilot_run_workflow({ platform, workflow, tab_id, params }).',
      files: 'Put workflows in workflows.js next to the formatter entry file (same directory). It must export an object map: module.exports = { my_workflow: { description, parameters, run } }.',
      exportRule: 'EVERY export is treated as a workflow. Do not export helpers, constants or the formatter; keep them module-private. An export that is not declared in the platform manifest is skipped with a warning.',
      declaration: 'Declare each workflow in the platform manifest.json under "workflows": [{ name, description, parameters }]. The description and parameters must be identical to the ones exported from workflows.js. parameters is a map of { paramName: { type, description } } where type is string, number, boolean, object or array. A workflow is only registered if the manifest declares it AND the export has description (non-empty string), parameters (object) and run (function). webpilot_get_formatter_info shows implemented: true for registered ones.',
      runSignature: 'async run({ params, browser, tabId, findInTree }) -> JSON-serializable object. The server wraps it as { ok: true, ...result }; a thrown error becomes a failed call and is recorded in webpilot_dev_get_formatter_logs. Declared param types are checked before run() starts, but every param is optional, so run() must assert the ones it needs.',
      browserPrimitives: [
        'browser.getAccessibilityTree({ tab_id, usePlatformOptimizer? }) -> the formatted result { tree, elementCount, refs, ...extras } (not the raw nodes)',
        'browser.click({ tab_id, ref? | selector? | x, y, button?, clickCount?, delay?, showCursor? })',
        'browser.type({ tab_id, text, ref? | selector?, delay?, pressEnter? })',
        'browser.scroll({ tab_id, ref? | selector?, pixels?, direction?, amount? })',
        'browser.getTabs() -> open tabs',
        'browser.createTab({ url })',
        'browser.resolveRefs({ tab_id, refs, resolver }) -> one JSON value (or null) per ref; resolver is a self-contained function (or its source string) run in the page with this = the element; throws on failure (see nodeResolution)'
      ],
      sitePolicy: 'Every primitive except getTabs is checked against the site policy on each call (resolveRefs is checked like getAccessibilityTree). A blocked call throws; let it propagate so the caller gets the policy result, and do not retry.',
      findInTree: 'findInTree(treeResult, selector) searches the formatted tree STRING (not raw nodes), so match what your formatter prints. Selector keys (all optional, ANDed): role (case-insensitive substring of the line), name (exact line text after the [eN] prefix), name_starts_with (prefix), name_contains (case-insensitive substring). Returns { ref, line } for the first matching line or null. Example: findInTree(tree, { role: "textbox", name_starts_with: "Message " }).',
      conventions: [
        'Refs are only valid for the latest tree of a tab. Fetch a tree, find the ref, act on it. If a caller hands you a ref (e.g. as a param), click it directly: fetching a new tree in between invalidates it.',
        'Set one overall deadline (e.g. a timeoutMs param, default under ~45s) and check it in every wait/poll loop. On expiry return { pending: true, message } telling the caller to re-read state (get the tree) before retrying. Never blindly repeat a click: a click on a background tab can time out yet still apply late.',
        'Return { ok: false, reason, message } for expected failures (not found, wrong page, blocking dialog). Throw only for genuine errors.',
        'Validate params at the top of run() (type, non-empty, ranges) and fail fast with a clear message.',
        'Keep helpers module-private (not exported) and results small: return only what the caller needs.'
      ],
      skeleton: [
        "'use strict';",
        "module.exports = {",
        "  open_item: {",
        "    description: 'Open the first link whose name contains the given text.',",
        "    parameters: { name: { type: 'string', description: 'Text to look for.' } },",
        "    async run({ params, browser, tabId, findInTree }) {",
        "      if (typeof params.name !== 'string' || !params.name) return { ok: false, reason: 'bad_params', message: 'name is required' };",
        "      const tree = await browser.getAccessibilityTree({ tab_id: tabId });",
        "      const hit = findInTree(tree, { role: 'link', name_contains: params.name });",
        "      if (!hit) return { ok: false, reason: 'not_found', message: 'No link matches ' + params.name };",
        "      await browser.click({ tab_id: tabId, ref: hit.ref });",
        "      return { clicked: hit.line };",
        "    }",
        "  }",
        "};"
      ]
    },
    platformManifest: {
      file: '<platform dir>/manifest.json, next to the formatter entry file (e.g. <customFormatterDir>/myplatform/manifest.json).',
      fields: {
        name: 'required — platform name; match the directory and the key in the top-level manifest.json',
        version: 'required — informational semver; bump it on every edit so webpilot_reload_formatters shows your edit took effect. For custom formatters use a suffix such as "1.0.0-custom" to tell it apart from a remote copy',
        match: 'required — hostname substring (same as in the top-level manifest entry)',
        source: 'required by the loader but overridden by where the file lives (custom dir => "custom"); write "custom"',
        description: 'required — one line on what the formatter covers',
        notes: 'optional but important — this is the text OTHER agents read through webpilot_get_formatter_info. Put usage instructions here: how pages are laid out, what the tree and extras contain, which workflows to use and in what order, their params, edge cases, what a pending result means.',
        errorHandling: 'optional — { fallbackToRawTree: true } (default) falls back to the default formatter output if your formatter throws; false surfaces the error',
        workflows: 'optional — array of { name, description, parameters } (see workflows)'
      },
      loaderRules: 'If name, version, match, source or description is missing (or the file is not valid JSON) the manifest is replaced by an empty synthesized one: notes are lost and no workflows load. A manifest-declared workflow with no valid implementation shows implemented: false.',
      shadowing: 'A custom platform with the same name as a remote (auto-updated) platform replaces it for routing and workflows; webpilot_get_formatter_info lists the replaced one under shadowedRemote. Either keep your copy in sync with upstream or remove the custom entry to go back to the remote one.',
      example: [
        '{',
        '  "name": "mysite", "version": "1.0.0-custom", "match": "mysite.com", "source": "custom",',
        '  "description": "MySite listings and item pages",',
        '  "notes": "Item pages show [eN] links; run open_item({name}) to open one. Links carry [id=...] tags when node resolution is available.",',
        '  "errorHandling": { "fallbackToRawTree": true },',
        '  "workflows": [{ "name": "open_item", "description": "Open the first link whose name contains the given text.", "parameters": { "name": { "type": "string", "description": "Text to look for." } } }]',
        '}'
      ]
    },
    nodeResolution: {
      purpose: 'Read values that exist only in the page (e.g. data attributes, framework internals) for specific accessibility nodes, then fold them into the tree. Optional: formatters that do not need it never touch it.',
      how: 'Attach a NON-ENUMERABLE __resolve = { resolvers, requests, apply } to the returned result. resolvers: { name: "function source string" }. requests: [{ key, backendNodeId, resolver: name }] (build them from the nodes\' backendDOMNodeId while formatting). apply(resolvedByKey) receives { key: value } for non-null results and must return a NEW full result with a string tree. Resolvers run in the page with this = the DOM element for the node; the original refs and elementCount are kept.',
      workflows: 'Workflows can run the same kind of function on refs from the latest tree: await browser.resolveRefs({ tab_id: tabId, refs: ["e5"], resolver: fn }) returns one value (or null) per ref and throws on failure. Use it when you need data for a few elements without re-annotating the whole tree.',
      rules: [
        'Resolvers must be self-contained: no closures over outer variables, no eval/new Function, no imports. They are serialized with fn.toString() and run in the page.',
        'Return only JSON-serializable values, and only the fields you need (small strings, numbers, flat objects). Return null when nothing is found; wrap the body in try/catch.',
        'Never read or return secrets: auth tokens, localStorage/sessionStorage, cookies, passwords.',
        'Cap any walk (ancestors, framework fiber chains, children) with an explicit depth/iteration limit.',
        'Resolution can fail silently (older extension or server, timeout, thrown error) and then the base result is returned as is, so the base tree must already be valid and useful without the extra data.',
        'apply must not mutate the original result and must return a plain new object (spreading the result drops the non-enumerable __resolve).'
      ],
      limits: 'At most 1000 requests per tree, 500 node ids per extension call, 10 calls (grouped per resolver); resolver source up to 32KB; 5 second timeout; the returned tree may be at most 2x the original length + 4KB, otherwise the base result is used.',
      failureMode: 'If resolution fails the base result is returned unchanged.',
      example: [
        "'use strict';",
        "// Runs in the page: this = the DOM element. Self-contained, JSON-only, never throws.",
        "function readItemId() {",
        "  try {",
        "    return this.getAttribute('data-item-id') || null;",
        "  } catch (e) {",
        "    return null;",
        "  }",
        "}",
        "module.exports = function formatMysite(nodes) {",
        "  const refs = {};",
        "  const requests = [];",
        "  let refCounter = 1;",
        "  let tree = '';",
        "  for (const node of nodes) {",
        "    if (node.ignored) continue;",
        "    const ref = 'e' + refCounter++;",
        "    refs[ref] = node.backendDOMNodeId;",
        "    tree += `[${ref}] ${node.role.value}: ${node.name?.value || ''}\\n`;",
        "    if (node.role.value === 'link' && node.backendDOMNodeId) {",
        "      requests.push({ key: ref, backendNodeId: node.backendDOMNodeId, resolver: 'itemId' });",
        "    }",
        "  }",
        "  const result = { tree, elementCount: Object.keys(refs).length, refs };",
        "  Object.defineProperty(result, '__resolve', {",
        "    enumerable: false,",
        "    value: {",
        "      resolvers: { itemId: readItemId.toString() },",
        "      requests,",
        "      apply(resolvedByKey) {",
        "        const lines = tree.split('\\n').map((line) => {",
        "          const m = line.match(/^\\[(e\\d+)\\]/);",
        "          return m && resolvedByKey[m[1]] ? `${line} [id=${resolvedByKey[m[1]]}]` : line;",
        "        });",
        "        return { ...result, tree: lines.join('\\n') };",
        "      }",
        "    }",
        "  });",
        "  return result;",
        "};"
      ]
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

/**
 * Snapshot of every loaded per-formatter manifest, keyed by formatter name.
 * Each value carries name/version/match/source/description/notes/errorHandling/
 * workflows. Used by the Web UI Formatters tab (`/api/ui/formatters`) and
 * `webpilot_get_formatter_info` so consumers don't re-read manifest.json from
 * disk. Returns a shallow copy of the internal map so callers can't mutate
 * the live state.
 *
 * @returns {Object<string, object>}
 */
function getPerFormatterManifests() {
  return { ...perFormatterManifests };
}

/**
 * Snapshot of every per-formatter manifest whose platform name exists in
 * BOTH the auto-updated and custom manifests — i.e. the remote copy is
 * currently being shadowed by a same-named custom formatter and would
 * route if the custom override were removed. Keyed by formatter name.
 *
 * Empty object when there is no overlap (the common case). Used by
 * `/api/ui/formatters` so the dashboard can render a "shadowed by local
 * override" sub-row next to the active formatter.
 *
 * @returns {Object<string, object>}
 */
function getShadowedFormatterManifests() {
  return { ...shadowedPerFormatterManifests };
}

module.exports = {
  init,
  formatTree,
  getFormatterNameForUrl,
  reload,
  getFormatterInfo,
  getCustomFormatterDir,
  getPerFormatterManifests,
  getShadowedFormatterManifests,
  getWorkflow,
  listWorkflows
};
