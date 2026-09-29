# DirectSend

Send files directly from one browser to others over WebRTC. Files travel peer-to-peer on encrypted DataChannels. They are **never uploaded to or stored on the application server**. The Node.js server only coordinates connections (WebSocket signaling) and serves the web app.

- One sender, many independent receivers, each with its own peer-to-peer connection
- The sender approves each receiver; each receiver explicitly accepts and picks where to save
- Streams directly to disk where the browser supports it (File System Access API), with a size-limited in-memory fallback elsewhere
- A **Successful downloads** history that only records files the receiver confirmed were fully received, checked and saved
- STUN only, never TURN: if a direct connection is impossible, users are told why and what to try

TypeScript throughout: React (Vite) frontend, Node.js + `ws` signaling server, Zod-validated protocols.

## Quick start (Docker)

```bash
docker compose up --build          # http://127.0.0.1:8080 (host loopback only)
```

The container is published on `127.0.0.1` only: it is never exposed on a LAN or public IP. To put it on the internet, run `cloudflared` on the host and point a Cloudflare Tunnel at `http://127.0.0.1:8080`. See [Cloudflare Tunnel](docs/DEPLOYMENT.md#production-with-cloudflare-tunnel-recommended).

The image build type-checks the code and runs the automated test suite before it produces the runtime image.

Open `http://localhost:8080`, pick files, create a link, and open the link in another browser window or profile.

To test with another device on your network you need HTTPS, because browsers only enable direct-to-disk saving and the clipboard in secure contexts:

```bash
SITE_ADDRESS=192.168.1.20:8443 docker compose --profile https up --build
# then open https://192.168.1.20:8443 on both devices (accept or trust Caddy's local certificate)
```

## Tests

```bash
docker compose run --rm test                     # type-check + 124 unit/integration tests
docker compose -f docker-compose.e2e.yml up --build --abort-on-container-exit --exit-code-from e2e
                                                 # 6 real-browser end-to-end tests (headless Chromium)
```

Without Docker, use Node ≥ 20: `npm ci && npm run check`.

| Suite | What it covers |
| --- | --- |
| `src/shared/protocol.test.ts` | Transfer and signaling message validation, binary framing, chunk sizing, sanitizers |
| `src/server/rooms.test.ts` | Room ids and secrets, receiver limits, expiry, reconnect grace, cleanup |
| `src/server/signaling.test.ts` | Signaling isolation between receivers and rooms, role permissions, rate and size limits, lifecycle |
| `src/server/app.test.ts` | Real HTTP/WebSocket server: origin checks, no upload paths, routing, receiver limits |
| `src/web/transfer/transfer.test.ts` | Transfer sequencing, integrity checks, backpressure, flow-control window, cancellation, write failures, failure isolation, duplicate acknowledgements, 64 MB bounded-memory run |
| `src/web/history/downloadHistory.test.ts` | History deduplication, confirmed vs. unconfirmed separation, per-receiver grouping |
| `src/web/session/scheduler.test.ts` | Concurrency limit and visible queueing |
| `e2e/tests/transfer.spec.ts` | Real Chromium and WebRTC: multiple receivers, memory fallback vs. streaming, failure isolation, approve/reject/retry/cancel/stop, unsupported-storage rejection, queueing, 1 GB bounded-memory transfer, server-byte accounting |

## Documentation

- [Architecture and protocols](docs/ARCHITECTURE.md)
- [Configuration and deployment](docs/DEPLOYMENT.md)
- [Manual verification checklist](docs/MANUAL_TEST_CHECKLIST.md)
- [Security, privacy and known limitations](docs/LIMITATIONS.md)

## Local development without Docker

```bash
npm ci
npm run dev:server        # signaling + API on :8080 (tsx watch)
npm run dev:web           # Vite on :5173, proxies /ws and /api to :8080
```

## License

MIT
