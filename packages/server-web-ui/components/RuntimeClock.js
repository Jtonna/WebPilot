'use client';

import { useEffect, useState } from 'react';

/**
 * Live UTC clock — small, quiet, no caret. Not used in the chrome anymore
 * (the top runtime strip was removed in the Apple Quiet pass) but kept as
 * a primitive for the Settings page or any future server-info surface that
 * wants a current-time readout.
 *
 * Returns empty until the first client tick to avoid hydration mismatch.
 */
function pad(n) {
  return n < 10 ? `0${n}` : `${n}`;
}

function formatUtc(date) {
  return `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
}

export default function RuntimeClock() {
  const [now, setNow] = useState(null);

  useEffect(() => {
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  if (!now) {
    return (
      <span className="wp-mono" suppressHydrationWarning>
        --:--:--
      </span>
    );
  }

  return (
    <span className="wp-mono" suppressHydrationWarning>
      {formatUtc(now)} UTC
    </span>
  );
}
