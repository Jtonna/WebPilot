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
