const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const modUrl = pathToFileURL(
  path.join(__dirname, '..', '..', 'chrome-extension-unpacked', 'utils', 'resolve-batch.js')
).href;

const okCall = () => ({ functionDeclaration: 'function(){ return 1; }', backendNodeIds: [1, 2] });

test('validateResolveParams rejects bad input', async () => {
  const { validateResolveParams } = await import(modUrl);
  const bad = (p) => assert.throws(() => validateResolveParams(p));
  bad(undefined);
  bad({ calls: [okCall()] });
  bad({ tab_id: '5', calls: [okCall()] });
  bad({ tab_id: 5, calls: 'x' });
  bad({ tab_id: 5, calls: [] });
  bad({ tab_id: 5, calls: Array.from({ length: 11 }, okCall) });
  bad({ tab_id: 5, calls: [{ ...okCall(), functionDeclaration: 5 }] });
  bad({ tab_id: 5, calls: [{ ...okCall(), functionDeclaration: 'function(){' + 'a'.repeat(33 * 1024) + '}' }] });
  bad({ tab_id: 5, calls: [{ ...okCall(), functionDeclaration: 'return 1' }] });
  bad({ tab_id: 5, calls: [{ functionDeclaration: 'function(){}' }] });
  bad({ tab_id: 5, calls: [{ functionDeclaration: 'function(){}', backendNodeIds: [1], refs: ['e1'] }] });
  bad({ tab_id: 5, calls: [{ functionDeclaration: 'function(){}', backendNodeIds: ['a'] }] });
  bad({ tab_id: 5, calls: [{ functionDeclaration: 'function(){}', refs: [1] }] });
  bad({ tab_id: 5, calls: [{ functionDeclaration: 'function(){}', backendNodeIds: new Array(501).fill(1) }] });
  bad({ tab_id: 5, calls: [{ functionDeclaration: 'function(){}', refs: new Array(501).fill('e1') }] });
});

test('validateResolveParams accepts valid input', async () => {
  const { validateResolveParams } = await import(modUrl);
  validateResolveParams({ tab_id: 5, calls: [okCall()] });
  validateResolveParams({ tab_id: 5, calls: [{ functionDeclaration: ' function(){}', refs: ['e1'] }] });
  validateResolveParams({ tab_id: 5, calls: Array.from({ length: 10 }, okCall) });
});

test('buildBatchDeclaration maps elements and isolates failures', async () => {
  const { buildBatchDeclaration } = await import(modUrl);
  const src = 'function(){ if (this.boom) throw new Error("x"); return this.name; }';
  const fn = new Function('return (' + buildBatchDeclaration(src) + ')')();
  const out = fn({ name: 'a' }, null, { boom: true }, { name: undefined }, { name: 'b' }, undefined);
  assert.deepStrictEqual(out, ['a', null, null, null, 'b', null]);
});

function makeSend({ resolveFail = [], callImpl } = {}) {
  const log = [];
  const send = async (method, params) => {
    log.push({ method, params });
    if (method === 'DOM.resolveNode') {
      if (resolveFail.includes(params.backendNodeId)) throw new Error('no node');
      return { object: { objectId: 'obj' + params.backendNodeId } };
    }
    if (method === 'Runtime.callFunctionOn') return callImpl(params);
    return {};
  };
  return { send, log };
}

const count = (log, m) => log.filter((l) => l.method === m).length;

test('runResolveCalls success, null slots and release', async () => {
  const { runResolveCalls } = await import(modUrl);
  const { send, log } = makeSend({
    resolveFail: [2],
    callImpl: (p) => ({ result: { value: p.arguments.map((a) => (a.objectId ? a.objectId : null)) } })
  });
  const r = await runResolveCalls(send, [{ functionDeclaration: 'function(){}', backendNodeIds: [1, 2, null, 3] }]);
  assert.deepStrictEqual(r, { results: [['obj1', null, null, 'obj3']], errors: [null] });
  const cfo = log.find((l) => l.method === 'Runtime.callFunctionOn');
  assert.strictEqual(cfo.params.objectId, 'obj1');
  assert.strictEqual(cfo.params.returnByValue, true);
  assert.ok(!('executionContextId' in cfo.params));
  assert.strictEqual(count(log, 'Runtime.releaseObjectGroup'), 1);
  assert.strictEqual(log.find((l) => l.method === 'DOM.resolveNode').params.objectGroup, 'webpilot-resolve');
});

test('runResolveCalls skips callFunctionOn when nothing resolves', async () => {
  const { runResolveCalls } = await import(modUrl);
  const { send, log } = makeSend({ resolveFail: [1, 2], callImpl: () => assert.fail('called') });
  const r = await runResolveCalls(send, [{ functionDeclaration: 'function(){}', backendNodeIds: [1, 2, null] }]);
  assert.deepStrictEqual(r.results, [[null, null, null]]);
  assert.strictEqual(count(log, 'Runtime.callFunctionOn'), 0);
  assert.strictEqual(count(log, 'Runtime.releaseObjectGroup'), 1);
});

test('runResolveCalls handles throw, exceptionDetails and oversize', async () => {
  const { runResolveCalls } = await import(modUrl);
  const calls = [{ functionDeclaration: 'function(){}', backendNodeIds: [1, 2] }];

  let h = makeSend({ callImpl: () => { throw new Error('Argument should belong to the same JavaScript world'); } });
  let r = await runResolveCalls(h.send, calls);
  assert.deepStrictEqual(r.results, [[null, null]]);
  assert.match(r.errors[0], /same JavaScript world/);
  assert.strictEqual(count(h.log, 'Runtime.releaseObjectGroup'), 1);

  h = makeSend({ callImpl: () => ({ exceptionDetails: { text: 'Uncaught', exception: { description: 'SyntaxError: bad' } } }) });
  r = await runResolveCalls(h.send, calls);
  assert.deepStrictEqual(r.results, [[null, null]]);
  assert.match(r.errors[0], /SyntaxError/);
  assert.strictEqual(count(h.log, 'Runtime.releaseObjectGroup'), 1);

  h = makeSend({ callImpl: () => ({ result: { value: ['x'.repeat(1024 * 1024 + 1), 'y'] } }) });
  r = await runResolveCalls(h.send, calls);
  assert.deepStrictEqual(r.results, [[null, null]]);
  assert.ok(r.errors[0]);
  assert.strictEqual(count(h.log, 'Runtime.releaseObjectGroup'), 1);
});

test('runResolveCalls pads short results and swallows release errors', async () => {
  const { runResolveCalls } = await import(modUrl);
  const send = async (m) => {
    if (m === 'DOM.resolveNode') return { object: { objectId: 'o' } };
    if (m === 'Runtime.callFunctionOn') return { result: { value: ['a'] } };
    throw new Error('release failed');
  };
  const r = await runResolveCalls(send, [{ functionDeclaration: 'function(){}', backendNodeIds: [1, 2, 3] }]);
  assert.deepStrictEqual(r.results, [['a', null, null]]);
});

test('runResolveCalls keeps multiple calls aligned', async () => {
  const { runResolveCalls } = await import(modUrl);
  let n = 0;
  const { send, log } = makeSend({
    callImpl: (p) => {
      n++;
      if (n === 2) throw new Error('fail2');
      return { result: { value: p.arguments.map(() => 'v' + n) } };
    }
  });
  const r = await runResolveCalls(send, [
    { functionDeclaration: 'function(){}', backendNodeIds: [1] },
    { functionDeclaration: 'function(){}', backendNodeIds: [2, 3] },
    { functionDeclaration: 'function(){}', backendNodeIds: [4, null] }
  ]);
  assert.deepStrictEqual(r.results, [['v1'], [null, null], ['v3', 'v3']]);
  assert.deepStrictEqual(r.errors, [null, 'fail2', null]);
  assert.strictEqual(count(log, 'Runtime.releaseObjectGroup'), 1);
});
