import { describe, expect, it, vi } from 'vitest';

import { fits, formatBytes, getStorage, StorageFullError, storageFullMessage, summarizeUsage, type StorageUsage } from '../src/api/storage';

vi.mock('../src/assets/local', () => ({
  sha256: async () => 'a'.repeat(64),
  saveLocal: vi.fn(async () => {}),
  readLocal: async () => null,
  localUri: async () => null,
}));
const kv = new Map<string, unknown>();
vi.mock('../src/lib/kv', () => ({
  kvGet: async (k: string) => kv.get(k),
  kvSet: async (k: string, v: unknown) => void kv.set(k, v),
}));

const { AssetService } = await import('../src/assets/assetService');

const MB = 1_000_000;
const usage = (used: number, limit = 250 * MB): StorageUsage => ({ usedBytes: used, limitBytes: limit, assetBytes: used, notebookBytes: 0 });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A TokenManager stand-in: answers /me/storage and records PUTs. */
function remote(u: StorageUsage | Error) {
  const puts: string[] = [];
  return {
    puts,
    tm: {
      fetch: async (path: string, init?: RequestInit) => {
        if (path === '/me/storage') {
          if (u instanceof Error) throw u;
          return json(u);
        }
        if (init?.method === 'PUT') puts.push(path);
        return json({}, 201);
      },
    },
  };
}

describe('storage usage', () => {
  it('formats decimal sizes like the cap', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(640_000)).toBe('640 KB');
    expect(formatBytes(4_250_000)).toBe('4.3 MB');
    expect(formatBytes(120 * MB)).toBe('120 MB');
    expect(formatBytes(250 * MB)).toBe('250 MB');
    expect(formatBytes(1_200 * MB)).toBe('1.2 GB');
  });

  it('summarizes "120 MB of 250 MB" with a bar fraction, a warning above 90 % and full at the cap', () => {
    expect(summarizeUsage(usage(120 * MB))).toEqual({ label: '120 MB of 250 MB', fraction: 0.48, warn: false, full: false });
    expect(summarizeUsage(usage(225 * MB))).toMatchObject({ warn: false, full: false });
    expect(summarizeUsage(usage(226 * MB))).toMatchObject({ warn: true, full: false });
    expect(summarizeUsage(usage(250 * MB))).toMatchObject({ warn: true, full: true, fraction: 1 });
    expect(summarizeUsage(usage(260 * MB)).fraction).toBe(1);
  });

  it('checks whether an import fits', () => {
    expect(fits(usage(240 * MB), 10 * MB)).toBe(true);
    expect(fits(usage(240 * MB), 10 * MB + 1)).toBe(false);
  });

  it('reads GET /me/storage', async () => {
    const f = vi.fn(async () => json(usage(5)));
    expect(await getStorage(f)).toEqual(usage(5));
    expect(f).toHaveBeenCalledWith('/me/storage');
    await expect(getStorage(async () => json({}, 500))).rejects.toThrow(/storage/);
  });

  it('says clearly why an import was refused', () => {
    expect(storageFullMessage()).toMatch(/storage is full \(250 MB\).*handwriting keeps syncing/i);
  });
});

describe('AssetService at the cap', () => {
  it('refuses a PDF or image that does not fit, before saving or uploading it', async () => {
    kv.clear();
    const r = remote(usage(249.5 * MB));
    const svc = new AssetService(() => r.tm as never);
    const err = await svc.put(new Uint8Array(MB), 'application/pdf', 'big.pdf').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StorageFullError);
    expect((err as Error).message).toMatch(/storage is full/);
    expect(kv.get('assets:pending')).toBeUndefined();
    expect(r.puts).toEqual([]);
  });

  it('allows imports that fit, signed out (no cap) and offline (the server has the last word)', async () => {
    kv.clear();
    const fitsNow = remote(usage(10 * MB));
    await expect(new AssetService(() => fitsNow.tm as never).put(new Uint8Array(10), 'image/png', 'a.png')).resolves.toMatchObject({ mime: 'image/png' });
    await expect(new AssetService(() => null).put(new Uint8Array(10), 'image/png', 'b.png')).resolves.toBeTruthy();
    const offline = remote(new Error('network down'));
    await expect(new AssetService(() => offline.tm as never).put(new Uint8Array(10), 'image/png', 'c.png')).resolves.toBeTruthy();
  });

  it('keeps an upload the server refused with 413 queued for later', async () => {
    kv.clear();
    kv.set('assets:pending', [{ sha: 'b'.repeat(64), mime: 'image/png' }]);
    const local = await import('../src/assets/local');
    vi.spyOn(local, 'readLocal').mockResolvedValue(new Uint8Array(3));
    const tm = { fetch: async () => json({ code: 'storage_full' }, 413) };
    await new AssetService(() => tm as never).uploadPending();
    expect(kv.get('assets:pending')).toEqual([{ sha: 'b'.repeat(64), mime: 'image/png' }]);
  });
});
