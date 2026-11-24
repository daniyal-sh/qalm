import { describe, expect, it, vi } from 'vitest';

import { accountDocIds, confirmAccountDeletion, DELETED_ITEMS, emailMatches, forgetAccountDocs, startAccountDeletion } from '../src/account/deletion';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const bodyOf = (init?: RequestInit) => JSON.parse(String(init!.body)) as Record<string, unknown>;

describe('delete account flow', () => {
  it('explains what goes, including notebooks, files, AI connections and the account', () => {
    expect(DELETED_ITEMS.join(' ')).toMatch(/notebook.*PDFs and images.*AI connections.*account itself/s);
  });

  it('only enables sending the code when the typed email is the account’s', () => {
    expect(emailMatches('ada@example.com', 'ada@example.com')).toBe(true);
    expect(emailMatches('  ADA@Example.com ', 'ada@example.com')).toBe(true);
    expect(emailMatches('ada@example.co', 'ada@example.com')).toBe(false);
    expect(emailMatches('', '')).toBe(false);
    expect(emailMatches('ada@example.com', null)).toBe(false);
  });

  it('emails the code, then deletes with it', async () => {
    const f = vi.fn(async (_p: string, _i?: RequestInit) => json({ ok: true }));
    await startAccountDeletion(f, ' ada@example.com ');
    expect(f.mock.calls[0]![0]).toBe('/account/delete/start');
    expect(bodyOf(f.mock.calls[0]![1])).toEqual({ email: 'ada@example.com' });

    const g = vi.fn(async (_p: string, _i?: RequestInit) => json({ deleted: true }));
    await confirmAccountDeletion(g, '123 456');
    expect(g.mock.calls[0]![0]).toBe('/account/delete');
    expect(bodyOf(g.mock.calls[0]![1])).toEqual({ code: '123456' });
  });

  it('shows the server’s reason for a wrong email or code, and a clear offline message', async () => {
    await expect(startAccountDeletion(async () => json({ error: "That email doesn't match this account" }, 400), 'x@y.z')).rejects.toThrow(/doesn't match/);
    await expect(confirmAccountDeletion(async () => json({ error: 'That code is wrong or has expired' }, 400), '000000')).rejects.toThrow(/wrong or has expired/);
    await expect(startAccountDeletion(async () => json({}, 429), 'x@y.z')).rejects.toThrow(/Too many/);
    await expect(
      confirmAccountDeletion(async () => {
        throw new TypeError('Failed to fetch');
      }, '123456'),
    ).rejects.toThrow(/reach the server/);
  });

  it('picks the account’s local docs, and keeps signed-out notebooks', () => {
    const local = ['lib:u1', 'lib:local', 'nb:a', 'pg:a:p1', 'pg:a:p2', 'nb:b', 'pg:b:p1', 'nb:keep', 'pg:keep:p1', 'lib:u2', 'nb:other'];
    expect(accountDocIds(local, 'u1', ['a', 'b', 'keep'], ['keep']).sort()).toEqual(['lib:u1', 'nb:a', 'nb:b', 'pg:a:p1', 'pg:a:p2', 'pg:b:p1']);
  });

  it('forgets the account’s docs on this device, carrying on past failures', async () => {
    const dropped: string[] = [];
    const removed: string[] = [];
    const ids = await forgetAccountDocs(
      {
        list: async () => ['nb:a', 'pg:a:p1', 'lib:local', 'nb:loc'],
        drop: async (id) => {
          dropped.push(id);
          if (id === 'nb:a') throw new Error('busy');
        },
        remove: async (id) => void removed.push(id),
      },
      'u1',
      ['a'],
      ['loc'],
    );
    // The library is removed even when it wasn't listed (e.g. not stored yet).
    expect(ids.sort()).toEqual(['lib:u1', 'nb:a', 'pg:a:p1']);
    expect(removed.sort()).toEqual(['lib:u1', 'nb:a', 'pg:a:p1']);
    expect(dropped).toContain('nb:a');
  });
});
