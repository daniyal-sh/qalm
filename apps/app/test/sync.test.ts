import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';

import { TokenManager, type Tokens } from '../src/auth/tokens';
import { AiLive } from '../src/editor/aiLive';
import { DocManager } from '../src/sync/docs';
import { MESSAGE_SYNC, PING, PONG, SyncProvider, type NetworkEvents, type SocketLike } from '../src/sync/provider';
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
  /** The network under this socket is gone: nothing arrives, sends vanish, and no close event fires. */
  dead = false;
  pings = 0;
  /** Text frames sent other than pings (Play / Pause AI). */
  readonly texts: string[] = [];
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
    if (this.dead) return;
    this.onmessage?.({ data: bytes.slice().buffer });
  }
  send(data: Uint8Array | string) {
    if (this.dead) return;
    if (typeof data === 'string') {
      if (data === PING) {
        this.pings++;
        this.onmessage?.({ data: PONG });
      } else this.texts.push(data);
      return;
    }
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
    expect(p.status).toBe('reconnecting');
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

  const heartbeat = { heartbeatMs: 20_000, heartbeatTimeoutMs: 8_000, minBackoffMs: 500 };

  it('pings after 20 s of silence and stays synced while pongs come back', async () => {
    vi.useFakeTimers();
    const server = new FakeServer();
    const p = new SyncProvider(new Y.Doc(), 'nb:hb', { serverUrl: 'https://api.test', getTicket: async () => 't', createSocket: server.create, ...heartbeat });
    await vi.advanceTimersByTimeAsync(0);
    expect(p.status).toBe('synced');
    await vi.advanceTimersByTimeAsync(19_999);
    expect(server.sockets[0]!.pings).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(server.sockets[0]!.pings).toBe(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(server.sockets[0]!.pings).toBe(4);
    expect(p.status).toBe('synced');
    expect(server.sockets).toHaveLength(1);
    p.destroy();
  });

  it('notices a connection dropped without a close event, reconnects with a fresh ticket and flushes edits', async () => {
    vi.useFakeTimers();
    const server = new FakeServer();
    let t = 0;
    const doc = new Y.Doc();
    const p = new SyncProvider(doc, 'nb:drop', { serverUrl: 'https://api.test', getTicket: async () => `t${++t}`, createSocket: server.create, ...heartbeat });
    const seen: string[] = [];
    p.onStatus((s) => seen.push(s));
    await vi.advanceTimersByTimeAsync(0);
    expect(p.status).toBe('synced');

    server.sockets[0]!.dead = true; // the network is gone, and no close event comes
    doc.getMap('m').set('whileDead', 1); // sent into the dead socket
    await vi.advanceTimersByTimeAsync(20_000 + 7_999);
    expect(p.status).toBe('synced'); // still waiting for an answer to the ping
    await vi.advanceTimersByTimeAsync(1);
    expect(p.status).toBe('reconnecting'); // 28 s after the drop at most
    doc.getMap('m').set('whileReconnecting', 2);

    await vi.advanceTimersByTimeAsync(500); // backoff, then a new ticket and socket
    expect(p.status).toBe('synced');
    expect(server.urls.map((u) => u.split('=')[1])).toEqual(['t1', 't2']);
    expect(server.doc.getMap('m').toJSON()).toEqual({ whileDead: 1, whileReconnecting: 2 });
    expect(seen).toEqual(['connected', 'synced', 'reconnecting', 'connected', 'synced']);
    p.destroy();
  });

  it('gives up on a socket that never opens, and retries', async () => {
    vi.useFakeTimers();
    const server = new FakeServer();
    let hang = true;
    const create = (url: string) => {
      const s = server.create(url) as FakeSocket;
      if (hang) {
        hang = false;
        s.dead = true;
        s.open = () => undefined;
      }
      return s;
    };
    const p = new SyncProvider(new Y.Doc(), 'nb:hang', { serverUrl: 'https://api.test', getTicket: async () => 't', createSocket: create, ...heartbeat });
    await vi.advanceTimersByTimeAsync(16_000);
    expect(p.status).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(500);
    expect(p.status).toBe('synced');
    p.destroy();
  });

  it('goes offline at once with the network, and reconnects at once when it is back', async () => {
    vi.useFakeTimers();
    const server = new FakeServer();
    let net: NetworkEvents | null = null;
    let unwatched = false;
    const watchNetwork = (e: NetworkEvents) => {
      net = e;
      return () => {
        unwatched = true;
      };
    };
    const doc = new Y.Doc();
    const getTicket = vi.fn(async () => 't');
    const p = new SyncProvider(doc, 'nb:net', { serverUrl: 'https://api.test', getTicket, createSocket: server.create, watchNetwork, ...heartbeat, minBackoffMs: 60_000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(p.status).toBe('synced');

    net!.offline();
    expect(p.status).toBe('offline');
    doc.getMap('m').set('offline', true);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(getTicket).toHaveBeenCalledTimes(1); // no retries while offline
    expect(p.status).toBe('offline');

    net!.online();
    expect(p.status).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(0); // no backoff wait
    expect(p.status).toBe('synced');
    expect(getTicket).toHaveBeenCalledTimes(2);
    expect(server.doc.getMap('m').get('offline')).toBe(true);
    p.destroy();
    expect(unwatched).toBe(true);
  });

  it('back in the foreground, checks the connection now instead of waiting for the next ping', async () => {
    vi.useFakeTimers();
    const server = new FakeServer();
    let net: NetworkEvents | null = null;
    const p = new SyncProvider(new Y.Doc(), 'nb:fg', {
      serverUrl: 'https://api.test',
      getTicket: async () => 't',
      createSocket: server.create,
      watchNetwork: (e) => {
        net = e;
        return () => undefined;
      },
      ...heartbeat,
    });
    await vi.advanceTimersByTimeAsync(5_000);
    server.sockets[0]!.dead = true; // killed while the app was in the background
    net!.foreground();
    expect(server.sockets[0]!.pings).toBe(0); // the ping went into the dead socket
    await vi.advanceTimersByTimeAsync(8_000);
    expect(p.status).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(500);
    expect(p.status).toBe('synced');
    expect(server.sockets).toHaveLength(2);

    // A healthy socket answers the foreground ping and stays.
    net!.foreground();
    expect(server.sockets[1]!.pings).toBe(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(server.sockets).toHaveLength(2);
    expect(p.status).toBe('synced');
    p.destroy();
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

describe('Play / Pause AI (AiLive over SyncProvider)', () => {
  afterEach(() => vi.useRealTimers());

  async function open() {
    vi.useFakeTimers();
    const server = new FakeServer();
    // Long socket heartbeats so the fake clock only exercises AI heartbeats.
    const p = new SyncProvider(new Y.Doc(), 'nb:1', { serverUrl: 'https://api.test', getTicket: async () => 't', createSocket: server.create, heartbeatMs: 600_000, heartbeatTimeoutMs: 600_000, minBackoffMs: 100 });
    await vi.advanceTimersByTimeAsync(0);
    expect(p.status).toBe('synced');
    const live = new AiLive(p, { everyMs: 15_000, ttlMs: 40_000 });
    const sock = () => server.sockets[server.sockets.length - 1]!;
    /** The server's answer to a Play or resume. */
    const answer = (m: string) => sock().onmessage?.({ data: m });
    return { server, p, live, sock, answer };
  }

  it('starts paused; Play sends ai:play then a heartbeat every 15 s; Pause stops and tells the server', async () => {
    const { p, live, sock, answer } = await open();
    expect(live.playing).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sock().texts).toEqual([]);
    let changes = 0;
    live.onChange(() => changes++);
    live.play();
    answer('ai:playing:0');
    expect(live.playing).toBe(true);
    expect(sock().texts).toEqual(['ai:play']);
    await vi.advanceTimersByTimeAsync(45_000);
    expect(sock().texts).toEqual(['ai:play', 'ai:live', 'ai:live', 'ai:live']);
    expect(live.pause()).toBe(true);
    expect(live.playing).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sock().texts).toEqual(['ai:play', 'ai:live', 'ai:live', 'ai:live', 'ai:pause']);
    expect(changes).toBe(2);
    live.destroy();
    p.destroy();
  });

  it('closing the notebook stops this device only; ai:paused from the server pauses here and sends ai:stop back', async () => {
    const { p, live, sock, answer } = await open();
    live.play();
    live.stop();
    expect(live.playing).toBe(false);
    expect(sock().texts).toEqual(['ai:play', 'ai:stop']);
    live.stop(); // already stopped: nothing more
    live.play();
    answer('ai:playing:0');
    // Pause on another device (or a refused heartbeat): paused here, and a stop in case a heartbeat crossed it.
    answer('ai:paused');
    expect(live.playing).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sock().texts).toEqual(['ai:play', 'ai:stop', 'ai:play', 'ai:stop']);
    live.play();
    live.destroy();
    expect(sock().texts.at(-1)).toBe('ai:stop');
    p.destroy();
  });

  it('a reconnect within the expiry resumes with the epoch; the server refuses it after a Pause elsewhere', async () => {
    const { server, p, live, sock, answer } = await open();
    live.play();
    answer('ai:playing:4');
    sock().drop(); // Wi-Fi drops; meanwhile someone presses Pause on the laptop
    await vi.advanceTimersByTimeAsync(200);
    expect(server.sockets.length).toBe(2);
    expect(sock().texts).toEqual(['ai:resume:4']); // never a bare Play or heartbeat after a reconnect
    // The room's epoch moved on: it says paused, and this device stops (no more heartbeats).
    answer('ai:paused');
    expect(live.playing).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sock().texts).toEqual(['ai:resume:4', 'ai:stop']);
    live.destroy();
    p.destroy();
  });

  it('stays paused after an outage longer than the expiry, or a Play the server never answered', async () => {
    const { server, p, live, sock, answer } = await open();
    live.play();
    answer('ai:playing:0');
    p.setNetwork(false);
    await vi.advanceTimersByTimeAsync(41_000);
    expect(live.playing).toBe(false);
    p.setNetwork(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sock().texts).toEqual([]);
    expect(server.sockets.length).toBe(2);
    // Play goes out but the socket drops before the answer: no epoch to resume with, so paused.
    live.play();
    sock().drop();
    await vi.advanceTimersByTimeAsync(200);
    expect(live.playing).toBe(false);
    expect(sock().texts).toEqual([]);
    live.destroy();
    p.destroy();
  });

  it('pauses on wake when the device slept (heartbeat timer frozen past the expiry)', async () => {
    const { p, live, sock, answer } = await open();
    live.play();
    answer('ai:playing:0');
    vi.setSystemTime(Date.now() + 120_000); // asleep: the clock jumps, timers didn't run
    await vi.advanceTimersByTimeAsync(15_000);
    expect(live.playing).toBe(false);
    expect(sock().texts).toEqual(['ai:play', 'ai:stop']);
    live.destroy();
    p.destroy();
  });

  it('a Pause pressed offline is queued, reported, and sent first on reconnect', async () => {
    const { p, live, sock, answer } = await open();
    live.play();
    answer('ai:playing:2');
    p.setNetwork(false);
    let changes = 0;
    live.onChange(() => changes++);
    expect(live.pause()).toBe(false);
    expect(live.playing).toBe(false);
    expect(live.pausePending).toBe(true);
    p.setNetwork(true);
    await vi.advanceTimersByTimeAsync(200);
    expect(sock().texts).toEqual(['ai:pause']); // the Pause, and no resume
    expect(live.pausePending).toBe(false);
    expect(changes).toBe(2);
    live.destroy();
    p.destroy();
  });

  it('a Play pressed offline goes out on reconnect (within the expiry)', async () => {
    const { p, live, sock } = await open();
    p.setNetwork(false);
    live.play();
    expect(live.playing).toBe(true);
    p.setNetwork(true);
    await vi.advanceTimersByTimeAsync(200);
    expect(sock().texts).toEqual(['ai:play']);
    live.destroy();
    p.destroy();
  });

  it('background stops this device unless held (Lecture recording); releasing in the background stops it then', async () => {
    const { p, live, sock, answer } = await open();
    live.play();
    answer('ai:playing:0');
    live.background();
    expect(live.playing).toBe(false);
    expect(sock().texts).toEqual(['ai:play', 'ai:stop']);
    live.foreground();
    // Held: backgrounding keeps sharing (heartbeats go on), Pause still works.
    const release = live.holdWhileBackgrounded('lecture');
    live.play();
    answer('ai:playing:0');
    live.background();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(live.playing).toBe(true);
    expect(sock().texts.slice(2)).toEqual(['ai:play', 'ai:live', 'ai:live']);
    // The recording stops while still in the background: sharing stops now.
    release();
    expect(live.playing).toBe(false);
    expect(sock().texts.at(-1)).toBe('ai:stop');
    // Released in the foreground: nothing happens until the next background.
    live.foreground();
    const r2 = live.holdWhileBackgrounded('lecture');
    live.play();
    r2();
    expect(live.playing).toBe(true);
    live.background();
    expect(live.playing).toBe(false);
    live.destroy();
    p.destroy();
  });

  it('delivers server text frames to listeners but not pongs', async () => {
    const { p, sock } = await open();
    const got: string[] = [];
    p.onText((m) => got.push(m));
    sock().onmessage?.({ data: 'pong' });
    sock().onmessage?.({ data: 'ai:paused' });
    expect(got).toEqual(['ai:paused']);
    p.destroy();
    expect(p.sendText('ai:live')).toBe(false);
  });
});
