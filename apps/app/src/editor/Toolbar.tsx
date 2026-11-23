import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { HIGHLIGHTER_WIDTH, PEN_WIDTHS, type PaperColor, type PenStyle } from '@qalm/core';
import * as React from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { useTheme } from '../theme/ThemeProvider';
import { radius, shadow2 } from '../theme/tokens';
import { IconButton } from '../ui/controls';
import { Text } from '../ui/Text';
import type { ToolState } from './context';
import { SwatchStrip } from './Swatches';
import type { ToolId } from './view';

type MciName = React.ComponentProps<typeof MaterialCommunityIcons>['name'];

const TOOLS: { id: ToolId; icon: MciName; label: string }[] = [
  { id: 'pen', icon: 'fountain-pen-tip', label: 'Pen' },
  { id: 'highlighter', icon: 'marker', label: 'Highlighter' },
  { id: 'eraser', icon: 'eraser', label: 'Eraser' },
  { id: 'lasso', icon: 'lasso', label: 'Lasso select' },
  { id: 'text', icon: 'format-text', label: 'Text box' },
];

export const ERASER_SIZES = [4, 10, 22] as const;

const PEN_STYLE_OPTIONS: { id: PenStyle; icon: MciName; label: string }[] = [
  { id: 'fountain', icon: 'fountain-pen-tip', label: 'Fountain pen' },
  { id: 'ball', icon: 'pen', label: 'Ballpoint pen' },
  { id: 'brush', icon: 'brush', label: 'Brush pen' },
];

function ToolButton({ icon, label, selected, onPress }: { icon: MciName; label: string; selected?: boolean; onPress(): void }) {
  const { c } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected }}
      onPress={onPress}
      style={(s) => [
        styles.tool,
        { backgroundColor: selected ? c.accent : (s as { hovered?: boolean }).hovered || s.pressed ? c.soft : 'transparent' },
      ]}
    >
      <MaterialCommunityIcons name={icon} size={21} color={selected ? c.onAccent : c.ink2} />
    </Pressable>
  );
}

function Sep() {
  const { c } = useTheme();
  return <View style={{ width: StyleSheet.hairlineWidth, alignSelf: 'stretch', marginVertical: 8, backgroundColor: c.line }} />;
}

function SizeDot({ size, selected, label, onPress }: { size: number; selected: boolean; label: string; onPress(): void }) {
  const { c } = useTheme();
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityLabel={label}
      accessibilityState={{ checked: selected }}
      onPress={onPress}
      style={[styles.sizeHit, { backgroundColor: selected ? c.accentSoft : 'transparent', borderColor: selected ? c.accentLine : 'transparent' }]}
    >
      <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: selected ? c.accentInk : c.ink2 }} />
    </Pressable>
  );
}

function StyleOption({ icon, label, selected, onPress }: { icon: MciName; label: string; selected: boolean; onPress(): void }) {
  const { c } = useTheme();
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityLabel={label}
      accessibilityState={{ checked: selected }}
      onPress={onPress}
      style={[styles.sizeHit, { backgroundColor: selected ? c.accentSoft : 'transparent', borderColor: selected ? c.accentLine : 'transparent' }]}
    >
      <MaterialCommunityIcons name={icon} size={19} color={selected ? c.accentInk : c.ink2} />
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
}

/** The floating toolbar: a solid surface with shadow-2 (brand.md). Scrolls sideways on narrow screens. */
export function Toolbar({ tools, onTool, onChange, onImage, zoom, onZoom, onZoomReset, paper }: ToolbarProps) {
  const { c } = useTheme();
  const t = tools.tool;
  const [dragging, setDragging] = React.useState(false);
  return (
    <View style={[styles.bar, shadow2, { backgroundColor: c.surface, borderColor: c.line }]}>
      <ScrollView horizontal scrollEnabled={!dragging} showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row}>
        {TOOLS.map((x) => (
          <ToolButton key={x.id} icon={x.icon} label={x.label} selected={t === x.id} onPress={() => onTool(x.id)} />
        ))}
        <ToolButton icon="image-outline" label="Insert image" onPress={onImage} />
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
                <ToolButton icon="shape-outline" label={tools.snapShapes ? 'Shape snapping on' : 'Shape snapping off'} selected={tools.snapShapes} onPress={() => onChange({ snapShapes: !tools.snapShapes })} />
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
            {ERASER_SIZES.map((r, i) => (
              <SizeDot key={r} size={6 + i * 5} label={['Small eraser', 'Medium eraser', 'Large eraser'][i]!} selected={tools.eraserRadius === r} onPress={() => onChange({ eraserRadius: r })} />
            ))}
          </>
        ) : null}
        {t === 'lasso' ? (
          <>
            <StyleOption icon="lasso" label="Freeform lasso" selected={tools.lassoMode !== 'rect'} onPress={() => onChange({ lassoMode: 'free' })} />
            <StyleOption icon="selection-drag" label="Rectangle select" selected={tools.lassoMode === 'rect'} onPress={() => onChange({ lassoMode: 'rect' })} />
            <Text variant="meta" style={{ paddingHorizontal: 8 }}>
              {tools.lassoMode === 'rect' ? 'Tap or drag a box to select' : 'Tap or circle to select'}
            </Text>
          </>
        ) : null}
        <Sep />
        <IconButton icon="zoom-out" label="Zoom out" size={40} onPress={() => onZoom(-1)} />
        <Pressable accessibilityRole="button" accessibilityLabel="Reset zoom" onPress={onZoomReset} style={styles.zoomLabel}>
          <Text variant="label" style={{ fontVariant: ['tabular-nums'], color: c.ink2 }}>
            {Math.round(zoom * 100)}%
          </Text>
        </Pressable>
        <IconButton icon="zoom-in" label="Zoom in" size={40} onPress={() => onZoom(1)} />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { borderRadius: radius.panel, borderWidth: StyleSheet.hairlineWidth, maxWidth: '100%', alignSelf: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 2, padding: 4 },
  tool: { width: 44, height: 44, borderRadius: radius.control, alignItems: 'center', justifyContent: 'center' },
  sizeHit: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center', borderRadius: radius.control, borderWidth: StyleSheet.hairlineWidth },
  zoomLabel: { minWidth: 52, height: 44, alignItems: 'center', justifyContent: 'center' },
});
