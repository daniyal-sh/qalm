import * as React from 'react';
import { Pressable, ScrollView, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { toolbarOverflow } from '../editor/toolbar.logic';
import { hoverTransition } from '../theme/motion';
import { useTheme } from '../theme/ThemeProvider';
import { space } from '../theme/tokens';
import { Icon } from './Icon';

/**
 * A row that scrolls sideways when it doesn't fit. A clipped edge shows a solid chevron button (no fade: brand.md has
 * no gradients) that scrolls the rest into view, so it's clear there's more.
 */
export function ScrollRow({ children, gap = space.sm, style, backdrop }: { children: React.ReactNode; gap?: number; style?: StyleProp<ViewStyle>; /** The colour behind the row (the chevron's solid edge). */ backdrop?: string }) {
  const { c } = useTheme();
  const ref = React.useRef<React.ComponentRef<typeof ScrollView>>(null);
  const [m, setM] = React.useState({ x: 0, view: 0, content: 0 });
  const more = toolbarOverflow(m.x, m.view, m.content);
  const page = (dir: 1 | -1) => ref.current?.scrollTo({ x: Math.max(0, m.x + dir * Math.max(120, m.view * 0.6)), animated: true });
  const edge = (side: 'left' | 'right') => (
    <View pointerEvents="box-none" style={[styles.edge, { backgroundColor: backdrop ?? c.bg }, side === 'left' ? { left: 0, paddingRight: space.xs } : { right: 0, paddingLeft: space.xs }]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={side === 'left' ? 'Scroll back' : 'Show more'}
        onPress={() => page(side === 'left' ? -1 : 1)}
        hitSlop={6}
        style={(s) => [
          styles.chev,
          hoverTransition,
          { backgroundColor: s.pressed || (s as { hovered?: boolean }).hovered ? c.soft : c.surface, borderColor: c.line },
        ]}
      >
        <Icon name={side === 'left' ? 'chevron-left' : 'chevron-right'} size={16} color={c.ink2} />
      </Pressable>
    </View>
  );
  return (
    <View style={style}>
      <ScrollView
        ref={ref}
        horizontal
        showsHorizontalScrollIndicator={false}
        scrollEventThrottle={32}
        contentContainerStyle={{ gap }}
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
        {children}
      </ScrollView>
      {more.left ? edge('left') : null}
      {more.right ? edge('right') : null}
    </View>
  );
}

const styles = StyleSheet.create({
  edge: { position: 'absolute', top: 0, bottom: 0, justifyContent: 'center' },
  chev: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center', borderWidth: StyleSheet.hairlineWidth },
});
