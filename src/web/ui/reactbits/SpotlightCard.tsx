/**
 * SpotlightCard — adapted from React Bits (reactbits.dev), MIT + Commons Clause.
 * Changes: themed via CSS tokens, forwards element props, polymorphic tag.
 */
import { type HTMLAttributes, useRef } from 'react';

type SpotlightCardProps = HTMLAttributes<HTMLElement> & {
  as?: 'div' | 'section' | 'li';
};

export default function SpotlightCard({ as = 'div', className = '', children, onMouseMove, ...rest }: SpotlightCardProps) {
  const ref = useRef<HTMLElement>(null);
  const Tag = as as 'div';
  return (
    <Tag
      {...rest}
      ref={ref as React.Ref<HTMLDivElement>}
      className={`card-spotlight ${className}`}
      onMouseMove={(e) => {
        const el = ref.current;
        if (el) {
          const rect = el.getBoundingClientRect();
          el.style.setProperty('--mouse-x', `${e.clientX - rect.left}px`);
          el.style.setProperty('--mouse-y', `${e.clientY - rect.top}px`);
        }
        onMouseMove?.(e);
      }}
    >
      {children}
    </Tag>
  );
}
