/** Runtime settings the server hands to browsers via GET /api/config. */
export interface ClientConfig {
  /** STUN server URLs. TURN relays are intentionally unsupported. */
  stunUrls: string[];
  /** How many receivers may connect/transfer at the same time per room. */
  maxConcurrentTransfers: number;
  /** Largest total transfer allowed for the in-memory download fallback. */
  memoryFallbackMaxBytes: number;
  /** Room lifetime, for display. */
  roomTtlSeconds: number;
  /** Maximum receivers that may join one room. */
  maxReceiversPerRoom: number;
  /** How long to wait for a direct connection before giving up. */
  connectTimeoutSeconds: number;
}

export const DEFAULT_CLIENT_CONFIG: ClientConfig = {
  stunUrls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'],
  maxConcurrentTransfers: 3,
  memoryFallbackMaxBytes: 256 * 1024 * 1024,
  roomTtlSeconds: 2 * 60 * 60,
  maxReceiversPerRoom: 10,
  connectTimeoutSeconds: 30,
};

/** STUN only: `stun:` and `stuns:` URLs are accepted; `turn:`/`turns:` are refused. */
export function isStunUrl(url: string): boolean {
  return /^stuns?:[A-Za-z0-9.\-[\]:]+(\?transport=(udp|tcp))?$/.test(url);
}
