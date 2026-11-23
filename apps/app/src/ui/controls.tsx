import * as React from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  StyleSheet,
  TextInput,
  View,
  type PressableProps,
  type StyleProp,
  type TextInputProps,
  type ViewStyle,
} from 'react-native';

import { useTheme } from '../theme/ThemeProvider';
import { CONTROL_H, font, radius, type Colors } from '../theme/tokens';
import { Icon, type IconName } from './Icon';
import { Text } from './Text';

type PressState = { pressed: boolean; hovered?: boolean; focused?: boolean };

/** Visible focus ring: 2px accent-line plus a 1px accent offset (brand.md). */
export function focusRing(c: Colors, focused: boolean | undefined): ViewStyle | null {
  if (!focused) return null;
  return Platform.OS === 'web'
    ? ({ outlineColor: c.accentLine, outlineStyle: 'solid', outlineWidth: 2, outlineOffset: 1 } as ViewStyle)
    : { borderColor: c.accent };
}

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'assistant';

export interface ButtonProps extends Omit<PressableProps, 'style' | 'children'> {
  label: string;
  variant?: ButtonVariant;
  icon?: IconName;
  loading?: boolean;
  size?: 'md' | 'sm';
  style?: StyleProp<ViewStyle>;
  grow?: boolean;
}

/** `primary` is the one solid indigo action per screen. */
export function Button({ label, variant = 'secondary', icon, loading, size = 'md', style, disabled, grow, ...rest }: ButtonProps) {
  const { c } = useTheme();
  const fill: Record<ButtonVariant, { bg: string; bgPressed: string; border: string; fg: string }> = {
    primary: { bg: c.accent, bgPressed: c.accentInk, border: c.accent, fg: c.onAccent },
    assistant: { bg: c.assistant, bgPressed: c.assistant, border: c.assistant, fg: c.onAccent },
    secondary: { bg: c.surface, bgPressed: c.soft, border: c.line, fg: c.ink },
    ghost: { bg: 'transparent', bgPressed: c.soft, border: 'transparent', fg: c.ink },
    danger: { bg: c.surface, bgPressed: c.badSoft, border: c.line, fg: c.bad },
  };
  const f = fill[variant];
  const h = size === 'sm' ? 36 : CONTROL_H;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled || loading}
      hitSlop={size === 'sm' ? 4 : 0}
      {...rest}
      style={(s) => {
        const st = s as PressState;
        return [
          styles.button,
          { height: h, paddingHorizontal: size === 'sm' ? 12 : 16, backgroundColor: st.pressed || st.hovered ? f.bgPressed : f.bg, borderColor: f.border },
          grow && { flexGrow: 1 },
          (disabled || loading) && { opacity: 0.5 },
          focusRing(c, st.focused),
          style,
        ];
      }}
    >
      {loading ? <ActivityIndicator size="small" color={f.fg} /> : icon ? <Icon name={icon} size={16} color={f.fg} /> : null}
      <Text variant="label" style={{ color: f.fg }} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

export interface IconButtonProps extends Omit<PressableProps, 'style' | 'children'> {
  icon: IconName;
  label: string;
  selected?: boolean;
  tone?: 'default' | 'assistant' | 'bad';
  size?: number;
  color?: string;
  style?: StyleProp<ViewStyle>;
}

export function IconButton({ icon, label, selected, tone = 'default', size = CONTROL_H, color, style, ...rest }: IconButtonProps) {
  const { c } = useTheme();
  const fg = color ?? (selected ? c.onAccent : tone === 'assistant' ? c.assistant : tone === 'bad' ? c.bad : c.ink2);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected }}
      {...rest}
      style={(s) => {
        const st = s as PressState;
        return [
          styles.iconButton,
          { width: size, height: size, backgroundColor: selected ? c.accent : st.pressed || st.hovered ? c.soft : 'transparent' },
          rest.disabled && { opacity: 0.4 },
          focusRing(c, st.focused),
          style,
        ];
      }}
    >
      <Icon name={icon} size={Math.round(size * 0.42)} color={fg} />
    </Pressable>
  );
}

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
  icon?: IconName;
  swatch?: string;
}

/** Segmented control on a `soft` track; the selected segment is a raised `surface`. */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  style,
  accessibilityLabel,
}: {
  options: SegmentOption<T>[];
  value: T;
  onChange(v: T): void;
  style?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
}) {
  const { c } = useTheme();
  return (
    <View accessibilityRole="radiogroup" accessibilityLabel={accessibilityLabel} style={[styles.segTrack, { backgroundColor: c.soft }, style]}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <Pressable
            key={o.value}
            accessibilityRole="radio"
            accessibilityState={{ checked: on }}
            accessibilityLabel={o.label}
            onPress={() => onChange(o.value)}
            style={(s) => [
              styles.seg,
              on && { backgroundColor: c.surface, borderColor: c.line },
              focusRing(c, (s as PressState).focused),
            ]}
          >
            {o.swatch ? <View style={[styles.swatch, { backgroundColor: o.swatch, borderColor: c.line }]} /> : null}
            {o.icon ? <Icon name={o.icon} size={15} color={on ? c.ink : c.muted} /> : null}
            <Text variant="label" style={{ color: on ? c.ink : c.muted }} numberOfLines={1}>
              {o.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** Filter chip: neutral, or accent-soft with accent-line when selected. */
export function Chip({ label, selected, onPress, icon }: { label: string; selected?: boolean; onPress?(): void; icon?: IconName }) {
  const { c } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={(s) => [
        styles.chip,
        {
          backgroundColor: selected ? c.accentSoft : (s as PressState).hovered ? c.surface2 : c.surface,
          borderColor: selected ? c.accentLine : c.line,
        },
        focusRing(c, (s as PressState).focused),
      ]}
    >
      {icon ? <Icon name={icon} size={14} color={selected ? c.accentInk : c.muted} /> : null}
      <Text variant="label" style={{ color: selected ? c.accentInk : c.ink2, fontSize: 13 }}>
        {label}
      </Text>
    </Pressable>
  );
}

export function Toggle({ value, onChange, label, disabled }: { value: boolean; onChange(v: boolean): void; label: string; disabled?: boolean }) {
  const { c } = useTheme();
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityState={{ checked: value, disabled }}
      disabled={disabled}
      onPress={() => onChange(!value)}
      hitSlop={8}
      style={(s) => [
        styles.toggle,
        { backgroundColor: value ? c.accent : c.soft, borderColor: value ? c.accent : c.line },
        disabled && { opacity: 0.5 },
        focusRing(c, (s as PressState).focused),
      ]}
    >
      <View style={[styles.thumb, { backgroundColor: c.surface, borderColor: c.line, transform: [{ translateX: value ? 18 : 0 }] }]} />
    </Pressable>
  );
}

export type PillTone = 'neutral' | 'accent' | 'assistant' | 'good' | 'warn' | 'bad' | 'context';

export function Pill({ label, tone = 'neutral', icon, dot }: { label: string; tone?: PillTone; icon?: IconName; dot?: boolean }) {
  const { c } = useTheme();
  const t = {
    neutral: [c.surface2, c.line, c.muted],
    accent: [c.accentSoft, c.accentLine, c.accentInk],
    assistant: [c.assistantSoft, c.assistantLine, c.assistant],
    good: [c.goodSoft, c.line, c.good],
    warn: [c.warnSoft, c.line, c.warn],
    bad: [c.badSoft, c.line, c.bad],
    context: [c.surface2, c.line, c.context],
  }[tone];
  return (
    <View style={[styles.pill, { backgroundColor: t[0], borderColor: t[1] }]}>
      {dot ? <View style={[styles.dot, { backgroundColor: t[2] }]} /> : null}
      {icon ? <Icon name={icon} size={12} color={t[2]} /> : null}
      <Text variant="meta" style={{ color: t[2], fontFamily: font.medium }} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

/** Solid avatar: agents use `assistant`, people use `accent`. */
export function Avatar({ name, kind = 'user', size = 28 }: { name: string; kind?: 'agent' | 'user'; size?: number }) {
  const { c } = useTheme();
  const letters = name.trim().slice(0, kind === 'agent' && name.length > 1 ? 2 : 1);
  return (
    <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: kind === 'agent' ? c.assistant : c.accent, alignItems: 'center', justifyContent: 'center' }}>
      <Text variant="meta" style={{ color: c.onAccent, fontFamily: font.semibold, fontSize: size * 0.42 }}>
        {letters.charAt(0).toUpperCase() + letters.slice(1).toLowerCase()}
      </Text>
    </View>
  );
}

export type TextFieldProps = TextInputProps & { icon?: IconName; containerStyle?: StyleProp<ViewStyle>; ref?: React.Ref<React.ComponentRef<typeof TextInput>> };

export function TextField({ icon, containerStyle, style, onFocus, onBlur, ref, ...rest }: TextFieldProps) {
    const { c } = useTheme();
    const [focused, setFocused] = React.useState(false);
    return (
      <View
        style={[
          styles.field,
          { backgroundColor: c.surface, borderColor: focused ? c.accent : c.line },
          containerStyle,
        ]}
      >
        {icon ? <Icon name={icon} size={16} color={c.faint} /> : null}
        <TextInput
          ref={ref}
          placeholderTextColor={c.faint}
          {...rest}
          onFocus={(e) => {
            setFocused(true);
            onFocus?.(e);
          }}
          onBlur={(e) => {
            setFocused(false);
            onBlur?.(e);
          }}
          style={[styles.input, { color: c.ink }, Platform.OS === 'web' && ({ outlineStyle: 'none' } as object), style]}
        />
      </View>
    );
}

const styles = StyleSheet.create({
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderRadius: radius.control,
    borderWidth: StyleSheet.hairlineWidth,
  },
  iconButton: { alignItems: 'center', justifyContent: 'center', borderRadius: radius.control },
  segTrack: { flexDirection: 'row', borderRadius: radius.control, padding: 3, gap: 2, alignSelf: 'flex-start' },
  seg: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minHeight: 38,
    paddingHorizontal: 12,
    borderRadius: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'transparent',
  },
  swatch: { width: 14, height: 14, borderRadius: 7, borderWidth: StyleSheet.hairlineWidth },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    height: 34,
    paddingHorizontal: 12,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
  },
  toggle: { width: 46, height: 28, borderRadius: 14, padding: 3, borderWidth: StyleSheet.hairlineWidth, justifyContent: 'center' },
  thumb: { width: 20, height: 20, borderRadius: 10, borderWidth: StyleSheet.hairlineWidth },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    height: 24,
    paddingHorizontal: 9,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    alignSelf: 'flex-start',
  },
  dot: { width: 6, height: 6, borderRadius: 3 },
  field: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    minHeight: CONTROL_H,
    paddingHorizontal: 12,
    borderRadius: radius.control,
    borderWidth: StyleSheet.hairlineWidth,
  },
  input: { flex: 1, fontFamily: font.regular, fontSize: 15, paddingVertical: 10 },
});
