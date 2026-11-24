/** Pure helpers for the email sign-in screen (app/sign-in.tsx). */
import { extractCode, extractMagicToken } from './magicLink';

/** Seconds before "Resend" works again (the server also allows 5 emails per address per hour). */
export const RESEND_COOLDOWN_S = 30;

export type CodeInput = { kind: 'code'; code: string } | { kind: 'link'; token: string } | { kind: 'partial'; digits: string };

/**
 * What the user typed or pasted into the code box: the 6-digit code (spaces and dashes allowed), the whole link from
 * the email, or digits still being typed (at most 6 are kept).
 */
export function readCodeInput(input: string): CodeInput {
  const s = input.trim();
  if (/token=/.test(s) || /^[a-z]+:\/\//i.test(s)) {
    const token = extractMagicToken(s);
    if (token) return { kind: 'link', token };
  }
  const code = extractCode(s);
  if (code) return { kind: 'code', code };
  return { kind: 'partial', digits: s.replace(/\D/g, '').slice(0, 6) };
}

/** The resend button's label: "Resend code" or "Resend in 0:24". */
export function resendLabel(secondsLeft: number): string {
  if (secondsLeft <= 0) return 'Resend code';
  const s = Math.ceil(secondsLeft);
  return `Resend in ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Seconds of cooldown left at `now`, given when the last email was sent. */
export const cooldownLeft = (sentAt: number | null, now: number, cooldownS = RESEND_COOLDOWN_S) =>
  sentAt === null ? 0 : Math.max(0, Math.ceil((sentAt + cooldownS * 1000 - now) / 1000));
