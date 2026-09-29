/**
 * Sends a fixed list of files to one receiver over one DataChannel.
 *
 * Files go strictly one after another. For each file the sender waits for the
 * receiver's `file-complete` (sent only after the receiver closed the
 * destination file) before starting the next one.
 *
 * Memory is bounded by three limits:
 *  - files are read incrementally in blocks of `readBlockBytes`;
 *  - the DataChannel send buffer never exceeds `highWaterMark` (+1 chunk),
 *    resuming on `bufferedamountlow`;
 *  - at most `windowBytes` may be sent but not yet written by the receiver
 *    (receiver-driven flow control via `ack`).
 */
import {
  type ControlMessage,
  type ControlMessageBody,
  encodeChunk,
  encodeControl,
  type OfferedFile,
  parseControlMessage,
  type TransferErrorCode,
} from '../../shared/transfer';
import { type DataChannelLike, TransferEnded, Waiters } from './channel';

export interface OutgoingFile {
  fileId: string;
  blob: Blob;
  name: string;
  size: number;
  type: string;
  lastModified?: number;
}

export type SenderTransferState = 'awaiting-acceptance' | 'transferring' | 'completed' | 'rejected' | 'canceled' | 'failed';

export interface SenderEndDetail {
  /** Who ended it, for canceled transfers. */
  by?: 'local' | 'remote';
  code?: TransferErrorCode | 'connection-lost' | string;
  message?: string;
}

export interface FileSenderEvents {
  onStateChange?(state: SenderTransferState, detail?: SenderEndDetail): void;
  onAccepted?(mode: 'stream' | 'memory'): void;
  onProgress?(progress: { fileId: string; fileIndex: number; ackedBytes: number; sentBytes: number }): void;
  onFileConfirmed?(fileId: string, saved: 'confirmed' | 'unconfirmed'): void;
}

export interface FileSenderOptions {
  channel: DataChannelLike;
  files: OutgoingFile[];
  transferId: string;
  transferNo: number;
  chunkSize: number;
  shareFileCount: number;
  windowBytes?: number;
  highWaterMark?: number;
  lowWaterMark?: number;
  readBlockBytes?: number;
  events?: FileSenderEvents;
}

const TERMINAL: ReadonlySet<SenderTransferState> = new Set(['completed', 'rejected', 'canceled', 'failed']);

export class FileSender {
  state: SenderTransferState = 'awaiting-acceptance';
  readonly transferId: string;
  /** Largest bufferedAmount observed right after a send (for tests/diagnostics). */
  maxBufferedObserved = 0;
  /** Largest sent-but-unacknowledged byte count observed. */
  maxInFlightObserved = 0;

  private readonly channel: DataChannelLike;
  private readonly files: OutgoingFile[];
  private readonly chunkSize: number;
  private readonly windowBytes: number;
  private readonly highWaterMark: number;
  private readonly readBlockBytes: number;
  private readonly events: FileSenderEvents;
  private readonly waiters = new Waiters();
  private readonly confirmed = new Map<string, 'confirmed' | 'unconfirmed'>();
  private readonly fullySent = new Set<string>();
  private current: { index: number; sent: number; acked: number } | undefined;
  private started = false;

  private readonly onMessage = (event: { data: unknown }) => this.handleMessage(event.data);
  private readonly onClose = () => this.handleChannelClosed();
  private readonly onLow = () => this.waiters.wake();

  constructor(private readonly opts: FileSenderOptions) {
    this.channel = opts.channel;
    this.files = opts.files;
    this.transferId = opts.transferId;
    this.chunkSize = opts.chunkSize;
    this.windowBytes = Math.max(opts.windowBytes ?? 8 * 1024 * 1024, opts.chunkSize * 2);
    this.highWaterMark = opts.highWaterMark ?? 1024 * 1024;
    this.readBlockBytes = Math.max(opts.readBlockBytes ?? 1024 * 1024, opts.chunkSize);
    this.events = opts.events ?? {};
    this.channel.bufferedAmountLowThreshold = opts.lowWaterMark ?? 256 * 1024;
    this.channel.addEventListener('message', this.onMessage);
    this.channel.addEventListener('close', this.onClose);
    this.channel.addEventListener('error', this.onClose);
    this.channel.addEventListener('bufferedamountlow', this.onLow);
  }

  get isTerminal(): boolean {
    return TERMINAL.has(this.state);
  }

  /** Files whose bytes were fully sent but whose save was never acknowledged. */
  get unconfirmedFileIds(): string[] {
    return [...this.fullySent].filter((id) => !this.confirmed.has(id));
  }

  get totalBytes(): number {
    return this.files.reduce((sum, f) => sum + f.size, 0);
  }

  /** Sends the offer; the transfer starts once the receiver accepts. */
  start(): void {
    if (this.started) return;
    this.started = true;
    const files: OfferedFile[] = this.files.map((f, index) => ({
      fileId: f.fileId,
      index,
      name: f.name,
      size: f.size,
      type: f.type,
      ...(f.lastModified !== undefined ? { lastModified: Math.max(0, Math.floor(f.lastModified)) } : {}),
    }));
    this.send({
      type: 'offer',
      transferId: this.transferId,
      transferNo: this.opts.transferNo,
      chunkSize: this.chunkSize,
      windowBytes: this.windowBytes,
      files,
      totalBytes: this.totalBytes,
      shareFileCount: this.opts.shareFileCount,
    });
  }

  cancel(reason: 'user' | 'sender-stopped' | 'page-closed' = 'user'): void {
    if (this.isTerminal) return;
    this.send({ type: 'cancel', transferId: this.transferId, reason });
    this.finish('canceled', { by: 'local' });
  }

  /** Called when the DataChannel or peer connection went away. */
  handleChannelClosed(): void {
    if (this.isTerminal) return;
    this.finish('failed', { code: 'connection-lost' });
  }

  // -------------------------------------------------------------------------

  private handleMessage(data: unknown): void {
    if (this.isTerminal) return;
    if (typeof data !== 'string') return this.protocolError('unexpected binary data from receiver');
    const parsed = parseControlMessage(data);
    if (!parsed.ok) return this.protocolError(parsed.error, parsed.code);
    const msg: ControlMessage = parsed.message;
    if ('transferId' in msg && msg.transferId !== undefined && msg.transferId !== this.transferId) {
      // Stale message from an earlier attempt on this channel: ignore.
      return;
    }

    switch (msg.type) {
      case 'accept':
        if (this.state !== 'awaiting-acceptance') return this.protocolError('unexpected accept');
        this.setState('transferring');
        this.events.onAccepted?.(msg.mode);
        void this.run();
        return;
      case 'reject':
        if (this.state !== 'awaiting-acceptance') return this.protocolError('unexpected reject');
        this.finish('rejected', { code: msg.reason });
        return;
      case 'ack': {
        const cur = this.current;
        const file = cur ? this.files[cur.index] : undefined;
        if (!cur || !file || file.fileId !== msg.fileId) {
          // A late ack for an already-confirmed file is harmless.
          if (this.confirmed.has(msg.fileId)) return;
          return this.protocolError('ack for unknown file');
        }
        if (msg.bytes < cur.acked || msg.bytes > cur.sent) return this.protocolError('invalid ack');
        cur.acked = msg.bytes;
        this.events.onProgress?.({ fileId: file.fileId, fileIndex: cur.index, ackedBytes: cur.acked, sentBytes: cur.sent });
        this.waiters.wake();
        return;
      }
      case 'file-complete': {
        // Idempotent: repeated confirmations for the same file are ignored.
        if (this.confirmed.has(msg.fileId)) return;
        const file = this.files.find((f) => f.fileId === msg.fileId);
        if (!file || !this.fullySent.has(file.fileId)) return this.protocolError('completion for a file not yet sent');
        if (msg.bytes !== file.size) return this.protocolError('completion byte count mismatch', 'integrity');
        this.confirmed.set(file.fileId, msg.saved);
        if (this.current && this.files[this.current.index]?.fileId === file.fileId) this.current.acked = file.size;
        this.events.onFileConfirmed?.(file.fileId, msg.saved);
        this.waiters.wake();
        return;
      }
      case 'cancel':
        this.finish('canceled', { by: 'remote' });
        return;
      case 'error':
        this.finish('failed', { code: msg.code, message: msg.message });
        return;
      default:
        this.protocolError(`unexpected message ${msg.type}`);
    }
  }

  private async run(): Promise<void> {
    try {
      for (let index = 0; index < this.files.length; index++) {
        const file = this.files[index]!;
        this.current = { index, sent: 0, acked: 0 };
        this.send({ type: 'file-start', transferId: this.transferId, fileId: file.fileId, index, size: file.size });
        const chunks = await this.sendFileData(file, index);
        this.send({ type: 'file-end', transferId: this.transferId, fileId: file.fileId, index, bytes: file.size, chunks });
        this.fullySent.add(file.fileId);
        await this.waiters.wait(() => this.confirmed.has(file.fileId));
      }
      this.finish('completed');
    } catch (err) {
      if (err instanceof TransferEnded || this.isTerminal) return;
      const readFailure = err instanceof DOMException && (err.name === 'NotReadableError' || err.name === 'NotFoundError');
      if (readFailure) {
        this.send({ type: 'error', transferId: this.transferId, code: 'read-failed', message: 'The sender could not read a file.' });
        this.finish('failed', { code: 'read-failed', message: 'A file could not be read. It may have been moved, changed or deleted.' });
      } else {
        this.finish('failed', { code: 'connection-lost' });
      }
    }
  }

  private async sendFileData(file: OutgoingFile, fileIndex: number): Promise<number> {
    const cur = this.current!;
    let seq = 0;
    let offset = 0;
    while (offset < file.size) {
      const blockEnd = Math.min(offset + this.readBlockBytes, file.size);
      const block = new Uint8Array(await file.blob.slice(offset, blockEnd).arrayBuffer());
      if (this.isTerminal) throw new TransferEnded();
      if (block.byteLength !== blockEnd - offset) throw new DOMException('short read', 'NotReadableError');

      for (let pos = 0; pos < block.byteLength; ) {
        const n = Math.min(this.chunkSize, block.byteLength - pos);
        await this.waiters.wait(
          () => this.channel.bufferedAmount <= this.highWaterMark && cur.sent - cur.acked + n <= this.windowBytes,
          250,
        );
        if (this.channel.readyState !== 'open') throw new TransferEnded();
        this.channel.send(encodeChunk({ transferNo: this.opts.transferNo, fileIndex, seq, offset: offset + pos }, block.subarray(pos, pos + n)));
        seq++;
        pos += n;
        cur.sent += n;
        this.maxBufferedObserved = Math.max(this.maxBufferedObserved, this.channel.bufferedAmount);
        this.maxInFlightObserved = Math.max(this.maxInFlightObserved, cur.sent - cur.acked);
        this.events.onProgress?.({ fileId: file.fileId, fileIndex, ackedBytes: cur.acked, sentBytes: cur.sent });
      }
      offset = blockEnd;
    }
    return seq;
  }

  private protocolError(detail: string, code: TransferErrorCode = 'protocol-error'): void {
    if (this.isTerminal) return;
    this.send({ type: 'error', transferId: this.transferId, code, message: detail.slice(0, 300) });
    this.finish('failed', { code, message: 'The receiving app sent unexpected data, so the transfer was stopped.' });
  }

  private send(message: ControlMessageBody): void {
    if (this.channel.readyState !== 'open') return;
    try {
      this.channel.send(encodeControl(message));
    } catch {
      // The channel is closing; the close handler reports the failure.
    }
  }

  private setState(state: SenderTransferState, detail?: SenderEndDetail): void {
    this.state = state;
    this.events.onStateChange?.(state, detail);
  }

  private finish(state: SenderTransferState, detail?: SenderEndDetail): void {
    if (this.isTerminal) return;
    this.waiters.abort();
    this.channel.removeEventListener('message', this.onMessage);
    this.channel.removeEventListener('close', this.onClose);
    this.channel.removeEventListener('error', this.onClose);
    this.channel.removeEventListener('bufferedamountlow', this.onLow);
    this.setState(state, detail);
  }
}
