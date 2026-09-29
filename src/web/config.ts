import { type ClientConfig, DEFAULT_CLIENT_CONFIG } from '../shared/config';

/** Loads deployment settings from the server; falls back to defaults if unavailable. */
export async function loadClientConfig(): Promise<ClientConfig> {
  try {
    const res = await fetch('/api/config', { cache: 'no-store' });
    if (!res.ok) return DEFAULT_CLIENT_CONFIG;
    const data = (await res.json()) as Partial<ClientConfig>;
    return {
      ...DEFAULT_CLIENT_CONFIG,
      ...data,
      stunUrls: Array.isArray(data.stunUrls) ? data.stunUrls.filter((u) => typeof u === 'string') : DEFAULT_CLIENT_CONFIG.stunUrls,
    };
  } catch {
    return DEFAULT_CLIENT_CONFIG;
  }
}
