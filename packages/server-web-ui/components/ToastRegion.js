'use client';

import { createContext, useCallback, useContext, useRef, useState } from 'react';
import Toast from './Toast';

/**
 * ToastRegion — fixed lower-right (lower-center on mobile) toast stack.
 *
 * Wrap the app in <ToastProvider> (done in app/layout.js) and call
 * `useToast()` from any descendant to push toasts.
 *
 *   const toast = useToast();
 *   toast.success('Profile created.');
 *   toast.error('Could not reach the server.');
 *
 * Max 3 visible at a time — older toasts are dropped from the stack.
 */

const MAX_VISIBLE = 3;

const ToastContext = createContext({
  push: () => {},
  success: () => {},
  info: () => {},
  error: () => {},
});

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const counterRef = useRef(0);

  const push = useCallback((flavor, message, opts = {}) => {
    counterRef.current += 1;
    const id = `t-${counterRef.current}`;
    setToasts((prev) => {
      const next = [...prev, { id, flavor, message, duration: opts.duration }];
      return next.length > MAX_VISIBLE ? next.slice(next.length - MAX_VISIBLE) : next;
    });
    return id;
  }, []);

  const dismiss = useCallback((id) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const value = {
    push,
    success: (m, o) => push('success', m, o),
    info:    (m, o) => push('info', m, o),
    error:   (m, o) => push('error', m, o),
  };

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="wp-toast-region" aria-live="polite" aria-atomic="false">
        {toasts.map((t) => (
          <Toast
            key={t.id}
            id={t.id}
            flavor={t.flavor}
            message={t.message}
            duration={t.duration}
            onDismiss={dismiss}
          />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}
