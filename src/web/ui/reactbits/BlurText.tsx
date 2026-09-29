/**
 * BlurText — adapted from React Bits (reactbits.dev), MIT + Commons Clause.
 * Changes: configurable heading tag, readable by screen readers as one
 * phrase, static when reduced motion is requested.
 */
import { motion } from 'motion/react';
import { usePrefersReducedMotion } from '../../lib/motion';

interface BlurTextProps {
  text: string;
  as?: 'h1' | 'h2' | 'p';
  className?: string;
  /** Delay between words, in ms. */
  delay?: number;
  direction?: 'top' | 'bottom';
  stepDuration?: number;
}

export default function BlurText({ text, as = 'p', className = '', delay = 90, direction = 'top', stepDuration = 0.35 }: BlurTextProps) {
  const reduced = usePrefersReducedMotion();
  const Tag = as;
  if (reduced) return <Tag className={className}>{text}</Tag>;

  const words = text.split(' ');
  const offset = direction === 'top' ? -24 : 24;
  const from = { filter: 'blur(10px)', opacity: 0, y: offset };
  const to = { filter: ['blur(10px)', 'blur(4px)', 'blur(0px)'], opacity: [0, 0.5, 1], y: [offset, offset * -0.1, 0] };

  return (
    <Tag className={`blur-text ${className}`} aria-label={text}>
      {words.map((word, i) => (
        <motion.span
          key={`${word}-${i}`}
          aria-hidden="true"
          className="blur-text-word"
          initial={from}
          animate={to}
          transition={{ duration: stepDuration * 2, times: [0, 0.5, 1], delay: (i * delay) / 1000, ease: 'easeOut' }}
        >
          {word}
          {i < words.length - 1 && ' '}
        </motion.span>
      ))}
    </Tag>
  );
}
