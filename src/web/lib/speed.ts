/** Rolling-window throughput estimate for speed and time-remaining display. */
export class SpeedMeter {
  private samples: Array<{ t: number; bytes: number }> = [];

  constructor(
    private readonly windowMs = 4000,
    private readonly now: () => number = () => performance.now(),
  ) {}

  /** Records the cumulative byte count. */
  update(totalBytes: number): void {
    const t = this.now();
    this.samples.push({ t, bytes: totalBytes });
    while (this.samples.length > 2 && t - this.samples[0]!.t > this.windowMs) this.samples.shift();
  }

  reset(): void {
    this.samples = [];
  }

  bytesPerSecond(): number {
    if (this.samples.length < 2) return 0;
    const first = this.samples[0]!;
    const last = this.samples[this.samples.length - 1]!;
    const dt = (last.t - first.t) / 1000;
    return dt > 0.25 ? Math.max(0, (last.bytes - first.bytes) / dt) : 0;
  }

  etaSeconds(remainingBytes: number): number | undefined {
    const speed = this.bytesPerSecond();
    return speed > 0 ? remainingBytes / speed : undefined;
  }
}
