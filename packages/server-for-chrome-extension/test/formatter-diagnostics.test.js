'use strict';

/**
 * Tests for issue #57: formatter error diagnostics.
 * Covers extractTopFrame, buildDiagnostics, workflow/format error paths,
 * and the no-double-record invariant.
 */

const assert = require('assert');

// ---------------------------------------------------------------------------
// Stub db/connection so formatter-logs can run without a real SQLite DB.
// ---------------------------------------------------------------------------
const Module = require('module');
const origLoad = Module._load.bind(Module);
let _stubIncidentId = 1;
const _insertedRows = [];

Module._load = function (request, parent, isMain) {
  if (request === './db/connection' || (parent && parent.filename && parent.filename.includes('formatter-logs') && request.includes('connection'))) {
    const fakeDb = {
      prepare(sql) {
        return {
          run(...args) {
            _insertedRows.push({ sql, args });
            return { lastInsertRowid: _stubIncidentId++ };
          },
          get() { return null; },
          all() { return []; }
        };
      }
    };
    return { getDb: () => fakeDb };
  }
  return origLoad(request, parent, isMain);
};

// Now load formatter-logs with the stub in place.
const formatterLogs = require('../src/formatter-logs');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeIncident(overrides = {}) {
  return {
    id: 1,
    formatter: 'test-platform',
    timestamp: '2026-01-01T00:00:00.000Z',
    phase: 'workflow',
    workflow: 'doThing',
    message: 'oops',
    stack: '    at Timeout._onTimeout (extension-bridge.js:141:5)\n    at listOnTimeout (node:internal/timers:559:17)',
    params: { url: 'https://example.com' },
    tabId: 42,
    dismissedAt: null,
    dismissedBy: null,
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// extractTopFrame
// ---------------------------------------------------------------------------
{
  const { extractTopFrame } = formatterLogs;

  // Valid V8 stack with one frame
  const stack = '    at Timeout._onTimeout (extension-bridge.js:141:5)\n    at listOnTimeout (node:internal/timers:559:17)';
  const result = extractTopFrame(stack);
  assert.strictEqual(result, 'extension-bridge.js:141 (Timeout._onTimeout)', `extractTopFrame valid: got ${result}`);

  // Absolute path — only basename should appear
  const stackAbs = '    at MyClass.method (/home/user/code/formatter-manager.js:88:12)';
  const resultAbs = extractTopFrame(stackAbs);
  assert.strictEqual(resultAbs, 'formatter-manager.js:88 (MyClass.method)', `extractTopFrame abs path: got ${resultAbs}`);

  // Garbage input returns null
  assert.strictEqual(extractTopFrame(null), null, 'extractTopFrame null → null');
  assert.strictEqual(extractTopFrame(''), null, 'extractTopFrame empty → null');
  assert.strictEqual(extractTopFrame('no frames here'), null, 'extractTopFrame garbage → null');
  assert.strictEqual(extractTopFrame(42), null, 'extractTopFrame non-string → null');

  console.log('extractTopFrame: PASS');
}

// ---------------------------------------------------------------------------
// buildDiagnostics — exact key set, correct values
// ---------------------------------------------------------------------------
{
  const { buildDiagnostics } = formatterLogs;

  const incident = makeIncident({ phase: 'workflow', workflow: 'doThing', tabId: 42 });
  const diag = buildDiagnostics(incident, 'myplatform');

  // Exact key set — no extra keys
  const keys = Object.keys(diag).sort();
  assert.deepStrictEqual(keys, ['more', 'phase', 'platform', 'tabId', 'topFrame', 'workflow'], `buildDiagnostics keys: got ${keys}`);

  assert.strictEqual(diag.phase, 'workflow');
  assert.strictEqual(diag.workflow, 'doThing');
  assert.strictEqual(diag.platform, 'myplatform');
  assert.strictEqual(diag.tabId, 42);
  assert.ok(diag.topFrame, 'topFrame should be non-null for a stack with a frame');
  assert.ok(diag.more.includes("webpilot_dev_get_formatter_logs({platform: 'myplatform'})"), `more hint: got ${diag.more}`);

  // format-phase incident: workflow should be null
  const formatIncident = makeIncident({ phase: 'format', workflow: null, tabId: null });
  const diagFormat = buildDiagnostics(formatIncident, 'someplatform');
  assert.strictEqual(diagFormat.phase, 'format');
  assert.strictEqual(diagFormat.workflow, null);
  assert.strictEqual(diagFormat.tabId, null);

  // No params/stack/timestamp in returned object
  assert.ok(!('params' in diag), 'buildDiagnostics must not include params');
  assert.ok(!('stack' in diag), 'buildDiagnostics must not include stack');
  assert.ok(!('timestamp' in diag), 'buildDiagnostics must not include timestamp');

  console.log('buildDiagnostics: PASS');
}

// ---------------------------------------------------------------------------
// recordError returns the incident
// ---------------------------------------------------------------------------
{
  formatterLogs._resetForTests();
  _insertedRows.length = 0;

  const incident = formatterLogs.recordError('myplatform', {
    error: new Error('boom'),
    phase: 'format',
    tabId: 7
  });

  assert.ok(incident, 'recordError should return the incident');
  assert.strictEqual(incident.phase, 'format');
  assert.strictEqual(incident.tabId, 7);
  assert.strictEqual(incident.formatter, 'myplatform');

  console.log('recordError returns incident: PASS');
}

// ---------------------------------------------------------------------------
// Workflow error path: diagnostics.phase === 'workflow', correct fields
// ---------------------------------------------------------------------------
{
  formatterLogs._resetForTests();
  _insertedRows.length = 0;

  const err = new Error('workflow failed');
  err.stack = '    at runWorkflow (some-workflow.js:55:10)\n    at process.nextTick (node:internal/process/task_queues:81:21)';

  // Simulate what mcp-handler's workflow catch block does (no __formatterIncident)
  const incident = formatterLogs.recordError('discord', {
    error: err,
    phase: 'workflow',
    workflow: 'sendMessage',
    params: { text: 'hi' },
    tabId: 99
  });
  const diag = formatterLogs.buildDiagnostics(incident, 'discord');

  assert.strictEqual(diag.phase, 'workflow');
  assert.strictEqual(diag.workflow, 'sendMessage');
  assert.strictEqual(diag.platform, 'discord');
  assert.strictEqual(diag.tabId, 99);
  assert.ok(diag.topFrame !== null, 'topFrame should be non-null for valid stack');

  console.log('workflow error path diagnostics: PASS');
}

// ---------------------------------------------------------------------------
// Format-phase no-fallback: diagnostics.phase === 'format', workflow === null
// ---------------------------------------------------------------------------
{
  formatterLogs._resetForTests();
  _insertedRows.length = 0;

  const err = new Error('formatter crashed');
  err.stack = '    at Object.formatFn (threads-formatter.js:23:7)';

  const incident = formatterLogs.recordError('threads', {
    error: err,
    phase: 'format',
    tabId: 5
  });
  const diag = formatterLogs.buildDiagnostics(incident, 'threads');

  assert.strictEqual(diag.phase, 'format');
  assert.strictEqual(diag.workflow, null);
  assert.strictEqual(diag.platform, 'threads');
  assert.strictEqual(diag.tabId, 5);

  console.log('format-phase diagnostics: PASS');
}

// ---------------------------------------------------------------------------
// No-double-record: workflow path using err.__formatterIncident doesn't push
// a duplicate entry to the ring buffer.
// ---------------------------------------------------------------------------
{
  formatterLogs._resetForTests();
  _insertedRows.length = 0;

  // Simulate formatter already recording via recordError (as formatTree does)
  const err = new Error('formatter blew up');
  err.stack = '    at formatFn (zillow-formatter.js:10:3)';
  const incident = formatterLogs.recordError('zillow', {
    error: err,
    phase: 'format',
    tabId: 12
  });
  err.__formatterIncident = incident;
  err.__platform = 'zillow';

  const countBefore = formatterLogs.getLogs('zillow').length;
  const insertsBefore = _insertedRows.length;

  // Simulate mcp-handler workflow catch block: uses err.__formatterIncident, skips recordError
  let incidentUsed;
  if (err.__formatterIncident) {
    incidentUsed = err.__formatterIncident;
  } else {
    incidentUsed = formatterLogs.recordError('zillow', { error: err, phase: 'workflow', workflow: 'foo' });
  }

  const countAfter = formatterLogs.getLogs('zillow').length;
  const insertsAfter = _insertedRows.length;

  assert.strictEqual(countAfter, countBefore, 'Ring buffer count must not grow on second path');
  assert.strictEqual(insertsAfter, insertsBefore, 'No additional DB insert on second path');
  assert.strictEqual(incidentUsed, incident, 'Should reuse the same incident object');

  console.log('no-double-record: PASS');
}

console.log('\nAll formatter-diagnostics tests passed.');
