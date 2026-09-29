/**
 * CountUp — adapted from React Bits (reactbits.dev), MIT + Commons Clause.
 * Changes: animates on every change of `to` (live statistics), exposes the
 * final value to assistive technology immediately, respects reduced motion.
 */
import { useMotionValue, useSpring } from 'motion/react';
import { useEffect, useRef } from 'react';
import { usePrefersReducedMotion } from '../../lib/motion';

interface CountUpProps {
  to: number;
  duration?: number;
  className?: string;
}

export default function CountUp({ to, duration = 1, className = '' }: CountUpProps) {
  const reduced = usePrefersReducedMotion();
  const ref = useRef<HTMLSpanElement>(null);
  const value = useMotionValue(0);
  const spring = useSpring(value, { damping: 20 + 40 / duration, stiffness: 100 / duration });

  useEffect(() => {
    if (reduced) {
      if (ref.current) ref.current.textContent = String(to);
      return;
    }
    value.set(to);
  }, [to, reduced, value]);

  useEffect(
    () =>
      spring.on('change', (latest) => {
        if (ref.current && !reduced) ref.current.textContent = String(Math.round(latest));
      }),
    [spring, reduced],
  );

  return (
    <span className={className}>
      <span ref={ref} aria-hidden="true">
        {reduced ? to : 0}
      </span>
      <span className="visually-hidden">{to}</span>
    </span>
  );
}
