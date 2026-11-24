// The fullscreen focus layout's floating tool pill: pen, highlighter, eraser, lasso, colour, undo / redo and exit.
// It sits on one window edge (vertical on the left and right), can be dragged to another one by its grip (a tap on
// the grip moves it to the next edge, for keyboards and screen readers), and remembers where it was (local prefs).
import { splitAlpha, type PaperColor } from '@qalm/core';
import * as React from 'react';
import { PanResponder, Platform, Pressable, StyleSheet, View } from 'react-native';

import { kvGet, kvSet } from '../lib/kv';
import { Appear, hoverTransition } from '../theme/motion';
import { useTheme } from '../theme/ThemeProvider';
import { CONTROL_H, radius, shadow2, space } from '../theme/tokens';
import { IconButton } from '../ui/controls';
import { Icon } from '../ui/Icon';
import { contrastRatio } from './colors.logic';
import type { ToolState } from './context';
import { DEFAULT_PILL, isVertical, parsePill, pillOrigin, snapPill, type Edge, type Pad, type PillPlace, type Size } from './focus.logic';
import { SwatchStrip } from './Swatches';
import { ToolButton } from './Toolbar';
import type { ToolId } from './view';

const PILL_KEY = 'focusPill';
const NEXT_EDGE: Record<Edge, Edge> = { top: 'right', right: 'bottom', bottom: 'left', left: 'top' };
const PILL_TOOLS: { id: ToolId; icon: 'pen' | 'highlighter' | 'eraser' | 'lasso'; label: string }[] = [
  { id: 'pen', icon: 'pen', label: 'Pen' },
  { id: 'highlighter', icon: 'highlighter', label: 'Highlighter' },
  { id: 'eraser', icon: 'eraser', label: 'Eraser' },
  { id: 'lasso', icon: 'lasso', label: 'Lasso select' },
];

/** The pill's saved place. */
export function usePillPlace(): [PillPlace, (p: PillPlace) => void] {
  const [place, setPlace] = React.useState<PillPlace>(DEFAULT_PILL);
  React.useEffect(() => {
    void kvGet<unknown>(PILL_KEY).then((v) => v !== undefined && setPlace(parsePill(v)));
  }, []);
  const save = React.useCallback((p: PillPlace) => {
    setPlace(p);
    void kvSet(PILL_KEY, p);
  }, []);
  return [place, save];
}

export interface FocusPillProps {
  /** The area the pill floats over (the page view). */
  view: Size;
  pad: Pad;
  place: PillPlace;
  onPlace(p: PillPlace): void;
  /** The pill's measured size (the editor keeps the selection bar clear of it). */
  onSize?(s: Size): void;
  tools: ToolState;
  paper?: PaperColor;
  onTool(t: ToolId): void;
  onChange(p: Partial<ToolState>): void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo(): void;
  onRedo(): void;
  onExit(): void;
  exitLabel: string;
}

export function FocusPill(p: FocusPillProps) {
  const { c } = useTheme();
  const vertical = isVertical(p.place.edge);
  const [size, setSize] = React.useState<Size & { vertical: boolean }>({ w: 0, h: 0, vertical });
  // Right after the pill turns (top ↔ side), its last measured size is the other way round.
  const pill = size.vertical === vertical ? size : { w: size.h, h: size.w };
  const at = pillOrigin(p.place, p.view, pill, p.pad);
  const [drag, setDrag] = React.useState<{ dx: number; dy: number } | null>(null);
  const [colours, setColours] = React.useState(false);

  const live = React.useRef({ at, pill, view: p.view, place: p.place, onPlace: p.onPlace });
  live.current = { at, pill, view: p.view, place: p.place, onPlace: p.onPlace };
  const responder = React.useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: () => setColours(false),
        onPanResponderMove: (_e, g) => setDrag({ dx: g.dx, dy: g.dy }),
        onPanResponderRelease: (_e, g) => {
          setDrag(null);
          const l = live.current;
          if (Math.hypot(g.dx, g.dy) < 6) return l.onPlace({ ...l.place, edge: NEXT_EDGE[l.place.edge] });
          l.onPlace(snapPill(l.at.left + g.dx + l.pill.w / 2, l.at.top + g.dy + l.pill.h / 2, l.view));
        },
        onPanResponderTerminate: () => setDrag(null),
      }),
    [],
  );

  const t = p.tools.tool;
  const hl = t === 'highlighter';
  const colour = hl ? splitAlpha(p.tools.hlColor, 1).rgb : p.tools.penColor;
  const sep = <View style={[vertical ? styles.sepH : styles.sepV, { backgroundColor: c.line }]} />;
  const tip = (label: string) => (Platform.OS === 'web' ? ({ title: label } as object) : {});

  // The colour popover opens beside the pill, on the side away from its edge.
  const gap = space.sm;
  const pop =
    p.place.edge === 'top'
      ? { top: at.top + pill.h + gap, left: Math.max(space.md, Math.min(at.left, p.view.w - 360)) }
      : p.place.edge === 'bottom'
        ? { bottom: p.view.h - at.top + gap, left: Math.max(space.md, Math.min(at.left, p.view.w - 360)) }
        : p.place.edge === 'left'
          ? { left: at.left + pill.w + gap, top: at.top }
          : { right: p.view.w - at.left + gap, top: at.top };

  return (
    <>
      <Appear
        from={p.place.edge === 'top' ? 'top' : p.place.edge === 'bottom' ? 'bottom' : p.place.edge}
        style={[
          styles.pill,
          shadow2,
          vertical ? styles.col : styles.row,
          { backgroundColor: c.surface, borderColor: c.line, left: at.left + (drag?.dx ?? 0), top: at.top + (drag?.dy ?? 0), opacity: size.w ? 1 : 0 },
        ]}
      >
        <View
          onLayout={(e) => {
            const { width, height } = e.nativeEvent.layout;
            setSize((s) => (s.w === width && s.h === height && s.vertical === vertical ? s : { w: width, h: height, vertical }));
            p.onSize?.({ w: width, h: height });
          }}
          style={vertical ? styles.col : styles.row}
        >
          <View
            {...responder.panHandlers}
            accessible
            accessibilityRole="button"
            accessibilityLabel="Move toolbar"
            accessibilityHint="Drag it to another edge of the screen, or tap to move it to the next edge"
            {...tip('Drag to move')}
            style={[vertical ? styles.gripV : styles.gripH, Platform.OS === 'web' ? ({ cursor: drag ? 'grabbing' : 'grab', touchAction: 'none' } as object) : null]}
          >
            <Icon name="more-vertical" size={16} color={c.faint} />
          </View>
          {PILL_TOOLS.map((x) => (
            <ToolButton key={x.id} icon={x.icon} label={x.label} selected={t === x.id} onPress={() => p.onTool(x.id)} />
          ))}
          {sep}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={hl ? 'Highlighter colour' : 'Pen colour'}
            accessibilityState={{ expanded: colours }}
            onPress={() => setColours((x) => !x)}
            {...tip(hl ? 'Highlighter colour' : 'Pen colour')}
            style={(s) => [
              styles.btn,
              hoverTransition,
              { backgroundColor: colours ? c.accentSoft : s.pressed ? c.soft : (s as { hovered?: boolean }).hovered ? c.surface2 : 'transparent' },
            ]}
          >
            {/* A colour close to the pill's own (graphite in dark mode) gets a visible outline, as in the toolbar. */}
            <View style={[styles.dot, { backgroundColor: colour }, contrastRatio(colour, c.surface) < 1.6 ? { borderWidth: 1, borderColor: c.faint } : { borderColor: c.line }]} />
          </Pressable>
          {sep}
          <IconButton icon="rotate-ccw" label="Undo" disabled={!p.canUndo} onPress={p.onUndo} />
          <IconButton icon="rotate-cw" label="Redo" disabled={!p.canRedo} onPress={p.onRedo} />
          {sep}
          <IconButton icon="minimize" label={p.exitLabel} onPress={p.onExit} />
        </View>
      </Appear>
      {colours ? (
        <Appear from={p.place.edge === 'bottom' ? 'bottom' : 'top'} style={[styles.pop, shadow2, pop, { backgroundColor: c.surface, borderColor: c.line }]}>
          <SwatchStrip
            tool={hl ? 'highlighter' : 'pen'}
            paper={p.paper}
            current={hl ? p.tools.hlColor : p.tools.penColor}
            onSelect={(hex) => {
              // A colour picked while erasing or selecting is for the pen.
              if (hl) p.onChange({ hlColor: hex });
              else p.onChange(t === 'pen' || t === 'text' ? { penColor: hex } : { penColor: hex, tool: 'pen' });
              setColours(false);
            }}
          />
        </Appear>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  pill: { position: 'absolute', borderRadius: radius.panel, borderWidth: StyleSheet.hairlineWidth, padding: 4 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  col: { flexDirection: 'column', alignItems: 'center', gap: 2 },
  gripH: { width: 20, height: CONTROL_H, alignItems: 'center', justifyContent: 'center' },
  gripV: { width: CONTROL_H, height: 20, alignItems: 'center', justifyContent: 'center', transform: [{ rotate: '90deg' }] },
  btn: { width: CONTROL_H, height: CONTROL_H, borderRadius: radius.control, alignItems: 'center', justifyContent: 'center' },
  dot: { width: 22, height: 22, borderRadius: 11, borderWidth: StyleSheet.hairlineWidth },
  sepV: { width: StyleSheet.hairlineWidth, alignSelf: 'stretch', marginVertical: space.md, marginHorizontal: space.xxs },
  sepH: { height: StyleSheet.hairlineWidth, alignSelf: 'stretch', marginHorizontal: space.md, marginVertical: space.xxs },
  pop: { position: 'absolute', borderRadius: radius.panel, borderWidth: StyleSheet.hairlineWidth, padding: 4, flexDirection: 'row', alignItems: 'center', maxWidth: 360 },
});
