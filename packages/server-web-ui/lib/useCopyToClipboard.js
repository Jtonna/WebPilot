'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * useCopyToClipboard — collapses the 4 near-identical clipboard impls in this
 * UI (AgentRow's Copy config, Settings paths, ProfileSetupModal's two copy
 * widgets, and PairAgentModal's larger handleCopy flow).
 *
 * Returns a tuple [state, copy] where `state` is one of:
 *   'idle' | 'copied' | 'error'
 *
 * The hook auto-reverts to 'idle' after `revertMs` (default 1500). Pending
 * revert timers are cleared on unmount so a fast unmount doesn't try to call
 * setState on a stale component.
 *
 * Callers that need to layer additional behavior on top of the copy itself
 * (e.g. PairAgentModal's commit-the-tentative-agent flow) wrap the `copy`
 * return in their own async function — the hook intentionally stays minimal.
 *
 *   const [copyState, copy] = useCopyToClipboard();
 *   <button onClick={() => copy('text')}>
 *     {copyState === 'copied' ? 'Copied' : 'Copy'}
 *   </button>
 */
export function useCopyToClipboard({ revertMs = 1500, onSuccess, onError } = {}) {
  const [state, setState] = useState('idle');
  const timerRef = useRef(null);

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
      setState('copied');
      if (onSuccess) onSuccess(text);
    } catch (e) {
      setState('error');
      if (onError) onError(e);
    }
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setState('idle'), revertMs);
  }

  return [state, copy];
}
