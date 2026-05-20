'use client';

/**
 * Skeleton — placeholder block for content that hasn't loaded yet.
 *
 * Renders as a `--wp-bg-elevated` rectangle with a subtle moving-gradient
 * shimmer (1.4s linear infinite). Animation is suppressed under
 * `prefers-reduced-motion`. No opacity flashing, no scaling.
 *
 * Props:
 *   width    — CSS length. Default 100%.
 *   height   — CSS length. Default 16px.
 *   radius   — CSS length. Default var(--radius-sm).
 *   className — extra classes appended to the root.
 *   style     — inline style merged onto the root.
 *
 * Convenience export:
 *   <SkeletonRow /> — common "title line + sub line" stack used inside
 *   wp-row-like containers.
 */
export default function Skeleton({
  width = '100%',
  height = 16,
  radius,
  className,
  style,
  ...rest
}) {
  const cls = `wp-skeleton${className ? ` ${className}` : ''}`;
  const h = typeof height === 'number' ? `${height}px` : height;
  const w = typeof width === 'number' ? `${width}px` : width;
  const r = radius || 'var(--radius-sm)';
  return (
    <span
      aria-hidden="true"
      className={cls}
      style={{
        display: 'block',
        width: w,
        height: h,
        borderRadius: r,
        ...style,
      }}
      {...rest}
    />
  );
}

/**
 * SkeletonRow — "row-shaped" skeleton with a title line and a sub line,
 * stacked the same way a wp-row's body is. Useful for list placeholders.
 *
 * Props:
 *   titleWidth — width of the top line. Default 60%.
 *   subWidth   — width of the bottom line. Default 40%.
 *   showTrailing — when true, also renders a small pill-shaped trailing
 *                  block on the right (for AgentRow / PairingRow shapes).
 *   padded    — apply wp-row's row padding so it visually lines up. Default
 *               true.
 */
export function SkeletonRow({
  titleWidth = '60%',
  subWidth = '40%',
  showTrailing = false,
  padded = true,
}) {
  return (
    <div
      className={padded ? 'wp-row' : ''}
      style={padded ? { cursor: 'default' } : { display: 'flex', alignItems: 'center', gap: 'var(--s-4)', padding: 'var(--s-3) 0' }}
    >
      <div className="wp-row-grow" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-2)' }}>
        <Skeleton width={titleWidth} height={14} />
        <Skeleton width={subWidth} height={12} />
      </div>
      {showTrailing ? (
        <Skeleton width={64} height={20} radius="var(--radius-xs)" />
      ) : null}
    </div>
  );
}
