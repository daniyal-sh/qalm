import { requireNativeView } from 'expo';
import * as React from 'react';
import { StyleSheet } from 'react-native';

import type { InkOverlayProps, ShapePreview } from './InkOverlay.types';

/** Native → JS when the pen has held still (live shapes): the stroke up to where the hold began. */
interface ShapeHoldEvent {
  requestId: number;
  points: { x: number; y: number }[];
}

type NativeProps = Omit<InkOverlayProps, 'width' | 'recognizeShape' | 'adjustShape'> & {
  strokeWidth: number;
  pointerEvents?: 'auto' | 'none';
  /** Live shapes on: the view reports holds (`onShapeHold`). */
  shapeSnap: boolean;
  onShapeHold?(e: { nativeEvent: ShapeHoldEvent }): void;
};

/** The view's async function: the answer to `onShapeHold` (null: not a shape). */
interface NativeInkViewRef {
  setShapePreview(requestId: number, shape: ShapePreview | null): Promise<void>;
}

/**
 * Native view QalmInkView (Android: app.qalm.ink.QalmInkView, iOS: QalmInkView), registered by module "QalmInk".
 * The brush width goes over as `strokeWidth`: under Fabric, style is flattened into props, so a native prop named
 * `width` would also be read as the view's layout width.
 */
const NativeInkView = requireNativeView('QalmInk') as unknown as React.ComponentType<NativeProps & React.RefAttributes<NativeInkViewRef>>;

/**
 * Transparent live-ink overlay. Stack it exactly over the page's PageCanvas; it takes all input and
 * draws only the stroke in progress (plus finished strokes until their id is in `committedIds`).
 *
 * Live shapes on native: a JS function can't run synchronously on the UI thread, so the view times the hold itself,
 * sends the stroke so far (`onShapeHold`), and gets the recognised shape back through `setShapePreview`. The hold is
 * the latency budget; the view drops an answer that comes after the pen moved on or lifted. Adjusting the shape while
 * the pen drags runs natively (a port of @qalm/core `adjustShape`), so `adjustShape` is not used here.
 */
export function InkOverlay({ style, width, recognizeShape, adjustShape: _adjust, ...props }: InkOverlayProps) {
  const ref = React.useRef<NativeInkViewRef>(null);
  const recognize = React.useRef(recognizeShape);
  recognize.current = recognizeShape;
  const onShapeHold = React.useCallback(({ nativeEvent: e }: { nativeEvent: ShapeHoldEvent }) => {
    let shape: ShapePreview | null = null;
    try {
      shape = recognize.current?.(e.points) ?? null;
    } catch {
      shape = null;
    }
    void ref.current?.setShapePreview(e.requestId, shape).catch(() => undefined);
  }, []);
  return (
    <NativeInkView
      ref={ref}
      {...props}
      strokeWidth={width}
      shapeSnap={!!recognizeShape}
      onShapeHold={onShapeHold}
      style={[StyleSheet.absoluteFill, style]}
      pointerEvents={props.tool === 'none' ? 'none' : 'auto'}
    />
  );
}
