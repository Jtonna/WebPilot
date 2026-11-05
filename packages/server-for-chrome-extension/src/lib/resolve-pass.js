'use strict';

// Generic page-side node resolution for formatters (#161).
//
// A formatter result MAY carry a NON-ENUMERABLE own property `__resolve`:
//   { resolvers: { name: '<function source>' },
//     requests:  [ { key, backendNodeId, resolver: name } ],
//     apply(resolvedByKey) -> full new formatter result }
// runResolvePass() sends the requests to the extension (`resolve_nodes`),
// then calls apply() with the resolved values. Every failure path returns the
// ORIGINAL formatted result, so resolution can never break a tree fetch.

const MAX_CALLS = 10;
const TREE_SLACK = 4096;

function normalizeResolverSource(fnOrString) {
  if (typeof fnOrString === 'function') return fnOrString.toString();
  if (typeof fnOrString === 'string') return fnOrString;
  throw new Error('resolver must be a function or a function source string');
}

async function runResolvePass(formatted, opts = {}) {
  const { sendResolve, onApplyError, maxRequests = 1000, chunk = 500 } = opts;
  const spec = formatted && formatted.__resolve;
  if (
    !spec ||
    typeof spec.apply !== 'function' ||
    !Array.isArray(spec.requests) ||
    spec.requests.length === 0 ||
    !spec.resolvers ||
    typeof spec.resolvers !== 'object' ||
    typeof sendResolve !== 'function'
  ) {
    return formatted;
  }

  const valid = [];
  for (const r of spec.requests) {
    if (!r || typeof r.key !== 'string' || typeof r.backendNodeId !== 'number') continue;
    if (typeof r.resolver !== 'string' || !Object.prototype.hasOwnProperty.call(spec.resolvers, r.resolver)) continue;
    if (typeof spec.resolvers[r.resolver] !== 'string') continue;
    valid.push(r);
    if (valid.length >= maxRequests) break;
  }
  if (valid.length === 0) return formatted;

  // Group by resolver, then split into calls of at most `chunk` ids.
  const groups = new Map();
  for (const r of valid) {
    if (!groups.has(r.resolver)) groups.set(r.resolver, []);
    groups.get(r.resolver).push(r);
  }
  const calls = [];
  const callRequests = [];
  for (const [name, reqs] of groups) {
    for (let i = 0; i < reqs.length; i += chunk) {
      const slice = reqs.slice(i, i + chunk);
      calls.push({ functionDeclaration: spec.resolvers[name], backendNodeIds: slice.map((r) => r.backendNodeId) });
      callRequests.push(slice);
    }
  }
  if (calls.length > MAX_CALLS) {
    calls.length = MAX_CALLS;
    callRequests.length = MAX_CALLS;
  }

  let res;
  try {
    res = await sendResolve(calls);
  } catch (_err) {
    return formatted;
  }

  const resolvedByKey = {};
  const results = res && Array.isArray(res.results) ? res.results : [];
  callRequests.forEach((reqs, ci) => {
    const row = Array.isArray(results[ci]) ? results[ci] : [];
    reqs.forEach((r, i) => {
      const v = row[i];
      if (v !== null && v !== undefined) resolvedByKey[r.key] = v;
    });
  });

  let out;
  try {
    out = spec.apply(resolvedByKey);
  } catch (err) {
    if (typeof onApplyError === 'function') {
      try { onApplyError(err); } catch (_e) { /* ignore */ }
    }
    return formatted;
  }

  const origLen = typeof formatted.tree === 'string' ? formatted.tree.length : 0;
  if (
    !out ||
    typeof out !== 'object' ||
    typeof out.tree !== 'string' ||
    out.tree.length > 2 * origLen + TREE_SLACK
  ) {
    return formatted;
  }
  // Fresh object: never carry __resolve forward.
  const result = { ...out, refs: formatted.refs, elementCount: formatted.elementCount };
  delete result.__resolve;
  return result;
}

module.exports = { runResolvePass, normalizeResolverSource };
