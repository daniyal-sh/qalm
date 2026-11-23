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

/** GET /auth/email/verify?token= (JSON) → tokens. The link is single-use. */
export async function verifyMagicLink(fetchFn: FetchFn, serverUrl: string, token: string): Promise<Tokens> {
  const res = await fetchFn(`${serverUrl}/auth/email/verify?token=${encodeURIComponent(token)}`, {
    headers: { accept: 'application/json' },
  });
  if (!res.ok) {
    let msg = 'This sign-in link is invalid or has expired';
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) msg = body.error;
    } catch {
      /* not JSON */
    }
    throw new Error(msg);
  }
  const t = (await res.json()) as Partial<Tokens>;
  if (!t.accessToken || !t.refreshToken) throw new Error('Sign-in returned no tokens');
  return { accessToken: t.accessToken, refreshToken: t.refreshToken };
}

/** POST /auth/email/start {email}. */
export async function startMagicLink(fetchFn: FetchFn, serverUrl: string, email: string): Promise<void> {
  const res = await fetchFn(`${serverUrl}/auth/email/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: email.trim() }),
  });
  if (!res.ok) {
    let msg = `Couldn't send the link (${res.status})`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) msg = body.error;
    } catch {
      /* not JSON */
    }
    throw new Error(msg);
  }
}

export const isEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
