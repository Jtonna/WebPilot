'use strict';

/**
 * tree-query.js — small helpers for querying a formatted accessibility tree
 * inside server-side workflow `run()` functions.
 *
 * The accessibility tree handed to a formatter is an array of raw CDP nodes,
 * but the *output* the formatter returns is a flat `refs` map (e.g.
 * `{ e1: backendDOMNodeId, ... }`) plus a human-readable `tree` string. The
 * Web UI / formatter output never re-exposes the raw nodes — so workflows
 * cannot walk the raw a11y tree the same way the formatter did. Instead,
 * workflows are handed the *parsed* result object from
 * `browser.getAccessibilityTree({ tab_id })`, which contains:
 *
 *   { tree, elementCount, refs, ...extras }
 *
 * `findInTree` does best-effort selector matching against the `tree` string
 * — most formatters emit lines like `[e42] Message textbox` or
 * `[e3] Reply` so we can pick out a ref by `role` (substring match against
 * the line text) and `name_*` selectors. This is intentionally text-based
 * and minimal in scope: workflows are platform-specific and the matching
 * needs are narrow per workflow. If a workflow needs richer queries, the
 * platform formatter can emit them as `extras` and the workflow can read
 * them directly from the result object.
 *
 * Selector shape:
 *   {
 *     role: 'textbox',                 // substring match against the line
 *     name: 'Message textbox',         // exact match against the line content
 *     name_starts_with: 'Message #',   // prefix match
 *     name_contains: 'Compose',        // substring
 *   }
 *
 * Return shape:
 *   { ref: 'e42', line: '[e42] Message textbox' } | null
 */

/**
 * Walk a formatted-tree result object and return the first matching
 * `{ ref, line }` pair (or `null` if no match).
 *
 * Accepts either:
 *   - the full formatted result object `{ tree, refs, ... }`
 *   - or a plain `{ tree }` object
 *
 * @param {object} treeResult
 * @param {object} selector
 * @returns {{ ref: string, line: string } | null}
 */
function findInTree(treeResult, selector = {}) {
  if (!treeResult || typeof treeResult !== 'object') return null;
  const tree = typeof treeResult === 'string' ? treeResult : treeResult.tree;
  if (typeof tree !== 'string' || tree.length === 0) return null;

  const lines = tree.split('\n');
  for (const line of lines) {
    if (!lineMatches(line, selector)) continue;
    const ref = extractRef(line);
    if (!ref) continue;
    return { ref, line };
  }
  return null;
}

/**
 * Same as `findInTree`, but returns every matching `{ ref, line }`.
 */
function findAllInTree(treeResult, selector = {}) {
  if (!treeResult || typeof treeResult !== 'object') return [];
  const tree = typeof treeResult === 'string' ? treeResult : treeResult.tree;
  if (typeof tree !== 'string' || tree.length === 0) return [];

  const out = [];
  for (const line of tree.split('\n')) {
    if (!lineMatches(line, selector)) continue;
    const ref = extractRef(line);
    if (!ref) continue;
    out.push({ ref, line });
  }
  return out;
}

function extractRef(line) {
  // Lines look like "[e42] Message textbox" or "[e1] Reply (3 mentions)".
  const m = line.match(/\[(e\d+)\]/);
  return m ? m[1] : null;
}

function lineMatches(line, selector) {
  if (!selector || typeof selector !== 'object') return true;

  // Strip the leading "[eN] " prefix so role/name matchers operate on the
  // textual content of the line.
  const stripped = line.replace(/^\[e\d+\]\s*/, '');

  if (selector.role && !stripped.toLowerCase().includes(String(selector.role).toLowerCase())) {
    return false;
  }
  if (selector.name && stripped.trim() !== String(selector.name).trim()) {
    return false;
  }
  if (selector.name_starts_with &&
      !stripped.trim().startsWith(String(selector.name_starts_with))) {
    return false;
  }
  if (selector.name_contains &&
      !stripped.toLowerCase().includes(String(selector.name_contains).toLowerCase())) {
    return false;
  }
  return true;
}

module.exports = { findInTree, findAllInTree };
