import type { Env } from './env';
import { now } from './util';

const ID = '[A-Za-z0-9_-]{1,64}';
const NB = new RegExp(`^nb:(${ID})$`);
const PG = new RegExp(`^pg:(${ID}):(${ID})$`);
const LIB = new RegExp(`^lib:(${ID})$`);

export type DocRef =
  | { kind: 'nb'; id: string; notebookId: string }
  | { kind: 'pg'; id: string; notebookId: string; pageId: string }
  | { kind: 'lib'; id: string; userId: string };

export function parseDocId(id: string): DocRef | null {
  let m = NB.exec(id);
  if (m) return { kind: 'nb', id, notebookId: m[1]! };
  m = PG.exec(id);
  if (m) return { kind: 'pg', id, notebookId: m[1]!, pageId: m[2]! };
  m = LIB.exec(id);
  if (m) return { kind: 'lib', id, userId: m[1]! };
  return null;
}

export const nbDocId = (notebookId: string) => `nb:${notebookId}`;
export const pgDocId = (notebookId: string, pageId: string) => `pg:${notebookId}:${pageId}`;
export const libDocId = (userId: string) => `lib:${userId}`;

export function room(env: Env, docId: string) {
  return env.DOC_ROOM.get(env.DOC_ROOM.idFromName(docId));
}

interface OwnerRow { owner_id: string; deleted_at: number | null }

/** The notebook's owner row; the first user to ask for it claims it. */
async function ownerRow(env: Env, notebookId: string, claimFor?: string): Promise<OwnerRow | null> {
  const q = () => env.DB.prepare('SELECT owner_id, deleted_at FROM notebooks WHERE id = ?1').bind(notebookId).first<OwnerRow>();
  const row = await q();
  if (row || !claimFor) return row;
  const t = now();
  await env.DB.prepare('INSERT INTO notebooks (id, owner_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?3) ON CONFLICT(id) DO NOTHING')
    .bind(notebookId, claimFor, t)
    .run();
  return q();
}

export async function notebookOwner(env: Env, notebookId: string, claimFor?: string): Promise<string | null> {
  return (await ownerRow(env, notebookId, claimFor))?.owner_id ?? null;
}

/** v1: owner only. Notebooks deleted forever are closed to everyone. */
export async function canAccess(env: Env, userId: string, doc: DocRef): Promise<boolean> {
  if (doc.kind === 'lib') return doc.userId === userId;
  const row = await ownerRow(env, doc.notebookId, userId);
  return !!row && row.owner_id === userId && !row.deleted_at;
}

/**
 * "Delete forever" (DELETE /notebooks/{id}, owner only): tombstones the D1 row (tickets are refused from now on), then
 * purges the nb/pg rooms' storage, best effort. Returns false when the user does not own the notebook.
 */
export async function deleteNotebook(env: Env, userId: string, notebookId: string): Promise<boolean> {
  const row = await ownerRow(env, notebookId);
  if (!row || row.owner_id !== userId) return false;
  if (!row.deleted_at) await env.DB.prepare('UPDATE notebooks SET deleted_at = ?2 WHERE id = ?1').bind(notebookId, now()).run();
  const pg = `pg:${notebookId}:`;
  await env.DB.prepare('DELETE FROM sync_tickets WHERE doc_id = ?1 OR substr(doc_id, 1, ?3) = ?2').bind(nbDocId(notebookId), pg, pg.length).run();
  try {
    const id = nbDocId(notebookId);
    await room(env, id).purgeNotebook(id);
  } catch (e) {
    console.error('notebook purge failed', e);
  }
  return true;
}
