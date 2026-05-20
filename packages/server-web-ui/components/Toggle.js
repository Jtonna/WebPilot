'use client';

import { useId } from 'react';

/**
 * Toggle — small monochrome switch in the WebPilot mono palette.
 *
 * Visual: hairline-bordered pill track (~36×20px). Off — transparent fill;
 * on — `--wp-fg` fill (value-only, no accent hue). Knob is a white-bg
 * circle with a hairline border that slides via `transform`. Click target
 * is the whole label so users can hit either text or switch.
 *
 * Motion: transform-only transition on the knob; honors
 * `prefers-reduced-motion` (the reset lives in globals.css under the
 * .wp-toggle* selectors).
 *
 * Props:
 *   checked   — boolean, controlled.
 *   onChange  — (next: boolean) => void.
 *   label     — string. Rendered to the left of the switch.
 *   title     — optional string. Native tooltip on the label (used here
 *               for the longer "On / Off" explainer that no longer lives
 *               in a paragraph).
 *   disabled  — boolean.
 *   id        — optional. Auto-generated otherwise.
 */
export default function Toggle({ checked, onChange, label, title, disabled, id }) {
  const generatedId = useId();
  const inputId = id || `wp-toggle-${generatedId}`;
  return (
    <label
      className={`wp-toggle${disabled ? ' is-disabled' : ''}`}
      htmlFor={inputId}
      title={title || undefined}
    >
      {label ? <span className="wp-toggle-label">{label}</span> : null}
      <span className={`wp-toggle-track${checked ? ' is-on' : ''}`}>
        <input
          id={inputId}
          type="checkbox"
          className="wp-toggle-input"
          checked={!!checked}
          disabled={!!disabled}
          onChange={(e) => {
            if (typeof onChange === 'function') onChange(e.target.checked);
          }}
        />
        <span className="wp-toggle-knob" aria-hidden="true" />
      </span>
    </label>
  );
}
