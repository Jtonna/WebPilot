'use strict';

// agentId -> Map<tabId, { formatter, urlAtUnlock, unlockedAt }>
const _state = new Map();

function recordUnlock(agentId, tabId, formatter, url) {
  if (!_state.has(agentId)) {
    _state.set(agentId, new Map());
  }
  _state.get(agentId).set(tabId, {
    formatter,
    urlAtUnlock: url,
    unlockedAt: Date.now()
  });
}

function getUnlock(agentId, tabId) {
  const agentMap = _state.get(agentId);
  if (!agentMap) return null;
  return agentMap.get(tabId) || null;
}

function invalidate(agentId, tabId) {
  const agentMap = _state.get(agentId);
  if (agentMap) {
    agentMap.delete(tabId);
  }
}

function invalidateAllForAgent(agentId) {
  _state.delete(agentId);
}

function _resetForTests() {
  _state.clear();
}

module.exports = {
  recordUnlock,
  getUnlock,
  invalidate,
  invalidateAllForAgent,
  _resetForTests
};
