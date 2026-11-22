import { describe, expect, it } from 'vitest';
import { assignLabels, encodeQinkRead, encodeQinkUpdate, resolveRef, renderLinesStripSvg } from '../src';
import type { QinkLabels, QinkSnapshot } from '../src';
import { newNotebook, newPage, stroke } from './helpers';

/** A notebook whose third page holds a worked integral, written row by row (rows 40 apart, 20 high). */
function setup() {
  const nb = newNotebook();
  const p1 = nb.pages()[0]!.id;
  nb.addAsset({ id: 'pdf1', sha256: 'ab', mime: 'application/pdf', name: 'hw.pdf', bytes: 100, pageCount: 3 });
  nb.addPage({ id: 'P2', background: { kind: 'pdf', assetId: 'pdf1', pageIndex: 1 } });
  nb.addPage({ id: 'P3' });
  const page1 = newPage();
  const page3 = newPage();
  const row = (id: string, i: number) => stroke(id, 50, 100 + 40 * i, 150, 120 + 40 * i);
  page3.addItem(row('k1', 0));
  page3.addItem(row('k2', 1));
  page3.addItem(row('k3', 2));
  page3.addItem(row('k4', 3));
  page3.setLineText('k1', 'Q3 ∫x^2 ln x dx', 'user');
  page3.setLineText('k2', 'u=ln x', 'agent');
  page3.setLineText('k3', 'v=x^3/3', 'device', 0.7);
  return { nb, p1, page1, page3, row, pages: { [p1]: page1, P2: newPage(), P3: page3 } };
}

describe('Q-ink', () => {
  it('encodes net diffs, context lines, images and asks (golden)', () => {
    const { nb, p1, page1, page3, row, pages } = setup();
    const labels: QinkLabels = {};

    const u1 = encodeQinkUpdate(nb, pages, labels, {}, { session: 'calc2', rev: 1 });
    expect(u1.text).toBe(
      [
        '#q s=calc2 r=1 p3 "Q3 ∫x^2 ln x dx"',
        '+L1 "Q3 ∫x^2 ln x dx"',
        '+L2 "u=ln x"',
        '+L3 [1] ~"v=x^3/3"',
        '+L4 [2]',
      ].join('\n'),
    );
    expect(u1.image).toEqual({ pageId: 'P3', lineKeys: ['k3', 'k4'], labels: ['[1]', '[2]'] });

    // Erase L4, write two lines and a drawing, then tap Ask. A stroke written and erased in between leaves no trace.
    page3.removeItems(['k4']);
    page3.addItem(row('k5', 4));
    page3.addItem(row('k6', 5));
    page3.addItem(row('tmp', 7));
    page3.removeItems(['tmp']);
    page3.addItem(stroke('fig', 300, 400, 400, 520));
    page3.setLineText('k5', '=x3/3 lnx - ∫x3/3 1/x dx', 'device', 0.5);
    page3.setLineText('k6', '=x3/3lnx-x3/9', 'device', 0.6);
    const u2 = encodeQinkUpdate(nb, pages, labels, u1.snapshot, { session: 'calc2', rev: 2, asks: [{ pageId: 'P3', text: 'is L6 right?' }] });
    expect(u2.text).toBe(
      [
        '#q s=calc2 r=2 p3 "Q3 ∫x^2 ln x dx"',
        ' L3 v=x^3/3',
        '+L5 [1] ~"=x3/3 lnx - ∫x3/3 1/x dx"',
        '+L6 [2] ~"=x3/3lnx-x3/9"',
        '+D1 [3]',
        '-L4',
        'ask "is L6 right?"',
      ].join('\n'),
    );
    expect(u2.image).toEqual({ pageId: 'P3', lineKeys: ['k5', 'k6', 'fig'], labels: ['[1]', '[2]', '[3]'] });

    // Extend L2 (its agent text is cleared) and write on page 1 too.
    page3.addItem(stroke('k2b', 155, 140, 175, 160));
    page1.addItem(stroke('h1', 50, 100, 150, 120));
    page1.setLineText('h1', 'hello', 'device');
    const u3 = encodeQinkUpdate(nb, pages, labels, u2.snapshot, { session: 'calc2', rev: 3 });
    expect(u3.text).toBe(
      [
        '#q s=calc2 r=3 p3 "Q3 ∫x^2 ln x dx"',
        ' L1 Q3 ∫x^2 ln x dx',
        '~L2 [1]',
        'p1 "hello"',
        '+L1 ~"hello"',
      ].join('\n'),
    );
    expect(u3.image).toEqual({ pageId: 'P3', lineKeys: ['k2'], labels: ['[1]'] });

    // Nothing changed.
    const u4 = encodeQinkUpdate(nb, { P3: page3 }, labels, u3.snapshot, { session: 'calc2', rev: 4 });
    expect(u4.text).toBe('#q s=calc2 r=4 p3 "Q3 ∫x^2 ln x dx"');
    expect(u4.image).toBeNull();
    expect(u4.snapshot).toEqual(u3.snapshot);
    expect(Object.keys(u4.snapshot).sort()).toEqual([p1, 'P2', 'P3'].sort());

    // The image strip renders those rows.
    const strip = renderLinesStripSvg(page3, u2.image!.lineKeys, u2.image!.labels);
    expect(strip.svg).toContain('>[3]</text>');
    expect(strip.width).toBeGreaterThan(100);
    expect(strip.height).toBeGreaterThan(3 * 40);
  });

  it('keeps labels stable and never reuses them', () => {
    const { page3 } = setup();
    const labels: QinkLabels = {};
    assignLabels(labels, 'P3', page3.lines());
    expect(labels.P3).toEqual({ nextL: 5, nextD: 1, byKey: { k1: 'L1', k2: 'L2', k3: 'L3', k4: 'L4' } });
    page3.removeItems(['k2']);
    page3.addItem(stroke('top', 50, 40, 150, 60)); // above L1
    page3.addItem(stroke('k2again', 50, 140, 150, 160)); // where L2 was
    assignLabels(labels, 'P3', page3.lines());
    expect(labels.P3!.byKey).toEqual({ k1: 'L1', k2: 'L2', k3: 'L3', k4: 'L4', top: 'L5', k2again: 'L6' });
    assignLabels(labels, 'P3', page3.lines());
    expect(labels.P3!.nextL).toBe(7);
  });

  it('reads pages, ranges, the outline and PDFs, and resolves refs', () => {
    const { nb, page1, page3, row, pages } = setup();
    const labels: QinkLabels = {};
    page3.addItem(row('k5', 4));
    page3.addItem(row('k6', 5));
    page3.setLineText('k5', '=x3/3 lnx', 'device');
    page1.addItem(stroke('h1', 50, 100, 150, 120));
    page1.setLineText('h1', 'hello', 'agent');

    const all = encodeQinkRead(nb, pages, labels, 'p3');
    expect(all.text).toBe(
      ['#q p3 "Q3 ∫x^2 ln x dx"', ' L1 "Q3 ∫x^2 ln x dx"', ' L2 "u=ln x"', ' L3 [1] ~"v=x^3/3"', ' L4 [2]', ' L5 [3] ~"=x3/3 lnx"', ' L6 [4]'].join('\n'),
    );
    expect(all.image).toEqual({ pageId: 'P3', lineKeys: ['k3', 'k4', 'k5', 'k6'], labels: ['[1]', '[2]', '[3]', '[4]'] });

    const ref = resolveRef(labels, nb, 'p3:L6');
    expect(ref).toEqual({ pageId: 'P3', lineKey: 'k6' });
    page3.setLineText(ref.lineKey, 'x^3/3 ln x - x^3/9', 'agent');
    const range = encodeQinkRead(nb, pages, labels, 'p3:L5-6');
    expect(range.text).toBe(['#q p3 "Q3 ∫x^2 ln x dx"', ' L5 [1] ~"=x3/3 lnx"', ' L6 "x^3/3 ln x - x^3/9"'].join('\n'));
    expect(range.image).toEqual({ pageId: 'P3', lineKeys: ['k5'], labels: ['[1]'] });
    expect(encodeQinkRead(nb, pages, labels, 'p3:L2').text).toBe('#q p3 "Q3 ∫x^2 ln x dx"\n L2 "u=ln x"');

    const outline = encodeQinkRead(nb, { [nb.pages()[0]!.id]: page1, P3: page3 }, labels, 'outline');
    expect(outline.text).toBe(['#q outline "Calculus"', 'p1 "hello"', 'p2 pdf', 'p3 "Q3 ∫x^2 ln x dx"'].join('\n'));
    expect(outline.image).toBeNull();
    expect(encodeQinkRead(nb, pages, labels, 'pdf:p2')).toEqual({ text: '#q pdf:p2 "hw.pdf" page=2', image: null });

    expect(() => resolveRef(labels, nb, 'p3:L99')).toThrow();
    expect(() => resolveRef(labels, nb, 'p9:L1')).toThrow();
    expect(() => encodeQinkRead(nb, pages, labels, 'pdf:p3')).toThrow();
  });

  it('snapshots are per page and survive pages not passed in', () => {
    const { nb, page3 } = setup();
    const prev: QinkSnapshot = { gone: { x: '1' } };
    const u = encodeQinkUpdate(nb, { P3: page3 }, {}, prev, { session: 's', rev: 1 });
    expect(Object.keys(u.snapshot).sort()).toEqual(['P3', 'gone']);
  });
});
