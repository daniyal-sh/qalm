import { SignJWT, jwtVerify, createRemoteJWKSet, type JWTPayload } from 'jose';
import type { Env } from './env';
import { HttpError, json, now, origin, parseCookies, randomToken, readJson, sha256Hex } from './util';
import { magicLinkEmail, sendEmail } from './email';

const ACCESS_TTL_S = 3600;
const REFRESH_TTL_MS = 60 * 24 * 3600 * 1000;
const MAGIC_TTL_MS = 15 * 60 * 1000;
const WEB_COOKIE = 'qalm_web';
const WEB_TTL_S = 3600;
const ISSUER = 'qalm';

const key = (env: Env) => {
  if (!env.JWT_SECRET || env.JWT_SECRET.length < 32) throw new Error('JWT_SECRET must be set (32+ characters)');
  return new TextEncoder().encode(env.JWT_SECRET);
};

async function sign(env: Env, sub: string, aud: string, ttl: number, extra: JWTPayload = {}): Promise<string> {
  return new SignJWT(extra)
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(sub)
    .setIssuer(ISSUER)
    .setAudience(aud)
    .setIssuedAt()
    .setExpirationTime(Math.floor(now() / 1000) + ttl)
    .sign(key(env));
}

async function verify(env: Env, token: string, aud: string): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, key(env), { issuer: ISSUER, audience: aud, algorithms: ['HS256'] });
    return payload.sub ?? null;
  } catch {
    return null;
  }
}

/** The signed-in app user (`Authorization: Bearer <accessToken>`), or a 401. */
export async function requireUser(req: Request, env: Env): Promise<string> {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.get('Authorization') ?? '');
  const userId = m ? await verify(env, m[1]!, 'app') : null;
  if (!userId) throw new HttpError(401, 'Unauthorized');
  return userId;
}

export interface Tokens { accessToken: string; refreshToken: string; expiresIn: number; userId: string }

async function issueTokens(env: Env, userId: string, sessionId: string = crypto.randomUUID()): Promise<Tokens> {
  const refreshToken = `${sessionId}.${randomToken()}`;
  const hash = await sha256Hex(refreshToken);
  const t = now();
  await env.DB.prepare(
    `INSERT INTO sessions (id, user_id, refresh_hash, expires_at, created_at) VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT(id) DO UPDATE SET refresh_hash = excluded.refresh_hash, expires_at = excluded.expires_at`,
  )
    .bind(sessionId, userId, hash, t + REFRESH_TTL_MS, t)
    .run();
  return { accessToken: await sign(env, userId, 'app', ACCESS_TTL_S), refreshToken, expiresIn: ACCESS_TTL_S, userId };
}

const normEmail = (e: string) => e.trim().toLowerCase();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function userByEmail(env: Env, email: string, name?: string): Promise<string> {
  const row = await env.DB.prepare('SELECT id FROM users WHERE email = ?1').bind(email).first<{ id: string }>();
  if (row) return row.id;
  const id = crypto.randomUUID();
  await env.DB.prepare('INSERT INTO users (id, email, name, created_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(email) DO NOTHING')
    .bind(id, email, name ?? null, now())
    .run();
  const again = await env.DB.prepare('SELECT id FROM users WHERE email = ?1').bind(email).first<{ id: string }>();
  return again!.id;
}

// ---- email magic link ----

/** Sends a sign-in link. `returnTo` (a path on this origin) is used by the MCP consent page. */
export async function startMagicLink(env: Env, req: Request, email: string, returnTo?: string): Promise<void> {
  const e = normEmail(email);
  if (!EMAIL_RE.test(e)) throw new HttpError(400, 'Invalid email');
  if (returnTo !== undefined && !(returnTo.startsWith('/') && !returnTo.startsWith('//'))) throw new HttpError(400, 'Invalid returnTo');
  const token = randomToken();
  await env.DB.prepare('INSERT INTO magic_links (token_hash, email, return_to, expires_at) VALUES (?1, ?2, ?3, ?4)')
    .bind(await sha256Hex(token), e, returnTo ?? null, now() + MAGIC_TTL_MS)
    .run();
  const base = returnTo || !env.MAGIC_LINK_URL ? `${origin(req, env.PUBLIC_URL)}/auth/email/verify` : env.MAGIC_LINK_URL;
  const link = `${base}${base.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
  await sendEmail(env, magicLinkEmail(e, link));
}

async function consumeMagicLink(env: Env, token: string): Promise<{ email: string; returnTo: string | null } | null> {
  const row = await env.DB.prepare(
    `UPDATE magic_links SET used_at = ?2 WHERE token_hash = ?1 AND used_at IS NULL AND expires_at > ?2 RETURNING email, return_to`,
  )
    .bind(await sha256Hex(token), now())
    .first<{ email: string; return_to: string | null }>();
  return row ? { email: row.email, returnTo: row.return_to } : null;
}

// ---- web session (consent page only) ----

export async function webUser(req: Request, env: Env): Promise<string | null> {
  const t = parseCookies(req)[WEB_COOKIE];
  return t ? verify(env, t, 'web') : null;
}

async function webCookie(env: Env, userId: string): Promise<string> {
  return `${WEB_COOKIE}=${await sign(env, userId, 'web', WEB_TTL_S)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${WEB_TTL_S}`;
}

// ---- Apple / Google identity tokens ----

const jwks = {
  apple: createRemoteJWKSet(new URL('https://appleid.apple.com/auth/keys')),
  google: createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs')),
};

async function verifyIdentity(env: Env, provider: 'apple' | 'google', idToken: string): Promise<{ sub: string; email?: string; emailVerified: boolean }> {
  const auds = (provider === 'apple' ? env.APPLE_AUDIENCES : env.GOOGLE_AUDIENCES)?.split(',').map((s) => s.trim()).filter(Boolean) ?? [];
  if (!auds.length) throw new HttpError(501, `${provider} sign-in is not configured`);
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(idToken, jwks[provider], {
      issuer: provider === 'apple' ? 'https://appleid.apple.com' : ['https://accounts.google.com', 'accounts.google.com'],
      audience: auds,
    }));
  } catch {
    throw new HttpError(401, 'Invalid identity token');
  }
  const ev = payload.email_verified;
  return {
    sub: payload.sub!,
    email: typeof payload.email === 'string' ? normEmail(payload.email) : undefined,
    emailVerified: ev === true || ev === 'true',
  };
}

async function userByIdentity(env: Env, provider: 'apple' | 'google', id: { sub: string; email?: string; emailVerified: boolean }, name?: string): Promise<string> {
  const col = provider === 'apple' ? 'apple_sub' : 'google_sub';
  const row = await env.DB.prepare(`SELECT id FROM users WHERE ${col} = ?1`).bind(id.sub).first<{ id: string }>();
  if (row) return row.id;
  if (id.email && id.emailVerified) {
    const userId = await userByEmail(env, id.email, name);
    await env.DB.prepare(`UPDATE users SET ${col} = ?2 WHERE id = ?1 AND ${col} IS NULL`).bind(userId, id.sub).run();
    return userId;
  }
  const userId = crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO users (id, ${col}, name, created_at) VALUES (?1, ?2, ?3, ?4)`).bind(userId, id.sub, name ?? null, now()).run();
  return userId;
}

// ---- routes ----

export async function handleAuth(req: Request, env: Env, path: string): Promise<Response | null> {
  if (path === '/auth/email/start' && req.method === 'POST') {
    const body = await readJson<{ email?: string }>(req);
    await startMagicLink(env, req, body.email ?? '');
    return json({ ok: true });
  }
  if (path === '/auth/email/verify' && req.method === 'GET') {
    const token = new URL(req.url).searchParams.get('token') ?? '';
    const link = token ? await consumeMagicLink(env, token) : null;
    if (!link) throw new HttpError(400, 'This sign-in link is invalid or has expired');
    const userId = await userByEmail(env, link.email);
    if (link.returnTo) {
      return new Response(null, { status: 302, headers: { Location: link.returnTo, 'Set-Cookie': await webCookie(env, userId), 'Cache-Control': 'no-store' } });
    }
    return json(await issueTokens(env, userId), 200, { 'Cache-Control': 'no-store' });
  }
  if ((path === '/auth/apple' || path === '/auth/google') && req.method === 'POST') {
    const provider = path === '/auth/apple' ? 'apple' : 'google';
    const body = await readJson<{ identityToken?: string; idToken?: string; name?: string }>(req);
    const token = body.identityToken ?? body.idToken;
    if (!token) throw new HttpError(400, 'identityToken is required');
    const id = await verifyIdentity(env, provider, token);
    return json(await issueTokens(env, await userByIdentity(env, provider, id, body.name)));
  }
  if (path === '/auth/refresh' && req.method === 'POST') {
    const body = await readJson<{ refreshToken?: string }>(req);
    const rt = body.refreshToken ?? '';
    const sessionId = rt.split('.')[0] ?? '';
    const row = await env.DB.prepare('SELECT user_id, refresh_hash, expires_at FROM sessions WHERE id = ?1')
      .bind(sessionId)
      .first<{ user_id: string; refresh_hash: string; expires_at: number }>();
    if (!row || row.expires_at < now() || row.refresh_hash !== (await sha256Hex(rt))) {
      // A stale token for a live session means it leaked or was replayed: end the session.
      if (row && row.refresh_hash !== (await sha256Hex(rt))) await env.DB.prepare('DELETE FROM sessions WHERE id = ?1').bind(sessionId).run();
      throw new HttpError(401, 'Invalid refresh token');
    }
    return json(await issueTokens(env, row.user_id, sessionId));
  }
  return null;
}
