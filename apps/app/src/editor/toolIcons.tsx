/**
 * The editor's tool icons, drawn on Feather's grid (24 px, 1.8 px round strokes) so the toolbar matches the stroke
 * icons used everywhere else (header, menus, sheets). Material's filled glyphs read heavier and mixed two styles.
 */
import * as React from 'react';
import Svg, { Circle, Path, Rect } from 'react-native-svg';

export type ToolIconName =
  | 'pen'
  | 'highlighter'
  | 'eraser'
  | 'lasso'
  | 'text'
  | 'image'
  | 'fountain'
  | 'ballpoint'
  | 'brush'
  | 'shapes'
  | 'rect-select'
  | 'erase-stroke'
  | 'erase-partial'
  | 'ruler'
  | 'laser'
  | 'laser-trail'
  | 'laser-dot'
  | 'present';

const STROKE = 1.8;

function Shape({ name, color }: { name: ToolIconName; color: string }) {
  const p = { stroke: color, strokeWidth: STROKE, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, fill: 'none' };
  switch (name) {
    case 'pen':
    case 'fountain':
      // A nib, point down, with its slit and breather hole.
      return (
        <>
          <Path d="M12 21.2 7.2 13.6 8.8 6.4h6.4l1.6 7.2z" {...p} />
          <Path d="M8.8 6.4V3.2h6.4v3.2" {...p} />
          <Path d="M12 21.2v-6.4" {...p} />
          <Circle cx={12} cy={12.6} r={1.1} fill={color} />
        </>
      );
    case 'ballpoint':
      return (
        <>
          <Path d="M16.6 3.6 20.4 7.4 8.6 19.2l-4.9 1.1 1.1-4.9z" {...p} />
          <Path d="M14.4 5.8l3.8 3.8" {...p} />
        </>
      );
    case 'brush':
      return (
        <>
          <Path d="M20.2 3.8 12.4 11.6" {...p} />
          <Path d="M12.4 11.6c-2.1-.6-4.1.6-4.6 2.6-.4 1.6-1.4 2.8-3.4 3.3 3 2.1 7.6 1.5 8.6-1.5.5-1.5.2-3-.6-4.4z" {...p} />
        </>
      );
    case 'highlighter':
      // A chisel marker over the line it leaves.
      return (
        <>
          <Path d="M8.2 12.6 15 5.8a1.6 1.6 0 0 1 2.3 0l1.9 1.9a1.6 1.6 0 0 1 0 2.3l-6.8 6.8z" {...p} />
          <Path d="M8.2 12.6 6 17.2l1.8 1.8 4.6-2.2" {...p} />
          <Path d="M3.6 21h9" {...p} />
        </>
      );
    case 'eraser':
      return (
        <>
          <Path d="M8.4 20.4 4.3 16.3a1.8 1.8 0 0 1 0-2.5l9.4-9.4a1.8 1.8 0 0 1 2.5 0l4.1 4.1a1.8 1.8 0 0 1 0 2.5l-9 9.4" {...p} />
          <Path d="M8.6 9.4l6 6" {...p} />
          <Path d="M8.4 20.4h11.2" {...p} />
        </>
      );
    case 'lasso':
      return (
        <>
          <Path d="M7.2 15.6C4.6 14.6 3 12.8 3 10.6 3 7 7 4 12 4s9 3 9 6.6-4 6.6-9 6.6c-1 0-1.9-.1-2.8-.3" {...p} />
          <Path d="M7.2 15.6c-.9 1.2-.4 2.7 1.1 2.9 1.3.2 1.7 1.4 1 2.7" {...p} />
        </>
      );
    case 'rect-select':
      return (
        <>
          <Rect x={4} y={4} width={16} height={16} rx={1.6} {...p} strokeDasharray="3.2 3" />
        </>
      );
    case 'text':
      return (
        <>
          <Path d="M5 7V4.6h14V7" {...p} />
          <Path d="M12 4.6v14.8" {...p} />
          <Path d="M9 19.4h6" {...p} />
        </>
      );
    case 'image':
      return (
        <>
          <Rect x={3.4} y={3.4} width={17.2} height={17.2} rx={2.4} {...p} />
          <Circle cx={8.6} cy={8.6} r={1.6} {...p} />
          <Path d="M20.6 15.2 16 10.6 5.4 20.6" {...p} />
        </>
      );
    case 'erase-stroke':
      // The whole squiggle goes (dashed), whatever part the eraser touches.
      return (
        <>
          <Path d="M3.4 14.6c2.2-5.6 4.6-5.6 6.8 0s4.6 5.6 6.8 0c.9-2.2 2-3.4 3.6-3.6" {...p} strokeDasharray="2.2 2.6" />
          <Circle cx={13.6} cy={16.4} r={2.8} {...p} />
        </>
      );
    case 'erase-partial':
      // The squiggle with a gap where the eraser passed.
      return (
        <>
          <Path d="M3.4 14.6c1.8-4.6 3.8-5.4 5.6-2.4" {...p} />
          <Path d="M15.4 17.6c.6-.8 1.1-1.8 1.6-3 .9-2.2 2-3.4 3.6-3.6" {...p} />
          <Circle cx={12.2} cy={15.4} r={2.8} {...p} />
        </>
      );
    case 'ruler':
      // A straightedge on the slant, with its ticks.
      return (
        <>
          <Path d="M3.4 16.6 16.6 3.4l4 4L7.4 20.6z" {...p} />
          <Path d="M7.2 12.8l1.6 1.6M10 10l2.4 2.4M12.8 7.2l1.6 1.6" {...p} />
        </>
      );
    case 'laser':
      // A pointer, its beam, and the glowing point it throws.
      return (
        <>
          <Path d="M3.4 20.6l4.4-4.4" {...p} strokeWidth={3.2} />
          <Path d="M9.6 14.4l3.2-3.2" {...p} strokeDasharray="1.4 1.6" />
          <Circle cx={16.4} cy={7.6} r={2.2} fill={color} />
          <Circle cx={16.4} cy={7.6} r={4.6} {...p} />
        </>
      );
    case 'laser-trail':
      // A trail fading out behind the point.
      return (
        <>
          <Path d="M3.4 17.2c2.4-4.4 4.8-4.6 7-1.8 1.9 2.4 4 2.3 6-.6" {...p} strokeDasharray="2.2 2.4" />
          <Circle cx={18.8} cy={12.6} r={2.4} fill={color} />
        </>
      );
    case 'laser-dot':
      return (
        <>
          <Circle cx={12} cy={12} r={6.4} {...p} />
          <Circle cx={12} cy={12} r={2.6} fill={color} />
        </>
      );
    case 'present':
      // A screen on a stand, playing.
      return (
        <>
          <Rect x={3} y={3.8} width={18} height={12.4} rx={2} {...p} />
          <Path d="M12 16.2v4M8.2 20.2h7.6" {...p} />
          <Path d="M10.4 7.6v5l4-2.5z" {...p} />
        </>
      );
    case 'shapes':
      return (
        <>
          <Circle cx={8.4} cy={8.4} r={4.6} {...p} />
          <Rect x={12.6} y={12.6} width={8} height={8} rx={1.4} {...p} />
        </>
      );
  }
}

export function ToolIcon({ name, size = 22, color }: { name: ToolIconName; size?: number; color: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Shape name={name} color={color} />
    </Svg>
  );
}
