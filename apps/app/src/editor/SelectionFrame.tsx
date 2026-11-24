import { frameCorners, moveBy, resizeSim, rotateSim, selectionFrame, textWidthPatch, type Frame, type Item, type TextItem } from '@qalm/core';
import * as React from 'react';
import { useMathFill } from 'qalm-ink';
import { PanResponder, Platform, StyleSheet, View } from 'react-native';
import { GestureDetector, usePanGesture, type PanGesture } from 'react-native-gesture-handler';

import { Icon } from '../ui/Icon';
import { liveFrame, type LiveEdit } from './selection.logic';

export type { LiveEdit } from './selection.logic';

/** Frame colours: the brand accent on light paper; a lighter indigo (and dark knobs) on night paper. */
export const PAPER_ACCENT = { light: { line: '#4338ca', knob: '#ffffff' }, night: { line: '#a5b4fc', knob: '#1f1f23' } } as const;
/** px between the ink and the frame line */
const PAD = 6;
/** px hit target of a handle (brand: 44 px touch targets) */
const HIT = 44;
/** px from the frame's top edge to the rotate handle */
const ROT_OFF = 30;
/** px of movement below which a press on the frame is a tap */
const TAP_SLOP = 4;

type P = [number, number];

export interface SelectionFrameProps {
  /** The selected items as they are on the page (not the live edit). */
  items: Item[];
  /** px per page unit */
  scale: number;
  live: LiveEdit | null;
  onLive(edit: LiveEdit | null): void;
  onCommit(edit: LiveEdit): void;
  /** A tap (no drag) inside the frame, at a window point (pageX/pageY). */
  onTap(windowX: number, windowY: number): void;
  /** On night paper the frame uses a lighter accent. */
  night?: boolean;
}

const cursor = (c: string) => (Platform.OS === 'web' ? ({ cursor: c } as object) : null);

interface DragHandlers {
  /** Where the press started, in window coordinates. */
  start?(x0: number, y0: number): void;
  move(dx: number, dy: number): void;
  end(dx: number, dy: number): void;
}

/** A drag that owns the gesture until it ends (the page must not scroll or draw meanwhile). */
type Drag = { panHandlers: object } | { gesture: PanGesture };

/**
 * Web: a PanResponder. iOS / Android: a gesture-handler pan. A PanResponder is granted asynchronously there, so a
 * native ScrollView takes a quick drag (past its touch slop) first and the page scrolls instead of the selection
 * moving; a gesture-handler pan is recognised natively, before the ScrollView, and then cancels it.
 */
const useDrag: (h: DragHandlers, onCancel: () => void) => Drag =
  Platform.OS === 'web'
    ? function useResponderDrag(h, onCancel) {
        const ref = React.useRef({ h, onCancel });
        ref.current = { h, onCancel };
        return React.useMemo(
          () => ({
            panHandlers: PanResponder.create({
              onStartShouldSetPanResponder: () => true,
              onMoveShouldSetPanResponder: () => true,
              onPanResponderTerminationRequest: () => false,
              onPanResponderGrant: (_e, g) => ref.current.h.start?.(g.x0, g.y0),
              onPanResponderMove: (_e, g) => ref.current.h.move(g.dx, g.dy),
              onPanResponderRelease: (_e, g) => ref.current.h.end(g.dx, g.dy),
              onPanResponderTerminate: () => ref.current.onCancel(),
            }).panHandlers,
          }),
          [],
        );
      }
    : function useNativeDrag(h, onCancel) {
        const ref = React.useRef({ h, onCancel });
        ref.current = { h, onCancel };
        const moved = React.useRef<[number, number]>([0, 0]);
        const active = React.useRef(false);
        const gesture = usePanGesture({
          runOnJS: true,
          disableReanimated: true,
          minDistance: 0,
          maxPointers: 1,
          onBegin: (e) => {
            moved.current = [0, 0];
            active.current = false;
            ref.current.h.start?.(e.absoluteX, e.absoluteY);
          },
          onActivate: () => {
            active.current = true;
          },
          onUpdate: (e) => {
            moved.current = [e.translationX, e.translationY];
            ref.current.h.move(e.translationX, e.translationY);
          },
          // A press that never moved "fails" (canceled): that is a tap, which end() turns into onTap.
          onFinalize: (e) => (e.canceled && active.current ? ref.current.onCancel() : ref.current.h.end(...moved.current)),
        });
        return { gesture };
      };

/**
 * The selection's frame on the page: drag inside to move, corner handles to resize (uniform, so images keep their
 * aspect), the round handle above to rotate. A single text box gets edge handles instead of corners: they change its
 * width (the text reflows) and never its font size.
 */
export function SelectionFrame({ items, scale, live, onLive, onCommit, onTap, night }: SelectionFrameProps) {
  const accent = night ? PAPER_ACCENT.night : PAPER_ACCENT.light;
  const line = { borderColor: accent.line };
  const knob = { borderColor: accent.line, backgroundColor: accent.knob };
  // A Markdown box's height changes when its maths fills in (MathJax loaded on demand, or a deferred time slice).
  const fill = useMathFill(true);
  const base = React.useMemo(() => selectionFrame(items), [items, fill]); // eslint-disable-line react-hooks/exhaustive-deps
  const frame = liveFrame(items, live);
  const single = items.length === 1 ? items[0]! : null;
  const textOnly = single?.type === 'text' ? single : null;

  // Everything a gesture needs is captured when it starts.
  const g0 = React.useRef<{ frame: Frame; at: P; text?: TextItem } | null>(null);
  const liveRef = React.useRef(live);
  liveRef.current = live;
  const cancel = () => {
    g0.current = null;
    onLive(null);
  };
  const finish = () => {
    const l = liveRef.current;
    g0.current = null;
    onLive(null);
    if (l) onCommit(l);
  };
  const k = 1 / scale;

  const body = useDrag(
    {
      start: (x0, y0) => base && (g0.current = { frame: base, at: [x0, y0] }),
      move: (dx, dy) => g0.current && (Math.abs(dx) > TAP_SLOP || Math.abs(dy) > TAP_SLOP || liveRef.current) && onLive({ kind: 'sim', sim: moveBy(dx * k, dy * k) }),
      end: (dx, dy) => {
        const at = g0.current?.at;
        if (!liveRef.current && at && Math.abs(dx) <= TAP_SLOP && Math.abs(dy) <= TAP_SLOP) {
          cancel();
          onTap(at[0], at[1]);
        } else finish();
      },
    },
    cancel,
  );

  const corner = (i: number) => ({
    start: () => base && (g0.current = { frame: base, at: frameCorners(base)[i]! }),
    move: (dx: number, dy: number) => {
      const s = g0.current;
      if (s) onLive({ kind: 'sim', sim: resizeSim(s.frame, i, [s.at[0] + dx * k, s.at[1] + dy * k]) });
    },
    end: finish,
  });
  const c0 = useDrag(corner(0), cancel);
  const c1 = useDrag(corner(1), cancel);
  const c2 = useDrag(corner(2), cancel);
  const c3 = useDrag(corner(3), cancel);

  const rotate = useDrag(
    {
      start: () => {
        if (!base) return;
        const up = base.h / 2 + (PAD + ROT_OFF) * k;
        g0.current = { frame: base, at: [base.cx + Math.sin(base.rot) * up, base.cy - Math.cos(base.rot) * up] };
      },
      move: (dx, dy) => {
        const s = g0.current;
        if (s) onLive({ kind: 'sim', sim: rotateSim(s.frame, s.at, [s.at[0] + dx * k, s.at[1] + dy * k]) });
      },
      end: finish,
    },
    cancel,
  );

  const side = (which: 'left' | 'right') => ({
    start: () => {
      if (!base || !textOnly) return;
      const [tl, tr] = frameCorners(base);
      const [bl, br] = [frameCorners(base)[3]!, frameCorners(base)[2]!];
      const at: P = which === 'left' ? [(tl![0] + bl[0]) / 2, (tl![1] + bl[1]) / 2] : [(tr![0] + br[0]) / 2, (tr![1] + br[1]) / 2];
      g0.current = { frame: base, at, text: textOnly };
    },
    move: (dx: number, dy: number) => {
      const s = g0.current;
      if (!s?.text) return;
      // The edge handle sits PAD px outside the box: aim at the box edge itself.
      const out = which === 'left' ? -PAD * k : PAD * k;
      const r = s.text.rot ?? 0;
      const p: P = [s.at[0] + dx * k - Math.cos(r) * out, s.at[1] + dy * k - Math.sin(r) * out];
      onLive({ kind: 'text', id: s.text.id, patch: textWidthPatch(s.text, which, p) });
    },
    end: finish,
  });
  const left = useDrag(side('left'), cancel);
  const right = useDrag(side('right'), cancel);

  if (!frame) return null;
  // px: the frame box (with PAD), and a margin around it big enough for the handles, so they stay inside this view
  // (Android only delivers touches inside a view's bounds).
  const bw = Math.max(12, frame.w * scale + PAD * 2);
  const bh = Math.max(12, frame.h * scale + PAD * 2);
  const m = HIT / 2;
  const top = ROT_OFF + HIT / 2;
  const W = bw + m * 2;
  const H = bh + m + top;

  const handle = (key: string, x: number, y: number, pan: Drag, label: string, cur: string, shape: 'square' | 'bar' | 'round') => (
    <Draggable
      key={key}
      drag={pan}
      accessibilityLabel={label}
      style={[styles.hit, { left: x - HIT / 2, top: y - HIT / 2 }, cursor(cur)]}
    >
      {shape === 'round' ? (
        // The icon (a Text) must not take the touch from the handle (gesture-handler on Android).
        <View pointerEvents="none" style={[styles.knob, knob, styles.round]}>
          <Icon name="rotate-cw" size={11} color={accent.line} />
        </View>
      ) : (
        <View pointerEvents="none" style={[styles.knob, knob, shape === 'bar' ? styles.bar : styles.square]} />
      )}
    </Draggable>
  );

  const deg = (frame.rot * 180) / Math.PI;
  const resizeCursor = (i: number) => {
    // nwse for the top-left/bottom-right diagonal, turned with the frame.
    const a = ((deg + (i % 2 ? 90 : 0)) % 180 + 180) % 180;
    return a < 22.5 || a >= 157.5 ? 'nwse-resize' : a < 67.5 ? 'ns-resize' : a < 112.5 ? 'nesw-resize' : 'ew-resize';
  };

  return (
    <View
      pointerEvents="box-none"
      // Always a real native view: a layout-only view is flattened away until a live rotation gives it a transform,
      // and re-parenting the handles then cancels the rotate drag (gesture-handler, Android).
      collapsable={false}
      style={{
        position: 'absolute',
        left: frame.cx * scale - bw / 2 - m,
        top: frame.cy * scale - bh / 2 - top,
        width: W,
        height: H,
        transform: frame.rot ? [{ rotate: `${deg}deg` }] : undefined,
        // Turn about the frame's centre, not this view's (it has the rotate handle's room on top).
        transformOrigin: `${m + bw / 2}px ${top + bh / 2}px`,
      }}
    >
      {/* the rotate handle's stem */}
      <View pointerEvents="none" style={[styles.stem, { backgroundColor: accent.line, left: m + bw / 2 - 0.5, top: top - ROT_OFF + 8, height: ROT_OFF - 8 }]} />
      <Draggable drag={body} accessibilityLabel="Move selection" style={[styles.box, line, { left: m, top, width: bw, height: bh }, cursor('move')]} />
      {textOnly ? (
        <>
          {handle('l', m, top + bh / 2, left, 'Text box width', resizeCursor(1), 'bar')}
          {handle('r', m + bw, top + bh / 2, right, 'Text box width', resizeCursor(1), 'bar')}
        </>
      ) : (
        <>
          {handle('c0', m, top, c0, 'Resize selection', resizeCursor(0), 'square')}
          {handle('c1', m + bw, top, c1, 'Resize selection', resizeCursor(1), 'square')}
          {handle('c2', m + bw, top + bh, c2, 'Resize selection', resizeCursor(0), 'square')}
          {handle('c3', m, top + bh, c3, 'Resize selection', resizeCursor(1), 'square')}
        </>
      )}
      {handle('rot', m + bw / 2, top - ROT_OFF, rotate, 'Rotate selection', 'grab', 'round')}
    </View>
  );
}

/** A view that a {@link Drag} moves: the responder's handlers on web, wrapped in a GestureDetector on native. */
function Draggable({ drag, children, ...props }: React.ComponentProps<typeof View> & { drag: Drag }) {
  if ('panHandlers' in drag) {
    return (
      <View {...props} {...drag.panHandlers}>
        {children}
      </View>
    );
  }
  return (
    <GestureDetector gesture={drag.gesture}>
      <View {...props}>{children}</View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  box: { position: 'absolute', borderWidth: 1.5, borderStyle: 'dashed', borderRadius: 2 },
  stem: { position: 'absolute', width: 1 },
  hit: { position: 'absolute', width: HIT, height: HIT, alignItems: 'center', justifyContent: 'center' },
  knob: { borderWidth: 1.5 },
  square: { width: 12, height: 12, borderRadius: 3 },
  bar: { width: 8, height: 22, borderRadius: 4 },
  round: { width: 22, height: 22, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
});
