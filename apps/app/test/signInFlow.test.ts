import { describe, expect, it } from 'vitest';

import { cooldownLeft, readCodeInput, resendLabel, RESEND_COOLDOWN_S } from '../src/auth/signInFlow';

describe('email sign-in screen', () => {
  it('reads the code box: digits being typed, a full code, or a pasted link', () => {
    expect(readCodeInput('12')).toEqual({ kind: 'partial', digits: '12' });
    expect(readCodeInput('12a3')).toEqual({ kind: 'partial', digits: '123' });
    expect(readCodeInput('1234567')).toEqual({ kind: 'partial', digits: '123456' });
    expect(readCodeInput('123456')).toEqual({ kind: 'code', code: '123456' });
    expect(readCodeInput(' 123 456 ')).toEqual({ kind: 'code', code: '123456' });
    expect(readCodeInput('123-456')).toEqual({ kind: 'code', code: '123456' });
    expect(readCodeInput('https://qalm.apollolearn.app/app/auth/email/verify?token=abcDEF_123-xyz')).toEqual({ kind: 'link', token: 'abcDEF_123-xyz' });
    expect(readCodeInput('qalm://auth/email/verify?token=t0k3n')).toEqual({ kind: 'link', token: 't0k3n' });
    expect(readCodeInput('')).toEqual({ kind: 'partial', digits: '' });
  });

  it('counts the resend cooldown down', () => {
    expect(RESEND_COOLDOWN_S).toBe(30);
    expect(cooldownLeft(null, 1000)).toBe(0);
    expect(cooldownLeft(0, 0)).toBe(30);
    expect(cooldownLeft(0, 6_500)).toBe(24);
    expect(cooldownLeft(0, 30_000)).toBe(0);
    expect(resendLabel(24)).toBe('Resend in 0:24');
    expect(resendLabel(5)).toBe('Resend in 0:05');
    expect(resendLabel(0)).toBe('Resend code');
  });
});
