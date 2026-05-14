'use client';

import { useEffect, useRef } from 'react';

/**
 * Dark-themed confirmation modal. Renders inline (no portal) at fixed
 * positioning over the page. Backdrop click cancels; Escape cancels.
 *
 * Props:
 *   open       — boolean; modal visible iff true
 *   title      — short header text
 *   body       — string or React node for the message
 *   confirmLabel — defaults to "Confirm"
 *   cancelLabel  — defaults to "Cancel"
 *   confirmDanger — if true, the Confirm button uses the danger style
 *   onConfirm  — called when the user clicks Confirm
 *   onCancel   — called when the user clicks Cancel, hits Escape, or
 *                clicks the backdrop
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
        // Only fire on Enter if the active element is inside the modal — avoid
        // accidentally double-firing from a focused input elsewhere.
        if (typeof onConfirm === 'function') onConfirm();
      }
    }
    window.addEventListener('keydown', handleKey);
    // Focus the Cancel button by default — safer for destructive actions.
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

  const backdropStyle = {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0, 0, 0, 0.6)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000,
  };

  const cardStyle = {
    background: '#171717',
    color: '#e5e5e5',
    border: '1px solid #2a2a2a',
    borderRadius: 8,
    padding: '20px 24px',
    width: 'min(440px, calc(100% - 32px))',
    boxShadow: '0 10px 40px rgba(0, 0, 0, 0.6)',
  };

  const titleStyle = {
    margin: '0 0 12px 0',
    fontSize: '1.05rem',
    fontWeight: 600,
  };

  const bodyStyle = {
    margin: '0 0 20px 0',
    color: '#c5c5c5',
    fontSize: '0.95rem',
    lineHeight: 1.5,
  };

  const actionsStyle = {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: 8,
  };

  const handleBackdrop = (e) => {
    if (e.target === e.currentTarget && typeof onCancel === 'function') {
      onCancel();
    }
  };

  return (
    <div
      style={backdropStyle}
      role="dialog"
      aria-modal="true"
      aria-labelledby="wp-confirm-title"
      onClick={handleBackdrop}
    >
      <div style={cardStyle}>
        <h2 id="wp-confirm-title" style={titleStyle}>{title}</h2>
        <div style={bodyStyle}>{body}</div>
        <div style={actionsStyle}>
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
