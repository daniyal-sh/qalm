import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { DEFAULT_SWATCHES, inkPaint, Library, MAX_SWATCHES, normalizeColor, splitAlpha, withAlpha, HIGHLIGHTER_ALPHA } from '../src';

const lib = () => new Library(new Y.Doc());

describe('colours', () => {
  it('normalises hex colours', () => {
    expect(normalizeColor('#ABC')).toBe('#aabbcc');
    expect(normalizeColor('FDE68A')).toBe('#fde68a');
    expect(normalizeColor('#fde68a80')).toBe('#fde68a80');
    expect(normalizeColor('#fde68aff')).toBe('#fde68a');
    expect(normalizeColor('red')).toBeNull();
    expect(normalizeColor('#12345')).toBeNull();
  });

  it('splits and joins alpha', () => {
    expect(splitAlpha('#fde68a80')).toEqual({ rgb: '#fde68a', alpha: 128 / 255 });
    expect(withAlpha('#fde68a', 0.5)).toBe('#fde68a80');
    expect(withAlpha('#fde68a40', 1)).toBe('#fde68a');
    expect(inkPaint('highlighter', '#fde68a')).toEqual({ rgb: '#fde68a', alpha: HIGHLIGHTER_ALPHA });
    expect(inkPaint('highlighter', '#fde68a80').alpha).toBeCloseTo(0.502, 3);
    expect(inkPaint('pen', '#27272a80')).toEqual({ rgb: '#27272a', alpha: 1 });
  });
});

describe('Library swatches', () => {
  it('starts with the brand palettes', () => {
    const l = lib();
    expect(l.swatches('pen')).toEqual(DEFAULT_SWATCHES.pen);
    expect(l.swatches('highlighter')).toEqual(DEFAULT_SWATCHES.highlighter);
    expect(l.hasCustomSwatches('pen')).toBe(false);
  });

  it('adds, dedupes, moves and removes', () => {
    const l = lib();
    expect(l.addSwatch('pen', '#FF8800')).toBe(true);
    expect(l.addSwatch('pen', '#ff8800')).toBe(false);
    expect(l.addSwatch('pen', '#ff8800cc')).toBe(false); // pens drop alpha: same colour
    expect(l.addSwatch('pen', 'nope')).toBe(false);
    expect(l.swatches('pen')).toEqual([...DEFAULT_SWATCHES.pen, '#ff8800']);
    l.moveSwatch('pen', '#ff8800', 0);
    expect(l.swatches('pen')[0]).toBe('#ff8800');
    l.moveSwatch('pen', '#ff8800', 99);
    expect(l.swatches('pen').at(-1)).toBe('#ff8800');
    l.removeSwatch('pen', '#27272a');
    expect(l.swatches('pen')).not.toContain('#27272a');
    expect(l.swatches('highlighter')).toEqual(DEFAULT_SWATCHES.highlighter); // lists are separate
    l.resetSwatches('pen');
    expect(l.swatches('pen')).toEqual(DEFAULT_SWATCHES.pen);
  });

  it('keeps highlighter alpha, so the same hue at two opacities is two swatches', () => {
    const l = lib();
    expect(l.addSwatch('highlighter', '#fde68a80')).toBe(true);
    expect(l.swatches('highlighter')).toEqual([...DEFAULT_SWATCHES.highlighter, '#fde68a80']);
  });

  it(`caps each list at ${MAX_SWATCHES}`, () => {
    const l = lib();
    l.setSwatches('pen', []);
    for (let i = 0; i < 30; i++) l.addSwatch('pen', `#0000${i.toString(16).padStart(2, '0')}`);
    expect(l.swatches('pen')).toHaveLength(MAX_SWATCHES);
    expect(l.addSwatch('pen', '#ffffff')).toBe(false);
  });

  it('an emptied list stays empty (not the defaults)', () => {
    const l = lib();
    for (const c of DEFAULT_SWATCHES.highlighter) l.removeSwatch('highlighter', c);
    expect(l.swatches('highlighter')).toEqual([]);
  });

  it('syncs between docs and dedupes concurrent edits', () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    const la = new Library(a);
    const lb = new Library(b);
    la.addSwatch('pen', '#111111');
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    expect(lb.swatches('pen')).toContain('#111111');
    la.addSwatch('pen', '#222222');
    lb.addSwatch('pen', '#333333');
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    const sa = la.swatches('pen');
    expect(sa).toEqual(lb.swatches('pen'));
    expect(new Set(sa).size).toBe(sa.length);
    expect(sa).toEqual(expect.arrayContaining(['#111111', '#222222', '#333333']));
  });

  it('merges custom swatches from another library', () => {
    const account = lib();
    const local = lib();
    local.addSwatch('pen', '#123456');
    account.mergeSwatchesFrom(local);
    expect(account.swatches('pen')).toEqual(local.swatches('pen'));
    expect(account.hasCustomSwatches('highlighter')).toBe(false); // untouched lists stay default
    account.addSwatch('pen', '#abcdef');
    local.addSwatch('pen', '#654321');
    account.mergeSwatchesFrom(local);
    expect(account.swatches('pen').slice(-3)).toEqual(['#123456', '#abcdef', '#654321']);
  });
});
