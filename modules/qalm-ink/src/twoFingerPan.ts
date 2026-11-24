// "Pen and finger" on web / Electron: one finger draws, so the canvas has `touch-action: none` and the browser
// can't scroll. Two fingers pan the page's scroll views from here instead (the pinch is react-native-gesture-handler's,
// in the editor), with momentum after the fingers lift, like a native touch scroll.

/** One position of the fingers' midpoint: client px, ms on the event clock. */
export interface PanSample {
  x: number;
  y: number;
  t: number;
}

/** Velocity is measured over the last this many ms of the drag. */
export const FLING_WINDOW_MS = 100;
/** No fling when the fingers stood still this long before lifting. */
export const FLING_STALE_MS = 50;
/** Per-ms decay of the fling's speed: UIScrollView's normal deceleration rate. */
export const FLING_DECAY_PER_MS = 0.998;
/** A fling stops below this speed (px/ms). */
export const FLING_MIN_SPEED = 0.02;

/** The midpoint's velocity (px/ms) at `upT`, from samples in order; zero if they stood still or are too few. */
export function flingVelocity(samples: readonly PanSample[], upT: number): { vx: number; vy: number } {
  const last = samples[samples.length - 1];
  if (!last || upT - last.t > FLING_STALE_MS) return { vx: 0, vy: 0 };
  let first = last;
  for (let i = samples.length - 1; i >= 0 && last.t - samples[i]!.t <= FLING_WINDOW_MS; i--) first = samples[i]!;
  const dt = last.t - first.t;
  if (dt <= 0) return { vx: 0, vy: 0 };
  return { vx: (last.x - first.x) / dt, vy: (last.y - first.y) / dt };
}

/** The distance a fling from `v` px/ms covers in `dt` ms, and its speed afterwards. */
export function flingStep(v: number, dt: number): { d: number; v: number } {
  const k = Math.pow(FLING_DECAY_PER_MS, dt);
  // ∫ v·r^t dt from 0 to dt = v (r^dt − 1) / ln r
  return { d: (v * (k - 1)) / Math.log(FLING_DECAY_PER_MS), v: v * k };
}

/** The nearest ancestors of `el` that scroll vertically and horizontally (react-native-web ScrollViews). */
export function scrollTargets(el: Element): { v: HTMLElement | null; h: HTMLElement | null } {
  let v: HTMLElement | null = null;
  let h: HTMLElement | null = null;
  for (let p = el.parentElement; p && !(v && h); p = p.parentElement) {
    const cs = getComputedStyle(p);
    if (!v && /auto|scroll/.test(cs.overflowY) && p.scrollHeight > p.clientHeight + 1) v = p;
    if (!h && /auto|scroll/.test(cs.overflowX) && p.scrollWidth > p.clientWidth + 1) h = p;
  }
  return { v, h };
}

/**
 * Two-finger pan: `move` with the fingers' midpoint, `end` when the last finger lifts. A new gesture (`begin`) or
 * `stop` cancels a fling in progress.
 */
export function createTwoFingerPan() {
  let targets: ReturnType<typeof scrollTargets> = { v: null, h: null };
  let last: PanSample | null = null;
  let samples: PanSample[] = [];
  let raf = 0;

  const scrollBy = (dx: number, dy: number) => {
    if (targets.v) targets.v.scrollTop -= dy;
    if (targets.h) targets.h.scrollLeft -= dx;
  };
  const stop = () => {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  };

  return {
    get active() {
      return last !== null;
    },
    begin(el: Element, at: PanSample) {
      stop();
      targets = scrollTargets(el);
      last = at;
      samples = [at];
    },
    /** The midpoint moved; `rebase` after a finger came or went, so the midpoint jumping doesn't scroll. */
    move(at: PanSample, rebase = false) {
      if (!last) return;
      if (!rebase) scrollBy(at.x - last.x, at.y - last.y);
      else samples = [];
      last = at;
      samples.push(at);
      if (samples.length > 32) samples.splice(0, samples.length - 32);
    },
    end(upT: number) {
      if (!last) return;
      let { vx, vy } = flingVelocity(samples, upT);
      last = null;
      samples = [];
      if (Math.hypot(vx, vy) < FLING_MIN_SPEED) return;
      let prev = performance.now();
      const frame = (now: number) => {
        const dt = Math.min(64, Math.max(0, now - prev));
        prev = now;
        const sx = flingStep(vx, dt);
        const sy = flingStep(vy, dt);
        vx = sx.v;
        vy = sy.v;
        scrollBy(sx.d, sy.d);
        raf = Math.hypot(vx, vy) < FLING_MIN_SPEED ? 0 : requestAnimationFrame(frame);
      };
      raf = requestAnimationFrame(frame);
    },
    stop,
  };
}

/** The overlay whose finger went down first: it owns the gesture until every finger has lifted. */
export interface FingerOwner {
  /** The overlay's element: the gesture scrolls its scroll views. */
  el: Element;
  /** Palm rules for a further finger (a palm resting by a finger stroke neither ends it nor pans). */
  isPalm(ev: PointerEvent): boolean;
  /** A second finger landed at `t`: retract or keep the finger stroke in progress. */
  secondFinger(t: number): void;
}

/**
 * The fingers down in "pen and finger", across every overlay on screen: a second finger may land on another page
 * (or between pages) when pinching a zoomed-out notebook. The first finger is registered by its overlay (`first`);
 * further touches anywhere in the window are caught here, in the capture phase, before any overlay sees them, so
 * the overlay under them checks `has` and leaves them alone. Two or more fingers pan.
 */
function createFingerGesture() {
  const fingers = new Map<number, { x: number; y: number }>();
  const pan = createTwoFingerPan();
  let owner: FingerOwner | null = null;
  let users = 0;

  const mid = (t: number): PanSample => {
    let x = 0;
    let y = 0;
    for (const f of fingers.values()) {
      x += f.x;
      y += f.y;
    }
    return { x: x / fingers.size, y: y / fingers.size, t };
  };

  const onDown = (ev: PointerEvent) => {
    if (ev.pointerType !== 'touch' && ev.pointerType !== 'pen') return;
    if (!fingers.size) {
      pan.stop(); // a touch stops a fling, as in a native scroll view
      return;
    }
    if (ev.pointerType !== 'touch' || !owner || owner.isPalm(ev)) return;
    fingers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    if (pan.active) return pan.move(mid(ev.timeStamp), true);
    owner.secondFinger(ev.timeStamp);
    pan.begin(owner.el, mid(ev.timeStamp));
  };
  const onMove = (ev: PointerEvent) => {
    const f = fingers.get(ev.pointerId);
    if (!f) return;
    f.x = ev.clientX;
    f.y = ev.clientY;
    if (pan.active) pan.move(mid(ev.timeStamp));
  };
  const onUp = (ev: PointerEvent) => {
    if (!fingers.delete(ev.pointerId)) return;
    if (fingers.size === 0) {
      owner = null;
      pan.end(ev.timeStamp);
    } else if (pan.active) pan.move(mid(ev.timeStamp), true);
  };

  return {
    /** Fingers down (registered here), including the first one. */
    has: (pointerId: number) => fingers.has(pointerId),
    /** A finger already down: a new one is a further finger of that gesture. */
    get busy() {
      return fingers.size > 0;
    },
    /** The overlay's first finger (it starts a stroke); further fingers end that stroke and pan. */
    first(ev: PointerEvent, o: FingerOwner) {
      pan.stop();
      owner = o;
      fingers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    },
    /** Called by each overlay while mounted; the window listeners stay while any overlay is on screen. */
    use() {
      if (users++ === 0) {
        window.addEventListener('pointerdown', onDown, true);
        window.addEventListener('pointermove', onMove, true);
        window.addEventListener('pointerup', onUp, true);
        window.addEventListener('pointercancel', onUp, true);
      }
      return () => {
        if (--users > 0) return;
        window.removeEventListener('pointerdown', onDown, true);
        window.removeEventListener('pointermove', onMove, true);
        window.removeEventListener('pointerup', onUp, true);
        window.removeEventListener('pointercancel', onUp, true);
        fingers.clear();
        owner = null;
        pan.stop();
      };
    },
    /** An overlay going away mid-gesture must not be called back. */
    release(o: FingerOwner) {
      if (owner === o) owner = null;
    },
  };
}

export const fingerGesture = createFingerGesture();
