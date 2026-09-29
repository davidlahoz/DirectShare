/**
 * Minimal external store for useSyncExternalStore. Sessions own mutable
 * state and publish immutable snapshots, throttled for progress updates.
 */
export class Store<T> {
  private listeners = new Set<() => void>();
  private pending: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private snapshot: T,
    private readonly throttleMs = 100,
  ) {}

  getSnapshot = (): T => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Publishes immediately (state changes that users must see without delay). */
  set(next: T): void {
    if (this.pending) {
      clearTimeout(this.pending);
      this.pending = undefined;
    }
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }

  /** Publishes at most every `throttleMs` (progress ticks). */
  setThrottled(build: () => T): void {
    if (this.pending) return;
    this.pending = setTimeout(() => {
      this.pending = undefined;
      this.set(build());
    }, this.throttleMs);
  }
}
