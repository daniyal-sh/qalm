import { SELF, runInDurableObject, evictDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { Page, createNotebookDoc, Notebook } from '@qalm/core';
import { BASE, YClient, signIn, ticket, until, stroke } from './helpers';
import { COMPACT_EVERY, type DocRoom } from '../src/room';

const upgrade = { headers: { Upgrade: 'websocket' } };

describe('sync', () => {
  it('two clients converge through a DocRoom', async () => {
    const t = await signIn('sync@example.com');
    const docId = 'pg:nbsync:p1';
    const a = await YClient.connect(t.accessToken, docId);
    const b = await YClient.connect(t.accessToken, docId);
    const pa = new Page(a.doc);
    const pb = new Page(b.doc);
    pa.addItem(stroke('s1', 50, 100, 150, 120));
    pb.addItem(stroke('s2', 50, 200, 150, 220));
    await until(() => pa.items().length === 2 && pb.items().length === 2);
    expect(pa.lines().map((l) => l.key).sort()).toEqual(['s1', 's2']);
    expect(Y.encodeStateVector(a.doc)).toEqual(Y.encodeStateVector(b.doc));

    // After eviction, a late joiner gets everything from storage.
    a.close();
    b.close();
    const stub = env.DOC_ROOM.get(env.DOC_ROOM.idFromName(docId));
    await evictDurableObject(stub, { webSockets: 'close' });
    const c = await YClient.connect(t.accessToken, docId);
    expect(new Page(c.doc).items().map((i) => i.id).sort()).toEqual(['s1', 's2']);
    c.close();
  });

  it('tickets are single-use, bound to the doc, and owner-only', async () => {
    const owner = await signIn('owner@example.com');
    const other = await signIn('other@example.com');
    const r = await ticket(owner.accessToken, 'nb:owned1');
    const { ticket: tk } = (await r.json()) as { ticket: string };
    // Wrong doc (and that attempt consumes it).
    expect((await SELF.fetch(`${BASE}/sync/nb:owned2?ticket=${tk}`, upgrade)).status).toBe(401);
    expect((await SELF.fetch(`${BASE}/sync/nb:owned1?ticket=${tk}`, upgrade)).status).toBe(401);
    // A fresh ticket works once.
    const { ticket: tk2 } = (await (await ticket(owner.accessToken, 'nb:owned1')).json()) as { ticket: string };
    const ok = await SELF.fetch(`${BASE}/sync/nb:owned1?ticket=${tk2}`, upgrade);
    expect(ok.status).toBe(101);
    ok.webSocket!.accept();
    ok.webSocket!.close();
    expect((await SELF.fetch(`${BASE}/sync/nb:owned1?ticket=${tk2}`, upgrade)).status).toBe(401);
    // Someone else's notebook, pages or library.
    expect((await ticket(other.accessToken, 'nb:owned1')).status).toBe(403);
    expect((await ticket(other.accessToken, 'pg:owned1:p1')).status).toBe(403);
    expect((await ticket(other.accessToken, `lib:${owner.userId}`)).status).toBe(403);
    expect((await ticket(other.accessToken, `lib:${other.userId}`)).status).toBe(200);
    expect((await ticket(other.accessToken, 'bogus')).status).toBe(400);
    // Access tokens are never accepted in the URL.
    expect((await SELF.fetch(`${BASE}/sync/nb:owned1?ticket=${owner.accessToken}`, upgrade)).status).toBe(401);
  });

  it('tickets expire after 30 s', async () => {
    const owner = await signIn('expiry@example.com');
    const r = await ticket(owner.accessToken, 'nb:exp1');
    const { expiresAt } = (await r.json()) as { expiresAt: number };
    expect(expiresAt - Date.now()).toBeGreaterThan(25_000);
    expect(expiresAt - Date.now()).toBeLessThanOrEqual(30_000);
    // A ticket that is past its expiry is refused (written directly so the test needn't wait 30 s).
    const tk = 'expired-ticket-value';
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(tk)))].map((b) => b.toString(16).padStart(2, '0')).join('');
    await env.DB.prepare('INSERT INTO sync_tickets (ticket_hash, user_id, doc_id, expires_at) VALUES (?1, ?2, ?3, ?4)').bind(hash, owner.userId, 'nb:exp1', Date.now() - 1).run();
    expect((await SELF.fetch(`${BASE}/sync/nb:exp1?ticket=${tk}`, upgrade)).status).toBe(401);
    // Missing ticket, and plain HTTP instead of an upgrade.
    expect((await SELF.fetch(`${BASE}/sync/nb:exp1`, upgrade)).status).toBe(401);
    expect((await SELF.fetch(`${BASE}/sync/nb:exp1?ticket=x`)).status).toBe(426);
  });

  it('compacts the update log into a snapshot every 200 updates', async () => {
    const t = await signIn('compact@example.com');
    const docId = 'nb:compact1';
    const init = createNotebookDoc({ id: 'compact1', title: 'Big', cover: '#4338ca', paper: 'ruled', paperColor: 'white', size: { w: 595, h: 842 } });
    const a = await YClient.connect(t.accessToken, docId, init);
    const nb = new Notebook(a.doc);
    const last = `T${COMPACT_EVERY + 9}`;
    for (let i = 0; i < COMPACT_EVERY + 10; i++) nb.setMeta({ title: `T${i}` });
    const stub = env.DOC_ROOM.get(env.DOC_ROOM.idFromName(docId));
    await until(async () => (await runInDurableObject(stub, (o: DocRoom) => new Notebook(o.doc).meta().title)) === last);
    expect(await runInDurableObject(stub, (o: DocRoom) => o.pendingUpdates())).toBeLessThan(COMPACT_EVERY);
    a.close();
    await evictDurableObject(stub, { webSockets: 'close' });
    expect(await runInDurableObject(stub, (o: DocRoom) => new Notebook(o.doc).meta().title)).toBe(last);
    // The D1 row follows the index doc's title.
    await until(async () => (await env.DB.prepare('SELECT title FROM notebooks WHERE id = ?').bind('compact1').first<{ title: string }>())?.title === last);
  });
});
