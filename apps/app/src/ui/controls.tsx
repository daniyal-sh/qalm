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

import { hoverTransition } from '../theme/motion';
import { useTheme } from '../theme/ThemeProvider';
import { CONTROL_H, CONTROL_H_SM, font, radius, space, type Colors } from '../theme/tokens';
import { Icon, type IconName } from './Icon';
import { Text } from './Text';

type PressState = { pressed: boolean; hovered?: boolean; focused?: boolean };

/**
 * Visible focus ring (brand.md: 2px accent-line plus a 1px accent edge). On web the global stylesheet draws it for
 * keyboard focus only (`:focus-visible`, see theme/webCss.ts), so a click never leaves a ring behind; native draws an
 * accent border while focused.
 */
export function focusRing(c: Colors, focused: boolean | undefined): ViewStyle | null {
  if (!focused || Platform.OS === 'web') return null;
  return { borderColor: c.accent };
}

/** `danger` is a quiet red-text button; `destructive` is the solid red action of a confirm dialog. */
export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'destructive' | 'assistant';

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
  // Hover is one quiet step, press a firmer one. Solid fills dim slightly instead (never a gradient or glow).
  const fill: Record<ButtonVariant, { bg: string; bgHover: string; bgPressed: string; border: string; fg: string }> = {
    primary: { bg: c.accent, bgHover: c.accent, bgPressed: c.accent, border: c.accent, fg: c.onAccent },
    assistant: { bg: c.assistant, bgHover: c.assistant, bgPressed: c.assistant, border: c.assistant, fg: c.onAssistant },
    secondary: { bg: c.surface, bgHover: c.surface2, bgPressed: c.soft, border: c.line, fg: c.ink },
    ghost: { bg: 'transparent', bgHover: c.surface2, bgPressed: c.soft, border: 'transparent', fg: c.ink },
    danger: { bg: c.surface, bgHover: c.badSoft, bgPressed: c.badSoft, border: c.line, fg: c.bad },
    destructive: { bg: c.bad, bgHover: c.bad, bgPressed: c.bad, border: c.bad, fg: c.onBad },
  };
  const f = fill[variant];
  const solid = variant === 'primary' || variant === 'assistant' || variant === 'destructive';
  const h = size === 'sm' ? CONTROL_H_SM : CONTROL_H;
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
          hoverTransition,
          {
            height: h,
            paddingHorizontal: size === 'sm' ? space.md : space.lg,
            backgroundColor: st.pressed ? f.bgPressed : st.hovered ? f.bgHover : f.bg,
            borderColor: f.border,
          },
          solid && !(disabled || loading) && (st.pressed ? { opacity: 0.84 } : st.hovered ? { opacity: 0.92 } : null),
          grow && { flexGrow: 1 },
          (disabled || loading) && { opacity: 0.45 },
          focusRing(c, st.focused),
          style,
        ];
      }}
    >
      {loading ? <ActivityIndicator size="small" color={f.fg} /> : icon ? <Icon name={icon} size={size === 'sm' ? 15 : 16} color={f.fg} /> : null}
      <Text variant={size === 'sm' ? 'smallStrong' : 'label'} style={{ color: f.fg, flexShrink: 1 }} numberOfLines={1}>
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
  ref?: React.Ref<React.ComponentRef<typeof View>>;
}

export function IconButton({ icon, label, selected, tone = 'default', size = CONTROL_H, color, style, ...rest }: IconButtonProps) {
  const { c } = useTheme();
  // `selected` is an on/off state (a panel that's open): accent-soft with an accent-line border, not a solid fill,
  // so the selected tool stays the one solid indigo control on screen.
  const fg = color ?? (selected ? c.accentInk : tone === 'assistant' ? c.assistant : tone === 'bad' ? c.bad : c.ink2);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected, disabled: !!rest.disabled }}
      hitSlop={size < CONTROL_H ? Math.ceil((CONTROL_H - size) / 2) : undefined}
      // Web: the name as a hover tooltip (icon-only control).
      {...((Platform.OS === 'web' ? { title: label } : {}) as object)}
      {...rest}
      style={(s) => {
        const st = s as PressState;
        return [
          styles.iconButton,
          hoverTransition,
          {
            width: size,
            height: size,
            backgroundColor: selected ? c.accentSoft : st.pressed ? c.soft : st.hovered ? c.surface2 : 'transparent',
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: selected ? c.accentLine : 'transparent',
          },
          rest.disabled && { opacity: 0.38 },
          focusRing(c, st.focused),
          style,
        ];
      }}
    >
      {/* Optical size: 20 px in a 44 px button, 16 in 36, 14 in 32 (Feather's 2 px strokes stay crisp). */}
      <Icon name={icon} size={Math.round(size * 0.45)} color={fg} />
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
              hoverTransition,
              on ? [{ backgroundColor: c.surface, borderColor: c.line }, segRaise] : (s as PressState).hovered ? { backgroundColor: c.surface2 } : null,
              focusRing(c, (s as PressState).focused),
            ]}
          >
            {o.swatch ? <View style={[styles.swatch, { backgroundColor: o.swatch, borderColor: c.line }]} /> : null}
            {o.icon ? <Icon name={o.icon} size={15} color={on ? c.ink : c.muted} /> : null}
            <Text variant="label" style={{ color: on ? c.ink : c.muted, flexShrink: 1 }} numberOfLines={1}>
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
        hoverTransition,
        {
          backgroundColor: selected ? c.accentSoft : (s as PressState).hovered ? c.surface2 : c.surface,
          borderColor: selected ? c.accentLine : c.line,
        },
        focusRing(c, (s as PressState).focused),
      ]}
    >
      {icon ? <Icon name={icon} size={14} color={selected ? c.accentInk : c.muted} /> : null}
      <Text variant="smallStrong" style={{ color: selected ? c.accentInk : c.ink2 }} numberOfLines={1}>
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
        hoverTransition,
        { backgroundColor: value ? c.accent : c.soft, borderColor: value ? c.accent : c.line },
        disabled && { opacity: 0.5 },
        focusRing(c, (s as PressState).focused),
      ]}
    >
      <View style={[styles.thumb, hoverTransition, { backgroundColor: c.surface, borderColor: value ? c.accent : c.line, transform: [{ translateX: value ? 18 : 0 }] }]} />
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
      <Text variant="meta" style={{ color: kind === 'agent' ? c.onAssistant : c.onAccent, fontFamily: font.semibold, fontSize: size * 0.42 }}>
        {letters.charAt(0).toUpperCase() + letters.slice(1).toLowerCase()}
      </Text>
    </View>
  );
}

export type TextFieldProps = TextInputProps & { icon?: IconName; containerStyle?: StyleProp<ViewStyle>; ref?: React.Ref<React.ComponentRef<typeof TextInput>> };

export function TextField({ icon, containerStyle, style, onFocus, onBlur, ref, ...rest }: TextFieldProps) {
    const { c } = useTheme();
    const [focused, setFocused] = React.useState(false);
    const inner = React.useRef<React.ComponentRef<typeof TextInput> | null>(null);
    const setRef = React.useCallback(
      (node: React.ComponentRef<typeof TextInput> | null) => {
        inner.current = node;
        if (typeof ref === 'function') ref(node);
        else if (ref) (ref as React.RefObject<typeof node>).current = node;
      },
      [ref],
    );
    useKeepAutoFocus(!!rest.autoFocus, inner);
    return (
      <View
        style={[
          styles.field,
          hoverTransition,
          { backgroundColor: c.surface, borderColor: focused ? c.accent : c.line },
          // Focused: the brand ring around the field (solid, no glow).
          focused && Platform.OS === 'web' ? ({ boxShadow: `0 0 0 2px ${c.accentLine}` } as ViewStyle) : null,
          containerStyle,
        ]}
      >
        {icon ? <Icon name={icon} size={16} color={c.faint} /> : null}
        <TextInput
          ref={setRef}
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

/**
 * Web: `autoFocus` can lose to focus moves that land right after a sheet opens, e.g. the menu it was opened from
 * handing focus back as it closes (Rename opened with focus on the sheet's Close button). For a moment after mounting,
 * take focus back unless it went to another text field.
 */
function useKeepAutoFocus(autoFocus: boolean, input: React.RefObject<React.ComponentRef<typeof TextInput> | null>) {
  React.useEffect(() => {
    if (Platform.OS !== 'web' || !autoFocus || typeof document === 'undefined') return;
    const grab = () => {
      const a = document.activeElement as HTMLElement | null;
      if (!a || !(a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable)) input.current?.focus();
    };
    const first = setTimeout(grab, 0);
    document.addEventListener('focusin', grab);
    const stop = setTimeout(() => document.removeEventListener('focusin', grab), 600);
    return () => {
      clearTimeout(first);
      clearTimeout(stop);
      document.removeEventListener('focusin', grab);
    };
  }, [autoFocus, input]);
}

/** The selected segment sits a hair above the track. */
const segRaise = { boxShadow: '0 1px 2px rgba(0,0,0,0.06)' } as ViewStyle;

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
  segTrack: { flexDirection: 'row', borderRadius: radius.control, padding: 3, gap: 2, alignSelf: 'flex-start', maxWidth: '100%' },
  seg: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minHeight: 38,
    paddingHorizontal: 12,
    borderRadius: radius.inner,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'transparent',
    flexShrink: 1,
    minWidth: 0,
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
