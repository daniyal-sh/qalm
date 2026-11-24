// Presentation view's only control (tech-spec §5): previous / next page, where you are, the laser's trail or dot, and
// exit. A small solid pill at the bottom centre; everything else in the editor is hidden while presenting.
import * as React from 'react';
import { Platform, StyleSheet, View } from 'react-native';

import { Appear } from '../theme/motion';
import { useTheme } from '../theme/ThemeProvider';
import { radius, shadow2 } from '../theme/tokens';
import { IconButton } from '../ui/controls';
import { Text } from '../ui/Text';
import { LASER_MODES, ToolButton } from './Toolbar';

export interface PresentBarProps {
  index: number;
  count: number;
  onPage(dir: 1 | -1): void;
  laserMode: 'trail' | 'dot';
  onLaserMode(m: 'trail' | 'dot'): void;
  onExit(): void;
  bottom: number;
}

export function PresentBar({ index, count, onPage, laserMode, onLaserMode, onExit, bottom }: PresentBarProps) {
  const { c } = useTheme();
  const web = Platform.OS === 'web';
  return (
    <View pointerEvents="box-none" style={[styles.wrap, { bottom }]}>
      <Appear from="bottom" style={[styles.bar, shadow2, { backgroundColor: c.surface, borderColor: c.line }]}>
        <IconButton icon="chevron-left" label={`Previous page${web ? ' (←)' : ''}`} disabled={index <= 0} onPress={() => onPage(-1)} />
        <Text variant="smallStrong" accessibilityLiveRegion="polite" style={[styles.count, { color: c.ink2 }]}>
          {index + 1} / {count}
        </Text>
        <IconButton icon="chevron-right" label={`Next page${web ? ' (→)' : ''}`} disabled={index >= count - 1} onPress={() => onPage(1)} />
        <View style={[styles.sep, { backgroundColor: c.line }]} />
        {LASER_MODES.map((m) => (
          <ToolButton key={m.id} toggle icon={m.icon} label={m.label} selected={laserMode === m.id} onPress={() => onLaserMode(m.id)} />
        ))}
        <View style={[styles.sep, { backgroundColor: c.line }]} />
        <IconButton icon="x" label={`Stop presenting${web ? ' (Esc)' : ''}`} onPress={onExit} />
      </Appear>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
  bar: { flexDirection: 'row', alignItems: 'center', gap: 2, padding: 4, borderRadius: radius.panel, borderWidth: StyleSheet.hairlineWidth },
  count: { minWidth: 56, textAlign: 'center', fontVariant: ['tabular-nums'] },
  sep: { width: StyleSheet.hairlineWidth, alignSelf: 'stretch', marginVertical: 10, marginHorizontal: 2 },
});
