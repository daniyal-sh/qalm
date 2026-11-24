import { runDurableObjectAlarm } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { Page } from '@qalm/core';
import { call, signIn, startEmail, stroke, until, verifyEmail, type Tokens } from './helpers';
import { connectAgent, notebook, serverDoc, tool } from './mcp-helpers';

async function sha(bytes: Uint8Array) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** POST /account/delete/start and the 6-digit code from the deletion email (logged by the console provider). */
async function deletionCode(t: Tokens, email: string): Promise<string> {
  const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    const r = await call('/account/delete/start', { method: 'POST', token: t.accessToken, body: JSON.stringify({ email }) });
    expect(r.status).toBe(200);
    const text = spy.mock.calls.map((c) => c.join(' ')).join('\n');
    const code = /delete your account for good: (\d{6})/.exec(text)?.[1];
    expect(code, 'a deletion code was emailed').toBeTruthy();
    return code!;
  } finally {
    spy.mockRestore();
  }
}

const deleteWith = (t: Tokens, code?: string) => call('/account/delete', { method: 'POST', token: t.accessToken, body: JSON.stringify(code === undefined ? {} : { code }) });

/** Every D1 row that belongs to the user. */
async function rowsFor(userId: string, email: string): Promise<Record<string, number>> {
  const q = async (sql: string, v: string) => (await env.DB.prepare(sql).bind(v).first<{ n: number }>())!.n;
  const out: Record<string, number> = {};
  for (const t of ['user_assets', 'doc_sizes', 'grants', 'auth_requests', 'activity', 'sessions', 'sync_tickets']) {
    out[t] = await q(`SELECT COUNT(*) AS n FROM ${t} WHERE user_id = ?1`, userId);
  }
  out.notebooks = await q('SELECT COUNT(*) AS n FROM notebooks WHERE owner_id = ?1', userId);
  out.users = await q('SELECT COUNT(*) AS n FROM users WHERE id = ?1', userId);
  out.magic_links = await q('SELECT COUNT(*) AS n FROM magic_links WHERE email = ?1', email);
  return out;
}

const isEmptyDoc = async (docId: string) => Y.encodeStateAsUpdate(await serverDoc(docId)).byteLength <= 2;

describe('delete account', () => {
  it('deletes everything, keeps an asset another user also owns, and is idempotent', async () => {
    const email = 'leaving@example.com';
    const t = await signIn(email);
    const other = await signIn('staying@example.com');

    // A notebook with ink, an AI connection with some activity, and two assets (one shared with another user).
    const n = await notebook(t, 'leavenb', 'Physics');
    n.page.addItem(stroke('s1', 50, 100, 150, 120));
    const pgDoc = `pg:leavenb:${n.pageId}`;
    await until(async () => new Page(await serverDoc(pgDoc)).items().length === 1);
    const mcpToken = await connectAgent(email, { comment: true, transcribe: false });
    await tool(mcpToken, 'wait');
    const mine = new Uint8Array(200).fill(1);
    const shared = new Uint8Array(300).fill(2);
    const [mineSha, sharedSha] = [await sha(mine), await sha(shared)];
    expect((await call(`/assets/${mineSha}`, { method: 'PUT', token: t.accessToken, body: mine })).status).toBe(201);
    expect((await call(`/assets/${sharedSha}`, { method: 'PUT', token: t.accessToken, body: shared })).status).toBe(201);
    expect((await call(`/assets/${sharedSha}`, { method: 'PUT', token: other.accessToken, body: shared })).status).toBe(200);
    await until(() => runDurableObjectAlarm(env.DOC_ROOM.get(env.DOC_ROOM.idFromName(pgDoc))));
    const before = await rowsFor(t.userId, email);
    for (const k of ['user_assets', 'doc_sizes', 'grants', 'activity', 'sessions', 'notebooks', 'users']) expect(before[k], k).toBeGreaterThan(0);
    n.nbc.close();
    n.pgc.close();

    const code = await deletionCode(t, email);
    const r = await deleteWith(t, code);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ deleted: true });

    // D1: nothing left for the user.
    expect(Object.values(await rowsFor(t.userId, email)).every((v) => v === 0), JSON.stringify(await rowsFor(t.userId, email))).toBe(true);
    // Durable Objects: the notebook, its page and the library are empty.
    for (const d of ['nb:leavenb', pgDoc, `lib:${t.userId}`]) expect(await isEmptyDoc(d), d).toBe(true);
    // R2: the user's own asset is gone; the shared one stays for the other user.
    expect(await env.ASSETS.head(mineSha)).toBeNull();
    expect(await env.ASSETS.head(sharedSha)).not.toBeNull();
    expect((await call(`/assets/${sharedSha}`, { token: other.accessToken })).status).toBe(200);
    // Tokens: refresh fails, the agent's MCP token is revoked, and nothing new can be created with the old access token.
    expect((await call('/auth/refresh', { method: 'POST', body: JSON.stringify({ refreshToken: t.refreshToken }) })).status).toBe(401);
    expect((await call('/mcp', { method: 'POST', token: mcpToken, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) })).status).toBe(401);
    expect((await call('/sync/ticket', { method: 'POST', token: t.accessToken, body: JSON.stringify({ docId: 'nb:leavenb' }) })).status).toBe(401);
    expect((await call(`/assets/${mineSha}`, { method: 'PUT', token: t.accessToken, body: mine })).status).toBe(401);
    // Running it again is fine.
    expect((await deleteWith(t, code)).status).toBe(200);
    // The other account is untouched.
    expect((await call('/me/storage', { token: other.accessToken })).status).toBe(200);
  });

  it('finishes a deletion that stopped halfway, without a new code', async () => {
    const email = 'halfway@example.com';
    const t = await signIn(email);
    const n = await notebook(t, 'halfnb', 'Maths', { ai: false });
    n.nbc.close();
    n.pgc.close();
    // As if a code was accepted and the run died before deleting anything.
    await env.DB.prepare('UPDATE users SET deleting_at = 1 WHERE id = ?1').bind(t.userId).run();
    expect((await deleteWith(t)).status).toBe(200);
    expect(Object.values(await rowsFor(t.userId, email)).every((v) => v === 0)).toBe(true);
    expect(await isEmptyDoc('nb:halfnb')).toBe(true);
  });

  it('rejects a wrong email and a wrong code, and keeps the account', async () => {
    const email = 'careful@example.com';
    const t = await signIn(email);
    const start = await call('/account/delete/start', { method: 'POST', token: t.accessToken, body: JSON.stringify({ email: 'someone@example.com' }) });
    expect(start.status).toBe(400);
    expect(((await start.json()) as { error: string }).error).toMatch(/doesn't match/);
    expect((await call('/account/delete/start', { method: 'POST', body: JSON.stringify({ email }) })).status).toBe(401);

    const code = await deletionCode(t, ` ${email.toUpperCase()} `);
    const wrong = code === '000000' ? '111111' : '000000';
    const r = await deleteWith(t, wrong);
    expect(r.status).toBe(400);
    expect((await deleteWith(t)).status).toBe(400);
    expect((await rowsFor(t.userId, email)).users).toBe(1);
    // The right code still works (one wrong guess of five).
    expect((await deleteWith(t, code)).status).toBe(200);
  });

  it('a sign-in code never deletes an account, and a deletion code never signs in', async () => {
    const email = 'twocodes@example.com';
    const t = await signIn(email);
    const signin = await startEmail(email);
    expect(signin.code).toMatch(/^\d{6}$/);
    expect((await deleteWith(t, signin.code!)).status).toBe(400);
    expect((await rowsFor(t.userId, email)).users).toBe(1);

    const del = await deletionCode(t, email);
    expect((await verifyEmail({ email, code: del, nonce: signin.nonce })).status).toBe(400);
    // Both are still good for their own purpose.
    expect((await verifyEmail({ email, code: signin.code, nonce: signin.nonce })).status).toBe(200);
    expect((await deleteWith(t, del)).status).toBe(200);
  });
});
