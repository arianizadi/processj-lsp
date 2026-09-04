/**
 * A small latest-work-wins queue for expensive, abortable background jobs.
 *
 * Scheduling the same key again drops its pending job and aborts its active one.
 * The replacement is debounced, then joins a bounded FIFO shared by all keys.
 * This keeps a burst of document changes from spawning one process per version,
 * while still allowing a small amount of useful cross-document parallelism.
 */
export class LatestTaskQueue<K> {
  private readonly timers = new Map<K, ReturnType<typeof setTimeout>>();
  private readonly queued = new Map<K, (signal: AbortSignal) => Promise<void>>();
  private readonly active = new Map<K, AbortController>();

  constructor(
    private readonly concurrency: number,
    private readonly onError: (error: unknown) => void = () => {},
  ) {
    if (!Number.isInteger(concurrency) || concurrency < 1) throw new RangeError('concurrency must be a positive integer');
  }

  schedule(key: K, delayMs: number, task: (signal: AbortSignal) => Promise<void>): void {
    this.cancel(key);
    const enqueue = () => {
      this.timers.delete(key);
      // Deleting first moves a replacement to the back of the FIFO.
      this.queued.delete(key);
      this.queued.set(key, task);
      this.pump();
    };
    if (delayMs <= 0) enqueue();
    else this.timers.set(key, setTimeout(enqueue, delayMs));
  }

  cancel(key: K): void {
    const timer = this.timers.get(key);
    if (timer) clearTimeout(timer);
    this.timers.delete(key);
    this.queued.delete(key);
    this.active.get(key)?.abort();
  }

  private pump(): void {
    while (this.active.size < this.concurrency && this.queued.size > 0) {
      // An aborted child may take a moment to emit `close`. Do not overwrite its
      // controller with a replacement for the same key: that would under-count
      // live processes and could exceed the global concurrency bound.
      let next: [K, (signal: AbortSignal) => Promise<void>] | undefined;
      for (const entry of this.queued) {
        if (!this.active.has(entry[0])) {
          next = entry;
          break;
        }
      }
      if (!next) return;
      const [key, task] = next;
      this.queued.delete(key);
      const controller = new AbortController();
      this.active.set(key, controller);
      void Promise.resolve()
        .then(() => task(controller.signal))
        .catch(this.onError)
        .finally(() => {
          if (this.active.get(key) === controller) this.active.delete(key);
          this.pump();
        });
    }
  }
}
