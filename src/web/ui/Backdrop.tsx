import { createPortal } from 'react-dom';
import { usePrefersReducedMotion } from '../lib/motion';
import { useTheme } from '../lib/theme';
import Aurora from './reactbits/Aurora';

const STOPS = {
  dark: ['#0f6b50', '#3fd39a', '#2b6fd8'],
  light: ['#8fe0bf', '#c9f0de', '#a9c9f5'],
} as const;

/**
 * Animated aurora behind the page header. `calm` pauses it (e.g. while files
 * are transferring) so it never competes with the transfer for CPU/GPU.
 */
export function Backdrop({ calm = false }: { calm?: boolean }) {
  const [theme] = useTheme();
  const reduced = usePrefersReducedMotion();
  // Portaled to <body> so it sits behind the header and page content.
  return createPortal(
    <div className={`backdrop backdrop-${theme}`} aria-hidden="true">
      <Aurora
        colorStops={[...STOPS[theme]] as [string, string, string]}
        lightMode={theme === 'light'}
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
