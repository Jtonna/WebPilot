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
function createExtensionBridge(apiKey) {
  // profileId -> ws
  const connections = new Map();
  // commandId -> { resolve, reject, timeout, profileId }
  const pendingCommands = new Map();
  const COMMAND_TIMEOUT = 30000;

  function setConnection(profileId, ws) {
    if (!profileId) {
      console.log('[extension-bridge] setConnection called with empty profileId — refusing');
      return;
    }
    const prev = connections.get(profileId);
    if (prev && prev !== ws) {
      console.log(
        `[extension-bridge] replacing existing connection for profile="${profileId}" ` +
          `(prev readyState=${prev.readyState})`
      );
      try {
        prev.close();
      } catch (e) {
        // ignore
      }
    }
    connections.set(profileId, ws);
    console.log(
      `[extension-bridge] connection registered for profile="${profileId}" ` +
        `(total=${connections.size})`
    );
  }

  function clearConnection(profileIdOrWs) {
    // Accept either a profileId string or a ws instance (for ws.on('close')).
    //
    // Critical contract: this MUST only act on the ONE entry that matches.
    // The old version's fallback (`!removedProfileId` branch) iterated EVERY
    // pending command and rejected them all on any anonymous disconnect —
    // an extension that opened a WS and dropped before completing hello would
    // wipe out every other profile's in-flight commands. See server I12.
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
      // Anonymous disconnect (WS that was never identified via hello). Nothing
      // to clear, nothing to reject. DO NOT iterate other profiles' pending
      // commands.
      console.log(
        '[bridge] clearConnection(ws): no matching profile, ignoring ' +
          '(this WebSocket never completed hello)'
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

      pendingCommands.set(id, { resolve, reject, timeout, profileId });

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

  function handleResponse(message) {
    const { id, success, result, error } = message;

    const pending = pendingCommands.get(id);
    if (!pending) {
      console.log(`[extension-bridge] unknown command response id=${id}`);
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

module.exports = { createExtensionBridge };
