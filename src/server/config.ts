import { resolve } from 'node:path';
import { type ClientConfig, DEFAULT_CLIENT_CONFIG, isStunUrl } from '../shared/config';
import { MAX_SIGNALING_MESSAGE_BYTES } from '../shared/signaling';

export interface ServerConfig {
  host: string;
  port: number;
  /** Serve HTTPS/WSS directly when both files are provided. */
  tls?: { certFile: string; keyFile: string };
  /** Exact origins allowed to open signaling WebSockets. Empty = same host only. */
  allowedOrigins: string[];
  /** Honor X-Forwarded-For (only enable behind a trusted reverse proxy). */
  trustProxy: boolean;
  staticDir: string;
  roomTtlMs: number;
  maxRooms: number;
  maxReceiversPerRoom: number;
  /** How long a disconnected sender/receiver may take to reconnect before their seat is released. */
  reconnectGraceMs: number;
  maxMessageBytes: number;
  rateLimit: { burst: number; perSecond: number };
  maxConnectionsPerIp: number;
  roomCreationsPerMinutePerIp: number;
  joinsPerMinutePerIp: number;
  /** Expose aggregate counters on GET /api/stats (for automated verification). */
  statsEnabled: boolean;
  client: ClientConfig;
}

export class ConfigError extends Error {}

type Env = Record<string, string | undefined>;

function int(env: Env, key: string, fallback: number, min: number, max: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ConfigError(`${key} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function bool(env: Env, key: string, fallback: boolean): boolean {
  const raw = env[key]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  throw new ConfigError(`${key} must be true or false`);
}

function list(env: Env, key: string): string[] | undefined {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return undefined;
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export function loadConfig(env: Env = process.env): ServerConfig {
  const stunUrls = list(env, 'STUN_URLS') ?? DEFAULT_CLIENT_CONFIG.stunUrls;
  for (const url of stunUrls) {
    if (/^turns?:/i.test(url)) {
      throw new ConfigError('TURN relays are not supported: DirectShare only uses direct peer-to-peer connections');
    }
    if (!isStunUrl(url)) throw new ConfigError(`Invalid STUN URL: ${url}`);
  }

  const certFile = env.TLS_CERT_FILE?.trim();
  const keyFile = env.TLS_KEY_FILE?.trim();
  if (Boolean(certFile) !== Boolean(keyFile)) {
    throw new ConfigError('TLS_CERT_FILE and TLS_KEY_FILE must be set together');
  }

  const allowedOrigins = (list(env, 'ALLOWED_ORIGINS') ?? []).map((origin) => {
    try {
      return new URL(origin).origin;
    } catch {
      throw new ConfigError(`Invalid origin in ALLOWED_ORIGINS: ${origin}`);
    }
  });

  const roomTtlSeconds = int(env, 'ROOM_TTL_SECONDS', DEFAULT_CLIENT_CONFIG.roomTtlSeconds, 60, 7 * 24 * 3600);
  const maxReceiversPerRoom = int(env, 'MAX_RECEIVERS_PER_ROOM', DEFAULT_CLIENT_CONFIG.maxReceiversPerRoom, 1, 100);

  return {
    host: env.HOST?.trim() || '0.0.0.0',
    port: int(env, 'PORT', 8080, 1, 65535),
    tls: certFile && keyFile ? { certFile, keyFile } : undefined,
    allowedOrigins,
    trustProxy: bool(env, 'TRUST_PROXY', false),
    staticDir: resolve(env.STATIC_DIR?.trim() || 'dist/web'),
    roomTtlMs: roomTtlSeconds * 1000,
    maxRooms: int(env, 'MAX_ROOMS', 1000, 1, 1_000_000),
    maxReceiversPerRoom,
    reconnectGraceMs: int(env, 'RECONNECT_GRACE_SECONDS', 30, 0, 600) * 1000,
    maxMessageBytes: int(env, 'MAX_SIGNALING_MESSAGE_BYTES', MAX_SIGNALING_MESSAGE_BYTES, 4096, 1024 * 1024),
    rateLimit: {
      burst: int(env, 'RATE_LIMIT_BURST', 200, 10, 100_000),
      perSecond: int(env, 'RATE_LIMIT_PER_SECOND', 30, 1, 10_000),
    },
    maxConnectionsPerIp: int(env, 'MAX_CONNECTIONS_PER_IP', 50, 1, 100_000),
    roomCreationsPerMinutePerIp: int(env, 'ROOM_CREATIONS_PER_MINUTE_PER_IP', 20, 1, 100_000),
    joinsPerMinutePerIp: int(env, 'JOINS_PER_MINUTE_PER_IP', 60, 1, 100_000),
    statsEnabled: bool(env, 'STATS_ENABLED', false),
    client: {
      stunUrls,
      maxConcurrentTransfers: int(
        env,
        'MAX_CONCURRENT_TRANSFERS',
        DEFAULT_CLIENT_CONFIG.maxConcurrentTransfers,
        1,
        maxReceiversPerRoom,
      ),
      memoryFallbackMaxBytes:
        int(env, 'MEMORY_FALLBACK_MAX_MB', DEFAULT_CLIENT_CONFIG.memoryFallbackMaxBytes / (1024 * 1024), 1, 4096) *
        1024 *
        1024,
      roomTtlSeconds,
      maxReceiversPerRoom,
      connectTimeoutSeconds: int(env, 'CONNECT_TIMEOUT_SECONDS', DEFAULT_CLIENT_CONFIG.connectTimeoutSeconds, 5, 300),
    },
  };
}
