import type { Env } from './env';
import { num } from './env';
import { handleAccount } from './account';
import { handleAuth, requireUser, TooManyRequests } from './auth';
import { handleAuthorize, messagePage } from './consent';
import { canAccess, deleteNotebook, nbDocId, parseDocId, room } from './docs';
import { type GrantRow } from './grants';
import { HttpError, error, json, now, origin, randomToken, readJson, sha256Hex } from './util';
import { storageFull, storageUsage } from './storage';

const TICKET_TTL_MS = 30_000;
const SHA = /^[0-9a-f]{64}$/;

/** Paths the app calls cross-origin (web build on another origin, Electron from file://). Bearer auth only, no cookies. */
const CORS_PATHS = /^\/(auth\/(email\/start|email\/lookup|email\/verify|refresh|logout)|account\/delete(\/start)?|me\/storage|sync\/ticket|notebooks\/[^/]+|assets\/[^/]+|ai\/.*|health)$/;
const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Max-Age': '86400',
};

function withCors(res: Response): Response {
  if (res.status === 101 || res.headers.has('Access-Control-Allow-Origin')) return res;
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(CORS_HEADERS)) out.headers.set(k, v);
  return out;
}

/** Everything that is not /mcp (OAuthProvider routes /mcp, /oauth/* and /.well-known/* itself). */
export const appHandler = {
  async fetch(req: Request, env: Env): Promise<Response> {
    const path = new URL(req.url).pathname;
    if (!CORS_PATHS.test(path)) return handle(req, env);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
    return withCors(await handle(req, env));
  },
};

async function handle(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    try {
      const res = (await handleAuth(req, env, path)) ?? (await handleAccount(req, env, path)) ?? (await handleAuthorize(req, env, path)) ?? (await route(req, env, url));
      return res ?? error(404, 'Not found');
    } catch (e) {
      if (e instanceof HttpError) {
        if (path === '/auth/email/verify' && (req.headers.get('Accept') ?? '').includes('text/html')) return messagePage("Can't sign in", e.message, e.status);
        const res = error(e.status, e.message);
        if (e instanceof TooManyRequests) res.headers.set('Retry-After', String(e.retryAfterS));
        return res;
      }
      console.error(e);
      return error(500, 'Internal error');
    }
}

async function route(req: Request, env: Env, url: URL): Promise<Response | null> {
  const path = url.pathname;
  if (path === '/' && req.method === 'GET') return json({ name: 'qalm', mcp: `${origin(req, env.PUBLIC_URL)}/mcp` });
  if (path === '/health' && req.method === 'GET') return json({ ok: true });

  // ---- sync ----
  if (path === '/sync/ticket' && req.method === 'POST') {
    const userId = await requireLiveUser(req, env);
    const { docId } = await readJson<{ docId?: string }>(req);
    const doc = parseDocId(docId ?? '');
    if (!doc) throw new HttpError(400, 'Invalid docId');
    if (!(await canAccess(env, userId, doc))) throw new HttpError(403, 'Forbidden');
    const ticket = randomToken();
    const expiresAt = now() + TICKET_TTL_MS;
    await env.DB.prepare('INSERT INTO sync_tickets (ticket_hash, user_id, doc_id, expires_at) VALUES (?1, ?2, ?3, ?4)')
      .bind(await sha256Hex(ticket), userId, doc.id, expiresAt)
      .run();
    return json({ ticket, expiresAt });
  }
  if (path.startsWith('/sync/') && req.method === 'GET') {
    const docId = decodeURIComponent(path.slice('/sync/'.length));
    if (!parseDocId(docId)) throw new HttpError(400, 'Invalid docId');
    if (req.headers.get('Upgrade')?.toLowerCase() !== 'websocket') throw new HttpError(426, 'Expected WebSocket');
    const ticket = url.searchParams.get('ticket') ?? '';
    const t = now();
    // Single use: the row is deleted as it is read.
    const row = ticket
      ? await env.DB.prepare('DELETE FROM sync_tickets WHERE ticket_hash = ?1 RETURNING user_id, doc_id, expires_at')
          .bind(await sha256Hex(ticket))
          .first<{ user_id: string; doc_id: string; expires_at: number }>()
      : null;
    if (!row || row.doc_id !== docId || row.expires_at < t) throw new HttpError(401, 'Invalid or expired ticket');
    env.DB.prepare('DELETE FROM sync_tickets WHERE expires_at < ?1').bind(t).run().catch(() => {});
    const headers = new Headers(req.headers);
    headers.set('X-Doc-Id', docId);
    headers.set('X-User-Id', row.user_id);
    return room(env, docId).fetch(new Request(req.url, { headers }));
  }

  // ---- Settings → Storage: what counts towards the cap ----
  if (path === '/me/storage' && req.method === 'GET') {
    const userId = await requireUser(req, env);
    return json(await storageUsage(env, userId), 200, { 'Cache-Control': 'no-store' });
  }

  // ---- Delete forever (owner only) ----
  const nm = /^\/notebooks\/([^/]+)$/.exec(path);
  if (nm && req.method === 'DELETE') {
    const userId = await requireUser(req, env);
    if (!(await deleteNotebook(env, userId, decodeURIComponent(nm[1]!)))) throw new HttpError(404, 'Not found');
    return json({ ok: true });
  }

  // ---- assets (content-addressed) ----
  const am = /^\/assets\/([^/]+)$/.exec(path);
  if (am) {
    const userId = await requireUser(req, env);
    const sha = am[1]!.toLowerCase();
    if (!SHA.test(sha)) throw new HttpError(400, 'Asset id must be a sha256 hex digest');
    if (req.method === 'PUT') return putAsset(req, env, await requireLiveUser(req, env), sha);
    if (req.method === 'GET') {
      // Only users who uploaded the bytes may read them (each device of a user uploads before referencing).
      const own = await env.DB.prepare('SELECT 1 FROM user_assets WHERE user_id = ?1 AND sha256 = ?2').bind(userId, sha).first();
      if (!own) throw new HttpError(404, 'Not found');
      const obj = await env.ASSETS.get(sha);
      if (!obj) throw new HttpError(404, 'Not found');
      const h = new Headers();
      obj.writeHttpMetadata(h);
      h.set('ETag', obj.httpEtag);
      h.set('Cache-Control', 'private, max-age=31536000, immutable');
      return new Response(obj.body, { headers: h });
    }
    return null;
  }

  // ---- Settings → AI access ----
  if (path.startsWith('/ai/')) return aiApi(req, env, path);
  return null;
}

/**
 * A signed-in user whose account still exists and isn't being deleted: for anything that creates server data (sync
 * tickets claim notebooks, uploads add assets). An access token stays valid for up to an hour after its account is deleted.
 */
async function requireLiveUser(req: Request, env: Env): Promise<string> {
  const userId = await requireUser(req, env);
  const live = await env.DB.prepare('SELECT 1 FROM users WHERE id = ?1 AND deleting_at IS NULL').bind(userId).first();
  if (!live) throw new HttpError(401, 'This account no longer exists');
  return userId;
}

async function putAsset(req: Request, env: Env, userId: string, sha: string): Promise<Response> {
  const max = num(env.MAX_ASSET_BYTES, 50 * 1024 * 1024);
  const len = Number(req.headers.get('Content-Length') ?? NaN);
  if (Number.isFinite(len) && len > max) throw new HttpError(413, `Asset larger than ${max} bytes`);
  const mine = await env.DB.prepare('SELECT bytes FROM user_assets WHERE user_id = ?1 AND sha256 = ?2').bind(userId, sha).first<{ bytes: number }>();
  if (mine) return json({ sha256: sha, bytes: mine.bytes, existed: true });
  // Refuse early when the declared size can't fit (before reading the body).
  const before = await storageUsage(env, userId);
  if (before.usedBytes + (Number.isFinite(len) ? len : 1) > before.limitBytes) return storageFull(before);
  // Always read and verify the body, even when the object exists: owning an asset requires having its bytes.
  const body = await req.arrayBuffer();
  if (body.byteLength > max) throw new HttpError(413, `Asset larger than ${max} bytes`);
  if ((await sha256Hex(body)) !== sha) throw new HttpError(400, 'Body does not match its sha256');
  const usage = await storageUsage(env, userId);
  if (usage.usedBytes + body.byteLength > usage.limitBytes) return storageFull(usage);
  const existing = await env.ASSETS.head(sha);
  if (!existing) {
    await env.ASSETS.put(sha, body, { httpMetadata: { contentType: req.headers.get('Content-Type') ?? 'application/octet-stream' }, sha256: sha });
  }
  await env.DB.prepare('INSERT INTO user_assets (user_id, sha256, bytes, created_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT DO NOTHING')
    .bind(userId, sha, body.byteLength, now())
    .run();
  return json({ sha256: sha, bytes: body.byteLength, existed: !!existing }, existing ? 200 : 201);
}

function grantJson(g: GrantRow) {
  return {
    id: g.id,
    clientId: g.client_id,
    clientName: g.client_name,
    // Deprecated: a grant covers every notebook with AI access on. Kept empty so older apps still parse it.
    notebookIds: [] as string[],
    folderIds: [] as string[],
    canComment: !!g.can_comment,
    canTranscribe: !!g.can_transcribe,
    createdAt: g.created_at,
    expiresAt: g.expires_at,
    lastUsedAt: g.last_used_at,
  };
}

/**
 * JSON API for the app's AI access screen (Bearer):
 * GET /ai/grants · PATCH /ai/grants/{id} {canComment?, canTranscribe?} (notebookIds/folderIds from older apps are ignored) · DELETE /ai/grants/{id} · GET /ai/requests · POST /ai/requests/{id}/deny · GET /ai/activity?limit= · GET /ai/presence?nb=
 */
async function aiApi(req: Request, env: Env, path: string): Promise<Response | null> {
  const userId = await requireUser(req, env);
  const t = now();
  if (path === '/ai/grants' && req.method === 'GET') {
    const rows = await env.DB.prepare('SELECT * FROM grants WHERE user_id = ?1 AND revoked_at IS NULL AND expires_at > ?2 ORDER BY created_at DESC')
      .bind(userId, t)
      .all<GrantRow>();
    return json({ mcpUrl: `${origin(req, env.PUBLIC_URL)}/mcp`, grants: rows.results.map(grantJson) });
  }
  const gm = /^\/ai\/grants\/([^/]+)$/.exec(path);
  if (gm && req.method === 'PATCH') {
    const g = await env.DB.prepare('SELECT * FROM grants WHERE id = ?1 AND user_id = ?2 AND revoked_at IS NULL').bind(gm[1], userId).first<GrantRow>();
    if (!g) throw new HttpError(404, 'Not found');
    const body = await readJson<{ canComment?: unknown; canTranscribe?: unknown }>(req);
    const flag = (v: unknown, cur: number): number => (v === undefined ? cur : v ? 1 : 0);
    await env.DB.prepare('UPDATE grants SET can_comment = ?2, can_transcribe = ?3 WHERE id = ?1')
      .bind(g.id, flag(body.canComment, g.can_comment), flag(body.canTranscribe, g.can_transcribe))
      .run();
    const next = await env.DB.prepare('SELECT * FROM grants WHERE id = ?1').bind(g.id).first<GrantRow>();
    return json({ grant: grantJson(next!) });
  }
  if (gm && req.method === 'DELETE') {
    const g = await env.DB.prepare('SELECT * FROM grants WHERE id = ?1 AND user_id = ?2').bind(gm[1], userId).first<GrantRow>();
    if (!g) throw new HttpError(404, 'Not found');
    await env.DB.prepare('UPDATE grants SET revoked_at = ?2 WHERE id = ?1 AND revoked_at IS NULL').bind(g.id, t).run();
    // Also revoke the OAuth grant, so the client's tokens stop working at once.
    let cursor: string | undefined;
    do {
      const page = await env.OAUTH_PROVIDER.listUserGrants(userId, { cursor });
      for (const og of page.items) {
        if (og.clientId === g.client_id) await env.OAUTH_PROVIDER.revokeGrant(og.id, userId);
      }
      cursor = page.cursor;
    } while (cursor);
    return json({ ok: true });
  }
  if (path === '/ai/requests' && req.method === 'GET') {
    const rows = await env.DB.prepare(
      `SELECT id, client_id, client_name, redirect_host, created_at FROM auth_requests WHERE user_id = ?1 AND status = 'pending' AND created_at > ?2 ORDER BY created_at DESC`,
    )
      .bind(userId, t - 10 * 60 * 1000)
      .all<{ id: string; client_id: string; client_name: string; redirect_host: string; created_at: number }>();
    return json({
      requests: rows.results.map((r) => ({ id: r.id, clientId: r.client_id, clientName: r.client_name, redirectHost: r.redirect_host, createdAt: r.created_at })),
    });
  }
  const rm = /^\/ai\/requests\/([^/]+)\/deny$/.exec(path);
  if (rm && req.method === 'POST') {
    await env.DB.prepare(`UPDATE auth_requests SET status = 'denied' WHERE id = ?1 AND user_id = ?2 AND status = 'pending'`).bind(rm[1], userId).run();
    return json({ ok: true });
  }
  // The editor's presence pill: which agents are following this notebook right now, and whether sharing is paused.
  if (path === '/ai/presence' && req.method === 'GET') {
    const nb = new URL(req.url).searchParams.get('nb') ?? '';
    const doc = parseDocId(nbDocId(nb));
    if (!nb || !doc || !(await canAccess(env, userId, doc))) throw new HttpError(404, 'Not found');
    return json(await room(env, doc.id).agentPresence(doc.id));
  }
  if (path === '/ai/activity' && req.method === 'GET') {
    const limit = Math.min(200, Math.max(1, num(new URL(req.url).searchParams.get('limit') ?? undefined, 50)));
    const rows = await env.DB.prepare('SELECT grant_id, client_name, tool, target, tokens, at FROM activity WHERE user_id = ?1 ORDER BY at DESC, id DESC LIMIT ?2')
      .bind(userId, limit)
      .all<{ grant_id: string; client_name: string; tool: string; target: string; tokens: number; at: number }>();
    return json({
      activity: rows.results.map((r) => ({ grantId: r.grant_id, clientName: r.client_name, tool: r.tool, target: r.target, tokens: r.tokens, at: r.at })),
    });
  }
  return null;
}
