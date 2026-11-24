// The on-page ruler (tech-spec §7, Ruler): a translucent straightedge over the pages with mm / cm ticks at the page's
// scale and its angle. It lives in the editor (never in the page or an export). One finger or the mouse moves it, two
// fingers turn and move it, the round handle turns it with the mouse; angles snap to 0 / 45 / 90°. A pen landing on it
// writes (web hands the pen to the ink overlay under it), and a pen stroke that starts near an edge follows that edge
// (the overlays do that, from the pose the editor passes them).
import { rulerDegrees, type RulerPose } from '@qalm/core';
import { forwardToInk, MM_PER_CSS_PX, palmVerdict, pointerContact, type InkInputSettings, type PenSeen } from 'qalm-ink';
import * as React from 'react';
import { PanResponder, Platform, Pressable, StyleSheet, View, type GestureResponderEvent } from 'react-native';
import Svg, { Line } from 'react-native-svg';

import { useTheme } from '../theme/ThemeProvider';
import { Icon } from '../ui/Icon';
import { Text } from '../ui/Text';
import { dragRuler, keepInView, rotateRuler, rulerTicks, twoFingerRuler, type Pt } from './ruler.logic';

/** The ticks start this far in from the ruler's left end (its zero), like a real ruler's. */
const ZERO_INSET = 16;
/** Tick lengths (px) for mm, 5 mm and cm. */
const TICK = { mm: 7, half: 11, cm: 16 } as const;
const HANDLE = 30;

export interface RulerProps {
  /** Pose in the view's px (the editor's page area). */
  pose: RulerPose;
  /** The view's size, to keep the ruler on screen. */
  view: { w: number; h: number };
  /** Where the view is in the window (pointers come in window coordinates). */
  origin: { x: number; y: number };
  /** Page mm at the current zoom, in px (the ticks measure the page). */
  pxPerMm: number;
  input: Pick<InkInputSettings, 'hand' | 'palm'>;
  /** A move ended: the new pose (while it moves, the ruler shows it itself, so the editor doesn't re-render). */
  onChange(pose: RulerPose): void;
  onClose(): void;
}

export function Ruler({ pose: committed, view, origin, pxPerMm, input, onChange, onClose }: RulerProps) {
  const { c } = useTheme();
  const root = React.useRef<React.ComponentRef<typeof View>>(null);
  const [moving, setMoving] = React.useState<RulerPose | null>(null);
  const pose = moving ?? committed;
  const live = React.useRef({ pose, view, origin, input, onChange });
  live.current = { pose, view, origin, input, onChange };

  // ---- gestures, in window coordinates; `origin` turns them into the view's px ----
  const g = React.useRef({
    pointers: new Map<number, Pt>(),
    start: null as null | { pose: RulerPose; pts: Map<number, Pt>; rotate: boolean },
    lastPen: { x: 0, y: 0, t: -Infinity } as PenSeen,
    moved: false,
  });

  const rebase = (rotate: boolean) => {
    const s = g.current;
    s.start = s.pointers.size ? { pose: live.current.pose, pts: new Map(s.pointers), rotate } : null;
  };
  const toView = (p: Pt): Pt => ({ x: p.x - live.current.origin.x, y: p.y - live.current.origin.y });
  const update = () => {
    const s = g.current;
    const st = s.start;
    if (!st) return;
    const ids = [...s.pointers.keys()].filter((id) => st.pts.has(id));
    let next = st.pose;
    if (ids.length >= 2) {
      const [a, b] = ids as [number, number];
      next = twoFingerRuler(st.pose, toView(st.pts.get(a)!), toView(st.pts.get(b)!), toView(s.pointers.get(a)!), toView(s.pointers.get(b)!));
    } else if (ids.length === 1) {
      const id = ids[0]!;
      const from = toView(st.pts.get(id)!);
      const to = toView(s.pointers.get(id)!);
      next = st.rotate ? rotateRuler(st.pose, from, to) : dragRuler(st.pose, from, to);
    }
    s.moved = true;
    const kept = keepInView(next, live.current.view);
    live.current.pose = kept; // a rebase before the next render starts from here
    setMoving(kept);
  };
  const end = () => {
    const s = g.current;
    if (s.moved) live.current.onChange(live.current.pose);
    s.moved = false;
    setMoving(null);
  };

  // Web / Electron: pointer events on the ruler's element.
  React.useEffect(() => {
    if (Platform.OS !== 'web') return;
    const el = root.current as unknown as HTMLElement | null;
    if (!el) return;
    const s = g.current;
    const notePen = (ev: PointerEvent) => {
      if (ev.pointerType === 'pen') s.lastPen = { x: ev.clientX, y: ev.clientY, t: ev.timeStamp };
    };
    const isPalm = (ev: PointerEvent) => ev.pointerType === 'touch' && palmVerdict(pointerContact(ev), s.lastPen, live.current.input, MM_PER_CSS_PX) !== null;
    const take = (ev: PointerEvent, rotate: boolean) => {
      s.pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      try {
        el.setPointerCapture(ev.pointerId);
      } catch {
        // already gone
      }
      rebase(rotate);
    };
    const onDown = (ev: PointerEvent) => {
      notePen(ev);
      // A pen writes, even over the ruler: hand it to the ink overlay underneath.
      if (ev.pointerType === 'pen') {
        if (forwardToInk(ev)) {
          ev.preventDefault();
          ev.stopPropagation();
        }
        return;
      }
      if ((ev.target as Element | null)?.closest?.('[data-ruler-close]')) return; // the hide button presses as usual
      ev.preventDefault(); // no compatibility mouse events (nothing under the ruler reacts), no text selection
      ev.stopPropagation();
      if (ev.pointerType === 'mouse' && ev.button !== 0) return;
      if (isPalm(ev)) return; // a resting hand doesn't move the ruler
      const onHandle = !!(ev.target as Element | null)?.closest?.('[data-ruler-handle]');
      take(ev, onHandle && ev.pointerType === 'mouse');
    };
    // While a finger is on the ruler, a further finger anywhere is the ruler's too (two fingers turn it), not ink.
    const onWindowDown = (ev: PointerEvent) => {
      notePen(ev);
      if (ev.pointerType !== 'touch' || !s.pointers.size || s.pointers.size >= 2 || el.contains(ev.target as Node)) return;
      if (isPalm(ev)) return;
      ev.preventDefault();
      ev.stopImmediatePropagation();
      take(ev, false);
    };
    const onWindowTouch = (ev: TouchEvent) => {
      if (s.pointers.size && !el.contains(ev.target as Node)) ev.preventDefault(); // that finger mustn't scroll the page
    };
    const onMove = (ev: PointerEvent) => {
      notePen(ev);
      const p = s.pointers.get(ev.pointerId);
      if (!p) return;
      p.x = ev.clientX;
      p.y = ev.clientY;
      update();
    };
    const onUp = (ev: PointerEvent) => {
      if (!s.pointers.delete(ev.pointerId)) return;
      if (s.pointers.size) rebase(false);
      else {
        s.start = null;
        end();
      }
    };
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
    window.addEventListener('pointerdown', onWindowDown, true);
    window.addEventListener('pointermove', notePen, true);
    window.addEventListener('touchstart', onWindowTouch, { capture: true, passive: false });
    return () => {
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onUp);
      window.removeEventListener('pointerdown', onWindowDown, true);
      window.removeEventListener('pointermove', notePen, true);
      window.removeEventListener('touchstart', onWindowTouch, { capture: true });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // iOS / Android: the responder system, with every touch on screen (two fingers turn it; a pen on it moves it too).
  const native = React.useMemo(() => {
    if (Platform.OS === 'web') return null;
    const fromTouches = (e: GestureResponderEvent) => {
      const s = g.current;
      const seen = new Set<number>();
      for (const t of e.nativeEvent.touches) {
        const id = Number(t.identifier);
        seen.add(id);
        s.pointers.set(id, { x: t.pageX, y: t.pageY });
      }
      for (const id of [...s.pointers.keys()]) if (!seen.has(id)) s.pointers.delete(id);
    };
    const responder = (rotate: boolean) =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: (e) => {
          g.current.pointers.clear();
          fromTouches(e);
          rebase(rotate);
        },
        onPanResponderMove: (e) => {
          const before = g.current.pointers.size;
          fromTouches(e);
          if (g.current.pointers.size !== before) rebase(false);
          else update();
        },
        onPanResponderRelease: () => {
          g.current.pointers.clear();
          g.current.start = null;
          end();
        },
        onPanResponderTerminate: () => {
          g.current.pointers.clear();
          g.current.start = null;
          end();
        },
      });
    return { body: responder(false), handle: responder(true) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const ticks = React.useMemo(() => rulerTicks(pose.length - 2 * ZERO_INSET, pxPerMm), [pose.length, pxPerMm]);
  const deg = rulerDegrees(pose.angle);
  const H = pose.thickness;
  const tickColor = c.ink2;

  return (
    <View
      ref={root}
      accessible
      accessibilityRole="image"
      accessibilityLabel={`Ruler, ${deg}°`}
      {...(native ? native.body.panHandlers : {})}
      style={[
        styles.ruler,
        {
          left: pose.cx - pose.length / 2,
          top: pose.cy - H / 2,
          width: pose.length,
          height: H,
          transform: [{ rotate: `${pose.angle}rad` }],
          // Translucent so the page shows through (the owner's choice for an on-page tool); hairline edges.
          backgroundColor: c.surface + 'cc',
          borderColor: c.ink2,
        },
        Platform.OS === 'web' ? ({ touchAction: 'none', cursor: 'grab', userSelect: 'none' } as object) : null,
      ]}
    >
      <Svg width={pose.length} height={H} style={StyleSheet.absoluteFill} pointerEvents="none">
        {ticks.map((t) => (
          <React.Fragment key={t.x}>
            <Line x1={ZERO_INSET + t.x} x2={ZERO_INSET + t.x} y1={0} y2={TICK[t.kind]} stroke={tickColor} strokeWidth={t.kind === 'mm' ? 0.8 : 1.1} />
            <Line x1={ZERO_INSET + t.x} x2={ZERO_INSET + t.x} y1={H} y2={H - TICK[t.kind]} stroke={tickColor} strokeWidth={t.kind === 'mm' ? 0.8 : 1.1} />
          </React.Fragment>
        ))}
      </Svg>
      {ticks
        .filter((t) => t.kind === 'cm')
        .map((t) => (
          <Text key={`l${t.x}`} variant="meta" pointerEvents="none" style={[styles.num, { left: ZERO_INSET + t.x - 12, top: TICK.cm + 1, color: c.muted }]}>
            {t.label}
          </Text>
        ))}
      <View pointerEvents="none" style={[styles.readout, { backgroundColor: c.accentSoft, borderColor: c.accentLine }]}>
        <Text variant="smallStrong" style={{ color: c.accentInk, fontVariant: ['tabular-nums'] }}>
          {deg}°
        </Text>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Hide ruler"
        onPress={onClose}
        hitSlop={6}
        {...({ dataSet: { rulerClose: '1' } } as object)}
        {...(Platform.OS === 'web' ? ({ title: 'Hide ruler (R)' } as object) : {})}
        style={(s) => [styles.handle, { left: 4, backgroundColor: s.pressed ? c.soft : c.surface, borderColor: c.line }]}
      >
        <Icon name="x" size={14} color={c.ink2} />
      </Pressable>
      <View
        {...(native ? native.handle.panHandlers : {})}
        {...({ dataSet: { rulerHandle: '1' } } as object)}
        accessible
        accessibilityLabel="Turn ruler"
        {...(Platform.OS === 'web' ? ({ title: 'Drag to turn' } as object) : {})}
        style={[styles.handle, { right: 4, backgroundColor: c.surface, borderColor: c.line }, Platform.OS === 'web' ? ({ cursor: 'alias' } as object) : null]}
      >
        <Icon name="rotate-cw" size={14} color={c.ink2} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  ruler: { position: 'absolute', borderTopWidth: 1, borderBottomWidth: 1, borderRadius: 2, overflow: 'hidden' },
  num: { position: 'absolute', width: 24, textAlign: 'center', fontSize: 10, lineHeight: 12 },
  readout: {
    position: 'absolute',
    alignSelf: 'center',
    top: '50%',
    marginTop: -11,
    height: 22,
    paddingHorizontal: 8,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  handle: {
    position: 'absolute',
    top: '50%',
    marginTop: -HANDLE / 2,
    width: HANDLE,
    height: HANDLE,
    borderRadius: HANDLE / 2,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
