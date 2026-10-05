/**
 * Receiver orchestration: joins the room, waits for approval, answers the
 * sender's WebRTC offer, reviews the offered files and saves them to the
 * destination the user picked.
 */
import type { ClientConfig } from '../../shared/config';
import type { RoomClosedReason, ServerMessage, SignalData } from '../../shared/signaling';
import type { SafeOfferedFile } from '../../shared/transfer';
import { SpeedMeter } from '../lib/speed';
import { Store } from '../lib/store';
import { SignalingClient, type SignalingStatus } from '../signaling/SignalingClient';
import { detectStorageCapabilities, isPickerCancel, pickDirectory, pickSaveFile, type StorageCapabilities } from '../storage/capabilities';
import { MemorySinkFactory, type SinkFactory } from '../storage/sinks';
import { FileReceiver, type ReceiverEndDetail, type ReceivedOffer } from '../transfer/FileReceiver';
import { type ConnectionPath, describePeerFailure, PeerLink, type PeerFailure } from '../webrtc/PeerLink';

export type ReceiverPhase =
  | 'join'
  | 'connecting'
  | 'awaiting-approval'
  | 'queued'
  | 'connecting-peer'
  | 'awaiting-acceptance'
  | 'transferring'
  | 'completed'
  | 'save-unconfirmed'
  | 'rejected'
  | 'denied'
  | 'canceled'
  | 'failed'
  | 'unavailable';

export interface IncomingFileView {
  fileId: string;
  name: string;
  size: number;
  bytes: number;
  state: 'pending' | 'writing' | 'saved' | 'delivered';
  savedName?: string;
}

export interface ReceiverSnapshot {
  phase: ReceiverPhase;
  label?: string;
  displayName?: string;
  queuePosition?: number;
  senderOnline: boolean;
  signaling: SignalingStatus | 'idle';
  offer?: { files: SafeOfferedFile[]; totalBytes: number; shareFileCount: number };
  files: IncomingFileView[];
  totalBytes: number;
  doneBytes: number;
  bytesPerSecond: number;
  etaSeconds?: number;
  mode?: 'stream' | 'memory';
  destination?: string;
  path?: ConnectionPath;
  error?: { title: string; message: string };
  pickerError?: string;
  canRetry: boolean;
  capabilities: StorageCapabilities;
  memoryLimit: number;
}

export class ReceiverSession {
  readonly store: Store<ReceiverSnapshot>;
  private phase: ReceiverPhase = 'join';
  private signaling: SignalingClient | undefined;
  private signalingStatus: SignalingStatus | 'idle' = 'idle';
  private creds: { sessionId: string; sessionSecret: string } | undefined;
  private label: string | undefined;
  private displayName: string | undefined;
  private queuePosition: number | undefined;
  private senderOnline = true;
  private roomClosed: RoomClosedReason | undefined;
  private link: PeerLink | undefined;
  private receiver: FileReceiver | undefined;
  private factory: SinkFactory | undefined;
  private offer: ReceivedOffer | undefined;
  private files: IncomingFileView[] = [];
  private path: ConnectionPath | undefined;
  private error: { title: string; message: string } | undefined;
  private pickerError: string | undefined;
  private channelOpened = false;
  private readonly speed = new SpeedMeter();
  private readonly capabilities = detectStorageCapabilities();

  constructor(
    private readonly roomId: string,
    private readonly config: ClientConfig,
  ) {
    this.store = new Store(this.build());
  }

  // ------------------------------------------------------------------ actions

  join(displayName?: string): void {
    if (this.phase !== 'join') return;
    this.displayName = displayName?.trim() || undefined;
    this.phase = 'connecting';
    this.signaling = new SignalingClient({
      onMessage: (msg) => this.onServerMessage(msg),
      onStatus: (status) => {
        this.signalingStatus = status;
        if (status === 'closed' && (this.phase === 'connecting' || this.phase === 'awaiting-approval' || this.phase === 'queued')) {
          this.fail('Connection lost', "Couldn't stay connected to the DirectShare server. Check your internet connection and open the link again.", 'unavailable');
        }
        this.emit();
      },
      onOpen: () => {
        if (this.creds) this.signaling?.send({ type: 'resume-receiver', roomId: this.roomId, ...this.creds });
        else this.signaling?.send({ type: 'join', roomId: this.roomId, displayName: this.displayName });
      },
      maxReconnectMs: 60_000,
    });
    this.signaling.connect();
    this.emit();
  }

  /** Call directly from a click handler. */
  async chooseFolderAndAccept(): Promise<void> {
    if (this.phase !== 'awaiting-acceptance') return;
    this.pickerError = undefined;
    try {
      const factory = await pickDirectory();
      this.accept(factory);
    } catch (err) {
      if (!isPickerCancel(err)) this.pickerError = 'The folder could not be opened for saving. Choose a different folder.';
      this.emit();
    }
  }

  /** Call directly from a click handler. Only for single-file transfers. */
  async chooseFileAndAccept(): Promise<void> {
    const file = this.offer?.files[0];
    if (this.phase !== 'awaiting-acceptance' || !file || this.offer!.files.length !== 1) return;
    this.pickerError = undefined;
    try {
      const factory = await pickSaveFile(file.safeName);
      this.accept(factory);
    } catch (err) {
      if (!isPickerCancel(err)) this.pickerError = 'That location could not be opened for saving. Choose a different one.';
      this.emit();
    }
  }

  acceptBrowserDownload(): void {
    if (this.phase !== 'awaiting-acceptance' || !this.offer) return;
    if (this.offer.totalBytes > this.config.memoryFallbackMaxBytes) return;
    this.accept(new MemorySinkFactory(this.config.memoryFallbackMaxBytes));
  }

  reject(reason: 'declined' | 'too-large' = 'declined'): void {
    if (this.phase !== 'awaiting-acceptance') return;
    this.receiver?.reject(reason);
  }

  cancel(): void {
    if (this.receiver && !this.receiver.isTerminal) {
      this.receiver.cancel();
      return;
    }
    if (this.phase === 'connecting-peer' && this.link) {
      this.signal({ kind: 'hangup', cid: this.link.cid });
      this.closeLink();
      this.phase = 'canceled';
      this.error = { title: 'Transfer canceled', message: 'You canceled before the transfer started.' };
      this.emit();
    }
  }

  /** Asks the sender for a fresh attempt. Files already saved are not sent again. */
  retry(): void {
    if (!this.canRetry()) return;
    this.closeLink();
    this.receiver = undefined;
    this.error = undefined;
    this.phase = 'queued';
    this.queuePosition = undefined;
    this.signal({ kind: 'retry-request' });
    this.emit();
  }

  /** Page is closing: end everything. Saved files stay on the device. */
  leave(): void {
    if (this.receiver && !this.receiver.isTerminal) this.receiver.cancel();
    this.signaling?.send({ type: 'leave' });
    this.signaling?.close();
    this.closeLink();
    this.factory?.dispose();
  }

  get hasActiveWork(): boolean {
    return this.phase === 'transferring' || this.phase === 'awaiting-acceptance' || this.phase === 'connecting-peer';
  }

  // ---------------------------------------------------------------- signaling

  private onServerMessage(msg: ServerMessage): void {
    switch (msg.type) {
      case 'joined':
        this.creds = { sessionId: msg.sessionId, sessionSecret: msg.sessionSecret };
        this.label = msg.label;
        this.displayName = msg.displayName;
        this.senderOnline = msg.senderOnline;
        if (this.phase === 'connecting') this.phase = msg.approved ? 'queued' : 'awaiting-approval';
        break;
      case 'approved':
        if (this.phase === 'awaiting-approval') this.phase = 'queued';
        break;
      case 'removed':
        this.signaling?.close();
        this.closeLink();
        if (msg.reason === 'denied') {
          this.phase = 'denied';
          this.error = { title: 'Not approved', message: 'The sender did not approve this device. Ask them to share again if this was a mistake.' };
        } else {
          this.fail('Removed', 'The sender removed you from this share.', 'unavailable');
        }
        break;
      case 'sender-status':
        this.senderOnline = msg.online;
        break;
      case 'room-closed':
        this.roomClosed = msg.reason;
        this.signaling?.close();
        if (this.phase === 'awaiting-approval' || this.phase === 'queued' || this.phase === 'connecting' || (this.phase === 'connecting-peer' && !this.channelOpened)) {
          this.closeLink();
          this.fail('Share ended', roomClosedMessage(msg.reason), 'unavailable');
        }
        // A transfer already running peer-to-peer carries on.
        break;
      case 'signal':
        if (msg.from === 'sender') this.onSignal(msg.data);
        return;
      case 'error':
        if (msg.code === 'room-unavailable' || msg.code === 'room-full' || msg.code === 'forbidden') {
          this.signaling?.close();
          this.fail(msg.code === 'room-full' ? 'This share is full' : 'Link unavailable', msg.message, 'unavailable');
        } else if (msg.code === 'rate-limited' && this.phase === 'connecting') {
          this.fail('Please wait', msg.message, 'unavailable');
        }
        break;
      default:
        return;
    }
    this.emit();
  }

  private onSignal(data: SignalData): void {
    switch (data.kind) {
      case 'queued':
        if (this.phase === 'queued' || this.phase === 'awaiting-approval') {
          this.phase = 'queued';
          this.queuePosition = data.position;
        }
        break;
      case 'offer': {
        if (this.link?.cid === data.cid) return;
        // A new attempt from the sender replaces any previous one.
        if (this.receiver && !this.receiver.isTerminal) this.receiver.cancel();
        this.closeLink();
        this.receiver = undefined;
        this.offer = undefined;
        this.files = [];
        this.error = undefined;
        this.channelOpened = false;
        this.phase = 'connecting-peer';
        const link: PeerLink = new PeerLink({
          role: 'answerer',
          cid: data.cid,
          stunUrls: this.config.stunUrls,
          connectTimeoutMs: this.config.connectTimeoutSeconds * 1000,
          sendSignal: (d) => this.signal(d),
          onChannelOpen: (channel) => this.onChannelOpen(link, channel),
          onFailed: (reason) => this.onLinkFailed(link, reason),
        });
        this.link = link;
        void link.handleSignal(data);
        break;
      }
      case 'candidate':
        if (this.link?.cid === data.cid) void this.link.handleSignal(data);
        return;
      case 'hangup':
        if (this.link?.cid !== data.cid) return;
        if (this.receiver && !this.receiver.isTerminal) return; // DataChannel reports the outcome
        this.closeLink();
        this.phase = 'canceled';
        this.error = { title: 'Transfer canceled', message: 'The sender canceled this transfer.' };
        break;
      default:
        return;
    }
    this.emit();
  }

  private signal(data: SignalData): void {
    this.signaling?.send({ type: 'signal', data });
  }

  // --------------------------------------------------------------- transfer

  private onChannelOpen(link: PeerLink, channel: RTCDataChannel): void {
    if (this.link !== link) return;
    this.channelOpened = true;
    const receiver: FileReceiver = new FileReceiver(channel, {
      onOffer: (offer) => {
        this.offer = offer;
        this.files = offer.files.map((f) => ({ fileId: f.fileId, name: f.safeName, size: f.size, bytes: 0, state: 'pending' }));
        this.phase = 'awaiting-acceptance';
        this.emit();
      },
      onProgress: ({ fileId, writtenBytes }) => {
        const file = this.files.find((f) => f.fileId === fileId);
        if (file) {
          file.bytes = writtenBytes;
          if (file.state === 'pending') file.state = 'writing';
        }
        this.speed.update(this.files.reduce((sum, f) => sum + f.bytes, 0));
        this.store.setThrottled(() => this.build());
      },
      onFileSaved: (fileId, savedName, confirmed) => {
        const file = this.files.find((f) => f.fileId === fileId);
        if (file) {
          file.bytes = file.size;
          file.state = confirmed ? 'saved' : 'delivered';
          file.savedName = savedName;
        }
        this.emit();
      },
      onStateChange: (state, detail) => this.onReceiverState(receiver, state, detail),
    });
    this.receiver = receiver;
    void link.describePath().then((path) => {
      if (this.link === link) {
        this.path = path;
        this.emit();
      }
    });
  }

  private onReceiverState(receiver: FileReceiver, state: FileReceiver['state'], detail?: ReceiverEndDetail): void {
    if (this.receiver !== receiver) return;
    switch (state) {
      case 'transferring':
        this.phase = 'transferring';
        this.speed.reset();
        break;
      case 'completed':
        this.phase = this.factory?.confirmsSave ? 'completed' : 'save-unconfirmed';
        this.closeLinkSoon();
        break;
      case 'rejected':
        this.phase = 'rejected';
        this.error = {
          title: 'Transfer declined',
          message: detail?.code === 'too-large' ? 'These files are too large for this browser.' : 'You declined these files.',
        };
        this.closeLinkSoon();
        break;
      case 'canceled':
        this.phase = 'canceled';
        this.error = {
          title: 'Transfer canceled',
          message:
            detail?.by === 'local'
              ? 'You canceled the transfer. Any partially received file was removed.'
              : detail?.code === 'sender-stopped' || detail?.code === 'page-closed'
                ? 'The sender stopped sharing. Files that finished before that are saved; the interrupted file was removed.'
                : 'The sender canceled the transfer. Files that finished before that are saved; the interrupted file was removed.',
        };
        this.closeLinkSoon();
        break;
      case 'failed':
        this.fail('Transfer failed', describeReceiverFailure(detail, this.roomClosed));
        this.closeLinkSoon();
        break;
      default:
        break;
    }
    this.emit();
  }

  private onLinkFailed(link: PeerLink, reason: PeerFailure): void {
    if (this.link !== link) return;
    if (this.receiver && !this.receiver.isTerminal) {
      this.receiver.handleChannelClosed();
      return;
    }
    if (this.phase === 'connecting-peer') {
      this.closeLink();
      this.fail("Couldn't connect", describePeerFailure(reason, this.channelOpened));
      this.emit();
    }
  }

  private accept(factory: SinkFactory): void {
    if (!this.receiver || this.phase !== 'awaiting-acceptance') {
      factory.dispose();
      return;
    }
    this.factory?.dispose();
    this.factory = factory;
    this.receiver.accept(factory);
  }

  private closeLink(): void {
    this.link?.close();
    this.link = undefined;
  }

  private closeLinkSoon(): void {
    const link = this.link;
    setTimeout(() => {
      if (this.link === link) this.closeLink();
    }, 1500);
  }

  private canRetry(): boolean {
    return (
      (this.phase === 'failed' || this.phase === 'canceled' || this.phase === 'rejected') &&
      this.roomClosed === undefined &&
      Boolean(this.signaling?.isOpen)
    );
  }

  private fail(title: string, message: string, phase: ReceiverPhase = 'failed'): void {
    this.phase = phase;
    this.error = { title, message };
  }

  // ---------------------------------------------------------------- snapshot

  private emit(): void {
    this.store.set(this.build());
  }

  private build(): ReceiverSnapshot {
    const totalBytes = this.files.reduce((sum, f) => sum + f.size, 0);
    const doneBytes = this.files.reduce((sum, f) => sum + f.bytes, 0);
    const transferring = this.phase === 'transferring';
    return {
      phase: this.phase,
      label: this.label,
      displayName: this.displayName,
      queuePosition: this.queuePosition,
      senderOnline: this.senderOnline,
      signaling: this.signalingStatus,
      offer: this.offer ? { files: this.offer.files, totalBytes: this.offer.totalBytes, shareFileCount: this.offer.shareFileCount } : undefined,
      files: this.files.map((f) => ({ ...f })),
      totalBytes,
      doneBytes,
      bytesPerSecond: transferring ? this.speed.bytesPerSecond() : 0,
      etaSeconds: transferring ? this.speed.etaSeconds(totalBytes - doneBytes) : undefined,
      mode: this.factory?.mode,
      destination: this.factory?.destinationLabel,
      path: this.path,
      error: this.error,
      pickerError: this.pickerError,
      canRetry: this.canRetry(),
      capabilities: this.capabilities,
      memoryLimit: this.config.memoryFallbackMaxBytes,
    };
  }
}

function roomClosedMessage(reason: RoomClosedReason): string {
  switch (reason) {
    case 'expired':
      return 'This sharing link expired. Ask the sender to share the files again.';
    case 'sender-left':
      return 'The sender closed their page or lost their connection. Ask them to share the files again.';
    default:
      return 'The sender stopped sharing. Ask them to share the files again if you still need them.';
  }
}

function describeReceiverFailure(detail: ReceiverEndDetail | undefined, roomClosed: RoomClosedReason | undefined): string {
  const tail = ' Files that finished before this are saved; the interrupted file was removed.';
  switch (detail?.code) {
    case 'connection-lost':
      if (roomClosed === 'stopped') return 'The sender stopped sharing.' + tail;
      return 'The connection to the sender was lost. They may have closed the page or changed networks.' + tail;
    case 'storage-full':
      return 'Your device ran out of space. Free up some storage, then try again.';
    case 'permission-denied':
      return 'The browser no longer allows saving to that folder. Try again and choose another folder.';
    case 'write-failed':
      return 'Saving to the chosen location failed. Check that it is still available, then try again.';
    case 'too-large':
      return 'This transfer is larger than your browser can hold in memory.';
    case 'read-failed':
      return "The sender's device could not read one of the files.";
    default:
      return (detail?.message ?? 'The transfer stopped because of an unexpected error.') + (detail?.by === 'remote' ? '' : tail);
  }
}
