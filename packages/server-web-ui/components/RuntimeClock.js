'use client';

import { useEffect, useState } from 'react';

/**
 * Live UTC clock displayed in the runtime strip. Pure presentation — ticks
 * once a second via setInterval. Renders empty until the first client tick
 * to avoid hydration mismatch.
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
    </span>
  );
}
