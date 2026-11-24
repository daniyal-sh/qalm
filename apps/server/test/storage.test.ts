import { runDurableObjectAlarm } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { Page } from '@qalm/core';
import { YClient, call, signIn, stroke, until } from './helpers';

interface Usage { usedBytes: number; limitBytes: number; assetBytes: number; notebookBytes: number }

async function sha(bytes: Uint8Array) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const usage = async (token: string) => {
  const r = await call('/me/storage', { token });
  expect(r.status).toBe(200);
  return (await r.json()) as Usage;
};

const stub = (docId: string) => env.DOC_ROOM.get(env.DOC_ROOM.idFromName(docId));

/** Fires the room's pending size report (scheduled a few seconds after a write). */
async function flushSize(docId: string) {
  await until(() => runDurableObjectAlarm(stub(docId)));
}

describe('storage cap', () => {
  it('GET /me/storage needs a user and starts at zero', async () => {
    expect((await call('/me/storage')).status).toBe(401);
    const t = await signIn('store0@example.com');
    // The test cap is 1500 bytes (vitest.config.ts); the default is 250 MB.
    expect(await usage(t.accessToken)).toEqual({ usedBytes: 0, limitBytes: 1500, assetBytes: 0, notebookBytes: 0 });
  });

  it('counts the bytes each DocRoom stores for the notebook owner', async () => {
    const t = await signIn('store1@example.com');
    const docId = 'pg:nbstore1:p1';
    const a = await YClient.connect(t.accessToken, docId);
    new Page(a.doc).addItem(stroke('s1', 10, 10, 100, 20));
    await flushSize(docId);
    const stored = await stub(docId).reportSize();
    expect(stored).toBeGreaterThan(50);
    const u = await usage(t.accessToken);
    expect(u.notebookBytes).toBe(stored);
    expect(u.usedBytes).toBe(stored);
    // Another user's usage is untouched.
    expect((await usage((await signIn('store1b@example.com')).accessToken)).usedBytes).toBe(0);
    a.close();
  });

  it('at the cap, imports get a 413 but ink keeps syncing', async () => {
    const t = await signIn('store2@example.com');
    const docId = 'pg:nbstore2:p1';
    const a = await YClient.connect(t.accessToken, docId);
    const b = await YClient.connect(t.accessToken, docId);
    const pa = new Page(a.doc);
    for (let i = 0; i < 6; i++) pa.addItem(stroke(`s${i}`, 10, 10 + i * 30, 300, 20 + i * 30));
    await flushSize(docId);
    expect((await usage(t.accessToken)).usedBytes).toBeGreaterThan(1500);

    const img = new Uint8Array(100).fill(3);
    const put = await call(`/assets/${await sha(img)}`, { method: 'PUT', token: t.accessToken, body: img, headers: { 'Content-Type': 'image/png' } });
    expect(put.status).toBe(413);
    const body = (await put.json()) as { code: string; error: string; limitBytes: number };
    expect(body.code).toBe('storage_full');
    expect(body.error).toMatch(/storage is full/);

    // Handwriting is never blocked.
    pa.addItem(stroke('after-cap', 10, 400, 300, 420));
    const pb = new Page(b.doc);
    await until(() => pb.items().some((i) => i.id === 'after-cap'));
    a.close();
    b.close();
  });

  it('assets and notebook data add up, and Delete forever frees the notebook bytes', async () => {
    const t = await signIn('store3@example.com');
    const img = new Uint8Array(300).fill(5);
    expect((await call(`/assets/${await sha(img)}`, { method: 'PUT', token: t.accessToken, body: img })).status).toBe(201);
    const docId = 'pg:nbstore3:p1';
    const a = await YClient.connect(t.accessToken, docId);
    new Page(a.doc).addItem(stroke('s1', 10, 10, 100, 20));
    await flushSize(docId);
    a.close();
    const u = await usage(t.accessToken);
    expect(u.assetBytes).toBe(300);
    expect(u.notebookBytes).toBeGreaterThan(0);
    expect(u.usedBytes).toBe(u.assetBytes + u.notebookBytes);

    expect((await call('/notebooks/nbstore3', { method: 'DELETE', token: t.accessToken })).status).toBe(200);
    expect(await usage(t.accessToken)).toMatchObject({ notebookBytes: 0, usedBytes: 300 });
  });
});
