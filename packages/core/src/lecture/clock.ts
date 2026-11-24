/** The session timeline: runs only while recording (docs/lecture-mode.md §1). `now` is injectable for tests. */
export class LectureClock {
  private elapsed: number;
  private resumedAt: number | null = null;

  constructor(private readonly now: () => number = () => Date.now(), startAt = 0) {
    this.elapsed = startAt;
  }

  get running(): boolean {
    return this.resumedAt !== null;
  }

  /** The current timeline time (ms). */
  t(): number {
    return Math.round(this.elapsed + (this.resumedAt !== null ? this.now() - this.resumedAt : 0));
  }

  start(): void {
    if (this.resumedAt === null) this.resumedAt = this.now();
  }

  /** Freezes the timeline; returns its time. */
  pause(): number {
    if (this.resumedAt !== null) {
      this.elapsed += this.now() - this.resumedAt;
      this.resumedAt = null;
    }
    return this.t();
  }
}
