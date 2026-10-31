'use strict';

// #129: the extension WebSocket must no longer be able to administer agents.
// The `list_paired_agents` / `rename_agent` / `revoke_key` message handlers and
// the `paired_agents_list` push to extensions were removed from the server.
//
// The extension WS message loop is defined inline inside createServer() (which
// cannot be mounted in isolation without booting the full daemon — it performs
// network I/O and installs non-unref'd maintenance timers), so this is a
// source-level guard: it asserts the removed handler branches and the removed
// extension push are absent from server.js. A behavioural counterpart to the
// extension WS *upgrade* path lives in extension-ws-upgrade.test.js.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const serverSrc = fs.readFileSync(
  path.join(__dirname, '../src/server.js'),
  'utf8'
);

describe('extension WS — agent-admin handlers removed (#129)', () => {
  test('no list_paired_agents / rename_agent / revoke_key message handlers', () => {
    for (const type of ['list_paired_agents', 'rename_agent', 'revoke_key']) {
      assert.ok(
        !serverSrc.includes(`message.type === '${type}'`),
        `server.js still handles extension WS message '${type}'`
      );
    }
  });

  test('server never pushes paired_agents_list to extensions', () => {
    assert.ok(
      !serverSrc.includes("type: 'paired_agents_list'"),
      'server.js still emits a paired_agents_list frame'
    );
    assert.ok(
      !/extensionBridge\.notifyAll\(\s*\{\s*type:\s*['"]paired_agents_list/.test(serverSrc),
      'server.js still broadcasts paired_agents_list to extensions'
    );
  });
});
