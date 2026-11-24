/**
 * Settings → Delete account (Bearer auth):
 *   POST /account/delete/start {email}  the user types their address; a 6-digit deletion code is emailed.
 *   POST /account/delete {code}         deletes everything, for good.
 * Deletion codes are `magic_links` rows with purpose 'delete' (and their own hash prefix), so a sign-in code can't
 * delete an account and a deletion code can't sign in. Once a code is accepted the user is marked `deleting_at`, and
 * every step is idempotent: if a run stops halfway, the same call (same access token, no new code) finishes the job.
 * The user row goes last, so a retry still knows what to delete.
 */
import type { Env } from './env';
import { libDocId, nbDocId, room } from './docs';
import { accountDeletionEmail, sendEmail } from './email';
import { limitEmails, MAX_CODE_ATTEMPTS, normEmail, requireUser, sixDigits } from './auth';
import { HttpError, json, now, randomToken, readJson, sha256Hex } from './util';

const CODE_TTL_MS = 15 * 60 * 1000;
const BAD_CODE = 'That code is wrong or has expired';

const deleteCodeHash = (email: string, code: string) => sha256Hex(`delete:${email}:${code}`);

interface UserRow { id: string; email: string | null; deleting_at: number | null }

const userRow = (env: Env, userId: string) => env.DB.prepare('SELECT id, email, deleting_at FROM users WHERE id = ?1').bind(userId).first<UserRow>();

export async function handleAccount(req: Request, env: Env, path: string): Promise<Response | null> {
  if (path === '/account/delete/start' && req.method === 'POST') {
    const userId = await requireUser(req, env);
    const body = await readJson<{ email?: unknown }>(req);
    const user = await userRow(env, userId);
    if (!user?.email) throw new HttpError(404, 'This account no longer exists');
    if (normEmail(String(body.email ?? '')) !== user.email) throw new HttpError(400, "That email doesn't match this account");
    await limitEmails(env, req, user.email);
    const code = sixDigits();
    await env.DB.prepare(
      `INSERT INTO magic_links (token_hash, email, return_to, expires_at, nonce_hash, code_hash, purpose) VALUES (?1, ?2, NULL, ?3, NULL, ?4, 'delete')`,
    )
      .bind(await sha256Hex(randomToken()), user.email, now() + CODE_TTL_MS, await deleteCodeHash(user.email, code))
      .run();
    await sendEmail(env, accountDeletionEmail(user.email, code));
    return json({ ok: true });
  }
  if (path === '/account/delete' && req.method === 'POST') {
    const userId = await requireUser(req, env);
    const body = await readJson<{ code?: unknown }>(req);
    const user = await userRow(env, userId);
    // Already gone (an earlier run finished): nothing left to do.
    if (!user) return json({ deleted: true });
    if (!user.deleting_at) {
      const code = String(body.code ?? '').replace(/\D/g, '');
      if (code.length !== 6 || !user.email || !(await consumeDeleteCode(env, user.email, code))) throw new HttpError(400, BAD_CODE);
      await env.DB.prepare('UPDATE users SET deleting_at = ?2 WHERE id = ?1 AND deleting_at IS NULL').bind(userId, now()).run();
    }
    await deleteAccount(env, user);
    return json({ deleted: true });
  }
  return null;
}

async function consumeDeleteCode(env: Env, email: string, code: string): Promise<boolean> {
  const t = now();
  const row = await env.DB.prepare(
    `UPDATE magic_links SET used_at = ?3 WHERE token_hash = (
       SELECT token_hash FROM magic_links
       WHERE email = ?1 AND code_hash = ?2 AND purpose = 'delete' AND used_at IS NULL AND expires_at > ?3 AND attempts < ?4 LIMIT 1
     ) RETURNING email`,
  )
    .bind(email, await deleteCodeHash(email, code), t, MAX_CODE_ATTEMPTS)
    .first<{ email: string }>();
  if (row) return true;
  // Wrong guesses count against every live deletion code for the address (5 and they're dead).
  await env.DB.prepare(`UPDATE magic_links SET attempts = attempts + 1 WHERE email = ?1 AND purpose = 'delete' AND used_at IS NULL AND expires_at > ?2`)
    .bind(email, t)
    .run();
  return false;
}

/** Deletes everything the user has on the server. Safe to run again after a partial run. */
export async function deleteAccount(env: Env, user: UserRow): Promise<void> {
  const userId = user.id;

  // 1. Notebook data: every notebook room (and the page rooms it knows), every room that reported a size for this
  //    user (lecture sessions included), and the library room. Purging an already-empty room is harmless.
  const nbs = (await env.DB.prepare('SELECT id FROM notebooks WHERE owner_id = ?1').bind(userId).all<{ id: string }>()).results;
  for (const { id } of nbs) await room(env, nbDocId(id)).purgeNotebook(nbDocId(id));
  const docs = (await env.DB.prepare('SELECT doc_id FROM doc_sizes WHERE user_id = ?1').bind(userId).all<{ doc_id: string }>()).results;
  for (const { doc_id } of docs) await room(env, doc_id).purge(doc_id);
  await room(env, libDocId(userId)).purge(libDocId(userId));

  // 2. Assets: the R2 objects nobody else owns (content-addressed, shared by sha256 across users).
  const own = (
    await env.DB.prepare(
      `SELECT sha256 FROM user_assets a WHERE a.user_id = ?1 AND NOT EXISTS (SELECT 1 FROM user_assets b WHERE b.sha256 = a.sha256 AND b.user_id != ?1)`,
    )
      .bind(userId)
      .all<{ sha256: string }>()
  ).results.map((r) => r.sha256);
  for (let i = 0; i < own.length; i += 1000) await env.ASSETS.delete(own.slice(i, i + 1000));

  // 3. MCP/OAuth: revoke every grant (tokens in OAUTH_KV stop working at once).
  let cursor: string | undefined;
  do {
    const page = await env.OAUTH_PROVIDER.listUserGrants(userId, { cursor });
    for (const g of page.items) await env.OAUTH_PROVIDER.revokeGrant(g.id, userId);
    cursor = page.cursor;
  } while (cursor);

  // 4. D1 rows, the user row last.
  const byUser = ['user_assets', 'doc_sizes', 'transcribe_usage', 'grants', 'auth_requests', 'activity', 'sessions', 'sync_tickets', 'notebooks'];
  await env.DB.batch([
    ...byUser.map((t) => env.DB.prepare(`DELETE FROM ${t} WHERE ${t === 'notebooks' ? 'owner_id' : 'user_id'} = ?1`).bind(userId)),
    ...(user.email
      ? [
          env.DB.prepare('DELETE FROM magic_links WHERE email = ?1').bind(user.email),
          env.DB.prepare('DELETE FROM email_sends WHERE key = ?1').bind(`email:${user.email}`),
        ]
      : []),
    env.DB.prepare('DELETE FROM users WHERE id = ?1').bind(userId),
  ]);
}
