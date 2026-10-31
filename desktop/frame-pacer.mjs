// Emits fixed-size audio frames at a steady wall-clock rate.
//
// setInterval(fn, 100) does NOT fire every 100 ms on Windows: timers tick at roughly 15.6 ms,
// so each "100 ms" tick lands ~109 ms apart. Pulling exactly one 100 ms frame per tick therefore
// consumes audio about 9% slower than the microphone produces it. The backlog grows until the
// queue's cap, after which the oldest audio is dropped: transcripts arrive seconds late AND have
// words missing. Pacing against a monotonic clock removes the drift.

export class FramePacer {
  constructor({ frameMs, now = () => performance.now(), maxBurstFrames = 30 }) {
    this.frameMs = frameMs;
    this.now = now;
    this.maxBurstFrames = maxBurstFrames;
    this.startedAt = null;
    this.emitted = 0;
  }

  start() {
    this.startedAt = this.now();
    this.emitted = 0;
  }

  /** How many frames should be emitted right now to keep to real time. */
  due() {
    if (this.startedAt === null) this.start();
    const target = Math.floor((this.now() - this.startedAt) / this.frameMs);
    const count = target - this.emitted;
    if (count <= 0) return 0;
    this.emitted = target;
    // After a long stall, send a bounded burst instead of an unbounded one.
    return Math.min(count, this.maxBurstFrames);
  }
}
