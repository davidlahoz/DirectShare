/**
 * In-memory DataChannel pair for tests. Messages are delivered
 * asynchronously at a configurable rate so `bufferedAmount` behaves like a
 * real send buffer, and the network can be paused to exercise backpressure.
 */
import type { DataChannelLike } from './channel';

type Listener = (event: { data: unknown }) => void;

export class FakeChannel implements DataChannelLike {
  readyState: RTCDataChannelState = 'open';
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  peer!: FakeChannel;
  paused = false;
  /** Every message this side sent, in order (for assertions). */
  readonly sent: Array<string | ArrayBuffer> = [];
  maxBuffered = 0;

  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly queue: Array<{ data: string | ArrayBuffer; size: number }> = [];
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    /** Bytes delivered per tick. */
    public bytesPerTick = 256 * 1024,
    private readonly tickMs = 0,
  ) {}

  static pair(bytesPerTick?: number, tickMs?: number): [FakeChannel, FakeChannel] {
    const a = new FakeChannel(bytesPerTick, tickMs);
    const b = new FakeChannel(bytesPerTick, tickMs);
    a.peer = b;
    b.peer = a;
    return [a, b];
  }

  send(data: string | ArrayBuffer): void {
    if (this.readyState !== 'open') throw new DOMException('DataChannel is not open', 'InvalidStateError');
    const size = typeof data === 'string' ? data.length : data.byteLength;
    this.sent.push(data);
    this.queue.push({ data, size });
    this.bufferedAmount += size;
    this.maxBuffered = Math.max(this.maxBuffered, this.bufferedAmount);
    this.schedule();
  }

  close(): void {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    this.queue.length = 0;
    this.bufferedAmount = 0;
    clearTimeout(this.timer);
    setTimeout(() => this.emit('close'), 0);
    if (this.peer.readyState !== 'closed') this.peer.close();
  }

  resume(): void {
    this.paused = false;
    this.schedule();
  }

  /** Test helper: inject a message as if the peer had sent it. */
  inject(data: string | ArrayBuffer): void {
    this.emit('message', { data });
  }

  addEventListener(type: string, listener: Listener | (() => void)): void {
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    set.add(listener as Listener);
  }

  removeEventListener(type: string, listener: Listener | (() => void)): void {
    this.listeners.get(type)?.delete(listener as Listener);
  }

  private emit(type: string, event: { data: unknown } = { data: undefined }): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
  }

  private schedule(): void {
    if (this.timer || this.paused || this.readyState !== 'open') return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.deliver();
    }, this.tickMs);
  }

  private deliver(): void {
    if (this.paused || this.readyState !== 'open') return;
    let budget = this.bytesPerTick;
    while (this.queue.length > 0 && budget > 0) {
      const item = this.queue.shift()!;
      budget -= item.size;
      const before = this.bufferedAmount;
      this.bufferedAmount -= item.size;
      if (this.peer.readyState === 'open') this.peer.emit('message', { data: item.data });
      if (before > this.bufferedAmountLowThreshold && this.bufferedAmount <= this.bufferedAmountLowThreshold) {
        this.emit('bufferedamountlow');
      }
    }
    if (this.queue.length > 0) this.schedule();
  }
}
