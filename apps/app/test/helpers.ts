import type { InkPoint, StrokeItem } from '@qalm/core';

import { makeStroke } from '../src/editor/items';

let n = 0;
export function stroke(x0: number, y0: number, x1: number, y1: number, opts: Partial<StrokeItem> = {}): StrokeItem {
  const pts: InkPoint[] = [];
  for (let i = 0; i <= 10; i++) {
    const t = i / 10;
    pts.push({ x: x0 + (x1 - x0) * t, y: y0 + (y1 - y0) * t, p: 0.5, tilt: Math.PI / 2, az: 0, t: i * 16 });
  }
  return { ...makeStroke({ id: `s${++n}-${Math.random().toString(36).slice(2)}`, tool: 'pen', color: '#27272a', width: 1.8, points: pts }), ...opts };
}

/** A handwriting-like zigzag word: `w` wide, 20 tall, starting at (x, y). */
export function word(x: number, y: number, w = 40): StrokeItem {
  const pts: InkPoint[] = [];
  for (let i = 0; i <= 12; i++) pts.push({ x: x + (w * i) / 12, y: y + (i % 2 ? 20 : 0), p: 0.5, tilt: Math.PI / 2, az: 0, t: i * 16 });
  return makeStroke({ id: `w${++n}-${Math.random().toString(36).slice(2)}`, tool: 'pen', color: '#27272a', width: 1.8, points: pts });
}

export const flush = () => new Promise((r) => setTimeout(r, 0));
