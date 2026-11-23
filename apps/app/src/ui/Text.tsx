import * as React from 'react';
import { Text as RNText, type TextProps, type TextStyle } from 'react-native';

import { useTheme } from '../theme/ThemeProvider';
import { font, type Colors } from '../theme/tokens';

export type TextVariant = 'display' | 'title' | 'section' | 'body' | 'bodyStrong' | 'label' | 'meta' | 'mono';
export type TextTone = 'ink' | 'ink2' | 'muted' | 'faint' | 'accent' | 'assistant' | 'good' | 'warn' | 'bad' | 'context' | 'onAccent';

const VARIANTS: Record<TextVariant, TextStyle> = {
  display: { fontFamily: font.semibold, fontSize: 28, lineHeight: 34, letterSpacing: -0.56 },
  title: { fontFamily: font.semibold, fontSize: 24, lineHeight: 30, letterSpacing: -0.48 },
  section: { fontFamily: font.semibold, fontSize: 17, lineHeight: 24, letterSpacing: -0.17 },
  body: { fontFamily: font.regular, fontSize: 15, lineHeight: 22 },
  bodyStrong: { fontFamily: font.medium, fontSize: 15, lineHeight: 22 },
  label: { fontFamily: font.medium, fontSize: 14, lineHeight: 20 },
  meta: { fontFamily: font.regular, fontSize: 12, lineHeight: 16 },
  mono: { fontFamily: font.mono, fontSize: 13, lineHeight: 18 },
};

export function toneColor(c: Colors, tone: TextTone): string {
  switch (tone) {
    case 'accent':
      return c.accentInk;
    case 'onAccent':
      return c.onAccent;
    default:
      return c[tone];
  }
}

export interface QTextProps extends TextProps {
  variant?: TextVariant;
  tone?: TextTone;
}

export function Text({ variant = 'body', tone, style, ...rest }: QTextProps) {
  const { c } = useTheme();
  const defaultTone: TextTone = variant === 'meta' ? 'muted' : 'ink';
  return <RNText {...rest} style={[VARIANTS[variant], { color: toneColor(c, tone ?? defaultTone) }, style]} />;
}
