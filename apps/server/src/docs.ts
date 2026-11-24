import type { Env } from './env';
import { now } from './util';
import { deleteLecture, notebookLectureIds } from './lecture';

const ID = '[A-Za-z0-9_-]{1,64}';
const NB = new RegExp(`^nb:(${ID})$`);
const PG = new RegExp(`^pg:(${ID}):(${ID})$`);
const LIB = new RegExp(`^lib:(${ID})$`);
const LEC = new RegExp(`^lec:(${ID}):(${ID})$`);

export type DocRef =
  | { kind: 'nb'; id: string; notebookId: string }
  | { kind: 'pg'; id: string; notebookId: string; pageId: string }
  | { kind: 'lib'; id: string; userId: string }
  /** A lecture session (docs/lecture-mode.md §5): owned like its notebook. */
  | { kind: 'lec'; id: string; notebookId: string; sessionId: string };

export function parseDocId(id: string): DocRef | null {
  let m = NB.exec(id);
  if (m) return { kind: 'nb', id, notebookId: m[1]! };
  m = PG.exec(id);
  if (m) return { kind: 'pg', id, notebookId: m[1]!, pageId: m[2]! };
  m = LIB.exec(id);
  if (m) return { kind: 'lib', id, userId: m[1]! };
  m = LEC.exec(id);
  if (m) return { kind: 'lec', id, notebookId: m[1]!, sessionId: m[2]! };
  return null;
}

export const nbDocId = (notebookId: string) => `nb:${notebookId}`;
export const pgDocId = (notebookId: string, pageId: string) => `pg:${notebookId}:${pageId}`;
export const libDocId = (userId: string) => `lib:${userId}`;
export const lecDocId = (notebookId: string, sessionId: string) => `lec:${notebookId}:${sessionId}`;

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
  const lec = `lec:${notebookId}:`;
  // Lecture sessions first, deleted like one at a time (tombstoned, room purged, audio and crops freed unless another
  // session of the user still uses them), before their rows go. Their ids: the notebook room's list, doc_sizes and
  // lecture_assets.
  let fromRoom: string[] = [];
  try {
    fromRoom = await room(env, nbDocId(notebookId)).lectureIds(nbDocId(notebookId));
  } catch (e) {
    console.error('lecture list failed', e);
  }
  for (const sid of await notebookLectureIds(env, notebookId, fromRoom)) {
    try {
      await deleteLecture(env, userId, notebookId, sid, { notebookRoom: false });
    } catch (e) {
      console.error('lecture delete failed', e);
    }
  }
  await env.DB.batch(
    ['sync_tickets', 'doc_sizes'].flatMap((t) => [
      env.DB.prepare(`DELETE FROM ${t} WHERE doc_id = ?1 OR substr(doc_id, 1, ?3) = ?2`).bind(nbDocId(notebookId), pg, pg.length),
      env.DB.prepare(`DELETE FROM ${t} WHERE substr(doc_id, 1, ?2) = ?1`).bind(lec, lec.length),
    ]),
  );
  try {
    const id = nbDocId(notebookId);
    await room(env, id).purgeNotebook(id);
  } catch (e) {
    console.error('notebook purge failed', e);
  }
  return true;
}
