// Scribble to erase: the ink a scribble deleted fades out briefly where it was (it is already gone from the page), so
// it is clear what went. A plain fade of the deleted ink's own shapes; with reduced motion it just disappears.
import { inkPaint, shapePolylines, strokeSvgPath, type Item, type Size } from '@qalm/core';
import * as React from 'react';
import { Animated, Platform, StyleSheet } from 'react-native';
import Svg, { Path, Polyline } from 'react-native-svg';

import { useReducedMotion } from '../theme/motion';

/** How long deleted ink takes to fade out (ms). */
export const ERASE_FADE_MS = 320;

export interface Fading {
  key: number;
  items: Item[];
}

function FadeOut({ items, size, onDone }: { items: Item[]; size: Size; onDone(): void }) {
  const v = React.useRef(new Animated.Value(0.55)).current;
  const done = React.useRef(onDone);
  done.current = onDone;
  React.useEffect(() => {
    const a = Animated.timing(v, { toValue: 0, duration: ERASE_FADE_MS, useNativeDriver: Platform.OS !== 'web' });
    a.start(() => done.current());
    return () => a.stop();
  }, [v]);
  return (
    <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { opacity: v }]} testID="erase-fade">
      <Svg width="100%" height="100%" viewBox={`0 0 ${size.w} ${size.h}`}>
        {items.map((it) => {
          if (it.type === 'stroke') {
            const paint = inkPaint(it.tool, it.color);
            return <Path key={it.id} d={strokeSvgPath(it)} fill={paint.rgb} fillOpacity={paint.alpha} />;
          }
          if (it.type === 'shape') {
            const paint = inkPaint('pen', it.color);
            return shapePolylines(it).map((pl, i) => (
              <Polyline
                key={`${it.id}:${i}`}
                points={pl.map(([x, y]) => `${x},${y}`).join(' ')}
                fill="none"
                stroke={paint.rgb}
                strokeOpacity={paint.alpha}
                strokeWidth={it.width}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            ));
          }
          return null;
        })}
      </Svg>
    </Animated.View>
  );
}

/** Deleted ink fading out over a page (page units mapped onto the view). */
export function EraseFade({ fading, size, onDone }: { fading: Fading[]; size: Size; onDone(key: number): void }) {
  const reduce = useReducedMotion();
  // Reduced motion: the ink just goes (nothing to show, nothing kept).
  React.useEffect(() => {
    if (reduce) for (const f of fading) onDone(f.key);
  }, [reduce, fading, onDone]);
  if (reduce || !fading.length) return null;
  return (
    <>
      {fading.map((f) => (
        <FadeOut key={f.key} items={f.items} size={size} onDone={() => onDone(f.key)} />
      ))}
    </>
  );
}
