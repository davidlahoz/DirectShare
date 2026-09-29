# Security, privacy and known limitations

## What the security model provides

- **Transport encryption**: WebRTC DataChannels are always encrypted with DTLS. Signaling uses WSS in production.
- **No server copies**: the server has no endpoint that accepts file data (non-GET requests return 405, and binary WebSocket frames are refused). File metadata goes only over the DataChannel. The end-to-end test measured 3.7 KB of signaling for 10.5 MB of delivered file data.
- **Access control**: an unguessable room id (128 bits) lets someone *ask* to join. The sender approves each receiver, and each receiver explicitly accepts. A separate 256-bit secret authorizes sender control.
- **Untrusted input**: all peer and server messages are schema-validated. File names are sanitized, display names are rendered as plain text, a strict CSP blocks inline scripts, and frames are checked for sequence, offset and size.

## What it does not provide

- **Peer identity is not verified.** DTLS encrypts the channel, but DirectSend does not verify fingerprints out of band. Anyone who obtains the link can request files, and display names are self-declared. The signaling server could in principle substitute its own peer (man-in-the-middle), so trust in the server operator is required. Mitigations: approve only receivers you expect, and share links privately.
- **Completion records are receiver-reported.** A “successful download” means the receiver's DirectSend page reported that it verified byte and chunk counts, finished writing and closed the file. It is not independent proof that the file exists, is intact at rest, or was not later deleted. A modified client could lie. There is no end-to-end content hash in protocol v1; DTLS and SCTP provide transport integrity.
- **Network exposure.** WebRTC reveals IP addresses (local and public) to the other peer and to the STUN servers. Signaling carries ICE candidates and therefore passes through the server as well.
- **Session cleanup does not delete received files.** Closing tabs, stopping sharing or room expiry ends connections only. Files already saved stay on receivers' devices.

## Functional limitations

- **No TURN relay by design**: some networks (symmetric NAT, strict firewalls, some mobile carriers, corporate networks) cannot connect directly. Users see an explanation and are told to try another network.
- **Both tabs must stay open** for the whole transfer. Sleep, tab discarding, backgrounding on mobile, or reloading interrupts it.
- **No resume**: interrupted files restart from byte 0 on retry (files already delivered are skipped).
- **Direct-to-disk streaming** requires the File System Access API: Chromium-based desktop browsers in a secure context. Firefox, Safari and most mobile browsers use the in-memory fallback, which is limited by `MEMORY_FALLBACK_MAX_MB` (default 256 MB) and cannot confirm the save.
- **Practical size limits** depend on browsers, free disk space and device resources. No size is guaranteed. Streaming was measured with a 1 GB file, and memory stayed flat. Larger sizes are expected to work but were not measured.
- **Single server instance** (in-memory room state). Horizontal scaling needs sticky routing by room.
- **Folders** cannot be shared as folders. Drag and drop ignores directories.
- **Receivers who reload** get a new session and appear as a new receiver.
- **Room expiry does not stop running transfers**: only queued or waiting receivers are affected.

## Verification status

**Verified automatically**: unit and integration tests (Node), and end-to-end tests in headless Chromium 1.63 (Playwright) under Linux/Docker, with both peers on one machine.

- The streaming destination in e2e is an Origin Private File System handle behind a mocked `showDirectoryPicker`. It uses the same writable-stream API, but the native folder picker and permission prompt were not exercised.
- The memory measurement uses a checksum-and-discard sink. Incognito-style test contexts keep OPFS data in memory with a small quota, so real-disk streaming of large files is unmeasured there. Results across runs: 1 GB at 83–110 MB/s. Browser RSS grew by a fixed 134–159 MB whether the file was 256 MB or 1 GB. Peak JS heap across both tabs was 65–102 MB (the test's limit is 150 MB).

**Not verified in real browsers** (see the [manual checklist](MANUAL_TEST_CHECKLIST.md)):
- Firefox, Safari, Edge, iOS and Android as sender or receiver
- Connections across different networks or NATs, and the local-vs-internet path label
- The native folder and Save-as pickers and their permission prompts, and disk-full behavior on real disks
- Screen-reader announcements; keyboard navigation was designed for but not audited
- Transfers larger than 1 GB, and very long-running transfers
- Behavior when devices sleep or mobile browsers background the tab
- Production deployment behind Caddy with a real domain and certificate
