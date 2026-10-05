/**
 * Receives one transfer over one DataChannel and writes it to a sink.
 *
 * Every incoming frame is validated on arrival (transfer number, file index,
 * sequence number, offset, size) and then queued for a single sequential
 * writer. A file is reported as saved to the sender only after:
 *   1. the byte count and chunk count in `file-end` match what arrived,
 *   2. every write completed, and
 *   3. the destination file was closed successfully.
 * Memory is bounded by the sender's flow-control window, which the receiver
 * also enforces.
 */
import {
  ackIntervalFor,
  type ControlMessageBody,
  decodeChunk,
  encodeControl,
  type OfferMessage,
  parseControlMessage,
  type SafeOfferedFile,
  toSafeFiles,
  type TransferErrorCode,
} from '../../shared/transfer';
import type { FileSink, SinkFactory } from '../storage/sinks';
import { toStorageError } from '../storage/sinks';
import { type DataChannelLike, TransferEnded } from './channel';

export type ReceiverTransferState = 'waiting-offer' | 'awaiting-acceptance' | 'transferring' | 'completed' | 'rejected' | 'canceled' | 'failed';

export interface ReceivedOffer {
  transferId: string;
  files: SafeOfferedFile[];
  totalBytes: number;
  shareFileCount: number;
}

export interface ReceiverEndDetail {
  by?: 'local' | 'remote';
  code?: TransferErrorCode | 'connection-lost' | 'storage-full' | 'permission-denied' | 'too-large' | string;
  message?: string;
}

export interface FileReceiverEvents {
  onOffer?(offer: ReceivedOffer): void;
  onStateChange?(state: ReceiverTransferState, detail?: ReceiverEndDetail): void;
  onProgress?(progress: { fileId: string; fileIndex: number; writtenBytes: number }): void;
  onFileSaved?(fileId: string, savedName: string, confirmed: boolean): void;
}

type Op =
  | { kind: 'start'; file: SafeOfferedFile }
  | { kind: 'chunk'; data: Uint8Array }
  | { kind: 'end'; file: SafeOfferedFile };

const TERMINAL: ReadonlySet<ReceiverTransferState> = new Set(['completed', 'rejected', 'canceled', 'failed']);

export class FileReceiver {
  state: ReceiverTransferState = 'waiting-offer';
  offer: ReceivedOffer | undefined;
  /** Largest number of bytes waiting to be written (for tests/diagnostics). */
  maxQueuedObserved = 0;

  private raw: OfferMessage | undefined;
  private factory: SinkFactory | undefined;
  private sink: FileSink | undefined;
  private ackEvery = 0;

  // Arrival-side validation state.
  private nextFileIndex = 0;
  private incoming: { file: SafeOfferedFile; seq: number; received: number } | undefined;

  // Writer-side state.
  private readonly queue: Op[] = [];
  private queuedBytes = 0;
  private pumping = false;
  private written = 0;
  private lastAck = 0;
  private writingFile: SafeOfferedFile | undefined;

  private readonly onMessage = (event: { data: unknown }) => this.handleMessage(event.data);
  private readonly onClose = () => this.handleChannelClosed();

  constructor(
    private readonly channel: DataChannelLike,
    private readonly events: FileReceiverEvents = {},
  ) {
    channel.addEventListener('message', this.onMessage);
    channel.addEventListener('close', this.onClose);
    channel.addEventListener('error', this.onClose);
  }

  get isTerminal(): boolean {
    return TERMINAL.has(this.state);
  }

  /** Starts receiving into `factory`. Only valid while awaiting acceptance. */
  accept(factory: SinkFactory): void {
    if (this.state !== 'awaiting-acceptance' || !this.raw) throw new Error('No transfer to accept');
    this.factory = factory;
    this.send({ type: 'accept', transferId: this.raw.transferId, mode: factory.mode });
    this.setState('transferring');
  }

  reject(reason: 'declined' | 'unsupported' | 'too-large' | 'storage-unavailable' = 'declined'): void {
    if (this.state !== 'awaiting-acceptance' || !this.raw) return;
    this.send({ type: 'reject', transferId: this.raw.transferId, reason });
    this.finish('rejected', { by: 'local', code: reason });
  }

  cancel(): void {
    if (this.isTerminal) return;
    if (this.raw) this.send({ type: 'cancel', transferId: this.raw.transferId, reason: 'user' });
    this.finish('canceled', { by: 'local' });
  }

  handleChannelClosed(): void {
    if (this.isTerminal) return;
    this.finish('failed', { code: 'connection-lost' });
  }

  // -------------------------------------------------------------------------

  private handleMessage(data: unknown): void {
    if (this.isTerminal) return;
    if (data instanceof ArrayBuffer) return this.handleChunk(data);
    if (typeof data !== 'string') return this.protocolError('unsupported message type');

    const parsed = parseControlMessage(data);
    if (!parsed.ok) return this.protocolError(parsed.error, parsed.code);
    const msg = parsed.message;

    if (msg.type === 'offer') {
      if (this.state !== 'waiting-offer') return this.protocolError('unexpected offer');
      this.raw = msg;
      this.ackEvery = ackIntervalFor(msg.windowBytes, msg.chunkSize);
      this.offer = {
        transferId: msg.transferId,
        files: toSafeFiles(msg.files),
        totalBytes: msg.totalBytes,
        shareFileCount: msg.shareFileCount,
      };
      this.setState('awaiting-acceptance');
      this.events.onOffer?.(this.offer);
      return;
    }

    if (!this.raw) return this.protocolError('message before offer');
    if ('transferId' in msg && msg.transferId !== undefined && msg.transferId !== this.raw.transferId) {
      return this.protocolError('unknown transfer id');
    }

    switch (msg.type) {
      case 'file-start': {
        if (this.state !== 'transferring' || this.incoming) return this.protocolError('unexpected file-start');
        const file = this.offer!.files[msg.index];
        if (!file || msg.index !== this.nextFileIndex || file.fileId !== msg.fileId || file.size !== msg.size) {
          return this.protocolError('file-start does not match the offer');
        }
        this.incoming = { file, seq: 0, received: 0 };
        this.enqueue({ kind: 'start', file });
        return;
      }
      case 'file-end': {
        const inc = this.incoming;
        if (this.state !== 'transferring' || !inc || inc.file.fileId !== msg.fileId || inc.file.index !== msg.index) {
          return this.protocolError('unexpected file-end');
        }
        if (msg.bytes !== inc.file.size || inc.received !== inc.file.size || msg.chunks !== inc.seq) {
          return this.protocolError('byte or chunk count mismatch', 'integrity');
        }
        this.incoming = undefined;
        this.nextFileIndex++;
        this.enqueue({ kind: 'end', file: inc.file });
        return;
      }
      case 'cancel':
        this.finish('canceled', { by: 'remote', code: msg.reason });
        return;
      case 'error':
        this.finish('failed', { by: 'remote', code: msg.code, message: msg.message });
        return;
      default:
        this.protocolError(`unexpected message ${msg.type}`);
    }
  }

  private handleChunk(buffer: ArrayBuffer): void {
    const inc = this.incoming;
    const raw = this.raw;
    if (this.state !== 'transferring' || !inc || !raw) return this.protocolError('data outside of a file');
    const decoded = decodeChunk(buffer);
    if (!decoded.ok) return this.protocolError(decoded.error);
    const { header, payload } = decoded;
    if (header.transferNo !== raw.transferNo) return this.protocolError('data for another transfer');
    if (header.fileIndex !== inc.file.index) return this.protocolError('data for the wrong file');
    if (header.seq !== inc.seq) return this.protocolError('chunk out of sequence', 'integrity');
    if (header.offset !== inc.received) return this.protocolError('chunk offset mismatch', 'integrity');
    if (payload.byteLength === 0 || payload.byteLength > raw.chunkSize) return this.protocolError('invalid chunk size');
    if (inc.received + payload.byteLength > inc.file.size) return this.protocolError('more data than announced', 'integrity');
    if (this.queuedBytes + payload.byteLength > raw.windowBytes + raw.chunkSize) {
      return this.protocolError('sender exceeded the flow-control window', 'flow-control');
    }
    inc.seq++;
    inc.received += payload.byteLength;
    this.enqueue({ kind: 'chunk', data: payload });
  }

  private enqueue(op: Op): void {
    this.queue.push(op);
    if (op.kind === 'chunk') {
      this.queuedBytes += op.data.byteLength;
      this.maxQueuedObserved = Math.max(this.maxQueuedObserved, this.queuedBytes);
    }
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.queue.length > 0) {
        if (this.isTerminal) throw new TransferEnded();
        const op = this.queue.shift()!;
        await this.execute(op);
      }
    } catch (err) {
      if (!(err instanceof TransferEnded) && !this.isTerminal) {
        const storage = toStorageError(err);
        this.send({ type: 'error', transferId: this.raw?.transferId, code: storage.code === 'storage-full' ? 'storage-full' : 'write-failed', message: 'The receiver could not save the file.' });
        this.finish('failed', { code: storage.code, message: storage.message });
      }
    } finally {
      this.pumping = false;
    }
  }

  private async execute(op: Op): Promise<void> {
    const transferId = this.raw!.transferId;
    switch (op.kind) {
      case 'start': {
        this.written = 0;
        this.lastAck = 0;
        this.writingFile = op.file;
        const sink = await this.factory!.open(op.file);
        if (this.isTerminal) {
          await sink.abort();
          throw new TransferEnded();
        }
        this.sink = sink;
        return;
      }
      case 'chunk': {
        await this.sink!.write(op.data);
        this.queuedBytes -= op.data.byteLength;
        if (this.isTerminal) throw new TransferEnded();
        this.written += op.data.byteLength;
        const file = this.writingFile!;
        this.events.onProgress?.({ fileId: file.fileId, fileIndex: file.index, writtenBytes: this.written });
        if (this.written - this.lastAck >= this.ackEvery) {
          this.lastAck = this.written;
          this.send({ type: 'ack', transferId, fileId: file.fileId, bytes: this.written });
        }
        return;
      }
      case 'end': {
        const file = op.file;
        if (this.written !== file.size) throw new Error('integrity');
        const sink = this.sink!;
        await sink.close();
        this.sink = undefined;
        this.writingFile = undefined;
        if (this.isTerminal) return;
        this.events.onProgress?.({ fileId: file.fileId, fileIndex: file.index, writtenBytes: file.size });
        this.events.onFileSaved?.(file.fileId, sink.savedName, this.factory!.confirmsSave);
        this.send({
          type: 'file-complete',
          transferId,
          fileId: file.fileId,
          bytes: file.size,
          saved: this.factory!.confirmsSave ? 'confirmed' : 'unconfirmed',
        });
        if (file.index === this.offer!.files.length - 1) this.finish('completed');
        return;
      }
    }
  }

  private protocolError(detail: string, code: TransferErrorCode = 'protocol-error'): void {
    if (this.isTerminal) return;
    this.send({ type: 'error', transferId: this.raw?.transferId, code, message: detail.slice(0, 300) });
    this.finish('failed', {
      code,
      message:
        code === 'unsupported-version'
          ? 'The sender is using a different version of DirectShare. Both sides should reload the page.'
          : 'The sender sent unexpected data, so the transfer was stopped to protect your files.',
    });
  }

  private send(message: ControlMessageBody): void {
    if (this.channel.readyState !== 'open') return;
    try {
      this.channel.send(encodeControl(message));
    } catch {
      // Closing; handled by the close listener.
    }
  }

  private setState(state: ReceiverTransferState, detail?: ReceiverEndDetail): void {
    this.state = state;
    this.events.onStateChange?.(state, detail);
  }

  private finish(state: ReceiverTransferState, detail?: ReceiverEndDetail): void {
    if (this.isTerminal) return;
    this.channel.removeEventListener('message', this.onMessage);
    this.channel.removeEventListener('close', this.onClose);
    this.channel.removeEventListener('error', this.onClose);
    this.queue.length = 0;
    this.queuedBytes = 0;
    if (state !== 'completed' && this.sink) {
      // Remove the partially written file.
      const sink = this.sink;
      this.sink = undefined;
      void sink.abort();
    }
    this.setState(state, detail);
  }
}
