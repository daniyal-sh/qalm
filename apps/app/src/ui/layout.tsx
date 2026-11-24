import * as React from 'react';
import {
  Animated,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  useWindowDimensions,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { hoverTransition, riseStyle, usePresence } from '../theme/motion';
import { useTheme } from '../theme/ThemeProvider';
import { motion, radius, shadow1, shadow2, space } from '../theme/tokens';
import { IconButton } from './controls';
import { Icon, type IconName } from './Icon';
import { Text } from './Text';

/** A solid surface panel with a hairline border and shadow-1. */
export function Panel({ children, style, inset }: { children: React.ReactNode; style?: StyleProp<ViewStyle>; inset?: boolean }) {
  const { c } = useTheme();
  return (
    <View
      style={[
        styles.panel,
        { backgroundColor: inset ? c.surface2 : c.surface, borderColor: c.line },
        !inset && shadow1,
        style,
      ]}
    >
      {children}
    </View>
  );
}

/** Sentence-case muted 12px section label (brand: no uppercase labels). */
export function SectionLabel({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[{ paddingHorizontal: space.xxs, paddingTop: space.lg, paddingBottom: space.xs }, style]}>
      <Text variant="meta" tone="muted">
        {children}
      </Text>
    </View>
  );
}

export function Divider({ style }: { style?: StyleProp<ViewStyle> }) {
  const { c } = useTheme();
  return <View style={[{ height: StyleSheet.hairlineWidth, backgroundColor: c.line2 }, style]} />;
}

/** Settings-style row: title, optional description, and a control on the right (stacks on narrow widths). */
export function Row({
  title,
  description,
  children,
  last,
  icon,
  onPress,
}: {
  title: string;
  description?: string;
  children?: React.ReactNode;
  last?: boolean;
  icon?: IconName;
  onPress?(): void;
}) {
  const { c } = useTheme();
  const { width } = useWindowDimensions();
  const stack = width < 560;
  const body = (
    <View
      style={[
        styles.row,
        stack && children ? { flexDirection: 'column', alignItems: 'stretch' } : null,
        !last && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.line2 },
      ]}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, flex: stack ? undefined : 1 }}>
        {icon ? <Icon name={icon} size={18} color={c.muted} /> : null}
        <View style={{ flex: 1, gap: 2 }}>
          <Text variant="bodyStrong">{title}</Text>
          {description ? <Text variant="meta">{description}</Text> : null}
        </View>
      </View>
      {children ? <View style={stack ? { marginTop: 10 } : { marginLeft: 16 }}>{children}</View> : null}
    </View>
  );
  if (!onPress) return body;
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={(s) => [hoverTransition, s.pressed ? { backgroundColor: c.soft } : (s as { hovered?: boolean }).hovered ? { backgroundColor: c.surface2 } : null]}
    >
      {body}
    </Pressable>
  );
}

export function EmptyState({
  icon,
  title,
  body,
  action,
}: {
  icon: IconName;
  title: string;
  body?: string;
  action?: React.ReactNode;
}) {
  const { c } = useTheme();
  return (
    <View style={styles.empty}>
      <View style={[styles.emptyIcon, { backgroundColor: c.surface, borderColor: c.line }, shadow1]}>
        <Icon name={icon} size={22} color={c.muted} />
      </View>
      <Text variant="section" style={{ textAlign: 'center' }}>
        {title}
      </Text>
      {body ? (
        <Text variant="body" tone="muted" style={{ textAlign: 'center', maxWidth: 360 }}>
          {body}
        </Text>
      ) : null}
      {action ? <View style={{ marginTop: space.md }}>{action}</View> : null}
    </View>
  );
}

/**
 * Modal sheet: a solid surface with shadow-2. Centred on wide screens, docked to the bottom on narrow ones.
 * The scrim is a plain dim (no blur).
 */
export function Sheet({
  visible,
  onClose,
  title,
  children,
  footer,
  width = 560,
}: {
  visible: boolean;
  onClose(): void;
  title?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  width?: number;
}) {
  const { c } = useTheme();
  const win = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const narrow = win.width < 640;
  // Arrives with a short rise (a bottom sheet slides up a little further) and leaves faster than it came.
  const { mounted, progress } = usePresence(visible, motion.slow, motion.fast);
  return (
    <Modal visible={mounted} transparent animationType="none" onRequestClose={onClose} supportedOrientations={['portrait', 'landscape']}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <View style={[styles.scrimWrap, narrow && { justifyContent: 'flex-end', padding: 0 }]}>
          <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: c.scrim, opacity: progress }]}>
            <Pressable accessibilityLabel="Close" style={StyleSheet.absoluteFill} onPress={onClose} />
          </Animated.View>
          <Animated.View
            accessibilityViewIsModal
            style={[
              riseStyle(progress, { distance: narrow ? 24 : motion.rise, scale: !narrow }),
              styles.sheet,
              shadow2,
              { backgroundColor: c.surface, borderColor: c.line, maxHeight: win.height * (narrow ? 0.92 : 0.88) },
              // Docked: clear the Android gesture / nav bar (the modal is drawn edge to edge).
              narrow ? { width: '100%', borderBottomLeftRadius: 0, borderBottomRightRadius: 0, paddingBottom: insets.bottom } : { width: Math.min(width, win.width - 48) },
            ]}
          >
            {title ? (
              <View style={[styles.sheetHeader, { borderBottomColor: c.line2 }]}>
                <Text variant="section" accessibilityRole="header" numberOfLines={2} style={{ flex: 1 }}>
                  {title}
                </Text>
                <IconButton icon="x" label="Close" size={36} onPress={onClose} />
              </View>
            ) : null}
            <ScrollView contentContainerStyle={{ padding: space.xl, gap: space.lg }} keyboardShouldPersistTaps="handled">
              {children}
            </ScrollView>
            {footer ? <View style={[styles.sheetFooter, { borderTopColor: c.line2 }]}>{footer}</View> : null}
          </Animated.View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

export interface MenuItem {
  label: string;
  icon?: IconName;
  description?: string;
  tone?: 'default' | 'bad' | 'assistant' | 'context';
  onPress(): void;
}

const MENU_ITEM_H = 44;

/** Popover menu anchored near a point (or centred on narrow screens). */
export function Menu({
  visible,
  onClose,
  items,
  anchor,
  width = 280,
}: {
  visible: boolean;
  onClose(): void;
  items: MenuItem[];
  anchor?: { x: number; y: number; align?: 'left' | 'right' };
  width?: number;
}) {
  const { c } = useTheme();
  const win = useWindowDimensions();
  const pos: ViewStyle = anchor
    ? {
        position: 'absolute',
        top: Math.max(8, Math.min(anchor.y, win.height - menuHeight(items) - 16)),
        ...(anchor.align === 'right'
          ? { right: Math.min(Math.max(8, win.width - anchor.x), Math.max(8, win.width - width - 8)) } // never past the left edge
          : { left: Math.min(Math.max(8, anchor.x), win.width - width - 8) }),
      }
    : { alignSelf: 'center', marginTop: win.height * 0.25 };
  // Keep the last items while the menu animates out.
  const { mounted, progress } = usePresence(visible, motion.fast, motion.fast);
  const last = React.useRef(items);
  if (visible) last.current = items;
  const shown = visible ? items : last.current;
  return (
    <Modal visible={mounted} transparent animationType="none" onRequestClose={onClose} supportedOrientations={['portrait', 'landscape']}>
      <Pressable accessibilityLabel="Close menu" style={StyleSheet.absoluteFill} onPress={onClose} />
      <Animated.View
        accessibilityRole="menu"
        style={[riseStyle(progress, { from: 'top', distance: 4, scale: true }), styles.menu, shadow2, pos, { width, backgroundColor: c.surface, borderColor: c.line }]}
      >
        {shown.map((it, i) => {
          const color = it.tone === 'bad' ? c.bad : it.tone === 'assistant' ? c.assistant : it.tone === 'context' ? c.context : c.ink2;
          // Destructive actions sit apart from the rest, under a hairline.
          const split = it.tone === 'bad' && i > 0 && shown[i - 1]!.tone !== 'bad';
          return (
            <React.Fragment key={`${it.label}-${i}`}>
              {split ? <View style={[styles.menuSplit, { backgroundColor: c.line2 }]} /> : null}
              <Pressable
                accessibilityRole="menuitem"
                onPress={() => {
                  onClose();
                  it.onPress();
                }}
                style={(s) => [
                  styles.menuItem,
                  hoverTransition,
                  s.pressed ? { backgroundColor: c.soft } : (s as { hovered?: boolean }).hovered ? { backgroundColor: it.tone === 'bad' ? c.badSoft : c.surface2 } : null,
                ]}
              >
                {it.icon ? <Icon name={it.icon} size={17} color={color} /> : null}
                <View style={{ flex: 1 }}>
                  <Text variant="label" numberOfLines={1} style={it.tone === 'bad' ? { color: c.bad } : undefined}>
                    {it.label}
                  </Text>
                  {it.description ? (
                    <Text variant="meta" tone="muted" numberOfLines={2}>
                      {it.description}
                    </Text>
                  ) : null}
                </View>
              </Pressable>
            </React.Fragment>
          );
        })}
      </Animated.View>
    </Modal>
  );
}

/** A menu's height for placement: items (taller with a description), a split before destructive items, and padding. */
function menuHeight(items: MenuItem[]): number {
  let h = 12;
  items.forEach((it, i) => {
    h += it.description ? 58 : MENU_ITEM_H;
    if (it.tone === 'bad' && i > 0 && items[i - 1]!.tone !== 'bad') h += 9;
  });
  return h;
}

/** Small transient message at the bottom (solid surface). It rises in and fades out. */
export function useToast(): [React.ReactNode, (msg: string) => void] {
  const { c } = useTheme();
  const insets = useSafeAreaInsets();
  const [msg, setMsg] = React.useState<string | null>(null);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const show = React.useCallback((m: string) => {
    setMsg(m);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setMsg(null), 2200);
  }, []);
  React.useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  const { mounted, progress } = usePresence(!!msg, motion.base, motion.base);
  const last = React.useRef('');
  if (msg) last.current = msg;
  const node = mounted ? (
    <View pointerEvents="none" style={[styles.toastWrap, { bottom: 28 + insets.bottom }]}>
      <Animated.View accessibilityRole="alert" accessibilityLiveRegion="polite" style={[riseStyle(progress), styles.toast, shadow2, { backgroundColor: c.surface, borderColor: c.line }]}>
        <Text variant="label" numberOfLines={3} style={{ textAlign: 'center' }}>
          {msg ?? last.current}
        </Text>
      </Animated.View>
    </View>
  ) : null;
  return [node, show];
}

const styles = StyleSheet.create({
  panel: { borderRadius: radius.panel, borderWidth: StyleSheet.hairlineWidth },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 14, paddingHorizontal: 16, minHeight: 56 },
  empty: { alignItems: 'center', justifyContent: 'center', gap: space.sm, padding: space.x3, flex: 1 },
  emptyIcon: {
    width: 56,
    height: 56,
    borderRadius: radius.panel,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    marginBottom: space.sm,
  },
  scrimWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  sheet: { borderRadius: radius.panel, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: 20,
    paddingRight: 8,
    height: 56,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  sheetFooter: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: 10,
    padding: 14,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  menu: { borderRadius: radius.panel, borderWidth: StyleSheet.hairlineWidth, padding: 6 },
  menuItem: { flexDirection: 'row', alignItems: 'center', gap: space.md, minHeight: MENU_ITEM_H, paddingHorizontal: 10, paddingVertical: space.sm, borderRadius: radius.inner },
  menuSplit: { height: StyleSheet.hairlineWidth, marginVertical: space.xxs, marginHorizontal: -6 },
  toastWrap: { position: 'absolute', left: space.lg, right: space.lg, bottom: 28, alignItems: 'center' },
  toast: { maxWidth: 480, paddingHorizontal: space.lg, paddingVertical: 10, borderRadius: radius.panel, borderWidth: StyleSheet.hairlineWidth },
});
