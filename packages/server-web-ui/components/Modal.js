'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Modal — shared scaffolding for ConfirmModal, ProfileSetupModal, PairAgentModal.
 *
 * Responsibilities (the things every modal in this app does the same way):
 *   - Backdrop + .wp-modal card with the standard entrance keyframes.
 *   - Mount-during-exit pattern: when `open` flips false we keep the modal
 *     rendered with `.is-closing` for `closeMs` so the exit keyframe can play.
 *   - Esc → onClose; backdrop click → onClose (with the e.target/currentTarget
 *     guard so clicks inside the card don't dismiss).
 *   - aria-labelledby wired via the `titleId` prop.
 *
 * What it deliberately does NOT do:
 *   - Title / body / actions markup: callers compose these as children so each
 *     modal keeps its own button labels, keybindings (Enter to confirm, etc.),
 *     and focus-management quirks. ConfirmModal latches body/title across the
 *     exit animation; PairAgentModal owns its own initialFocus on the cancel
 *     button via autoFocus on the rendered <button>. We pass `initialFocusRef`
 *     through so callers can focus a specific element on open.
 *
 * Props:
 *   open          (bool, required)  — current open state
 *   onClose       (fn)              — called for Esc + backdrop dismiss
 *   titleId       (string)          — id of the heading element inside children
 *   size          ('md' | 'lg')     — adds .wp-modal-lg when 'lg'; default 'md'
 *   closeMs       (number)          — exit anim duration; default 240
 *   initialFocusRef (ref)           — focused on open (defer one tick)
 *   children                        — header / body / actions markup
 *
 * Returns null when fully closed (open=false and not currently animating out).
 */
export default function Modal({
  open,
  onClose,
  titleId,
  size = 'md',
  closeMs = 240,
  initialFocusRef = null,
  children,
}) {
  const [closing, setClosing] = useState(false);
  const wasOpenRef = useRef(open);

  // Mirror open → closing animation. Stay mounted until exit anim finishes.
  useEffect(() => {
    if (wasOpenRef.current && !open) {
      setClosing(true);
      const id = setTimeout(() => setClosing(false), closeMs);
      wasOpenRef.current = open;
      return () => clearTimeout(id);
    }
    wasOpenRef.current = open;
    return undefined;
  }, [open, closeMs]);

  // Esc closes.
  useEffect(() => {
    if (!open) return undefined;
    function onKey(e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (typeof onClose === 'function') onClose();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // Focus the initialFocusRef when opening — deferred so the element is
  // mounted and visible. Wrapped in try/catch because the ref may be detached.
  useEffect(() => {
    if (!open) return;
    if (!initialFocusRef || !initialFocusRef.current) return;
    try { initialFocusRef.current.focus(); } catch (_) { /* ignore */ }
  }, [open, initialFocusRef]);

  if (!open && !closing) return null;

  const handleBackdrop = (e) => {
    if (e.target === e.currentTarget && typeof onClose === 'function') {
      onClose();
    }
  };

  const modalClass = size === 'lg' ? 'wp-modal wp-modal-lg' : 'wp-modal';

  return (
    <div
      className={`wp-modal-backdrop${closing && !open ? ' is-closing' : ''}`}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onClick={handleBackdrop}
    >
      <div className={modalClass}>{children}</div>
    </div>
  );
}
