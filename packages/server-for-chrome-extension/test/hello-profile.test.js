'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { resolveHelloProfile } = require('../src/server');

const PROFILES = [
  { directoryName: 'Default', gaiaEmail: null },
  { directoryName: 'Profile 1', gaiaEmail: 'alice@example.com' },
];

function deps(overrides = {}) {
  return {
    readProfiles: () => PROFILES,
    userDataDir: null,
    getConnectedProfiles: () => [],
    getProfileForInstall: () => null,
    scanInstallProfile: () => ({ matches: [], scanned: 0, skipped: 0, truncated: false }),
    log: () => {},
    ...overrides,
  };
}

describe('resolveHelloProfile — client-supplied profileId (#129)', () => {
  test('a valid client profileId binds that profile', () => {
    const r = resolveHelloProfile({ profileId: 'Default' }, deps());
    assert.equal(r.profileId, 'Default');
    assert.equal(r.via, 'client_profileId');
  });

  test('a bogus client profileId is NOT trusted — never binds the attacker value', () => {
    // Ambiguous profile set so inference-by-exclusion also yields nothing: the
    // attacker-chosen profileId must not bind, and we end at null
    // (identify_required).
    const ambiguous = deps({
      readProfiles: () => [
        { directoryName: 'Default', gaiaEmail: null },
        { directoryName: 'Other', gaiaEmail: null },
      ],
    });
    const r = resolveHelloProfile({ profileId: 'Attacker Profile' }, ambiguous);
    assert.notEqual(r.profileId, 'Attacker Profile');
    assert.equal(r.profileId, null);
  });

  test('a bogus client profileId falls through to the installId path', () => {
    const r = resolveHelloProfile(
      { profileId: 'does-not-exist', installId: 'install-1' },
      deps({ getProfileForInstall: (id) => (id === 'install-1' ? 'Default' : null) })
    );
    assert.equal(r.profileId, 'Default');
    assert.equal(r.via, 'installId');
  });

  test('installId mapped to a deleted profile is ignored', () => {
    // Ambiguous profile set so the stale mapping cannot be rescued by
    // inference; the ghost profile must never bind.
    const r = resolveHelloProfile(
      { installId: 'install-ghost' },
      deps({
        getProfileForInstall: () => 'Ghost Profile',
        readProfiles: () => [
          { directoryName: 'Default', gaiaEmail: null },
          { directoryName: 'Other', gaiaEmail: null },
        ],
      })
    );
    assert.notEqual(r.profileId, 'Ghost Profile');
    assert.equal(r.profileId, null);
  });

  // #131: the installId validated at WS upgrade wins over the hello claim, so
  // a client cannot borrow another install's profile mapping by naming it in
  // hello, and resolution keys off the same identity that gets persisted.
  const ambiguousProfiles = () => [
    { directoryName: 'Default', gaiaEmail: null },
    { directoryName: 'Other', gaiaEmail: null },
  ];

  test('upgrade-validated installId takes precedence over the hello installId', () => {
    const map = { 'victim-install': 'Default', 'own-install': 'Other' };
    const r = resolveHelloProfile(
      { installId: 'victim-install' },
      deps({
        readProfiles: ambiguousProfiles,
        getProfileForInstall: (id) => map[id] || null,
        installId: 'own-install',
      })
    );
    assert.equal(r.profileId, 'Other');
    assert.equal(r.via, 'installId');
  });

  test('a hello installId naming another install cannot resolve when the validated one is unmapped', () => {
    const r = resolveHelloProfile(
      { installId: 'victim-install' },
      deps({
        readProfiles: ambiguousProfiles,
        getProfileForInstall: (id) => (id === 'victim-install' ? 'Default' : null),
        installId: 'own-install',
      })
    );
    assert.equal(r.profileId, null);
  });

  test('validated installId resolves even when hello omits it (storage cleared)', () => {
    const r = resolveHelloProfile(
      { installId: null },
      deps({
        readProfiles: ambiguousProfiles,
        getProfileForInstall: (id) => (id === 'own-install' ? 'Other' : null),
        installId: 'own-install',
      })
    );
    assert.equal(r.profileId, 'Other');
  });

  test('gaiaEmail resolves when no profileId/installId', () => {
    const r = resolveHelloProfile({ gaiaEmail: 'ALICE@example.com' }, deps());
    assert.equal(r.profileId, 'Profile 1');
    assert.equal(r.via, 'gaiaEmail');
  });

  test('inference by exclusion picks the lone unconnected non-gaia profile', () => {
    const r = resolveHelloProfile({}, deps());
    // Default has no gaiaEmail and is not connected; Profile 1 has a gaiaEmail
    // so it is excluded from the candidate set -> Default is the lone candidate.
    assert.equal(r.profileId, 'Default');
    assert.equal(r.via, 'inference');
  });

  test('ambiguous inference -> null (identify_required)', () => {
    const r = resolveHelloProfile(
      {},
      deps({ readProfiles: () => [
        { directoryName: 'A', gaiaEmail: null },
        { directoryName: 'B', gaiaEmail: null },
      ] })
    );
    assert.equal(r.profileId, null);
  });
});

// #138 — install scan ("step 2b"): runs after gaiaEmail, before inference.
describe('resolveHelloProfile — install scan (#138)', () => {
  const EXT_ID = 'abcdefghijklmnopabcdefghijklmnop';
  const INSTALL = '0f8fad5b-d9cb-469f-a165-70867728950e';
  const ambiguous = () => [
    { directoryName: 'A', gaiaEmail: null },
    { directoryName: 'B', gaiaEmail: null },
  ];
  const hello = (extra = {}) => ({ installId: INSTALL, extensionId: EXT_ID, ...extra });

  test('the ambiguous 2-candidate fixture resolves when the scan finds one profile', () => {
    const calls = [];
    const r = resolveHelloProfile(
      hello(),
      deps({
        readProfiles: ambiguous,
        scanInstallProfile: (installId, extensionId) => {
          calls.push([installId, extensionId]);
          return { matches: ['B'], scanned: 2, skipped: 0, truncated: false };
        },
      })
    );
    assert.equal(r.profileId, 'B');
    assert.equal(r.via, 'install_scan');
    assert.deepEqual(calls, [[INSTALL, EXT_ID]]);
  });

  test('install scan wins over inference by exclusion', () => {
    // PROFILES infers 'Default' by exclusion; the scan says 'Profile 1'.
    const r = resolveHelloProfile(hello(), deps({ scanInstallProfile: () => ({ matches: ['Profile 1'] }) }));
    assert.equal(r.profileId, 'Profile 1');
    assert.equal(r.via, 'install_scan');
  });

  test('the upgrade-validated installId is what gets scanned', () => {
    let scanned = null;
    resolveHelloProfile(
      hello({ installId: 'claimed-in-hello' }),
      deps({
        readProfiles: ambiguous,
        installId: INSTALL,
        scanInstallProfile: (id) => { scanned = id; return { matches: [] }; },
      })
    );
    assert.equal(scanned, INSTALL);
  });

  const scanMustNotRun = () => { throw new Error('scan must not run'); };

  test('client profileId (step 1) wins over the scan', () => {
    const r = resolveHelloProfile(
      hello({ profileId: 'A' }),
      deps({ readProfiles: ambiguous, scanInstallProfile: scanMustNotRun })
    );
    assert.equal(r.profileId, 'A');
    assert.equal(r.via, 'client_profileId');
  });

  test('installId mapping (step 2) wins over the scan', () => {
    const r = resolveHelloProfile(
      hello(),
      deps({ readProfiles: ambiguous, getProfileForInstall: () => 'A', scanInstallProfile: scanMustNotRun })
    );
    assert.equal(r.profileId, 'A');
    assert.equal(r.via, 'installId');
  });

  test('gaiaEmail (step 3) wins over the scan', () => {
    const r = resolveHelloProfile(
      hello({ gaiaEmail: 'alice@example.com' }),
      deps({ scanInstallProfile: scanMustNotRun })
    );
    assert.equal(r.profileId, 'Profile 1');
    assert.equal(r.via, 'gaiaEmail');
  });

  test('a scan match that is not a known local profile falls through', () => {
    const r = resolveHelloProfile(
      hello(),
      deps({ readProfiles: ambiguous, scanInstallProfile: () => ({ matches: ['Ghost'] }) })
    );
    assert.equal(r.profileId, null);
  });

  test('a scan with two matches falls through (to inference)', () => {
    const r = resolveHelloProfile(
      hello(),
      deps({ scanInstallProfile: () => ({ matches: ['Default', 'Profile 1'] }) })
    );
    // PROFILES: inference by exclusion picks Default.
    assert.equal(r.profileId, 'Default');
    assert.equal(r.via, 'inference');
  });

  test('a scan with two matches on the ambiguous fixture -> null', () => {
    const r = resolveHelloProfile(
      hello(),
      deps({ readProfiles: ambiguous, scanInstallProfile: () => ({ matches: ['A', 'B'] }) })
    );
    assert.equal(r.profileId, null);
  });

  test('a throwing scan is caught and falls through without crashing', () => {
    const logs = [];
    const r = resolveHelloProfile(
      hello(),
      deps({
        readProfiles: ambiguous,
        scanInstallProfile: () => { throw new Error('EBUSY'); },
        log: (m) => logs.push(m),
      })
    );
    assert.equal(r.profileId, null);
    assert.ok(logs.some((m) => m.includes('install-scan failed')));
  });

  test('no valid extensionId in hello -> the scan is not attempted', () => {
    for (const extensionId of [undefined, '../x', EXT_ID.toUpperCase(), EXT_ID.slice(0, 31)]) {
      const r = resolveHelloProfile(
        hello({ extensionId }),
        deps({ readProfiles: ambiguous, scanInstallProfile: scanMustNotRun })
      );
      assert.equal(r.profileId, null);
    }
  });

  test('scan log line carries counts only — never the installId', () => {
    const logs = [];
    resolveHelloProfile(
      hello(),
      deps({
        readProfiles: ambiguous,
        scanInstallProfile: () => ({ matches: [], scanned: 3, skipped: 1, truncated: false }),
        log: (m) => logs.push(m),
      })
    );
    const line = logs.find((m) => m.includes('install-scan:'));
    assert.equal(line, '[extension-bridge] install-scan: 0 match(es), scanned 3, skipped 1');
    assert.ok(!logs.some((m) => m.includes(INSTALL)));
  });
});
