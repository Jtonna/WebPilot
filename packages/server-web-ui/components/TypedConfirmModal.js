'use client';

import { useEffect, useId, useRef, useState } from 'react';
import Modal from './Modal';

/**
 * TypedConfirmModal — like ConfirmModal but requires the user to type a
 * confirmation phrase before the Confirm button is enabled. Used for
 * higher-stakes actions where a single misclick shouldn't be enough.
 *
 * Behavior:
 *   - Backdrop click / Escape cancels (handled by <Modal>).
 *   - No Enter-to-confirm shortcut: submitting the form (Enter in the input,
 *     or clicking Confirm) only calls onConfirm when the typed value matches
 *     `phrase` (case-insensitive, trimmed).
 *   - Latches title/body/labels across the exit animation so the card
 *     doesn't blank out mid-animation when the parent clears props, mirroring
 *     ConfirmModal.
 *   - Input is cleared whenever the modal transitions to open, and receives
 *     initial focus (via Modal's initialFocusRef).
 */
export default function TypedConfirmModal({
  open,
  title,
  body,
  phrase = 'i understand',
  inputLabel,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  confirmDanger = true,
  onConfirm,
  onCancel,
}) {
  const inputRef = useRef(null);
  const [value, setValue] = useState('');
  const reactId = useId();
  const hintId = `wp-typed-confirm-hint-${reactId}`;
  const inputId = `wp-typed-confirm-input-${reactId}`;

  const resolvedInputLabel = inputLabel || `Type ${phrase} to confirm.`;

  // Latched copy of the props so the close animation has stable content even
  // after the parent zeroes out `title`/`body`.
  const lastPropsRef = useRef({
    title,
    body,
    phrase,
    inputLabel: resolvedInputLabel,
    confirmLabel,
    cancelLabel,
    confirmDanger,
  });
  useEffect(() => {
    if (open) {
      lastPropsRef.current = {
        title,
        body,
        phrase,
        inputLabel: resolvedInputLabel,
        confirmLabel,
        cancelLabel,
        confirmDanger,
      };
    }
  }, [open, title, body, phrase, resolvedInputLabel, confirmLabel, cancelLabel, confirmDanger]);

  // Clear the input every time the modal opens.
  useEffect(() => {
    if (open) setValue('');
  }, [open]);

  // Like ConfirmModal: live props while open, latched props only during the
  // exit animation (after the parent has cleared title/body on close).
  const view = open
    ? {
        title,
        body,
        phrase,
        inputLabel: resolvedInputLabel,
        confirmLabel,
        cancelLabel,
        confirmDanger,
      }
    : lastPropsRef.current;

  const matched = value.trim().toLowerCase() === view.phrase.toLowerCase();

  function handleSubmit(e) {
    e.preventDefault();
    if (!matched) return;
    if (typeof onConfirm === 'function') onConfirm();
  }

  return (
    <Modal
      open={open}
      onClose={onCancel}
      titleId="wp-typed-confirm-title"
      initialFocusRef={inputRef}
    >
      <h2 id="wp-typed-confirm-title" className="wp-modal-title">{view.title}</h2>
      <div className="wp-modal-body">{view.body}</div>
      <form
        onSubmit={handleSubmit}
        style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-4)' }}
      >
        <div>
          <label htmlFor={inputId} className="wp-secondary" style={{ display: 'block', marginBottom: 'var(--s-2)' }}>
            {view.inputLabel}
          </label>
          <input
            ref={inputRef}
            id={inputId}
            type="text"
            className="wp-input"
            autoComplete="off"
            spellCheck={false}
            aria-describedby={hintId}
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
          <div
            id={hintId}
            className="wp-secondary"
            style={{ marginTop: 'var(--s-2)', fontSize: 'var(--fs-small)' }}
          >
            Not case-sensitive.
          </div>
        </div>
        <div className="wp-modal-actions">
          <button
            type="button"
            className="wp-btn"
            onClick={onCancel}
          >
            {view.cancelLabel}
          </button>
          <button
            type="submit"
            className={view.confirmDanger ? 'wp-btn wp-btn-danger' : 'wp-btn'}
            disabled={!matched}
          >
            {view.confirmLabel}
          </button>
        </div>
      </form>
    </Modal>
  );
}
