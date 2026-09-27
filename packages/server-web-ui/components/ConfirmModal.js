'use client';

import { useEffect, useRef, useState } from 'react';
import Modal from './Modal';

/**
 * Apple-style confirmation modal. Centered card with a soft backdrop blur,
 * opacity + small scale entrance (0.96 → 1) over 220ms. Replaces
 * window.confirm() in the web UI.
 *
 * Behavior:
 *   - Backdrop click cancels; Escape cancels. Enter does NOT auto-confirm
 *     (per DESIGN_AND_UX.md) — a focused button still activates natively on
 *     Enter/Space, but there's no global listener that confirms regardless
 *     of focus.
 *   - Closes with the inverse keyframes (faster), driven by an `is-closing`
 *     class. The component keeps the modal mounted until the keyframe
 *     finishes (see <Modal>).
 *
 * Built on the shared <Modal> base for backdrop, keyboard dismiss, and exit-
 * animation lifecycle. ConfirmModal latches its props across exit so the
 * card doesn't blank out mid-animation when the parent clears body/title.
 * Exit duration is 240ms to match other modals in this app.
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

  // Dev-visibility log. <Modal> handles Esc / backdrop dismiss; there is no
  // window-level Enter-to-confirm listener (Enter does not auto-confirm).
  useEffect(() => {
    if (!open) return;
    // eslint-disable-next-line no-console
    console.log('[confirm-modal] opened:', title);
  }, [open, title]);

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
