/**
 * ShinyText — adapted from React Bits (reactbits.dev), MIT + Commons Clause.
 * Changes: pure CSS animation (no per-frame JavaScript), theme-token colors,
 * disabled for reduced motion via CSS.
 */
interface ShinyTextProps {
  text: string;
  className?: string;
  /** Seconds per sweep. */
  speed?: number;
  disabled?: boolean;
}

export default function ShinyText({ text, className = '', speed = 3, disabled = false }: ShinyTextProps) {
  return (
    <span className={`shiny-text${disabled ? ' disabled' : ''} ${className}`} style={{ animationDuration: `${speed}s` }}>
      {text}
    </span>
  );
}
