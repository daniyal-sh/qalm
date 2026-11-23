import { HIGHLIGHTER_ALPHA, MAX_SWATCHES, normalizeColor, splitAlpha, withAlpha, type SwatchTool } from '@qalm/core';
import * as React from 'react';
import { Modal, Pressable, StyleSheet, useWindowDimensions, View, type GestureResponderEvent, type ViewStyle } from 'react-native';

import { useTheme } from '../theme/ThemeProvider';
import { coverInk, font, radius, shadow2 } from '../theme/tokens';
import { Button, IconButton, TextField } from '../ui/controls';
import { Icon } from '../ui/Icon';
import { Text } from '../ui/Text';
import { hexToHsl, hslToHex, OPACITY_MAX, OPACITY_MIN, sameColor, toneGrid } from './colors.logic';

const TILE = 36;
const GAP = 4;
const WIDTH = 7 * TILE + 6 * GAP + 2 * 16; // the grid plus padding
const HUES = Array.from({ length: 36 }, (_, i) => hslToHex({ h: i * 10, s: 0.9, l: 0.5 }));

/**
 * A slider drawn as solid segments (brand.md: no gradients) with a ring thumb. Drag or tap anywhere on it; works the
 * same with a finger, a stylus and a mouse. Arrow keys on web via accessibilityActions.
 */
function SegmentSlider({ segments, value, onChange, label, valueText }: { segments: string[]; value: number; onChange(v: number): void; label: string; valueText: string }) {
  const { c } = useTheme();
  const [w, setW] = React.useState(0);
  const set = (e: GestureResponderEvent) => {
    if (w) onChange(Math.min(1, Math.max(0, e.nativeEvent.locationX / w)));
  };
  return (
    <View
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel={label}
      accessibilityValue={{ text: valueText }}
      accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
      onAccessibilityAction={(e) => onChange(Math.min(1, Math.max(0, value + (e.nativeEvent.actionName === 'increment' ? 0.05 : -0.05))))}
      style={styles.sliderHit}
      onLayout={(e) => setW(e.nativeEvent.layout.width)}
    >
      <View style={[styles.track, { borderColor: c.line }]}>
        {segments.map((s, i) => (
          <View key={i} style={{ flex: 1, backgroundColor: s }} />
        ))}
      </View>
      <View pointerEvents="none" style={[styles.thumb, { left: value * w - 11, borderColor: c.surface, outlineColor: c.ink } as ViewStyle]} />
      <View
        style={StyleSheet.absoluteFill}
        onStartShouldSetResponder={() => true}
        onMoveShouldSetResponder={() => true}
        onResponderTerminationRequest={() => false}
        onResponderGrant={set}
        onResponderMove={set}
      />
    </View>
  );
}

export interface ColorPickerProps {
  visible: boolean;
  tool: SwatchTool;
  /** The colour to start from (the tool's current colour). */
  initial: string;
  /** Saved colours; "Add" is disabled when full. */
  saved: string[];
  /** Window point to open next to (a "+" button); centred / docked when missing or on narrow screens. */
  anchor?: { x: number; y: number };
  onClose(): void;
  /** Use the colour (and save it as a swatch when `save`). */
  onPick(color: string, save: boolean): void;
}

/**
 * The colour picker popover: a hue slider over a grid of solid tones for that hue, a hex field and, for the
 * highlighter, an opacity slider. "Add" saves the colour as a swatch and uses it; picking a saved colour just uses it.
 */
export function ColorPicker({ visible, tool, initial, saved, anchor, onClose, onPick }: ColorPickerProps) {
  const { c } = useTheme();
  const win = useWindowDimensions();
  const hl = tool === 'highlighter';
  const start = splitAlpha(initial, hl ? HIGHLIGHTER_ALPHA : 1);
  const [rgb, setRgb] = React.useState(start.rgb);
  const [alpha, setAlpha] = React.useState(start.alpha);
  const [hue, setHue] = React.useState(() => hexToHsl(start.rgb).h);
  const [hexText, setHexText] = React.useState(start.rgb);
  React.useEffect(() => {
    if (!visible) return;
    const s = splitAlpha(initial, hl ? HIGHLIGHTER_ALPHA : 1);
    setRgb(s.rgb);
    setAlpha(s.alpha);
    setHexText(s.rgb);
    const hsl = hexToHsl(s.rgb);
    if (hsl.s > 0.05) setHue(hsl.h);
  }, [visible, initial, hl]);

  const choose = (hex: string) => {
    setRgb(hex);
    setHexText(hex);
  };
  // Highlighters at the default opacity stay plain #rrggbb (the same as every highlight made before this).
  const result = hl && Math.abs(alpha - HIGHLIGHTER_ALPHA) > 0.005 ? withAlpha(rgb, alpha) : rgb;
  const isSaved = saved.some((s) => sameColor(s, result));
  const full = !isSaved && saved.length >= MAX_SWATCHES;
  const grid = React.useMemo(() => toneGrid(hue), [hue]);

  const narrow = win.width < 520;
  const height = hl ? 470 : 410;
  const pos: ViewStyle =
    anchor && !narrow
      ? {
          position: 'absolute',
          top: Math.max(8, Math.min(anchor.y, win.height - height - 8)),
          left: Math.max(8, Math.min(anchor.x - WIDTH / 2, win.width - WIDTH - 8)),
        }
      : narrow
        ? { position: 'absolute', bottom: 0, left: 0, right: 0, borderBottomLeftRadius: 0, borderBottomRightRadius: 0, alignItems: 'center' }
        : { alignSelf: 'center', marginTop: win.height * 0.15 };

  const commitHex = () => {
    const n = normalizeColor(hexText.startsWith('#') ? hexText : `#${hexText}`);
    if (!n) return setHexText(rgb);
    const s = splitAlpha(n, alpha);
    choose(s.rgb);
    if (hl && n.length === 9) setAlpha(Math.min(OPACITY_MAX, Math.max(OPACITY_MIN, s.alpha)));
    const hsl = hexToHsl(s.rgb);
    if (hsl.s > 0.05) setHue(hsl.h);
  };

  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={onClose} supportedOrientations={['portrait', 'landscape']}>
      <Pressable accessibilityLabel="Close colour picker" style={[StyleSheet.absoluteFill, narrow && { backgroundColor: 'rgba(0,0,0,0.32)' }]} onPress={onClose} />
      <View accessibilityViewIsModal style={[styles.pop, shadow2, { backgroundColor: c.surface, borderColor: c.line }, narrow ? null : { width: WIDTH }, pos]}>
        <View style={{ width: WIDTH - 32, gap: 12 }}>
          <View style={styles.head}>
            <Text variant="label" style={{ flex: 1 }}>
              {hl ? 'Highlighter colour' : 'Pen colour'}
            </Text>
            <IconButton icon="x" label="Close" size={36} onPress={onClose} />
          </View>

          <SegmentSlider segments={HUES} value={hue / 360} onChange={(v) => setHue(Math.min(359, v * 360))} label="Hue" valueText={`${Math.round(hue)}°`} />

          <View accessibilityRole="radiogroup" accessibilityLabel="Tones" style={{ gap: GAP }}>
            {grid.map((row, ri) => (
              <View key={ri} style={{ flexDirection: 'row', gap: GAP }}>
                {row.map((hex) => {
                  const on = hex === rgb;
                  return (
                    <Pressable
                      key={hex}
                      accessibilityRole="radio"
                      accessibilityLabel={hex}
                      accessibilityState={{ checked: on }}
                      aria-checked={on}
                      onPress={() => choose(hex)}
                      style={[styles.tile, { backgroundColor: hex, borderColor: c.line }, on && { borderWidth: 2, borderColor: c.surface, outlineColor: c.ink, outlineWidth: 2, outlineStyle: 'solid' } as ViewStyle]}
                    >
                      {on ? <Icon name="check" size={16} color={coverInk(hex)} /> : null}
                    </Pressable>
                  );
                })}
              </View>
            ))}
          </View>

          {hl ? (
            <View style={{ gap: 4 }}>
              <Text variant="meta">Opacity {Math.round(alpha * 100)}%</Text>
              <SegmentSlider
                segments={Array.from({ length: 12 }, (_, i) => withAlpha(rgb, OPACITY_MIN + ((OPACITY_MAX - OPACITY_MIN) * (i + 0.5)) / 12))}
                value={(alpha - OPACITY_MIN) / (OPACITY_MAX - OPACITY_MIN)}
                onChange={(v) => setAlpha(Math.round((OPACITY_MIN + v * (OPACITY_MAX - OPACITY_MIN)) * 100) / 100)}
                label="Opacity"
                valueText={`${Math.round(alpha * 100)}%`}
              />
            </View>
          ) : null}

          <View style={styles.foot}>
            <View accessibilityLabel={`Preview ${result}`} style={[styles.preview, { borderColor: c.line, backgroundColor: '#ffffff' }]}>
              <View style={[StyleSheet.absoluteFill, { backgroundColor: rgb, opacity: hl ? alpha : 1 }]} />
            </View>
            <TextField
              accessibilityLabel="Hex colour"
              value={hexText}
              onChangeText={setHexText}
              onSubmitEditing={commitHex}
              onBlur={commitHex}
              autoCapitalize="none"
              autoCorrect={false}
              maxLength={9}
              containerStyle={{ flex: 1, height: 44 }}
              style={{ fontFamily: font.mono }}
            />
          </View>
          <View style={styles.foot}>
            <Button label="Use once" grow onPress={() => onPick(result, false)} />
            <Button
              label={isSaved ? 'Use' : full ? `Full (${MAX_SWATCHES})` : 'Add colour'}
              icon={isSaved ? 'check' : 'plus'}
              variant="primary"
              grow
              disabled={full}
              onPress={() => onPick(result, !isSaved)}
            />
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  pop: { borderRadius: radius.panel, borderWidth: StyleSheet.hairlineWidth, padding: 16, paddingTop: 8 },
  head: { flexDirection: 'row', alignItems: 'center', marginRight: -8 },
  sliderHit: { height: 44, justifyContent: 'center' },
  track: { height: 24, borderRadius: radius.control, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden', flexDirection: 'row', backgroundColor: '#ffffff' },
  thumb: { position: 'absolute', top: 11, width: 22, height: 22, borderRadius: 11, borderWidth: 3, outlineWidth: 1.5, outlineStyle: 'solid' } as ViewStyle,
  tile: { width: TILE, height: TILE, borderRadius: radius.control, borderWidth: StyleSheet.hairlineWidth, alignItems: 'center', justifyContent: 'center' },
  foot: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  preview: { width: 44, height: 44, borderRadius: radius.control, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
});
