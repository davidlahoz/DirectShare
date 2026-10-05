/**
 * Sender orchestration: owns the file selection, the sharing room, one
 * PeerLink + FileSender per receiver, the transfer queue and the download
 * history. The UI renders immutable snapshots from `store`.
 */
import type { ClientConfig } from '../../shared/config';
import type { ServerMessage, SignalData } from '../../shared/signaling';
import { chooseChunkSize, MAX_FILES_PER_OFFER } from '../../shared/transfer';
import { emptyHistory, deliveredFileIds, type HistoryState, recordOutcome } from '../history/downloadHistory';
import { randomId } from '../lib/ids';
import { SpeedMeter } from '../lib/speed';
import { Store } from '../lib/store';
import { SignalingClient, type SignalingStatus } from '../signaling/SignalingClient';
import { FileSender, type OutgoingFile, type SenderEndDetail } from '../transfer/FileSender';
import { type ConnectionPath, describePeerFailure, PeerLink, type PeerFailure } from '../webrtc/PeerLink';
import { ACTIVE_STATUSES, planSchedule, type ReceiverStatus } from './scheduler';

export interface SharedFile {
  fileId: string;
  file: File;
  name: string;
  size: number;
  type: string;
}

export type FileProgressState = 'pending' | 'sending' | 'confirmed' | 'save-unconfirmed' | 'unconfirmed';

export interface ReceiverFileProgress {
  fileId: string;
  name: string;
  size: number;
  bytes: number;
  state: FileProgressState;
}

export interface ReceiverView {
  sessionId: string;
  label: string;
  displayName?: string;
  status: ReceiverStatus;
  message?: string;
  online: boolean;
  queuePosition?: number;
  attempt: number;
  mode?: 'stream' | 'memory';
  path?: ConnectionPath;
  files: ReceiverFileProgress[];
  totalBytes: number;
  doneBytes: number;
  bytesPerSecond: number;
  etaSeconds?: number;
  alreadyDelivered: number;
}

export type SenderPhase = 'select' | 'creating' | 'sharing' | 'stopped' | 'ended';

export interface Notice {
  tone: 'info' | 'error';
  text: string;
}

export interface SenderSnapshot {
  phase: SenderPhase;
  files: Array<Omit<SharedFile, 'file'>>;
  totalBytes: number;
  shareUrl?: string;
  expiresAt?: number;
  signaling: SignalingStatus | 'idle';
  receivers: ReceiverView[];
  history: HistoryState;
  notice?: Notice;
  endedReason?: string;
  maxConcurrent: number;
}

interface ReceiverRuntime {
  sessionId: string;
  label: string;
  displayName?: string;
  status: ReceiverStatus;
  message?: string;
  online: boolean;
  queuedAt?: number;
  queuePosition?: number;
  lastSentPosition?: number;
  attempt: number;
  link?: PeerLink;
  sender?: FileSender;
  channelOpened: boolean;
  mode?: 'stream' | 'memory';
  path?: ConnectionPath;
  files: ReceiverFileProgress[];
  alreadyDelivered: number;
  speed: SpeedMeter;
}

const TERMINAL_STATUSES: ReadonlySet<ReceiverStatus> = new Set([
  'completed',
  'save-unconfirmed',
  'rejected',
  'canceled',
  'failed',
  'denied',
  'left',
]);

export class SenderSession {
  readonly store: Store<SenderSnapshot>;
  private files: SharedFile[] = [];
  private phase: SenderPhase = 'select';
  private signaling: SignalingClient | undefined;
  private signalingStatus: SignalingStatus | 'idle' = 'idle';
  private creds: { roomId: string; senderSecret: string } | undefined;
  private shareUrl: string | undefined;
  private expiresAt: number | undefined;
  private receivers = new Map<string, ReceiverRuntime>();
  private history: HistoryState = emptyHistory;
  private notice: Notice | undefined;
  private endedReason: string | undefined;
  private transferCounter = 0;
  private createTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly config: ClientConfig,
    private readonly origin: string = location.origin,
  ) {
    this.store = new Store(this.build());
  }

  // ---------------------------------------------------------------- selection

  addFiles(list: Iterable<File>): void {
    if (this.phase !== 'select') return;
    const known = new Set(this.files.map((f) => `${f.name}\u0000${f.size}\u0000${f.file.lastModified}`));
    let skipped = 0;
    for (const file of list) {
      const key = `${file.name}\u0000${file.size}\u0000${file.lastModified}`;
      if (known.has(key)) continue;
      if (this.files.length >= MAX_FILES_PER_OFFER) {
        skipped++;
        continue;
      }
      known.add(key);
      this.files.push({ fileId: randomId(12), file, name: file.name || 'file', size: file.size, type: file.type });
    }
    this.notice = skipped > 0 ? { tone: 'error', text: `You can share up to ${MAX_FILES_PER_OFFER} files at once.` } : undefined;
    this.emit();
  }

  removeFile(fileId: string): void {
    if (this.phase !== 'select') return;
    this.files = this.files.filter((f) => f.fileId !== fileId);
    this.emit();
  }

  clearFiles(): void {
    if (this.phase !== 'select') return;
    this.files = [];
    this.emit();
  }

  // ------------------------------------------------------------------ sharing

  startSharing(): void {
    if (this.phase !== 'select' || this.files.length === 0) return;
    this.phase = 'creating';
    this.notice = undefined;
    this.signaling = new SignalingClient({
      onMessage: (msg) => this.onServerMessage(msg),
      onStatus: (status) => this.onSignalingStatus(status),
      onOpen: () => {
        if (this.creds) this.signaling?.send({ type: 'resume-sender', ...this.creds });
        else this.signaling?.send({ type: 'create-room' });
      },
    });
    this.signaling.connect();
    this.createTimer = setTimeout(() => {
      if (this.phase !== 'creating') return;
      this.signaling?.close();
      this.signaling = undefined;
      this.phase = 'select';
      this.notice = { tone: 'error', text: "Couldn't reach the DirectShare server. Check your internet connection and try again." };
      this.emit();
    }, 15_000);
    this.emit();
  }

  approve(sessionId: string): void {
    const r = this.receivers.get(sessionId);
    if (!r || r.status !== 'awaiting-approval' || this.phase !== 'sharing') return;
    this.signaling?.send({ type: 'approve', sessionId });
    this.enqueue(r);
    this.schedule();
    this.emit();
  }

  deny(sessionId: string): void {
    const r = this.receivers.get(sessionId);
    if (!r || r.status !== 'awaiting-approval') return;
    this.signaling?.send({ type: 'remove-receiver', sessionId, reason: 'denied' });
    r.status = 'denied';
    r.message = 'You declined this receiver.';
    this.emit();
  }

  cancel(sessionId: string): void {
    const r = this.receivers.get(sessionId);
    if (!r || TERMINAL_STATUSES.has(r.status)) return;
    if (r.status === 'awaiting-approval') return this.deny(sessionId);
    if (r.sender && !r.sender.isTerminal) {
      r.sender.cancel('user'); // onStateChange finishes the bookkeeping
      return;
    }
    if (r.link) this.signalTo(r, { kind: 'hangup', cid: r.link.cid });
    this.teardown(r);
    r.status = 'canceled';
    r.message = 'You canceled this transfer.';
    this.schedule();
    this.emit();
  }

  /** Starts a fresh attempt (new connection and transfer id) for files not yet delivered. */
  retry(sessionId: string): void {
    const r = this.receivers.get(sessionId);
    if (!r || this.phase !== 'sharing' || !r.online) return;
    if (!['failed', 'canceled', 'rejected'].includes(r.status)) return;
    this.teardown(r);
    this.enqueue(r);
    this.schedule();
    this.emit();
  }

  /** Invalidates the room, ends all transfers and keeps history visible. */
  stopSharing(reason: 'user' | 'page-closed' = 'user'): void {
    if (this.phase !== 'sharing' && this.phase !== 'creating' && this.phase !== 'ended') return;
    clearTimeout(this.createTimer);
    const wasEnded = this.phase === 'ended';
    this.phase = 'stopped';
    this.signaling?.send({ type: 'close-room' });
    this.signaling?.close();
    this.signaling = undefined;
    for (const r of this.receivers.values()) {
      if (r.sender && !r.sender.isTerminal) r.sender.cancel(reason === 'page-closed' ? 'page-closed' : 'sender-stopped');
      if (!TERMINAL_STATUSES.has(r.status)) {
        r.status = 'canceled';
        r.message = 'Sharing was stopped.';
      }
      // Let the cancel message reach the receiver before closing the connection.
      const link = r.link;
      if (reason === 'page-closed') this.teardown(r);
      else setTimeout(() => link?.close(), 1000);
    }
    this.notice = wasEnded ? undefined : { tone: 'info', text: 'Sharing stopped. The link no longer works.' };
    this.emit();
  }

  /** Starts over with a new selection. Clears this session's history. */
  reset(): void {
    if (this.phase === 'sharing' || this.phase === 'creating') this.stopSharing();
    this.receivers.clear();
    this.files = [];
    this.history = emptyHistory;
    this.creds = undefined;
    this.shareUrl = undefined;
    this.expiresAt = undefined;
    this.endedReason = undefined;
    this.notice = undefined;
    this.signalingStatus = 'idle';
    this.phase = 'select';
    this.emit();
  }

  clearHistory(): void {
    this.history = emptyHistory;
    this.emit();
  }

  dismissNotice(): void {
    this.notice = undefined;
    this.emit();
  }

  get hasActiveWork(): boolean {
    if (this.phase === 'sharing' || this.phase === 'creating') return true;
    return [...this.receivers.values()].some((r) => ACTIVE_STATUSES.has(r.status));
  }

  // --------------------------------------------------------------- signaling

  private onSignalingStatus(status: SignalingStatus): void {
    this.signalingStatus = status;
    if (status === 'closed' && this.phase === 'sharing') {
      this.endSharing('The connection to the DirectShare server was lost, so new receivers cannot join. Transfers already in progress continue.');
    }
    this.emit();
  }

  private onServerMessage(msg: ServerMessage): void {
    switch (msg.type) {
      case 'room-created': {
        clearTimeout(this.createTimer);
        if (this.phase !== 'creating') return;
        this.creds = { roomId: msg.roomId, senderSecret: msg.senderSecret };
        // The room id lives in the URL fragment, which browsers never send to servers.
        this.shareUrl = `${this.origin}/join#${msg.roomId}`;
        this.expiresAt = msg.expiresAt;
        this.phase = 'sharing';
        break;
      }
      case 'sender-resumed': {
        this.expiresAt = msg.expiresAt;
        const present = new Set(msg.receivers.map((r) => r.sessionId));
        for (const info of msg.receivers) {
          const r = this.receivers.get(info.sessionId);
          if (r) r.online = info.online;
          else this.addReceiver(info.sessionId, info.label, info.displayName, info.online);
        }
        for (const r of this.receivers.values()) {
          if (!present.has(r.sessionId) && (r.status === 'awaiting-approval' || r.status === 'queued')) {
            r.status = 'left';
            r.online = false;
          }
        }
        this.schedule();
        break;
      }
      case 'receiver-joined':
        if (this.phase !== 'sharing') return;
        if (!this.receivers.has(msg.receiver.sessionId)) {
          this.addReceiver(msg.receiver.sessionId, msg.receiver.label, msg.receiver.displayName, msg.receiver.online);
        }
        break;
      case 'receiver-status': {
        const r = this.receivers.get(msg.sessionId);
        if (!r) return;
        r.online = msg.online;
        if (msg.online) {
          r.lastSentPosition = undefined;
          this.schedule();
        }
        break;
      }
      case 'receiver-left': {
        const r = this.receivers.get(msg.sessionId);
        if (!r) return;
        r.online = false;
        if (r.status === 'awaiting-approval' || r.status === 'queued' || (r.status === 'connecting' && !r.channelOpened)) {
          this.teardown(r);
          r.status = 'left';
          r.message = 'Left before the transfer started.';
          this.schedule();
        }
        // An open peer-to-peer transfer continues without the signaling server.
        break;
      }
      case 'signal':
        if (msg.from !== 'sender') this.onSignal(msg.from, msg.data);
        return;
      case 'room-closed':
        if (msg.reason === 'stopped') return;
        this.endSharing(
          msg.reason === 'expired'
            ? 'This sharing link expired. Transfers already in progress continue; start a new share for more receivers.'
            : 'This page was disconnected for too long, so the link was closed. Transfers already in progress continue.',
        );
        break;
      case 'error':
        this.onServerError(msg.code, msg.message);
        break;
      default:
        return;
    }
    this.emit();
  }

  private onServerError(code: string, message: string): void {
    if (this.phase === 'creating') {
      clearTimeout(this.createTimer);
      this.signaling?.close();
      this.signaling = undefined;
      this.phase = 'select';
      this.notice = { tone: 'error', text: message };
      return;
    }
    if (code === 'room-unavailable' || code === 'forbidden') {
      this.endSharing('The sharing link is no longer active. Transfers already in progress continue.');
      return;
    }
    if (code === 'peer-offline' || code === 'unknown-receiver') return; // handled by timeouts/status updates
    this.notice = { tone: 'error', text: message };
  }

  private endSharing(reason: string): void {
    if (this.phase !== 'sharing') return;
    this.phase = 'ended';
    this.endedReason = reason;
    this.signaling?.close();
    this.signaling = undefined;
    for (const r of this.receivers.values()) {
      if (r.status === 'awaiting-approval' || r.status === 'queued') {
        r.status = 'failed';
        r.message = 'The link closed before this transfer could start.';
      }
    }
  }

  private onSignal(sessionId: string, data: SignalData): void {
    const r = this.receivers.get(sessionId);
    if (!r) return;
    switch (data.kind) {
      case 'answer':
      case 'candidate':
        if (r.link && r.link.cid === data.cid) void r.link.handleSignal(data);
        return;
      case 'hangup':
        if (!r.link || r.link.cid !== data.cid) return;
        if (r.sender && !r.sender.isTerminal) return; // the DataChannel reports the outcome
        this.teardown(r);
        r.status = 'canceled';
        r.message = 'The receiver canceled.';
        this.schedule();
        this.emit();
        return;
      case 'retry-request':
        this.retry(sessionId);
        return;
      default:
        return;
    }
  }

  private signalTo(r: ReceiverRuntime, data: SignalData): void {
    this.signaling?.send({ type: 'signal', to: r.sessionId, data });
  }

  // --------------------------------------------------------------- transfers

  private addReceiver(sessionId: string, label: string, displayName: string | undefined, online: boolean): void {
    this.receivers.set(sessionId, {
      sessionId,
      label,
      displayName,
      status: 'awaiting-approval',
      online,
      attempt: 0,
      channelOpened: false,
      files: [],
      alreadyDelivered: 0,
      speed: new SpeedMeter(),
    });
  }

  private enqueue(r: ReceiverRuntime): void {
    r.status = 'queued';
    r.message = undefined;
    r.queuedAt = performance.now();
    r.lastSentPosition = undefined;
  }

  private schedule(): void {
    if (this.phase !== 'sharing') return;
    const plan = planSchedule([...this.receivers.values()], this.config.maxConcurrentTransfers);
    for (const r of this.receivers.values()) {
      if (r.status !== 'queued') continue;
      const position = plan.positions.get(r.sessionId);
      r.queuePosition = position;
      if (position !== undefined && position !== r.lastSentPosition && r.online) {
        r.lastSentPosition = position;
        this.signalTo(r, { kind: 'queued', position });
      }
    }
    for (const id of plan.start) {
      const r = this.receivers.get(id);
      if (r) this.startConnection(r);
    }
  }

  private startConnection(r: ReceiverRuntime): void {
    const delivered = deliveredFileIds(this.history, r.sessionId);
    const pending = this.files.filter((f) => !delivered.has(f.fileId));
    r.alreadyDelivered = this.files.length - pending.length;
    if (pending.length === 0) {
      r.status = 'completed';
      r.message = 'Already received every file.';
      return;
    }
    r.attempt++;
    r.status = 'connecting';
    r.message = undefined;
    r.queuePosition = undefined;
    r.channelOpened = false;
    r.mode = undefined;
    r.path = undefined;
    r.sender = undefined;
    r.speed.reset();
    r.files = pending.map((f) => ({ fileId: f.fileId, name: f.name, size: f.size, bytes: 0, state: 'pending' }));

    const link: PeerLink = new PeerLink({
      role: 'offerer',
      cid: randomId(12),
      stunUrls: this.config.stunUrls,
      connectTimeoutMs: this.config.connectTimeoutSeconds * 1000,
      sendSignal: (data) => this.signalTo(r, data),
      onChannelOpen: (channel) => this.onChannelOpen(r, link, channel, pending),
      onFailed: (reason) => this.onLinkFailed(r, link, reason),
    });
    r.link = link;
    void link.start();
  }

  private onChannelOpen(r: ReceiverRuntime, link: PeerLink, channel: RTCDataChannel, pending: SharedFile[]): void {
    if (r.link !== link) return;
    r.channelOpened = true;
    const outgoing: OutgoingFile[] = pending.map((f) => ({
      fileId: f.fileId,
      blob: f.file,
      name: f.name,
      size: f.size,
      type: f.type,
      lastModified: f.file.lastModified,
    }));
    const transferId = randomId(12);
    const sender = new FileSender({
      channel,
      files: outgoing,
      transferId,
      transferNo: ++this.transferCounter,
      chunkSize: chooseChunkSize(link.maxMessageSize),
      shareFileCount: this.files.length,
      events: {
        onAccepted: (mode) => {
          r.mode = mode;
          r.status = 'transferring';
          r.speed.reset();
          this.emit();
        },
        onProgress: ({ fileId, ackedBytes }) => {
          const entry = r.files.find((f) => f.fileId === fileId);
          if (entry && entry.state === 'pending') entry.state = 'sending';
          if (entry && entry.state === 'sending') entry.bytes = ackedBytes;
          r.speed.update(r.files.reduce((sum, f) => sum + f.bytes, 0));
          this.store.setThrottled(() => this.build());
        },
        onFileConfirmed: (fileId, saved) => {
          const entry = r.files.find((f) => f.fileId === fileId);
          const file = this.files.find((f) => f.fileId === fileId);
          if (!entry || !file) return;
          entry.bytes = entry.size;
          entry.state = saved === 'confirmed' ? 'confirmed' : 'save-unconfirmed';
          this.history = recordOutcome(this.history, {
            receiverId: r.sessionId,
            receiverName: r.displayName ?? r.label,
            fileId,
            fileName: file.name,
            size: file.size,
            completedAt: Date.now(),
            transferId,
            kind: saved === 'confirmed' ? 'confirmed' : 'save-unconfirmed',
          });
          this.emit();
        },
        onStateChange: (state, detail) => this.onTransferState(r, sender, transferId, state, detail),
      },
    });
    r.sender = sender;
    r.status = 'awaiting-acceptance';
    sender.start();
    void link.describePath().then((path) => {
      if (r.link === link) {
        r.path = path;
        this.emit();
      }
    });
    this.emit();
  }

  private onTransferState(
    r: ReceiverRuntime,
    sender: FileSender,
    transferId: string,
    state: FileSender['state'],
    detail?: SenderEndDetail,
  ): void {
    if (r.sender !== sender || !sender.isTerminal) return;
    switch (state) {
      case 'completed':
        r.status = r.files.some((f) => f.state === 'save-unconfirmed') ? 'save-unconfirmed' : 'completed';
        r.message = undefined;
        break;
      case 'rejected':
        r.status = 'rejected';
        r.message =
          detail?.code === 'declined'
            ? 'The receiver declined the files.'
            : detail?.code === 'too-large'
              ? "The files are too large for the receiver's browser."
              : "The receiver's browser can't save these files.";
        break;
      case 'canceled':
        r.status = 'canceled';
        r.message =
          detail?.by === 'remote'
            ? 'The receiver canceled the transfer.'
            : this.phase === 'stopped'
              ? 'Sharing was stopped.'
              : 'You canceled this transfer.';
        break;
      case 'failed': {
        r.status = 'failed';
        r.message = describeSenderFailure(detail);
        const unconfirmed = sender.unconfirmedFileIds;
        for (const fileId of unconfirmed) {
          const file = this.files.find((f) => f.fileId === fileId);
          const entry = r.files.find((f) => f.fileId === fileId);
          if (entry) entry.state = 'unconfirmed';
          if (!file) continue;
          this.history = recordOutcome(this.history, {
            receiverId: r.sessionId,
            receiverName: r.displayName ?? r.label,
            fileId,
            fileName: file.name,
            size: file.size,
            completedAt: Date.now(),
            transferId,
            kind: 'unconfirmed',
          });
        }
        if (unconfirmed.length > 0) {
          r.message += ` ${unconfirmed.length === 1 ? 'One file was' : `${unconfirmed.length} files were`} fully sent but never confirmed.`;
        }
        break;
      }
      default:
        return;
    }
    // Give final control messages a moment to flush before closing.
    const link = r.link;
    setTimeout(() => {
      if (link && r.link === link) this.teardown(r);
    }, 1500);
    this.schedule();
    this.emit();
  }

  private onLinkFailed(r: ReceiverRuntime, link: PeerLink, reason: PeerFailure): void {
    if (r.link !== link) return;
    if (r.sender && !r.sender.isTerminal) {
      r.sender.handleChannelClosed();
      return;
    }
    if (TERMINAL_STATUSES.has(r.status)) return;
    this.teardown(r);
    r.status = 'failed';
    r.message = describePeerFailure(reason, r.channelOpened);
    this.schedule();
    this.emit();
  }

  private teardown(r: ReceiverRuntime): void {
    r.link?.close();
    r.link = undefined;
  }

  // ---------------------------------------------------------------- snapshot

  private emit(): void {
    this.store.set(this.build());
  }

  private build(): SenderSnapshot {
    return {
      phase: this.phase,
      files: this.files.map(({ fileId, name, size, type }) => ({ fileId, name, size, type })),
      totalBytes: this.files.reduce((sum, f) => sum + f.size, 0),
      shareUrl: this.shareUrl,
      expiresAt: this.expiresAt,
      signaling: this.signalingStatus,
      receivers: [...this.receivers.values()].map((r) => {
        const totalBytes = r.files.reduce((sum, f) => sum + f.size, 0);
        const doneBytes = r.files.reduce((sum, f) => sum + f.bytes, 0);
        const transferring = r.status === 'transferring';
        return {
          sessionId: r.sessionId,
          label: r.label,
          displayName: r.displayName,
          status: r.status,
          message: r.message,
          online: r.online,
          queuePosition: r.queuePosition,
          attempt: r.attempt,
          mode: r.mode,
          path: r.path,
          files: r.files.map((f) => ({ ...f })),
          totalBytes,
          doneBytes,
          bytesPerSecond: transferring ? r.speed.bytesPerSecond() : 0,
          etaSeconds: transferring ? r.speed.etaSeconds(totalBytes - doneBytes) : undefined,
          alreadyDelivered: r.alreadyDelivered,
        };
      }),
      history: this.history,
      notice: this.notice,
      endedReason: this.endedReason,
      maxConcurrent: this.config.maxConcurrentTransfers,
    };
  }
}

function describeSenderFailure(detail?: SenderEndDetail): string {
  switch (detail?.code) {
    case 'connection-lost':
      return 'The connection to the receiver was lost. They may have closed the page or lost their network.';
    case 'write-failed':
    case 'storage-full':
      return "The receiver's device could not save the file (storage full or not writable).";
    case 'read-failed':
      return detail.message ?? 'A file could not be read on this device.';
    default:
      return detail?.message ?? 'The transfer stopped because of an unexpected error.';
  }
}
