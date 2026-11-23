import { Library } from '@qalm/core';
import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

import { extractCode, isEmail, lookupMagicLink, startMagicLink, verifyCode, verifyMagicLink } from '../src/auth/magicLink';
import { beginEmailSignIn, clearPending, pendingNonce, PENDING_TTL_MS, type PendingDeps, type PendingMap } from '../src/auth/pending';
import { TokenManager, type RefreshLock, type Tokens } from '../src/auth/tokens';
import { entryFor } from '../src/library/actions';
import { hasLocalLibrary, localToMove, moveLocalLibrary } from '../src/state/localLibrary';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const bodyOf = (init?: RequestInit) => JSON.parse(String(init!.body)) as Record<string, unknown>;

function jwt(claims: object): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none' })}.${b64(claims)}.sig`;
}

function memPending(now: { t: number }): PendingDeps & { map: () => PendingMap | undefined } {
  let stored: PendingMap | undefined;
  let n = 0;
  return {
    load: async () => (stored ? structuredClone(stored) : undefined),
    save: async (v) => void (stored = structuredClone(v)),
    random: () => `nonce-${++n}`,
    sha256: async (s) => `h(${s})`,
    now: () => now.t,
    map: () => stored,
  };
}

describe('magic link API', () => {
  it('starts with the nonce hash, looks up and verifies with the nonce, a confirmation, or a code', async () => {
    const f = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/auth/email/lookup')) return bodyOf(init).token === 'good' ? json({ email: 'a@b.co' }) : json({ error: 'This sign-in link is invalid or has expired' }, 400);
      if (url.endsWith('/auth/email/verify')) return json({ accessToken: 'a', refreshToken: 'r', expiresIn: 3600, email: 'a@b.co' });
      if (url.endsWith('/auth/email/start')) return bodyOf(init).email === 'many@b.co' ? new Response('', { status: 429 }) : json({ ok: true });
      return json({}, 404);
    });
    await startMagicLink(f, 'https://s', ' a@b.co ', 'hash1');
    expect(bodyOf(f.mock.calls[0]![1])).toEqual({ email: 'a@b.co', nonceHash: 'hash1' });
    await expect(startMagicLink(f, 'https://s', 'many@b.co', 'h')).rejects.toThrow('Too many');

    expect(await lookupMagicLink(f, 'https://s', 'good')).toBe('a@b.co');
    await expect(lookupMagicLink(f, 'https://s', 'bad')).rejects.toThrow('invalid or has expired');

    f.mockClear();
    await expect(verifyMagicLink(f, 'https://s', 'tok', { nonce: 'n1' })).resolves.toEqual({ accessToken: 'a', refreshToken: 'r', email: 'a@b.co' });
    expect(f.mock.calls[0]![0]).toBe('https://s/auth/email/verify');
    expect(f.mock.calls[0]![1]!.method).toBe('POST'); // never a GET: GETs don't use links up
    expect(bodyOf(f.mock.calls[0]![1])).toEqual({ token: 'tok', nonce: 'n1' });
    await verifyMagicLink(f, 'https://s', 'tok', { confirm: true });
    expect(bodyOf(f.mock.calls[1]![1])).toEqual({ token: 'tok', confirm: true });
    await verifyCode(f, 'https://s', 'a@b.co', '123456', 'n1');
    expect(bodyOf(f.mock.calls[2]![1])).toEqual({ email: 'a@b.co', code: '123456', nonce: 'n1' });
  });

  it('tells codes from links', () => {
    expect(extractCode('123456')).toBe('123456');
    expect(extractCode(' 123 456 ')).toBe('123456');
    expect(extractCode('123-456')).toBe('123456');
    expect(extractCode('12345')).toBeNull();
    expect(extractCode('https://qalm.app/auth/email/verify?token=123456')).toBeNull();
    expect(isEmail('a@b.co')).toBe(true);
    expect(isEmail('a@b')).toBe(false);
  });
});

describe('pending email sign-in (device nonce)', () => {
  it('stores a nonce per email for 15 minutes and reuses it for resends', async () => {
    const now = { t: 1_000_000 };
    const d = memPending(now);
    const a = await beginEmailSignIn(d, ' Ada@Example.com ');
    expect(a).toEqual({ nonce: 'nonce-1', nonceHash: 'h(nonce-1)' });
    expect(await pendingNonce(d, 'ada@example.com')).toBe('nonce-1');
    expect(await pendingNonce(d, 'other@example.com')).toBeNull();

    // A resend keeps the nonce (so the first email's link still works here) and renews the expiry.
    now.t += PENDING_TTL_MS - 1000;
    expect((await beginEmailSignIn(d, 'ada@example.com')).nonce).toBe('nonce-1');
    now.t += PENDING_TTL_MS - 1000;
    expect(await pendingNonce(d, 'ada@example.com')).toBe('nonce-1');

    // Expired: gone, and a new request gets a new nonce.
    now.t += 2000;
    expect(await pendingNonce(d, 'ada@example.com')).toBeNull();
    expect((await beginEmailSignIn(d, 'ada@example.com')).nonce).toBe('nonce-2');

    await beginEmailSignIn(d, 'b@example.com');
    await clearPending(d, 'ADA@example.com');
    expect(await pendingNonce(d, 'ada@example.com')).toBeNull();
    expect(await pendingNonce(d, 'b@example.com')).toBe('nonce-3');
    expect(Object.keys(d.map()!)).toEqual(['b@example.com']);
  });
});

describe('TokenManager across tabs', () => {
  it('re-reads stored tokens before refreshing: another tab already rotated them', async () => {
    const now = 1_000_000;
    let stored: Tokens = { accessToken: jwt({ sub: 'u1', exp: now / 1000 + 30 }), refreshToken: 'r1' };
    const store = { load: async () => stored, save: async (t: Tokens | null) => void (t && (stored = t)) };
    const calls: string[] = [];
    const fetchFn = async (url: string) => {
      calls.push(url);
      return json({ accessToken: jwt({ sub: 'u1', exp: now / 1000 + 3600 }), refreshToken: 'r2' });
    };
    const tabA = new TokenManager('https://api.test', store, fetchFn, () => now);
    const tabB = new TokenManager('https://api.test', store, fetchFn, () => now);
    await tabA.load();
    await tabB.load();
    await tabA.accessToken(); // A refreshes: r1 → r2, saved
    expect(stored.refreshToken).toBe('r2');
    const tokB = await tabB.accessToken(); // B holds r1 in memory but finds r2 stored: no second refresh
    expect(calls).toHaveLength(1);
    expect(tokB).toBe(stored.accessToken);
  });

  it('serializes refreshes through the shared lock', async () => {
    const order: string[] = [];
    let held = Promise.resolve();
    const lock: RefreshLock = (fn) => {
      const run = held.then(fn);
      held = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    };
    const now = 1_000_000;
    let stored: Tokens = { accessToken: jwt({ sub: 'u1', exp: now / 1000 + 30 }), refreshToken: 'r1' };
    const store = { load: async () => stored, save: async (t: Tokens | null) => void (t && (stored = t)) };
    let n = 1;
    const fetchFn = async (_url: string, init?: RequestInit) => {
      order.push(`refresh ${bodyOf(init).refreshToken}`);
      n++;
      return json({ accessToken: jwt({ sub: 'u1', exp: now / 1000 + 3600, n }), refreshToken: `r${n}` });
    };
    const a = new TokenManager('https://api.test', store, fetchFn, () => now, lock);
    const b = new TokenManager('https://api.test', store, fetchFn, () => now, lock);
    await a.load();
    await b.load();
    await Promise.all([a.accessToken(), b.accessToken()]);
    expect(order).toEqual(['refresh r1']); // B waited, then used A's tokens
  });

  it('logout ends the server session, and still signs out offline', async () => {
    const seen: { url: string; init?: RequestInit }[] = [];
    let saved: Tokens | null | undefined;
    const store = { load: async () => ({ accessToken: jwt({ sub: 'u1', exp: 4e9 }), refreshToken: 'r1' }), save: async (t: Tokens | null) => void (saved = t) };
    const tm = new TokenManager('https://api.test', store, async (url, init) => {
      seen.push({ url, init });
      return json({ ok: true });
    });
    await tm.load();
    await tm.logout();
    expect(seen[0]!.url).toBe('https://api.test/auth/logout');
    expect(bodyOf(seen[0]!.init)).toEqual({ refreshToken: 'r1' });
    expect(new Headers(seen[0]!.init!.headers).get('authorization')).toMatch(/^Bearer /);
    expect(saved).toBeNull();
    expect(tm.user()).toBeNull();

    const offline = new TokenManager('https://api.test', store, async () => {
      throw new TypeError('Failed to fetch');
    });
    await offline.load();
    await offline.logout();
    expect(offline.user()).toBeNull();
  });
});

describe('moving signed-out notebooks into the account', () => {
  it('moves every lib:local notebook once and removes it from lib:local', () => {
    const account = new Library(new Y.Doc());
    const local = new Library(new Y.Doc());
    const f = local.addFolder('School');
    const meta = (id: string, title: string) => ({ id, title, cover: 'slate', aiAccess: false });
    local.putEntry(entryFor(meta('a', 'A'), f));
    local.putEntry(entryFor(meta('b', 'B'), null));
    // Already in the account (e.g. merged by an older build that copied instead of moving).
    account.putEntry(entryFor(meta('b', 'B'), null));

    expect(localToMove(account, local)).toBe(1);
    expect(moveLocalLibrary(account, local)).toBe(1);
    expect(account.entries().map((e) => e.title).sort()).toEqual(['A', 'B']);
    expect(account.folders().map((x) => x.name)).toEqual(['School']);
    expect(local.entries()).toEqual([]);
    expect(local.folders()).toEqual([]);
    // Nothing left to offer or duplicate.
    expect(localToMove(account, local)).toBe(0);
    expect(moveLocalLibrary(account, local)).toBe(0);
    expect(account.entries()).toHaveLength(2);
  });

  it('moves colours saved while signed out, even with no notebooks', () => {
    const account = new Library(new Y.Doc());
    const local = new Library(new Y.Doc());
    expect(hasLocalLibrary(local)).toBe(false);
    local.addSwatch('highlighter', '#ff880080');
    expect(hasLocalLibrary(local)).toBe(true);
    account.addSwatch('highlighter', '#00ff00');
    expect(moveLocalLibrary(account, local)).toBe(0);
    expect(account.swatches('highlighter').slice(-2)).toEqual(['#00ff00', '#ff880080']);
    expect(account.hasCustomSwatches('pen')).toBe(false);
    expect(hasLocalLibrary(local)).toBe(false);
  });
});
