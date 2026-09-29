/**
 * StarBorder — adapted from React Bits (reactbits.dev), MIT + Commons Clause.
 * Changes: wraps an existing button/element instead of rendering one, themed
 * glow color, animation paused for reduced motion via CSS.
 */
import type { ReactNode } from 'react';

interface StarBorderProps {
  children: ReactNode;
  className?: string;
  /** Seconds per sweep. */
  speed?: number;
}

export default function StarBorder({ children, className = '', speed = 6 }: StarBorderProps) {
  const style = { animationDuration: `${speed}s` };
  return (
    <div className={`star-border ${className}`}>
      <div className="star-border-glow bottom" style={style} aria-hidden="true" />
      <div className="star-border-glow top" style={style} aria-hidden="true" />
      <div className="star-border-inner">{children}</div>
    </div>
  );
}
