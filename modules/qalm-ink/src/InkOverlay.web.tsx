import * as React from 'react';
import { StyleSheet, View } from 'react-native';

import { HIGHLIGHTER_ALPHA, liveOutline } from './freehand';
import {
  PALM_MAJOR_MM,
  PEN_LOCKOUT_MS,
  type InkOverlayProps,
  type InkPoint,
} from './InkOverlay.types';
import { traceOutline } from './outlinePath';

/** CSS px → mm (tech-spec §3). */
const MM_PER_PX = 0.2646;
/** A touch on the hand side of the pen is rejected while the pen was seen within this window. */
const HAND_SIDE_WINDOW_MS = 3000; // same as iOS and Android
/** "Beside or below" = no more than this far on the other side of / above the pen tip. */
const HAND_SIDE_MARGIN_MM = 10;
/** Movement smaller than this counts as holding still (heldMs). */
const HOLD_MOVE_MM = 1;
const LASSO_COLOR = '#4338ca'; // brand accent
/** A finished stroke whose id never reaches committedIds (e.g. snapped to a shape) is dropped after this. */
const PENDING_FALLBACK_MS = 4000;
/**
 * Animation frames a finished stroke stays on the overlay after its id reaches `committedIds` (PageCanvas's onDrawn):
 * the WebGL canvas shows its new picture up to a couple of frames after Skia has it. 1 frame still left blank frames
 * in headless Chrome now and then; 2 never did (tech-spec §3).
 */
const HANDOFF_FRAMES = 2;

type Kind = 'ink' | 'erase' | 'lasso';

interface Live {
  pointerId: number;
  kind: Kind;
  isPen: boolean;
  tool: 'pen' | 'highlighter';
  color: string;
  width: number;
  rect: DOMRect;
  t0: number;
  points: InkPoint[];
  predicted: InkPoint[];
  holdX: number;
  holdY: number;
  holdT: number;
  erasedUpTo: number;
}

interface Finished {
  id: string;
  /** Set once the id is in committedIds and the drop is scheduled. */
  dropping?: boolean;
  color: string;
  alpha: number;
  path: Path2D;
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

function outlinePath(tool: 'pen' | 'highlighter', width: number, pts: InkPoint[]): Path2D {
  const path = new Path2D();
  traceOutline(liveOutline(tool, width, pts), {
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

      for (const f of s.finished) {
        ctx.globalAlpha = f.alpha;
        ctx.fillStyle = f.color;
        ctx.fill(f.path);
      }
      ctx.globalAlpha = 1;

      const live = s.live;
      if (live?.kind === 'ink') {
        ctx.globalAlpha = live.tool === 'highlighter' ? HIGHLIGHTER_ALPHA : 1;
        ctx.fillStyle = live.color;
        ctx.fill(outlinePath(live.tool, live.width, live.points.concat(live.predicted)));
        ctx.globalAlpha = 1;
      } else if (live?.kind === 'lasso' && live.points.length > 1) {
        ctx.beginPath();
        live.points.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
        ctx.closePath();
        ctx.lineWidth = (1.5 * dpr) / k;
        ctx.setLineDash([(6 * dpr) / k, (4 * dpr) / k]);
        ctx.strokeStyle = LASSO_COLOR;
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // Brush preview: hover, or the eraser under the pen.
      const cursor = live?.kind === 'erase' ? live.points[live.points.length - 1] : live ? null : s.hover;
      const tool = live?.kind === 'erase' ? 'eraser' : propsRef.current.tool;
      if (cursor && tool !== 'none' && tool !== 'lasso') {
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
      return {
        x: ((ev.clientX - live.rect.left) * pageSize.w) / live.rect.width,
        y: ((ev.clientY - live.rect.top) * pageSize.h) / live.rect.height,
        p: Math.min(1, p),
        tilt,
        az,
        t: Math.max(0, ev.timeStamp - live.t0),
      };
    };

    const reject = (reason: string) => propsRef.current.onRejectedTouch?.({ nativeEvent: { reason } });

    const penButtonPressed = (ev: PointerEvent) => ev.pointerType === 'pen' && (ev.button === 5 || (ev.buttons & (2 | 32)) !== 0);

    const firePenButton = (ev: PointerEvent) => {
      const pressed = penButtonPressed(ev);
      if (pressed && !s.buttonDown) propsRef.current.onPenButton?.({ nativeEvent: { kind: 'button' } });
      s.buttonDown = pressed;
    };

    const handSide = (ev: PointerEvent) => {
      if (ev.timeStamp - s.lastPen.t > HAND_SIDE_WINDOW_MS) return false;
      const margin = HAND_SIDE_MARGIN_MM / MM_PER_PX;
      const dx = ev.clientX - s.lastPen.x;
      const dy = ev.clientY - s.lastPen.y;
      const beside = propsRef.current.input.hand === 'right' ? dx > -margin : dx < margin;
      return beside && dy > -margin;
    };

    const palmSizeExceeded = (ev: PointerEvent) =>
      Math.max(ev.width, ev.height) * MM_PER_PX > PALM_MAJOR_MM[propsRef.current.input.palm];

    const notePen = (ev: PointerEvent) => {
      s.lastPen = { x: ev.clientX, y: ev.clientY, t: ev.timeStamp };
    };

    const emitErase = (live: Live, final: boolean) => {
      const from = Math.max(0, live.erasedUpTo - 1);
      if (live.points.length - from < (final ? 1 : 2)) return;
      const path = live.points.slice(from).map(({ x, y }) => ({ x, y }));
      live.erasedUpTo = live.points.length;
      propsRef.current.onErase({ nativeEvent: { path } });
    };

    const addPoint = (live: Live, ev: PointerEvent) => {
      const pt = toPoint(ev, live);
      const prev = live.points[live.points.length - 1];
      if (prev && prev.x === pt.x && prev.y === pt.y) return;
      live.points.push(pt);
      const mmPerUnit = (live.rect.width / propsRef.current.pageSize.w) * MM_PER_PX;
      if (Math.hypot(pt.x - live.holdX, pt.y - live.holdY) * mmPerUnit > HOLD_MOVE_MM) {
        live.holdX = pt.x;
        live.holdY = pt.y;
        live.holdT = pt.t;
      }
    };

    const start = (ev: PointerEvent, isPen: boolean) => {
      const P = propsRef.current;
      const eraserOverride = penButtonPressed(ev);
      const tool = eraserOverride ? 'eraser' : P.tool;
      if (tool === 'none') return;
      const kind: Kind = tool === 'eraser' ? 'erase' : tool === 'lasso' ? 'lasso' : 'ink';
      const live: Live = {
        pointerId: ev.pointerId,
        kind,
        isPen,
        tool: tool === 'highlighter' ? 'highlighter' : 'pen',
        color: P.color,
        width: P.width,
        rect: canvas.getBoundingClientRect(),
        t0: ev.timeStamp,
        points: [],
        predicted: [],
        holdX: 0,
        holdY: 0,
        holdT: 0,
        erasedUpTo: 0,
      };
      s.live = live;
      addPoint(live, ev);
      live.holdX = live.points[0]?.x ?? 0;
      live.holdY = live.points[0]?.y ?? 0;
      canvas.setPointerCapture(ev.pointerId);
      draw();
    };

    const retract = () => {
      s.live = null;
      draw();
    };

    const finish = (ev: PointerEvent) => {
      const live = s.live;
      if (!live) return;
      s.live = null;
      addPoint(live, ev);
      const P = propsRef.current;
      if (live.kind === 'erase') {
        emitErase(live, true);
      } else if (live.kind === 'lasso') {
        if (live.points.length >= 3) P.onLasso({ nativeEvent: { polygon: live.points.map(({ x, y }) => ({ x, y })) } });
      } else if (live.points.length > 0) {
        const id = uuid();
        const last = live.points[live.points.length - 1]!;
        const heldMs = Math.max(0, Math.round(Math.max(last.t, ev.timeStamp - live.t0) - live.holdT));
        s.finished.push({
          id,
          color: live.color,
          alpha: live.tool === 'highlighter' ? HIGHLIGHTER_ALPHA : 1,
          path: outlinePath(live.tool, live.width, live.points),
        });
        setTimeout(() => {
          const before = s.finished.length;
          s.finished = s.finished.filter((f) => f.id !== id);
          if (s.finished.length !== before) s.draw();
        }, PENDING_FALLBACK_MS);
        P.onStrokeEnd({
          nativeEvent: { id, tool: live.tool, color: live.color, width: live.width, points: live.points, heldMs },
        });
      }
      draw();
    };

    const onDown = (ev: PointerEvent) => {
      const P = propsRef.current;
      if (ev.pointerType === 'pen') {
        s.penPointers.add(ev.pointerId);
        notePen(ev);
        firePenButton(ev);
        if (s.live && !s.live.isPen) {
          retract(); // the palm got there first
          reject('pen-took-over');
        }
        if (!s.live) start(ev, true);
        return;
      }
      if (ev.pointerType === 'touch') {
        if (P.input.drawWith === 'pen') return reject('pen-only'); // fingers scroll and zoom
        if (palmSizeExceeded(ev)) return reject('palm-size');
        if (ev.timeStamp - s.lastPen.t < PEN_LOCKOUT_MS) return reject('pen-lockout');
        if (handSide(ev)) return reject('hand-side');
        if (s.live?.isPen) return reject('pen-active');
        if (s.live) {
          // A second finger: this is a scroll / zoom, not ink.
          retract();
          reject('multi-touch');
          return;
        }
        start(ev, false);
        return;
      }
      if (ev.button === 0 && !s.live) start(ev, false); // mouse
    };

    const onMove = (ev: PointerEvent) => {
      if (ev.pointerType === 'pen') {
        notePen(ev);
        firePenButton(ev);
      }
      const live = s.live;
      if (live && ev.pointerId === live.pointerId) {
        if (ev.pointerType === 'touch' && palmSizeExceeded(ev)) {
          retract(); // the contact grew into a palm
          reject('palm-size');
          return;
        }
        const coalesced = ev.getCoalescedEvents?.() ?? [];
        for (const c of coalesced.length ? coalesced : [ev]) addPoint(live, c);
        live.predicted = live.kind === 'ink' ? (ev.getPredictedEvents?.() ?? []).map((p) => toPoint(p, live)) : [];
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
      if (s.hover) {
        s.hover = null;
        draw();
      }
    };

    // A hovering pen must never pan: switch touch-action before it touches down.
    const onOver = (ev: PointerEvent) => {
      if (ev.pointerType === 'pen') canvas.style.touchAction = 'none';
    };

    // Chromium may still turn a pen drag into a pan: cancel the compatibility touch events of pen contacts.
    const onTouchStart = (ev: TouchEvent) => {
      if (s.penPointers.size > 0 || s.live?.isPen) ev.preventDefault();
    };

    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onCancel);
    canvas.addEventListener('pointerleave', onLeave);
    canvas.addEventListener('pointerover', onOver);
    canvas.addEventListener('touchstart', onTouchStart, { passive: false });
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
      ro.disconnect();
      s.draw = () => {};
    };
  }, []);

  // Redraw the hover preview when the brush changes.
  React.useEffect(() => state.current.draw(), [props.tool, props.width, props.color, props.pageSize.w, props.pageSize.h]);

  return (
    <View style={[StyleSheet.absoluteFill, props.style]} pointerEvents={props.tool === 'none' ? 'none' : 'auto'}>
      <canvas
        ref={canvasRef}
        style={{
          width: '100%',
          height: '100%',
          display: 'block',
          touchAction: touchActionFor(props),
          cursor: props.tool === 'none' ? 'default' : 'crosshair',
        }}
      />
    </View>
  );
}

function touchActionFor(p: InkOverlayProps): string {
  return p.input.drawWith === 'pen' ? 'pan-x pan-y pinch-zoom' : 'none';
}
