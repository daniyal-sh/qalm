import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
declare const console: { log(...a: unknown[]): void };
import { LectureDoc, type InkPoint, type LectureEvent, type StrokeItem } from '../src';

/** A deterministic pseudo-random handwriting stroke: `n` points over ~`n * 4` ms, wobbling like real writing. */
function handStroke(id: string, x: number, y: number, n: number, seed: number): StrokeItem {
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
  const points: InkPoint[] = [];
  let px = x, py = y;
  for (let i = 0; i < n; i++) {
    px += (rnd() - 0.3) * 1.6;
    py += Math.sin(i / 4) * 0.9 + (rnd() - 0.5) * 0.4;
    points.push({ x: px, y: py, p: 0.35 + rnd() * 0.4, tilt: 1.05 + rnd() * 0.1, az: 2.1 + rnd() * 0.05, t: i * 4.2 });
  }
  return { id, type: 'stroke', tool: 'pen', color: '#27272a', width: 1.8, points, bbox: [x, y, px, py], createdAt: 0, style: 'fountain', smoothing: 2 };
}

/**
 * Sizes per hour of lecture (docs/lecture-mode.md §9): a teacher writing 3,000 strokes an hour (one every 1.2 s), 10%
 * of them erased, a page turn every 5 minutes. Pen input at 240 Hz gives ~70 points per stroke.
 */
describe('lecture sizes per hour', () => {
  it('timeline stays a few MB per hour', () => {
    const lec = new LectureDoc(new Y.Doc());
    let batch: LectureEvent[] = [];
    const strokes: StrokeItem[] = [];
    for (let i = 0; i < 3000; i++) {
      const t = i * 1200;
      const page = `pg${Math.floor(t / 300_000)}`;
      if (t % 300_000 === 0) batch.push({ t, k: 'page', p: page, n: 1 + Math.floor(t / 300_000) }, { t, k: 'base', p: page, ids: [] });
      const s = handStroke(`stroke-${i}-0000-0000-0000-000000000000`, 40 + (i % 30) * 17, 60 + (i % 40) * 18, 60 + (i % 25), i + 1);
      strokes.push(s);
      batch.push({ t, k: 'add', p: page, items: [s] });
      if (i % 10 === 9) batch.push({ t: t + 600, k: 'erase', p: page, items: [strokes[i - 3]!] });
      // The client flushes ~1 s after a stroke while writing continuously: about every 5 strokes.
      if (batch.length >= 5) {
        lec.appendEvents(batch);
        batch = [];
      }
    }
    lec.appendEvents(batch);
    const timeline = lec.timelineChunks().reduce((n, c) => n + c.byteLength, 0);
    const doc = Y.encodeStateAsUpdate(lec.doc).byteLength;
    const audio = (32_000 / 8) * 3600;
    console.log(`per hour: timeline ${(timeline / 1e6).toFixed(2)} MB deflated (${lec.timelineChunks().length} chunks), session doc ${(doc / 1e6).toFixed(2)} MB, audio ${(audio / 1e6).toFixed(1)} MB at 32 kbps`);
    expect(timeline).toBeLessThan(6_000_000);
  });
});
