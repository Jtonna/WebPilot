'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runResolvePass, normalizeResolverSource } = require('../src/lib/resolve-pass');

function make({ requests, resolvers, apply, tree = 'base tree' }) {
  const f = { tree, elementCount: 3, refs: { e1: 1, e2: 2 }, extra: 'x' };
  Object.defineProperty(f, '__resolve', {
    value: { resolvers: resolvers || { r: 'function () { return 1; }' }, requests, apply },
    enumerable: false,
  });
  return f;
}
const reqs = (n, resolver = 'r') =>
  Array.from({ length: n }, (_, i) => ({ key: 'k' + i, backendNodeId: i + 1, resolver }));
const okApply = (m) => ({ tree: 'annotated ' + Object.keys(m).join(','), elementCount: 99, refs: { z: 9 }, extra: 'y' });

test('no __resolve -> same object, sendResolve not called', async () => {
  const f = { tree: 't', elementCount: 1, refs: {} };
  let called = false;
  const out = await runResolvePass(f, { sendResolve: async () => { called = true; } });
  assert.equal(out, f);
  assert.equal(called, false);
});

test('malformed __resolve -> original', async () => {
  const f = make({ requests: [], apply: okApply });
  assert.equal(await runResolvePass(f, { sendResolve: async () => ({}) }), f);
  const g = make({ requests: reqs(1), apply: 'nope' });
  assert.equal(await runResolvePass(g, { sendResolve: async () => ({}) }), g);
});

test('sendResolve rejects (unknown command) -> original', async () => {
  const f = make({ requests: reqs(2), apply: okApply });
  const out = await runResolvePass(f, {
    sendResolve: async () => { throw new Error('Unknown command type: resolve_nodes'); },
  });
  assert.equal(out, f);
});

test('partial nulls -> apply gets only resolved keys; refs/elementCount forced to originals', async () => {
  let seen;
  const f = make({ requests: reqs(3), apply: (m) => { seen = m; return okApply(m); } });
  const out = await runResolvePass(f, {
    sendResolve: async () => ({ results: [['a', null, 'c']], errors: [null] }),
  });
  assert.deepEqual(seen, { k0: 'a', k2: 'c' });
  assert.equal(out.tree, 'annotated k0,k2');
  assert.equal(out.elementCount, 3);
  assert.deepEqual(out.refs, { e1: 1, e2: 2 });
  assert.equal(out.extra, 'y');
});

test('apply throws -> original and onApplyError called', async () => {
  const f = make({ requests: reqs(1), apply: () => { throw new Error('boom'); } });
  let err;
  const out = await runResolvePass(f, {
    sendResolve: async () => ({ results: [['a']], errors: [null] }),
    onApplyError: (e) => { err = e; },
  });
  assert.equal(out, f);
  assert.equal(err.message, 'boom');
});

test('apply output too large or invalid -> original', async () => {
  const big = make({ requests: reqs(1), apply: () => ({ tree: 'x'.repeat(5000) }) });
  const send = async () => ({ results: [['a']], errors: [null] });
  assert.equal(await runResolvePass(big, { sendResolve: send }), big);
  const bad = make({ requests: reqs(1), apply: () => ({ tree: 5 }) });
  assert.equal(await runResolvePass(bad, { sendResolve: send }), bad);
  const nul = make({ requests: reqs(1), apply: () => null });
  assert.equal(await runResolvePass(nul, { sendResolve: send }), nul);
});

test('>chunk requests on one resolver -> multiple calls in ONE sendResolve', async () => {
  const f = make({ requests: reqs(1200), apply: okApply });
  const sent = [];
  await runResolvePass(f, {
    maxRequests: 5000,
    sendResolve: async (calls) => {
      sent.push(calls);
      return { results: calls.map((c) => c.backendNodeIds.map(() => null)), errors: calls.map(() => null) };
    },
  });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].length, 3);
  assert.deepEqual(sent[0].map((c) => c.backendNodeIds.length), [500, 500, 200]);
});

test('>maxRequests truncated without throwing', async () => {
  const f = make({ requests: reqs(50), apply: okApply });
  let ids = 0;
  await runResolvePass(f, {
    maxRequests: 20,
    sendResolve: async (calls) => {
      ids = calls.reduce((n, c) => n + c.backendNodeIds.length, 0);
      return { results: calls.map((c) => c.backendNodeIds.map(() => 'v')), errors: [] };
    },
  });
  assert.equal(ids, 20);
});

test('unknown resolver names / bad entries dropped', async () => {
  const f = make({
    requests: [
      { key: 'a', backendNodeId: 1, resolver: 'r' },
      { key: 'b', backendNodeId: 2, resolver: 'nope' },
      { key: 'c', backendNodeId: 'x', resolver: 'r' },
    ],
    apply: okApply,
  });
  let calls;
  await runResolvePass(f, {
    sendResolve: async (c) => { calls = c; return { results: [['v']], errors: [null] }; },
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].backendNodeIds, [1]);
});

test('result has no enumerable __resolve', async () => {
  const f = make({
    requests: reqs(1),
    apply: (m) => {
      const o = okApply(m);
      Object.defineProperty(o, '__resolve', { value: {}, enumerable: true });
      return o;
    },
  });
  const out = await runResolvePass(f, { sendResolve: async () => ({ results: [['a']], errors: [null] }) });
  assert.notEqual(out, f);
  assert.equal(Object.keys(out).includes('__resolve'), false);
  assert.equal(out.__resolve, undefined);
});

test('normalizeResolverSource', () => {
  assert.equal(normalizeResolverSource('function () {}'), 'function () {}');
  assert.match(normalizeResolverSource(function foo() { return 1; }), /^function foo/);
  assert.throws(() => normalizeResolverSource(42));
});
