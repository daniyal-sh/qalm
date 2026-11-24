/**
 * Motion primitives (brand.md: brief, for continuity only; ink never animates). Every helper here respects the
 * platform's reduce-motion setting: things appear and disappear at once instead.
 */
import * as React from 'react';
import { AccessibilityInfo, Animated, Easing, Platform, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';

import { motion } from './tokens';

const NATIVE_DRIVER = Platform.OS !== 'web';
export const easeOut = Easing.bezier(...motion.easeOut);
export const easeIn = Easing.bezier(...motion.easeIn);
const css = (e: readonly number[]) => `cubic-bezier(${e.join(',')})`;

/**
 * Web only: hover and press colour changes ease over `motion.fast` (native press feedback is instant, as on iOS).
 * The global stylesheet turns transitions off under reduced motion.
 */
export const hoverTransition: ViewStyle | null =
  Platform.OS === 'web'
    ? ({
        transitionProperty: 'background-color, border-color, color, opacity, box-shadow, transform',
        transitionDuration: `${motion.fast}ms`,
        transitionTimingFunction: css(motion.easeOut),
      } as ViewStyle)
    : null;

let reduced = false;
let started = false;
const subs = new Set<(v: boolean) => void>();
function startWatching() {
  if (started) return;
  started = true;
  void AccessibilityInfo.isReduceMotionEnabled?.().then((v) => {
    reduced = !!v;
    subs.forEach((f) => f(reduced));
  });
  AccessibilityInfo.addEventListener?.('reduceMotionChanged', (v: boolean) => {
    reduced = !!v;
    subs.forEach((f) => f(reduced));
  });
}

/** True when the user asked the OS (or browser) to reduce motion. */
export function useReducedMotion(): boolean {
  startWatching();
  const [v, setV] = React.useState(reduced);
  React.useEffect(() => {
    subs.add(setV);
    setV(reduced);
    return () => void subs.delete(setV);
  }, []);
  return v;
}

/**
 * Keeps an overlay mounted while it animates out. `progress` runs 0 → 1 on show (`motion.base`, decelerating) and
 * back to 0 on hide (`motion.fast`, accelerating), then `mounted` turns false. With reduced motion it jumps.
 */
export function usePresence(visible: boolean, enter: number = motion.base, exit: number = motion.fast): { mounted: boolean; progress: Animated.Value } {
  const reduce = useReducedMotion();
  const progress = React.useRef(new Animated.Value(visible ? 1 : 0)).current;
  const [mounted, setMounted] = React.useState(visible);
  React.useEffect(() => {
    if (visible) setMounted(true);
    if (reduce) {
      progress.setValue(visible ? 1 : 0);
      if (!visible) setMounted(false);
      return;
    }
    const a = Animated.timing(progress, {
      toValue: visible ? 1 : 0,
      duration: visible ? enter : exit,
      easing: visible ? easeOut : easeIn,
      useNativeDriver: NATIVE_DRIVER,
    });
    a.start(({ finished }) => {
      if (finished && !visible) setMounted(false);
    });
    return () => a.stop();
  }, [visible, reduce, enter, exit, progress]);
  return { mounted, progress };
}

/** Opacity plus a short rise (or drop, with `from: 'top'`) and a slight scale, driven by a presence `progress`. */
export function riseStyle(progress: Animated.Value, opts: { from?: 'bottom' | 'top' | 'none'; distance?: number; scale?: boolean } = {}) {
  const d = opts.distance ?? motion.rise;
  const sign = opts.from === 'top' ? -1 : 1;
  const transform: object[] = [];
  if (opts.from !== 'none') transform.push({ translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [sign * d, 0] }) });
  if (opts.scale) transform.push({ scale: progress.interpolate({ inputRange: [0, 1], outputRange: [0.97, 1] }) });
  return { opacity: progress, transform } as unknown as Animated.WithAnimatedValue<ViewStyle>;
}

/** Fades (and rises) its children in once when mounted. For transient bars, cards and banners. */
export function Appear({
  children,
  style,
  from = 'bottom',
  distance,
  duration = motion.base,
  scale,
  pointerEvents,
  ready = true,
}: {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  from?: 'bottom' | 'top' | 'left' | 'right' | 'none';
  distance?: number;
  duration?: number;
  scale?: boolean;
  pointerEvents?: 'box-none' | 'none' | 'box-only' | 'auto';
  /** The entrance waits for this (e.g. until the content has measured itself and can be placed). */
  ready?: boolean;
}) {
  const reduce = useReducedMotion();
  const v = React.useRef(new Animated.Value(reduce ? 1 : 0)).current;
  React.useEffect(() => {
    if (!ready) return;
    if (reduce) return v.setValue(1);
    Animated.timing(v, { toValue: 1, duration, easing: easeOut, useNativeDriver: NATIVE_DRIVER }).start();
  }, [v, reduce, duration, ready]);
  const d = distance ?? motion.rise;
  // The style's own transforms (e.g. the focus pill's shrink on a phone) and opacity (the pill stays hidden until it
  // has measured itself) stay; the entrance is added to them.
  const flat = StyleSheet.flatten(style);
  const own = (flat?.transform ?? []) as object[];
  const ownOpacity = typeof flat?.opacity === 'number' ? flat.opacity : undefined;
  const opacity = ownOpacity === undefined ? v : Animated.multiply(v, ownOpacity);
  const transform: object[] = [...own];
  if (from === 'bottom' || from === 'top') transform.push({ translateY: v.interpolate({ inputRange: [0, 1], outputRange: [from === 'top' ? -d : d, 0] }) });
  if (from === 'left' || from === 'right') transform.push({ translateX: v.interpolate({ inputRange: [0, 1], outputRange: [from === 'left' ? -d : d, 0] }) });
  if (scale) transform.push({ scale: v.interpolate({ inputRange: [0, 1], outputRange: [0.97, 1] }) });
  return (
    <Animated.View pointerEvents={pointerEvents} style={[style, { opacity, transform } as unknown as Animated.WithAnimatedValue<ViewStyle>]}>
      {children}
    </Animated.View>
  );
}
