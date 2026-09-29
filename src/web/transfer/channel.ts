/**
 * The subset of RTCDataChannel used by the transfer engine. Keeping it
 * narrow lets tests drive FileSender/FileReceiver with an in-memory channel.
 */
export interface DataChannelLike {
  readonly readyState: RTCDataChannelState;
  readonly bufferedAmount: number;
  bufferedAmountLowThreshold: number;
  send(data: string | ArrayBuffer): void;
  close(): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  addEventListener(type: 'close' | 'error' | 'bufferedamountlow', listener: () => void): void;
  removeEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  removeEventListener(type: 'close' | 'error' | 'bufferedamountlow', listener: () => void): void;
}

/** Error used internally to unwind transfer loops once a transfer ended. */
export class TransferEnded extends Error {
  constructor() {
    super('transfer ended');
  }
}

/**
 * Condition waiter: `wait(cond)` resolves when `cond()` becomes true after a
 * `wake()`, or rejects with TransferEnded once `abort()` is called. An
 * optional poll interval guards against browsers that skip
 * `bufferedamountlow` events.
 */
export class Waiters {
  private readonly checks = new Set<() => void>();
  private aborted = false;

  wait(cond: () => boolean, pollMs?: number): Promise<void> {
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setInterval> | undefined;
      const check = () => {
        if (this.aborted) {
          cleanup();
          reject(new TransferEnded());
        } else if (cond()) {
          cleanup();
          resolve();
        }
      };
      const cleanup = () => {
        this.checks.delete(check);
        if (timer) clearInterval(timer);
      };
      this.checks.add(check);
      if (pollMs) timer = setInterval(check, pollMs);
      check();
    });
  }

  wake(): void {
    for (const check of [...this.checks]) check();
  }

  abort(): void {
    this.aborted = true;
    this.wake();
  }
}
