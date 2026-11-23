import type { Env } from './env';
import { num } from './env';
import { handleAuth, requireUser } from './auth';
import { handleAuthorize, messagePage } from './consent';
import { canAccess, parseDocId, room } from './docs';
import { type GrantRow } from './grants';
import { HttpError, error, json, now, origin, randomToken, readJson, sha256Hex } from './util';

const TICKET_TTL_MS = 30_000;
const SHA = /^[0-9a-f]{64}$/;

/** Everything that is not /mcp (OAuthProvider routes /mcp, /oauth/* and /.well-known/* itself). */
export const appHandler = {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    try {
      const res = (await handleAuth(req, env, path)) ?? (await handleAuthorize(req, env, path)) ?? (await route(req, env, url));
      return res ?? error(404, 'Not found');
    } catch (e) {
      if (e instanceof HttpError) {
        if (path === '/auth/email/verify' && (req.headers.get('Accept') ?? '').includes('text/html')) return messagePage("Can't sign in", e.message, e.status);
        return error(e.status, e.message);
      }
      console.error(e);
      return error(500, 'Internal error');
    }
  },
};

async function route(req: Request, env: Env, url: URL): Promise<Response | null> {
  const path = url.pathname;
  if (path === '/' && req.method === 'GET') return json({ name: 'qalm', mcp: `${origin(req, env.PUBLIC_URL)}/mcp` });
  if (path === '/health' && req.method === 'GET') return json({ ok: true });

  // ---- sync ----
  if (path === '/sync/ticket' && req.method === 'POST') {
    const userId = await requireUser(req, env);
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

  // ---- assets (content-addressed) ----
  const am = /^\/assets\/([^/]+)$/.exec(path);
  if (am) {
    const userId = await requireUser(req, env);
    const sha = am[1]!.toLowerCase();
    if (!SHA.test(sha)) throw new HttpError(400, 'Asset id must be a sha256 hex digest');
    if (req.method === 'PUT') return putAsset(req, env, userId, sha);
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

async function putAsset(req: Request, env: Env, userId: string, sha: string): Promise<Response> {
  const max = num(env.MAX_ASSET_BYTES, 50 * 1024 * 1024);
  const quota = num(env.MAX_USER_STORAGE_BYTES, 1024 * 1024 * 1024);
  const len = Number(req.headers.get('Content-Length') ?? NaN);
  if (Number.isFinite(len) && len > max) throw new HttpError(413, `Asset larger than ${max} bytes`);
  const mine = await env.DB.prepare('SELECT bytes FROM user_assets WHERE user_id = ?1 AND sha256 = ?2').bind(userId, sha).first<{ bytes: number }>();
  if (mine) return json({ sha256: sha, bytes: mine.bytes, existed: true });
  // Always read and verify the body, even when the object exists: owning an asset requires having its bytes.
  const body = await req.arrayBuffer();
  if (body.byteLength > max) throw new HttpError(413, `Asset larger than ${max} bytes`);
  if ((await sha256Hex(body)) !== sha) throw new HttpError(400, 'Body does not match its sha256');
  const used = (await env.DB.prepare('SELECT COALESCE(SUM(bytes), 0) AS n FROM user_assets WHERE user_id = ?1').bind(userId).first<{ n: number }>())?.n ?? 0;
  if (used + body.byteLength > quota) throw new HttpError(507, 'Storage limit reached');
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
    notebookIds: JSON.parse(g.notebook_ids) as string[],
    folderIds: JSON.parse(g.folder_ids) as string[],
    canComment: !!g.can_comment,
    canTranscribe: !!g.can_transcribe,
    createdAt: g.created_at,
    expiresAt: g.expires_at,
    lastUsedAt: g.last_used_at,
  };
}

/**
 * JSON API for the app's AI access screen (Bearer):
 * GET /ai/grants · DELETE /ai/grants/{id} · GET /ai/requests · POST /ai/requests/{id}/deny · GET /ai/activity?limit=
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
