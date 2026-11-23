import * as React from 'react';
import { View } from 'react-native';
import Svg, { Circle, Defs, Mask, Path, Rect } from 'react-native-svg';

import { useTheme } from '../theme/ThemeProvider';
import { BRAND, font } from '../theme/tokens';
import { Text } from './Text';

const ORBIT_BACK =
  'M7.5 57.3L8.0 55.7L8.8 53.9L9.8 52.2L11.2 50.4L12.9 48.5L14.8 46.6L17.0 44.7L19.4 42.8L22.1 40.9L25.1 39.0L28.2 37.2L31.5 35.4L35.0 33.6L38.6 31.9L42.3 30.3L46.2 28.7L50.1 27.3L54.1 25.9L58.2 24.7L62.2 23.5L66.2 22.5L70.2 21.6L74.2 20.9L78.0 20.3L81.7 19.8L85.4 19.4L88.8 19.2L92.1 19.2L95.2 19.3L98.1 19.5L100.8 19.9L103.2 20.5L105.4 21.1L107.3 21.9L108.9 22.9L110.3 23.9';
const ORBIT_FRONT =
  'M111.2 24.9L112.0 26.3L112.5 27.9L112.6 29.6L112.3 31.4L111.6 33.3L110.5 35.3L109.0 37.4L107.1 39.5L104.9 41.6L102.4 43.8L99.5 46.0L96.3 48.1L92.8 50.2L89.1 52.3L85.2 54.3L81.1 56.2L76.8 58.1L72.4 59.8L67.9 61.4L63.3 62.9L58.7 64.2L54.1 65.4L49.6 66.4L45.1 67.2L40.8 67.9L36.6 68.4L32.6 68.7L28.8 68.8L25.2 68.7L21.9 68.5L18.9 68.0L16.2 67.4L13.8 66.6L11.8 65.6L10.1 64.4L8.8 63.1';
const NIB_MASK = 'M60 94 C52 78 38 64 37 48 C36 34 46 22 60 11 C74 22 84 34 83 48 C82 64 68 78 60 94Z';
const NIB = 'M60 86 C54 73 45 61 44 48 C43 37 50 28 60 19 C70 28 77 37 76 48 C75 61 66 73 60 86Z';

/** The Qalm mark (assets/brand/qalm-mark.svg) with theme colours: ink nib, accent orbit, assistant planet. */
export function Mark({ size = 32 }: { size?: number }) {
  const { c } = useTheme();
  const id = React.useId().replace(/:/g, '');
  return (
    <Svg width={size * 1.2} height={size} viewBox="0 0 120 100" fill="none">
      <Defs>
        <Mask id={`ring${id}`}>
          <Rect width="120" height="100" fill="#fff" />
          <Path d={NIB_MASK} fill="#000" />
        </Mask>
      </Defs>
      <Path d={ORBIT_BACK} stroke={c.accent} strokeWidth={6} strokeLinecap="round" strokeLinejoin="round" mask={`url(#ring${id})`} />
      <Path d={NIB} stroke={c.ink} strokeWidth={7} strokeLinecap="round" strokeLinejoin="round" />
      <Path d="M60 80 L60 57" stroke={c.ink} strokeWidth={5} strokeLinecap="round" />
      <Circle cx="60" cy="50" r="4.5" fill={c.ink} />
      <Path d={ORBIT_FRONT} stroke={c.accent} strokeWidth={6} strokeLinecap="round" strokeLinejoin="round" />
      <Circle cx="107.3" cy="39.3" r="7.5" fill={c.assistant} />
    </Svg>
  );
}

/** Lockup: the mark, then "Qalm" (semibold, -0.02em) with "by Apollo" under it (medium, muted, 0.58×). */
export function Lockup({ size = 20 }: { size?: number }) {
  const { c } = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: size * 0.45 }} accessibilityLabel={`${BRAND.name} ${BRAND.byline}`}>
      <Mark size={size * 1.5} />
      <View>
        <Text style={{ fontFamily: font.semibold, fontSize: size, lineHeight: size * 1.1, letterSpacing: -0.02 * size, color: c.ink }}>{BRAND.name}</Text>
        <Text style={{ fontFamily: font.medium, fontSize: size * 0.58, lineHeight: size * 0.75, color: c.muted }}>{BRAND.byline}</Text>
      </View>
    </View>
  );
}
