'use client';

import { useEffect, useState } from 'react';
import { CheckCircle, Info, WarningCircle, X } from '@phosphor-icons/react';

/**
 * Toast — a single toast notification. Rendered by ToastRegion.
 *
 * Props:
 *   id        — unique id (used for keying / dismiss).
 *   flavor    — 'success' | 'info' | 'error'.
 *   message   — string or React node.
 *   onDismiss — callback fired when the toast should be removed.
 *   duration  — auto-dismiss ms; 0 → persistent.  Errors default to 0.
 */
export default function Toast({ id, flavor = 'info', message, onDismiss, duration }) {
  const [leaving, setLeaving] = useState(false);

  const FlavorIcon =
    flavor === 'success' ? CheckCircle :
    flavor === 'error'   ? WarningCircle :
    Info;

  const effective =
    typeof duration === 'number'
      ? duration
      : (flavor === 'error' ? 0 : 4000);

  useEffect(() => {
    if (effective === 0) return undefined;
    const t = setTimeout(() => beginDismiss(), effective);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effective]);

  function beginDismiss() {
    setLeaving(true);
    setTimeout(() => {
      if (typeof onDismiss === 'function') onDismiss(id);
    }, 180);
  }

  return (
    <div
      role="status"
      data-flavor={flavor}
      className={`wp-toast${leaving ? ' is-leaving' : ''}`}
    >
      <span className="wp-toast-icon" aria-hidden="true">
        <FlavorIcon size={20} weight="regular" />
      </span>
      <div className="wp-toast-body">{message}</div>
      <button
        type="button"
        className="wp-toast-close"
        aria-label="Dismiss"
        onClick={beginDismiss}
      >
        <X size={14} weight="bold" />
      </button>
    </div>
  );
}
