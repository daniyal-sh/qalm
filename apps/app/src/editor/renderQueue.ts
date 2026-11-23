/**
 * A small job queue for expensive per-page work (PDF page renders, opening page docs): at most `concurrency` jobs run
 * at once, the lowest `priority` starts first and, among equals, the most recently requested one (the page the user
 * just scrolled to), and a job cancelled before it starts never runs (the page scrolled away again).
 */
export class RenderQueue {
  private waiting: { run: () => void; cancelled: boolean; priority: number }[] = [];
  private running = 0;

  constructor(private readonly concurrency = 2) {}

  get pending(): number {
    return this.waiting.filter((j) => !j.cancelled).length;
  }

  get active(): number {
    return this.running;
  }

  /** Queues `fn`. `cancel()` drops it if it hasn't started (a started job finishes; its result is just ignored). */
  request<T>(fn: () => Promise<T>, priority = 0): { promise: Promise<T>; cancel(): void } {
    let job!: { run: () => void; cancelled: boolean; priority: number };
    const promise = new Promise<T>((resolve, reject) => {
      job = {
        cancelled: false,
        priority,
        run: () => {
          this.running++;
          let p: Promise<T>;
          try {
            p = fn();
          } catch (e) {
            p = Promise.reject(e);
          }
          p.then(resolve, reject).finally(() => {
            this.running--;
            this.pump();
          });
        },
      };
    });
    this.waiting.push(job);
    queueMicrotask(() => this.pump());
    return {
      promise,
      cancel: () => {
        job.cancelled = true;
      },
    };
  }

  private pump(): void {
    while (this.running < this.concurrency) {
      this.waiting = this.waiting.filter((j) => !j.cancelled);
      let best = -1;
      for (let i = 0; i < this.waiting.length; i++) if (best < 0 || this.waiting[i]!.priority <= this.waiting[best]!.priority) best = i;
      if (best < 0) return;
      this.waiting.splice(best, 1)[0]!.run();
    }
  }
}

/** The app-wide queue for PDF backgrounds. */
export const pdfQueue = new RenderQueue(2);

/**
 * Opening page docs, one at a time, nearest the current page first: loading a page with thousands of strokes is one
 * long step, so pages load and draw in the order the user sees them instead of all at once.
 */
export const pageDocQueue = new RenderQueue(1);
