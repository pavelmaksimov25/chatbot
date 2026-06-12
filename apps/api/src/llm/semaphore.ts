/** Thrown when the wait queue is full — the caller should answer "at capacity". */
export class QueueFullError extends Error {
  constructor(queued: number) {
    super(`admission queue is full (${queued} waiting)`);
  }
}

interface Waiter {
  resolve: (release: () => void) => void;
}

/**
 * IO-bound concurrency semaphore with a FIFO wait queue and backpressure
 * (see DECISIONS.md, slice 12). The "worker pool" of the original spec — a
 * cap on in-flight LLM requests, not OS threads.
 */
export class Semaphore {
  private inFlightCount = 0;
  private waiters: Waiter[] = [];

  constructor(
    private limit: number,
    private readonly maxQueue: number,
  ) {}

  get inFlight(): number {
    return this.inFlightCount;
  }

  get queued(): number {
    return this.waiters.length;
  }

  get currentLimit(): number {
    return this.limit;
  }

  /** Raising the limit admits waiters immediately; lowering drains naturally. */
  setLimit(limit: number): void {
    this.limit = limit;
    this.admit();
  }

  acquire(): Promise<() => void> {
    if (this.inFlightCount < this.limit) {
      this.inFlightCount += 1;
      return Promise.resolve(this.releaser());
    }
    if (this.waiters.length >= this.maxQueue) {
      return Promise.reject(new QueueFullError(this.waiters.length));
    }
    return new Promise<() => void>((resolve) => {
      this.waiters.push({ resolve });
    });
  }

  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) {
        return; // double-release must not corrupt the count
      }
      released = true;
      this.inFlightCount -= 1;
      this.admit();
    };
  }

  private admit(): void {
    while (this.inFlightCount < this.limit && this.waiters.length > 0) {
      const waiter = this.waiters.shift()!;
      this.inFlightCount += 1;
      waiter.resolve(this.releaser());
    }
  }
}
