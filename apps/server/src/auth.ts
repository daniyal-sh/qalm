import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import type { Env } from './env';
import { b64url, enc, HttpError, json, now, origin, parseCookies, randomToken, readJson, sha256Hex } from './util';
import { magicLinkEmail, sendEmail } from './email';
import { magicLinkPage } from './consent';

const ACCESS_TTL_S = 3600;
const REFRESH_TTL_MS = 60 * 24 * 3600 * 1000;
/** How long the immediately-previous refresh token keeps working after rotation (two tabs refreshing at once). */
const REFRESH_GRACE_MS = 60_000;
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

async function verifyClaims(env: Env, token: string, aud: string): Promise<JWTPayload | null> {
  try {
    const { payload } = await jwtVerify(token, key(env), { issuer: ISSUER, audience: aud, algorithms: ['HS256'] });
    return payload;
  } catch {
    return null;
  }
}

async function verify(env: Env, token: string, aud: string): Promise<string | null> {
  return (await verifyClaims(env, token, aud))?.sub ?? null;
}

/** The signed-in app user (`Authorization: Bearer <accessToken>`), or a 401. */
export async function requireUser(req: Request, env: Env): Promise<string> {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.get('Authorization') ?? '');
  const userId = m ? await verify(env, m[1]!, 'app') : null;
  if (!userId) throw new HttpError(401, 'Unauthorized');
  return userId;
}

export interface Tokens { accessToken: string; refreshToken: string; expiresIn: number; userId: string }

async function tokensFor(env: Env, userId: string, sessionId: string, refreshToken: string): Promise<Tokens> {
  return { accessToken: await sign(env, userId, 'app', ACCESS_TTL_S, { sid: sessionId }), refreshToken, expiresIn: ACCESS_TTL_S, userId };
}

async function issueTokens(env: Env, userId: string): Promise<Tokens> {
  const sessionId = crypto.randomUUID();
  const refreshToken = `${sessionId}.${randomToken()}`;
  const t = now();
  await env.DB.prepare('INSERT INTO sessions (id, user_id, refresh_hash, expires_at, created_at) VALUES (?1, ?2, ?3, ?4, ?5)')
    .bind(sessionId, userId, await sha256Hex(refreshToken), t + REFRESH_TTL_MS, t)
    .run();
  return tokensFor(env, userId, sessionId, refreshToken);
}

/**
 * The refresh token that replaces `rt`: HMAC(JWT_SECRET, rt). Deterministic, so a replay of the immediately-previous
 * token inside the grace window is answered with the current pair without storing any refresh token in the clear.
 */
async function nextRefreshToken(env: Env, sessionId: string, rt: string): Promise<string> {
  const k = await crypto.subtle.importKey('raw', key(env), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return `${sessionId}.${b64url(new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(`refresh:${rt}`))))}`;
}

interface SessionRow { user_id: string; refresh_hash: string; prev_hash: string | null; rotated_at: number | null; expires_at: number }

async function refresh(env: Env, rt: string): Promise<Tokens> {
  const sessionId = rt.split('.')[0] ?? '';
  const read = () =>
    env.DB.prepare('SELECT user_id, refresh_hash, prev_hash, rotated_at, expires_at FROM sessions WHERE id = ?1').bind(sessionId).first<SessionRow>();
  let row = await read();
  if (!row || row.expires_at < now()) throw new HttpError(401, 'Invalid refresh token');
  const h = await sha256Hex(rt);
  const next = await nextRefreshToken(env, sessionId, rt);
  const nextHash = await sha256Hex(next);
  if (row.refresh_hash === h) {
    const t = now();
    const r = await env.DB.prepare(
      'UPDATE sessions SET refresh_hash = ?3, prev_hash = ?2, rotated_at = ?4, expires_at = ?5 WHERE id = ?1 AND refresh_hash = ?2',
    )
      .bind(sessionId, h, nextHash, t, t + REFRESH_TTL_MS)
      .run();
    if (r.meta.changes) return tokensFor(env, row.user_id, sessionId, next);
    // Lost a race with a concurrent refresh of the same token, which rotated to the same `next`.
    row = await read();
    if (!row) throw new HttpError(401, 'Invalid refresh token');
  }
  // The immediately-previous token shortly after rotation (another tab refreshed first): answer with the current pair.
  if (row.prev_hash === h && row.refresh_hash === nextHash && row.rotated_at !== null && now() - row.rotated_at < REFRESH_GRACE_MS) {
    return tokensFor(env, row.user_id, sessionId, next);
  }
  // Any other stale token for a live session means it leaked or was replayed: end the session.
  await env.DB.prepare('DELETE FROM sessions WHERE id = ?1').bind(sessionId).run();
  throw new HttpError(401, 'Invalid refresh token');
}

/** POST /auth/logout: ends the session named by the refresh token in the body and/or by the Bearer access token. */
async function logout(req: Request, env: Env): Promise<void> {
  let rt = '';
  try {
    const body = (await req.json()) as { refreshToken?: unknown };
    if (typeof body?.refreshToken === 'string') rt = body.refreshToken;
  } catch {
    /* no body */
  }
  if (rt) {
    await env.DB.prepare('DELETE FROM sessions WHERE id = ?1 AND (refresh_hash = ?2 OR prev_hash = ?2)')
      .bind(rt.split('.')[0] ?? '', await sha256Hex(rt))
      .run();
  }
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.get('Authorization') ?? '');
  const claims = m ? await verifyClaims(env, m[1]!, 'app') : null;
  if (claims?.sub && typeof claims.sid === 'string') {
    await env.DB.prepare('DELETE FROM sessions WHERE id = ?1 AND user_id = ?2').bind(claims.sid, claims.sub).run();
  }
}

const normEmail = (e: string) => e.trim().toLowerCase();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const HEX64 = /^[0-9a-f]{64}$/;

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

// ---- rate limits on sign-in email ----

export class TooManyRequests extends HttpError {
  constructor(readonly retryAfterS: number) {
    super(429, 'Too many sign-in emails. Try again later.');
  }
}

const HOUR_MS = 3600_000;
const PER_EMAIL_PER_HOUR = 5;
const PER_IP_PER_HOUR = 20;

/**
 * At most 5 emails per address and 20 per client IP (CF-Connecting-IP) per rolling hour; records the send.
 * Without CF-Connecting-IP (local dev, tests) only the per-address limit applies.
 */
async function limitEmails(env: Env, req: Request, email: string): Promise<void> {
  const t = now();
  const ip = req.headers.get('CF-Connecting-IP');
  const keys: [string, number][] = [[`email:${email}`, PER_EMAIL_PER_HOUR]];
  if (ip) keys.push([`ip:${ip}`, PER_IP_PER_HOUR]);
  for (const [k, max] of keys) {
    const r = await env.DB.prepare('SELECT COUNT(*) AS n, MIN(at) AS first FROM email_sends WHERE key = ?1 AND at > ?2')
      .bind(k, t - HOUR_MS)
      .first<{ n: number; first: number | null }>();
    if (r && r.n >= max) throw new TooManyRequests(Math.max(1, Math.ceil(((r.first ?? t) + HOUR_MS - t) / 1000)));
  }
  await env.DB.batch([
    ...keys.map(([k]) => env.DB.prepare('INSERT INTO email_sends (key, at) VALUES (?1, ?2)').bind(k, t)),
    env.DB.prepare('DELETE FROM email_sends WHERE at <= ?1').bind(t - HOUR_MS),
  ]);
}

// ---- email magic link ----

function sixDigits(): string {
  const a = new Uint32Array(1);
  do crypto.getRandomValues(a);
  while (a[0]! >= 4_294_000_000); // unbiased mod 1e6
  return String(a[0]! % 1_000_000).padStart(6, '0');
}

const codeHash = (email: string, code: string) => sha256Hex(`code:${email}:${code}`);

/** The app sign-in link in the email: the app's verify route (MAGIC_LINK_URL), which POSTs the token back. */
export function appLink(env: Env, token: string): string {
  const base = env.MAGIC_LINK_URL || 'qalm://auth/email/verify';
  return `${base}${base.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
}

/**
 * Sends a sign-in email.
 * - App sign-in: `nonceHash` (sha256 hex of a nonce only the asking device knows) is required. The email has an app link and a 6-digit code.
 * - MCP consent page: `returnTo` (a path on this origin). The link opens this server's page, whose button POSTs the token.
 */
export async function startMagicLink(env: Env, req: Request, email: string, opts: { returnTo?: string; nonceHash?: string } = {}): Promise<void> {
  const e = normEmail(email);
  const { returnTo, nonceHash } = opts;
  const forApp = returnTo === undefined;
  if (!EMAIL_RE.test(e)) throw new HttpError(400, 'Invalid email');
  if (!forApp && !(returnTo.startsWith('/') && !returnTo.startsWith('//'))) throw new HttpError(400, 'Invalid returnTo');
  if (forApp && !(typeof nonceHash === 'string' && HEX64.test(nonceHash))) throw new HttpError(400, 'nonceHash is required');
  await limitEmails(env, req, e);
  const token = randomToken();
  const code = forApp ? sixDigits() : null;
  await env.DB.prepare('INSERT INTO magic_links (token_hash, email, return_to, expires_at, nonce_hash, code_hash) VALUES (?1, ?2, ?3, ?4, ?5, ?6)')
    .bind(await sha256Hex(token), e, returnTo ?? null, now() + MAGIC_TTL_MS, forApp ? nonceHash : null, code ? await codeHash(e, code) : null)
    .run();
  const link = forApp ? appLink(env, token) : `${origin(req, env.PUBLIC_URL)}/auth/email/verify?token=${encodeURIComponent(token)}`;
  await sendEmail(env, magicLinkEmail(e, link, code));
}

interface LinkRow { email: string; return_to: string | null }

/** A live (unused, unexpired) link, without consuming it. */
async function peekMagicLink(env: Env, token: string): Promise<LinkRow | null> {
  if (!token) return null;
  return env.DB.prepare('SELECT email, return_to FROM magic_links WHERE token_hash = ?1 AND used_at IS NULL AND expires_at > ?2')
    .bind(await sha256Hex(token), now())
    .first<LinkRow>();
}

/**
 * Consumes an app sign-in link. It must carry the nonce of the device that asked, or `confirm` (no nonce: the user
 * confirmed on a screen that names the account, because this device has no matching request).
 */
async function consumeAppLink(env: Env, token: string, nonce: string | undefined, confirm: boolean): Promise<string | null> {
  const row = await env.DB.prepare(
    `UPDATE magic_links SET used_at = ?2 WHERE token_hash = ?1 AND used_at IS NULL AND expires_at > ?2 AND return_to IS NULL
       AND (nonce_hash = ?3 OR ?4 = 1) RETURNING email`,
  )
    .bind(await sha256Hex(token), now(), nonce ? await sha256Hex(nonce) : '', !nonce && confirm ? 1 : 0)
    .first<{ email: string }>();
  return row?.email ?? null;
}

const MAX_CODE_ATTEMPTS = 5;

/** The 6-digit code typed on the device that asked (its nonce is required). */
async function consumeCode(env: Env, email: string, code: string, nonce: string): Promise<string | null> {
  const t = now();
  const row = await env.DB.prepare(
    `UPDATE magic_links SET used_at = ?3 WHERE token_hash = (
       SELECT token_hash FROM magic_links
       WHERE email = ?1 AND code_hash = ?2 AND nonce_hash = ?4 AND used_at IS NULL AND expires_at > ?3 AND attempts < ?5 LIMIT 1
     ) RETURNING email`,
  )
    .bind(email, await codeHash(email, code), t, await sha256Hex(nonce), MAX_CODE_ATTEMPTS)
    .first<{ email: string }>();
  if (row) return row.email;
  // Wrong guesses count against every live code for the address.
  await env.DB.prepare('UPDATE magic_links SET attempts = attempts + 1 WHERE email = ?1 AND used_at IS NULL AND expires_at > ?2').bind(email, t).run();
  return null;
}

/** The MCP consent link, consumed by the button on the page served at GET /auth/email/verify. */
async function consumeConsentLink(env: Env, token: string): Promise<LinkRow | null> {
  if (!token) return null;
  return env.DB.prepare(
    `UPDATE magic_links SET used_at = ?2 WHERE token_hash = ?1 AND used_at IS NULL AND expires_at > ?2 AND return_to IS NOT NULL RETURNING email, return_to`,
  )
    .bind(await sha256Hex(token), now())
    .first<LinkRow>();
}

// ---- web session (consent page only) ----

export async function webUser(req: Request, env: Env): Promise<string | null> {
  const t = parseCookies(req)[WEB_COOKIE];
  return t ? verify(env, t, 'web') : null;
}

async function webCookie(env: Env, userId: string): Promise<string> {
  return `${WEB_COOKIE}=${await sign(env, userId, 'web', WEB_TTL_S)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${WEB_TTL_S}`;
}

// ---- routes ----

const NO_STORE = { 'Cache-Control': 'no-store' };
const BAD_LINK = 'This sign-in link is invalid or has expired';
const BAD_CODE = 'That code is wrong or has expired';

export async function handleAuth(req: Request, env: Env, path: string): Promise<Response | null> {
  if (path === '/auth/email/start' && req.method === 'POST') {
    const body = await readJson<{ email?: string; nonceHash?: string }>(req);
    await startMagicLink(env, req, body.email ?? '', { nonceHash: body.nonceHash });
    return json({ ok: true });
  }
  if (path === '/auth/email/lookup' && req.method === 'POST') {
    // Which account a link signs in to, without consuming it (for the app's confirmation screen).
    const body = await readJson<{ token?: string }>(req);
    const link = await peekMagicLink(env, String(body.token ?? ''));
    if (!link || link.return_to) throw new HttpError(400, BAD_LINK);
    return json({ email: link.email }, 200, NO_STORE);
  }
  if (path === '/auth/email/verify' && req.method === 'GET') {
    // Never consumes the token or returns tokens (mail scanners follow links): a person presses the button.
    const token = new URL(req.url).searchParams.get('token') ?? '';
    const link = await peekMagicLink(env, token);
    if (!link) throw new HttpError(400, BAD_LINK);
    return link.return_to ? magicLinkPage(link.email, { postToken: token }) : magicLinkPage(link.email, { href: appLink(env, token) });
  }
  if (path === '/auth/email/verify' && req.method === 'POST') {
    if ((req.headers.get('Content-Type') ?? '').startsWith('application/x-www-form-urlencoded')) {
      // The button on the consent sign-in page; only from our own origin.
      // Browsers send `Origin: null` for a form on a page with a strict referrer policy, so fall back to Fetch
      // Metadata: `Sec-Fetch-Site: same-origin` can't be set by another site.
      const o = req.headers.get('Origin');
      const sameOrigin = !o || o === origin(req, env.PUBLIC_URL) || o === new URL(req.url).origin || (o === 'null' && req.headers.get('Sec-Fetch-Site') === 'same-origin');
      if (!sameOrigin) throw new HttpError(403, 'Forbidden');
      const form = await req.formData();
      const link = await consumeConsentLink(env, String(form.get('token') ?? ''));
      if (!link?.return_to) throw new HttpError(400, BAD_LINK);
      const userId = await userByEmail(env, link.email);
      return new Response(null, { status: 302, headers: { Location: link.return_to, 'Set-Cookie': await webCookie(env, userId), ...NO_STORE } });
    }
    const body = await readJson<{ token?: unknown; nonce?: unknown; confirm?: unknown; email?: unknown; code?: unknown }>(req);
    const nonce = typeof body.nonce === 'string' && body.nonce ? body.nonce : undefined;
    let email: string | null;
    if (body.code !== undefined) {
      const code = String(body.code).replace(/\D/g, '');
      if (!nonce || code.length !== 6) throw new HttpError(400, BAD_CODE);
      email = await consumeCode(env, normEmail(String(body.email ?? '')), code, nonce);
      if (!email) throw new HttpError(400, BAD_CODE);
    } else {
      email = await consumeAppLink(env, String(body.token ?? ''), nonce, body.confirm === true);
      if (!email) throw new HttpError(400, nonce ? `${BAD_LINK}, or was requested on another device` : BAD_LINK);
    }
    return json({ ...(await issueTokens(env, await userByEmail(env, email))), email }, 200, NO_STORE);
  }
  if (path === '/auth/refresh' && req.method === 'POST') {
    const body = await readJson<{ refreshToken?: string }>(req);
    return json(await refresh(env, String(body.refreshToken ?? '')), 200, NO_STORE);
  }
  if (path === '/auth/logout' && req.method === 'POST') {
    await logout(req, env);
    return json({ ok: true });
  }
  return null;
}
