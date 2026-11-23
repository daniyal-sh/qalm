import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';

import { TokenManager, type Tokens } from '../src/auth/tokens';
import { DocManager } from '../src/sync/docs';
import { MESSAGE_SYNC, SyncProvider, type SocketLike } from '../src/sync/provider';
import { MemoryStorage, SnapshotPersistence } from '../src/sync/snapshot';
import { fetchTicket, syncSocketUrl } from '../src/sync/ticket';
import { flush } from './helpers';

function jwt(claims: object): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none' })}.${b64(claims)}.sig`;
}

/** An in-memory y-websocket-style server for one doc. */
class FakeServer {
  readonly doc = new Y.Doc();
  readonly urls: string[] = [];
  readonly sockets: FakeSocket[] = [];
  constructor() {
    this.doc.on('update', (u: Uint8Array, origin: unknown) => {
      for (const s of this.sockets) {
        if (s === origin || s.readyState !== 1) continue;
        const enc = encoding.createEncoder();
        encoding.writeVarUint(enc, MESSAGE_SYNC);
        syncProtocol.writeUpdate(enc, u);
        s.deliver(encoding.toUint8Array(enc));
      }
    });
  }
  create = (url: string): SocketLike => {
    this.urls.push(url);
    const s = new FakeSocket(this);
    this.sockets.push(s);
    queueMicrotask(() => s.open());
    return s;
  };
}

class FakeSocket implements SocketLike {
  binaryType = 'blob';
  readyState = 0;
  onopen: SocketLike['onopen'] = null;
  onclose: SocketLike['onclose'] = null;
  onerror: SocketLike['onerror'] = null;
  onmessage: SocketLike['onmessage'] = null;
  constructor(private server: FakeServer) {}
  open() {
    this.readyState = 1;
    this.onopen?.({});
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(enc, this.server.doc);
    this.deliver(encoding.toUint8Array(enc));
  }
  deliver(bytes: Uint8Array) {
    this.onmessage?.({ data: bytes.slice().buffer });
  }
  send(data: Uint8Array) {
    const dec = decoding.createDecoder(data);
    if (decoding.readVarUint(dec) !== MESSAGE_SYNC) return;
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MESSAGE_SYNC);
    syncProtocol.readSyncMessage(dec, enc, this.server.doc, this);
    if (encoding.length(enc) > 1) this.deliver(encoding.toUint8Array(enc));
  }
  close() {
    this.readyState = 3;
    this.onclose?.({});
  }
  /** Server-side drop. */
  drop() {
    this.readyState = 3;
    this.onclose?.({});
  }
}

describe('ticket client', () => {
  it('POSTs the doc id with Bearer auth and returns the ticket', async () => {
    const seen: { url: string; init?: RequestInit }[] = [];
    const tm = new TokenManager(
      'https://api.test',
      { load: async () => ({ accessToken: jwt({ sub: 'u1', exp: 4e9 }), refreshToken: 'r' }), save: async () => {} },
      async (url, init) => {
        seen.push({ url, init });
        return new Response(JSON.stringify({ ticket: 't-123' }), { status: 200 });
      },
    );
    await tm.load();
    expect(await fetchTicket((p, i) => tm.fetch(p, i), 'pg:nb1:p1')).toBe('t-123');
    expect(seen[0]!.url).toBe('https://api.test/sync/ticket');
    expect(JSON.parse(String(seen[0]!.init!.body))).toEqual({ docId: 'pg:nb1:p1' });
    expect(new Headers(seen[0]!.init!.headers).get('authorization')).toMatch(/^Bearer /);
  });

  it('builds the socket URL without the access token', () => {
    expect(syncSocketUrl('https://api.test/', 'pg:a:b', 't/1')).toBe('wss://api.test/sync/pg%3Aa%3Ab?ticket=t%2F1');
    expect(syncSocketUrl('http://localhost:8787', 'lib:u', 'x')).toBe('ws://localhost:8787/sync/lib%3Au?ticket=x');
  });

  it('throws on a non-2xx ticket response', async () => {
    await expect(fetchTicket(async () => new Response('no', { status: 403 }), 'nb:x')).rejects.toThrow(/403/);
  });
});

describe('TokenManager', () => {
  it('refreshes single-flight before expiry and keeps the new tokens', async () => {
    let now = 1_000_000;
    let saved: Tokens | null = null;
    const calls: string[] = [];
    const tm = new TokenManager(
      'https://api.test',
      { load: async () => ({ accessToken: jwt({ sub: 'u1', exp: now / 1000 + 30 }), refreshToken: 'r1' }), save: async (t) => void (saved = t) },
      async (url, init) => {
        calls.push(url);
        if (url.endsWith('/auth/refresh')) {
          expect(JSON.parse(String(init!.body))).toEqual({ refreshToken: 'r1' });
          await flush();
          return new Response(JSON.stringify({ accessToken: jwt({ sub: 'u1', exp: now / 1000 + 3600 }), refreshToken: 'r2' }));
        }
        return new Response('{}');
      },
      () => now,
    );
    expect((await tm.load())?.id).toBe('u1');
    const [a, b] = await Promise.all([tm.accessToken(), tm.accessToken()]);
    expect(a).toBe(b);
    expect(calls.filter((c) => c.endsWith('/auth/refresh'))).toHaveLength(1);
    expect(saved!.refreshToken).toBe('r2');
    now += 10_000;
    await tm.accessToken();
    expect(calls.filter((c) => c.endsWith('/auth/refresh'))).toHaveLength(1);
  });

  it('retries once after a 401 with a refreshed token', async () => {
    let n = 0;
    const tm = new TokenManager(
      'https://api.test',
      { load: async () => ({ accessToken: jwt({ sub: 'u1', exp: 4e9 }), refreshToken: 'r' }), save: async () => {} },
      async (url, init) => {
        if (url.endsWith('/auth/refresh')) return new Response(JSON.stringify({ accessToken: jwt({ sub: 'u1', exp: 4e9, n: 2 }), refreshToken: 'r' }));
        n++;
        const auth = new Headers(init!.headers).get('authorization')!;
        return new Response('{}', { status: n === 1 ? 401 : 200, headers: { 'x-auth': auth } });
      },
    );
    await tm.load();
    const res = await tm.fetch('/api/me');
    expect(res.status).toBe(200);
    expect(n).toBe(2);
  });

  it('signs out when the refresh token is rejected', async () => {
    const tm = new TokenManager(
      'https://api.test',
      { load: async () => ({ accessToken: jwt({ sub: 'u1', exp: 1 }), refreshToken: 'bad' }), save: async () => {} },
      async () => new Response('{}', { status: 401 }),
    );
    await tm.load();
    const changes: unknown[] = [];
    tm.onChange((u) => changes.push(u));
    await expect(tm.accessToken()).rejects.toThrow(/expired/);
    expect(tm.user()).toBeNull();
    expect(changes).toEqual([null]);
  });
});

describe('SyncProvider', () => {
  afterEach(() => vi.useRealTimers());

  it('syncs both ways using a fresh ticket per connection', async () => {
    const server = new FakeServer();
    server.doc.getMap('m').set('fromServer', 1);
    const doc = new Y.Doc();
    doc.getMap('m').set('fromClient', 2);
    let t = 0;
    const p = new SyncProvider(doc, 'nb:1', {
      serverUrl: 'https://api.test',
      getTicket: async () => `t${++t}`,
      createSocket: server.create,
      minBackoffMs: 1,
    });
    await p.whenSynced();
    expect(p.status).toBe('synced');
    expect(doc.getMap('m').get('fromServer')).toBe(1);
    expect(server.doc.getMap('m').get('fromClient')).toBe(2);

    doc.getMap('m').set('live', 3);
    expect(server.doc.getMap('m').get('live')).toBe(3);
    server.doc.getMap('m').set('push', 4);
    expect(doc.getMap('m').get('push')).toBe(4);

    // server drops the socket: reconnect with a new ticket
    server.sockets[0]!.drop();
    expect(p.status).toBe('offline');
    await new Promise((r) => setTimeout(r, 20));
    await p.whenSynced();
    expect(server.urls).toEqual(['wss://api.test/sync/nb%3A1?ticket=t1', 'wss://api.test/sync/nb%3A1?ticket=t2']);
    p.destroy();
  });

  it('retries with backoff when the ticket request fails', async () => {
    vi.useFakeTimers();
    const server = new FakeServer();
    let fail = 2;
    const getTicket = vi.fn(async () => {
      if (fail-- > 0) throw new Error('offline');
      return 'ok';
    });
    const p = new SyncProvider(new Y.Doc(), 'lib:u', { serverUrl: 'https://api.test', getTicket, createSocket: server.create, minBackoffMs: 100 });
    await vi.advanceTimersByTimeAsync(0);
    expect(getTicket).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(getTicket).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(200);
    expect(getTicket).toHaveBeenCalledTimes(3);
    expect(server.urls).toEqual(['wss://api.test/sync/lib%3Au?ticket=ok']);
    p.disconnect();
    expect(p.status).toBe('offline');
  });
});

describe('local persistence', () => {
  it('snapshots a doc and restores it', async () => {
    const storage = new MemoryStorage();
    const a = new Y.Doc();
    const pa = new SnapshotPersistence('pg:x:y', a, storage, 5);
    await pa.whenSynced;
    a.getArray('order').push(['i1', 'i2']);
    await pa.destroy();
    const b = new Y.Doc();
    const pb = new SnapshotPersistence('pg:x:y', b, storage, 5);
    await pb.whenSynced;
    expect(b.getArray('order').toArray()).toEqual(['i1', 'i2']);
    await pb.destroy();
  });

  it('DocManager ref-counts docs, keeps a small LRU and connects when online', async () => {
    const storage = new MemoryStorage();
    const evicted: string[] = [];
    const m = new DocManager({ persist: (id, d) => new SnapshotPersistence(id, d, storage, 1), remote: null, cacheSize: 1 });
    m.onEvict((id) => evicted.push(id));
    const h1 = m.open('pg:n:1');
    const h1b = m.open('pg:n:1');
    expect(h1.doc).toBe(h1b.doc);
    h1.doc.getMap('m').set('k', 1);
    h1.release();
    expect(m.isOpen('pg:n:1')).toBe(true);
    h1b.release();
    m.open('pg:n:2').release();
    m.open('pg:n:3').release();
    expect(evicted).toEqual(['pg:n:1', 'pg:n:2']);
    await new Promise((r) => setTimeout(r, 10));
    const again = m.open('pg:n:1');
    await again.loaded;
    expect(again.doc.getMap('m').get('k')).toBe(1);

    const server = new FakeServer();
    m.setRemote((id, doc) => new SyncProvider(doc, id, { serverUrl: 'https://api.test', getTicket: async () => 't', createSocket: server.create }));
    expect(again.provider()).not.toBeNull();
    await again.provider()!.whenSynced();
    expect(server.doc.getMap('m').get('k')).toBe(1);
    await m.closeAll();
  });
});
