/**
 * Android: holds PageCanvas updates while the pen keeps writing (tech-spec §3, "Page redraws wait for the pen").
 * react-native-skia redraws the page on the UI thread, where pen input arrives too, and on a page of picture chunks
 * that redraw took ~90 ms right after every stroke: the next stroke's first samples waited behind it. The overlay keeps
 * finished strokes on screen until PageCanvas reports them drawn, so a short hold is invisible.
 *
 * After an ink stroke ends the page keeps showing what it showed; the hold is released once the pen has been up for
 * IDLE_MS, or at a stroke end once it has lasted MAX_MS, and always after CAP_MS (a stroke that never ends, e.g. a
 * cancelled touch). Anything that isn't plain ink (erasing, the lasso, a scribble) releases it at once.
 */
export const HOLD_IDLE_MS = 300;
export const HOLD_MAX_MS = 1500;
/** Below the overlay's PENDING_FALLBACK_MS (4 s), after which it drops a stroke the page never drew. */
export const HOLD_CAP_MS = 2500;

export class InkHold<T> {
  private held: { value: T; since: number } | null = null;
  private idle: ReturnType<typeof setTimeout> | null = null;
  private cap: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly onRelease: () => void,
    private readonly now: () => number = Date.now,
  ) {}

  /** What the page should show: the held value, or [latest] when nothing is held. */
  pick(latest: T): T {
    return this.held ? this.held.value : latest;
  }

  get holding(): boolean {
    return this.held !== null;
  }

  /** A stroke began: don't release under the pen. */
  strokeStart(): void {
    this.clearIdle();
  }

  /** An ink stroke ended; [shown] is what the page shows now (before the stroke lands). */
  inkEnd(shown: T): void {
    this.clearIdle();
    if (!this.held) {
      this.held = { value: shown, since: this.now() };
      this.cap = setTimeout(() => this.release(), HOLD_CAP_MS);
    } else if (this.now() - this.held.since >= HOLD_MAX_MS) {
      return this.release();
    }
    this.idle = setTimeout(() => this.release(), HOLD_IDLE_MS);
  }

  release(): void {
    this.clearIdle();
    if (this.cap) clearTimeout(this.cap);
    this.cap = null;
    if (!this.held) return;
    this.held = null;
    this.onRelease();
  }

  /** Unmount: stop the timers without a callback. */
  dispose(): void {
    this.clearIdle();
    if (this.cap) clearTimeout(this.cap);
    this.cap = null;
    this.held = null;
  }

  private clearIdle(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
  }
}
