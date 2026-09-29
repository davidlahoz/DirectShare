/**
 * HTTP handler: serves the built frontend, runtime client configuration and a
 * health check. There is deliberately no upload endpoint of any kind.
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import type { ServerConfig } from './config';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};

export function securityHeaders(secure: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Security-Policy': [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' data: blob:",
      "connect-src 'self' ws: wss:",
      "font-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
      "form-action 'none'",
    ].join('; '),
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  };
  if (secure) headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
  return headers;
}

export interface HttpDeps {
  config: ServerConfig;
  stats?: () => object;
}

export function createHttpHandler({ config, stats }: HttpDeps) {
  const root = normalize(config.staticDir + sep);
  const clientConfigBody = JSON.stringify(config.client);

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const secure = Boolean(config.tls) || (config.trustProxy && req.headers['x-forwarded-proto'] === 'https');
    for (const [name, value] of Object.entries(securityHeaders(secure))) res.setHeader(name, value);

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain' }).end('Method not allowed');
      return;
    }

    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
    } catch {
      res.writeHead(400).end();
      return;
    }

    if (pathname === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }).end('ok');
      return;
    }
    if (pathname === '/api/config') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(clientConfigBody);
      return;
    }
    if (pathname === '/api/stats' && config.statsEnabled && stats) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(stats()));
      return;
    }

    // Static files, with SPA fallback to index.html for extension-less paths.
    const candidate = normalize(join(root, pathname));
    if (!candidate.startsWith(root) && candidate + sep !== root) {
      res.writeHead(404).end();
      return;
    }
    const hasExtension = extname(pathname) !== '';
    const file = await findFile(candidate, hasExtension ? undefined : join(root, 'index.html'));
    if (!file) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
      return;
    }
    const type = CONTENT_TYPES[extname(file.path)] ?? 'application/octet-stream';
    const immutable = file.path.includes(`${sep}assets${sep}`);
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': file.size,
      'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    createReadStream(file.path)
      .on('error', () => res.destroy())
      .pipe(res);
  };
}

async function findFile(path: string, fallback?: string): Promise<{ path: string; size: number } | undefined> {
  for (const p of fallback ? [path, fallback] : [path]) {
    try {
      const s = await stat(p);
      if (s.isFile()) return { path: p, size: s.size };
    } catch {
      // try next
    }
  }
  return undefined;
}
