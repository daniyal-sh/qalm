import type { Env } from './env';
import { num } from './env';
import { json } from './util';

/** The free beta's per-user cap: 250 MB (decimal), counting assets and notebook data. */
export const DEFAULT_STORAGE_LIMIT = 250_000_000;

export const storageLimit = (env: Env) => num(env.MAX_USER_STORAGE_BYTES, DEFAULT_STORAGE_LIMIT);

export interface StorageUsage {
  usedBytes: number;
  limitBytes: number;
  /** Uploaded PDFs and images (R2, counted once per user). */
  assetBytes: number;
  /** The user's Yjs docs (library, notebook indexes, pages) as stored by their DocRooms. */
  notebookBytes: number;
}

export async function storageUsage(env: Env, userId: string): Promise<StorageUsage> {
  const r = await env.DB.prepare(
    `SELECT (SELECT COALESCE(SUM(bytes), 0) FROM user_assets WHERE user_id = ?1) AS a,
            (SELECT COALESCE(SUM(bytes), 0) FROM doc_sizes WHERE user_id = ?1) AS d`,
  )
    .bind(userId)
    .first<{ a: number; d: number }>();
  const assetBytes = r?.a ?? 0;
  const notebookBytes = r?.d ?? 0;
  return { usedBytes: assetBytes + notebookBytes, limitBytes: storageLimit(env), assetBytes, notebookBytes };
}

export const STORAGE_FULL = 'storage_full';

/** 413 for an import that doesn't fit. Ink and other doc edits are never refused. */
export function storageFull(u: StorageUsage): Response {
  const mb = Math.round(u.limitBytes / 1_000_000);
  return json(
    {
      error: `Your qalm storage is full (${mb} MB). Delete some PDFs or images to import more. Your handwriting keeps syncing.`,
      code: STORAGE_FULL,
      ...u,
    },
    413,
  );
}
