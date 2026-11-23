import { SELF } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
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

  it('verifies Google id tokens against the JWKS (network mocked)', async () => {
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
    const realFetch = globalThis.fetch;
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.startsWith('https://www.googleapis.com/oauth2/v3/certs')) return Response.json({ keys: [jwk] });
      return realFetch(input, init);
    });
    const idToken = (aud: string, sub = 'g-123', email = 'grace@example.com') =>
      new SignJWT({ email, email_verified: true })
        .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
        .setIssuer('https://accounts.google.com')
        .setAudience(aud)
        .setSubject(sub)
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(privateKey);
    try {
      // An email account that signs in with Google later is the same user.
      const byEmail = await signIn('grace@example.com');
      const r = await call('/auth/google', { method: 'POST', body: JSON.stringify({ idToken: await idToken('qalm-test.apps.googleusercontent.com') }) });
      expect(r.status).toBe(200);
      const t = (await r.json()) as { userId: string; accessToken: string };
      expect(t.userId).toBe(byEmail.userId);
      // Wrong audience.
      const bad = await call('/auth/google', { method: 'POST', body: JSON.stringify({ idToken: await idToken('someone-else') }) });
      expect(bad.status).toBe(401);
      // Garbage.
      expect((await call('/auth/google', { method: 'POST', body: JSON.stringify({ idToken: 'a.b.c' }) })).status).toBe(401);
    } finally {
      spy.mockRestore();
    }
  });
});
