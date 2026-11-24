import { inkPaint, projectOnLine, rulerEdgeAt, rulerLine } from '@qalm/core';
import * as React from 'react';
import { StyleSheet, View } from 'react-native';

import { liveOutline } from './freehand';
import {
  type InkOverlayProps,
  type InkPenStyle,
  type InkPoint,
  type InkSmoothing,
  type ShapePreview,
  ERASE_TRAIL_MS,
  LASER_CORE,
  LASER_FADE_MS,
  LASER_GLOW,
  RULER_SNAP_PX,
  SHAPE_HOLD_MM,
  SHAPE_HOLD_MS,
} from './InkOverlay.types';
import { laserRuns, type LaserPt } from './laser';
import { traceOutline } from './outlinePath';
import { MM_PER_CSS_PX as MM_PER_PX, palmVerdict, pointerContact, secondFingerRetracts, touchContact } from './palm';
import { fingerGesture, type FingerOwner } from './twoFingerPan';
/** A snapped shape pulses this long (web has no haptics): a halo that shrinks and fades. */
const PULSE_MS = 260;
/** The halo starts this wide (CSS px) beyond the line. */
const PULSE_PX = 7;
const LASSO_COLOR = '#4338ca'; // brand accent
const ERASE_TRAIL_COLOR = '#8b8b95'; // brand faint
/** A finished stroke whose id never reaches committedIds (e.g. snapped to a shape) is dropped after this. */
const PENDING_FALLBACK_MS = 4000;
/**
 * Animation frames a finished stroke stays on the overlay after its id reaches `committedIds` (PageCanvas's onDrawn):
 * the WebGL canvas shows its new picture up to a couple of frames after Skia has it. 1 frame still left blank frames
 * in headless Chrome now and then; 2 never did (tech-spec §3).
 */
const HANDOFF_FRAMES = 2;

type Kind = 'ink' | 'erase' | 'lasso' | 'laser';

/** Laser widths in CSS px (they don't scale with zoom): the glow and the core of the trail, the dot's glow and core radii. */
const LASER_GLOW_PX = 10;
const LASER_CORE_PX = 3;
const LASER_DOT_GLOW_PX = 9;
const LASER_DOT_PX = 4;

const NO_PEN = { x: 0, y: 0, t: -Infinity };

interface Live {
  pointerId: number;
  kind: Kind;
  isPen: boolean;
  tool: 'pen' | 'highlighter';
  color: string;
  width: number;
  style: InkPenStyle;
  smoothing: InkSmoothing;
  rect: DOMRect;
  t0: number;
  points: InkPoint[];
  predicted: InkPoint[];
  holdX: number;
  holdY: number;
  holdT: number;
  /** Index of the point where the hold began (the stroke handed to `recognizeShape` ends there). */
  holdIdx: number;
  holdTimer: ReturnType<typeof setTimeout> | null;
  /** Snapped while held: the shape under the pen, adjusted as the pen drags (`from` is where the pen was then). */
  snap: { base: ShapePreview; cur: ShapePreview; from: [number, number]; at: number } | null;
  erasedUpTo: number;
  /** Along the ruler: every point is projected onto this line (page units). Set when the stroke starts near its edge. */
  line: { a: [number, number]; b: [number, number] } | null;
  /** Client px of the last sample, and how far the contact has travelled (mm): a second finger's verdict. */
  lastX: number;
  lastY: number;
  travelMm: number;
}

interface Finished {
  id: string;
  /** Set once the id is in committedIds and the drop is scheduled. */
  dropping?: boolean;
  color: string;
  alpha: number;
  path: Path2D;
  /** A shape: stroked at this width (page units) instead of filled. */
  lineWidth?: number;
}

function uuid(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function afterFrames(n: number, fn: () => void) {
  if (n <= 0) fn();
  else requestAnimationFrame(() => afterFrames(n - 1, fn));
}

function shapePath(shape: ShapePreview): Path2D {
  const path = new Path2D();
  for (const pl of shape.polylines) pl.forEach(([x, y], i) => (i ? path.lineTo(x, y) : path.moveTo(x, y)));
  return path;
}

function outlinePath(live: Live, pts: InkPoint[]): Path2D {
  const path = new Path2D();
  traceOutline(liveOutline(live.tool, live.width, pts, live.style, live.smoothing), {
    moveTo: (x, y) => path.moveTo(x, y),
    lineTo: (x, y) => path.lineTo(x, y),
    quadTo: (cx, cy, x, y) => path.quadraticCurveTo(cx, cy, x, y),
    close: () => path.closePath(),
  });
  return path;
}

/**
 * Web / Electron live-ink overlay: a transparent canvas stacked over the PageCanvas. It draws only the
 * stroke in progress (and finished strokes until their id is in `committedIds`).
 */
export function InkOverlay(props: InkOverlayProps) {
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const propsRef = React.useRef(props);
  propsRef.current = props;

  const state = React.useRef({
    live: null as Live | null,
    finished: [] as Finished[],
    hover: null as { x: number; y: number } | null, // page units
    lastPen: { x: 0, y: 0, t: -Infinity }, // client px, performance.now()
    penPointers: new Set<number>(),
    buttonDown: false,
    penReported: false,
    /** The laser: its fading trail, and the dot (page units) under the pen or a hovering pointer in dot mode. */
    laser: [] as LaserPt[],
    laserDot: null as { x: number; y: number } | null,
    laserRaf: 0,
    laserCanvas: null as HTMLCanvasElement | null,
    draw: () => {},
  });

  // Drop finished strokes once PageCanvas has drawn them: a few frames after their id shows up in committedIds.
  React.useEffect(() => {
    const s = state.current;
    const committed = new Set(props.committedIds);
    for (const f of s.finished) {
      if (f.dropping || !committed.has(f.id)) continue;
      f.dropping = true;
      afterFrames(HANDOFF_FRAMES, () => {
        const before = s.finished.length;
        s.finished = s.finished.filter((x) => x !== f);
        if (s.finished.length !== before) s.draw();
      });
    }
  }, [props.committedIds]);

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d', { desynchronized: true, alpha: true });
    if (!ctx) return;
    const s = state.current;

    const draw = () => {
      const { pageSize } = propsRef.current;
      const dpr = window.devicePixelRatio || 1;
      const cssW = canvas.clientWidth;
      const cssH = canvas.clientHeight;
      const w = Math.max(1, Math.round(cssW * dpr));
      const h = Math.max(1, Math.round(cssH * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, w, h);
      if (!cssW || !pageSize.w) return;
      const k = (cssW * dpr) / pageSize.w; // page unit → device px
      ctx.setTransform(k, 0, 0, (cssH * dpr) / pageSize.h, 0, 0);

      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      for (const f of s.finished) {
        ctx.globalAlpha = f.alpha;
        if (f.lineWidth) {
          ctx.strokeStyle = f.color;
          ctx.lineWidth = f.lineWidth;
          ctx.stroke(f.path);
        } else {
          ctx.fillStyle = f.color;
          ctx.fill(f.path);
        }
      }
      ctx.globalAlpha = 1;

      const live = s.live;
      if (live?.kind === 'ink' && live.snap) {
        // The snapped shape under the pen, as PageCanvas will draw it (round caps and joins, the pen's width).
        const paint = inkPaint(live.tool, live.color);
        const path = shapePath(live.snap.cur);
        const age = performance.now() - live.snap.at;
        if (age < PULSE_MS) {
          const f = 1 - age / PULSE_MS;
          ctx.globalAlpha = 0.22 * f;
          ctx.strokeStyle = paint.rgb;
          ctx.lineWidth = live.width + ((2 * PULSE_PX * dpr) / k) * f;
          ctx.stroke(path);
          requestAnimationFrame(() => s.draw());
        }
        ctx.globalAlpha = paint.alpha;
        ctx.strokeStyle = paint.rgb;
        ctx.lineWidth = live.width;
        ctx.stroke(path);
        ctx.globalAlpha = 1;
      } else if (live?.kind === 'ink') {
        const paint = inkPaint(live.tool, live.color);
        ctx.globalAlpha = paint.alpha;
        ctx.fillStyle = paint.rgb;
        ctx.fill(outlinePath(live, live.points.concat(live.predicted)));
        ctx.globalAlpha = 1;
      } else if (live?.kind === 'lasso' && live.points.length > 1) {
        ctx.beginPath();
        if (propsRef.current.lassoMode === 'rect') {
          const a = live.points[0]!;
          const b = live.points[live.points.length - 1]!;
          ctx.rect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
        } else live.points.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
        ctx.closePath();
        ctx.lineWidth = (1.5 * dpr) / k;
        ctx.setLineDash([(6 * dpr) / k, (4 * dpr) / k]);
        ctx.strokeStyle = LASSO_COLOR;
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // Partial erase: a faint trail of where the eraser just went, while the page catches up.
      if (live?.kind === 'erase' && propsRef.current.eraserMode === 'partial' && live.points.length > 1) {
        const now = live.points[live.points.length - 1]!.t;
        const trail = live.points.filter((p) => p.t >= now - ERASE_TRAIL_MS);
        if (trail.length > 1) {
          ctx.beginPath();
          trail.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
          ctx.lineWidth = propsRef.current.width;
          ctx.strokeStyle = ERASE_TRAIL_COLOR;
          ctx.globalAlpha = 0.16;
          ctx.stroke();
          ctx.globalAlpha = 1;
        }
      }

      // Laser: a glowing red trail fading over LASER_FADE_MS (brand `bad`), or a dot. Never saved.
      const P = propsRef.current;
      if (s.laser.length > 1 || s.laserDot) {
        const now = performance.now();
        const px = dpr / k; // one CSS px in page units
        if (s.laser.length > 1) {
          // Each layer is drawn on its own canvas, then laid on the overlay: within a layer, each run of the trail in
          // one fade band is one path (no joints painted twice), and a band first clears what it covers, so where two
          // bands meet the newer one shows, not both (no beads at the joints).
          const lc = (s.laserCanvas ??= document.createElement('canvas'));
          if (lc.width !== w || lc.height !== h) {
            lc.width = w;
            lc.height = h;
          }
          const l = lc.getContext('2d')!;
          const runs = laserRuns(s.laser, now);
          for (const [colour, lw, a] of [
            [LASER_GLOW, LASER_GLOW_PX, 0.35],
            [LASER_CORE, LASER_CORE_PX, 1],
          ] as const) {
            l.setTransform(1, 0, 0, 1, 0, 0);
            l.clearRect(0, 0, w, h);
            l.setTransform(k, 0, 0, (cssH * dpr) / pageSize.h, 0, 0);
            l.lineCap = 'round';
            l.lineJoin = 'round';
            l.lineWidth = lw * px;
            l.strokeStyle = colour;
            for (const run of runs) {
              const path = new Path2D();
              run.pts.forEach((q, i) => (i ? path.lineTo(q.x, q.y) : path.moveTo(q.x, q.y)));
              l.globalCompositeOperation = 'destination-out';
              l.globalAlpha = 1;
              l.stroke(path);
              l.globalCompositeOperation = 'source-over';
              l.globalAlpha = a * run.alpha;
              l.stroke(path);
            }
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.globalAlpha = 1;
            ctx.drawImage(lc, 0, 0);
            ctx.setTransform(k, 0, 0, (cssH * dpr) / pageSize.h, 0, 0);
          }
        }
        if (s.laserDot && P.tool === 'laser') {
          ctx.globalAlpha = 0.35;
          ctx.fillStyle = LASER_GLOW;
          ctx.beginPath();
          ctx.arc(s.laserDot.x, s.laserDot.y, LASER_DOT_GLOW_PX * px, 0, Math.PI * 2);
          ctx.fill();
          ctx.globalAlpha = 1;
          ctx.fillStyle = LASER_CORE;
          ctx.beginPath();
          ctx.arc(s.laserDot.x, s.laserDot.y, LASER_DOT_PX * px, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.globalAlpha = 1;
      }

      // Brush preview: hover, or the eraser under the pen.
      const cursor = live?.kind === 'erase' ? live.points[live.points.length - 1] : live ? null : s.hover;
      const tool = live?.kind === 'erase' ? 'eraser' : propsRef.current.tool;
      if (cursor && tool !== 'none' && tool !== 'lasso' && tool !== 'laser') {
        const r = Math.max(propsRef.current.width / 2, 1 / k);
        ctx.beginPath();
        ctx.arc(cursor.x, cursor.y, r, 0, Math.PI * 2);
        ctx.lineWidth = dpr / k;
        ctx.strokeStyle = tool === 'eraser' ? '#8b8b95' : propsRef.current.color;
        ctx.globalAlpha = 0.7;
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    };
    s.draw = draw;

    /** Fades the laser trail: redraws every frame until it is gone (canvas.dataset.laser counts its points, for tests). */
    const tickLaser = () => {
      s.laserRaf = 0;
      const now = performance.now();
      let i = 0;
      while (i < s.laser.length && now - s.laser[i]!.t >= LASER_FADE_MS) i++;
      if (i) s.laser.splice(0, i);
      canvas.dataset.laser = String(s.laser.length);
      draw();
      if (s.laser.length) s.laserRaf = requestAnimationFrame(tickLaser);
    };
    const runLaser = () => {
      if (!s.laserRaf) s.laserRaf = requestAnimationFrame(tickLaser);
    };

    const toPoint = (ev: PointerEvent, live: Live): InkPoint => {
      const { pageSize } = propsRef.current;
      const p = ev.pointerType === 'pen' ? (ev.pressure > 0 ? ev.pressure : 0.5) : 0.5;
      let tilt = Math.PI / 2;
      let az = 0;
      if (ev.pointerType === 'pen') {
        if (typeof ev.altitudeAngle === 'number') {
          tilt = ev.altitudeAngle;
          az = ev.azimuthAngle;
        } else if (ev.tiltX || ev.tiltY) {
          const tx = Math.tan((ev.tiltX * Math.PI) / 180);
          const ty = Math.tan((ev.tiltY * Math.PI) / 180);
          tilt = Math.atan(1 / Math.hypot(tx, ty));
          az = Math.atan2(ty, tx);
        }
      }
      let x = ((ev.clientX - live.rect.left) * pageSize.w) / live.rect.width;
      let y = ((ev.clientY - live.rect.top) * pageSize.h) / live.rect.height;
      if (live.line) [x, y] = projectOnLine([x, y], live.line.a, live.line.b);
      return {
        x,
        y,
        p: Math.min(1, p),
        tilt,
        az,
        t: Math.max(0, ev.timeStamp - live.t0),
      };
    };

    const reject = (reason: string) => propsRef.current.onRejectedTouch?.({ nativeEvent: { reason } });

    // The pen's barrel button (Windows reports it as the right button) or its eraser end.
    const penButtonPressed = (ev: PointerEvent) => ev.pointerType === 'pen' && (ev.button === 2 || ev.button === 5 || (ev.buttons & (2 | 32)) !== 0);
    // Held while the pen (or the mouse's right button) drags: that stroke erases, whatever the tool.
    const erasesWhileHeld = (ev: PointerEvent) => penButtonPressed(ev) || (ev.pointerType === 'mouse' && ev.button === 2);

    /**
     * The pen button pressed while the pen hovers is the shortcut (onPenButton: eraser or last tool, per Settings).
     * Pressed while touching, it only makes that stroke erase: toggling the tool as well left the eraser on after the
     * button was released.
     */
    const firePenButton = (ev: PointerEvent, touching: boolean) => {
      const pressed = penButtonPressed(ev);
      if (pressed && !s.buttonDown && !touching) propsRef.current.onPenButton?.({ nativeEvent: { kind: 'button' } });
      s.buttonDown = pressed;
    };

    const palmSizeExceeded = (ev: PointerEvent) => palmVerdict(pointerContact(ev), NO_PEN, propsRef.current.input) === 'palm-size';

    const notePen = (ev: PointerEvent) => {
      s.lastPen = { x: ev.clientX, y: ev.clientY, t: ev.timeStamp };
      if (!s.penReported) {
        s.penReported = true;
        propsRef.current.onPenSeen?.({ nativeEvent: {} });
      }
    };

    const emitErase = (live: Live, final: boolean) => {
      const from = Math.max(0, live.erasedUpTo - 1);
      if (live.points.length - from < (final ? 1 : 2)) return;
      const path = live.points.slice(from).map(({ x, y }) => ({ x, y }));
      live.erasedUpTo = live.points.length;
      propsRef.current.onErase({ nativeEvent: final ? { path, final: true } : { path } });
    };

    /** Snaps the stroke to a shape if it looks like one (the pen has held still since `holdIdx`). */
    const trySnap = (live: Live) => {
      live.holdTimer = null;
      const recognize = propsRef.current.recognizeShape;
      if (s.live !== live || live.snap || !recognize) return;
      const shape = recognize(live.points.slice(0, live.holdIdx + 1).map(({ x, y }) => ({ x, y })));
      if (!shape) return; // not a shape: nothing happens, the pen keeps drawing
      const last = live.points[live.points.length - 1]!;
      live.snap = { base: shape, cur: shape, from: [last.x, last.y], at: performance.now() };
      live.predicted = [];
      canvas.dataset.shape = shape.kind; // for tests: the shape under the pen
      draw();
    };

    /** (Re)starts the hold clock: pen strokes only, when live shapes are on. */
    const armHold = (live: Live) => {
      if (live.holdTimer) clearTimeout(live.holdTimer);
      live.holdTimer = null;
      // A stroke along the ruler is a straight line already: it never snaps to a shape.
      if (live.kind !== 'ink' || live.tool !== 'pen' || live.snap || live.line || !propsRef.current.recognizeShape) return;
      live.holdTimer = setTimeout(() => trySnap(live), SHAPE_HOLD_MS);
    };

    const stopHold = (live: Live | null) => {
      if (live?.holdTimer) clearTimeout(live.holdTimer);
      if (live) live.holdTimer = null;
      delete canvas.dataset.shape;
    };

    const addPoint = (live: Live, ev: PointerEvent) => {
      live.travelMm += Math.hypot(ev.clientX - live.lastX, ev.clientY - live.lastY) * MM_PER_PX;
      live.lastX = ev.clientX;
      live.lastY = ev.clientY;
      const pt = toPoint(ev, live);
      if (live.kind === 'laser') {
        if (propsRef.current.laserMode === 'dot') s.laserDot = { x: pt.x, y: pt.y };
        else {
          s.laser.push({ x: pt.x, y: pt.y, t: performance.now(), start: live.points.length === 0 });
          runLaser();
        }
        live.points.push(pt);
        return;
      }
      if (live.snap) {
        // Adjusting: the stroke stays as it was drawn; the shape follows the pen.
        const adjust = propsRef.current.adjustShape;
        if (adjust) live.snap.cur = adjust(live.snap.base, live.snap.from, [pt.x, pt.y]);
        return;
      }
      const prev = live.points[live.points.length - 1];
      if (prev && prev.x === pt.x && prev.y === pt.y) return;
      live.points.push(pt);
      // Holding still: within SHAPE_HOLD_MM of where the hold began (not of the previous point, so a slow drift ends it).
      const mmPerUnit = (live.rect.width / propsRef.current.pageSize.w) * MM_PER_PX;
      if (live.points.length === 1 || Math.hypot(pt.x - live.holdX, pt.y - live.holdY) * mmPerUnit > SHAPE_HOLD_MM) {
        live.holdX = pt.x;
        live.holdY = pt.y;
        live.holdT = pt.t;
        live.holdIdx = live.points.length - 1;
        armHold(live);
      }
    };

    const start = (ev: PointerEvent, isPen: boolean) => {
      const P = propsRef.current;
      // The barrel button, the eraser end and the right mouse button erase that stroke, except with the laser: pointing
      // must never change the page.
      const eraserOverride = P.tool !== 'laser' && erasesWhileHeld(ev);
      const tool = eraserOverride ? 'eraser' : P.tool;
      if (tool === 'none') return;
      const kind: Kind = tool === 'eraser' ? 'erase' : tool === 'lasso' ? 'lasso' : tool === 'laser' ? 'laser' : 'ink';
      const rect = canvas.getBoundingClientRect();
      // Near a ruler edge: the stroke follows that edge (projected onto it, half the pen's width outside it).
      const ruler = P.getRuler ? P.getRuler() : P.ruler;
      const edge = kind === 'ink' && ruler ? rulerEdgeAt(ruler, [ev.clientX, ev.clientY], RULER_SNAP_PX) : null;
      const line = edge
        ? rulerLine(edge, ([x, y]) => [((x - rect.left) * P.pageSize.w) / rect.width, ((y - rect.top) * P.pageSize.h) / rect.height], P.width / 2)
        : null;
      const live: Live = {
        pointerId: ev.pointerId,
        kind,
        isPen,
        tool: tool === 'highlighter' ? 'highlighter' : 'pen',
        color: P.color,
        width: P.width,
        style: P.penStyle ?? 'fountain',
        smoothing: P.smoothing ?? 0,
        rect,
        t0: ev.timeStamp,
        points: [],
        predicted: [],
        holdX: 0,
        holdY: 0,
        holdT: 0,
        holdIdx: 0,
        holdTimer: null,
        snap: null,
        line,
        erasedUpTo: 0,
        lastX: ev.clientX,
        lastY: ev.clientY,
        travelMm: 0,
      };
      s.live = live;
      if (line) canvas.dataset.ruler = '1'; // for tests: this stroke follows the ruler
      else delete canvas.dataset.ruler;
      addPoint(live, ev);
      try {
        canvas.setPointerCapture(ev.pointerId);
      } catch {
        // A pointer handed over from the ruler (forwarded) may already be gone.
      }
      draw();
    };

    const retract = () => {
      stopHold(s.live);
      s.live = null;
      s.laserDot = null;
      draw();
    };

    /** `ev` is the live pointer's last event; null when a second finger ends the stroke where it is. */
    const finish = (ev: PointerEvent | null, now = ev?.timeStamp ?? 0) => {
      const live = s.live;
      if (!live) return;
      s.live = null;
      if (ev) addPoint(live, ev);
      stopHold(live);
      const P = propsRef.current;
      if (live.kind === 'laser') {
        // Nothing to save: the trail fades on its own; the dot goes (it comes back on hover).
        if (ev?.pointerType !== 'mouse' && ev?.pointerType !== 'pen') s.laserDot = null;
      } else if (live.kind === 'erase') {
        emitErase(live, true);
      } else if (live.kind === 'lasso') {
        if (live.points.length >= 1) P.onLasso({ nativeEvent: { polygon: live.points.map(({ x, y }) => ({ x, y })) } });
      } else if (live.points.length > 0) {
        const id = uuid();
        const last = live.points[live.points.length - 1]!;
        const heldMs = Math.max(0, Math.round(Math.max(last.t, now - live.t0) - live.holdT));
        const shape = live.snap?.cur;
        s.finished.push({
          id,
          color: inkPaint(live.tool, live.color).rgb,
          alpha: inkPaint(live.tool, live.color).alpha,
          // Exactly what PageCanvas will draw: the shape, or the stroke without predicted points.
          path: shape ? shapePath(shape) : outlinePath(live, live.points),
          lineWidth: shape ? live.width : undefined,
        });
        setTimeout(() => {
          const before = s.finished.length;
          s.finished = s.finished.filter((f) => f.id !== id);
          if (s.finished.length !== before) s.draw();
        }, PENDING_FALLBACK_MS);
        P.onStrokeEnd({
          nativeEvent: {
            id,
            tool: live.tool,
            color: live.color,
            width: live.width,
            points: live.points,
            heldMs,
            style: live.style,
            smoothing: live.smoothing,
            ...(shape ? { shape: { kind: shape.kind, pts: shape.pts } } : null),
            ...(live.line ? { ruler: true } : null),
          },
        });
      }
      draw();
    };

    // "Pen and finger": this overlay's finger owns the gesture until every finger lifts; a second one, anywhere in the
    // window, pans (twoFingerPan.ts) and the editor's pinch zooms.
    const owner: FingerOwner = {
      el: canvas,
      isPalm: (ev) => palmVerdict(pointerContact(ev), s.lastPen, propsRef.current.input) !== null,
      secondFinger: (t) => {
        const live = s.live;
        if (!live || live.isPen) return;
        if (secondFingerRetracts(t - live.t0, live.travelMm)) {
          retract(); // both fingers were meant as the gesture
          reject('multi-touch');
        } else finish(null, t); // a real stroke: keep it, ending here
      },
    };
    const releaseFingers = fingerGesture.use();

    const onDown = (ev: PointerEvent) => {
      const P = propsRef.current;
      if (ev.pointerType === 'pen') {
        s.penPointers.add(ev.pointerId);
        notePen(ev);
        firePenButton(ev, true);
        if (s.live && !s.live.isPen) {
          retract(); // the palm got there first
          reject('pen-took-over');
        }
        if (!s.live) start(ev, true);
        return;
      }
      if (ev.pointerType === 'touch') {
        const palm = palmVerdict(pointerContact(ev), s.lastPen, P.input);
        // Pen only: fingers scroll and zoom. A palm is still reported as one (and onTouchStart keeps it from scrolling).
        if (P.input.drawWith === 'pen') return reject(palm ?? 'pen-only');
        if (palm) return reject(palm);
        // A further finger (here, or the first landed on another page): a pan or pinch, not ink.
        if (fingerGesture.busy) return;
        if (s.live?.isPen) return reject('pen-active');
        if (s.live) return; // a mouse stroke
        fingerGesture.first(ev, owner);
        start(ev, false);
        return;
      }
      if ((ev.button === 0 || ev.button === 2) && !s.live) start(ev, false); // mouse: the right button erases
    };

    const onMove = (ev: PointerEvent) => {
      if (ev.pointerType === 'pen') {
        notePen(ev);
        firePenButton(ev, s.penPointers.has(ev.pointerId));
      }
      const live = s.live;
      if (live && ev.pointerId === live.pointerId) {
        if (ev.pointerType === 'touch' && palmSizeExceeded(ev)) {
          retract(); // the contact grew into a palm
          reject('palm-size');
          return;
        }
        // A pointer handed over from the ruler (a synthetic pointerdown) has no coalesced events on its first moves either way.
        const coalesced = ev.getCoalescedEvents?.() ?? [];
        for (const c of coalesced.length ? coalesced : [ev]) addPoint(live, c);
        live.predicted = live.kind === 'ink' && !live.snap ? (ev.getPredictedEvents?.() ?? []).map((p) => toPoint(p, live)) : [];
        if (live.kind === 'erase') emitErase(live, false);
        draw();
        return;
      }
      if (!live && ev.buttons === 0 && ev.pointerType !== 'touch') {
        const rect = canvas.getBoundingClientRect();
        const { pageSize } = propsRef.current;
        s.hover = {
          x: ((ev.clientX - rect.left) * pageSize.w) / rect.width,
          y: ((ev.clientY - rect.top) * pageSize.h) / rect.height,
        };
        s.laserDot = propsRef.current.tool === 'laser' && propsRef.current.laserMode === 'dot' ? s.hover : null;
        draw();
      }
    };

    const onUp = (ev: PointerEvent) => {
      s.penPointers.delete(ev.pointerId);
      if (ev.pointerType === 'pen') {
        notePen(ev);
        s.buttonDown = false;
      }
      if (s.live && ev.pointerId === s.live.pointerId) finish(ev);
    };

    // OS / browser cancel retracts the stroke in progress (tech-spec §3, rule 4).
    const onCancel = (ev: PointerEvent) => {
      s.penPointers.delete(ev.pointerId);
      if (s.live && ev.pointerId === s.live.pointerId) {
        retract();
        reject('cancelled');
      }
    };

    const onLeave = (ev: PointerEvent) => {
      if (ev.pointerType === 'pen') canvas.style.touchAction = touchActionFor(propsRef.current);
      if (s.hover || s.laserDot) {
        s.hover = null;
        if (!s.live) s.laserDot = null;
        draw();
      }
    };

    // A hovering pen must never pan: switch touch-action before it touches down.
    const onOver = (ev: PointerEvent) => {
      if (ev.pointerType !== 'pen') return;
      canvas.style.touchAction = 'none';
      notePen(ev);
    };

    // Chromium may still turn a pen drag into a pan: cancel the compatibility touch events of pen contacts. With
    // "pen only", fingers pan and zoom (touch-action), but a palm, or a hand resting by the pen, never scrolls.
    const onTouchStart = (ev: TouchEvent) => {
      if (s.penPointers.size > 0 || s.live?.isPen) return ev.preventDefault();
      const P = propsRef.current;
      if (P.input.drawWith !== 'pen') return; // touch-action: none, so nothing scrolls
      for (const t of Array.from(ev.changedTouches)) {
        if (palmVerdict(touchContact(t, ev.timeStamp), s.lastPen, P.input)) return ev.preventDefault();
      }
    };

    // No context menu on the page: the right button and the pen's barrel button erase.
    const onContextMenu = (ev: Event) => ev.preventDefault();

    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onCancel);
    canvas.addEventListener('pointerleave', onLeave);
    canvas.addEventListener('pointerover', onOver);
    canvas.addEventListener('touchstart', onTouchStart, { passive: false });
    canvas.addEventListener('contextmenu', onContextMenu);
    canvas.dataset.qalmInk = '1'; // the ruler hands pens over to the overlay under it (forwardToInk)
    const ro = new ResizeObserver(draw);
    ro.observe(canvas);
    draw();
    return () => {
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onCancel);
      canvas.removeEventListener('pointerleave', onLeave);
      canvas.removeEventListener('pointerover', onOver);
      canvas.removeEventListener('touchstart', onTouchStart);
      canvas.removeEventListener('contextmenu', onContextMenu);
      ro.disconnect();
      if (s.laserRaf) cancelAnimationFrame(s.laserRaf);
      fingerGesture.release(owner);
      releaseFingers();
      s.draw = () => {};
    };
  }, []);

  // Redraw the hover preview when the brush changes. Leaving the laser (or switching its mode) drops its trail and dot.
  React.useEffect(() => {
    const s = state.current;
    if (props.tool !== 'laser' || props.laserMode === 'dot') s.laser = [];
    if (props.tool !== 'laser' || props.laserMode !== 'dot') s.laserDot = null;
    s.draw();
  }, [props.tool, props.width, props.color, props.pageSize.w, props.pageSize.h, props.laserMode]);

  return (
    <View style={[StyleSheet.absoluteFill, props.style]} pointerEvents={props.tool === 'none' ? 'none' : 'auto'}>
      <canvas
        ref={canvasRef}
        style={{
          width: '100%',
          height: '100%',
          display: 'block',
          touchAction: touchActionFor(props),
          // The laser dot replaces the mouse cursor.
          cursor: props.tool === 'none' ? 'default' : props.tool === 'laser' && props.laserMode === 'dot' ? 'none' : 'crosshair',
        }}
      />
    </View>
  );
}

function touchActionFor(p: InkOverlayProps): string {
  return p.input.drawWith === 'pen' ? 'pan-x pan-y pinch-zoom' : 'none';
}
