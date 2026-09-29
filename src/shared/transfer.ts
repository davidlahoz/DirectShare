/**
 * DirectSend peer-to-peer transfer protocol, version 1.
 *
 * Runs over one reliable, ordered RTCDataChannel per receiver. Control
 * messages are JSON text frames carrying `v` (protocol version) and `type`.
 * File data travels in binary frames with a fixed 24-byte header so the
 * receiver can validate ordering and offsets before writing anything.
 *
 *   sender                                   receiver
 *     | offer {files, chunkSize, window} ------->|  review, choose destination
 *     |<------------------- accept {mode} / reject
 *     | file-start ----------------------------->|  open destination file
 *     | [chunk frames] ------------------------->|  validate + write
 *     |<------------------------------ ack {bytes}  (flow control window)
 *     | file-end {bytes, chunks} --------------->|  verify counts, close file
 *     |<------------------ file-complete {saved}    (only after close succeeds)
 *     | ...next file...                          |
 *     |<------------ cancel / error ------------>|  either direction, any time
 *
 * Binary frame layout (big-endian):
 *   0  u8   magic (0xD5)
 *   1  u8   protocol version
 *   2  u16  reserved (0)
 *   4  u32  transferNo   per-connection transfer counter
 *   8  u32  fileIndex    position of the file in the offer
 *  12  u32  seq          chunk sequence number within the file, from 0
 *  16  f64  offset       byte offset of this chunk within the file
 *  24  ...  payload
 */
import { z } from 'zod';
import { sanitizeFilename, sanitizeMimeType } from './sanitize';

export const TRANSFER_PROTOCOL_VERSION = 1;
export const DATA_CHANNEL_LABEL = 'directsend-v1';

export const FRAME_MAGIC = 0xd5;
export const FRAME_HEADER_BYTES = 24;
export const MIN_CHUNK_BYTES = 1024;
export const MAX_CHUNK_BYTES = 256 * 1024;
export const DEFAULT_CHUNK_BYTES = 64 * 1024;
/** Chunk size used when the browser does not report an SCTP message size. */
export const CONSERVATIVE_CHUNK_BYTES = 16 * 1024;
export const MAX_FILES_PER_OFFER = 1000;
export const MAX_CONTROL_MESSAGE_CHARS = 512 * 1024;
export const MIN_WINDOW_BYTES = 256 * 1024;
export const MAX_WINDOW_BYTES = 64 * 1024 * 1024;

const u32 = z.number().int().min(0).max(0xffff_ffff);
const byteCount = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const protoId = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);
const version = z.literal(TRANSFER_PROTOCOL_VERSION);

export const offeredFileSchema = z
  .object({
    fileId: protoId,
    index: z.number().int().min(0).max(MAX_FILES_PER_OFFER - 1),
    name: z.string().min(1).max(1024),
    size: byteCount,
    type: z.string().max(255),
    lastModified: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  })
  .strict();
export type OfferedFile = z.infer<typeof offeredFileSchema>;

const offerSchema = z
  .object({
    v: version,
    type: z.literal('offer'),
    transferId: protoId,
    transferNo: u32,
    chunkSize: z.number().int().min(MIN_CHUNK_BYTES).max(MAX_CHUNK_BYTES),
    windowBytes: z.number().int().min(MIN_WINDOW_BYTES).max(MAX_WINDOW_BYTES),
    files: z.array(offeredFileSchema).min(1).max(MAX_FILES_PER_OFFER),
    totalBytes: byteCount,
    /** How many files the sender is sharing overall (offers may be retries of a subset). */
    shareFileCount: z.number().int().min(1).max(MAX_FILES_PER_OFFER),
  })
  .strict()
  .superRefine((offer, ctx) => {
    let total = 0;
    const ids = new Set<string>();
    offer.files.forEach((file, i) => {
      if (file.index !== i) ctx.addIssue({ code: 'custom', message: 'file indexes must be sequential' });
      if (ids.has(file.fileId)) ctx.addIssue({ code: 'custom', message: 'duplicate file id' });
      ids.add(file.fileId);
      total += file.size;
    });
    if (total !== offer.totalBytes) ctx.addIssue({ code: 'custom', message: 'totalBytes mismatch' });
    if (offer.files.length > offer.shareFileCount) ctx.addIssue({ code: 'custom', message: 'shareFileCount too small' });
    if (offer.windowBytes < offer.chunkSize * 2) ctx.addIssue({ code: 'custom', message: 'window too small' });
  });

export const REJECT_REASONS = ['declined', 'unsupported', 'too-large', 'storage-unavailable'] as const;
export const CANCEL_REASONS = ['user', 'sender-stopped', 'page-closed'] as const;
export const TRANSFER_ERROR_CODES = [
  'protocol-error',
  'unsupported-version',
  'flow-control',
  'write-failed',
  'read-failed',
  'storage-full',
  'integrity',
  'internal',
] as const;
export type TransferErrorCode = (typeof TRANSFER_ERROR_CODES)[number];

export const controlMessageSchema = z.discriminatedUnion('type', [
  offerSchema,
  z
    .object({ v: version, type: z.literal('accept'), transferId: protoId, mode: z.enum(['stream', 'memory']) })
    .strict(),
  z.object({ v: version, type: z.literal('reject'), transferId: protoId, reason: z.enum(REJECT_REASONS) }).strict(),
  z
    .object({ v: version, type: z.literal('file-start'), transferId: protoId, fileId: protoId, index: u32, size: byteCount })
    .strict(),
  z
    .object({
      v: version,
      type: z.literal('file-end'),
      transferId: protoId,
      fileId: protoId,
      index: u32,
      bytes: byteCount,
      chunks: u32,
    })
    .strict(),
  z.object({ v: version, type: z.literal('ack'), transferId: protoId, fileId: protoId, bytes: byteCount }).strict(),
  z
    .object({
      v: version,
      type: z.literal('file-complete'),
      transferId: protoId,
      fileId: protoId,
      bytes: byteCount,
      /** `confirmed`: written and closed at the chosen destination. `unconfirmed`: handed to the browser's download manager. */
      saved: z.enum(['confirmed', 'unconfirmed']),
    })
    .strict(),
  z.object({ v: version, type: z.literal('cancel'), transferId: protoId, reason: z.enum(CANCEL_REASONS) }).strict(),
  z
    .object({
      v: version,
      type: z.literal('error'),
      transferId: protoId.optional(),
      code: z.enum(TRANSFER_ERROR_CODES),
      message: z.string().max(300),
    })
    .strict(),
]);

export type ControlMessage = z.infer<typeof controlMessageSchema>;
export type OfferMessage = Extract<ControlMessage, { type: 'offer' }>;
export type ControlMessageOf<T extends ControlMessage['type']> = Extract<ControlMessage, { type: T }>;

/** Distributive Omit so each union member keeps its own fields. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type ControlMessageBody = DistributiveOmit<ControlMessage, 'v'>;

export type ControlParseResult =
  | { ok: true; message: ControlMessage }
  | { ok: false; code: 'protocol-error' | 'unsupported-version'; error: string };

export function parseControlMessage(raw: string): ControlParseResult {
  if (raw.length > MAX_CONTROL_MESSAGE_CHARS) return { ok: false, code: 'protocol-error', error: 'message too large' };
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, code: 'protocol-error', error: 'invalid JSON' };
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    return { ok: false, code: 'protocol-error', error: 'not an object' };
  }
  const v = (json as { v?: unknown }).v;
  if (v !== TRANSFER_PROTOCOL_VERSION) {
    return { ok: false, code: 'unsupported-version', error: `unsupported protocol version ${String(v)}` };
  }
  const result = controlMessageSchema.safeParse(json);
  if (!result.success) return { ok: false, code: 'protocol-error', error: 'invalid message shape' };
  return { ok: true, message: result.data };
}

export function encodeControl(message: ControlMessageBody): string {
  return JSON.stringify({ v: TRANSFER_PROTOCOL_VERSION, ...message });
}

/** An offered file after its peer-provided fields were made safe to use locally. */
export interface SafeOfferedFile extends OfferedFile {
  /** Filesystem-safe version of `name`. Use for saving and display. */
  safeName: string;
  safeType: string;
}

export function toSafeFiles(files: readonly OfferedFile[]): SafeOfferedFile[] {
  return files.map((file) => ({
    ...file,
    safeName: sanitizeFilename(file.name, `file-${file.index + 1}`),
    safeType: sanitizeMimeType(file.type),
  }));
}

// ---------------------------------------------------------------------------
// Binary chunk frames

export interface ChunkHeader {
  transferNo: number;
  fileIndex: number;
  seq: number;
  offset: number;
}

export function encodeChunk(header: ChunkHeader, payload: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(FRAME_HEADER_BYTES + payload.byteLength);
  const view = new DataView(buffer);
  view.setUint8(0, FRAME_MAGIC);
  view.setUint8(1, TRANSFER_PROTOCOL_VERSION);
  view.setUint16(2, 0);
  view.setUint32(4, header.transferNo);
  view.setUint32(8, header.fileIndex);
  view.setUint32(12, header.seq);
  view.setFloat64(16, header.offset);
  new Uint8Array(buffer, FRAME_HEADER_BYTES).set(payload);
  return buffer;
}

export type ChunkDecodeResult =
  | { ok: true; header: ChunkHeader; payload: Uint8Array }
  | { ok: false; error: string };

export function decodeChunk(buffer: ArrayBuffer): ChunkDecodeResult {
  if (buffer.byteLength < FRAME_HEADER_BYTES) return { ok: false, error: 'frame too short' };
  const view = new DataView(buffer);
  if (view.getUint8(0) !== FRAME_MAGIC) return { ok: false, error: 'bad frame magic' };
  if (view.getUint8(1) !== TRANSFER_PROTOCOL_VERSION) return { ok: false, error: 'unsupported frame version' };
  const offset = view.getFloat64(16);
  if (!Number.isSafeInteger(offset) || offset < 0) return { ok: false, error: 'bad frame offset' };
  return {
    ok: true,
    header: {
      transferNo: view.getUint32(4),
      fileIndex: view.getUint32(8),
      seq: view.getUint32(12),
      offset,
    },
    payload: new Uint8Array(buffer, FRAME_HEADER_BYTES),
  };
}

/**
 * Picks a chunk payload size that fits in one SCTP message for this
 * connection. `maxMessageSize` comes from RTCSctpTransport and reflects the
 * remote peer's limit; 0 or undefined means "unknown".
 */
export function chooseChunkSize(maxMessageSize: number | null | undefined): number {
  if (!maxMessageSize || !Number.isFinite(maxMessageSize) || maxMessageSize <= 0) {
    return maxMessageSize === Infinity ? DEFAULT_CHUNK_BYTES : CONSERVATIVE_CHUNK_BYTES;
  }
  const fit = Math.floor(maxMessageSize) - FRAME_HEADER_BYTES;
  return Math.max(MIN_CHUNK_BYTES, Math.min(DEFAULT_CHUNK_BYTES, fit));
}

/** Receiver acknowledgement interval that guarantees the sender can always make progress. */
export function ackIntervalFor(windowBytes: number, chunkSize: number): number {
  return Math.max(chunkSize, Math.min(1024 * 1024, Math.floor((windowBytes - chunkSize) / 2)));
}
