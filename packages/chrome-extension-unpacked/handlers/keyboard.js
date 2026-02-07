/**
 * Keyboard handler - CDP keyboard input simulation.
 * Types text into focused element using Input.dispatchKeyEvent.
 */

import { getSession } from '../utils/debugger.js';
import { click } from './click.js';

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

  // If ref or selector provided, click to focus first
  if (ref || selector) {
    await click({ tab_id, ref, selector, showCursor: true });
    // Brief delay after click for focus to settle
    await sleep(100);
  }

  const target = await getSession(tab_id);

  let charCount = 0;

  // Type each character
  for (const char of text) {
    await typeChar(target, char);
    charCount++;

    // Delay between keystrokes (human-like variation)
    if (delay > 0) {
      const variance = Math.floor(delay * 0.3);
      const actualDelay = delay + Math.floor(Math.random() * variance * 2) - variance;
      await sleep(Math.max(10, actualDelay));
    }
  }

  // Press Enter if requested
  if (pressEnter) {
    await sleep(50);
    await typeKey(target, 'Enter');
  }

  return {
    success: true,
    tab_id,
    text,
    charCount,
    ref,
    selector,
    pressEnter
  };
}

/**
 * Type a single character using CDP.
 * @param {Object} target - Debugger target
 * @param {string} char - Character to type
 */
async function typeChar(target, char) {
  // For regular characters, use keyDown with text property
  await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: char,
    text: char,
    unmodifiedText: char
  });

  await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: char
  });
}

/**
 * Type a special key (Enter, Tab, Backspace, etc.)
 * @param {Object} target - Debugger target
 * @param {string} key - Key name
 */
async function typeKey(target, key) {
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

  await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: keyInfo.key,
    code: keyInfo.code,
    windowsVirtualKeyCode: keyInfo.keyCode,
    nativeVirtualKeyCode: keyInfo.keyCode
  });

  await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: keyInfo.key,
    code: keyInfo.code,
    windowsVirtualKeyCode: keyInfo.keyCode,
    nativeVirtualKeyCode: keyInfo.keyCode
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
