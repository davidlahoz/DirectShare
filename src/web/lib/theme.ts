/**
 * Light/dark theme. Without a saved choice the page follows the system
 * setting; a manual choice is stored per browser and set as data-theme on <html>.
 */
import { useEffect, useState } from 'react';

export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'directsend-theme';
const darkQuery = () => window.matchMedia('(prefers-color-scheme: dark)');

function storedTheme(): Theme | undefined {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === 'light' || value === 'dark' ? value : undefined;
  } catch {
    return undefined;
  }
}

function effectiveTheme(): Theme {
  return storedTheme() ?? (darkQuery().matches ? 'dark' : 'light');
}

/** Current theme plus a setter that applies and remembers the choice. */
export function useTheme(): [Theme, (theme: Theme) => void] {
  const [theme, setThemeState] = useState<Theme>(effectiveTheme);

  // Keep following the system while the user hasn't chosen.
  useEffect(() => {
    const query = darkQuery();
    const onChange = () => {
      if (!storedTheme()) setThemeState(query.matches ? 'dark' : 'light');
    };
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  const setTheme = (next: Theme) => {
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* not persisted; still applied for this page */
    }
    setThemeState(next);
  };

  return [theme, setTheme];
}
