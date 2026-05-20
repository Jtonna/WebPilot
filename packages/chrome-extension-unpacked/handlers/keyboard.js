/**
 * Keyboard handler - CDP keyboard input simulation.
 * Types text into focused element using Input.dispatchKeyEvent.
 *
 * Mirrors click.js's detach/stall protection: when a key event triggers
 * SPA navigation (e.g. Enter in a Discord composer = send message + DOM
 * swap), individual `chrome.debugger.sendCommand` calls can hang because
 * Chrome's main thread is starved by the React re-render. We listen for
 * `chrome.debugger.onDetach` AND apply a per-call stall watchdog, so a
 * stuck CDP call short-circuits within ~4 s instead of riding out the
 * server's 30 s `COMMAND_TIMEOUT`.
 */

import { getSession } from '../utils/debugger.js';
import { click } from './click.js';

// Per-call CDP stall budget — matches click.js. See that file for the
// rationale (Discord pushState renderers can starve CDP without detaching
// the target).
const CDP_STALL_MS = 4000;

/**
 * Type text into the focused element or click a ref/selector first.
 * Uses CDP Input.dispatchKeyEvent for real keyboard simulation.
 *
 * @param {Object} params
 * @param {number} params.tab_id - Target tab ID
 * @param {string} params.text - Text to type
 * @param {string} [params.ref] - Optional ref to click first to focus
 * @param {string} [params.selector] - Optional CSS selector to click first
 * @param {number} [params.delay=50] - Delay between keystrokes in ms
 * @param {boolean} [params.pressEnter=false] - Press Enter after typing
 * @returns {Promise<Object>} Type result
 */
export async function type(params) {
  const { tab_id, text, ref, selector, delay = 50, pressEnter = false } = params;

  if (!tab_id) throw new Error('tab_id is required');
  if (!text && text !== '') throw new Error('text is required');

  // ---------------------------------------------------------------------------
  // Detach + stall watch (mirrors click.js).
  // ---------------------------------------------------------------------------
  let detached = false;
  let detachReason = null;
  const onDetach = (source, reason) => {
    if (source && source.tabId === tab_id) {
      detached = true;
      detachReason = reason || 'unknown';
    }
  };
  chrome.debugger.onDetach.addListener(onDetach);

  const safeCdp = (promise, label) =>
    raceDetachOrStall(promise, () => detached, CDP_STALL_MS, label, (reason) => {
      detached = true;
      detachReason = reason;
    });

  const t0 = Date.now();
  const phaseLog = (phase, extra) => {
    const dt = Date.now() - t0;
    if (extra !== undefined) console.log(`[type] +${dt}ms ${phase}`, extra);
    else console.log(`[type] +${dt}ms ${phase}`);
  };

  try {
    phaseLog('start', { tab_id, ref, selector, len: text.length, pressEnter });

    // If ref or selector provided, click to focus first
    if (ref || selector) {
      await click({ tab_id, ref, selector, showCursor: true });
      // Brief delay after click for focus to settle
      await sleep(100);
      phaseLog('focus_click_done');
    }

    const target = await getSession(tab_id);

    let charCount = 0;
    let stalled = false;

    // Type each character. Newlines (`\n`) are emitted as Shift+Enter so
    // chat composers (Discord, Slack, etc.) interpret them as soft line
    // breaks rather than a SUBMIT — plain Enter is reserved for the
    // optional `pressEnter: true` send below.
    for (const char of text) {
      if (detached) break;
      const r = char === '\n'
        ? await typeShiftEnter(target, safeCdp)
        : await typeChar(target, char, safeCdp);
      if (r && r.__stalled) { stalled = true; break; }
      if (r && r.__detached) break;
      charCount++;

      // Delay between keystrokes (human-like variation)
      if (delay > 0) {
        const variance = Math.floor(delay * 0.3);
        const actualDelay = delay + Math.floor(Math.random() * variance * 2) - variance;
        await sleep(Math.max(10, actualDelay));
      }
    }
    phaseLog('chars_done', { charCount, total: text.length, stalled, detached });

    // Press Enter if requested. This is the line that can trigger SPA-level
    // re-renders (sending a chat message clears the composer + appends a
    // message + scrolls + etc.) — exactly the path safeCdp protects.
    if (pressEnter && !detached) {
      await sleep(50);
      phaseLog('press_enter');
      await typeKey(target, 'Enter', safeCdp);
      phaseLog('press_enter_done', { detached, detachReason });
    }

    return {
      success: true,
      tab_id,
      text,
      charCount,
      ref,
      selector,
      pressEnter,
      // Same convention as click.js: `navigated` means the call either
      // triggered a CDP target detach OR was short-circuited by the stall
      // watchdog. The actual keystrokes that needed to fire did fire; the
      // caller can treat this as a soft success.
      navigated: detached,
      detachReason: detached ? detachReason : null,
      durationMs: Date.now() - t0
    };
  } finally {
    chrome.debugger.onDetach.removeListener(onDetach);
  }
}

/**
 * Type a single character using CDP.
 * @param {Object} target - Debugger target
 * @param {string} char - Character to type
 * @param {Function} safeCdp - per-call detach+stall wrapper
 */
async function typeChar(target, char, safeCdp) {
  const down = await safeCdp(
    chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: char,
      text: char,
      unmodifiedText: char
    }),
    'keyDown'
  );
  if (down && (down.__stalled || down.__detached)) return down;

  return await safeCdp(
    chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: char
    }),
    'keyUp'
  );
}

/**
 * Emit a Shift+Enter keystroke sequence — used to encode a `\n` in input
 * text as a soft line break in chat composers (Discord, Slack, etc.)
 * instead of a SUBMIT. Sequence is: Shift down → Enter down (with
 * modifiers=8) → Enter up (with modifiers=8) → Shift up. Each step
 * goes through `safeCdp` so the stall watchdog protects every call,
 * matching `typeChar` / `typeKey`.
 *
 * CDP `Input.dispatchKeyEvent` modifiers bitmask: Alt=1, Ctrl=2, Meta=4,
 * Shift=8. See
 * https://chromedevtools.github.io/devtools-protocol/tot/Input/#method-dispatchKeyEvent
 *
 * @param {Object} target - Debugger target
 * @param {Function} safeCdp - per-call detach+stall wrapper
 */
async function typeShiftEnter(target, safeCdp) {
  const shiftDown = await safeCdp(
    chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'Shift',
      code: 'ShiftLeft',
      windowsVirtualKeyCode: 16,
      nativeVirtualKeyCode: 16,
      modifiers: 8
    }),
    'keyDown:Shift'
  );
  if (shiftDown && (shiftDown.__stalled || shiftDown.__detached)) return shiftDown;

  const enterDown = await safeCdp(
    chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
      modifiers: 8
    }),
    'keyDown:Shift+Enter'
  );
  if (enterDown && (enterDown.__stalled || enterDown.__detached)) return enterDown;

  const enterUp = await safeCdp(
    chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
      modifiers: 8
    }),
    'keyUp:Shift+Enter'
  );
  if (enterUp && (enterUp.__stalled || enterUp.__detached)) return enterUp;

  return await safeCdp(
    chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'Shift',
      code: 'ShiftLeft',
      windowsVirtualKeyCode: 16,
      nativeVirtualKeyCode: 16
    }),
    'keyUp:Shift'
  );
}

/**
 * Type a special key (Enter, Tab, Backspace, etc.)
 * @param {Object} target - Debugger target
 * @param {string} key - Key name
 * @param {Function} safeCdp - per-call detach+stall wrapper
 */
async function typeKey(target, key, safeCdp) {
  const keyMap = {
    'Enter': { key: 'Enter', code: 'Enter', keyCode: 13 },
    'Tab': { key: 'Tab', code: 'Tab', keyCode: 9 },
    'Backspace': { key: 'Backspace', code: 'Backspace', keyCode: 8 },
    'Escape': { key: 'Escape', code: 'Escape', keyCode: 27 },
    'ArrowUp': { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
    'ArrowDown': { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
    'ArrowLeft': { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
    'ArrowRight': { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 }
  };

  const keyInfo = keyMap[key] || { key, code: key, keyCode: 0 };

  const down = await safeCdp(
    chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: keyInfo.key,
      code: keyInfo.code,
      windowsVirtualKeyCode: keyInfo.keyCode,
      nativeVirtualKeyCode: keyInfo.keyCode
    }),
    `keyDown:${key}`
  );
  if (down && (down.__stalled || down.__detached)) return down;

  return await safeCdp(
    chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: keyInfo.key,
      code: keyInfo.code,
      windowsVirtualKeyCode: keyInfo.keyCode,
      nativeVirtualKeyCode: keyInfo.keyCode
    }),
    `keyUp:${key}`
  );
}

/**
 * Race a CDP promise against a detach flag and a per-call stall budget.
 * See click.js's `raceDetachOrStall` for the full rationale.
 */
function raceDetachOrStall(promise, getDetached, stallMs, label, onStall) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (val) => {
      if (!settled) {
        settled = true;
        clearInterval(detachTick);
        clearTimeout(stallTimer);
        resolve(val);
      }
    };
    const fail = (err) => {
      if (!settled) {
        settled = true;
        clearInterval(detachTick);
        clearTimeout(stallTimer);
        reject(err);
      }
    };
    const detachTick = setInterval(() => {
      if (getDetached()) finish({ __detached: true });
    }, 25);
    const stallTimer = setTimeout(() => {
      const reason = `cdp_stall:${label}`;
      console.warn(`[type] CDP stall on "${label}" — exceeded ${stallMs}ms; short-circuiting`);
      try { if (onStall) onStall(reason); } catch (_) {}
      finish({ __stalled: true, label });
    }, stallMs);
    promise.then(finish, fail);
  });
}

/**
 * Simple sleep helper.
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
