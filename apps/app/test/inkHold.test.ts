import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HOLD_CAP_MS, HOLD_IDLE_MS, HOLD_MAX_MS, InkHold } from '../src/editor/inkHold';

describe('InkHold', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const make = () => {
    const released = vi.fn();
    const hold = new InkHold<string>(released, () => Date.now());
    return { hold, released };
  };

  it('keeps the page as it was until the pen has been up for IDLE_MS', () => {
    const { hold, released } = make();
    expect(hold.pick('a')).toBe('a');
    hold.inkEnd('a');
    expect(hold.pick('a+1')).toBe('a');
    vi.advanceTimersByTime(HOLD_IDLE_MS - 1);
    expect(released).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(released).toHaveBeenCalledTimes(1);
    expect(hold.pick('a+1')).toBe('a+1');
  });

  it('does not release while a stroke is in progress', () => {
    const { hold, released } = make();
    hold.inkEnd('a');
    vi.advanceTimersByTime(100);
    hold.strokeStart();
    vi.advanceTimersByTime(HOLD_IDLE_MS * 3);
    expect(released).not.toHaveBeenCalled();
    hold.inkEnd('ignored'); // already holding: still shows 'a'
    expect(hold.pick('a+2')).toBe('a');
    vi.advanceTimersByTime(HOLD_IDLE_MS);
    expect(released).toHaveBeenCalledTimes(1);
  });

  it('releases at a stroke end once it has held MAX_MS, and always by CAP_MS', () => {
    const { hold, released } = make();
    hold.inkEnd('a');
    for (let t = 0; t < HOLD_MAX_MS; t += 200) {
      vi.advanceTimersByTime(100);
      hold.strokeStart();
      vi.advanceTimersByTime(100);
      hold.inkEnd('x');
    }
    expect(released).toHaveBeenCalledTimes(1);
    expect(hold.holding).toBe(false);

    hold.inkEnd('b');
    hold.strokeStart(); // a stroke that never ends (cancelled)
    vi.advanceTimersByTime(HOLD_CAP_MS);
    expect(released).toHaveBeenCalledTimes(2);
  });

  it('release is immediate and idempotent; dispose stays silent', () => {
    const { hold, released } = make();
    hold.release();
    expect(released).not.toHaveBeenCalled();
    hold.inkEnd('a');
    hold.release();
    hold.release();
    expect(released).toHaveBeenCalledTimes(1);
    hold.inkEnd('b');
    hold.dispose();
    vi.advanceTimersByTime(HOLD_CAP_MS);
    expect(released).toHaveBeenCalledTimes(1);
  });
});
