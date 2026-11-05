/**
 * resolve_nodes handler - run formatter-supplied functions against DOM nodes
 * identified by backendNodeId (or accessibility refs) via CDP.
 */

import { getBackendNodeId } from '../accessibility-storage.js';
import { getSession, isProtectedPage } from '../utils/debugger.js';
import { validateResolveParams, runResolveCalls } from '../utils/resolve-batch.js';

export async function resolveNodes(params) {
  validateResolveParams(params);
  const { tab_id, calls } = params;

  const tab = await chrome.tabs.get(tab_id);
  if (isProtectedPage(tab.url)) {
    throw new Error('Cannot resolve nodes on protected pages');
  }

  const target = await getSession(tab_id);

  const mapped = calls.map((call) => ({
    functionDeclaration: call.functionDeclaration,
    backendNodeIds: call.refs
      ? call.refs.map((ref) => {
          const id = getBackendNodeId(tab_id, ref);
          return typeof id === 'number' ? id : null;
        })
      : call.backendNodeIds
  }));

  return runResolveCalls((method, p) => chrome.debugger.sendCommand(target, method, p), mapped);
}
