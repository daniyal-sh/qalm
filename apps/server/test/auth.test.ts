import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { call, captureLink, signIn } from './helpers';

describe('auth', () => {
  it('signs in with a magic link, refreshes with rotation', async () => {
    const t = await signIn('Ada@Example.com');
    expect(t.accessToken.split('.')).toHaveLength(3);
    expect(t.expiresIn).toBe(3600);

    // Same email, same user.
    const again = await signIn('ada@example.com');
    expect(again.userId).toBe(t.userId);

    const r = await call('/auth/refresh', { method: 'POST', body: JSON.stringify({ refreshToken: t.refreshToken }) });
    expect(r.status).toBe(200);
    const t2 = (await r.json()) as typeof t;
    expect(t2.userId).toBe(t.userId);
    expect(t2.refreshToken).not.toBe(t.refreshToken);

    // The old refresh token is dead, and replaying it ends the session.
    expect((await call('/auth/refresh', { method: 'POST', body: JSON.stringify({ refreshToken: t.refreshToken }) })).status).toBe(401);
    expect((await call('/auth/refresh', { method: 'POST', body: JSON.stringify({ refreshToken: t2.refreshToken }) })).status).toBe(401);
  });

  it('magic links work once', async () => {
    const link = await captureLink(() => call('/auth/email/start', { method: 'POST', body: JSON.stringify({ email: 'once@example.com' }) }));
    expect((await SELF.fetch(link)).status).toBe(200);
    expect((await SELF.fetch(link)).status).toBe(400);
  });

  it('rejects bad emails and missing tokens', async () => {
    expect((await call('/auth/email/start', { method: 'POST', body: JSON.stringify({ email: 'nope' }) })).status).toBe(400);
    expect((await call('/sync/ticket', { method: 'POST', body: JSON.stringify({ docId: 'nb:x' }) })).status).toBe(401);
    expect((await call('/sync/ticket', { method: 'POST', token: 'garbage', body: JSON.stringify({ docId: 'nb:x' }) })).status).toBe(401);
    // Not configured in tests.
    expect((await call('/auth/apple', { method: 'POST', body: JSON.stringify({ identityToken: 'x' }) })).status).toBe(501);
  });
});
