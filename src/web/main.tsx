import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './ui/App';
import { loadClientConfig } from './config';
import './ui/styles.css';

const root = createRoot(document.getElementById('root')!);
void loadClientConfig().then((config) => {
  root.render(
    <StrictMode>
      <App config={config} />
    </StrictMode>,
  );
});
