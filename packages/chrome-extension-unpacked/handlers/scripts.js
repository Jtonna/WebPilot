/**
 * Script handlers - inject and execute JavaScript in page context.
 */

import { getSession, isProtectedPage } from '../utils/debugger.js';

/**
 * Track scripts that should persist across navigation.
 * @type {Map<number, string>}
 */
export const persistentScripts = new Map();

// Defensive cap on injectable/executable JS bodies. The MCP server already
// caps fetched scripts at 5 MB; this is the per-extension last-line guard
// so a misbehaving / hijacked server can't push a payload large enough to
// exhaust the service-worker heap. See QOL security audit X2.
const MAX_SCRIPT_BYTES = 5 * 1024 * 1024;

/**
 * Inject a script into a tab.
 *
 * @param {Object} params
 * @param {number} params.tab_id - Target tab ID
 * @param {string} params.script_content - JavaScript code to inject
 * @param {boolean} [params.keep_injected=false] - Persist across navigation
 * @returns {Promise<Object>} Injection result
 */
export async function injectScript(params) {
  const { tab_id, script_content, keep_injected } = params;

  if (!tab_id) throw new Error('tab_id is required');
  if (!script_content) throw new Error('script_content is required');
  if (typeof script_content !== 'string') {
    throw new Error('script_content must be a string');
  }
  if (script_content.length > MAX_SCRIPT_BYTES) {
    throw new Error(`script_content exceeds ${MAX_SCRIPT_BYTES} bytes`);
  }

  const tab = await chrome.tabs.get(tab_id);
  if (isProtectedPage(tab.url)) {
    throw new Error('Cannot inject scripts into protected pages');
  }

  await doInjectScript(tab_id, script_content);

  if (keep_injected) {
    persistentScripts.set(tab_id, script_content);
  } else {
    persistentScripts.delete(tab_id);
  }

  return {
    success: true,
    tab_id,
    injected: true,
    persistent: keep_injected || false
  };
}

/**
 * Internal function to perform script injection via CDP.
 *
 * @param {number} tab_id - Target tab ID
 * @param {string} script_content - JavaScript code to inject
 */
export async function doInjectScript(tab_id, script_content) {
  const target = await getSession(tab_id);

  const result = await chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
    expression: script_content,
    returnByValue: true
  });

  if (result.exceptionDetails) {
    throw new Error(
      result.exceptionDetails.exception?.description ||
      result.exceptionDetails.text ||
      'Script injection error'
    );
  }
}

/**
 * Execute JavaScript in a tab's page context.
 *
 * @param {Object} params
 * @param {number} params.tab_id - Target tab ID
 * @param {string} params.code - JavaScript code to execute
 * @returns {Promise<Object>} Execution result
 */
export async function executeJs(params) {
  const { tab_id, code } = params;

  if (!tab_id) throw new Error('tab_id is required');
  if (!code) throw new Error('code is required');
  if (typeof code !== 'string') throw new Error('code must be a string');
  if (code.length > MAX_SCRIPT_BYTES) {
    throw new Error(`code exceeds ${MAX_SCRIPT_BYTES} bytes`);
  }

  const tab = await chrome.tabs.get(tab_id);
  if (isProtectedPage(tab.url)) {
    throw new Error('Cannot execute scripts on protected pages');
  }

  const target = await getSession(tab_id);

  const result = await chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
    expression: code,
    returnByValue: true,
    awaitPromise: true
  });

  if (result.exceptionDetails) {
    throw new Error(
      result.exceptionDetails.exception?.description ||
      result.exceptionDetails.text ||
      'Script execution error'
    );
  }

  return { success: true, tab_id, result: result.result?.value };
}

/**
 * Handle navigation completion - re-inject persistent scripts.
 *
 * @param {Object} details - Navigation details from webNavigation.onCompleted
 */
export async function handleNavigationComplete(details) {
  if (details.frameId !== 0) return;

  const tab_id = details.tabId;
  const scriptContent = persistentScripts.get(tab_id);

  if (scriptContent) {
    try {
      await new Promise(resolve => setTimeout(resolve, 100));
      await doInjectScript(tab_id, scriptContent);
      console.log(`Re-injected persistent script into tab ${tab_id}`);
    } catch (e) {
      console.warn(`Failed to re-inject script into tab ${tab_id}:`, e);
    }
  }
}

/**
 * Clean up persistent scripts for a closed tab.
 *
 * @param {number} tabId - The closed tab ID
 */
export function handleTabClosed(tabId) {
  persistentScripts.delete(tabId);
}
