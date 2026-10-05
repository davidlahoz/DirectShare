import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './ui/App';
import { loadClientConfig } from './config';
// Self-hosted (CSP allows only same-origin fonts): the RazorLabs type system.
import '@fontsource-variable/bricolage-grotesque';
import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import './ui/styles.css';

const root = createRoot(document.getElementById('root')!);
void loadClientConfig().then((config) => {
  root.render(
    <StrictMode>
      <App config={config} />
    </StrictMode>,
  );
});
