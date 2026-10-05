# Configuration and deployment

All settings are environment variables. They are documented in [`.env.example`](../.env.example); copy it to `.env`. Invalid values stop the server at startup with a clear message. For example, a `turn:` URL in `STUN_URLS` is refused on purpose.

Browser-facing settings (STUN servers, concurrency, memory-fallback limit, room lifetime, receiver limit, connect timeout) are served at `GET /api/config`. Changing them only requires a restart, not a rebuild.

## Production with Cloudflare Tunnel (recommended)

The host needs no public IP and no open inbound ports. The container listens on `127.0.0.1:8080` only, and `cloudflared` on the host connects out to Cloudflare, which serves HTTPS and WebSockets on your hostname.

```
browser ──HTTPS/WSS──▶ Cloudflare ──tunnel──▶ cloudflared (host) ──▶ 127.0.0.1:8080 ──▶ container
browser ◀════════ WebRTC DataChannel, direct peer-to-peer (never via Cloudflare or the host) ════════▶ browser
```

The tunnel carries only the web app and signaling (a few KB per receiver). File data goes directly between browsers.

1. **Configure and start the app** on the host:
   ```bash
   cp .env.example .env
   # in .env:  ALLOWED_ORIGINS=https://send.example.com
   docker compose up -d --build
   curl -s http://127.0.0.1:8080/healthz        # → ok
   ```
   `docker compose ps` should show `127.0.0.1:8080->8080/tcp`, not `0.0.0.0`.

2. **Create the tunnel** (once) with `cloudflared` installed on the host:
   ```bash
   cloudflared tunnel login
   cloudflared tunnel create directshare
   cloudflared tunnel route dns directshare send.example.com
   ```

3. **Configure cloudflared**: copy [`deploy/cloudflared/config.yml.example`](../deploy/cloudflared/config.yml.example) to `/etc/cloudflared/config.yml`, then fill in the tunnel UUID, credentials file and hostname. The ingress rule points at `http://127.0.0.1:8080`.

4. **Run it as a service**:
   ```bash
   sudo cloudflared service install
   sudo systemctl enable --now cloudflared
   ```
   Or, for a quick test: `cloudflared tunnel run directshare`.

5. **Open** `https://send.example.com`.

Notes:
- **What the tunnel setup relies on:**
  - `TRUST_PROXY=true` (the compose default) is safe only because the port is on loopback. The app then uses `CF-Connecting-IP` for per-visitor rate limits and `X-Forwarded-Proto` to send HSTS.
  - `ALLOWED_ORIGINS` must be your public `https://` URL. Otherwise signaling WebSockets are refused (HTTP 403).
- **Keep in the Cloudflare dashboard:**
  - WebSockets enabled (the default).
  - "Always Use HTTPS" on.
  - Rocket Loader off: the app's Content-Security-Policy blocks injected scripts, so such features do nothing useful.
- **Other behavior:**
  - Cloudflare closes idle WebSockets after about 100 s. The client pings every 25 s, and it reconnects and resumes if a connection drops.
  - You can protect the site with Cloudflare Access if only certain people should send files. Receivers also need access to open links.
  - Cloudflare sees HTTP metadata such as the `/join` path. The room id is in the URL fragment, so browsers never send it to Cloudflare.
  - To change the loopback port, set `HOST_PORT` in `.env` and update the cloudflared ingress `service`.

## Alternative: Docker Compose + Caddy with a public IP (automatic HTTPS)

Requirements: a host with Docker, a DNS name pointing at it, and ports 80 and 443 open.

```bash
cp .env.example .env            # adjust limits if needed
DOMAIN=send.example.com docker compose -f docker-compose.prod.yml up -d --build
```

- Caddy obtains and renews Let's Encrypt certificates and proxies HTTPS and secure WebSockets (`wss://send.example.com/ws`) to the app.
- The compose file sets `TRUST_PROXY=true` and `ALLOWED_ORIGINS=https://$DOMAIN`, so only your site can open signaling connections.
- The app container runs as a non-root user with a read-only filesystem and exposes `GET /healthz`.
- Caddy's access log drops request URIs and headers. The app itself never logs room ids, secrets, SDP, names or file details.

## Other deployment options

- **Your own reverse proxy** (nginx, Traefik, a load balancer): forward `/` and the WebSocket upgrade on `/ws`, set `X-Forwarded-For`/`X-Forwarded-Proto`, then set `TRUST_PROXY=true` and `ALLOWED_ORIGINS`. Proxy idle timeouts must allow WebSockets to stay open (the server pings every 30 s).
- **TLS directly in Node**: set `TLS_CERT_FILE` and `TLS_KEY_FILE`. Mount the files into the container.
- **Without Docker**: `npm ci && npm run build && NODE_ENV=production node dist/server/index.js` (Node ≥ 20).

## Scaling

Room state is in memory in one process. Run **one instance**, or use sticky routing by room. A sender and all of its receivers must reach the same process. Signaling traffic is tiny (a few KB per connection), so one small instance handles many simultaneous shares. File data never passes through it.

## STUN

The defaults are Google's and Cloudflare's public STUN servers. For privacy or reliability you can run your own (for example coturn in STUN-only mode) and set `STUN_URLS=stun:stun.example.com:3478`. STUN servers learn users' public IP addresses. TURN is deliberately unsupported: DirectShare never relays data.

## Local HTTPS for testing across devices

```bash
SITE_ADDRESS=192.168.1.20:8443 docker compose --profile https up --build
```

Caddy issues a certificate from its local CA. Browsers warn until you trust it. To trust it, export `/data/caddy/pki/authorities/local/root.crt` from the `https` container (`docker compose cp https:/data/caddy/pki/authorities/local/root.crt .`) and install it on the test devices.
