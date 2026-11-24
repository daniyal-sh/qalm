import * as React from 'react';
import { Text as RNText, type TextProps, type TextStyle } from 'react-native';

import { useTheme } from '../theme/ThemeProvider';
import { typeRamp, type Colors, type TypeVariant } from '../theme/tokens';

export type TextVariant = TypeVariant;
export type TextTone = 'ink' | 'ink2' | 'muted' | 'faint' | 'accent' | 'assistant' | 'good' | 'warn' | 'bad' | 'context' | 'onAccent';

const VARIANTS: Record<TextVariant, TextStyle> = typeRamp;

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
