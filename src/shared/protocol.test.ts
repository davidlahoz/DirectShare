import { describe, expect, it } from 'vitest';
import { isStunUrl } from './config';
import { sanitizeDisplayName, sanitizeFilename, sanitizeMimeType } from './sanitize';
import { parseClientMessage, parseServerMessage } from './signaling';
import {
  ackIntervalFor,
  chooseChunkSize,
  decodeChunk,
  encodeChunk,
  encodeControl,
  FRAME_HEADER_BYTES,
  parseControlMessage,
} from './transfer';

const offer = (over: Record<string, unknown> = {}) => ({
  v: 1,
  type: 'offer',
  transferId: 'transfer-01',
  transferNo: 1,
  chunkSize: 16384,
  windowBytes: 1048576,
  files: [
    { fileId: 'file-0001', index: 0, name: 'a.txt', size: 10, type: 'text/plain' },
    { fileId: 'file-0002', index: 1, name: 'b.txt', size: 5, type: '' },
  ],
  totalBytes: 15,
  shareFileCount: 2,
  ...over,
});

describe('transfer protocol: control messages', () => {
  it('accepts a valid offer', () => {
    const result = parseControlMessage(JSON.stringify(offer()));
    expect(result.ok).toBe(true);
  });

  it('round-trips through encodeControl', () => {
    const raw = encodeControl({ type: 'ack', transferId: 'transfer-01', fileId: 'file-0001', bytes: 42 });
    const parsed = parseControlMessage(raw);
    expect(parsed).toEqual({ ok: true, message: { v: 1, type: 'ack', transferId: 'transfer-01', fileId: 'file-0001', bytes: 42 } });
  });

  it.each([
    ['totals that do not add up', offer({ totalBytes: 16 })],
    ['non-sequential indexes', offer({ files: [{ fileId: 'file-0001', index: 1, name: 'a', size: 1, type: '' }], totalBytes: 1 })],
    ['duplicate file ids', offer({ files: [
      { fileId: 'file-0001', index: 0, name: 'a', size: 1, type: '' },
      { fileId: 'file-0001', index: 1, name: 'b', size: 1, type: '' },
    ], totalBytes: 2 })],
    ['negative sizes', offer({ files: [{ fileId: 'file-0001', index: 0, name: 'a', size: -1, type: '' }], totalBytes: -1 })],
    ['fractional sizes', offer({ files: [{ fileId: 'file-0001', index: 0, name: 'a', size: 1.5, type: '' }], totalBytes: 1.5 })],
    ['empty names', offer({ files: [{ fileId: 'file-0001', index: 0, name: '', size: 1, type: '' }], totalBytes: 1 })],
    ['oversized chunks', offer({ chunkSize: 10 * 1024 * 1024 })],
    ['a window smaller than two chunks', offer({ chunkSize: 200_000, windowBytes: 300_000 })],
    ['no files', offer({ files: [], totalBytes: 0 })],
    ['unknown fields', offer({ extra: true })],
    ['bad identifiers', offer({ transferId: 'x' })],
  ])('rejects offers with %s', (_label, msg) => {
    const result = parseControlMessage(JSON.stringify(msg));
    expect(result.ok).toBe(false);
  });

  it('distinguishes unsupported versions from malformed messages', () => {
    expect(parseControlMessage(JSON.stringify({ ...offer(), v: 2 }))).toMatchObject({ ok: false, code: 'unsupported-version' });
    expect(parseControlMessage('{"type":"offer"}')).toMatchObject({ ok: false, code: 'unsupported-version' });
    expect(parseControlMessage('nope')).toMatchObject({ ok: false, code: 'protocol-error' });
    expect(parseControlMessage('[1,2]')).toMatchObject({ ok: false, code: 'protocol-error' });
    expect(parseControlMessage(JSON.stringify({ v: 1, type: 'launch-missiles' }))).toMatchObject({ ok: false, code: 'protocol-error' });
    expect(parseControlMessage('x'.repeat(600 * 1024))).toMatchObject({ ok: false, code: 'protocol-error' });
  });

  it('rejects unknown completion states', () => {
    const msg = { v: 1, type: 'file-complete', transferId: 'transfer-01', fileId: 'file-0001', bytes: 1, saved: 'probably' };
    expect(parseControlMessage(JSON.stringify(msg)).ok).toBe(false);
  });
});

describe('transfer protocol: binary frames', () => {
  it('encodes and decodes headers and payload', () => {
    const payload = new Uint8Array([1, 2, 3, 4, 5]);
    const frame = encodeChunk({ transferNo: 9, fileIndex: 3, seq: 77, offset: 2 ** 40 }, payload);
    expect(frame.byteLength).toBe(FRAME_HEADER_BYTES + 5);
    const decoded = decodeChunk(frame);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.header).toEqual({ transferNo: 9, fileIndex: 3, seq: 77, offset: 2 ** 40 });
    expect(Array.from(decoded.payload)).toEqual([1, 2, 3, 4, 5]);
  });

  it('rejects short frames, bad magic, other versions and bad offsets', () => {
    expect(decodeChunk(new ArrayBuffer(10)).ok).toBe(false);
    const frame = encodeChunk({ transferNo: 1, fileIndex: 0, seq: 0, offset: 0 }, new Uint8Array(1));
    const badMagic = frame.slice(0);
    new DataView(badMagic).setUint8(0, 0);
    expect(decodeChunk(badMagic).ok).toBe(false);
    const badVersion = frame.slice(0);
    new DataView(badVersion).setUint8(1, 2);
    expect(decodeChunk(badVersion).ok).toBe(false);
    const badOffset = frame.slice(0);
    new DataView(badOffset).setFloat64(16, 1.5);
    expect(decodeChunk(badOffset).ok).toBe(false);
    new DataView(badOffset).setFloat64(16, -1);
    expect(decodeChunk(badOffset).ok).toBe(false);
  });

  it('chooses chunk sizes that fit the negotiated SCTP message size', () => {
    expect(chooseChunkSize(262144)).toBe(64 * 1024);
    expect(chooseChunkSize(16 * 1024)).toBe(16 * 1024 - FRAME_HEADER_BYTES);
    expect(chooseChunkSize(0)).toBe(16 * 1024);
    expect(chooseChunkSize(undefined)).toBe(16 * 1024);
    expect(chooseChunkSize(Infinity)).toBe(64 * 1024);
    expect(chooseChunkSize(100)).toBe(1024);
  });

  it('ack interval always lets the sender make progress', () => {
    for (const [windowBytes, chunk] of [[256 * 1024, 64 * 1024], [8 * 1024 * 1024, 64 * 1024], [131072, 65536]] as const) {
      const every = ackIntervalFor(windowBytes, chunk);
      expect(every).toBeGreaterThanOrEqual(chunk);
      expect(every).toBeLessThanOrEqual(windowBytes - chunk);
    }
  });
});

describe('signaling protocol', () => {
  it('accepts valid client messages', () => {
    expect(parseClientMessage('{"type":"create-room"}').ok).toBe(true);
    expect(parseClientMessage(JSON.stringify({ type: 'join', roomId: 'A'.repeat(22), displayName: 'Ana' })).ok).toBe(true);
  });

  it.each([
    ['invalid JSON', '{'],
    ['unknown types', '{"type":"upload","data":"..."}'],
    ['extra fields', JSON.stringify({ type: 'create-room', files: ['a'] })],
    ['short room ids', JSON.stringify({ type: 'join', roomId: 'abc' })],
    ['room ids with path characters', JSON.stringify({ type: 'join', roomId: '../../../../etc/passwd' })],
    ['oversized SDP', JSON.stringify({ type: 'signal', data: { kind: 'offer', cid: 'abcdefgh', sdp: 'x'.repeat(40_000) } })],
    ['unknown signal kinds', JSON.stringify({ type: 'signal', data: { kind: 'file-chunk', cid: 'abcdefgh' } })],
  ])('rejects %s', (_label, raw) => {
    expect(parseClientMessage(raw).ok).toBe(false);
  });

  it('enforces the message size limit before parsing', () => {
    expect(parseClientMessage(`{"type":"ping","pad":"${'x'.repeat(70_000)}"}`).ok).toBe(false);
  });

  it('validates messages from the server too', () => {
    expect(parseServerMessage('{"type":"approved"}').ok).toBe(true);
    expect(parseServerMessage('{"type":"approved","evil":1}').ok).toBe(false);
  });
});

describe('sanitizers', () => {
  it.each([
    ['../../etc/passwd', '_.._etc_passwd'],
    ['C:\\Windows\\system32\\evil.dll', 'C__Windows_system32_evil.dll'],
    ['.bashrc', 'bashrc'],
    ['CON', '_CON'],
    ['nul.txt', '_nul.txt'],
    ['report.pdf.   ', 'report.pdf'],
    ['a\u0000b\u001fc.txt', 'abc.txt'],
    ['photo\u202Egpj.exe', 'photogpj.exe'],
    ['', 'file'],
    ['...', 'file'],
    ['   ', 'file'],
    ['normal name (1).jpg', 'normal name (1).jpg'],
  ])('sanitizeFilename(%j) = %j', (input, expected) => {
    expect(sanitizeFilename(input)).toBe(expected);
  });

  it('limits long file names while keeping the extension', () => {
    const name = sanitizeFilename(`${'a'.repeat(500)}.tar.gz`);
    expect(name.length).toBeLessThanOrEqual(200);
    expect(name.endsWith('.gz')).toBe(true);
  });

  it('cleans display names', () => {
    expect(sanitizeDisplayName('  Ana \n Maria  ')).toBe('Ana Maria');
    expect(sanitizeDisplayName('\u202E\u0000')).toBeUndefined();
    expect(sanitizeDisplayName(42)).toBeUndefined();
    expect(sanitizeDisplayName('x'.repeat(100))).toHaveLength(40);
    expect(sanitizeDisplayName('<script>alert(1)</script>')).toBe('<script>alert(1)</script>'); // rendered as text by React
  });

  it('normalizes MIME types', () => {
    expect(sanitizeMimeType('Image/PNG')).toBe('image/png');
    expect(sanitizeMimeType('text/html; charset=utf-8')).toBe('application/octet-stream');
    expect(sanitizeMimeType(undefined)).toBe('application/octet-stream');
  });

  it('only accepts STUN URLs', () => {
    expect(isStunUrl('stun:stun.l.google.com:19302')).toBe(true);
    expect(isStunUrl('stuns:example.com:5349')).toBe(true);
    expect(isStunUrl('turn:example.com:3478')).toBe(false);
    expect(isStunUrl('stun:exa mple.com')).toBe(false);
  });
});
