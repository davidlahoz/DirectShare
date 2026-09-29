import { describe, expect, it, vi } from 'vitest';
import { encodeChunk, encodeControl, parseControlMessage } from '../../shared/transfer';
import type { FileSink, SinkFactory } from '../storage/sinks';
import { MemorySinkFactory, StorageError } from '../storage/sinks';
import { FakeChannel } from './fakeChannel';
import { FileReceiver } from './FileReceiver';
import { FileSender, type OutgoingFile } from './FileSender';

// ---------------------------------------------------------------- helpers

function pattern(size: number, seed = 1): Uint8Array {
  const data = new Uint8Array(size);
  let x = seed;
  for (let i = 0; i < size; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    data[i] = x & 0xff;
  }
  return data;
}

function outgoing(name: string, data: Uint8Array, fileId = `file-${name.replace(/\W/g, '')}-id`): OutgoingFile {
  return { fileId, blob: new Blob([data as BlobPart]), name, size: data.byteLength, type: 'application/octet-stream' };
}

interface RecordedFile {
  name: string;
  chunks: Uint8Array[];
  closed: boolean;
  aborted: boolean;
}

/** Sink factory that records everything and can simulate slow or failing storage. */
class RecordingSinkFactory implements SinkFactory {
  readonly mode = 'stream' as const;
  readonly confirmsSave = true;
  readonly destinationLabel = 'test';
  readonly files: RecordedFile[] = [];
  writeDelayMs = 0;
  failWriteAfterBytes: number | undefined;
  closeGate: Promise<void> | undefined;
  private written = 0;

  async open(file: { safeName: string }): Promise<FileSink> {
    const rec: RecordedFile = { name: file.safeName, chunks: [], closed: false, aborted: false };
    this.files.push(rec);
    return {
      savedName: file.safeName,
      write: async (chunk) => {
        if (this.writeDelayMs) await new Promise((r) => setTimeout(r, this.writeDelayMs));
        this.written += chunk.byteLength;
        if (this.failWriteAfterBytes !== undefined && this.written > this.failWriteAfterBytes) {
          throw new DOMException('disk full', 'QuotaExceededError');
        }
        rec.chunks.push(chunk.slice());
      },
      close: async () => {
        if (this.closeGate) await this.closeGate;
        rec.closed = true;
      },
      abort: async () => {
        rec.aborted = true;
      },
    };
  }

  dispose(): void {}

  bytesOf(index: number): Uint8Array {
    const rec = this.files[index]!;
    const total = rec.chunks.reduce((n, c) => n + c.byteLength, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const c of rec.chunks) {
      out.set(c, offset);
      offset += c.byteLength;
    }
    return out;
  }
}

function expectSameBytes(actual: Uint8Array, expected: Uint8Array): void {
  expect(actual.byteLength).toBe(expected.byteLength);
  expect(Buffer.compare(actual, expected)).toBe(0);
}

function until(cond: () => boolean, timeoutMs = 10_000): Promise<void> {
  return vi.waitFor(() => {
    if (!cond()) throw new Error('condition not met');
  }, { timeout: timeoutMs, interval: 2 });
}

function setup(files: OutgoingFile[], opts: Partial<ConstructorParameters<typeof FileSender>[0]> = {}, channelRate?: number) {
  const [senderSide, receiverSide] = FakeChannel.pair(channelRate);
  const confirmed: Array<{ fileId: string; saved: string }> = [];
  const senderStates: string[] = [];
  const sender = new FileSender({
    channel: senderSide,
    files,
    transferId: 'transfer-0001',
    transferNo: 1,
    chunkSize: 16 * 1024,
    shareFileCount: files.length,
    ...opts,
    events: {
      onFileConfirmed: (fileId, saved) => confirmed.push({ fileId, saved }),
      onStateChange: (s) => senderStates.push(s),
      ...opts.events,
    },
  });
  const receiverStates: string[] = [];
  const receiver = new FileReceiver(receiverSide, { onStateChange: (s) => receiverStates.push(s) });
  return { senderSide, receiverSide, sender, receiver, confirmed, senderStates, receiverStates };
}

// ------------------------------------------------------------------ tests

describe('file transfer', () => {
  it('transfers several files sequentially and byte-exactly', async () => {
    const a = pattern(100_000, 1);
    const b = pattern(0, 2);
    const c = pattern(70_001, 3);
    const t = setup([outgoing('a.bin', a), outgoing('empty.txt', b), outgoing('c.bin', c)]);
    const sink = new RecordingSinkFactory();
    t.sender.start();
    await until(() => t.receiver.state === 'awaiting-acceptance');
    expect(t.receiver.offer?.files.map((f) => f.safeName)).toEqual(['a.bin', 'empty.txt', 'c.bin']);
    expect(t.receiver.offer?.totalBytes).toBe(170_001);

    t.receiver.accept(sink);
    await until(() => t.sender.state === 'completed');
    expect(t.receiver.state).toBe('completed');
    expect(sink.files.map((f) => f.name)).toEqual(['a.bin', 'empty.txt', 'c.bin']);
    expectSameBytes(sink.bytesOf(0), a);
    expectSameBytes(sink.bytesOf(1), b);
    expectSameBytes(sink.bytesOf(2), c);
    expect(sink.files.every((f) => f.closed && !f.aborted)).toBe(true);
    expect(t.confirmed.map((c) => c.fileId)).toEqual(['file-abin-id', 'file-emptytxt-id', 'file-cbin-id']);
    expect(t.confirmed.every((c) => c.saved === 'confirmed')).toBe(true);
  });

  it('sends file N+1 only after file N was confirmed', async () => {
    const t = setup([outgoing('one', pattern(40_000)), outgoing('two', pattern(40_000, 9))]);
    const sink = new RecordingSinkFactory();
    let release!: () => void;
    sink.closeGate = new Promise((r) => (release = r));
    t.sender.start();
    await until(() => t.receiver.state === 'awaiting-acceptance');
    t.receiver.accept(sink);
    await until(() => t.senderSide.sent.some((m) => typeof m === 'string' && m.includes('"file-end"')));
    await new Promise((r) => setTimeout(r, 30));
    const started = t.senderSide.sent.filter((m) => typeof m === 'string' && m.includes('"file-start"'));
    expect(started).toHaveLength(1);
    expect(t.confirmed).toHaveLength(0);
    release();
    await until(() => t.sender.state === 'completed');
    expect(t.confirmed).toHaveLength(2);
  });

  it('does not report success until the destination file is closed', async () => {
    const t = setup([outgoing('slow-close.bin', pattern(50_000))]);
    const sink = new RecordingSinkFactory();
    let release!: () => void;
    sink.closeGate = new Promise((r) => (release = r));
    t.sender.start();
    await until(() => t.receiver.state === 'awaiting-acceptance');
    t.receiver.accept(sink);
    // All bytes delivered and written, but close() has not finished.
    await until(() => sink.files[0]?.chunks.reduce((n, c) => n + c.byteLength, 0) === 50_000);
    await new Promise((r) => setTimeout(r, 30));
    expect(t.confirmed).toHaveLength(0);
    expect(t.sender.state).toBe('transferring');
    release();
    await until(() => t.confirmed.length === 1);
    expect(t.sender.state).toBe('completed');
  });

  it('reports memory-fallback deliveries as unconfirmed saves', async () => {
    const t = setup([outgoing('small.txt', pattern(5000))]);
    const downloads: Array<{ name: string; size: number }> = [];
    const factory = new MemorySinkFactory(1024 * 1024, (blob, name) => downloads.push({ name, size: blob.size }));
    t.sender.start();
    await until(() => t.receiver.state === 'awaiting-acceptance');
    t.receiver.accept(factory);
    await until(() => t.sender.state === 'completed');
    expect(downloads).toEqual([{ name: 'small.txt', size: 5000 }]);
    expect(t.confirmed).toEqual([{ fileId: 'file-smalltxt-id', saved: 'unconfirmed' }]);
  });

  it('handles rejection without sending any file data', async () => {
    const t = setup([outgoing('x', pattern(10_000))]);
    t.sender.start();
    await until(() => t.receiver.state === 'awaiting-acceptance');
    t.receiver.reject('declined');
    await until(() => t.sender.state === 'rejected');
    expect(t.senderSide.sent.some((m) => typeof m !== 'string')).toBe(false);
  });
});

describe('backpressure and flow control', () => {
  it('stops sending when the DataChannel buffer is full and resumes on bufferedamountlow', async () => {
    const data = pattern(4 * 1024 * 1024);
    const t = setup([outgoing('big', data)], { highWaterMark: 256 * 1024, lowWaterMark: 64 * 1024, windowBytes: 8 * 1024 * 1024 });
    const sink = new RecordingSinkFactory();
    t.sender.start();
    await until(() => t.receiver.state === 'awaiting-acceptance');
    t.senderSide.paused = true;
    t.receiver.accept(sink);
    await new Promise((r) => setTimeout(r, 50));
    const bufferedWhilePaused = t.senderSide.bufferedAmount;
    // The sender must stop at the high-water mark (+ one chunk and small control frames).
    expect(bufferedWhilePaused).toBeGreaterThan(0);
    expect(bufferedWhilePaused).toBeLessThanOrEqual(256 * 1024 + 16 * 1024 + 4096);
    t.senderSide.resume();
    await until(() => t.sender.state === 'completed');
    expectSameBytes(sink.bytesOf(0), data);
    expect(t.senderSide.maxBuffered).toBeLessThanOrEqual(256 * 1024 + 16 * 1024 + 4096);
  });

  it('bounds unacknowledged data by the receiver window when storage is slow', async () => {
    const data = pattern(3 * 1024 * 1024, 5);
    const windowBytes = 512 * 1024;
    const t = setup([outgoing('slow', data)], { windowBytes, highWaterMark: 4 * 1024 * 1024 });
    const sink = new RecordingSinkFactory();
    sink.writeDelayMs = 1;
    t.sender.start();
    await until(() => t.receiver.state === 'awaiting-acceptance');
    t.receiver.accept(sink);
    await until(() => t.sender.state === 'completed', 20_000);
    expectSameBytes(sink.bytesOf(0), data);
    expect(t.sender.maxInFlightObserved).toBeLessThanOrEqual(windowBytes);
    expect(t.receiver.maxQueuedObserved).toBeLessThanOrEqual(windowBytes + 16 * 1024);
  });

  it('keeps memory bounded for a large transfer (64 MB)', async () => {
    const size = 64 * 1024 * 1024;
    // A Blob made of repeated parts avoids allocating a 64 MB test buffer.
    const part = pattern(1024 * 1024, 7);
    const blob = new Blob(Array.from({ length: 64 }, () => part as BlobPart));
    const file: OutgoingFile = { fileId: 'large-file-id', blob, name: 'large.bin', size, type: '' };
    const windowBytes = 4 * 1024 * 1024;
    const t = setup([file], { chunkSize: 64 * 1024, windowBytes, highWaterMark: 1024 * 1024 }, 1024 * 1024);
    let written = 0;
    let checksumOk = true;
    const factory: SinkFactory = {
      mode: 'stream',
      confirmsSave: true,
      destinationLabel: 'counter',
      dispose() {},
      async open() {
        return {
          savedName: 'large.bin',
          write: async (chunk: Uint8Array) => {
            // Spot-check content without retaining it.
            const expected = part[written % part.byteLength];
            if (chunk[0] !== expected) checksumOk = false;
            written += chunk.byteLength;
          },
          close: async () => undefined,
          abort: async () => undefined,
        };
      },
    };
    t.sender.start();
    await until(() => t.receiver.state === 'awaiting-acceptance');
    t.receiver.accept(factory);
    await until(() => t.sender.state === 'completed', 60_000);
    expect(written).toBe(size);
    expect(checksumOk).toBe(true);
    expect(t.sender.maxInFlightObserved).toBeLessThanOrEqual(windowBytes);
    expect(t.senderSide.maxBuffered).toBeLessThanOrEqual(1024 * 1024 + 64 * 1024 + 4096);
    expect(t.receiver.maxQueuedObserved).toBeLessThanOrEqual(windowBytes + 64 * 1024);
  }, 90_000);
});

describe('cancellation and failures', () => {
  it('receiver cancel stops the sender and removes the partial file', async () => {
    const t = setup([outgoing('big', pattern(2 * 1024 * 1024))], { windowBytes: 256 * 1024 });
    const sink = new RecordingSinkFactory();
    sink.writeDelayMs = 2;
    t.sender.start();
    await until(() => t.receiver.state === 'awaiting-acceptance');
    t.receiver.accept(sink);
    await until(() => (sink.files[0]?.chunks.length ?? 0) > 2);
    t.receiver.cancel();
    await until(() => t.sender.state === 'canceled');
    expect(t.receiver.state).toBe('canceled');
    await until(() => sink.files[0]!.aborted);
    expect(sink.files[0]!.closed).toBe(false);
    expect(t.confirmed).toHaveLength(0);
  });

  it('sender cancel stops the receiver', async () => {
    const t = setup([outgoing('big', pattern(2 * 1024 * 1024))], { windowBytes: 256 * 1024 });
    const sink = new RecordingSinkFactory();
    sink.writeDelayMs = 2;
    t.sender.start();
    await until(() => t.receiver.state === 'awaiting-acceptance');
    t.receiver.accept(sink);
    await until(() => (sink.files[0]?.chunks.length ?? 0) > 1);
    t.sender.cancel('user');
    await until(() => t.receiver.state === 'canceled');
    expect(t.sender.state).toBe('canceled');
    await until(() => sink.files[0]!.aborted);
  });

  it('write failures are reported to the sender and never count as success', async () => {
    const t = setup([outgoing('f', pattern(300_000))]);
    const sink = new RecordingSinkFactory();
    sink.failWriteAfterBytes = 100_000;
    t.sender.start();
    await until(() => t.receiver.state === 'awaiting-acceptance');
    t.receiver.accept(sink);
    await until(() => t.sender.state === 'failed');
    expect(t.receiver.state).toBe('failed');
    expect(t.confirmed).toHaveLength(0);
    await until(() => sink.files[0]!.aborted);
  });

  it('a dropped connection after all bytes were sent leaves the file unconfirmed', async () => {
    const t = setup([outgoing('f', pattern(50_000))]);
    const sink = new RecordingSinkFactory();
    sink.closeGate = new Promise(() => undefined); // never finishes closing
    t.sender.start();
    await until(() => t.receiver.state === 'awaiting-acceptance');
    t.receiver.accept(sink);
    await until(() => t.sender.unconfirmedFileIds.length === 1);
    t.senderSide.close();
    await until(() => t.sender.state === 'failed');
    expect(t.sender.unconfirmedFileIds).toEqual(['file-f-id']);
    expect(t.confirmed).toHaveLength(0);
  });

  it('one failed receiver does not disturb another receiver of the same files', async () => {
    const data = pattern(1024 * 1024, 11);
    const files = () => [outgoing('shared.bin', data)];
    const good = setup(files(), { transferId: 'transfer-good' });
    const bad = setup(files(), { transferId: 'transfer-bad' });
    const goodSink = new RecordingSinkFactory();
    const badSink = new RecordingSinkFactory();
    badSink.writeDelayMs = 3;
    goodSink.writeDelayMs = 1;
    good.sender.start();
    bad.sender.start();
    await until(() => good.receiver.state === 'awaiting-acceptance' && bad.receiver.state === 'awaiting-acceptance');
    good.receiver.accept(goodSink);
    bad.receiver.accept(badSink);
    await until(() => (badSink.files[0]?.chunks.length ?? 0) > 2);
    bad.receiverSide.close(); // receiver B's tab closes mid-transfer
    await until(() => bad.sender.state === 'failed');
    await until(() => good.sender.state === 'completed');
    expectSameBytes(goodSink.bytesOf(0), data);
    expect(good.confirmed).toHaveLength(1);
    expect(bad.confirmed).toHaveLength(0);
  });
});

describe('protocol validation on the receiver', () => {
  async function acceptedReceiver() {
    const [senderSide, receiverSide] = FakeChannel.pair();
    const receiver = new FileReceiver(receiverSide);
    const sink = new RecordingSinkFactory();
    senderSide.addEventListener('message', () => undefined);
    receiverSide.inject(
      encodeControl({
        type: 'offer',
        transferId: 'transfer-0001',
        transferNo: 7,
        chunkSize: 1024,
        windowBytes: 256 * 1024,
        files: [{ fileId: 'file-00001', index: 0, name: '../../etc/passwd', size: 3000, type: 'text/plain' }],
        totalBytes: 3000,
        shareFileCount: 1,
      }),
    );
    expect(receiver.state).toBe('awaiting-acceptance');
    receiver.accept(sink);
    receiverSide.inject(encodeControl({ type: 'file-start', transferId: 'transfer-0001', fileId: 'file-00001', index: 0, size: 3000 }));
    return { receiver, receiverSide, senderSide, sink };
  }

  const errorsSent = (ch: FakeChannel) =>
    ch.sent.filter((m): m is string => typeof m === 'string').map((m) => parseControlMessage(m)).filter((p) => p.ok && p.message.type === 'error');

  it('sanitizes offered file names', async () => {
    const { receiver } = await acceptedReceiver();
    expect(receiver.offer!.files[0]!.safeName).toBe('_.._etc_passwd');
  });

  it('rejects out-of-sequence chunks', async () => {
    const { receiver, receiverSide, sink } = await acceptedReceiver();
    receiverSide.inject(encodeChunk({ transferNo: 7, fileIndex: 0, seq: 1, offset: 0 }, new Uint8Array(1000)));
    expect(receiver.state).toBe('failed');
    expect(errorsSent(receiverSide)).toHaveLength(1);
    await until(() => sink.files[0]?.aborted === true);
  });

  it('rejects chunks with a wrong offset', async () => {
    const { receiver, receiverSide } = await acceptedReceiver();
    receiverSide.inject(encodeChunk({ transferNo: 7, fileIndex: 0, seq: 0, offset: 0 }, new Uint8Array(1000)));
    receiverSide.inject(encodeChunk({ transferNo: 7, fileIndex: 0, seq: 1, offset: 999 }, new Uint8Array(1000)));
    expect(receiver.state).toBe('failed');
  });

  it('rejects chunks for another transfer or oversize chunks', async () => {
    const a = await acceptedReceiver();
    a.receiverSide.inject(encodeChunk({ transferNo: 8, fileIndex: 0, seq: 0, offset: 0 }, new Uint8Array(10)));
    expect(a.receiver.state).toBe('failed');
    const b = await acceptedReceiver();
    b.receiverSide.inject(encodeChunk({ transferNo: 7, fileIndex: 0, seq: 0, offset: 0 }, new Uint8Array(1025)));
    expect(b.receiver.state).toBe('failed');
  });

  it('rejects more data than announced and mismatched file-end counts', async () => {
    const a = await acceptedReceiver();
    a.receiverSide.inject(encodeChunk({ transferNo: 7, fileIndex: 0, seq: 0, offset: 0 }, new Uint8Array(1024)));
    a.receiverSide.inject(encodeChunk({ transferNo: 7, fileIndex: 0, seq: 1, offset: 1024 }, new Uint8Array(1024)));
    a.receiverSide.inject(encodeChunk({ transferNo: 7, fileIndex: 0, seq: 2, offset: 2048 }, new Uint8Array(1024)));
    expect(a.receiver.state).toBe('failed');

    const b = await acceptedReceiver();
    b.receiverSide.inject(encodeChunk({ transferNo: 7, fileIndex: 0, seq: 0, offset: 0 }, new Uint8Array(1000)));
    b.receiverSide.inject(encodeControl({ type: 'file-end', transferId: 'transfer-0001', fileId: 'file-00001', index: 0, bytes: 3000, chunks: 1 }));
    expect(b.receiver.state).toBe('failed');
    await until(() => b.sink.files[0]?.aborted === true);
    expect(b.sink.files[0]!.closed).toBe(false);
  });

  it('rejects malformed JSON, unknown versions and unexpected messages', () => {
    for (const bad of ['{not json', JSON.stringify({ v: 2, type: 'offer' }), encodeControl({ type: 'accept', transferId: 'transfer-0001', mode: 'stream' })]) {
      const [, receiverSide] = FakeChannel.pair();
      const receiver = new FileReceiver(receiverSide);
      receiverSide.inject(bad);
      expect(receiver.state).toBe('failed');
    }
  });

  it('rejects data that exceeds the flow-control window', async () => {
    const [, receiverSide] = FakeChannel.pair();
    const receiver = new FileReceiver(receiverSide);
    receiverSide.inject(
      encodeControl({
        type: 'offer',
        transferId: 'transfer-0001',
        transferNo: 1,
        chunkSize: 64 * 1024,
        windowBytes: 256 * 1024,
        files: [{ fileId: 'file-00001', index: 0, name: 'f', size: 10 * 1024 * 1024, type: '' }],
        totalBytes: 10 * 1024 * 1024,
        shareFileCount: 1,
      }),
    );
    const sink = new RecordingSinkFactory();
    sink.writeDelayMs = 50; // storage is slow, the sender ignores acks
    receiver.accept(sink);
    receiverSide.inject(encodeControl({ type: 'file-start', transferId: 'transfer-0001', fileId: 'file-00001', index: 0, size: 10 * 1024 * 1024 }));
    for (let seq = 0; seq < 10 && receiver.state === 'transferring'; seq++) {
      receiverSide.inject(encodeChunk({ transferNo: 1, fileIndex: 0, seq, offset: seq * 64 * 1024 }, new Uint8Array(64 * 1024)));
    }
    expect(receiver.state).toBe('failed');
  });
});

describe('protocol validation on the sender', () => {
  it('ignores duplicate completion acknowledgements', async () => {
    const t = setup([outgoing('a', pattern(2000)), outgoing('b', pattern(2000, 3))]);
    const sink = new RecordingSinkFactory();
    let release!: () => void;
    sink.closeGate = new Promise((r) => (release = r));
    t.sender.start();
    await until(() => t.receiver.state === 'awaiting-acceptance');
    t.receiver.accept(sink);
    await until(() => t.sender.unconfirmedFileIds.length === 1);
    release();
    await until(() => t.confirmed.length >= 1);
    // A buggy or malicious receiver repeats the acknowledgement.
    const dup = encodeControl({ type: 'file-complete', transferId: 'transfer-0001', fileId: 'file-a-id', bytes: 2000, saved: 'confirmed' });
    t.senderSide.inject(dup);
    t.senderSide.inject(dup);
    await until(() => t.sender.state === 'completed');
    expect(t.confirmed.filter((c) => c.fileId === 'file-a-id')).toHaveLength(1);
  });

  it('fails on a completion claim for a file that was never sent', async () => {
    const t = setup([outgoing('a', pattern(200_000))]);
    t.sender.start();
    await until(() => t.receiver.state === 'awaiting-acceptance');
    t.senderSide.inject(encodeControl({ type: 'accept', transferId: 'transfer-0001', mode: 'stream' }));
    t.senderSide.inject(encodeControl({ type: 'file-complete', transferId: 'transfer-0001', fileId: 'file-a-id', bytes: 200_000, saved: 'confirmed' }));
    expect(t.sender.state).toBe('failed');
    expect(t.confirmed).toHaveLength(0);
  });

  it('fails when the receiver sends binary data', async () => {
    const t = setup([outgoing('a', pattern(200))]);
    t.sender.start();
    t.senderSide.inject(new ArrayBuffer(10));
    expect(t.sender.state).toBe('failed');
  });
});

describe('storage errors', () => {
  it('reports quota errors to the sender as storage-full', async () => {
    const t = setup([outgoing('f', pattern(100_000))]);
    const sink = new RecordingSinkFactory();
    sink.failWriteAfterBytes = 10;
    t.sender.start();
    await until(() => t.receiver.state === 'awaiting-acceptance');
    t.receiver.accept(sink);
    await until(() => t.sender.state === 'failed');
    const codes = t.receiverSide.sent
      .filter((m): m is string => typeof m === 'string')
      .map((m) => parseControlMessage(m))
      .flatMap((p) => (p.ok && p.message.type === 'error' ? [p.message.code] : []));
    expect(codes).toEqual(['storage-full']);
  });

  it('memory fallback refuses files larger than the limit', async () => {
    const factory = new MemorySinkFactory(1000, () => undefined);
    await expect(factory.open({ safeName: 'x', size: 1001, safeType: '' })).rejects.toBeInstanceOf(StorageError);
  });
});
