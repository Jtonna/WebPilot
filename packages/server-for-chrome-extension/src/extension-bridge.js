const { v4: uuidv4 } = require('uuid');

/**
 * Multi-extension WebSocket bridge.
 *
 * Tracks N simultaneous extension connections keyed by Chrome profile-directory
 * name (e.g. "Default", "Profile 1"). Commands route per-profile; broadcasts
 * via notifyAll().
 *
 * Backwards-compatible helpers:
 *   - isConnected()          — alias for isAnyConnected()
 *   - isConnected(profileId) — exact profile check
 */
// A live connection with no traffic (incl. pings) for this long may be taken over.
const STALE_CONNECTION_MS = 45000;

function createExtensionBridge() {
  // profileId -> ws
  const connections = new Map();
  // commandId -> { resolve, reject, timeout, profileId, ws }
  const pendingCommands = new Map();
  const COMMAND_TIMEOUT = 30000;

  function setConnection(profileId, ws) {
    if (!profileId) {
      console.log('[extension-bridge] setConnection called with empty profileId — refusing');
      return { ok: false, reason: 'invalid_profile' };
    }
    const prev = connections.get(profileId);
    if (prev === ws) {
      // Same socket re-sending hello: nothing to replace.
      ws._lastActivity = Date.now();
      return { ok: true };
    }
    if (prev && _wsAlive(prev)) {
      const sameInstall = !!(prev._installId && ws._installId && prev._installId === ws._installId);
      const stale =
        typeof prev._lastActivity === 'number' &&
        Date.now() - prev._lastActivity > STALE_CONNECTION_MS;
      if (!sameInstall && !stale) {
        console.log(
          `[extension-bridge] refusing connection for profile="${profileId}" — ` +
            'a live connection from a different install already holds it'
        );
        return { ok: false, reason: 'connection_in_use' };
      }
      const closeReason = sameInstall ? 'replaced_by_new_connection' : 'stale_connection';
      console.log(
        `[extension-bridge] replacing existing connection for profile="${profileId}" ` +
          `(prev readyState=${prev.readyState}, reason=${closeReason})`
      );
      try {
        prev.close(4000, closeReason);
      } catch (e) {
        // ignore
      }
    }
    if (prev && prev !== ws) {
      // The replaced socket's close event will find no matching map entry (it
      // now holds `ws`), so fail its in-flight commands here instead of
      // letting them wait out the full command timeout. Runs for live and
      // dead (CLOSING/CLOSED) prev alike, before the map swap.
      _rejectPendingForSocket(prev, 'Extension connection replaced');
    }
    ws._lastActivity = Date.now();
    connections.set(profileId, ws);
    console.log(
      `[extension-bridge] connection registered for profile="${profileId}" ` +
        `(total=${connections.size})`
    );
    return { ok: true };
  }

  // Reject and drop every pending command that was sent on `ws`. Strict match:
  // entries without a recorded socket are never touched. Returns the count.
  function _rejectPendingForSocket(ws, message) {
    if (ws === undefined || ws === null) return 0;
    let rejected = 0;
    for (const [id, pending] of pendingCommands) {
      if (pending.ws !== undefined && pending.ws === ws) {
        clearTimeout(pending.timeout);
        pendingCommands.delete(id);
        pending.reject(new Error(message));
        rejected += 1;
      }
    }
    if (rejected > 0) {
      console.log(
        `[bridge] rejected ${rejected} pending command(s) on a socket: ${message}`
      );
    }
    return rejected;
  }

  function clearConnection(profileIdOrWs) {
    // Accept either a profileId string or a ws instance (for ws.on('close')).
    //
    // Critical contract: this MUST only act on the ONE entry that matches.
    // An anonymous-disconnect fallback that iterates every pending command
    // would wipe out every other profile's in-flight commands when an
    // extension opens a WS and drops before completing hello.
    let removedProfileId = null;
    if (typeof profileIdOrWs === 'string') {
      if (connections.has(profileIdOrWs)) {
        connections.delete(profileIdOrWs);
        removedProfileId = profileIdOrWs;
      }
    } else if (profileIdOrWs) {
      for (const [pid, ws] of connections.entries()) {
        if (ws === profileIdOrWs) {
          connections.delete(pid);
          removedProfileId = pid;
          break;
        }
      }
    }

    if (!removedProfileId) {
      // No map entry matches this socket: it either never completed hello or
      // was already replaced in the map. Only commands bound to this exact
      // socket are rejected (defense in depth); DO NOT iterate other
      // profiles' pending commands.
      if (profileIdOrWs && typeof profileIdOrWs === 'object') {
        _rejectPendingForSocket(profileIdOrWs, 'Extension disconnected');
      }
      console.log(
        '[bridge] clearConnection: no matching profile entry, ignoring ' +
          '(socket never completed hello or was already replaced)'
      );
      return;
    }

    // Count + reject only pending commands that targeted this specific profile.
    let pendingCleared = 0;
    for (const [id, pending] of pendingCommands) {
      if (pending.profileId === removedProfileId) {
        pending.reject(new Error('Extension disconnected'));
        clearTimeout(pending.timeout);
        pendingCommands.delete(id);
        pendingCleared += 1;
      }
    }

    console.log(
      `[bridge] clearConnection: profileId=${removedProfileId} removed ` +
        `(had ${pendingCleared} pending; total connections=${connections.size})`
    );
  }

  function _wsAlive(ws) {
    return ws && ws.readyState === 1;
  }

  function isConnected(profileId) {
    if (profileId === undefined || profileId === null) {
      return isAnyConnected();
    }
    const ws = connections.get(profileId);
    return _wsAlive(ws);
  }

  function isAnyConnected() {
    for (const ws of connections.values()) {
      if (_wsAlive(ws)) return true;
    }
    return false;
  }

  function getConnectedProfiles() {
    const out = [];
    for (const [pid, ws] of connections.entries()) {
      if (_wsAlive(ws)) out.push(pid);
    }
    return out;
  }

  function sendCommand(profileId, type, params, options = {}) {
    return new Promise((resolve, reject) => {
      const ws = connections.get(profileId);
      if (!_wsAlive(ws)) {
        reject(
          new Error(
            `No browser instance connected for profile "${profileId}". ` +
              'Call browser_create_tab to launch Chrome.'
          )
        );
        return;
      }

      const id = uuidv4();
      const timeoutMs = options.timeout || COMMAND_TIMEOUT;

      const timeout = setTimeout(() => {
        pendingCommands.delete(id);
        reject(new Error('Command timeout'));
      }, timeoutMs);

      // Store the originating socket so handleResponse can reject a response
      // that arrives on a different socket than the command was sent on.
      pendingCommands.set(id, { resolve, reject, timeout, profileId, ws });

      const message = { id, type, params };

      try {
        ws.send(JSON.stringify(message));
        console.log(
          `[extension-bridge] sent command type="${type}" id=${id} profile="${profileId}"`
        );
      } catch (error) {
        pendingCommands.delete(id);
        clearTimeout(timeout);
        reject(error);
      }
    });
  }

  function handleResponse(message, ws) {
    const { id, success, result, error } = message;

    const pending = pendingCommands.get(id);
    if (!pending) {
      console.log(`[extension-bridge] unknown command response id=${id}`);
      return;
    }

    // Connection-displacement safety: if the command was sent on a specific
    // socket and this response arrived on a DIFFERENT socket, ignore it. The
    // command-id match alone is not enough — a displaced/second extension
    // connection for the same profile must not be able to answer another
    // socket's in-flight command. When no ws is supplied (older callers) or
    // the command has no recorded socket, fall back to id-only matching.
    if (ws && pending.ws && ws !== pending.ws) {
      console.log(
        `[extension-bridge] ignoring response id=${id} — arrived on a different socket ` +
          `than the command was sent on`
      );
      return;
    }

    pendingCommands.delete(id);
    clearTimeout(pending.timeout);

    if (success) {
      console.log(`[extension-bridge] command ${id} succeeded`);
      pending.resolve(result);
    } else {
      console.log(`[extension-bridge] command ${id} failed: ${error}`);
      pending.reject(new Error(error || 'Command failed'));
    }
  }

  function notify(profileId, message) {
    const ws = connections.get(profileId);
    if (_wsAlive(ws)) {
      ws.send(JSON.stringify(message));
      return true;
    }
    return false;
  }

  function notifyAll(message) {
    const json = JSON.stringify(message);
    let sent = 0;
    for (const ws of connections.values()) {
      if (_wsAlive(ws)) {
        try {
          ws.send(json);
          sent += 1;
        } catch (e) {
          console.log(`[extension-bridge] notifyAll send failed: ${e.message}`);
        }
      }
    }
    console.log(`[extension-bridge] notifyAll delivered to ${sent} connection(s)`);
    return sent;
  }

  return {
    setConnection,
    clearConnection,
    isConnected,
    isAnyConnected,
    getConnectedProfiles,
    sendCommand,
    handleResponse,
    notify,
    notifyAll,
  };
}

module.exports = { createExtensionBridge, STALE_CONNECTION_MS };
