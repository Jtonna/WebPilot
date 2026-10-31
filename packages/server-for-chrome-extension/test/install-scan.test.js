'use strict';

// Unit coverage for src/chrome/install-scan.js (#138). Every fixture lives in
// an fs.mkdtempSync directory — the real Chrome user-data dir is never read.

const { test, describe, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  scanForInstallId,
  clearScanCache,
  CACHE_TTL_MS,
} = require('../src/chrome/install-scan');

const EXT_ID = 'abcdefghijklmnopabcdefghijklmnop';
const INSTALL_ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const OTHER_INSTALL_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

const roots = [];
function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'webpilot-install-scan-'));
  roots.push(root);
  return root;
}

after(() => {
  for (const r of roots) {
    try { fs.rmSync(r, { recursive: true, force: true }); } catch (_e) { /* ignore */ }
  }
});

beforeEach(() => {
  clearScanCache();
});

/** Create `<root>/<profile>/Local Extension Settings/<ext>/` and return it. */
function extDir(root, profile, ext = EXT_ID) {
  const d = path.join(root, profile, 'Local Extension Settings', ext);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/** A fake LevelDB log record carrying `webpilot.installId` as JSON text. */
function storageBytes(installId) {
  return Buffer.concat([
    Buffer.from([0x01, 0x02, 0x03, 0x00]),
    Buffer.from(`webpilot.installId"${installId}"`, 'utf8'),
    Buffer.from([0xff, 0x00]),
  ]);
}

function scan(root, profileDirs, extra = {}) {
  return scanForInstallId({
    userDataDir: root,
    profileDirs,
    extensionId: EXT_ID,
    installId: INSTALL_ID,
    ...extra,
  });
}

/** Wrap fs methods to count calls; returns { calls, restore }. */
function spyFs(names) {
  const originals = {};
  const calls = {};
  for (const n of names) {
    originals[n] = fs[n];
    calls[n] = 0;
    fs[n] = function (...args) {
      calls[n] += 1;
      return originals[n].apply(this, args);
    };
  }
  return {
    calls,
    total: () => Object.values(calls).reduce((a, b) => a + b, 0),
    restore: () => { for (const n of names) fs[n] = originals[n]; },
  };
}

const FS_METHODS = ['lstatSync', 'statSync', 'readdirSync', 'openSync', 'readSync', 'readFileSync', 'existsSync'];

describe('scanForInstallId — matching', () => {
  test('one matching profile -> that directory', () => {
    const root = makeRoot();
    fs.writeFileSync(path.join(extDir(root, 'Default'), '000003.log'), storageBytes(OTHER_INSTALL_ID));
    fs.writeFileSync(path.join(extDir(root, 'Profile 1'), '000003.log'), storageBytes(INSTALL_ID));
    const r = scan(root, ['Default', 'Profile 1']);
    assert.deepEqual(r.matches, ['Profile 1']);
    assert.equal(r.scanned, 2);
    assert.equal(r.skipped, 0);
    assert.equal(r.truncated, false);
  });

  test('a profile with several occurrences / files is counted once', () => {
    const root = makeRoot();
    const d = extDir(root, 'Profile 2');
    fs.writeFileSync(path.join(d, '000005.log'), Buffer.concat([storageBytes(INSTALL_ID), storageBytes(INSTALL_ID)]));
    fs.writeFileSync(path.join(d, '000004.ldb'), storageBytes(INSTALL_ID));
    const r = scan(root, ['Profile 2']);
    assert.deepEqual(r.matches, ['Profile 2']);
  });

  test('two matching profiles -> both returned (caller falls through)', () => {
    const root = makeRoot();
    fs.writeFileSync(path.join(extDir(root, 'Default'), '000003.ldb'), storageBytes(INSTALL_ID));
    fs.writeFileSync(path.join(extDir(root, 'Profile 1'), '000003.log'), storageBytes(INSTALL_ID));
    const r = scan(root, ['Default', 'Profile 1']);
    assert.deepEqual(r.matches.sort(), ['Default', 'Profile 1']);
  });

  test('no match -> empty', () => {
    const root = makeRoot();
    fs.writeFileSync(path.join(extDir(root, 'Default'), '000003.log'), storageBytes(OTHER_INSTALL_ID));
    const r = scan(root, ['Default']);
    assert.deepEqual(r.matches, []);
    assert.equal(r.scanned, 1);
  });

  test('missing extension dir -> no match, not counted as skipped', () => {
    const root = makeRoot();
    fs.mkdirSync(path.join(root, 'Default'), { recursive: true });
    const r = scan(root, ['Default', 'Never Created']);
    assert.deepEqual(r.matches, []);
    assert.equal(r.scanned, 0);
    assert.equal(r.skipped, 0);
  });

  test('only *.log / *.ldb are read — LOCK, CURRENT, MANIFEST are never opened', () => {
    const root = makeRoot();
    const d = extDir(root, 'Default');
    for (const n of ['LOCK', 'CURRENT', 'MANIFEST-000001', 'LOG', 'LOG.old']) {
      fs.writeFileSync(path.join(d, n), storageBytes(INSTALL_ID));
    }
    const spy = spyFs(['openSync']);
    const opened = [];
    const origOpen = fs.openSync;
    fs.openSync = function (p, ...rest) { opened.push(path.basename(p)); return origOpen.call(this, p, ...rest); };
    let r;
    try {
      r = scan(root, ['Default']);
    } finally {
      fs.openSync = origOpen;
      spy.restore();
    }
    assert.deepEqual(r.matches, []);
    assert.deepEqual(opened, []);
  });
});

describe('scanForInstallId — input validation never touches the filesystem', () => {
  const badExtensionIds = ['../x', EXT_ID.toUpperCase(), EXT_ID.slice(0, 31), 'qbcdefghijklmnopabcdefghijklmnop', null, 42];
  for (const bad of badExtensionIds) {
    test(`invalid extensionId ${JSON.stringify(bad)} -> no matches, zero fs calls`, () => {
      const root = makeRoot();
      const spy = spyFs(FS_METHODS);
      let r;
      try {
        r = scan(root, ['Default'], { extensionId: bad });
      } finally {
        spy.restore();
      }
      assert.deepEqual(r.matches, []);
      assert.equal(spy.total(), 0, `fs calls: ${JSON.stringify(spy.calls)}`);
    });
  }

  const badInstallIds = ['not-a-uuid', '', '../../etc/passwd', INSTALL_ID + 'x', null];
  for (const bad of badInstallIds) {
    test(`invalid installId ${JSON.stringify(bad)} -> no matches, zero fs calls`, () => {
      const root = makeRoot();
      const spy = spyFs(FS_METHODS);
      let r;
      try {
        r = scan(root, ['Default'], { installId: bad });
      } finally {
        spy.restore();
      }
      assert.deepEqual(r.matches, []);
      assert.equal(spy.total(), 0, `fs calls: ${JSON.stringify(spy.calls)}`);
    });
  }

  test('uppercase UUID installId is accepted as valid', () => {
    const root = makeRoot();
    const upper = INSTALL_ID.toUpperCase();
    fs.writeFileSync(path.join(extDir(root, 'Default'), '000003.log'), storageBytes(upper));
    const r = scan(root, ['Default'], { installId: upper });
    assert.deepEqual(r.matches, ['Default']);
  });

  test('profile dirs with "..", "/" or "\\" are skipped without fs access', () => {
    const root = makeRoot();
    // A matching store reachable only via traversal from a sibling dir.
    const inner = path.join(root, 'inner');
    fs.mkdirSync(inner);
    fs.writeFileSync(path.join(extDir(root, 'Escaped'), '000003.log'), storageBytes(INSTALL_ID));
    const spy = spyFs(FS_METHODS);
    let r;
    try {
      r = scan(inner, ['..', '../Escaped', '..\\Escaped', 'a/b']);
    } finally {
      spy.restore();
    }
    assert.deepEqual(r.matches, []);
    assert.equal(spy.total(), 0, `fs calls: ${JSON.stringify(spy.calls)}`);
  });
});

describe('scanForInstallId — symlinks', () => {
  test('a symlinked storage file is skipped', (t) => {
    const root = makeRoot();
    const d = extDir(root, 'Default');
    const target = path.join(root, 'outside.log');
    fs.writeFileSync(target, storageBytes(INSTALL_ID));
    try {
      fs.symlinkSync(target, path.join(d, '000003.log'), 'file');
    } catch (e) {
      t.skip(`cannot create file symlinks here (${e.code}) — e.g. Windows without Developer Mode`);
      return;
    }
    const r = scan(root, ['Default']);
    assert.deepEqual(r.matches, []);
    assert.equal(r.scanned, 0);
  });

  test('a symlinked / junctioned extension directory is skipped', (t) => {
    const root = makeRoot();
    const real = path.join(root, 'real-store');
    fs.mkdirSync(real);
    fs.writeFileSync(path.join(real, '000003.log'), storageBytes(INSTALL_ID));
    const settings = path.join(root, 'Default', 'Local Extension Settings');
    fs.mkdirSync(settings, { recursive: true });
    try {
      // 'junction' needs no privileges on Windows; ignored elsewhere.
      fs.symlinkSync(real, path.join(settings, EXT_ID), 'junction');
    } catch (e) {
      t.skip(`cannot create directory links here (${e.code})`);
      return;
    }
    const r = scan(root, ['Default']);
    assert.deepEqual(r.matches, []);
    assert.equal(r.scanned, 0);
  });
});

describe('scanForInstallId — caps and unreadable files', () => {
  test('a file over the per-file cap is skipped', () => {
    const root = makeRoot();
    const d = extDir(root, 'Default');
    fs.writeFileSync(path.join(d, '000003.ldb'), Buffer.concat([Buffer.alloc(2048), storageBytes(INSTALL_ID)]));
    const r = scan(root, ['Default'], { limits: { perFileBytes: 1024 } });
    assert.deepEqual(r.matches, []);
    assert.equal(r.skipped, 1);
    assert.equal(r.scanned, 0);
  });

  test('exceeding the total cap stops the scan and sets truncated', () => {
    const root = makeRoot();
    fs.writeFileSync(path.join(extDir(root, 'Default'), '000003.log'), Buffer.alloc(600));
    fs.writeFileSync(path.join(extDir(root, 'Profile 1'), '000003.log'), Buffer.concat([Buffer.alloc(600), storageBytes(INSTALL_ID)]));
    const r = scan(root, ['Default', 'Profile 1'], { limits: { perFileBytes: 4096, totalBytes: 1000 } });
    assert.equal(r.truncated, true);
    assert.equal(r.scanned, 1);
    assert.deepEqual(r.matches, []);
  });

  test('an unreadable file (EACCES) is counted as skipped, not thrown', () => {
    const root = makeRoot();
    const d = extDir(root, 'Default');
    const locked = path.join(d, '000003.log');
    fs.writeFileSync(locked, storageBytes(INSTALL_ID));
    fs.writeFileSync(path.join(d, '000002.ldb'), storageBytes(OTHER_INSTALL_ID));
    const origOpen = fs.openSync;
    fs.openSync = function (p, ...rest) {
      if (path.resolve(p) === path.resolve(locked)) {
        const err = new Error('EACCES: permission denied');
        err.code = 'EACCES';
        throw err;
      }
      return origOpen.call(this, p, ...rest);
    };
    let r;
    try {
      r = scan(root, ['Default']);
    } finally {
      fs.openSync = origOpen;
    }
    assert.deepEqual(r.matches, []);
    assert.equal(r.skipped, 1);
    assert.equal(r.scanned, 1);
  });

  test('EBUSY on one profile does not stop other profiles being scanned', () => {
    const root = makeRoot();
    const busy = path.join(extDir(root, 'Default'), '000003.log');
    fs.writeFileSync(busy, storageBytes(OTHER_INSTALL_ID));
    fs.writeFileSync(path.join(extDir(root, 'Profile 1'), '000003.log'), storageBytes(INSTALL_ID));
    const origOpen = fs.openSync;
    fs.openSync = function (p, ...rest) {
      if (path.resolve(p) === path.resolve(busy)) {
        const err = new Error('EBUSY: resource busy or locked');
        err.code = 'EBUSY';
        throw err;
      }
      return origOpen.call(this, p, ...rest);
    };
    let r;
    try {
      r = scan(root, ['Default', 'Profile 1']);
    } finally {
      fs.openSync = origOpen;
    }
    assert.deepEqual(r.matches, ['Profile 1']);
    assert.equal(r.skipped, 1);
  });
});

describe('scanForInstallId — negative cache', () => {
  test('a no-match result is reused within the TTL; clearScanCache resets it', () => {
    const root = makeRoot();
    const d = extDir(root, 'Default');
    fs.writeFileSync(path.join(d, '000003.log'), storageBytes(OTHER_INSTALL_ID));
    let clock = 1_000_000;
    const now = () => clock;

    const first = scan(root, ['Default'], { now });
    assert.deepEqual(first.matches, []);
    assert.equal(first.cached, false);

    // The install now shows up on disk, but a retry inside the TTL must not rescan.
    fs.writeFileSync(path.join(d, '000004.log'), storageBytes(INSTALL_ID));
    clock += 3000;
    const spy = spyFs(FS_METHODS);
    let second;
    try {
      second = scan(root, ['Default'], { now });
    } finally {
      spy.restore();
    }
    assert.deepEqual(second.matches, []);
    assert.equal(second.cached, true);
    assert.equal(spy.total(), 0, 'cached result must not touch fs');

    clearScanCache();
    const third = scan(root, ['Default'], { now });
    assert.deepEqual(third.matches, ['Default']);
    assert.equal(third.cached, false);
  });

  test('the cache entry expires after the TTL', () => {
    const root = makeRoot();
    const d = extDir(root, 'Default');
    let clock = 5_000_000;
    const now = () => clock;
    assert.deepEqual(scan(root, ['Default'], { now }).matches, []);
    fs.writeFileSync(path.join(d, '000003.log'), storageBytes(INSTALL_ID));
    clock += CACHE_TTL_MS + 1;
    const r = scan(root, ['Default'], { now });
    assert.deepEqual(r.matches, ['Default']);
    assert.equal(r.cached, false);
  });

  test('a unique match is not cached (the next scan reads the disk again)', () => {
    const root = makeRoot();
    const file = path.join(extDir(root, 'Default'), '000003.log');
    fs.writeFileSync(file, storageBytes(INSTALL_ID));
    assert.deepEqual(scan(root, ['Default']).matches, ['Default']);
    fs.writeFileSync(file, storageBytes(OTHER_INSTALL_ID));
    const r = scan(root, ['Default']);
    assert.deepEqual(r.matches, []);
    assert.equal(r.cached, false);
  });
});
