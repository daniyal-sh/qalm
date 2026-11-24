import { describe, expect, it } from 'vitest';
import { call, signIn } from './helpers';

async function sha(bytes: Uint8Array) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

describe('assets', () => {
  it('uploads and downloads content-addressed files', async () => {
    const t = await signIn('assets@example.com');
    const body = new TextEncoder().encode('%PDF-1.7 fake');
    const h = await sha(body);
    expect((await call(`/assets/${h}`, { method: 'PUT', body })).status).toBe(401);
    const put = await call(`/assets/${h}`, { method: 'PUT', token: t.accessToken, body, headers: { 'Content-Type': 'application/pdf' } });
    expect(put.status).toBe(201);
    const again = await call(`/assets/${h}`, { method: 'PUT', token: t.accessToken, body });
    expect(((await again.json()) as { existed: boolean }).existed).toBe(true);

    const get = await call(`/assets/${h}`, { token: t.accessToken });
    expect(get.status).toBe(200);
    expect(get.headers.get('Content-Type')).toBe('application/pdf');
    expect(new Uint8Array(await get.arrayBuffer())).toEqual(body);
    expect((await call(`/assets/${h}`)).status).toBe(401);
  });

  it('verifies the hash and the size limit', async () => {
    const t = await signIn('assets2@example.com');
    const body = new TextEncoder().encode('hello');
    const wrong = await sha(new TextEncoder().encode('other'));
    expect((await call(`/assets/${wrong}`, { method: 'PUT', token: t.accessToken, body })).status).toBe(400);
    expect((await call('/assets/not-a-hash', { method: 'PUT', token: t.accessToken, body })).status).toBe(400);
    const big = new Uint8Array(2048);
    expect((await call(`/assets/${await sha(big)}`, { method: 'PUT', token: t.accessToken, body: big })).status).toBe(413);
    expect((await call(`/assets/${await sha(body)}`, { token: t.accessToken })).status).toBe(404);
  });

  it('only uploaders can read an asset, and storage is capped per user', async () => {
    const a = await signIn('assets3@example.com');
    const b = await signIn('assets4@example.com');
    const body = new Uint8Array(1000).fill(7);
    const h = await sha(body);
    expect((await call(`/assets/${h}`, { method: 'PUT', token: a.accessToken, body })).status).toBe(201);
    // Knowing the hash is not enough.
    expect((await call(`/assets/${h}`, { token: b.accessToken })).status).toBe(404);
    // b proves it has the bytes by uploading them; the object is shared, not stored twice.
    const up = await call(`/assets/${h}`, { method: 'PUT', token: b.accessToken, body });
    expect(up.status).toBe(200);
    expect(((await up.json()) as { existed: boolean }).existed).toBe(true);
    expect((await call(`/assets/${h}`, { token: b.accessToken })).status).toBe(200);
    // The test cap is 1500 bytes per user: a has 1000 used.
    const more = new Uint8Array(600).fill(9);
    expect((await call(`/assets/${await sha(more)}`, { method: 'PUT', token: a.accessToken, body: more })).status).toBe(413);
    const fits = new Uint8Array(400).fill(9);
    expect((await call(`/assets/${await sha(fits)}`, { method: 'PUT', token: a.accessToken, body: fits })).status).toBe(201);
  });
});
