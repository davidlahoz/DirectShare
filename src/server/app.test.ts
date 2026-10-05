import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { SIGNALING_SUBPROTOCOL, type ServerMessage } from '../shared/signaling';
import { clientIp, type RunningServer, startServer } from './app';
import { ConfigError, loadConfig } from './config';
import { silentLogger } from './log';

let server: RunningServer;
let base: string;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'directshare-'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>DirectShare</title>');
  const config = loadConfig({ PORT: '1', HOST: '127.0.0.1', STATIC_DIR: dir, STATS_ENABLED: 'true', MAX_RECEIVERS_PER_ROOM: '3' });
  server = await startServer({ ...config, port: 0 }, silentLogger);
  base = `127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await server.close();
});

function connect(origin = `http://${base}`, protocol = SIGNALING_SUBPROTOCOL): Promise<Client> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${base}/ws`, protocol, { headers: { Origin: origin } });
    const client = new Client(ws);
    ws.once('open', () => resolve(client));
    ws.once('error', reject);
    ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
  });
}

class Client {
  readonly inbox: ServerMessage[] = [];
  private waiters: Array<() => void> = [];
  constructor(readonly ws: WebSocket) {
    ws.on('message', (data) => {
      this.inbox.push(JSON.parse(String(data)) as ServerMessage);
      for (const w of this.waiters.splice(0)) w();
    });
  }
  send(msg: object) {
    this.ws.send(JSON.stringify(msg));
  }
  async next<T extends ServerMessage['type']>(type: T, timeoutMs = 3000): Promise<Extract<ServerMessage, { type: T }>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const i = this.inbox.findIndex((m) => m.type === type);
      if (i >= 0) return this.inbox.splice(i, 1)[0] as Extract<ServerMessage, { type: T }>;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${type}`);
      await new Promise<void>((r) => {
        this.waiters.push(r);
        setTimeout(r, 50);
      });
    }
  }
  close() {
    this.ws.close();
  }
}

describe('HTTP server', () => {
  it('serves client configuration without secrets', async () => {
    const res = await fetch(`http://${base}/api/config`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(
      ['connectTimeoutSeconds', 'maxConcurrentTransfers', 'maxReceiversPerRoom', 'memoryFallbackMaxBytes', 'roomTtlSeconds', 'stunUrls'].sort(),
    );
    expect((body.stunUrls as string[]).every((u) => u.startsWith('stun'))).toBe(true);
  });

  it('sends security headers and serves the SPA for /join', async () => {
    const res = await fetch(`http://${base}/join`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
  });

  it('has no way to upload anything', async () => {
    for (const path of ['/', '/api/config', '/upload', '/ws']) {
      const res = await fetch(`http://${base}${path}`, { method: 'POST', body: 'x'.repeat(1000) });
      expect(res.status).toBe(405);
    }
    const put = await fetch(`http://${base}/file.bin`, { method: 'PUT', body: 'data' });
    expect(put.status).toBe(405);
  });

  it('does not serve files outside the static directory', async () => {
    const res = await fetch(`http://${base}/..%2f..%2fetc%2fpasswd.txt`);
    expect(res.status).toBe(404);
  });
});

describe('WebSocket signaling server', () => {
  it('rejects cross-origin connections and missing subprotocols', async () => {
    await expect(connect('https://evil.example')).rejects.toThrow('403');
    await expect(connect(`http://${base}`, 'something-else')).rejects.toThrow();
  });

  it('pairs a sender with multiple receivers and relays only to the intended peer', async () => {
    const sender = await connect();
    sender.send({ type: 'create-room' });
    const created = await sender.next('room-created');

    const a = await connect();
    const b = await connect();
    a.send({ type: 'join', roomId: created.roomId, displayName: 'Alpha' });
    b.send({ type: 'join', roomId: created.roomId });
    const joinedA = await a.next('joined');
    const joinedB = await b.next('joined');
    expect(joinedB.label).toBe('Receiver 2');
    await sender.next('receiver-joined');
    await sender.next('receiver-joined');

    sender.send({ type: 'approve', sessionId: joinedA.sessionId });
    await a.next('approved');
    sender.send({ type: 'signal', to: joinedA.sessionId, data: { kind: 'offer', cid: 'conn-0001', sdp: 'v=0' } });
    expect((await a.next('signal')).data.kind).toBe('offer');

    a.send({ type: 'signal', to: joinedB.sessionId, data: { kind: 'answer', cid: 'conn-0001', sdp: 'v=0' } });
    const relayed = await sender.next('signal');
    expect(relayed.from).toBe(joinedA.sessionId);
    await new Promise((r) => setTimeout(r, 100));
    expect(b.inbox.filter((m) => m.type === 'signal')).toHaveLength(0);

    // Stop sharing: everyone is told and new joins are refused.
    sender.send({ type: 'close-room' });
    expect((await a.next('room-closed')).reason).toBe('stopped');
    expect((await b.next('room-closed')).reason).toBe('stopped');
    const late = await connect();
    late.send({ type: 'join', roomId: created.roomId });
    expect((await late.next('error')).code).toBe('room-unavailable');
    for (const c of [sender, a, b, late]) c.close();
  });

  it('enforces the configured receiver limit', async () => {
    const sender = await connect();
    sender.send({ type: 'create-room' });
    const { roomId } = await sender.next('room-created');
    const clients = [];
    for (let i = 0; i < 3; i++) {
      const c = await connect();
      c.send({ type: 'join', roomId });
      await c.next('joined');
      clients.push(c);
    }
    const extra = await connect();
    extra.send({ type: 'join', roomId });
    expect((await extra.next('error')).code).toBe('room-full');
    for (const c of [sender, extra, ...clients]) c.close();
  });

  it('closes connections that send oversize frames', async () => {
    const c = await connect();
    const closed = new Promise<number>((resolve) => c.ws.once('close', (code) => resolve(code)));
    c.ws.send('x'.repeat(200 * 1024));
    expect(await closed).toBe(1009);
  });

  it('exposes aggregate stats when enabled', async () => {
    const res = await fetch(`http://${base}/api/stats`);
    const stats = (await res.json()) as Record<string, number>;
    expect(stats.bytesIn).toBeGreaterThan(0);
    expect(stats.messagesRelayed).toBeGreaterThan(0);
  });
});

describe('configuration', () => {
  it('refuses TURN servers', () => {
    expect(() => loadConfig({ STUN_URLS: 'turn:relay.example.com:3478' })).toThrow(ConfigError);
  });

  it('validates numbers and TLS settings', () => {
    expect(() => loadConfig({ ROOM_TTL_SECONDS: 'soon' })).toThrow(ConfigError);
    expect(() => loadConfig({ MAX_RECEIVERS_PER_ROOM: '0' })).toThrow(ConfigError);
    expect(() => loadConfig({ TLS_CERT_FILE: '/cert.pem' })).toThrow(ConfigError);
  });

  it('applies overrides', () => {
    const cfg = loadConfig({
      STUN_URLS: 'stun:a.example:3478, stun:b.example:3478',
      ROOM_TTL_SECONDS: '600',
      MAX_RECEIVERS_PER_ROOM: '4',
      MAX_CONCURRENT_TRANSFERS: '2',
      MEMORY_FALLBACK_MAX_MB: '64',
    });
    expect(cfg.client).toMatchObject({
      stunUrls: ['stun:a.example:3478', 'stun:b.example:3478'],
      roomTtlSeconds: 600,
      maxReceiversPerRoom: 4,
      maxConcurrentTransfers: 2,
      memoryFallbackMaxBytes: 64 * 1024 * 1024,
    });
  });
});

describe('client IP behind a proxy', () => {
  const req = (headers: Record<string, string>) =>
    ({ headers, socket: { remoteAddress: '127.0.0.1' } }) as unknown as Parameters<typeof clientIp>[0];

  it('uses CF-Connecting-IP from Cloudflare Tunnel when the proxy is trusted', () => {
    expect(clientIp(req({ 'cf-connecting-ip': '203.0.113.7', 'x-forwarded-for': '198.51.100.1' }), true)).toBe('203.0.113.7');
    expect(clientIp(req({ 'x-forwarded-for': '198.51.100.1, 10.0.0.1' }), true)).toBe('198.51.100.1');
  });

  it('ignores forwarded headers when the proxy is not trusted', () => {
    expect(clientIp(req({ 'cf-connecting-ip': '203.0.113.7' }), false)).toBe('127.0.0.1');
  });
});
