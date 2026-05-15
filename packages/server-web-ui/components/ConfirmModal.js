'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Mission Control confirmation modal. Hairline rectangular card with an
 * accent-orange top edge, italic serif title, mono kicker.
 *
 * Behavior:
 *   - Backdrop click cancels; Escape cancels; Enter confirms.
 *   - Opens with a vertical iris (clip-path) + backdrop fade.
 *   - Closes with the iris reversed (faster), driven by an `is-closing`
 *     class. The component keeps the modal mounted for ~200ms after `open`
 *     flips to false so the close keyframe can play before unmount.
 *
 * Replaces window.confirm() usage in the web UI — see QOL fix-up F7.
 */
export default function ConfirmModal({
  open,
  title,
  body,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  confirmDanger = false,
  onConfirm,
  onCancel,
}) {
  const cancelRef = useRef(null);
  // True while the close animation is in flight. We stay rendered, with the
  // is-closing class, until the keyframe finishes.
  const [closing, setClosing] = useState(false);
  // Latched copy of the props so the close animation has stable content even
  // after the parent zeroes out `title`/`body`.
  const lastPropsRef = useRef({ title, body, confirmLabel, cancelLabel, confirmDanger });
  useEffect(() => {
    if (open) {
      lastPropsRef.current = { title, body, confirmLabel, cancelLabel, confirmDanger };
    }
  }, [open, title, body, confirmLabel, cancelLabel, confirmDanger]);

  useEffect(() => {
    if (open && closing) {
      // Re-opened while closing — cancel the close.
      setClosing(false);
    }
    if (!open && !closing) return undefined;

    function handleKey(e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (typeof onCancel === 'function') onCancel();
      } else if (e.key === 'Enter') {
        if (typeof onConfirm === 'function') onConfirm();
      }
    }
    if (open) {
      window.addEventListener('keydown', handleKey);
      if (cancelRef.current) {
        try { cancelRef.current.focus(); } catch (_) { /* ignore */ }
      }
      // eslint-disable-next-line no-console
      console.log('[confirm-modal] opened:', title);
    }
    return () => {
      window.removeEventListener('keydown', handleKey);
    };
  }, [open, closing, onCancel, onConfirm, title]);

  // When `open` flips from true → false we delay unmount so the close
  // animation can run.
  const wasOpenRef = useRef(open);
  useEffect(() => {
    if (wasOpenRef.current && !open) {
      setClosing(true);
      const id = setTimeout(() => setClosing(false), 220);
      wasOpenRef.current = open;
      return () => clearTimeout(id);
    }
    wasOpenRef.current = open;
    return undefined;
  }, [open]);

  if (!open && !closing) return null;

  const handleBackdrop = (e) => {
    if (e.target === e.currentTarget && typeof onCancel === 'function') {
      onCancel();
    }
  };

  const view = open ? { title, body, confirmLabel, cancelLabel, confirmDanger } : lastPropsRef.current;

  return (
    <div
      className={`wp-modal-backdrop${closing && !open ? ' is-closing' : ''}`}
      role="dialog"
      aria-modal="true"
      aria-labelledby="wp-confirm-title"
      onClick={handleBackdrop}
    >
      <div className="wp-modal">
        <div className="wp-modal-kicker">§ confirm · action required</div>
        <h2 id="wp-confirm-title" className="wp-modal-title">{view.title}</h2>
        <div className="wp-modal-body">{view.body}</div>
        <div className="wp-modal-actions">
          <button
            ref={cancelRef}
            type="button"
            className="wp-btn"
            onClick={onCancel}
          >
            {view.cancelLabel}
          </button>
          <button
            type="button"
            className={view.confirmDanger ? 'wp-btn wp-btn-danger' : 'wp-btn wp-btn-primary'}
            onClick={onConfirm}
          >
            {view.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
