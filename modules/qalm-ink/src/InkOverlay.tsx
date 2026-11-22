import { requireNativeView } from 'expo';
import * as React from 'react';
import { StyleSheet } from 'react-native';

import type { InkOverlayProps } from './InkOverlay.types';

/** Native view QalmInkView (Android: app.qalm.ink.QalmInkView, iOS: QalmInkView), registered by module "QalmInk". */
const NativeInkView: React.ComponentType<InkOverlayProps & { pointerEvents?: 'auto' | 'none' }> =
  requireNativeView('QalmInk');

/**
 * Transparent live-ink overlay. Stack it exactly over the page's PageCanvas; it takes all input and
 * draws only the stroke in progress (plus finished strokes until their id is in `committedIds`).
 */
export function InkOverlay({ style, ...props }: InkOverlayProps) {
  return (
    <NativeInkView
      {...props}
      style={[StyleSheet.absoluteFill, style]}
      pointerEvents={props.tool === 'none' ? 'none' : 'auto'}
    />
  );
}
