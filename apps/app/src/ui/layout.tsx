import * as React from 'react';
import {
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

import { useTheme } from '../theme/ThemeProvider';
import { radius, shadow1, shadow2 } from '../theme/tokens';
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
    <View style={[{ paddingHorizontal: 4, paddingTop: 16, paddingBottom: 6 }, style]}>
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
    <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => pressed && { backgroundColor: c.soft }}>
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
      <View style={[styles.emptyIcon, { backgroundColor: c.surface2, borderColor: c.line }]}>
        <Icon name={icon} size={22} color={c.muted} />
      </View>
      <Text variant="section" style={{ textAlign: 'center' }}>
        {title}
      </Text>
      {body ? (
        <Text variant="body" tone="muted" style={{ textAlign: 'center', maxWidth: 380 }}>
          {body}
        </Text>
      ) : null}
      {action ? <View style={{ marginTop: 8 }}>{action}</View> : null}
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
  const narrow = win.width < 640;
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose} supportedOrientations={['portrait', 'landscape']}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <View style={[styles.scrimWrap, narrow && { justifyContent: 'flex-end', padding: 0 }]}>
          <Pressable accessibilityLabel="Close" style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.32)' }]} onPress={onClose} />
          <View
            style={[
              styles.sheet,
              shadow2,
              { backgroundColor: c.surface, borderColor: c.line, maxHeight: win.height * (narrow ? 0.92 : 0.88) },
              narrow ? { width: '100%', borderBottomLeftRadius: 0, borderBottomRightRadius: 0 } : { width: Math.min(width, win.width - 48) },
            ]}
          >
            {title ? (
              <View style={[styles.sheetHeader, { borderBottomColor: c.line2 }]}>
                <Text variant="section" style={{ flex: 1 }}>
                  {title}
                </Text>
                <IconButton icon="x" label="Close" size={36} onPress={onClose} />
              </View>
            ) : null}
            <ScrollView contentContainerStyle={{ padding: 20, gap: 16 }} keyboardShouldPersistTaps="handled">
              {children}
            </ScrollView>
            {footer ? <View style={[styles.sheetFooter, { borderTopColor: c.line2 }]}>{footer}</View> : null}
          </View>
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
        top: Math.min(anchor.y, win.height - 60 * items.length - 24),
        ...(anchor.align === 'right'
          ? { right: Math.min(Math.max(8, win.width - anchor.x), Math.max(8, win.width - width - 8)) } // never past the left edge
          : { left: Math.min(Math.max(8, anchor.x), win.width - width - 8) }),
      }
    : { alignSelf: 'center', marginTop: win.height * 0.25 };
  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={onClose} supportedOrientations={['portrait', 'landscape']}>
      <Pressable accessibilityLabel="Close menu" style={StyleSheet.absoluteFill} onPress={onClose} />
      <View style={[styles.menu, shadow2, pos, { width, backgroundColor: c.surface, borderColor: c.line }]}>
        {items.map((it, i) => {
          const color = it.tone === 'bad' ? c.bad : it.tone === 'assistant' ? c.assistant : it.tone === 'context' ? c.context : c.ink2;
          return (
            <Pressable
              key={`${it.label}-${i}`}
              accessibilityRole="menuitem"
              onPress={() => {
                onClose();
                it.onPress();
              }}
              style={(s) => [styles.menuItem, ((s as { hovered?: boolean }).hovered || s.pressed) && { backgroundColor: c.soft }]}
            >
              {it.icon ? <Icon name={it.icon} size={17} color={color} /> : null}
              <View style={{ flex: 1 }}>
                <Text variant="label" style={it.tone === 'bad' ? { color: c.bad } : undefined}>
                  {it.label}
                </Text>
                {it.description ? <Text variant="meta">{it.description}</Text> : null}
              </View>
            </Pressable>
          );
        })}
      </View>
    </Modal>
  );
}

/** Small transient message at the bottom (solid surface). */
export function useToast(): [React.ReactNode, (msg: string) => void] {
  const { c } = useTheme();
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
  const node = msg ? (
    <View pointerEvents="none" style={styles.toastWrap}>
      <View style={[styles.toast, shadow2, { backgroundColor: c.surface, borderColor: c.line }]}>
        <Text variant="label">{msg}</Text>
      </View>
    </View>
  ) : null;
  return [node, show];
}

const styles = StyleSheet.create({
  panel: { borderRadius: radius.panel, borderWidth: StyleSheet.hairlineWidth },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 14, paddingHorizontal: 16, minHeight: 56 },
  empty: { alignItems: 'center', justifyContent: 'center', gap: 8, padding: 32, flex: 1 },
  emptyIcon: {
    width: 52,
    height: 52,
    borderRadius: radius.panel,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    marginBottom: 4,
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
  menuItem: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 44, paddingHorizontal: 10, paddingVertical: 8, borderRadius: radius.control },
  toastWrap: { position: 'absolute', left: 0, right: 0, bottom: 28, alignItems: 'center' },
  toast: { paddingHorizontal: 16, paddingVertical: 10, borderRadius: radius.control, borderWidth: StyleSheet.hairlineWidth },
});
