import { describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { call, captureLink, consentSignIn, deviceNonce, signIn, startEmail, tokenOf, verifyEmail, type Tokens } from './helpers';

async function refresh(refreshToken: string): Promise<{ status: number; body: Tokens }> {
  const r = await call('/auth/refresh', { method: 'POST', body: JSON.stringify({ refreshToken }) });
  return { status: r.status, body: (await r.json()) as Tokens };
}

/** Runs a request that may send an email, keeping the console quiet. */
async function quiet(fn: () => Promise<Response>): Promise<Response> {
  const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    return await fn();
  } finally {
    spy.mockRestore();
  }
}

const unescape = (s: string) => s.replace(/&#(\d+);/g, (_, c: string) => String.fromCharCode(Number(c)));

describe('auth', () => {
  it('signs in with a magic link, refreshes with rotation', async () => {
    const t = await signIn('Ada@Example.com');
    expect(t.accessToken.split('.')).toHaveLength(3);
    expect(t.expiresIn).toBe(3600);

    // Same email, same user.
    const again = await signIn('ada@example.com');
    expect(again.userId).toBe(t.userId);

    const t2 = await refresh(t.refreshToken);
    expect(t2.status).toBe(200);
    expect(t2.body.userId).toBe(t.userId);
    expect(t2.body.refreshToken).not.toBe(t.refreshToken);
    const t3 = await refresh(t2.body.refreshToken);
    expect(t3.status).toBe(200);

    // A token two rotations old was replayed: that ends the session.
    expect((await refresh(t.refreshToken)).status).toBe(401);
    expect((await refresh(t3.body.refreshToken)).status).toBe(401);
  });

  it('accepts the previous refresh token for 60 s after rotation (two tabs), not after', async () => {
    const t = await signIn('tabs@example.com');
    const a = await refresh(t.refreshToken); // tab A
    expect(a.status).toBe(200);
    const b = await refresh(t.refreshToken); // tab B, a moment later, with the token it read before A rotated
    expect(b.status).toBe(200);
    expect(b.body.refreshToken).toBe(a.body.refreshToken);
    expect(b.body.userId).toBe(t.userId);
    expect((await call('/sync/ticket', { method: 'POST', token: b.body.accessToken, body: JSON.stringify({ docId: 'nb:tabs-1' }) })).status).toBe(200);

    // Rotate again, then replay the immediately-previous token after the window: theft, the session ends.
    const c = await refresh(a.body.refreshToken);
    expect(c.status).toBe(200);
    await env.DB.prepare('UPDATE sessions SET rotated_at = rotated_at - 61000 WHERE id = ?1').bind(t.refreshToken.split('.')[0]).run();
    expect((await refresh(a.body.refreshToken)).status).toBe(401);
    expect((await refresh(c.body.refreshToken)).status).toBe(401);
  });

  it('GET on a magic link never uses it up or returns tokens', async () => {
    const m = await startEmail('scanner@example.com');
    expect(m.link.startsWith('https://qalm.example/app/auth/email/verify?token=')).toBe(true); // MAGIC_LINK_URL: the app's route, under its base path
    // A mail scanner (or an old link that points at the server) follows it, twice.
    for (let i = 0; i < 2; i++) {
      const r = await call(`/auth/email/verify?token=${encodeURIComponent(m.token)}`);
      expect(r.status).toBe(200);
      expect(r.headers.get('Content-Type')).toContain('text/html');
      expect(r.headers.get('Cache-Control')).toBe('no-store');
      const html = await r.text();
      expect(html).toContain('scanner@example.com');
      expect(unescape(html)).toContain(`href="https://qalm.example/app/auth/email/verify?token=${encodeURIComponent(m.token)}"`);
      expect(html).not.toMatch(/accessToken|refreshToken/);
    }
    // Lookup (the app's confirmation screen) doesn't use it up either.
    const look = await call('/auth/email/lookup', { method: 'POST', body: JSON.stringify({ token: m.token }) });
    expect(await look.json()).toEqual({ email: 'scanner@example.com' });
    // The device that asked still can.
    const ok = await verifyEmail({ token: m.token, nonce: m.nonce });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { email: string }).email).toBe('scanner@example.com');
    // Single use.
    expect((await verifyEmail({ token: m.token, nonce: m.nonce })).status).toBe(400);
    expect((await call(`/auth/email/verify?token=${encodeURIComponent(m.token)}`)).status).toBe(400);
    expect((await call('/auth/email/lookup', { method: 'POST', body: JSON.stringify({ token: m.token }) })).status).toBe(400);
  });

  it('binds links to the device that asked; other devices must confirm', async () => {
    const m = await startEmail('bound@example.com');
    const other = await deviceNonce();
    expect((await verifyEmail({ token: m.token, nonce: other.nonce })).status).toBe(400); // another device's nonce
    expect((await verifyEmail({ token: m.token })).status).toBe(400); // no nonce, not confirmed
    expect((await verifyEmail({ token: m.token, nonce: other.nonce, confirm: true })).status).toBe(400); // confirm doesn't excuse a wrong nonce
    // Still unused: an explicit confirmation (the app asked "Sign in as …?") without a nonce works.
    expect((await verifyEmail({ token: m.token, confirm: true })).status).toBe(200);
    // Starting needs a nonce hash.
    expect((await call('/auth/email/start', { method: 'POST', body: JSON.stringify({ email: 'bound@example.com' }) })).status).toBe(400);
  });

  it('signs in with the 6-digit code on the device that asked', async () => {
    const m = await startEmail('code@example.com');
    expect(m.code).toMatch(/^\d{6}$/);
    const wrongNonce = await deviceNonce();
    expect((await verifyEmail({ email: 'code@example.com', code: m.code, nonce: wrongNonce.nonce })).status).toBe(400);
    expect((await verifyEmail({ email: 'code@example.com', code: m.code })).status).toBe(400);
    const r = await verifyEmail({ email: ' Code@Example.com ', code: m.code, nonce: m.nonce });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { email: string }).email).toBe('code@example.com');
    // Used up, and so is its link.
    expect((await verifyEmail({ email: 'code@example.com', code: m.code, nonce: m.nonce })).status).toBe(400);
    expect((await verifyEmail({ token: m.token, nonce: m.nonce })).status).toBe(400);

    // Five wrong guesses and the code stops working; the link still works.
    const n = await startEmail('guess@example.com');
    const wrong = n.code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) expect((await verifyEmail({ email: 'guess@example.com', code: wrong, nonce: n.nonce })).status).toBe(400);
    expect((await verifyEmail({ email: 'guess@example.com', code: n.code, nonce: n.nonce })).status).toBe(400);
    expect((await verifyEmail({ token: n.token, nonce: n.nonce })).status).toBe(200);
  });

  it('rate-limits sign-in emails per address and per IP', async () => {
    const send = (email: string, ip?: string) =>
      quiet(() => call('/auth/email/start', { method: 'POST', headers: ip ? { 'CF-Connecting-IP': ip } : {}, body: JSON.stringify({ email, nonceHash: 'a'.repeat(64) }) }));
    for (let i = 0; i < 5; i++) expect((await send('limit@example.com')).status).toBe(200);
    const r = await send('limit@example.com');
    expect(r.status).toBe(429);
    const retry = Number(r.headers.get('Retry-After'));
    expect(retry).toBeGreaterThan(3500);
    expect(retry).toBeLessThanOrEqual(3600);
    // The consent page's sign-in shares the per-address limit.
    const page = await call('/authorize/signin', { method: 'POST', body: new URLSearchParams({ email: 'limit@example.com', return: '/authorize?x=1' }) });
    expect(page.status).toBe(429);
    expect(page.headers.get('Retry-After')).toBeTruthy();
    expect(await page.text()).toContain('Too many sign-in emails');
    // An hour later it's allowed again.
    await env.DB.prepare(`UPDATE email_sends SET at = at - 3600000 WHERE key = 'email:limit@example.com'`).run();
    expect((await send('limit@example.com')).status).toBe(200);

    // 20 per IP per hour, across addresses.
    for (let i = 0; i < 20; i++) expect((await send(`ip${i}@example.com`, '203.0.113.7')).status).toBe(200);
    expect((await send('ip-last@example.com', '203.0.113.7')).status).toBe(429);
    expect((await send('ip-last@example.com', '203.0.113.8')).status).toBe(200);
  });

  it('logout ends the server session (by refresh token or access token)', async () => {
    const a = await signIn('bye@example.com');
    expect((await call('/auth/logout', { method: 'POST', body: JSON.stringify({ refreshToken: a.refreshToken }) })).status).toBe(200);
    expect((await refresh(a.refreshToken)).status).toBe(401);

    const b = await signIn('bye@example.com');
    expect((await call('/auth/logout', { method: 'POST', token: b.accessToken })).status).toBe(200);
    expect((await refresh(b.refreshToken)).status).toBe(401);

    // A session id alone can't end someone's session.
    const c = await signIn('bye2@example.com');
    await call('/auth/logout', { method: 'POST', body: JSON.stringify({ refreshToken: `${c.refreshToken.split('.')[0]}.nope` }) });
    expect((await refresh(c.refreshToken)).status).toBe(200);
  });

  it('consent sign-in: GET shows a button, the POST from our page signs in', async () => {
    const link = await captureLink(() =>
      call('/authorize/signin', { method: 'POST', body: new URLSearchParams({ email: 'consent@example.com', return: '/authorize?x=1' }) }),
    );
    expect(link.startsWith('https://qalm.test/auth/email/verify?token=')).toBe(true);
    const token = tokenOf(link);
    // A cross-site form post can't use it, nor can the app API.
    const evil = await call('/auth/email/verify', { method: 'POST', headers: { Origin: 'https://evil.example' }, body: new URLSearchParams({ token }) });
    expect(evil.status).toBe(403);
    // `Origin: null` (sandboxed or no-referrer pages) is only accepted when Fetch Metadata says same-origin.
    const opaque = await call('/auth/email/verify', { method: 'POST', headers: { Origin: 'null', 'Sec-Fetch-Site': 'cross-site' }, body: new URLSearchParams({ token }) });
    expect(opaque.status).toBe(403);
    // The page itself no longer forces `Origin: null` on its own form.
    expect((await call(`/auth/email/verify?token=${encodeURIComponent(token)}`)).headers.get('Referrer-Policy')).toBe('same-origin');
    expect((await verifyEmail({ token, confirm: true })).status).toBe(400);
    const back = await consentSignIn(link);
    expect(back.status).toBe(302);
    expect(back.headers.get('Location')).toBe('/authorize?x=1');
    expect(back.headers.get('Set-Cookie')).toContain('qalm_web=');
    // Used up: the page now says so.
    expect((await call(`/auth/email/verify?token=${encodeURIComponent(token)}`)).status).toBe(400);
  });

  it('consent sign-in works when the browser sends Origin: null from our own page', async () => {
    const link = await captureLink(() =>
      call('/authorize/signin', { method: 'POST', body: new URLSearchParams({ email: 'opaque@example.com', return: '/authorize?y=2' }) }),
    );
    const res = await call('/auth/email/verify', {
      method: 'POST',
      headers: { Origin: 'null', 'Sec-Fetch-Site': 'same-origin' },
      body: new URLSearchParams({ token: tokenOf(link) }),
      redirect: 'manual',
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/authorize?y=2');
  });

  it('rejects bad emails and missing tokens', async () => {
    expect((await call('/auth/email/start', { method: 'POST', body: JSON.stringify({ email: 'nope', nonceHash: 'a'.repeat(64) }) })).status).toBe(400);
    expect((await call('/sync/ticket', { method: 'POST', body: JSON.stringify({ docId: 'nb:x' }) })).status).toBe(401);
    expect((await call('/sync/ticket', { method: 'POST', token: 'garbage', body: JSON.stringify({ docId: 'nb:x' }) })).status).toBe(401);
  });

  it('signs in with email only: there are no Apple or Google routes', async () => {
    for (const p of ['/auth/apple', '/auth/google']) {
      expect((await call(p, { method: 'POST', body: JSON.stringify({ identityToken: 'x', idToken: 'x' }) })).status).toBe(404);
    }
  });
});
