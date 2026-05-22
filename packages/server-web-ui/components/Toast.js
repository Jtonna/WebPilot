'use client';

import { useEffect, useState } from 'react';
import {
  CheckCircleIcon,
  InformationCircleIcon,
  ExclamationCircleIcon,
} from '@heroicons/react/24/outline';
import { XMarkIcon } from '@heroicons/react/20/solid';

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
    flavor === 'success' ? CheckCircleIcon :
    flavor === 'error'   ? ExclamationCircleIcon :
    InformationCircleIcon;

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
        <FlavorIcon style={{ width: 20, height: 20 }} />
      </span>
      <div className="wp-toast-body">{message}</div>
      <button
        type="button"
        className="wp-toast-close"
        aria-label="Dismiss"
        onClick={beginDismiss}
      >
        <XMarkIcon style={{ width: 16, height: 16 }} />
      </button>
    </div>
  );
}
