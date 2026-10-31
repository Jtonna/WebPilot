'use strict';

/**
 * Reusable loopback-trust helpers.
 *
 * The WebPilot server always runs on the user's machine alongside Chrome +
 * the extension. In network / LAN mode ONLY the MCP surface (`/sse`,
 * `/message`, API-key gated) is meant to be LAN-reachable. Every other
 * surface — the extension WebSocket, the popup routes, `/connect`, `/ui` and
 * `/health` — must stay loopback-only.
 *
 * This module factors the loopback predicate and the dev-bypass policy into a
 * single, pure, unit-testable place so the SAME logic can be applied to the WS
 * upgrade, the popup routes and the plain HTTP routes.
 *
 * Dev-mode detection: the ONLY signal is an explicit `WEBPILOT_DEV=1` env var
 * (see server.js for the full rationale). It is read once at module load.
 */

const IS_DEV_MODE = process.env.WEBPILOT_DEV === '1';

/**
 * Pure predicate: is `remoteAddress` a loopback address?
 * Covers IPv4, IPv6 and the IPv4-mapped-IPv6 form Node reports on dual-stack
 * sockets.
 * @param {string} remoteAddress
 * @returns {boolean}
 */
function isLoopbackRemote(remoteAddress) {
  return (
    remoteAddress === '127.0.0.1' ||
    remoteAddress === '::1' ||
    remoteAddress === '::ffff:127.0.0.1'
  );
}

/**
 * A dev-mode bypass is only safe when (a) the operator explicitly opted into
 * dev mode AND (b) the daemon is bound to loopback only — i.e. there is no
 * LAN-reachable surface. Network-mode binds to 0.0.0.0; in that case every
 * bypass path must refuse to loosen, because a remote attacker could otherwise
 * reach loopback-only surfaces simply because the operator left WEBPILOT_DEV
 * set.
 * @param {string} hostBinding e.g. '127.0.0.1' | 'localhost' | '0.0.0.0'
 * @returns {boolean}
 */
function isDevBypassSafe(hostBinding) {
  if (!IS_DEV_MODE) return false;
  return hostBinding === '127.0.0.1' || hostBinding === 'localhost';
}

/**
 * The single decision every loopback gate uses. Pure — takes the host binding
 * explicitly so it can be unit-tested with fabricated inputs.
 * @param {string} remoteAddress
 * @param {string} hostBinding
 * @returns {{ allowed: boolean, devBypass: boolean }}
 */
function evaluateLoopbackAccess(remoteAddress, hostBinding) {
  if (isLoopbackRemote(remoteAddress)) return { allowed: true, devBypass: false };
  if (isDevBypassSafe(hostBinding)) return { allowed: true, devBypass: true };
  return { allowed: false, devBypass: false };
}

/**
 * Build an express middleware that rejects non-loopback callers with 403.
 * Honors the dev-mode bypass (only when safe — see isDevBypassSafe).
 *
 * @param {string} hostBinding the interface the daemon bound to
 * @param {{ label?: string, log?: Function }} [opts]
 * @returns {(req, res, next) => void}
 */
function makeLoopbackGate(hostBinding, opts = {}) {
  const label = opts.label || 'loopback-only endpoint';
  const log = opts.log || console.log;
  return function loopbackGate(req, res, next) {
    const remote = (req.socket && req.socket.remoteAddress) || '';
    const { allowed, devBypass } = evaluateLoopbackAccess(remote, hostBinding);
    if (allowed) {
      if (devBypass) {
        log(
          `[loopback-gate] DEV MODE (loopback bind) — allowing non-local ${req.method} ${req.url} ` +
            `(${label}) from ${remote}`
        );
        try { res.setHeader('X-WebPilot-Dev-Bypass', '1'); } catch (_e) { /* ignore */ }
      }
      return next();
    }
    if (IS_DEV_MODE && hostBinding === '0.0.0.0') {
      log(
        `[loopback-gate] DEV MODE present but daemon is network-bound — refusing ${label} ` +
          `for non-local ${req.method} ${req.url} from ${remote}`
      );
    }
    log(`[loopback-gate] rejecting non-local request to ${label} ${req.method} ${req.url} from ${remote}`);
    return res.status(403).json({ error: 'Forbidden: loopback-only' });
  };
}

module.exports = {
  IS_DEV_MODE,
  isLoopbackRemote,
  isDevBypassSafe,
  evaluateLoopbackAccess,
  makeLoopbackGate,
};
