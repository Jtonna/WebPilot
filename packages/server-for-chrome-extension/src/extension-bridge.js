const { v4: uuidv4 } = require('uuid');

function createExtensionBridge(apiKey) {
  let wsConnection = null;
  const pendingCommands = new Map();
  const COMMAND_TIMEOUT = 30000;

  function setConnection(ws) {
    wsConnection = ws;
    console.log('Extension bridge connected');
  }

  function clearConnection() {
    wsConnection = null;

    for (const [id, pending] of pendingCommands) {
      pending.reject(new Error('Extension disconnected'));
      clearTimeout(pending.timeout);
    }
    pendingCommands.clear();

    console.log('Extension bridge disconnected');
  }

  function isConnected() {
    return wsConnection !== null && wsConnection.readyState === 1;
  }

  function sendCommand(type, params) {
    return new Promise((resolve, reject) => {
      if (!isConnected()) {
        reject(new Error('Extension not connected'));
        return;
      }

      const id = uuidv4();

      const timeout = setTimeout(() => {
        pendingCommands.delete(id);
        reject(new Error('Command timeout'));
      }, COMMAND_TIMEOUT);

      pendingCommands.set(id, { resolve, reject, timeout });

      const message = { id, type, params };

      try {
        wsConnection.send(JSON.stringify(message));
        console.log(`Sent command: ${type} (${id})`);
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
      console.warn(`Unknown command response: ${id}`);
      return;
    }

    pendingCommands.delete(id);
    clearTimeout(pending.timeout);

    if (success) {
      console.log(`Command ${id} succeeded`);
      pending.resolve(result);
    } else {
      console.log(`Command ${id} failed: ${error}`);
      pending.reject(new Error(error || 'Command failed'));
    }
  }

  return {
    setConnection,
    clearConnection,
    isConnected,
    sendCommand,
    handleResponse
  };
}

module.exports = { createExtensionBridge };
