import { HIGHLIGHTER_WIDTH, PEN_WIDTHS, type PaperColor, type PenStyle } from '@qalm/core';
import * as React from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { hoverTransition } from '../theme/motion';
import { useTheme } from '../theme/ThemeProvider';
import { CONTROL_H, CONTROL_H_SM, radius, shadow2, space } from '../theme/tokens';
import { IconButton } from '../ui/controls';
import { Icon } from '../ui/Icon';
import { Text } from '../ui/Text';
import type { ToolState } from './context';
import type { EraserMode } from './items';
import { SwatchStrip } from './Swatches';
import { ToolIcon, type ToolIconName } from './toolIcons';
import { toolbarOverflow } from './toolbar.logic';
import type { ToolId } from './view';

const TOOLS: { id: ToolId; icon: ToolIconName; label: string }[] = [
  { id: 'pen', icon: 'pen', label: 'Pen' },
  { id: 'highlighter', icon: 'highlighter', label: 'Highlighter' },
  { id: 'eraser', icon: 'eraser', label: 'Eraser' },
  { id: 'lasso', icon: 'lasso', label: 'Lasso select' },
  { id: 'text', icon: 'text', label: 'Text box' },
  { id: 'laser', icon: 'laser', label: 'Laser pointer' },
];

/** The laser's modes (K pressed again while the laser is on switches). */
export const LASER_MODES: { id: 'trail' | 'dot'; icon: ToolIconName; label: string }[] = [
  { id: 'trail', icon: 'laser-trail', label: 'Laser trail' },
  { id: 'dot', icon: 'laser-dot', label: 'Laser dot' },
];

export const ERASER_SIZES = [4, 10, 22] as const;

/** The eraser's modes (E switches between them while the eraser is on). */
export const ERASER_MODES: { id: EraserMode; icon: ToolIconName; label: string }[] = [
  { id: 'stroke', icon: 'erase-stroke', label: 'Whole stroke' },
  { id: 'partial', icon: 'erase-partial', label: 'Partial' },
];

const PEN_STYLE_OPTIONS: { id: PenStyle; icon: ToolIconName; label: string }[] = [
  { id: 'fountain', icon: 'fountain', label: 'Fountain pen' },
  { id: 'ball', icon: 'ballpoint', label: 'Ballpoint pen' },
  { id: 'brush', icon: 'brush', label: 'Brush pen' },
];

/** A web hover tooltip with the control's name (icon-only controls). */
const tip = (label: string) => (Platform.OS === 'web' ? ({ title: label } as object) : {});

/**
 * A toolbar tool (solid accent when it's the current tool), or with `toggle` an on/off control such as the ruler
 * (accent-soft with an accent-line border when on, never a solid fill).
 */
export function ToolButton({ icon, label, selected, onPress, toggle }: { icon: ToolIconName; label: string; selected?: boolean; onPress(): void; toggle?: boolean }) {
  const { c } = useTheme();
  const solid = selected && !toggle;
  return (
    <Pressable
      accessibilityRole={toggle ? 'switch' : 'button'}
      accessibilityLabel={label}
      accessibilityState={toggle ? { checked: !!selected } : { selected }}
      onPress={onPress}
      {...tip(label)}
      // Web: a tool is a toggle button, so screen readers hear "pressed" for the current one.
      {...((Platform.OS === 'web' && selected !== undefined ? { 'aria-pressed': selected } : {}) as object)}
      style={(s) => [
        styles.tool,
        hoverTransition,
        {
          backgroundColor: solid ? c.accent : selected ? c.accentSoft : s.pressed ? c.soft : (s as { hovered?: boolean }).hovered ? c.surface2 : 'transparent',
          borderColor: selected && toggle ? c.accentLine : 'transparent',
        },
      ]}
    >
      <ToolIcon name={icon} size={22} color={solid ? c.onAccent : selected ? c.accentInk : c.ink2} />
    </Pressable>
  );
}

function Sep() {
  const { c } = useTheme();
  return <View style={{ width: StyleSheet.hairlineWidth, alignSelf: 'stretch', marginVertical: space.md, marginHorizontal: space.xxs, backgroundColor: c.line }} />;
}

function SizeDot({ size, selected, label, onPress }: { size: number; selected: boolean; label: string; onPress(): void }) {
  const { c } = useTheme();
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityLabel={label}
      accessibilityState={{ checked: selected }}
      onPress={onPress}
      hitSlop={4}
      {...tip(label)}
      style={(s) => [
        styles.sizeHit,
        hoverTransition,
        { backgroundColor: selected ? c.accentSoft : (s as { hovered?: boolean }).hovered ? c.surface2 : 'transparent', borderColor: selected ? c.accentLine : 'transparent' },
      ]}
    >
      <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: selected ? c.accentInk : c.ink2 }} />
    </Pressable>
  );
}

/** A tool option or an on/off toggle: accent-soft with an accent-line border when on (never a solid fill). */
function StyleOption({ icon, label, selected, onPress, toggle }: { icon: ToolIconName; label: string; selected: boolean; onPress(): void; toggle?: boolean }) {
  const { c } = useTheme();
  return (
    <Pressable
      accessibilityRole={toggle ? 'switch' : 'radio'}
      accessibilityLabel={label}
      accessibilityState={{ checked: selected }}
      onPress={onPress}
      hitSlop={4}
      {...tip(label)}
      style={(s) => [
        styles.sizeHit,
        hoverTransition,
        { backgroundColor: selected ? c.accentSoft : (s as { hovered?: boolean }).hovered ? c.surface2 : 'transparent', borderColor: selected ? c.accentLine : 'transparent' },
      ]}
    >
      <ToolIcon name={icon} size={19} color={selected ? c.accentInk : c.ink2} />
    </Pressable>
  );
}

function EdgeChevron({ side, onPress }: { side: 'left' | 'right'; onPress(): void }) {
  const { c } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={side === 'left' ? 'Show earlier tools' : 'Show more tools'}
      onPress={onPress}
      style={(s) => [
        styles.edge,
        side === 'left'
          ? { left: 0, borderRightWidth: StyleSheet.hairlineWidth, borderTopLeftRadius: radius.panel, borderBottomLeftRadius: radius.panel }
          : { right: 0, borderLeftWidth: StyleSheet.hairlineWidth, borderTopRightRadius: radius.panel, borderBottomRightRadius: radius.panel },
        { backgroundColor: (s as { hovered?: boolean }).hovered || s.pressed ? c.soft : c.surface, borderColor: c.line },
      ]}
    >
      <Icon name={side === 'left' ? 'chevron-left' : 'chevron-right'} size={18} color={c.ink2} />
    </Pressable>
  );
}

export interface ToolbarProps {
  tools: ToolState;
  onTool(t: ToolId): void;
  onChange(p: Partial<ToolState>): void;
  onImage(): void;
  zoom: number;
  onZoom(dir: 1 | -1): void;
  onZoomReset(): void;
  /** The current page's paper: the colour picker previews pen ink on it. */
  paper?: PaperColor;
  /** Controls placed before the tools (Undo / Redo on a phone, where the header has no room for them). */
  leading?: React.ReactNode;
  /** The ruler is shown (a toggle, not a tool: the pen stays the tool). */
  ruler: boolean;
  onRuler(): void;
  /** Presentation view (from the laser's options). */
  onPresent(): void;
}

/** The floating toolbar: a solid surface with shadow-2 (brand.md). Scrolls sideways on narrow screens. */
export function Toolbar({ tools, onTool, onChange, onImage, zoom, onZoom, onZoomReset, paper, leading, ruler, onRuler, onPresent }: ToolbarProps) {
  const { c } = useTheme();
  const t = tools.tool;
  const [dragging, setDragging] = React.useState(false);
  // When the bar is wider than the window, chevrons at the clipped edges show (and scroll) the rest.
  const scroll = React.useRef<React.ComponentRef<typeof ScrollView>>(null);
  const [m, setM] = React.useState({ x: 0, view: 0, content: 0 });
  const more = toolbarOverflow(m.x, m.view, m.content);
  const page = (dir: 1 | -1) => scroll.current?.scrollTo({ x: Math.max(0, m.x + dir * Math.max(120, m.view * 0.6)), animated: true });
  return (
    <View style={[styles.bar, shadow2, { backgroundColor: c.surface, borderColor: c.line }]}>
      <ScrollView
        ref={scroll}
        horizontal
        scrollEnabled={!dragging}
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.row}
        scrollEventThrottle={32}
        onScroll={(e) => {
          const x = e.nativeEvent.contentOffset.x;
          setM((p) => (Math.abs(p.x - x) < 1 ? p : { ...p, x }));
        }}
        onLayout={(e) => {
          const view = e.nativeEvent.layout.width;
          setM((p) => (p.view === view ? p : { ...p, view }));
        }}
        onContentSizeChange={(content) => setM((p) => (p.content === content ? p : { ...p, content }))}
      >
        {leading ? (
          <>
            {leading}
            <Sep />
          </>
        ) : null}
        {TOOLS.map((x) => (
          <ToolButton key={x.id} icon={x.icon} label={x.label} selected={t === x.id} onPress={() => onTool(x.id)} />
        ))}
        <ToolButton icon="image" label="Insert image" onPress={onImage} />
        <ToolButton toggle icon="ruler" label={ruler ? 'Hide ruler' : 'Show ruler'} selected={ruler} onPress={onRuler} />
        <Sep />
        {t === 'pen' || t === 'text' ? (
          <>
            <SwatchStrip tool="pen" paper={paper} current={tools.penColor} onSelect={(c) => onChange({ penColor: c })} onDragging={setDragging} />
            {t === 'pen' ? (
              <>
                <Sep />
                {PEN_STYLE_OPTIONS.map((o) => (
                  <StyleOption key={o.id} icon={o.icon} label={o.label} selected={tools.penStyle === o.id} onPress={() => onChange({ penStyle: o.id })} />
                ))}
                <Sep />
                {PEN_WIDTHS.map((w, i) => (
                  <SizeDot key={w} size={4 + i * 3} label={['Fine', 'Medium', 'Bold'][i]!} selected={tools.penWidth === w} onPress={() => onChange({ penWidth: w })} />
                ))}
                <Sep />
                <StyleOption toggle icon="shapes" label="Shape snapping" selected={tools.snapShapes} onPress={() => onChange({ snapShapes: !tools.snapShapes })} />
              </>
            ) : null}
          </>
        ) : null}
        {t === 'highlighter' ? (
          <>
            <SwatchStrip tool="highlighter" current={tools.hlColor} onSelect={(c) => onChange({ hlColor: c })} onDragging={setDragging} />
            <Sep />
            {[HIGHLIGHTER_WIDTH * 0.66, HIGHLIGHTER_WIDTH, HIGHLIGHTER_WIDTH * 1.6].map((w, i) => (
              <SizeDot key={w} size={6 + i * 4} label={['Thin', 'Medium', 'Wide'][i]!} selected={Math.abs(tools.hlWidth - w) < 0.01} onPress={() => onChange({ hlWidth: w })} />
            ))}
          </>
        ) : null}
        {t === 'eraser' ? (
          <>
            {ERASER_MODES.map((o) => (
              <StyleOption key={o.id} icon={o.icon} label={o.label} selected={tools.eraserMode === o.id} onPress={() => onChange({ eraserMode: o.id })} />
            ))}
            <Sep />
            {ERASER_SIZES.map((r, i) => (
              <SizeDot key={r} size={6 + i * 5} label={['Small eraser', 'Medium eraser', 'Large eraser'][i]!} selected={tools.eraserRadius === r} onPress={() => onChange({ eraserRadius: r })} />
            ))}
          </>
        ) : null}
        {t === 'lasso' ? (
          <>
            <StyleOption icon="lasso" label="Freeform lasso" selected={tools.lassoMode !== 'rect'} onPress={() => onChange({ lassoMode: 'free' })} />
            <StyleOption icon="rect-select" label="Rectangle select" selected={tools.lassoMode === 'rect'} onPress={() => onChange({ lassoMode: 'rect' })} />
            <Text variant="meta" tone="muted" numberOfLines={1} style={{ paddingHorizontal: space.sm }}>
              {tools.lassoMode === 'rect' ? 'Tap or drag a box to select' : 'Tap or circle to select'}
            </Text>
          </>
        ) : null}
        {t === 'laser' ? (
          <>
            {LASER_MODES.map((o) => (
              <StyleOption key={o.id} icon={o.icon} label={o.label} selected={tools.laserMode === o.id} onPress={() => onChange({ laserMode: o.id })} />
            ))}
            <Sep />
            <IconButton icon="monitor" label="Present" size={CONTROL_H_SM} onPress={onPresent} {...tip(`Present${Platform.OS === 'web' ? ' (F5)' : ''}`)} />
          </>
        ) : null}
        <Sep />
        <IconButton icon="zoom-out" label="Zoom out" size={CONTROL_H_SM} onPress={() => onZoom(-1)} {...tip('Zoom out')} />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Reset zoom"
          onPress={onZoomReset}
          {...tip('Reset zoom')}
          style={(s) => [styles.zoomLabel, hoverTransition, (s as { hovered?: boolean }).hovered || s.pressed ? { backgroundColor: c.surface2 } : null]}
        >
          <Text variant="smallStrong" style={{ fontVariant: ['tabular-nums'], color: c.ink2 }}>
            {Math.round(zoom * 100)}%
          </Text>
        </Pressable>
        <IconButton icon="zoom-in" label="Zoom in" size={CONTROL_H_SM} onPress={() => onZoom(1)} {...tip('Zoom in')} />
      </ScrollView>
      {more.left ? <EdgeChevron side="left" onPress={() => page(-1)} /> : null}
      {more.right ? <EdgeChevron side="right" onPress={() => page(1)} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { borderRadius: radius.panel, borderWidth: StyleSheet.hairlineWidth, maxWidth: '100%', alignSelf: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 2, padding: 4 },
  tool: { width: CONTROL_H, height: CONTROL_H, borderRadius: radius.control, borderWidth: StyleSheet.hairlineWidth, alignItems: 'center', justifyContent: 'center' },
  sizeHit: { width: CONTROL_H_SM, height: CONTROL_H_SM, alignItems: 'center', justifyContent: 'center', borderRadius: radius.control, borderWidth: StyleSheet.hairlineWidth },
  edge: { position: 'absolute', top: 0, bottom: 0, width: 32, alignItems: 'center', justifyContent: 'center' },
  zoomLabel: { minWidth: 48, height: CONTROL_H_SM, paddingHorizontal: space.xxs, borderRadius: radius.control, alignItems: 'center', justifyContent: 'center' },
});
