import { readFileSync } from 'node:fs';
import { createServer as createHttpServer, type IncomingMessage, type Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import { SIGNALING_PATH, SIGNALING_SUBPROTOCOL, type ServerMessage } from '../shared/signaling';
import type { ServerConfig } from './config';
import { createHttpHandler } from './http';
import type { Logger } from './log';
import { RoomManager } from './rooms';
import { type Connection, SignalingService } from './signaling';

const SWEEP_INTERVAL_MS = 5_000;
const HEARTBEAT_INTERVAL_MS = 30_000;

export interface RunningServer {
  server: Server;
  signaling: SignalingService;
  port: number;
  close(): Promise<void>;
}

export function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    // Cloudflare (including Cloudflare Tunnel) sends the visitor's address here.
    const cf = req.headers['cf-connecting-ip'];
    const cfIp = (Array.isArray(cf) ? cf[0] : cf)?.trim();
    if (cfIp) return cfIp;
    const forwarded = req.headers['x-forwarded-for'];
    const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.socket.remoteAddress ?? 'unknown';
}

function originAllowed(req: IncomingMessage, config: ServerConfig): boolean {
  const origin = req.headers.origin;
  if (!origin) return false;
  if (config.allowedOrigins.length > 0) return config.allowedOrigins.includes(origin);
  // Default: same host as the page that was served.
  try {
    const host = req.headers['x-forwarded-host'] && config.trustProxy ? String(req.headers['x-forwarded-host']) : req.headers.host;
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function reject(socket: Duplex, status: number, text: string): void {
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

export function startServer(config: ServerConfig, log: Logger): Promise<RunningServer> {
  const rooms = new RoomManager({
    ttlMs: config.roomTtlMs,
    maxRooms: config.maxRooms,
    maxReceiversPerRoom: config.maxReceiversPerRoom,
    reconnectGraceMs: config.reconnectGraceMs,
  });
  const signaling = new SignalingService(rooms, config, log);
  const handler = createHttpHandler({ config, stats: () => signaling.stats() });
  const onRequest = (req: IncomingMessage, res: import('node:http').ServerResponse) => {
    handler(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  };

  const server: Server = config.tls
    ? createHttpsServer({ cert: readFileSync(config.tls.certFile), key: readFileSync(config.tls.keyFile) }, onRequest)
    : createHttpServer(onRequest);

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: config.maxMessageBytes,
    perMessageDeflate: false,
    handleProtocols: (protocols) => (protocols.has(SIGNALING_SUBPROTOCOL) ? SIGNALING_SUBPROTOCOL : false),
  });
  const connectionsPerIp = new Map<string, number>();

  server.on('upgrade', (req, socket, head) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (path !== SIGNALING_PATH) return reject(socket, 404, 'Not Found');
    if (!originAllowed(req, config)) return reject(socket, 403, 'Forbidden');
    const protocols = String(req.headers['sec-websocket-protocol'] ?? '').split(',').map((p) => p.trim());
    if (!protocols.includes(SIGNALING_SUBPROTOCOL)) return reject(socket, 426, 'Upgrade Required');
    const ip = clientIp(req, config.trustProxy);
    const count = connectionsPerIp.get(ip) ?? 0;
    if (count >= config.maxConnectionsPerIp) return reject(socket, 429, 'Too Many Requests');
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req, ip));
  });

  wss.on('connection', (ws: WebSocket & { isAlive?: boolean }, _req: IncomingMessage, ip: string) => {
    connectionsPerIp.set(ip, (connectionsPerIp.get(ip) ?? 0) + 1);
    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });
    const conn: Connection = {
      ip,
      send(message: ServerMessage) {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
      },
      close(code: number, reason: string) {
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close(code, reason);
      },
    };
    signaling.connect(conn);
    ws.on('message', (data, isBinary) => {
      const raw = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
      signaling.message(conn, raw, isBinary);
    });
    ws.on('close', () => {
      signaling.disconnect(conn);
      const remaining = (connectionsPerIp.get(ip) ?? 1) - 1;
      if (remaining <= 0) connectionsPerIp.delete(ip);
      else connectionsPerIp.set(ip, remaining);
    });
    ws.on('error', () => ws.terminate());
  });

  const sweepTimer = setInterval(() => signaling.sweep(), SWEEP_INTERVAL_MS);
  const heartbeatTimer = setInterval(() => {
    for (const client of wss.clients as Set<WebSocket & { isAlive?: boolean }>) {
      if (client.isAlive === false) {
        client.terminate();
        continue;
      }
      client.isAlive = false;
      client.ping();
    }
  }, HEARTBEAT_INTERVAL_MS);
  sweepTimer.unref();
  heartbeatTimer.unref();

  return new Promise((resolve) => {
    server.listen(config.port, config.host, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : config.port;
      log.info('server_listening', { port, tls: Boolean(config.tls), stun: config.client.stunUrls.length });
      resolve({
        server,
        signaling,
        port,
        close: () =>
          new Promise<void>((done) => {
            clearInterval(sweepTimer);
            clearInterval(heartbeatTimer);
            signaling.shutdown();
            for (const client of wss.clients) client.terminate();
            wss.close();
            server.close(() => done());
            server.closeAllConnections?.();
          }),
      });
    });
  });
}
