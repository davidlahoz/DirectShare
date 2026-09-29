# Architecture

```
 Sender browser                         Node.js server                    Receiver browsers
 ┌───────────────────────┐   WSS    ┌────────────────────────┐   WSS   ┌───────────────────────┐
 │ SenderSession         │◀────────▶│ SignalingService        │◀───────▶│ ReceiverSession        │
 │  ├ SignalingClient    │ signaling│  ├ RoomManager          │signaling│  ├ SignalingClient     │
 │  ├ scheduler (queue)  │  only    │  ├ rate limits          │  only   │  ├ PeerLink (answerer) │
 │  ├ PeerLink × N ──────┼──────────┼────────────────────────┼─────────┼─▶├ FileReceiver         │
 │  ├ FileSender × N     │  WebRTC DataChannel (DTLS), direct peer-to-peer, one per receiver   │
 │  └ downloadHistory    │          │ static files, /api/config│        │  └ sinks (disk/memory) │
 └───────────────────────┘          └────────────────────────┘         └───────────────────────┘
```

The server never receives file names, sizes or contents. Those are exchanged only over the DataChannel. The server sees room membership, display names the receivers choose, and WebRTC session descriptions and ICE candidates. The latter contain network addresses.

## Modules

| Concern | Module |
| --- | --- |
| Room creation and peer pairing | `src/server/rooms.ts` |
| WebSocket signaling (server) | `src/server/signaling.ts`, `src/server/app.ts`, `src/shared/signaling.ts` |
| WebSocket signaling (client) | `src/web/signaling/SignalingClient.ts` |
| WebRTC connection management | `src/web/webrtc/PeerLink.ts` |
| File transfer protocol | `src/shared/transfer.ts` |
| File transfer and flow control | `src/web/transfer/FileSender.ts`, `FileReceiver.ts`, `channel.ts` |
| Receiver storage and downloads | `src/web/storage/sinks.ts`, `capabilities.ts` |
| Sender download history | `src/web/history/downloadHistory.ts` |
| Transfer queue | `src/web/session/scheduler.ts` |
| Orchestration and UI state | `src/web/session/SenderSession.ts`, `ReceiverSession.ts`, `src/web/lib/store.ts` |
| User interface | `src/web/ui/*` |
| Configuration | `src/server/config.ts`, `src/shared/config.ts`, `.env.example` |

## Signaling protocol

JSON text frames over a WebSocket at `/ws`, subprotocol `directsend.v1`. Every message is validated with Zod (`src/shared/signaling.ts`); unknown fields are rejected.

- **Room id**: 128 random bits (base64url). It is placed in the URL *fragment* (`/join#<id>`), which browsers never send to servers or put in `Referer`.
- **Sender secret**: 256 random bits, returned only to the creating connection. The server stores only its SHA-256 hash and compares it in constant time. It is required to resume control after a reconnect.
- **Receiver session**: each receiver gets a random session id, a session secret for reconnecting, and an anonymous label (“Receiver N”). An optional display name is sanitized and limited to 40 characters.
- **Routing**: sender signals must name a receiver in the same room that the sender has approved. Receiver signals always go to that room's sender; their `to` field is ignored. Each role may originate only certain signal kinds: `offer`/`queued` come only from the sender, `answer`/`retry-request` only from receivers.
- **Limits**: max frame size (`ws` `maxPayload`, default 64 KB), per-connection token bucket, per-IP connection cap, per-IP room-creation and join rate limits, max rooms, max receivers per room. Binary frames close the connection.
- **Lifecycle**: rooms expire after `ROOM_TTL_SECONDS`. If a sender or receiver disconnects, they have `RECONNECT_GRACE_SECONDS` to resume before the room closes (sender) or their seat is released (receiver). `close-room` invalidates the room at once. Closed room ids are remembered for a while, so late visitors get a precise message.

## WebRTC

`PeerLink` wraps one `RTCPeerConnection` per receiver. It uses trickle ICE with STUN servers from `STUN_URLS` and never configures TURN. The sender creates one reliable, ordered DataChannel (`directsend-v1`). Remote candidates that arrive before the remote description are buffered. Each connection attempt has its own id (`cid`), so late signals from an abandoned attempt are ignored. If no DataChannel opens within `CONNECT_TIMEOUT_SECONDS`, or ICE fails, the user sees an explanation and is advised to try another network. After connecting, `getStats()` reports whether ICE chose a local-network path. This is shown for information only and is not guaranteed.

## Transfer protocol v1

This runs over the DataChannel. Control messages are JSON with `v: 1` and are validated strictly. File data uses binary frames with a 24-byte header (see the diagram in `src/shared/transfer.ts`).

| Message | Direction | Purpose |
| --- | --- | --- |
| `offer` | S→R | transfer id, per-connection transfer number, chunk size, flow window, file metadata (id, index, name, size, type) |
| `accept` / `reject` | R→S | explicit decision; `accept` states the storage mode (`stream` or `memory`) |
| `file-start` / `file-end` | S→R | boundaries of each file; `file-end` states the byte and chunk counts |
| binary chunk | S→R | `transferNo`, `fileIndex`, `seq`, `offset`, payload |
| `ack` | R→S | bytes **written** so far; drives the flow-control window |
| `file-complete` | R→S | sent only after counts matched, all writes finished and the file was closed; `saved: confirmed` or `unconfirmed` |
| `cancel` | both | the user canceled, the sender stopped sharing, or the page was closed |
| `error` | both | protocol, integrity, flow-control, read or write failures |

The receiver checks every frame: transfer number, file index, `seq == expected`, `offset == bytes received`, payload size no larger than the chunk size, never more than the announced file size, and queued bytes within the window. Any violation stops the transfer and removes the partial file.

**Chunking**: the chunk size is `min(64 KB, sctp.maxMessageSize − 24)`, falling back to 16 KB when the browser does not report a size.

**Memory bounds**:
- The sender reads each file in 1 MB blocks via `Blob.slice().arrayBuffer()`.
- The sender pauses when `bufferedAmount` exceeds 1 MB and resumes on `bufferedamountlow` (256 KB threshold). A 250 ms poll is a safety net.
- At most `windowBytes` (8 MB) may be unacknowledged, so the receiver's storage speed throttles the sender.
- The receiver writes sequentially and acknowledges at least every `min(1 MB, (window − chunk)/2)`.
- The receiver-side queue can never exceed the window plus one chunk.

**Ordering**: files are sent one at a time. The next file starts only after the previous file's `file-complete`.

**Concurrency**: each approved receiver has its own connection and `FileSender`. At most `MAX_CONCURRENT_TRANSFERS` are connecting or transferring at once. The others are queued in approval order and told their position.

**Retries**: a retry creates a new connection, a new `transferId` and a new transfer number. It offers only the files not yet delivered to that receiver and restarts each of them from byte 0.

## Receiver storage

| Mode | When | Confirms save? |
| --- | --- | --- |
| Save to a folder (`showDirectoryPicker`) | Chromium desktop, secure context | Yes: `FileSystemWritableFileStream.close()` resolved |
| Save as… (`showSaveFilePicker`) | same, single-file offers | Yes |
| Browser download (memory) | everywhere, if the total is ≤ `MEMORY_FALLBACK_MAX_MB` | **No**: shown as “Delivered to browser — save unconfirmed” |

File names are sanitized: no path separators, control or bidi characters, reserved Windows names, or leading dots, and length is limited. Existing files are never overwritten (`name (1).ext`). In Chromium, writable streams write to a swap file that replaces the target only on `close()`. On cancel or failure the stream is aborted and the created entry removed. Object URLs from the memory fallback are revoked 60 s after the download starts, and buffers are released as soon as each file's Blob is built.

## Download history

Records are keyed by (receiver session, file id). There are three kinds, which are never mixed:

- `confirmed`: from `file-complete` with `saved: confirmed` and a matching byte count.
- `save-unconfirmed`: memory-fallback deliveries.
- `unconfirmed`: every byte was sent, but the connection dropped before `file-complete` arrived.

Recording is idempotent: repeated acknowledgements return the same state. A later confirmation upgrades an earlier unconfirmed record, and nothing downgrades a confirmed one. The sender's history lives only in the tab's memory. It survives Stop sharing and is lost when the page is reloaded or closed.
