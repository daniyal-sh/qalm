import { SELF } from 'cloudflare:test';
import { vi, expect } from 'vitest';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import type { InkPoint, StrokeItem } from '@qalm/core';

export const BASE = 'https://qalm.test';

export function call(path: string, init: RequestInit & { token?: string } = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.token) headers.set('Authorization', `Bearer ${init.token}`);
  if (init.body && typeof init.body === 'string' && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  return SELF.fetch(`${BASE}${path}`, { ...init, headers, redirect: 'manual' });
}

/** Runs `fn` while capturing console.log, and returns the first sign-in email logged (link and, for app sign-in, the code). */
export async function captureEmail(fn: () => Promise<unknown>): Promise<{ link: string; code: string | null }> {
  const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    await fn();
    const text = spy.mock.calls.map((c) => c.join(' ')).join('\n');
    const m = /(https:\/\/\S+\/auth\/email\/verify\?token=\S+)/.exec(text);
    expect(m, 'a magic link was logged').toBeTruthy();
    return { link: m![1]!, code: /enter this code in qalm: (\d{6})/.exec(text)?.[1] ?? null };
  } finally {
    spy.mockRestore();
  }
}

export async function captureLink(fn: () => Promise<unknown>): Promise<string> {
  return (await captureEmail(fn)).link;
}

export const tokenOf = (link: string) => new URL(link).searchParams.get('token')!;

async function sha256Hex(s: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** A device nonce and the hash sent to /auth/email/start. */
export async function deviceNonce(): Promise<{ nonce: string; nonceHash: string }> {
  const nonce = crypto.randomUUID();
  return { nonce, nonceHash: await sha256Hex(nonce) };
}

/** POST /auth/email/start as the app does; returns the email's link, token and code, and the device nonce. */
export async function startEmail(email: string, headers?: HeadersInit) {
  const n = await deviceNonce();
  let status = 0;
  const mail = await captureEmail(async () => {
    const r = await call('/auth/email/start', { method: 'POST', headers, body: JSON.stringify({ email, nonceHash: n.nonceHash }) });
    status = r.status;
  });
  expect(status).toBe(200);
  return { ...mail, token: tokenOf(mail.link), ...n };
}

export function verifyEmail(body: Record<string, unknown>): Promise<Response> {
  return call('/auth/email/verify', { method: 'POST', body: JSON.stringify(body) });
}

export interface Tokens { accessToken: string; refreshToken: string; expiresIn: number; userId: string }

export async function signIn(email: string): Promise<Tokens> {
  const m = await startEmail(email);
  const r = await verifyEmail({ token: m.token, nonce: m.nonce });
  expect(r.status).toBe(200);
  return (await r.json()) as Tokens;
}

/** MCP consent sign-in: GET the emailed link (a page with a button), then press it (form POST). */
export async function consentSignIn(link: string): Promise<Response> {
  const page = await SELF.fetch(link, { redirect: 'manual' });
  expect(page.status).toBe(200);
  const token = /name="token" value="([^"]*)"/.exec(await page.text())?.[1];
  expect(token, 'the page has a form with the token').toBeTruthy();
  return call('/auth/email/verify', { method: 'POST', body: new URLSearchParams({ token: token!.replace(/&#(\d+);/g, (_, c) => String.fromCharCode(Number(c))) }) });
}

export async function ticket(token: string, docId: string): Promise<Response> {
  return call('/sync/ticket', { method: 'POST', token, body: JSON.stringify({ docId }) });
}

const MSG_SYNC = 0;

/** A minimal y-websocket client over a ticketed /sync WebSocket. */
export class YClient {
  readonly synced: Promise<void>;
  private markSynced!: () => void;
  private constructor(readonly ws: WebSocket, readonly doc: Y.Doc) {
    this.synced = new Promise((r) => (this.markSynced = r));
    // workerd delivers binary frames on client sockets as Blobs; decode them strictly in arrival order.
    let queue = Promise.resolve();
    ws.addEventListener('message', (ev) => {
      const data = ev.data as ArrayBuffer | Blob | string;
      queue = queue
        .then(async () => this.onMessage(data instanceof Blob ? await data.arrayBuffer() : data))
        .catch((e: unknown) => console.error('YClient message failed', e));
    });
    doc.on('update', (u: Uint8Array, origin: unknown) => {
      if (origin === this) return;
      const e = encoding.createEncoder();
      encoding.writeVarUint(e, MSG_SYNC);
      syncProtocol.writeUpdate(e, u);
      ws.send(encoding.toUint8Array(e));
    });
    const e = encoding.createEncoder();
    encoding.writeVarUint(e, MSG_SYNC);
    syncProtocol.writeSyncStep1(e, doc);
    ws.send(encoding.toUint8Array(e));
  }

  static async connect(token: string, docId: string, doc = new Y.Doc()): Promise<YClient> {
    const t = await ticket(token, docId);
    expect(t.status).toBe(200);
    const { ticket: tk } = (await t.json()) as { ticket: string };
    const res = await SELF.fetch(`${BASE}/sync/${encodeURIComponent(docId)}?ticket=${encodeURIComponent(tk)}`, { headers: { Upgrade: 'websocket' } });
    expect(res.status).toBe(101);
    const ws = res.webSocket!;
    ws.accept();
    const c = new YClient(ws, doc);
    await c.synced;
    return c;
  }

  private onMessage(data: ArrayBuffer | string) {
    if (typeof data === 'string') return;
    const d = decoding.createDecoder(new Uint8Array(data));
    const type = decoding.readVarUint(d);
    if (type !== MSG_SYNC) return;
    const e = encoding.createEncoder();
    encoding.writeVarUint(e, MSG_SYNC);
    const kind = syncProtocol.readSyncMessage(d, e, this.doc, this);
    if (encoding.length(e) > 1) this.ws.send(encoding.toUint8Array(e));
    if (kind === syncProtocol.messageYjsSyncStep2) this.markSynced();
  }

  close() {
    this.ws.close(1000, 'bye');
  }
}

export async function until(cond: () => boolean | Promise<boolean>, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

export function stroke(id: string, x0: number, y0: number, x1: number, y1: number): StrokeItem {
  const points: InkPoint[] = [];
  for (let k = 0; k <= 10; k++) {
    const t = k / 10;
    points.push({ x: x0 + (x1 - x0) * t, y: y0 + (y1 - y0) * t, p: 0.5, tilt: Math.PI / 2, az: 0, t: k * 8 });
  }
  return { id, type: 'stroke', tool: 'pen', color: '#27272a', width: 1.8, points, bbox: [x0, y0, x1, y1], createdAt: 0 };
}

export function cookieJar() {
  const jar = new Map<string, string>();
  return {
    take(res: Response) {
      for (const c of res.headers.getSetCookie()) {
        const [pair] = c.split(';');
        const i = pair!.indexOf('=');
        jar.set(pair!.slice(0, i), pair!.slice(i + 1));
      }
    },
    header: () => [...jar].map(([k, v]) => `${k}=${v}`).join('; '),
  };
}
