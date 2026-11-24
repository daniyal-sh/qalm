import type { Asset } from '@qalm/core';

import { fits, getStorage, StorageFullError, type StorageUsage } from '../api/storage';
import type { TokenManager } from '../auth/tokens';
import { newId } from '../lib/id';
import { kvGet, kvSet } from '../lib/kv';
import { localUri, readLocal, saveLocal, sha256 } from './local';

interface Pending {
  sha: string;
  mime: string;
}

/**
 * Content-addressed assets (PDFs, images): cached locally, uploaded to `PUT /assets/{sha256}` when signed in,
 * downloaded from `GET /assets/{sha256}` on devices that don't have them yet (tech-spec §4).
 */
export class AssetService {
  private uploading: Promise<void> | null = null;
  private uris = new Map<string, Promise<string | null>>();

  constructor(private readonly remote: () => TokenManager | null) {}

  /** The account's storage, or null when signed out (local only: no cap). Throws when offline. */
  async storage(): Promise<StorageUsage | null> {
    const tm = this.remote();
    return tm ? getStorage((p, i) => tm.fetch(p, i)) : null;
  }

  /**
   * Refuses an import of `bytes` that won't fit in the account (StorageFullError). Signed out, or when the server
   * can't be reached, the import goes ahead locally; the upload is retried later and the server has the last word.
   */
  async ensureRoom(bytes: number): Promise<void> {
    let u: StorageUsage | null;
    try {
      u = await this.storage();
    } catch {
      return;
    }
    if (u && !fits(u, bytes)) throw new StorageFullError(u);
  }

  /** Adds a PDF or image: checks the account has room, keeps it locally and queues the upload. */
  async put(bytes: Uint8Array, mime: string, name: string, extra: Partial<Asset> = {}): Promise<Asset> {
    await this.ensureRoom(bytes.length);
    return this.putUnchecked(bytes, mime, name, extra);
  }

  /** `put` without the storage check (the caller already checked, e.g. for a whole .qalm restore). */
  async putUnchecked(bytes: Uint8Array, mime: string, name: string, extra: Partial<Asset> = {}): Promise<Asset> {
    const sha = await sha256(bytes);
    await saveLocal(sha, mime, bytes);
    const pending = (await kvGet<Pending[]>('assets:pending')) ?? [];
    if (!pending.some((p) => p.sha === sha)) await kvSet('assets:pending', [...pending, { sha, mime }]);
    void this.uploadPending();
    return { id: newId(), sha256: sha, mime, name, bytes: bytes.length, ...extra };
  }

  /** A uri the renderer can load (file:// on native, blob: on web), downloading first if needed. */
  uri(asset: Asset): Promise<string | null> {
    let p = this.uris.get(asset.sha256);
    if (!p) {
      p = (async () => {
        const local = await localUri(asset.sha256, asset.mime);
        if (local) return local;
        if (!(await this.download(asset))) return null;
        return localUri(asset.sha256, asset.mime);
      })();
      p.then((v) => {
        if (!v) this.uris.delete(asset.sha256);
      });
      this.uris.set(asset.sha256, p);
    }
    return p;
  }

  async bytes(asset: Asset): Promise<Uint8Array> {
    const local = await readLocal(asset.sha256, asset.mime);
    if (local) return local;
    if (await this.download(asset)) {
      const b = await readLocal(asset.sha256, asset.mime);
      if (b) return b;
    }
    throw new Error(`asset ${asset.name} is not available offline`);
  }

  private async download(asset: Asset): Promise<boolean> {
    const tm = this.remote();
    if (!tm) return false;
    try {
      const res = await tm.fetch(`/assets/${asset.sha256}`);
      if (!res.ok) return false;
      await saveLocal(asset.sha256, asset.mime, new Uint8Array(await res.arrayBuffer()));
      return true;
    } catch {
      return false;
    }
  }

  /** Uploads queued assets (called after adding one and after sign-in). */
  uploadPending(): Promise<void> {
    const tm = this.remote();
    if (!tm) return Promise.resolve();
    this.uploading ??= (async () => {
      try {
        const pending = (await kvGet<Pending[]>('assets:pending')) ?? [];
        const left: Pending[] = [];
        for (const p of pending) {
          try {
            const bytes = await readLocal(p.sha, p.mime);
            if (!bytes) continue;
            const res = await tm.fetch(`/assets/${p.sha}`, {
              method: 'PUT',
              headers: { 'content-type': p.mime },
              body: bytes as unknown as BodyInit,
            });
            // 413 (storage full): kept and retried later, once there's room again.
            if (!res.ok && res.status !== 409) left.push(p);
          } catch {
            left.push(p);
          }
        }
        await kvSet('assets:pending', left);
      } finally {
        this.uploading = null;
      }
    })();
    return this.uploading;
  }
}
