import * as React from 'react';
import { View } from 'react-native';
import Svg, { Circle, Defs, Mask, Path, Rect } from 'react-native-svg';

import { useTheme } from '../theme/ThemeProvider';
import { BRAND, font } from '../theme/tokens';
import { MARK, MARK_COLORS, MARK_WEIGHTS, markWeightFor } from './markGeometry';
import { Text } from './Text';

/**
 * The qalm mark (assets/brand/qalm-mark.svg). It follows the theme: the light mark on light, the dark mark on dark
 * (the graphite tile is only for the app icon). `size` is its height; below 24 px it draws the heavier weights.
 */
export function Mark({ size = 32 }: { size?: number }) {
  const { scheme } = useTheme();
  const id = React.useId().replace(/[^a-zA-Z0-9]/g, '');
  const col = MARK_COLORS[scheme];
  const w = MARK_WEIGHTS[markWeightFor(size)];
  const [vx, vy, vw, vh] = w.viewBox;
  const box = { x: vx - 5, y: vy - 5, width: vw + 10, height: vh + 10 };
  const halo = <Circle cx={MARK.planet.cx} cy={MARK.planet.cy} r={w.planet + w.halo} fill="#000" />;
  return (
    <Svg width={(size * vw) / vh} height={size} viewBox={w.viewBox.join(' ')} fill="none">
      <Defs>
        <Mask id={`back${id}`} maskUnits="userSpaceOnUse" {...box}>
          <Rect {...box} fill="#fff" />
          <Path d={MARK.nib} fill="#000" />
          {halo}
        </Mask>
        <Mask id={`halo${id}`} maskUnits="userSpaceOnUse" {...box}>
          <Rect {...box} fill="#fff" />
          {halo}
        </Mask>
      </Defs>
      <Path d={MARK.orbitBack} stroke={col.orbit} strokeWidth={w.orbit} strokeLinecap="round" mask={`url(#back${id})`} />
      <Path d={MARK.nib} stroke={col.ink} strokeWidth={w.nib} strokeLinejoin="round" />
      <Path d={MARK.slit} stroke={col.ink} strokeWidth={w.slit} strokeLinecap="round" />
      {w.hole ? <Circle cx={MARK.hole.cx} cy={MARK.hole.cy} r={w.hole} fill={col.ink} /> : null}
      <Path d={MARK.orbitFront} stroke={col.orbit} strokeWidth={w.orbit} strokeLinecap="round" mask={`url(#halo${id})`} />
      <Circle cx={MARK.planet.cx} cy={MARK.planet.cy} r={w.planet} fill={col.planet} />
    </Svg>
  );
}

/** Lockup: the mark, then "qalm" (semibold, -0.02em) with "by Apollo" under it (medium, muted, 0.58×). */
export function Lockup({ size = 20 }: { size?: number }) {
  const { c } = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: size * 0.45 }} accessibilityLabel={`${BRAND.name} ${BRAND.byline}`}>
      <Mark size={size * 1.6} />
      <View>
        <Text style={{ fontFamily: font.semibold, fontSize: size, lineHeight: size * 1.1, letterSpacing: -0.02 * size, color: c.ink }}>{BRAND.name}</Text>
        <Text style={{ fontFamily: font.medium, fontSize: size * 0.58, lineHeight: size * 0.75, color: c.muted }}>{BRAND.byline}</Text>
      </View>
    </View>
  );
}
