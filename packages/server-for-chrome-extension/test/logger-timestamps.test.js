'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { SizeManagedWriter } = require('../src/service/logger.js');

const STAMP = '\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z';
const STAMP_PREFIX = new RegExp(`^(${STAMP}) `);
const STAMP_ANYWHERE = new RegExp(STAMP);

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logger-ts-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('every line in the file starts with an ISO timestamp and continuations are not stamped', () => {
  withTempDir((dir) => {
    const logPath = path.join(dir, 'daemon.log');
    const writer = new SizeManagedWriter(logPath);

    writer.write('alpha ');          // starts line 1
    writer.write('beta\ngamma');     // continues line 1, starts line 2 mid-chunk
    writer.write('\ndelta\n');       // ends line 2, line 3 is "delta", chunk ends in newline
    writer.write(Buffer.from('eps')); // Buffer chunk starts line 4
    writer.write(Buffer.from('ilon\n\nzeta\n')); // continuation, blank line, line

    const text = fs.readFileSync(logPath, 'utf8');
    const lines = text.split('\n');
    assert.equal(lines.pop(), '', 'file should end with a newline');

    assert.equal(lines.length, 6);
    const bodies = lines.map((line) => {
      const m = STAMP_PREFIX.exec(line);
      assert.ok(m, `line does not start with an ISO timestamp: ${JSON.stringify(line)}`);
      return line.slice(m[0].length);
    });
    assert.deepEqual(bodies, ['alpha beta', 'gamma', 'delta', 'epsilon', '', 'zeta']);

    for (const body of bodies) {
      assert.ok(!STAMP_ANYWHERE.test(body), `timestamp found mid-line: ${JSON.stringify(body)}`);
    }

    assert.equal(writer.bytesWritten, Buffer.byteLength(text, 'utf8'));
  });
});

test('a continuation chunk that ends mid-line is not stamped and the next chunk continues it', () => {
  withTempDir((dir) => {
    const logPath = path.join(dir, 'daemon.log');
    const writer = new SizeManagedWriter(logPath);

    writer.write('one\n');
    writer.write('two');
    writer.write(' three');
    writer.write('\n');

    const lines = fs.readFileSync(logPath, 'utf8').split('\n');
    assert.equal(lines.length, 3);
    assert.match(lines[0], STAMP_PREFIX);
    assert.match(lines[1], STAMP_PREFIX);
    assert.equal(lines[1].replace(STAMP_PREFIX, ''), 'two three');
  });
});

test('multi-byte UTF-8 split across Buffer chunks is decoded correctly', () => {
  withTempDir((dir) => {
    const logPath = path.join(dir, 'daemon.log');
    const writer = new SizeManagedWriter(logPath);
    const bytes = Buffer.from('café\n', 'utf8'); // 'é' is two bytes

    writer.write(bytes.subarray(0, 4)); // cuts 'é' in half
    writer.write(bytes.subarray(4));

    const lines = fs.readFileSync(logPath, 'utf8').split('\n');
    assert.equal(lines[0].replace(STAMP_PREFIX, ''), 'café');
  });
});

test('rotation triggers at the size limit and size accounting matches the file', () => {
  withTempDir((dir) => {
    const logPath = path.join(dir, 'daemon.log');
    const limit = 400;
    const writer = new SizeManagedWriter(logPath, limit);

    for (let i = 0; i < 40; i++) {
      writer.write(`line ${String(i).padStart(2, '0')} payload-xxxxxxxx\n`);
    }

    const text = fs.readFileSync(logPath, 'utf8');
    assert.ok(text.length < 40 * 60, 'file should have been trimmed by rotation');
    assert.ok(!text.includes('line 00 '), 'oldest line should have been dropped');
    assert.ok(text.includes('line 39 '), 'newest line should be retained');
    assert.equal(fs.statSync(logPath).size, writer.bytesWritten, 'bytesWritten must equal bytes on disk');
    assert.ok(writer.bytesWritten < limit, 'counter should be reset below the limit after rotation');

    for (const line of text.split('\n').filter(Boolean)) {
      assert.match(line, STAMP_PREFIX);
    }
  });
});

test('string and Buffer chunks produce identical stamped output shape', () => {
  withTempDir((dir) => {
    const a = path.join(dir, 'a.log');
    const b = path.join(dir, 'b.log');
    const wa = new SizeManagedWriter(a);
    const wb = new SizeManagedWriter(b);

    wa.write('x\ny\n');
    wb.write(Buffer.from('x\ny\n'));

    const la = fs.readFileSync(a, 'utf8').split('\n').map((l) => l.replace(STAMP_PREFIX, ''));
    const lb = fs.readFileSync(b, 'utf8').split('\n').map((l) => l.replace(STAMP_PREFIX, ''));
    assert.deepEqual(la, lb);
  });
});
