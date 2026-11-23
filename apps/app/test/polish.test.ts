import { describe, expect, it } from 'vitest';

import { confirm, pendingConfirm, settleConfirm, subscribeConfirm } from '../src/ui/confirm';
import { rejectedTouchText } from '../src/lib/palm';
import { toolbarOverflow } from '../src/editor/toolbar.logic';

describe('confirm', () => {
  it('opens a request, runs the action on yes and closes', () => {
    const seen: (string | null)[] = [];
    const off = subscribeConfirm((r) => seen.push(r?.action ?? null));
    let ran = 0;
    confirm('Delete page 2?', 'Its ink goes with it.', 'Delete', () => ran++);
    expect(pendingConfirm()?.title).toBe('Delete page 2?');
    settleConfirm(true);
    expect(ran).toBe(1);
    expect(pendingConfirm()).toBeNull();
    expect(seen).toEqual(['Delete', null]);
    off();
  });

  it('cancel does nothing; a newer request replaces an open one', () => {
    let a = 0;
    let b = 0;
    confirm('A?', '', 'Delete', () => a++);
    confirm('B?', '', 'Sign out', () => b++);
    expect(pendingConfirm()?.action).toBe('Sign out');
    settleConfirm(false);
    settleConfirm(true); // nothing open: no-op
    expect([a, b]).toEqual([0, 0]);
  });
});

describe('rejectedTouchText', () => {
  it('uses plain words, never the raw code', () => {
    for (const code of ['pen-only', 'palm-size', 'pen-lockout', 'hand-side', 'pen-active', 'pen-took-over', 'multi-touch', 'cancelled', 'something-new']) {
      const t = rejectedTouchText(code);
      expect(t).toMatch(/^Ignored/);
      expect(t).not.toContain(code);
    }
  });
});

describe('toolbarOverflow', () => {
  it('shows chevrons only at clipped edges', () => {
    expect(toolbarOverflow(0, 800, 700)).toEqual({ left: false, right: false });
    expect(toolbarOverflow(0, 400, 900)).toEqual({ left: false, right: true });
    expect(toolbarOverflow(200, 400, 900)).toEqual({ left: true, right: true });
    expect(toolbarOverflow(500, 400, 900)).toEqual({ left: true, right: false });
  });
});
