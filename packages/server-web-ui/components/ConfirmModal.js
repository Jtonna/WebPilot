'use client';

import { useEffect, useRef, useState } from 'react';
import Modal from './Modal';

/**
 * Apple-style confirmation modal. Centered card with a soft backdrop blur,
 * opacity + small scale entrance (0.96 → 1) over 220ms. Replaces
 * window.confirm() in the web UI.
 *
 * Behavior:
 *   - Backdrop click cancels; Escape cancels; Enter confirms.
 *   - Closes with the inverse keyframes (faster), driven by an `is-closing`
 *     class. The component keeps the modal mounted until the keyframe
 *     finishes (see <Modal>).
 *
 * Built on the shared <Modal> base for backdrop, keyboard dismiss, and exit-
 * animation lifecycle. ConfirmModal owns the Enter-to-confirm shortcut and
 * latches its props across exit so the card doesn't blank out mid-animation
 * when the parent clears body/title. Exit duration is 240ms to match other
 * modals in this app.
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
  // Latched copy of the props so the close animation has stable content even
  // after the parent zeroes out `title`/`body`.
  const lastPropsRef = useRef({ title, body, confirmLabel, cancelLabel, confirmDanger });
  useEffect(() => {
    if (open) {
      lastPropsRef.current = { title, body, confirmLabel, cancelLabel, confirmDanger };
    }
  }, [open, title, body, confirmLabel, cancelLabel, confirmDanger]);

  // Enter-to-confirm. <Modal> handles Esc / backdrop dismiss.
  useEffect(() => {
    if (!open) return undefined;
    function handleKey(e) {
      if (e.key === 'Enter') {
        if (typeof onConfirm === 'function') onConfirm();
      }
    }
    window.addEventListener('keydown', handleKey);
    // eslint-disable-next-line no-console
    console.log('[confirm-modal] opened:', title);
    return () => window.removeEventListener('keydown', handleKey);
  }, [open, onConfirm, title]);

  const view = open ? { title, body, confirmLabel, cancelLabel, confirmDanger } : lastPropsRef.current;

  return (
    <Modal
      open={open}
      onClose={onCancel}
      titleId="wp-confirm-title"
      initialFocusRef={cancelRef}
    >
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
    </Modal>
  );
}
