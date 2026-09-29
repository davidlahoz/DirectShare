# Manual verification checklist

The automated suites cover the protocol and headless Chromium. The items below need real devices, networks and browsers. Record the browser versions, OS and network for each run.

Use `docker compose --profile https up` (LAN) or a production deployment (HTTPS). Keep DevTools → Network open on the sender to confirm no large HTTP or WebSocket traffic.

## 1. Browsers

| # | Sender → Receiver | Expected receiver options | Result |
| --- | --- | --- | --- |
| 1.1 | Chrome desktop → Chrome desktop | Folder (recommended), Save as (1 file), Browser download | ☐ |
| 1.2 | Edge desktop → Chrome desktop | same as 1.1 | ☐ |
| 1.3 | Chrome → Firefox desktop | Browser download only; over-limit shows “Too large for this browser” | ☐ |
| 1.4 | Firefox → Chrome | Folder streaming works with a Firefox sender | ☐ |
| 1.5 | Chrome → Safari macOS | Browser download only | ☐ |
| 1.6 | Safari macOS → Chrome | Transfer completes (check the chunk-size fallback) | ☐ |
| 1.7 | Chrome desktop → iOS Safari (scan QR) | QR opens the link; download works for small files | ☐ |
| 1.8 | Chrome desktop → Android Chrome | Browser download; large offers are rejected before starting | ☐ |
| 1.9 | Keyboard only (Tab/Enter/Space) on both sides | Every action reachable, focus visible | ☐ |
| 1.10 | Screen reader (VoiceOver/NVDA) | Status changes and progress announced; buttons labeled | ☐ |

## 2. Multiple receivers

- ☐ 2.1 Five receivers join at once. Each appears with its own label, and nothing transfers before approval.
- ☐ 2.2 Approve all five with `MAX_CONCURRENT_TRANSFERS=3`. Two show “Queued · #n” (receiver: “number n in line”) and start automatically.
- ☐ 2.3 Each receiver picks a different mode. Progress, speed and ETA are independent.
- ☐ 2.4 A receiver that joins after others completed can still download.
- ☐ 2.5 Reject a receiver. They see “Not approved” and cannot get the files.
- ☐ 2.6 Joining beyond `MAX_RECEIVERS_PER_ROOM` shows “This share is full”.

## 3. Networks

- ☐ 3.1 Same Wi‑Fi: the receiver card shows “Direct · local network”.
- ☐ 3.2 Different networks (home broadband ↔ phone hotspot): the connection succeeds or fails with the “couldn't reach each other directly” message.
- ☐ 3.3 Symmetric NAT or strict corporate network: the failure message appears within `CONNECT_TIMEOUT_SECONDS`, and other receivers are unaffected.
- ☐ 3.4 VPN on one side: note the result (support varies).
- ☐ 3.5 On the server, confirm `docker stats` network I/O stays in KB while GBs transfer.

## 4. Large files

- ☐ 4.1 A 5 GB file with a folder destination on Chrome: sender and receiver tab memory (Task Manager) stays flat, and the output SHA-256 matches the source.
- ☐ 4.2 A 20 GB file, if the disk allows: completes, or fails with a clear storage error.
- ☐ 4.3 1,000 small files: sequential progress, history lists all of them, “Received all files” appears.
- ☐ 4.4 Fill the receiver's disk during a transfer: “Your device ran out of space”, the partial file is removed, and the sender shows Failed, not success.

## 5. Unsupported storage APIs

- ☐ 5.1 Firefox/Safari receiver, total ≤ limit: “Download through the browser”. The sender shows “Save unconfirmed” and lists the files under “Delivered to browser — save unconfirmed”, not under successful downloads.
- ☐ 5.2 Same, total > limit: offer rejected before any data moves, and the sender card says too large.
- ☐ 5.3 Chrome over plain HTTP from a LAN IP (not secure): no folder option, with an explanation that HTTPS is needed.
- ☐ 5.4 Cancel the folder picker: nothing starts and you can choose again.
- ☐ 5.5 Deny the folder write permission: an actionable message appears.

## 6. Interrupted transfers

- ☐ 6.1 Receiver closes the tab mid-file: sender card shows Failed, other receivers continue.
- ☐ 6.2 Sender closes the tab mid-transfer: receivers see a lost-connection message. Completed files are kept, and the interrupted file is removed.
- ☐ 6.3 Receiver cancels: the sender sees “The receiver canceled”. Then Retry from either side: new attempt (“Attempt 2”), only undelivered files are sent, and earlier history is kept.
- ☐ 6.4 Sender cancels one receiver: the others are unaffected.
- ☐ 6.5 Stop sharing: every receiver is informed, the link says “no longer sharing”, and the sender's history stays visible until reload.
- ☐ 6.6 Turn Wi‑Fi off for about 10 s on the receiver during a transfer: it recovers, or fails with the connection-lost message. It never shows success.
- ☐ 6.7 Restart the signaling server during an active transfer: the transfer continues (P2P). Sender and receivers show reconnecting, then resume.
- ☐ 6.8 Let a room expire (`ROOM_TTL_SECONDS=120`): new joins see “expired”, and active transfers finish.
- ☐ 6.9 Laptop lid closed on the sender: receivers fail with a clear message.
- ☐ 6.10 Drop the connection right after the last byte, before confirmation (e.g. close the receiver tab while it is closing a large file): the sender shows the file under “Unconfirmed”, not as successful.

## 7. Security spot checks

- ☐ 7.1 The server logs contain no room ids, secrets, names or file names.
- ☐ 7.2 A receiver named `<img src=x onerror=alert(1)>` is shown as plain text.
- ☐ 7.3 A file named `..\..\evil.bat` is saved as a sanitized single name inside the chosen folder.
- ☐ 7.4 A WebSocket from another origin is refused (HTTP 403).
