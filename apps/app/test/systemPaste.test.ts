import { describe, expect, it } from 'vitest';

import { pastedImage, pastedText, pasteSource, viewCentre, type SystemClip } from '../src/editor/systemPaste';

const sys = (over: Partial<SystemClip> = {}): SystemClip => ({ marker: null, image: null, text: '', ...over });
const A4 = { w: 595, h: 842 };

describe('pasteSource (F16)', () => {
  it('pastes qalm items when the system clipboard holds qalm’s marker', () => {
    expect(pasteSource(sys({ marker: 'x', text: 'hello' }), 0, 100)).toBe('qalm');
  });
  it('pastes qalm items when the clip is newer than the last system change', () => {
    expect(pasteSource(sys({ text: 'old text' }), 200, 100)).toBe('qalm');
  });
  it('pastes the system content when it changed after the clip was set', () => {
    expect(pasteSource(sys({ text: 'new text' }), 100, 200)).toBe('text');
    expect(pasteSource(sys({ image: new Blob(['x'], { type: 'image/png' }), text: 'alt' }), 100, 200)).toBe('image');
  });
  it('a clip restored after a restart (time 0) loses to system content, but not to an empty clipboard', () => {
    expect(pasteSource(sys({ text: 'hi' }), 0, 0)).toBe('text');
    expect(pasteSource(sys({ text: '  \n' }), 0, 0)).toBe('qalm');
  });
  it('with no qalm clip, only system content pastes', () => {
    expect(pasteSource(sys({ text: 'hi' }), null, 0)).toBe('text');
    expect(pasteSource(sys({ marker: 'x' }), null, 0)).toBeNull();
    expect(pasteSource(sys(), null, 0)).toBeNull();
  });
});

describe('placing pasted content', () => {
  it('centres on the visible part of the page', () => {
    // Page 100px down, 842px tall at zoom 1 (px = page units); the view shows 300..700.
    expect(viewCentre({ top: 100, height: 842 }, 300, 400, A4)).toEqual({ x: 297.5, y: 400 });
    // Only the top of the page in view.
    expect(viewCentre({ top: 500, height: 1684 }, 0, 700, A4)).toEqual({ x: 297.5, y: 50 });
  });
  it('scales a large image to fit and keeps it on the page', () => {
    const it = pastedImage('a', { w: 2000, h: 1000 }, { x: 297.5, y: 30 }, A4, 'i');
    expect(it.w).toBeCloseTo(357);
    expect(it.h).toBeCloseTo(178.5);
    expect(it.y).toBe(0);
    expect(it.x).toBeCloseTo(297.5 - 178.5);
  });
  it('keeps a small image at its natural size', () => {
    const it = pastedImage('a', { w: 100, h: 50 }, { x: 300, y: 400 }, A4, 'i');
    expect([it.x, it.y, it.w, it.h]).toEqual([250, 375, 100, 50]);
  });
  it('makes a text box centred on the point', () => {
    const t = pastedText('∫ x dx\r\n', { x: 297.5, y: 400 }, A4, '#111', 't');
    expect(t.text).toBe('∫ x dx');
    expect(t.x + t.w / 2).toBeCloseTo(297.5);
    expect(t.type).toBe('text');
  });
});
