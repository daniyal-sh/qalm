import { requireNativeView } from 'expo';
import * as React from 'react';
import { StyleSheet } from 'react-native';

import type { InkOverlayProps } from './InkOverlay.types';

/**
 * Native view QalmInkView (Android: app.qalm.ink.QalmInkView, iOS: QalmInkView), registered by module "QalmInk".
 * The brush width goes over as `strokeWidth`: under Fabric, style is flattened into props, so a native prop named
 * `width` would also be read as the view's layout width.
 */
const NativeInkView: React.ComponentType<
  Omit<InkOverlayProps, 'width'> & { strokeWidth: number; pointerEvents?: 'auto' | 'none' }
> = requireNativeView('QalmInk');

/**
 * Transparent live-ink overlay. Stack it exactly over the page's PageCanvas; it takes all input and
 * draws only the stroke in progress (plus finished strokes until their id is in `committedIds`).
 */
export function InkOverlay({ style, width, ...props }: InkOverlayProps) {
  return (
    <NativeInkView
      {...props}
      strokeWidth={width}
      style={[StyleSheet.absoluteFill, style]}
      pointerEvents={props.tool === 'none' ? 'none' : 'auto'}
    />
  );
}
