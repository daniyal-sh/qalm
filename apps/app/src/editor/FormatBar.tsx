import * as React from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { hoverTransition } from '../theme/motion';
import { useTheme } from '../theme/ThemeProvider';
import { CONTROL_H, font, radius, shadow2 } from '../theme/tokens';
import { Icon, type IconName } from '../ui/Icon';
import { Text } from '../ui/Text';
import type { FormatKind } from './format.logic';

/** The buttons, in order: a Feather icon where there is one, else a glyph. */
const BUTTONS: { kind: FormatKind; label: string; icon?: IconName; glyph?: string; glyphStyle?: object }[] = [
  { kind: 'bold', label: 'Bold', icon: 'bold' },
  { kind: 'italic', label: 'Italic', icon: 'italic' },
  { kind: 'strike', label: 'Strikethrough', glyph: 'S', glyphStyle: { textDecorationLine: 'line-through' } },
  { kind: 'heading', label: 'Heading', glyph: 'H' },
  { kind: 'bullet', label: 'Bulleted list', icon: 'list' },
  { kind: 'numbered', label: 'Numbered list', glyph: '1.' },
  { kind: 'quote', label: 'Quote', glyph: '“' },
  { kind: 'code', label: 'Code', icon: 'code' },
  { kind: 'link', label: 'Link', icon: 'link' },
  { kind: 'math', label: 'Maths', glyph: '∑' },
];

type PressState = { pressed: boolean; hovered?: boolean; focused?: boolean };

/**
 * The format bar shown while a text box is being typed in: each button inserts Markdown around the selection
 * (`applyFormat`). It never takes focus from the text box: on web and desktop a mouse-down on it is cancelled (that's
 * what would move focus), and on iPad and Android it sits outside the page's scroll view, whose taps would dismiss
 * the keyboard.
 */
export function FormatBar({ onFormat, compact }: { onFormat(kind: FormatKind): void; compact?: boolean }) {
  const { c } = useTheme();
  const size = compact ? 40 : CONTROL_H;
  const keepFocus = Platform.OS === 'web' ? ({ onMouseDown: (e: { preventDefault(): void }) => e.preventDefault() } as object) : null;
  return (
    <View
      accessibilityRole="toolbar"
      accessibilityLabel="Format text"
      {...keepFocus}
      style={[styles.bar, shadow2, { backgroundColor: c.surface, borderColor: c.line }]}
    >
      <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="always" contentContainerStyle={styles.row}>
        {BUTTONS.map((b) => (
          <Pressable
            key={b.kind}
            accessibilityRole="button"
            accessibilityLabel={b.label}
            {...((Platform.OS === 'web' ? { title: b.label, focusable: false } : {}) as object)}
            onPress={() => onFormat(b.kind)}
            style={(s) => {
              const st = s as PressState;
              return [styles.button, hoverTransition, { width: size, height: size, backgroundColor: st.pressed ? c.soft : st.hovered ? c.surface2 : 'transparent' }];
            }}
          >
            {b.icon ? (
              <Icon name={b.icon} size={Math.round(size * 0.42)} color={c.ink2} />
            ) : (
              <Text style={[styles.glyph, { color: c.ink2, fontSize: Math.round(size * 0.42) }, b.glyphStyle]}>{b.glyph}</Text>
            )}
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { borderRadius: radius.panel, borderWidth: StyleSheet.hairlineWidth, maxWidth: '100%', alignSelf: 'center', overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 2, padding: 4 },
  button: { borderRadius: radius.control, alignItems: 'center', justifyContent: 'center' },
  glyph: { fontFamily: font.bold },
});
