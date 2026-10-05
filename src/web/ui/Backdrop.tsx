import { createPortal } from 'react-dom';
import { usePrefersReducedMotion } from '../lib/motion';
import Aurora from './reactbits/Aurora';

const STOPS: [string, string, string] = ['#0f6b50', '#3fd39a', '#2b6fd8'];

/**
 * Animated aurora behind the page header. `calm` pauses it (e.g. while files
 * are transferring) so it never competes with the transfer for CPU/GPU.
 */
export function Backdrop({ calm = false }: { calm?: boolean }) {
  const reduced = usePrefersReducedMotion();
  // Portaled to <body> so it sits behind the header and page content.
  return createPortal(
    <div className="backdrop" aria-hidden="true">
      <Aurora
        colorStops={STOPS}
        amplitude={1.1}
        blend={0.6}
        speed={0.6}
        active={!calm}
        still={reduced}
      />
    </div>,
    document.body,
  );
}
