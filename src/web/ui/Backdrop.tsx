import { createPortal } from 'react-dom';

/**
 * Static brand-blue glow behind the page header, over the grid-paper body
 * background shared with razorlabs.dev. `calm` is kept for callers; there is
 * no animation to pause any more.
 */
export function Backdrop(_props: { calm?: boolean }) {
  // Portaled to <body> so it sits behind the header and page content.
  return createPortal(<div className="backdrop" aria-hidden="true" />, document.body);
}
