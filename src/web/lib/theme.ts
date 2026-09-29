/**
 * Light/dark theme. Without a saved choice the page follows the system
 * setting; a manual choice is stored per browser and set as data-theme on <html>.
 * Shared as a tiny external store so every component sees the same theme.
 */
import { useSyncExternalStore } from 'react';

export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'directsend-theme';
const listeners = new Set<() => void>();

function storedTheme(): Theme | undefined {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === 'light' || value === 'dark' ? value : undefined;
  } catch {
    return undefined;
  }
}

function currentTheme(): Theme {
  return storedTheme() ?? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const query = window.matchMedia('(prefers-color-scheme: dark)');
  query.addEventListener('change', listener);
  return () => {
    listeners.delete(listener);
    query.removeEventListener('change', listener);
  };
}

export function setTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    /* not persisted; still applied for this page */
  }
  for (const listener of listeners) listener();
}

/** Current theme plus a setter that applies and remembers the choice. */
export function useTheme(): [Theme, (theme: Theme) => void] {
  const theme = useSyncExternalStore(subscribe, currentTheme);
  return [theme, setTheme];
}
