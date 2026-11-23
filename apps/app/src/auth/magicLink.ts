import type { Tokens } from './tokens';

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * The token from a magic link the user pasted or opened: a full URL (`…/auth/email/verify?token=…`,
 * `qalm://auth/email/verify?token=…`) or the bare token.
 */
export function extractMagicToken(input: string): string | null {
  const s = input.trim();
  if (!s) return null;
  const m = /[?&#]token=([^&#\s]+)/.exec(s);
  if (m) {
    try {
      return decodeURIComponent(m[1]!);
    } catch {
      return m[1]!;
    }
  }
  if (/^[A-Za-z0-9_\-.~%]{16,}$/.test(s)) return s;
  return null;
}

/** A 6-digit sign-in code typed by the user (spaces and dashes allowed), or null. */
export function extractCode(input: string): string | null {
  const s = input.trim();
  return /^\d{3}[\s-]?\d{3}$/.test(s) ? s.replace(/\D/g, '') : null;
}

async function postJson(fetchFn: FetchFn, url: string, body: unknown, fallback: string): Promise<unknown> {
  const res = await fetchFn(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) {
    let msg = res.status === 429 ? 'Too many sign-in emails. Try again later.' : fallback;
    try {
      const b = (await res.json()) as { error?: string };
      if (b.error) msg = b.error;
    } catch {
      /* not JSON */
    }
    throw new Error(msg);
  }
  return res.json();
}

export interface EmailTokens extends Tokens {
  email: string;
}

function asTokens(t: Partial<EmailTokens>): EmailTokens {
  if (!t.accessToken || !t.refreshToken) throw new Error('Sign-in returned no tokens');
  return { accessToken: t.accessToken, refreshToken: t.refreshToken, email: t.email ?? '' };
}

/** POST /auth/email/start {email, nonceHash}. */
export async function startMagicLink(fetchFn: FetchFn, serverUrl: string, email: string, nonceHash: string): Promise<void> {
  await postJson(fetchFn, `${serverUrl}/auth/email/start`, { email: email.trim(), nonceHash }, "Couldn't send the link");
}

/** POST /auth/email/lookup {token} → the account the link signs in to. Doesn't use the link up. */
export async function lookupMagicLink(fetchFn: FetchFn, serverUrl: string, token: string): Promise<string> {
  const r = (await postJson(fetchFn, `${serverUrl}/auth/email/lookup`, { token }, 'This sign-in link is invalid or has expired')) as { email?: string };
  if (!r.email) throw new Error('This sign-in link is invalid or has expired');
  return r.email;
}

/**
 * POST /auth/email/verify → tokens; uses the link up. Pass this device's `nonce` when it asked for the link,
 * otherwise `confirm: true` after the user confirmed the account.
 */
export async function verifyMagicLink(fetchFn: FetchFn, serverUrl: string, token: string, opts: { nonce?: string | null; confirm?: boolean } = {}): Promise<EmailTokens> {
  const body = opts.nonce ? { token, nonce: opts.nonce } : { token, confirm: !!opts.confirm };
  return asTokens((await postJson(fetchFn, `${serverUrl}/auth/email/verify`, body, 'This sign-in link is invalid or has expired')) as Partial<EmailTokens>);
}

/** POST /auth/email/verify {email, code, nonce}: the 6-digit code from the email, on the device that asked. */
export async function verifyCode(fetchFn: FetchFn, serverUrl: string, email: string, code: string, nonce: string): Promise<EmailTokens> {
  return asTokens((await postJson(fetchFn, `${serverUrl}/auth/email/verify`, { email: email.trim(), code, nonce }, 'That code is wrong or has expired')) as Partial<EmailTokens>);
}

export const isEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
