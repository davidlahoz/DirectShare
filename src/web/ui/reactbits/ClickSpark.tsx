/**
 * ClickSpark — adapted from React Bits (reactbits.dev), MIT + Commons Clause.
 * Changes: the animation loop runs only while sparks are visible, color from
 * a CSS custom property, disabled for reduced motion, inline-sized wrapper.
 */
import { type ReactNode, useCallback, useEffect, useRef } from 'react';
import { usePrefersReducedMotion } from '../../lib/motion';

interface ClickSparkProps {
  children: ReactNode;
  className?: string;
  sparkSize?: number;
  sparkRadius?: number;
  sparkCount?: number;
  duration?: number;
}

interface Spark {
  x: number;
  y: number;
  angle: number;
  start: number;
}

export default function ClickSpark({ children, className = '', sparkSize = 10, sparkRadius = 22, sparkCount = 8, duration = 450 }: ClickSparkProps) {
  const reduced = usePrefersReducedMotion();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sparks = useRef<Spark[]>([]);
  const frame = useRef(0);

  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  const draw = useCallback(
    (now: number) => {
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext('2d');
      if (!canvas || !ctx) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.strokeStyle = getComputedStyle(canvas).getPropertyValue('--spark-color').trim() || '#0b6e4f';
      ctx.lineWidth = 2;
      ctx.lineCap = 'round';
      sparks.current = sparks.current.filter((s) => {
        const t = (now - s.start) / duration;
        if (t >= 1) return false;
        const eased = t * (2 - t);
        const distance = eased * sparkRadius;
        const length = sparkSize * (1 - eased);
        ctx.beginPath();
        ctx.moveTo(s.x + distance * Math.cos(s.angle), s.y + distance * Math.sin(s.angle));
        ctx.lineTo(s.x + (distance + length) * Math.cos(s.angle), s.y + (distance + length) * Math.sin(s.angle));
        ctx.stroke();
        return true;
      });
      frame.current = sparks.current.length > 0 ? requestAnimationFrame(draw) : 0;
    },
    [duration, sparkRadius, sparkSize],
  );

  const onClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const canvas = canvasRef.current;
    if (reduced || !canvas) return;
    const rect = canvas.getBoundingClientRect();
    if (canvas.width !== Math.round(rect.width) || canvas.height !== Math.round(rect.height)) {
      canvas.width = Math.round(rect.width);
      canvas.height = Math.round(rect.height);
    }
    // Keyboard activation reports (0,0): spark from the center instead.
    const x = e.clientX === 0 && e.clientY === 0 ? rect.width / 2 : e.clientX - rect.left;
    const y = e.clientX === 0 && e.clientY === 0 ? rect.height / 2 : e.clientY - rect.top;
    const now = performance.now();
    for (let i = 0; i < sparkCount; i++) sparks.current.push({ x, y, angle: (2 * Math.PI * i) / sparkCount, start: now });
    if (!frame.current) frame.current = requestAnimationFrame(draw);
  };

  return (
    <div className={`click-spark ${className}`} onClick={onClick}>
      <canvas ref={canvasRef} className="click-spark-canvas" aria-hidden="true" />
      {children}
    </div>
  );
}
