/**
 * One RTCPeerConnection between the sender and a single receiver, with
 * trickle ICE over the signaling server and a single reliable, ordered
 * DataChannel. STUN only: no TURN relay is ever configured, so if the peers
 * cannot reach each other directly the connection fails with an explanation.
 */
import type { SignalData } from '../../shared/signaling';
import { DATA_CHANNEL_LABEL } from '../../shared/transfer';

export type PeerRole = 'offerer' | 'answerer';
export type ConnectionPath = 'local-network' | 'internet';

export type PeerFailure = 'timeout' | 'ice-failed' | 'disconnected' | 'closed' | 'setup-error';

export interface PeerLinkOptions {
  role: PeerRole;
  /** Connection attempt id; signals with a different id are ignored. */
  cid: string;
  stunUrls: string[];
  connectTimeoutMs: number;
  sendSignal(data: SignalData): void;
  onChannelOpen(channel: RTCDataChannel): void;
  onFailed(reason: PeerFailure): void;
}

const DISCONNECT_GRACE_MS = 8_000;

export class PeerLink {
  readonly pc: RTCPeerConnection;
  private channel: RTCDataChannel | undefined;
  private pendingCandidates: RTCIceCandidateInit[] = [];
  private connectTimer: ReturnType<typeof setTimeout> | undefined;
  private disconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private opened = false;

  constructor(private readonly opts: PeerLinkOptions) {
    this.pc = new RTCPeerConnection({
      iceServers: opts.stunUrls.length > 0 ? [{ urls: opts.stunUrls }] : [],
      iceTransportPolicy: 'all',
    });

    this.pc.onicecandidate = (event) => {
      if (!event.candidate || this.closed) return;
      const c = event.candidate.toJSON();
      this.opts.sendSignal({
        kind: 'candidate',
        cid: this.opts.cid,
        candidate: {
          candidate: c.candidate ?? '',
          sdpMid: c.sdpMid ?? null,
          sdpMLineIndex: c.sdpMLineIndex ?? null,
          usernameFragment: c.usernameFragment ?? null,
        },
      });
    };

    this.pc.onconnectionstatechange = () => {
      const state = this.pc.connectionState;
      if (state === 'failed') this.fail('ice-failed');
      else if (state === 'disconnected') {
        clearTimeout(this.disconnectTimer);
        this.disconnectTimer = setTimeout(() => {
          if (this.pc.connectionState === 'disconnected') this.fail('disconnected');
        }, DISCONNECT_GRACE_MS);
      } else if (state === 'connected') clearTimeout(this.disconnectTimer);
    };

    if (opts.role === 'answerer') {
      this.pc.ondatachannel = (event) => {
        if (event.channel.label === DATA_CHANNEL_LABEL && !this.channel) this.attachChannel(event.channel);
      };
    }
  }

  get cid(): string {
    return this.opts.cid;
  }

  /** Remote peer's maximum SCTP message size (0 when unknown). */
  get maxMessageSize(): number {
    return this.pc.sctp?.maxMessageSize ?? 0;
  }

  /** Offerer only: creates the DataChannel and sends the SDP offer. */
  async start(): Promise<void> {
    this.armTimeout();
    try {
      // Reliable and ordered are the defaults; stated explicitly for clarity.
      this.attachChannel(this.pc.createDataChannel(DATA_CHANNEL_LABEL, { ordered: true }));
      await this.pc.setLocalDescription(await this.pc.createOffer());
      const sdp = this.pc.localDescription?.sdp;
      if (!sdp || this.closed) return;
      this.opts.sendSignal({ kind: 'offer', cid: this.opts.cid, sdp });
    } catch {
      this.fail('setup-error');
    }
  }

  async handleSignal(data: SignalData): Promise<void> {
    if (this.closed) return;
    try {
      if (data.kind === 'offer' && this.opts.role === 'answerer') {
        this.armTimeout();
        await this.pc.setRemoteDescription({ type: 'offer', sdp: data.sdp });
        await this.flushCandidates();
        await this.pc.setLocalDescription(await this.pc.createAnswer());
        const sdp = this.pc.localDescription?.sdp;
        if (sdp && !this.closed) this.opts.sendSignal({ kind: 'answer', cid: this.opts.cid, sdp });
      } else if (data.kind === 'answer' && this.opts.role === 'offerer') {
        if (this.pc.signalingState !== 'have-local-offer') return;
        await this.pc.setRemoteDescription({ type: 'answer', sdp: data.sdp });
        await this.flushCandidates();
      } else if (data.kind === 'candidate') {
        const candidate: RTCIceCandidateInit = {
          candidate: data.candidate.candidate,
          sdpMid: data.candidate.sdpMid ?? undefined,
          sdpMLineIndex: data.candidate.sdpMLineIndex ?? undefined,
          usernameFragment: data.candidate.usernameFragment ?? undefined,
        };
        if (this.pc.remoteDescription) await this.pc.addIceCandidate(candidate).catch(() => undefined);
        else if (this.pendingCandidates.length < 200) this.pendingCandidates.push(candidate);
      }
    } catch {
      this.fail('setup-error');
    }
  }

  /** Reports whether ICE picked a path inside the local network. Informational only. */
  async describePath(): Promise<ConnectionPath | undefined> {
    try {
      const stats = await this.pc.getStats();
      let pairId: string | undefined;
      stats.forEach((report) => {
        if (report.type === 'transport' && report.selectedCandidatePairId) pairId = report.selectedCandidatePairId;
      });
      if (!pairId) {
        stats.forEach((report) => {
          if (report.type === 'candidate-pair' && report.state === 'succeeded' && (report.nominated || report.selected)) pairId ??= report.id;
        });
      }
      const pair = pairId ? stats.get(pairId) : undefined;
      if (!pair) return undefined;
      const local = stats.get(pair.localCandidateId);
      const remote = stats.get(pair.remoteCandidateId);
      if (!local || !remote) return undefined;
      return local.candidateType === 'host' && remote.candidateType === 'host' ? 'local-network' : 'internet';
    } catch {
      return undefined;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.connectTimer);
    clearTimeout(this.disconnectTimer);
    try {
      this.channel?.close();
    } catch {
      /* already closed */
    }
    this.pc.close();
  }

  private attachChannel(channel: RTCDataChannel): void {
    this.channel = channel;
    channel.binaryType = 'arraybuffer';
    channel.addEventListener('open', () => {
      this.opened = true;
      clearTimeout(this.connectTimer);
      this.opts.onChannelOpen(channel);
    });
  }

  private armTimeout(): void {
    clearTimeout(this.connectTimer);
    this.connectTimer = setTimeout(() => {
      if (!this.opened) this.fail('timeout');
    }, this.opts.connectTimeoutMs);
  }

  private async flushCandidates(): Promise<void> {
    const pending = this.pendingCandidates;
    this.pendingCandidates = [];
    for (const candidate of pending) await this.pc.addIceCandidate(candidate).catch(() => undefined);
  }

  private fail(reason: PeerFailure): void {
    if (this.closed) return;
    this.close();
    this.opts.onFailed(reason);
  }
}

/** User-facing explanation for a failed direct connection. */
export function describePeerFailure(reason: PeerFailure, wasConnected: boolean): string {
  if (wasConnected) {
    return 'The direct connection was lost. The other device may have closed the page, gone to sleep, or changed networks.';
  }
  switch (reason) {
    case 'timeout':
    case 'ice-failed':
      return "The two devices couldn't reach each other directly. Some Wi‑Fi, corporate and mobile networks block direct connections. Try putting both devices on the same Wi‑Fi network, or try a different network.";
    case 'setup-error':
      return 'The browser could not set up a direct connection. Try reloading the page or using an up-to-date browser.';
    default:
      return 'The direct connection could not be established. Try again, or try a different network.';
  }
}
