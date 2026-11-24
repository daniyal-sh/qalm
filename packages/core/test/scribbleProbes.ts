// Scribble-outs a reviewer found blocked by the outline rules (re-check of PR #68): a word written in a hand-drawn box,
// and small closed letters (o, 8), alone or next to a digit. Each case is a quick zig-zag over the ink; it succeeds when
// exactly that ink is deleted (the box around a word stays).
import { detectScribble, UNITS_PER_MM, type InkPoint, type Item, type StrokeItem } from '../src';
import { pointsBBox } from '../src/geometry/bbox';
import { trace, zigzag } from './gestures';
import { handwriting } from './ink';

export interface Probe {
  name: string;
  items: Item[];
  scribble: InkPoint[];
  /** The ids the scribble should delete. */
  want: string[];
}

const U = UNITS_PER_MM;
const span = (items: Item[]) => {
  const b = pointsBBox(items.flatMap((it) => (it.type === 'stroke' ? it.points : [])));
  return { x: b[0], y: b[1], w: (b[2] - b[0]) / U, h: (b[3] - b[1]) / U };
};
const box = (id: string, x: number, y: number, w: number, h: number): StrokeItem => {
  const points = trace([[0, 0], [w, 0], [w, h], [0, h], [0, 0]], { at: [x, y], speed: 40 });
  return { id, type: 'stroke', tool: 'pen', color: '#27272a', width: 1.6, points, bbox: pointsBBox(points, 0.8), createdAt: 0 };
};
/** A zig-zag over `ink`, `ov` mm past it on every side, `legs` legs, at `speed` mm/s. */
const over = (ink: Item[], ov: number, legs: number, speed: number) => {
  const s = span(ink);
  return trace(zigzag(s.w + 2 * ov, (s.h + 2 * ov) / legs, legs, 0.1), { at: [s.x - ov * U, s.y - ov * U], speed });
};
/** handwriting() glyph size for letters `mm` tall (its o and 8 are 8 glyph units). */
const sized = (mm: number) => (mm * U * 20) / 8;

export function probes(): Record<string, Probe[]> {
  const out: Record<string, Probe[]> = { 'cos(x) in a box': [], 'a 6.3 mm o': [], '2o': [], 'a 6.3 mm 8': [] };
  for (const m of [1.5, 2, 3]) {
    const word = handwriting('w', 'cos(x)', 200, 200, 20);
    const s = span(word);
    const frame = box('box', s.x - m * U, s.y - m * U, s.w + 2 * m, s.h + 2 * m);
    for (const ov of [0.5, 1, m]) {
      for (const speed of [120, 200]) {
        for (const legs of [8, 12]) {
          out['cos(x) in a box']!.push({
            name: `cos(x) in a box, ${m} mm margin, ${ov} mm past, ${speed} mm/s, ${legs} legs`,
            items: [frame, ...word],
            scribble: over(word, ov, legs, speed),
            want: word.map((x) => x.id),
          });
        }
      }
    }
  }
  for (const [group, text] of [['a 6.3 mm o', 'o'], ['a 6.3 mm 8', '8']] as const) {
    const ink = handwriting('g', text, 200, 200, sized(6.3));
    for (const ov of [0.5, 1, 1.5, 2]) {
      for (const speed of [120, 200]) {
        for (const legs of [6, 8, 10]) out[group]!.push({ name: `${group}, ${ov} mm past, ${speed} mm/s, ${legs} legs`, items: ink, scribble: over(ink, ov, legs, speed), want: ink.map((x) => x.id) });
      }
    }
  }
  const two = handwriting('t', '2o', 200, 200, sized(6.3));
  for (const ov of [0.5, 1, 1.5]) {
    for (const speed of [120, 200]) {
      for (const legs of [8, 12]) out['2o']!.push({ name: `2o, ${ov} mm past, ${speed} mm/s, ${legs} legs`, items: two, scribble: over(two, ov, legs, speed), want: two.map((x) => x.id) });
    }
  }
  return out;
}

/** Whether the probe's scribble deletes exactly what it should. */
export const erases = (p: Probe) => JSON.stringify([...(detectScribble(p.items, p.scribble, 1.8) ?? [])].sort()) === JSON.stringify([...p.want].sort());
