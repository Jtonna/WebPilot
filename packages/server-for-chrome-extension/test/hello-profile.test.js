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
