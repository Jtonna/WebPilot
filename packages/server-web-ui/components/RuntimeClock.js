'use client';

import { useEffect, useState } from 'react';

/**
 * Live UTC clock displayed in the runtime strip. Pure presentation — ticks
 * once a second via setInterval. Renders empty until the first client tick
 * to avoid hydration mismatch.
 *
 * A 1Hz accent-orange caret blinks to the right of the seconds field for a
 * terminal feel. The blink keyframes are gated globally by
 * `prefers-reduced-motion`.
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
    return <span className="wp-mono" suppressHydrationWarning>--:--:-- UTC</span>;
  }

  return (
    <span className="wp-mono" suppressHydrationWarning>
      {formatUtc(now)} UTC
      <span className="wp-strip-caret" aria-hidden="true" />
    </span>
  );
}
