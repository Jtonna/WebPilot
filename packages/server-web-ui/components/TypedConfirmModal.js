'use client';

import { useEffect, useId, useRef, useState } from 'react';
import Modal from './Modal';

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

// Excludes visually ambiguous characters (0/O, 1/I/L) so a typed code can't
// be misread off the screen.
function generateCode(length) {
  const bytes = new Uint8Array(length);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  } else {
    // Non-crypto fallback (e.g. SSR/build-time render); never used in the
    // browser where crypto is always available.
    for (let i = 0; i < length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return out;
}

/**
 * TypedConfirmModal — like ConfirmModal but requires the user to type a
 * random confirmation code before the Confirm button is enabled. Used for
 * higher-stakes actions where a single misclick shouldn't be enough.
 *
 * Behavior:
 *   - A fresh `codeLength`-character code (default 4, alphabet excludes
 *     ambiguous chars) is generated every time `open` transitions to true.
 *   - Backdrop click / Escape cancels (handled by <Modal>).
 *   - No blanket Enter-to-confirm shortcut: submitting the form (Enter in
 *     the input, or clicking Confirm) only calls onConfirm when the typed
 *     value matches the generated code (case-insensitive, trimmed).
 *   - Latches title/body/labels/code across the exit animation so the card
 *     doesn't blank out mid-animation when the parent clears props, mirroring
 *     ConfirmModal.
 *   - Input is cleared and a new code is generated whenever the modal
 *     transitions to open; the input receives initial focus (via Modal's
 *     initialFocusRef).
 */
export default function TypedConfirmModal({
  open,
  title,
  body,
  codeLength = 4,
  inputLabel,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  confirmDanger = true,
  onConfirm,
  onCancel,
}) {
  const inputRef = useRef(null);
  const [value, setValue] = useState('');
  const [code, setCode] = useState(() => generateCode(codeLength));
  const reactId = useId();
  const hintId = `wp-typed-confirm-hint-${reactId}`;
  const inputId = `wp-typed-confirm-input-${reactId}`;

  const resolvedInputLabel = (label) =>
    inputLabel || (
      <>
        Type <code className="wp-mono">{label}</code> to confirm.
      </>
    );

  // Latched copy of the props so the close animation has stable content even
  // after the parent zeroes out `title`/`body`.
  const lastPropsRef = useRef({
    title,
    body,
    code,
    confirmLabel,
    cancelLabel,
    confirmDanger,
  });
  useEffect(() => {
    if (open) {
      lastPropsRef.current = {
        title,
        body,
        code,
        confirmLabel,
        cancelLabel,
        confirmDanger,
      };
    }
  }, [open, title, body, code, confirmLabel, cancelLabel, confirmDanger]);

  // On every open transition: clear the input and roll a fresh code so a
  // stale/leaked code from a previous open can't be reused.
  useEffect(() => {
    if (open) {
      setValue('');
      setCode(generateCode(codeLength));
    }
    // codeLength intentionally omitted — it's not expected to change across
    // opens for a given call site, and including it would re-roll on every
    // render if the caller passes a fresh default value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Like ConfirmModal: live props while open, latched props only during the
  // exit animation (after the parent has cleared title/body on close).
  const view = open
    ? { title, body, code, confirmLabel, cancelLabel, confirmDanger }
    : lastPropsRef.current;

  const matched = value.trim().toUpperCase() === view.code;

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
            {resolvedInputLabel(view.code)}
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
