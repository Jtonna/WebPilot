'use client';

import { useEffect, useRef } from 'react';

/**
 * Mission Control confirmation modal. Hairline rectangular card with an
 * accent-orange top edge, italic serif title, mono kicker. Backdrop click
 * cancels; Escape cancels; Enter confirms.
 *
 * Props:
 *   open         — boolean; modal visible iff true
 *   title        — short header text (rendered in italic serif)
 *   body         — string or React node for the message
 *   confirmLabel — defaults to "Confirm"
 *   cancelLabel  — defaults to "Cancel"
 *   confirmDanger — if true, the Confirm button uses the danger style
 *   onConfirm    — called when the user clicks Confirm or hits Enter
 *   onCancel     — called when the user clicks Cancel, hits Escape, or
 *                  clicks the backdrop
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

  useEffect(() => {
    if (!open) return undefined;
    function handleKey(e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (typeof onCancel === 'function') onCancel();
      } else if (e.key === 'Enter') {
        if (typeof onConfirm === 'function') onConfirm();
      }
    }
    window.addEventListener('keydown', handleKey);
    if (cancelRef.current) {
      try { cancelRef.current.focus(); } catch (_) { /* ignore */ }
    }
    // eslint-disable-next-line no-console
    console.log('[confirm-modal] opened:', title);
    return () => {
      window.removeEventListener('keydown', handleKey);
    };
  }, [open, onCancel, onConfirm, title]);

  if (!open) return null;

  const handleBackdrop = (e) => {
    if (e.target === e.currentTarget && typeof onCancel === 'function') {
      onCancel();
    }
  };

  return (
    <div
      className="wp-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="wp-confirm-title"
      onClick={handleBackdrop}
    >
      <div className="wp-modal">
        <div className="wp-modal-kicker">§ confirm · action required</div>
        <h2 id="wp-confirm-title" className="wp-modal-title">{title}</h2>
        <div className="wp-modal-body">{body}</div>
        <div className="wp-modal-actions">
          <button
            ref={cancelRef}
            type="button"
            className="wp-btn"
            onClick={onCancel}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            className={confirmDanger ? 'wp-btn wp-btn-danger' : 'wp-btn wp-btn-primary'}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
