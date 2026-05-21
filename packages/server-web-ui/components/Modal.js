'use client';

import { useEffect, useRef, useState } from 'react';

// Standard focusable-elements selector. Used by the hand-rolled focus
// trap: on Tab at the last focusable, wrap to the first; on Shift+Tab at
// the first, wrap to the last. No third-party dep; queried fresh on every
// keystroke so dynamically rendered buttons (e.g. ConfirmModal showing a
// "Saving…" spinner) are picked up.
const FOCUSABLE_SELECTORS = [
  'a[href]',
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

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
  const modalRef = useRef(null);

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

  // Esc closes + Tab/Shift+Tab focus trap. Both handlers live in one
  // keydown listener so we only attach one global handler per open modal.
  // The trap queries the modal root on every Tab so dynamically inserted
  // controls (e.g. ConfirmModal swapping a button label mid-submit) are
  // included in the wrap-around order.
  useEffect(() => {
    if (!open) return undefined;
    function onKey(e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (typeof onClose === 'function') onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const root = modalRef.current;
      if (!root) return;
      const nodes = root.querySelectorAll(FOCUSABLE_SELECTORS);
      // Filter to nodes that are actually focusable right now: skip
      // visually-hidden or inert elements (offsetParent === null is the
      // cheapest sniff that catches `display:none` ancestors; disabled
      // inputs are already excluded by the selector).
      const focusable = Array.from(nodes).filter(
        (el) => el.offsetParent !== null || el === document.activeElement
      );
      if (focusable.length === 0) {
        // Nothing focusable inside the dialog — keep focus from escaping
        // by parking it on the dialog itself.
        e.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (e.shiftKey) {
        if (active === first || !root.contains(active)) {
          e.preventDefault();
          try { last.focus(); } catch (_) { /* ignore */ }
        }
      } else if (active === last || !root.contains(active)) {
        e.preventDefault();
        try { first.focus(); } catch (_) { /* ignore */ }
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
      <div ref={modalRef} className={modalClass}>{children}</div>
    </div>
  );
}
